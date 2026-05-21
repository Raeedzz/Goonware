import { describe, expect, test } from "bun:test";
import {
  decideVisibilityAction,
  executeVisibilityAction,
  type RestoreCallbacks,
  type VisibilityAction,
  type VisibilityState,
} from "./visibilityRestore";

/**
 * Exhaustive regression guards for the WebGPU canvas visibility-
 * restore state machine.
 *
 * Symptoms these tests pin (all variants of the same root cause —
 * GPU surface release under `display: none`):
 *
 *   - Black screen on `/model` selection inside Claude.
 *   - Black screen on switch to editor / diff / markdown tab and back.
 *   - Black screen mid-stream as prompts fire (autoHeightPx
 *     oscillating against zero between frames).
 *   - Black screen on worktree switch.
 *
 * The contract (encoded by `decideVisibilityAction` + `executeVisibility-
 * Action`):
 *
 *   - 0×0 rect on visibility-restore defers — never resize a dead
 *     surface to nothing.
 *   - Hidden→visible always reconfigures the GPU surface BEFORE the
 *     resize, then invalidates seq, then paints.
 *   - Visible→hidden does nothing (no work to do until we come back).
 *   - The four call-order rules in `executeVisibilityAction` must be
 *     observable in test mocks.
 *
 * If any of these regress, the bug ships in a DMG and the user sees
 * black. The cost of these tests is microseconds; the cost of a
 * silent regression is "the entire agent screen goes black."
 */

function build(state: Partial<VisibilityState> = {}): VisibilityState {
  return {
    wasVisible: false,
    isVisible: true,
    rectWidth: 800,
    rectHeight: 600,
    ...state,
  };
}

describe("decideVisibilityAction — exhaustive transition table", () => {
  // Each row is one cell of the {wasVisible, isVisible, rect>0} cube.
  // Pinning the full 2×2×2 keeps a future "simplification" from
  // silently dropping a state.
  const cases: Array<{
    name: string;
    state: VisibilityState;
    expected: VisibilityAction;
  }> = [
    {
      name: "hidden → hidden (stay hidden) with rect",
      state: build({ wasVisible: false, isVisible: false }),
      expected: "noop",
    },
    {
      name: "hidden → hidden with 0×0 rect",
      state: build({
        wasVisible: false,
        isVisible: false,
        rectWidth: 0,
        rectHeight: 0,
      }),
      expected: "noop",
    },
    {
      name: "visible → visible (no transition)",
      state: build({ wasVisible: true, isVisible: true }),
      expected: "noop",
    },
    {
      name: "visible → visible with 0×0 rect (mid-resize hiccup)",
      state: build({
        wasVisible: true,
        isVisible: true,
        rectWidth: 0,
        rectHeight: 0,
      }),
      expected: "noop",
    },
    {
      name: "visible → hidden (going away)",
      state: build({ wasVisible: true, isVisible: false }),
      expected: "noop",
    },
    {
      name: "visible → hidden with 0×0 rect",
      state: build({
        wasVisible: true,
        isVisible: false,
        rectWidth: 0,
        rectHeight: 0,
      }),
      expected: "noop",
    },
    {
      name: "hidden → visible with non-zero rect (the happy restore)",
      state: build({ wasVisible: false, isVisible: true }),
      expected: "restore",
    },
    {
      name: "hidden → visible with 0×0 rect (defer until rect lands)",
      state: build({
        wasVisible: false,
        isVisible: true,
        rectWidth: 0,
        rectHeight: 0,
      }),
      expected: "defer",
    },
    {
      name: "hidden → visible with 0 width but non-zero height (defer)",
      state: build({
        wasVisible: false,
        isVisible: true,
        rectWidth: 0,
        rectHeight: 600,
      }),
      expected: "defer",
    },
    {
      name: "hidden → visible with non-zero width but 0 height (defer)",
      state: build({
        wasVisible: false,
        isVisible: true,
        rectWidth: 800,
        rectHeight: 0,
      }),
      expected: "defer",
    },
    {
      name: "hidden → visible with negative rect (defensive)",
      // Some browser implementations have been observed to report
      // negative content-box rects during display transitions
      // (typically rounding bugs near 0). Treat the same as 0×0.
      state: build({
        wasVisible: false,
        isVisible: true,
        rectWidth: -2,
        rectHeight: 5,
      }),
      expected: "defer",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(decideVisibilityAction(c.state)).toBe(c.expected);
    });
  }
});

describe("decideVisibilityAction — the deferred restore eventually catches up", () => {
  // Simulates the exact sequence the user observes:
  //   1. They're on the terminal tab — CanvasGrid mounted, visible.
  //   2. They switch to the editor — keepalive flips display: none.
  //   3. The wrapper is now 0×0 (display: none has no box).
  //   4. They switch back — display: flex re-applied.
  //   5. React re-renders with isVisible=true, but
  //      ResizeObserver hasn't yet fired so wrapper rect is still
  //      cached at 0×0 for the very first render tick.
  //   6. Next tick: ResizeObserver fires; rect is now the real size.
  //
  // Without the defer action, step 5 would call `resize(0, 0)` and
  // shrink the GPU surface back to 1×1 physical pixels — the user
  // is stuck in black. With defer, step 5 no-ops and step 6's
  // ResizeObserver tick performs the resize from a real rect.
  test("0×0 rect on first restore tick defers, then real rect restores", () => {
    // Step 5: react render with isVisible=true but stale 0×0 rect.
    const tick5 = decideVisibilityAction({
      wasVisible: false,
      isVisible: true,
      rectWidth: 0,
      rectHeight: 0,
    });
    expect(tick5).toBe("defer");

    // Step 6: ResizeObserver tick with real rect. The wasVisible
    // ref STAYS false because the previous restore was deferred —
    // the ref only advances on a successful restore. So this tick
    // sees wasVisible=false, isVisible=true, real rect → restore.
    const tick6 = decideVisibilityAction({
      wasVisible: false,
      isVisible: true,
      rectWidth: 1200,
      rectHeight: 800,
    });
    expect(tick6).toBe("restore");
  });
});

/**
 * Stub callbacks that just record what was called and in what order.
 * The recorder is the unit under test for `executeVisibilityAction`.
 */
function buildRecorder(): {
  callbacks: RestoreCallbacks;
  events: string[];
} {
  const events: string[] = [];
  return {
    events,
    callbacks: {
      reconfigure: () => events.push("reconfigure"),
      resizeFromRect: (w, h, dpr) =>
        events.push(`resizeFromRect(${w},${h},${dpr})`),
      invalidate: () => events.push("invalidate"),
      paint: () => events.push("paint"),
    },
  };
}

describe("executeVisibilityAction — noop / defer perform zero side effects", () => {
  test("noop action fires no callbacks", () => {
    const { callbacks, events } = buildRecorder();
    executeVisibilityAction("noop", callbacks, 800, 600, 2);
    expect(events).toEqual([]);
  });

  test("defer action fires no callbacks", () => {
    // The deferred restore is supposed to be a no-op on this tick;
    // a future ResizeObserver tick fires the real restore. If
    // executeVisibilityAction ever started calling reconfigure on
    // defer, we'd touch the surface with no rect to resize against
    // — the user would land in a partial-restore state.
    const { callbacks, events } = buildRecorder();
    executeVisibilityAction("defer", callbacks, 0, 0, 2);
    expect(events).toEqual([]);
  });
});

describe("executeVisibilityAction — restore follows the exact ordering", () => {
  test("restore fires reconfigure → resize → invalidate → paint, in order", () => {
    const { callbacks, events } = buildRecorder();
    executeVisibilityAction("restore", callbacks, 1024, 768, 2);
    expect(events).toEqual([
      "reconfigure",
      "resizeFromRect(1024,768,2)",
      "invalidate",
      "paint",
    ]);
  });

  test("reconfigure ALWAYS precedes resize", () => {
    // The load-bearing ordering rule. Reconfigure first acquires a
    // live swapchain; only then can resize meaningfully target it.
    // If a future refactor swaps the order (e.g. "let resize happen
    // first because the size affects buffer allocation"), this test
    // catches it before the bug ships.
    const { callbacks, events } = buildRecorder();
    executeVisibilityAction("restore", callbacks, 800, 600, 1);
    const reconfigureIdx = events.indexOf("reconfigure");
    const resizeIdx = events.findIndex((e) => e.startsWith("resizeFromRect"));
    expect(reconfigureIdx).toBeGreaterThanOrEqual(0);
    expect(resizeIdx).toBeGreaterThanOrEqual(0);
    expect(reconfigureIdx).toBeLessThan(resizeIdx);
  });

  test("invalidate ALWAYS precedes paint", () => {
    // Without invalidate-before-paint, the renderer's seq-dedupe
    // skips paint when the backend frame seq didn't bump while we
    // were hidden — and the user sees the cleared-black buffer.
    const { callbacks, events } = buildRecorder();
    executeVisibilityAction("restore", callbacks, 800, 600, 1);
    const invalidateIdx = events.indexOf("invalidate");
    const paintIdx = events.indexOf("paint");
    expect(invalidateIdx).toBeGreaterThanOrEqual(0);
    expect(paintIdx).toBeGreaterThanOrEqual(0);
    expect(invalidateIdx).toBeLessThan(paintIdx);
  });

  test("paint is the LAST callback to fire", () => {
    // Anything fired after paint would land before the user sees
    // the restored frame at best, and at worst land in the next
    // frame and produce an extra render that paints on top.
    const { callbacks, events } = buildRecorder();
    executeVisibilityAction("restore", callbacks, 800, 600, 1);
    expect(events[events.length - 1]).toBe("paint");
  });

  test("rect dimensions are forwarded verbatim to resize", () => {
    // Pin that we don't accidentally drop the rect when forwarding
    // — a subtle bug would be e.g. swapping w/h order or rounding
    // through a stale ref.
    const { callbacks, events } = buildRecorder();
    executeVisibilityAction("restore", callbacks, 1920, 1080, 3);
    expect(events).toContain("resizeFromRect(1920,1080,3)");
  });
});

describe("executeVisibilityAction — restore is fully ordered (full integration)", () => {
  // Combine deciding + executing across a realistic transition
  // sequence the user actually drives.
  test("user opens app → switches tab → comes back → restore fires once with correct rect", () => {
    const events: Array<{ tick: string; action: VisibilityAction; events: string[] }> = [];

    // Tick 0: initial mount, visible.
    const tick0 = decideVisibilityAction({
      wasVisible: true,
      isVisible: true,
      rectWidth: 1200,
      rectHeight: 800,
    });
    {
      const r = buildRecorder();
      executeVisibilityAction(tick0, r.callbacks, 1200, 800, 2);
      events.push({ tick: "0 (mount visible)", action: tick0, events: r.events });
    }

    // Tick 1: user switches to editor → keepalive flips display:none.
    const tick1 = decideVisibilityAction({
      wasVisible: true,
      isVisible: false,
      rectWidth: 0,
      rectHeight: 0,
    });
    {
      const r = buildRecorder();
      executeVisibilityAction(tick1, r.callbacks, 0, 0, 2);
      events.push({ tick: "1 (hide)", action: tick1, events: r.events });
    }

    // Tick 2: user comes back, ResizeObserver lagging — still 0×0.
    const tick2 = decideVisibilityAction({
      wasVisible: false,
      isVisible: true,
      rectWidth: 0,
      rectHeight: 0,
    });
    {
      const r = buildRecorder();
      executeVisibilityAction(tick2, r.callbacks, 0, 0, 2);
      events.push({ tick: "2 (visible, defer)", action: tick2, events: r.events });
    }

    // Tick 3: ResizeObserver catches up, real rect lands.
    const tick3 = decideVisibilityAction({
      wasVisible: false,
      isVisible: true,
      rectWidth: 1200,
      rectHeight: 800,
    });
    {
      const r = buildRecorder();
      executeVisibilityAction(tick3, r.callbacks, 1200, 800, 2);
      events.push({ tick: "3 (visible, restore)", action: tick3, events: r.events });
    }

    expect(events[0].action).toBe("noop");
    expect(events[0].events).toEqual([]);
    expect(events[1].action).toBe("noop");
    expect(events[1].events).toEqual([]);
    expect(events[2].action).toBe("defer");
    expect(events[2].events).toEqual([]);
    expect(events[3].action).toBe("restore");
    expect(events[3].events).toEqual([
      "reconfigure",
      "resizeFromRect(1200,800,2)",
      "invalidate",
      "paint",
    ]);
  });

  test("multiple rapid show/hide cycles each fire exactly one restore on show", () => {
    // The autoHeightPx oscillation case: user reports "blanks
    // randomly as prompts are firing." If the canvas briefly
    // transitions to 0×0 (autoHeightPx hits floor) and then back,
    // each cycle gets exactly one restore.
    //
    // Pin that we don't fire MULTIPLE restores per show — that
    // would multiply GPU reconfigure work and could itself produce
    // a black flash.
    const cycles: VisibilityAction[] = [];
    let wasVisible = true;
    const flipsAndExpected: Array<{
      isVisible: boolean;
      width: number;
      height: number;
      expected: VisibilityAction;
    }> = [
      { isVisible: false, width: 0, height: 0, expected: "noop" },
      { isVisible: true, width: 1200, height: 800, expected: "restore" },
      { isVisible: false, width: 0, height: 0, expected: "noop" },
      { isVisible: true, width: 1200, height: 800, expected: "restore" },
      { isVisible: false, width: 0, height: 0, expected: "noop" },
      { isVisible: true, width: 1200, height: 800, expected: "restore" },
    ];

    for (const f of flipsAndExpected) {
      const action = decideVisibilityAction({
        wasVisible,
        isVisible: f.isVisible,
        rectWidth: f.width,
        rectHeight: f.height,
      });
      cycles.push(action);
      expect(action).toBe(f.expected);
      // Mirror the caller's "advance the wasVisibleRef on each
      // tick" contract.
      wasVisible = f.isVisible;
    }

    const restoreCount = cycles.filter((a) => a === "restore").length;
    expect(restoreCount).toBe(3);
  });
});

describe("executeVisibilityAction — defensive: unknown action types degrade safely", () => {
  // A future change might add a new action variant. If the
  // executor doesn't recognise it, default to no-op rather than
  // partial work — partial state on a GPU surface is worse than
  // skipping a frame.
  test("an unknown action does nothing", () => {
    const { callbacks, events } = buildRecorder();
    // Cast through unknown so we can poke an off-table value
    // without TS yelling.
    executeVisibilityAction(
      "rebuild-pipeline" as unknown as VisibilityAction,
      callbacks,
      800,
      600,
      1,
    );
    expect(events).toEqual([]);
  });
});
