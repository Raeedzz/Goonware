import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOOTSTRAP_RETRY_DELAYS_MS,
  decideEscalation,
  ESCALATION_DELAYS_MS,
  MAX_REBUILD_ATTEMPTS,
  type EscalationState,
} from "./canvasGridEscalation";

/**
 * Exhaustive tests for the CanvasGrid escalation decision function.
 * The state machine has 5 inputs (attempt, currentDrawCount,
 * isVisible, hasFrame, maxAttempts) and 3 outputs (stop/escalate/
 * give-up) — small enough to enumerate the cases that matter rather
 * than rely on hand-picked examples.
 */

function state(overrides: Partial<EscalationState> = {}): EscalationState {
  return {
    attempt: 0,
    currentDrawCount: 0,
    isVisible: true,
    hasFrame: true,
    maxAttempts: MAX_REBUILD_ATTEMPTS,
    ...overrides,
  };
}

describe("decideEscalation — short-circuit on healthy canvas", () => {
  test("any positive draw count → stop, regardless of other state", () => {
    expect(decideEscalation(state({ currentDrawCount: 1 }))).toBe("stop");
    expect(
      decideEscalation(state({ currentDrawCount: 1, isVisible: false })),
    ).toBe("stop");
    expect(
      decideEscalation(state({ currentDrawCount: 1, hasFrame: false })),
    ).toBe("stop");
    // Even past max attempts — if it just started painting, that's a win.
    expect(
      decideEscalation(
        state({ currentDrawCount: 999, attempt: MAX_REBUILD_ATTEMPTS + 1 }),
      ),
    ).toBe("stop");
  });

  test("count == 0 is NOT 'painting' — falls through to other checks", () => {
    // No frame, no visibility, no draws: stop because there's no work,
    // not because the canvas is healthy.
    expect(decideEscalation(state({ hasFrame: false }))).toBe("stop");
  });
});

describe("decideEscalation — no-work cases", () => {
  test("hasFrame false → stop (no input to draw)", () => {
    expect(decideEscalation(state({ hasFrame: false }))).toBe("stop");
    expect(
      decideEscalation(state({ hasFrame: false, isVisible: false })),
    ).toBe("stop");
    expect(
      decideEscalation(
        state({ hasFrame: false, attempt: MAX_REBUILD_ATTEMPTS }),
      ),
    ).toBe("stop");
  });

  test("isVisible false (and has frame) → stop (compositor not active)", () => {
    expect(decideEscalation(state({ isVisible: false }))).toBe("stop");
    expect(
      decideEscalation(
        state({ isVisible: false, attempt: MAX_REBUILD_ATTEMPTS }),
      ),
    ).toBe("stop");
  });
});

describe("decideEscalation — the escalate path", () => {
  test("first attempt against dead canvas → escalate", () => {
    expect(decideEscalation(state({ attempt: 0 }))).toBe("escalate");
  });

  test("each attempt up to the cap → escalate", () => {
    for (let i = 0; i < MAX_REBUILD_ATTEMPTS; i++) {
      expect(decideEscalation(state({ attempt: i }))).toBe("escalate");
    }
  });
});

describe("decideEscalation — the give-up path", () => {
  test("at-cap attempt with dead canvas → give-up", () => {
    expect(
      decideEscalation(state({ attempt: MAX_REBUILD_ATTEMPTS })),
    ).toBe("give-up");
  });

  test("past-cap attempt with dead canvas → give-up", () => {
    expect(
      decideEscalation(state({ attempt: MAX_REBUILD_ATTEMPTS + 5 })),
    ).toBe("give-up");
  });

  test("give-up is gated on hasFrame AND isVisible AND no paint", () => {
    // Even past cap, if we're hidden or have no frame, we say stop
    // (we wouldn't expect paints anyway — don't penalize the budget
    // for a state where painting is impossible).
    expect(
      decideEscalation(
        state({ attempt: MAX_REBUILD_ATTEMPTS, isVisible: false }),
      ),
    ).toBe("stop");
    expect(
      decideEscalation(
        state({ attempt: MAX_REBUILD_ATTEMPTS, hasFrame: false }),
      ),
    ).toBe("stop");
  });
});

describe("ESCALATION_DELAYS_MS — ladder contract", () => {
  test("exactly four steps", () => {
    expect(ESCALATION_DELAYS_MS.length).toBe(4);
  });

  test("strictly increasing", () => {
    for (let i = 1; i < ESCALATION_DELAYS_MS.length; i++) {
      expect(ESCALATION_DELAYS_MS[i]).toBeGreaterThan(
        ESCALATION_DELAYS_MS[i - 1],
      );
    }
  });

  test("first step is after the existing soft warmups (1200ms)", () => {
    // CanvasGrid bootstraps 50/200/500/1200 ms reconfigure ticks; the
    // first escalation must wait until those have had a chance to
    // recover. Hard-coded against the documented value in the source.
    expect(ESCALATION_DELAYS_MS[0]).toBeGreaterThanOrEqual(1300);
  });

  test("MAX_REBUILD_ATTEMPTS matches the ladder length", () => {
    expect(MAX_REBUILD_ATTEMPTS).toBe(ESCALATION_DELAYS_MS.length);
  });
});

describe("BOOTSTRAP_RETRY_DELAYS_MS — retry contract", () => {
  test("at least one retry, strictly increasing", () => {
    expect(BOOTSTRAP_RETRY_DELAYS_MS.length).toBeGreaterThan(0);
    for (let i = 1; i < BOOTSTRAP_RETRY_DELAYS_MS.length; i++) {
      expect(BOOTSTRAP_RETRY_DELAYS_MS[i]).toBeGreaterThan(
        BOOTSTRAP_RETRY_DELAYS_MS[i - 1],
      );
    }
  });

  test("first retry is fast enough to recover from transient adapter races", () => {
    // The user reports "this keeps happening" — fast first retry is
    // what keeps the recurring-but-transient case from punishing them.
    expect(BOOTSTRAP_RETRY_DELAYS_MS[0]).toBeLessThanOrEqual(1000);
  });
});

/**
 * Source pin: the escalation ladder MUST actually be wired up in
 * CanvasGrid.tsx. A regression where someone removes the timer chain
 * but leaves the pure module would pass every test above while
 * producing the original "stuck on black" symptom in production.
 */
describe("source pin — CanvasGrid uses the escalation ladder", () => {
  const canvasGridSrc = readFileSync(
    join(import.meta.dir, "CanvasGrid.tsx"),
    "utf8",
  );

  test("imports decideEscalation from the helper module", () => {
    expect(canvasGridSrc).toMatch(
      /from\s+["'].*canvasGridEscalation["']/,
    );
    expect(canvasGridSrc).toMatch(/decideEscalation/);
  });

  test("imports the ladder timing array", () => {
    expect(canvasGridSrc).toMatch(/ESCALATION_DELAYS_MS/);
  });

  test("imports the bootstrap retry delays", () => {
    expect(canvasGridSrc).toMatch(/BOOTSTRAP_RETRY_DELAYS_MS/);
  });

  test("reads successfulDrawCount from the renderer", () => {
    expect(canvasGridSrc).toMatch(/successfulDrawCount/);
  });
});

describe("source pin — GridRenderer exposes successfulDrawCount", () => {
  const rendererSrc = readFileSync(
    join(import.meta.dir, "gpu", "GridRenderer.ts"),
    "utf8",
  );

  test("getter exists on GridRenderer", () => {
    expect(rendererSrc).toMatch(/get\s+successfulDrawCount\s*\(\s*\)/);
  });

  test("counter is incremented inside draw()", () => {
    expect(rendererSrc).toMatch(/successfulDraws\+\+/);
  });
});

/**
 * Source pin: CanvasGrid's bootstrap path MUST defer createGridRenderer
 * until the wrapper has nonzero CSS dimensions. This is the load-bearing
 * prevention for the "open agent → all black, never recovers" bug:
 * context.configure() against a 0×0 canvas makes WKWebView hand back a
 * zombie swapchain that paints into the void forever, no errors fired.
 *
 * The escalation ladder is the safety net for unknown unknowns; this
 * gate is what makes the ladder almost never need to fire.
 *
 * If a future refactor inlines the configure call without the gate,
 * the ladder still works but users see 2.5+ seconds of black before
 * the first rebuild. These pins flag that regression at the source.
 */
describe("source pin — CanvasGrid bootstrap is size-gated", () => {
  const canvasGridSrc = readFileSync(
    join(import.meta.dir, "CanvasGrid.tsx"),
    "utf8",
  );

  test("guard reads the wrapper's bounding rect before bootstrap", () => {
    // The gate must measure the wrapper, not the canvas — the canvas
    // starts at its default 300×150 even when its parent is 0×0, so
    // checking the canvas alone would falsely report "ready" and
    // configure() would still run against a non-laid-out parent tree.
    expect(canvasGridSrc).toMatch(
      /wrapper\.getBoundingClientRect\(\)[\s\S]*?startBootstrapIfSized/,
    );
  });

  test("bootstrap short-circuits when either dimension is 0", () => {
    // Both width AND height must be nonzero. A canvas that's wide but
    // 0-tall (or vice versa) still has no backing surface as far as
    // WKWebView's swapchain is concerned.
    expect(canvasGridSrc).toMatch(
      /rect\.width\s*===\s*0\s*\|\|\s*rect\.height\s*===\s*0/,
    );
  });

  test("canvas is pre-sized before createGridRenderer runs", () => {
    // The whole point: configure() lands on a canvas with real
    // physical-pixel dimensions, not the default 300×150 or 0×0.
    // The pre-sizing must live in startBootstrapIfSized — pin both
    // the canvas.width assignment AND the canvas.style.width assignment
    // (the second is what makes the CSS box honest about its size).
    expect(canvasGridSrc).toMatch(/canvas\.width\s*=\s*physWidth/);
    expect(canvasGridSrc).toMatch(/canvas\.style\.width\s*=/);
  });

  test("ResizeObserver fallback covers 0×0-at-mount edge case", () => {
    // useEffect runs after layout, so most mounts hit the synchronous
    // path. The observer is the safety net for the keepalive-layer
    // initially-hidden case where the wrapper has no rect yet.
    expect(canvasGridSrc).toMatch(/new ResizeObserver/);
    expect(canvasGridSrc).toMatch(/bootstrapStarted/);
  });

  test("observer disconnects once bootstrap actually starts", () => {
    // Without disconnect, a runtime wrapper resize would re-trigger
    // startBootstrapIfSized, which would no-op (bootstrapStarted is
    // true) but the observer would keep firing for the lifetime of
    // the mount. Cheap, but the disconnect makes the lifecycle obvious.
    expect(canvasGridSrc).toMatch(
      /sizeObserver\??\.disconnect\(\)/,
    );
  });
});
