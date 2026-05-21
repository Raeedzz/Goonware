import { describe, expect, test } from "bun:test";

/**
 * Behavioral tests for the GridRenderer's GPU-surface recovery path.
 *
 * The bug class these guard against (same root cause as
 * visibilityRestore.test.ts but at a different layer):
 *
 *   WKWebView's GPU surface for a canvas hosted under `display: none`
 *   can be silently released without firing `device.lost`. Subsequent
 *   `context.getCurrentTexture()` calls either throw or return a
 *   texture that draws into the void — the user sees a black pane
 *   even though the renderer thinks it's painting correctly.
 *
 * The fixes pinned by these tests:
 *
 *   1. `reconfigure()` calls `context.configure(...)` with the same
 *      device + format the bootstrap used. Idempotent on a healthy
 *      surface; restores a dead one. (The HTML5 spec says configure()
 *      "establishes the configuration" — calling it again replaces
 *      the prior configuration.)
 *
 *   2. `resize()` ends with a configure() call so any GPU resize
 *      lands on a live surface. This catches the case where the user
 *      switched tabs (surface released) and then a window resize
 *      fires before the next visibility tick.
 *
 *   3. `draw()` wraps `getCurrentTexture()` in try/catch. On throw,
 *      it calls reconfigure() and retries. On a second throw it
 *      gives up cleanly (does NOT crash the renderer) so the next
 *      paint can try again.
 *
 * These tests use a mock GridRenderer-like object — exercising the
 * real GPUDevice would require a real WebGPU environment we can't
 * spin up in `bun test`. The contract under test is the WHEN of the
 * recovery calls, not the WGSL pipeline shape.
 *
 * Source pin: `gridRendererSourcePins` at the bottom verifies the
 * recovery calls actually live in GridRenderer.ts (no behavioral
 * test from a separate file can guarantee the runtime code path
 * without reflecting the source). This catches "someone refactored
 * the renderer and removed reconfigure() — the unit tests still
 * pass against the mock but production is broken."
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Tiny mock of the GridRenderer surface this test cares about. Lets
 * us drive the recovery state machine without WebGPU.
 *
 * Mirrors GridRenderer's public + relevant private surface — the
 * test can compose actions in any order and observe what fires.
 */
class MockGridRenderer {
  configureCalls = 0;
  resizeCalls: Array<{ width: number; height: number; dpr: number }> = [];
  paints = 0;
  invalidateCalls = 0;
  /** Simulate WKWebView releasing the GPU surface. */
  surfaceAlive = true;
  /** Counts every `getCurrentTexture()` attempt. */
  getCurrentTextureAttempts = 0;
  /** Mirror of GridRenderer.needsReconfigure. */
  needsReconfigure = false;
  /** Mirror of GridRenderer.lastSeq. */
  lastSeq = -1;

  reconfigure(): void {
    this.configureCalls++;
    // Reconfiguring re-acquires the swapchain.
    this.surfaceAlive = true;
    this.needsReconfigure = false;
    this.lastSeq = -1;
  }

  resize(width: number, height: number, dpr: number): void {
    this.resizeCalls.push({ width, height, dpr });
    // The real resize() ends with a configure() call — mirror that.
    this.reconfigure();
  }

  invalidate(): void {
    this.invalidateCalls++;
    this.lastSeq = -1;
  }

  /** Simulates the inner `getCurrentTexture()` of GridRenderer.draw. */
  private acquireSurface(): boolean {
    this.getCurrentTextureAttempts++;
    return this.surfaceAlive;
  }

  /** Mirrors GridRenderer.draw's recovery sequence. */
  draw(): "painted" | "skipped" {
    if (this.needsReconfigure) this.reconfigure();
    if (!this.acquireSurface()) {
      // First attempt failed — reconfigure + retry.
      this.needsReconfigure = true;
      this.reconfigure();
      if (!this.acquireSurface()) {
        // Second failure — bail without painting. Reset lastSeq so
        // the next render call doesn't dedupe and skip.
        this.lastSeq = -1;
        return "skipped";
      }
    }
    this.paints++;
    return "painted";
  }

  /** Simulate WKWebView releasing the surface. */
  killSurface(): void {
    this.surfaceAlive = false;
  }
}

describe("GridRenderer recovery — reconfigure() is idempotent on a healthy surface", () => {
  test("calling reconfigure() repeatedly on a live surface stays live", () => {
    const r = new MockGridRenderer();
    r.reconfigure();
    r.reconfigure();
    r.reconfigure();
    expect(r.surfaceAlive).toBe(true);
    expect(r.configureCalls).toBe(3);
  });

  test("reconfigure() resets needsReconfigure flag", () => {
    const r = new MockGridRenderer();
    r.needsReconfigure = true;
    r.reconfigure();
    expect(r.needsReconfigure).toBe(false);
  });

  test("reconfigure() forces next paint by clearing lastSeq", () => {
    const r = new MockGridRenderer();
    r.lastSeq = 42;
    r.reconfigure();
    // The mock mirrors the real `lastSeq = -1` reset on reconfigure.
    expect(r.lastSeq).toBe(-1);
  });
});

describe("GridRenderer recovery — draw() self-heals a dead surface", () => {
  test("draw on a healthy surface paints once with no reconfigure", () => {
    const r = new MockGridRenderer();
    const result = r.draw();
    expect(result).toBe("painted");
    expect(r.configureCalls).toBe(0);
    expect(r.paints).toBe(1);
    expect(r.getCurrentTextureAttempts).toBe(1);
  });

  test("draw on a dead surface attempts twice + reconfigures + recovers", () => {
    const r = new MockGridRenderer();
    // First attempt fails — surface is dead.
    r.killSurface();
    // But the surface comes back alive after reconfigure (this is
    // the simulation of WKWebView re-acquiring the swapchain when
    // configure() is called fresh).
    const result = r.draw();
    expect(result).toBe("painted");
    expect(r.configureCalls).toBe(1);
    expect(r.paints).toBe(1);
    // Two getCurrentTexture attempts: the failing one + the retry.
    expect(r.getCurrentTextureAttempts).toBe(2);
  });

  test("draw on a permanently dead surface bails without crashing", () => {
    // The test mock keeps the surface dead forever (a real WKWebView
    // failure mode if the canvas was detached or the device is in
    // a half-lost state we can't recover from).
    const r = new MockGridRenderer();
    r.killSurface();
    // Override the reconfigure to keep the surface dead — mirrors
    // the catch path in the real renderer's reconfigure().
    const origReconfigure = r.reconfigure.bind(r);
    r.reconfigure = () => {
      origReconfigure();
      r.surfaceAlive = false;
    };
    const result = r.draw();
    expect(result).toBe("skipped");
    expect(r.paints).toBe(0);
    // After a skipped frame, lastSeq must reset so the NEXT render
    // call doesn't dedupe and silently skip the recovery.
    expect(r.lastSeq).toBe(-1);
  });

  test("draw with needsReconfigure pre-set calls reconfigure first", () => {
    // The case where the PREVIOUS draw flagged the surface as dead
    // — we should pre-emptively reconfigure before even attempting
    // getCurrentTexture.
    const r = new MockGridRenderer();
    r.needsReconfigure = true;
    const result = r.draw();
    expect(result).toBe("painted");
    expect(r.configureCalls).toBe(1);
    // Only ONE attempt at getCurrentTexture — the pre-reconfigure
    // covered for the dead state and the first attempt succeeded.
    expect(r.getCurrentTextureAttempts).toBe(1);
  });
});

describe("GridRenderer recovery — resize() re-acquires the swapchain", () => {
  test("resize() always ends with a configure call", () => {
    // The "switch tabs → window resize while hidden → come back"
    // case. The resize hits before the visibility tick, so the
    // resize itself must re-acquire the swapchain or the next draw
    // lands on a dead surface.
    const r = new MockGridRenderer();
    r.resize(1024, 768, 2);
    expect(r.configureCalls).toBe(1);
    expect(r.resizeCalls).toHaveLength(1);
  });

  test("resize() recovers a dead surface synchronously", () => {
    const r = new MockGridRenderer();
    r.killSurface();
    expect(r.surfaceAlive).toBe(false);
    r.resize(800, 600, 1);
    // After the resize-time reconfigure, the surface is live again.
    expect(r.surfaceAlive).toBe(true);
    // The next draw paints without further reconfigure work.
    const result = r.draw();
    expect(result).toBe("painted");
  });

  test("multiple resizes don't compound reconfigure work", () => {
    // Pin that each resize() does exactly one reconfigure — not
    // accumulating. (A future refactor might add a "retry on
    // failure" loop that compounds work in pathological cases.)
    const r = new MockGridRenderer();
    r.resize(800, 600, 1);
    r.resize(1024, 768, 2);
    r.resize(1920, 1080, 2);
    expect(r.configureCalls).toBe(3);
    expect(r.resizeCalls).toHaveLength(3);
  });
});

describe("GridRenderer recovery — interleaved resize / draw / visibility", () => {
  test("kill → resize → draw recovers without extra work", () => {
    // The realistic sequence: user hides tab (surface released),
    // user resizes window (ResizeObserver fires resize), user
    // switches back (visibility-restore fires draw). The middle
    // resize must alone recover; the draw should paint cleanly.
    const r = new MockGridRenderer();
    r.killSurface();
    r.resize(1200, 800, 2);
    const before = r.configureCalls;
    const result = r.draw();
    expect(result).toBe("painted");
    // The draw didn't need to reconfigure — resize already did.
    expect(r.configureCalls).toBe(before);
  });

  test("kill → draw → resize → draw paints both times via recovery", () => {
    const r = new MockGridRenderer();
    r.killSurface();
    // First draw: dead surface, but draw() recovers via the
    // try/catch path.
    const first = r.draw();
    expect(first).toBe("painted");
    // Subsequent resize: idempotent on a now-live surface.
    r.resize(800, 600, 1);
    // Second draw: also paints.
    const second = r.draw();
    expect(second).toBe("painted");
    expect(r.paints).toBe(2);
  });

  test("rapid kill/recover cycles never strand the surface in a dead state", () => {
    // The "random black screens during prompts" case: the canvas
    // may briefly transition to 0×0 (autoHeightPx hit floor) and
    // back many times in quick succession. Each cycle must end
    // with a live surface ready to paint.
    const r = new MockGridRenderer();
    for (let i = 0; i < 50; i++) {
      r.killSurface();
      // ResizeObserver pulse: a real-rect resize comes in.
      r.resize(1200 + i, 800, 2);
      const result = r.draw();
      expect(result).toBe("painted");
      expect(r.surfaceAlive).toBe(true);
    }
    expect(r.paints).toBe(50);
  });
});

/**
 * Source pinning — guarantees the recovery contract exists in the
 * actual GridRenderer.ts production file, not just our mock.
 *
 * Without these, the behavioral tests above pass against the mock
 * forever even if the real renderer regresses.
 */
describe("GridRenderer source pins — recovery code lives in GridRenderer.ts", () => {
  const src = readFileSync(
    join(import.meta.dir, "GridRenderer.ts"),
    "utf-8",
  );

  test("exposes a `reconfigure(): void` method", () => {
    expect(src).toContain("reconfigure(): void");
  });

  test("reconfigure() calls context.configure with device + format + alphaMode", () => {
    // The exact call shape that re-acquires the WKWebView swapchain.
    // If a future refactor changes the descriptor (e.g. drops
    // alphaMode), the visibility-restore stops working in subtle
    // ways. Pin the descriptor.
    expect(src).toContain("this.context.configure({");
    expect(src).toMatch(/alphaMode:\s*"premultiplied"/);
  });

  test("resize() calls context.configure at the end", () => {
    // The resize-time reconfigure is what catches the
    // "switch-tabs → window-resize-while-hidden → come back" case.
    // Drop the configure call from resize() and that case regresses.
    const resizeBody = extractMethodBody(src, "resize");
    expect(resizeBody).toContain("this.context.configure({");
  });

  test("draw() wraps getCurrentTexture in a try/catch with reconfigure retry", () => {
    const drawBody = extractMethodBody(src, "private draw");
    expect(drawBody).toContain("try");
    expect(drawBody).toContain("this.context.getCurrentTexture()");
    expect(drawBody).toContain("this.reconfigure()");
    expect(drawBody).toContain("catch");
  });

  test("draw() resets lastSeq when skipping a frame so next render re-attempts", () => {
    // Without `this.lastSeq = -1` on the skip path, the next call
    // to render() with the same seq would dedupe and silently skip
    // — turning a single-frame surface hiccup into "stuck black."
    const drawBody = extractMethodBody(src, "private draw");
    expect(drawBody).toContain("this.lastSeq = -1");
  });

  test("`format` is stored on the instance for re-configure", () => {
    // Without storing format at bootstrap, reconfigure() couldn't
    // build the configure descriptor. The constructor must capture
    // it.
    expect(src).toMatch(/this\.format\s*=\s*format/);
  });
});

/**
 * Crude method-body extractor. Walks braces from the first `{` after
 * `name` to the matching `}`. Good enough for grep-style assertions
 * — we're not parsing the AST, just verifying call patterns live
 * inside the right method.
 */
function extractMethodBody(src: string, name: string): string {
  const idx = src.indexOf(name);
  if (idx === -1) return "";
  const openIdx = src.indexOf("{", idx);
  if (openIdx === -1) return "";
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return src.slice(openIdx);
}
