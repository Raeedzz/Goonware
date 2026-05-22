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
/**
 * Mirror of the real HEARTBEAT_FRAMES constant in GridRenderer.ts.
 * Source-pin test below asserts the production code uses the same
 * number so the mock can't drift out of sync silently.
 */
const HEARTBEAT_FRAMES = 60;

class MockGridRenderer {
  configureCalls = 0;
  resizeCalls: Array<{ width: number; height: number; dpr: number }> = [];
  /** Resize calls that actually did work — excludes the no-op fast-path skips. */
  resizeWorkCalls: Array<{ width: number; height: number; dpr: number }> = [];
  paints = 0;
  invalidateCalls = 0;
  markHiddenCalls = 0;
  /** Simulate WKWebView releasing the GPU surface. */
  surfaceAlive = true;
  /** Counts every `getCurrentTexture()` attempt. */
  getCurrentTextureAttempts = 0;
  /** Mirror of GridRenderer.needsReconfigure. */
  needsReconfigure = false;
  /** Mirror of GridRenderer.lastSeq. */
  lastSeq = -1;
  /** Mirror of GridRenderer.lastPhysWidth/lastPhysHeight. */
  lastPhysWidth = 0;
  lastPhysHeight = 0;
  /** Mirror of GridRenderer.framesSinceReconfigure (heartbeat counter). */
  framesSinceReconfigure = 0;

  reconfigure(): void {
    this.configureCalls++;
    // Reconfiguring re-acquires the swapchain.
    this.surfaceAlive = true;
    this.needsReconfigure = false;
    this.lastSeq = -1;
    // Heartbeat clock resets on every successful reconfigure —
    // mirrors the real renderer so a successful refresh restarts
    // the countdown to the next forced reconfigure.
    this.framesSinceReconfigure = 0;
  }

  resize(width: number, height: number, dpr: number): void {
    this.resizeCalls.push({ width, height, dpr });
    // Compute physical pixels — must match the real renderer's math
    // (floor width, ceil height) so the mock's fast-path comparison
    // makes the same call the real one would.
    const physWidth = Math.max(1, Math.floor(width * dpr));
    const physHeight = Math.max(1, Math.ceil(height * dpr));
    // Fast path: dimensions unchanged AND surface healthy. The real
    // renderer skips the canvas.width/height + configure() driver
    // round-trip here. This is the load-bearing optimisation for
    // "switching cells is super slow" — without it every show-hide
    // cycle costs one configure() per cell even when the wrapper
    // came back to the exact same rect.
    if (
      physWidth === this.lastPhysWidth &&
      physHeight === this.lastPhysHeight &&
      !this.needsReconfigure
    ) {
      return;
    }
    this.resizeWorkCalls.push({ width, height, dpr });
    // The slow path ends with a configure() call — mirror that.
    this.reconfigure();
    this.lastPhysWidth = physWidth;
    this.lastPhysHeight = physHeight;
  }

  /**
   * Signal that the canvas is going hidden — the swapchain may be
   * silently released by WKWebView. The NEXT resize must take the
   * slow path even if dimensions match.
   */
  markHidden(): void {
    this.markHiddenCalls++;
    this.needsReconfigure = true;
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
    // Heartbeat: every HEARTBEAT_FRAMES successful paints, flag the
    // surface for a pre-emptive reconfigure. Mirrors the real
    // renderer's `framesSinceReconfigure >= HEARTBEAT_FRAMES` check.
    if (this.framesSinceReconfigure >= HEARTBEAT_FRAMES) {
      this.needsReconfigure = true;
    }
    if (this.needsReconfigure) this.reconfigure();
    if (!this.acquireSurface()) {
      // First attempt failed — reconfigure + retry.
      this.needsReconfigure = true;
      this.reconfigure();
      if (!this.acquireSurface()) {
        // Second failure — bail without painting. Reset lastSeq so
        // the next render call doesn't dedupe and skip. Heartbeat
        // counter is NOT advanced — only successful submits count
        // (matches the real renderer's post-submit increment).
        this.lastSeq = -1;
        return "skipped";
      }
    }
    this.paints++;
    // Increment AFTER successful paint, mirroring the real renderer.
    // A skipped frame does not tick the counter so a pathological
    // failing run doesn't compound reconfigure work.
    this.framesSinceReconfigure++;
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

describe("GridRenderer perf — resize() fast-path skips no-op work", () => {
  // The "switching cells is super slow" class of bug. Every visibility
  // flip in the keepalive layer fires a ResizeObserver tick — and
  // the wrapper's contentRect doesn't actually change with display
  // (absolute-positioned, inset:0). Without the fast path we paid
  // one GPU `context.configure()` driver round-trip per cell per
  // switch, which the user feels as "switching is sluggish" once
  // a project has a handful of agent shells stacked in the layer.
  test("resize() with unchanged dimensions and healthy surface is a no-op", () => {
    const r = new MockGridRenderer();
    r.resize(1200, 800, 2);
    expect(r.configureCalls).toBe(1);
    expect(r.resizeWorkCalls).toHaveLength(1);
    // Second resize with the SAME args: full fast path — no canvas
    // writes, no configure() round-trip, no lastSeq reset.
    r.resize(1200, 800, 2);
    expect(r.configureCalls).toBe(1);
    expect(r.resizeWorkCalls).toHaveLength(1);
    // The call was still recorded (we measured "resize was invoked")
    // — but only the FIRST one did work.
    expect(r.resizeCalls).toHaveLength(2);
  });

  test("resize() runs full path when dimensions change", () => {
    const r = new MockGridRenderer();
    r.resize(1200, 800, 2);
    r.resize(1400, 800, 2);
    expect(r.configureCalls).toBe(2);
    expect(r.resizeWorkCalls).toHaveLength(2);
  });

  test("resize() runs full path when DPR changes (Retina ↔ 1x monitor drag)", () => {
    // Same CSS dimensions but different DPR ⇒ different physical
    // pixels ⇒ must rebuild. The visibility fast path must not
    // collapse these into a no-op.
    const r = new MockGridRenderer();
    r.resize(1200, 800, 2);
    expect(r.configureCalls).toBe(1);
    r.resize(1200, 800, 1);
    expect(r.configureCalls).toBe(2);
  });

  test("many no-op resize ticks cost zero configure calls past the first", () => {
    // Mirrors a long-running session: same wrapper rect, ResizeObserver
    // fires once per visibility flip, layout change, etc. The
    // accumulated cost should be O(1), not O(ticks).
    const r = new MockGridRenderer();
    r.resize(1200, 800, 2);
    for (let i = 0; i < 100; i++) {
      r.resize(1200, 800, 2);
    }
    expect(r.configureCalls).toBe(1);
    expect(r.resizeWorkCalls).toHaveLength(1);
  });
});

describe("GridRenderer recovery — markHidden() forces next resize to reconfigure", () => {
  // This is the load-bearing safety net for the new resize fast
  // path. Without it, a visibility-flip cycle that lands back on
  // the same dimensions (the COMMON case for keepalive layer tab
  // switches) would skip configure() and the user would see a
  // black pane if WKWebView happened to release the swapchain
  // while we sat behind `display: none`.
  test("markHidden() flips needsReconfigure without doing any GPU work", () => {
    const r = new MockGridRenderer();
    r.resize(1200, 800, 2);
    const configsBefore = r.configureCalls;
    r.markHidden();
    // markHidden is just a flag toggle — no configure, no resize.
    expect(r.configureCalls).toBe(configsBefore);
    expect(r.needsReconfigure).toBe(true);
    expect(r.markHiddenCalls).toBe(1);
  });

  test("resize() after markHidden() takes the full reconfigure path even at same dims", () => {
    // The exact "switch from editor → back to agent shell" sequence
    // the user reports as "black screen on switch back" — but at the
    // GridRenderer layer. CanvasGrid's visibility effect must call
    // markHidden() on the visible→hidden edge for this guarantee to
    // hold; the source pin below verifies that wire-up.
    const r = new MockGridRenderer();
    r.resize(1200, 800, 2);
    expect(r.configureCalls).toBe(1);
    // No-op resize while still healthy — fast path.
    r.resize(1200, 800, 2);
    expect(r.configureCalls).toBe(1);
    // Visibility flips to hidden. CanvasGrid signals.
    r.markHidden();
    // WKWebView silently releases the swapchain. Surface is now
    // effectively dead even though needsReconfigure already says so.
    r.killSurface();
    // User flips back. ResizeObserver fires with the SAME rect.
    r.resize(1200, 800, 2);
    // The configure must have fired — re-acquired the swapchain.
    expect(r.configureCalls).toBe(2);
    expect(r.surfaceAlive).toBe(true);
    // The very next draw paints, no extra work.
    expect(r.draw()).toBe("painted");
  });

  test("multiple hide/show cycles with unchanged dims each fire one reconfigure", () => {
    // Pin that repeated cycles don't degenerate — each cycle does
    // exactly ONE configure() (the one on the show resize), no
    // accumulating work.
    const r = new MockGridRenderer();
    r.resize(1200, 800, 2);
    const baseline = r.configureCalls; // 1 (initial)
    for (let i = 0; i < 10; i++) {
      r.markHidden();
      r.killSurface();
      r.resize(1200, 800, 2);
      expect(r.draw()).toBe("painted");
    }
    // 10 cycles × 1 configure each = 10, plus the initial = 11.
    expect(r.configureCalls).toBe(baseline + 10);
  });

  test("markHidden() does NOT itself paint or invalidate", () => {
    // The signal is dirt-cheap by design — no draw work happens
    // while we're going hidden. The slow work waits for the show.
    const r = new MockGridRenderer();
    r.resize(1200, 800, 2);
    const paintsBefore = r.paints;
    const invalidatesBefore = r.invalidateCalls;
    r.markHidden();
    expect(r.paints).toBe(paintsBefore);
    expect(r.invalidateCalls).toBe(invalidatesBefore);
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

describe("GridRenderer heartbeat — periodic reconfigure during sustained rendering", () => {
  // The user-reported bug class this guards: "agent shell goes black
  // mid-run, no tab switch, no resize, nothing — it just goes black."
  // WKWebView can silently release the GPU surface; nothing in the
  // visibility-restore / resize / draw-retry paths fires. The
  // heartbeat is the safety net: every HEARTBEAT_FRAMES successful
  // paints, the next draw pre-emptively reconfigures the swapchain.

  test("first HEARTBEAT_FRAMES draws don't trigger a heartbeat reconfigure", () => {
    // The fast path of the heartbeat — every paint inside the window
    // skips the reconfigure entirely.
    const r = new MockGridRenderer();
    for (let i = 0; i < HEARTBEAT_FRAMES; i++) {
      expect(r.draw()).toBe("painted");
    }
    // Zero reconfigures: every draw was inside the threshold and
    // the surface was healthy.
    expect(r.configureCalls).toBe(0);
    expect(r.paints).toBe(HEARTBEAT_FRAMES);
  });

  test("draw HEARTBEAT_FRAMES + 1 fires exactly one heartbeat reconfigure", () => {
    // The threshold-crossing edge. Once the counter reaches
    // HEARTBEAT_FRAMES, the next draw flags needsReconfigure and
    // reconfigures the surface. The reconfigure resets the counter
    // so subsequent draws inside the next window don't compound.
    const r = new MockGridRenderer();
    for (let i = 0; i < HEARTBEAT_FRAMES; i++) {
      r.draw();
    }
    expect(r.configureCalls).toBe(0);
    // The HEARTBEAT_FRAMES + 1th draw trips the heartbeat.
    r.draw();
    expect(r.configureCalls).toBe(1);
    // All draws still painted — heartbeat is transparent to the
    // caller, not a frame skip.
    expect(r.paints).toBe(HEARTBEAT_FRAMES + 1);
  });

  test("heartbeat counter resets after each forced reconfigure", () => {
    // The whole point — heartbeats fire at a steady cadence, not
    // every frame past the threshold.
    const r = new MockGridRenderer();
    for (let i = 0; i < HEARTBEAT_FRAMES * 3 + 1; i++) {
      r.draw();
    }
    // 3 full windows × 1 reconfigure each = 3.
    expect(r.configureCalls).toBe(3);
    expect(r.paints).toBe(HEARTBEAT_FRAMES * 3 + 1);
  });

  test("explicit reconfigure resets the heartbeat clock", () => {
    // A resize-time configure (or any other explicit reconfigure)
    // must reset the counter so the next heartbeat is still
    // HEARTBEAT_FRAMES draws away. Otherwise heartbeats would fire
    // immediately after a resize, doubling configure work.
    const r = new MockGridRenderer();
    // Build counter up to one short of the threshold.
    for (let i = 0; i < HEARTBEAT_FRAMES - 1; i++) {
      r.draw();
    }
    expect(r.configureCalls).toBe(0);
    // Explicit reconfigure — should reset the heartbeat clock.
    r.reconfigure();
    expect(r.configureCalls).toBe(1);
    expect(r.framesSinceReconfigure).toBe(0);
    // Now we should be able to draw HEARTBEAT_FRAMES more times
    // without tripping another heartbeat.
    for (let i = 0; i < HEARTBEAT_FRAMES; i++) {
      r.draw();
    }
    // No new heartbeat configures — counter was reset by the
    // explicit reconfigure.
    expect(r.configureCalls).toBe(1);
  });

  test("resize that runs configure also resets the heartbeat clock", () => {
    // resize() ends with a configure call; that configure must
    // reset the counter just like an explicit reconfigure does.
    // Otherwise a heartbeat could fire immediately after a real
    // dimension-changing resize.
    const r = new MockGridRenderer();
    // Initial resize establishes the baseline dimensions.
    r.resize(1200, 800, 2);
    expect(r.configureCalls).toBe(1);
    // Build counter close to the threshold.
    for (let i = 0; i < HEARTBEAT_FRAMES - 1; i++) {
      r.draw();
    }
    // Now a real dimension-changing resize — should reset.
    r.resize(1400, 800, 2);
    expect(r.configureCalls).toBe(2);
    expect(r.framesSinceReconfigure).toBe(0);
    // Next HEARTBEAT_FRAMES draws stay under threshold.
    for (let i = 0; i < HEARTBEAT_FRAMES; i++) {
      r.draw();
    }
    expect(r.configureCalls).toBe(2);
  });

  test("skipped frames do NOT advance the heartbeat counter", () => {
    // If a dead-surface skip ticked the counter, a long failure run
    // would trip the heartbeat almost immediately — the OPPOSITE of
    // what we want during failure recovery. Only successful submits
    // count.
    const r = new MockGridRenderer();
    // Permanently dead surface (mirrors the real "can't recover")
    // path — every draw will skip.
    r.killSurface();
    const origReconfigure = r.reconfigure.bind(r);
    r.reconfigure = () => {
      origReconfigure();
      r.surfaceAlive = false;
    };
    for (let i = 0; i < HEARTBEAT_FRAMES * 2; i++) {
      expect(r.draw()).toBe("skipped");
    }
    // The counter never advances on skip — so its value stays 0.
    expect(r.framesSinceReconfigure).toBe(0);
    expect(r.paints).toBe(0);
  });

  test("idle (no draw calls) never triggers a heartbeat", () => {
    // The heartbeat is a per-paint check, not a wall-clock timer.
    // A terminal that's not actively rendering pays zero configure
    // cost no matter how long it sits idle. This is what makes the
    // safety net free.
    const r = new MockGridRenderer();
    // No draws.
    expect(r.configureCalls).toBe(0);
    expect(r.framesSinceReconfigure).toBe(0);
  });

  test("HEARTBEAT_FRAMES is a small enough window to recover within ~1 second at 60Hz", () => {
    // Tight bound. If a future refactor pushes the threshold past
    // a few seconds, the "stuck black" perception comes back.
    // 60 frames ≈ 1s — the user's perceptual stuck threshold is
    // multiple seconds, so this gives generous headroom.
    expect(HEARTBEAT_FRAMES).toBeLessThanOrEqual(120);
    // And big enough that the per-second configure cost stays cheap.
    // At HEARTBEAT_FRAMES = 1, we'd reconfigure every paint — that
    // defeats the perf-win of the fast-path resize.
    expect(HEARTBEAT_FRAMES).toBeGreaterThanOrEqual(30);
  });

  test("heartbeat interleaves cleanly with the draw-retry recovery", () => {
    // Confirm the two recovery mechanisms compose: heartbeat fires
    // a pre-emptive reconfigure, and any draw-time failure still
    // routes through the try/catch retry. Neither path's bookkeeping
    // corrupts the other.
    const r = new MockGridRenderer();
    // Run up to a heartbeat threshold so the next draw will fire one.
    for (let i = 0; i < HEARTBEAT_FRAMES; i++) {
      r.draw();
    }
    // Surface dies right before the heartbeat-triggered draw.
    r.killSurface();
    // The next draw: heartbeat reconfigures (recovers surface),
    // first acquireSurface succeeds, paint goes through. NO retry
    // path was needed because heartbeat already healed it.
    const result = r.draw();
    expect(result).toBe("painted");
    expect(r.surfaceAlive).toBe(true);
  });

  test("after a hide-cycle markHidden + heartbeat threshold the next draw configures exactly once", () => {
    // Subtle: a draw run while hidden races with the heartbeat clock.
    // The hidden draws shouldn't compound — when we come back
    // visible, only ONE reconfigure fires (the markHidden-driven
    // path takes care of it; the heartbeat had no chance to tick
    // because nothing was drawing).
    const r = new MockGridRenderer();
    // Initial paint to establish the baseline.
    for (let i = 0; i < 10; i++) r.draw();
    expect(r.configureCalls).toBe(0);
    // Hide. No more draws happen during hide window (the keepalive
    // layer + visibility gate in useTerminalSession together stop
    // them).
    r.markHidden();
    r.killSurface();
    // Comeback resize at same dims — slow path runs because
    // needsReconfigure is set. One configure.
    r.resize(0, 0, 1); // initial baseline so lastPhys is 0,0
    expect(r.configureCalls).toBe(1);
    // Next paint: needsReconfigure was already cleared by resize's
    // configure, surface is live, normal paint.
    expect(r.draw()).toBe("painted");
    // Still just one reconfigure for the whole hide/show cycle.
    expect(r.configureCalls).toBe(1);
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
    const resizeBody = extractMethodBody(src, "resize(cssWidth");
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

  test("exposes a `markHidden(): void` method", () => {
    // The signal CanvasGrid uses on visible→hidden so the next
    // resize at the same dimensions still re-acquires the swapchain.
    // Without this, the resize fast path skips the configure and
    // the user lands on a dead WKWebView surface = black pane.
    expect(src).toContain("markHidden(): void");
  });

  test("markHidden() sets needsReconfigure", () => {
    // The flag is what the resize() fast-path inspects to decide
    // "no-op or full path." If markHidden ever stops setting it,
    // the visibility-restore path silently degrades.
    const markHiddenBody = extractMethodBody(src, "markHidden(): void");
    expect(markHiddenBody).toContain("this.needsReconfigure = true");
  });

  test("GridRenderer tracks lastPhysWidth and lastPhysHeight", () => {
    // The two fields the resize() fast path compares against. Without
    // them no caching is possible and every resize is a slow path.
    expect(src).toMatch(/private\s+lastPhysWidth\s*=/);
    expect(src).toMatch(/private\s+lastPhysHeight\s*=/);
  });

  test("resize() short-circuits when dimensions unchanged AND surface healthy", () => {
    // The actual perf win. The check MUST gate on BOTH the dims
    // AND the needsReconfigure flag — gating on dims alone would
    // skip the visibility-restore reconfigure when WKWebView
    // silently released the surface.
    const resizeBody = extractMethodBody(src, "resize(cssWidth");
    expect(resizeBody).toContain("this.lastPhysWidth");
    expect(resizeBody).toContain("this.lastPhysHeight");
    expect(resizeBody).toContain("!this.needsReconfigure");
    // The early-return is the load-bearing line — without it the
    // check evaluates but the work runs anyway.
    expect(resizeBody).toMatch(/if\s*\([^)]*lastPhysWidth[^)]*\)[\s\S]*?return;/);
  });

  test("resize() caches new dimensions after the work runs", () => {
    // Without updating lastPhysWidth/lastPhysHeight at the end, the
    // fast path would never trigger and every resize would do full
    // work — the optimisation degenerates to a no-op.
    const resizeBody = extractMethodBody(src, "resize(cssWidth");
    expect(resizeBody).toMatch(/this\.lastPhysWidth\s*=\s*physWidth/);
    expect(resizeBody).toMatch(/this\.lastPhysHeight\s*=\s*physHeight/);
  });

  test("declares the HEARTBEAT_FRAMES constant", () => {
    // The heartbeat threshold. Without this constant the periodic
    // reconfigure can't exist — and "agent shell goes black mid-run
    // with no tab switch" comes back.
    expect(src).toMatch(/const\s+HEARTBEAT_FRAMES\s*=\s*\d+/);
  });

  test("HEARTBEAT_FRAMES is in [30, 120] to balance recovery latency vs configure cost", () => {
    // Same bound as the behavioral test, asserted on the production
    // value (not just the mock). 30..120 keeps the recovery window
    // under ~2 seconds at 60Hz while staying well above the per-paint
    // configure threshold that would defeat the resize fast-path.
    const m = src.match(/const\s+HEARTBEAT_FRAMES\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    const value = parseInt(m![1], 10);
    expect(value).toBeGreaterThanOrEqual(30);
    expect(value).toBeLessThanOrEqual(120);
  });

  test("the mock's HEARTBEAT_FRAMES matches the production value", () => {
    // Without this pin the behavioral tests pass forever against the
    // mock even if production drifts. Reading the production constant
    // and asserting it equals our local mirror catches the drift the
    // moment it lands.
    const m = src.match(/const\s+HEARTBEAT_FRAMES\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    const prodValue = parseInt(m![1], 10);
    expect(HEARTBEAT_FRAMES).toBe(prodValue);
  });

  test("tracks framesSinceReconfigure on the instance", () => {
    // The counter field that drives the heartbeat. Renaming it
    // without updating the draw() check silently disables the
    // heartbeat — pin the field name AND its initial value.
    expect(src).toMatch(/private\s+framesSinceReconfigure\s*=\s*0/);
  });

  test("draw() checks framesSinceReconfigure against HEARTBEAT_FRAMES", () => {
    // The actual trigger. Pin both the field reference AND the
    // threshold constant inside draw() so a rename of either
    // collapses to a test failure rather than a silent regression.
    const drawBody = extractMethodBody(src, "private draw");
    expect(drawBody).toContain("framesSinceReconfigure");
    expect(drawBody).toContain("HEARTBEAT_FRAMES");
    // The check must SET needsReconfigure when threshold reached.
    expect(drawBody).toMatch(
      /framesSinceReconfigure\s*>=\s*HEARTBEAT_FRAMES[\s\S]*?needsReconfigure\s*=\s*true/,
    );
  });

  test("draw() increments framesSinceReconfigure on successful paint", () => {
    // Without the increment, the heartbeat never fires. Without
    // putting it AFTER the submit (not at the top of draw), a
    // failing draw would tick the counter and trip the heartbeat
    // during failure mode — exactly the wrong time.
    const drawBody = extractMethodBody(src, "private draw");
    expect(drawBody).toMatch(/framesSinceReconfigure\+\+/);
    // The increment must live AFTER the queue.submit call — that's
    // the "only count submitted frames" contract.
    const submitIdx = drawBody.indexOf("queue.submit");
    const incrementIdx = drawBody.indexOf("framesSinceReconfigure++");
    expect(submitIdx).toBeGreaterThanOrEqual(0);
    expect(incrementIdx).toBeGreaterThan(submitIdx);
  });

  test("reconfigure() resets framesSinceReconfigure", () => {
    // The clock-reset that makes heartbeats fire at a steady cadence
    // instead of every paint past the threshold.
    const reconfigureBody = extractMethodBody(src, "reconfigure(): void");
    expect(reconfigureBody).toMatch(/framesSinceReconfigure\s*=\s*0/);
  });

  test("resize() success path also resets framesSinceReconfigure", () => {
    // resize() routes through context.configure() directly (not
    // through this.reconfigure()), so it needs its own reset. Without
    // it, every dimension-changing resize would leave the heartbeat
    // clock running from a stale start — and a heartbeat would fire
    // immediately after.
    const resizeBody = extractMethodBody(src, "resize(cssWidth");
    expect(resizeBody).toMatch(/framesSinceReconfigure\s*=\s*0/);
  });
});

/**
 * `successfulDrawCount` — the proof-of-life signal CanvasGrid's
 * escalation ladder reads to decide whether the WKWebView GPU
 * surface is alive. Counts CUMULATIVE successful frame submissions
 * since construction (no reset on reconfigure — see field doc in
 * GridRenderer.ts for the rationale).
 *
 * If the renderer paints fine but this counter doesn't advance,
 * the React layer cannot distinguish a healthy canvas from a
 * silently-dead one and the user is stuck on persistent black.
 * These tests pin the contract so a future refactor that breaks
 * the signal trips here instead of in production.
 */
describe("GridRenderer.successfulDrawCount — proof-of-life counter", () => {
  const src = readFileSync(
    join(import.meta.dir, "GridRenderer.ts"),
    "utf8",
  );

  test("private field `successfulDraws` declared with initial 0", () => {
    expect(src).toMatch(/private\s+successfulDraws\s*=\s*0/);
  });

  test("public getter `successfulDrawCount` exposes the counter", () => {
    // Use a relaxed match — getter syntax can vary in whitespace but
    // the name + return identifier must both be present.
    const getterMatch = src.match(
      /get\s+successfulDrawCount\s*\([^)]*\)[^{]*\{[\s\S]*?return\s+this\.successfulDraws/,
    );
    expect(getterMatch).not.toBeNull();
  });

  test("draw() increments `successfulDraws` on successful submit", () => {
    const drawBody = extractMethodBody(src, "private draw");
    expect(drawBody).toMatch(/successfulDraws\+\+/);
    // Must live AFTER queue.submit — same "post-submit only" contract
    // as framesSinceReconfigure, so a failed-then-skipped frame
    // doesn't fake a success.
    const submitIdx = drawBody.indexOf("queue.submit");
    const incIdx = drawBody.indexOf("successfulDraws++");
    expect(submitIdx).toBeGreaterThanOrEqual(0);
    expect(incIdx).toBeGreaterThan(submitIdx);
  });

  test("reconfigure() does NOT reset `successfulDraws`", () => {
    // CRITICAL: the escalation ladder reads this as "has this
    // renderer instance EVER painted?". A reset on reconfigure would
    // make a heartbeat-triggered reconfigure look like a fresh-mount
    // dead canvas to the ladder, triggering unnecessary rebuilds.
    const reconfigureBody = extractMethodBody(src, "reconfigure(): void");
    expect(reconfigureBody).not.toMatch(/successfulDraws\s*=\s*0/);
  });

  test("counter is capped to MAX_SAFE_INTEGER to avoid overflow", () => {
    // Defensive — a long-running session could theoretically wrap if
    // we let the counter grow unchecked. Pin the cap so a future
    // refactor doesn't drop it.
    const drawBody = extractMethodBody(src, "private draw");
    expect(drawBody).toMatch(/MAX_SAFE_INTEGER/);
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
