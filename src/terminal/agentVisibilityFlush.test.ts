import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guards for the "switch from editor (or different shell)
 * back to a shell running an agent → black screen" bug.
 *
 * Root cause this pins (full story in useTerminalSession.ts above the
 * `useLayoutEffect` for visibility flip):
 *
 *   1. While a terminal sits hidden behind `display: none`,
 *      useTerminalSession's `onFrame` handler updates `rowsRef` /
 *      `pendingFrameRef` in place but skips the `setLiveFrame()`
 *      commit (the visibility gate at the bottom of `onFrame`).
 *      The pending frame data stays in refs.
 *
 *   2. On the `isVisible: false → true` edge, the cached frame must
 *      be flushed into liveFrame state. The previous implementation
 *      wrapped the flush in `requestAnimationFrame` — which lands
 *      AFTER React has fired all useEffects for the current commit.
 *
 *   3. Meanwhile, CanvasGrid (rendering the agent TUI inside
 *      LiveBlock) has a `useEffect([isVisible])` that immediately
 *      calls its paint sequence (reconfigure → resize → invalidate
 *      → paint), reading `frameRef.current` for the paint data.
 *      React fires effects child → parent, so this paint happens
 *      BEFORE the parent's rAF-deferred flush would have updated
 *      the frame ref via prop propagation.
 *
 *   4. The paint draws stale (or null) frame data. User sees a
 *      black canvas on tab switch back to any agent shell.
 *
 * The fix this test pins:
 *
 *   - useTerminalSession uses `useLayoutEffect` (not `useEffect`)
 *     for the visibility flip, so it fires synchronously during
 *     the commit phase BEFORE the browser paints AND before child
 *     useEffects run.
 *
 *   - The layout effect calls a synchronous `flushNowRef`
 *     (not an rAF-deferred `requestFlushRef`). State updates
 *     inside a layout effect cause React to immediately re-render
 *     before paint, propagating the fresh liveFrame down through
 *     LiveBlock → CanvasGrid so `frameRef.current` is current by
 *     the time CanvasGrid's visibility-restore useEffect paints.
 *
 *   - CanvasGrid signals `renderer.markHidden()` on the visible→
 *     hidden edge so the next resize at the same wrapper rect
 *     still re-acquires the WKWebView swapchain.
 *
 * These are source-pin tests — they verify the code structure the
 * fix relies on. Unit-testing the actual React behaviour would
 * require spinning up a real React renderer with the keepalive
 * layer + a mock GPU, which is more harness than guard. The cost
 * of a regression here is "every agent shell goes black on tab
 * switch back," so we pin the load-bearing lines instead.
 */

const useTerminalSessionSrc = readFileSync(
  join(import.meta.dir, "useTerminalSession.ts"),
  "utf-8",
);

describe("useTerminalSession source pins — visibility flip flushes synchronously", () => {
  test("imports useLayoutEffect from react", () => {
    // The whole flush ordering relies on using a LAYOUT effect, not
    // a regular useEffect. If a future cleanup drops the import,
    // either the visibility flip silently becomes a useEffect again
    // (regression) or the file fails to compile (caught by tsc).
    // Either way this pin makes intent explicit.
    expect(useTerminalSessionSrc).toMatch(
      /import\s+\{[^}]*useLayoutEffect[^}]*\}\s+from\s+["']react["']/,
    );
  });

  test("visibility flip is a useLayoutEffect, not a useEffect", () => {
    // The bug class: a regular useEffect fires AFTER child useEffects
    // (effects flush child→parent), so CanvasGrid's
    // useEffect([isVisible]) paints with the stale frame before
    // useTerminalSession's flush gets a chance to commit.
    //
    // Search for the visibility-flip effect by its dependency
    // signature `[isVisible]` and verify the surrounding hook is
    // useLayoutEffect.
    const layoutEffectBlocks = useTerminalSessionSrc.match(
      /useLayoutEffect\(\(\)\s*=>\s*\{[\s\S]*?\},\s*\[isVisible\]\)/g,
    );
    expect(layoutEffectBlocks).not.toBeNull();
    expect(layoutEffectBlocks!.length).toBeGreaterThanOrEqual(1);
  });

  test("visibility-flip layout effect calls flushNowRef (not requestFlushRef)", () => {
    // The synchronous flush is what makes the layout-effect choice
    // pay off — wrapping the flush in requestAnimationFrame inside
    // a layout effect would push the React state update back into
    // the next paint cycle, reintroducing the race.
    const visibilityFlip = useTerminalSessionSrc.match(
      /useLayoutEffect\(\(\)\s*=>\s*\{[\s\S]*?\},\s*\[isVisible\]\)/,
    );
    expect(visibilityFlip).not.toBeNull();
    expect(visibilityFlip![0]).toContain("flushNowRef.current()");
    // Must NOT route through the rAF-deferred path here — that's
    // exactly the bug we're guarding against.
    expect(visibilityFlip![0]).not.toContain("requestFlushRef.current()");
  });

  test("declares a flushNowRef alongside requestFlushRef", () => {
    // The synchronous flush bridge. Without it the layout effect
    // would have nothing to call (or would call the rAF version
    // again).
    expect(useTerminalSessionSrc).toMatch(
      /flushNowRef\s*=\s*useRef<\(\)\s*=>\s*void>\(/,
    );
    expect(useTerminalSessionSrc).toMatch(
      /requestFlushRef\s*=\s*useRef<\(\)\s*=>\s*void>\(/,
    );
  });

  test("flushNowRef.current cancels any pending rAF before flushing synchronously", () => {
    // Critical: if a rAF flush was already scheduled (e.g. an
    // onFrame event landed in the same tick as the visibility
    // flip), we'd flush twice without the cancel — once now, once
    // on the next rAF tick. Both flushes would update the same
    // liveFrame state; the second is harmless but wastes the rAF
    // slot. The bigger reason is to keep the flush queue
    // single-source so subtle state-ordering bugs don't creep in.
    const flushNowAssignment = useTerminalSessionSrc.match(
      /flushNowRef\.current\s*=\s*\(\)\s*=>\s*\{[\s\S]*?\};/,
    );
    expect(flushNowAssignment).not.toBeNull();
    expect(flushNowAssignment![0]).toContain("cancelAnimationFrame(");
    expect(flushNowAssignment![0]).toContain("rafIdRef.current = null");
    // Must also actually call flushFrame — otherwise we cancel and
    // do nothing, which strands cached frame data.
    expect(flushNowAssignment![0]).toContain("flushFrame()");
  });

  test("flushNowRef.current respects the cancelled-effect guard", () => {
    // The main effect's cleanup sets `cancelled = true`. If
    // flushNowRef.current ran after unmount it'd touch React state
    // (setLiveFrame, etc.) on a dead component — React 19 warns
    // and may throw in StrictMode. Pin the early-return.
    const flushNowAssignment = useTerminalSessionSrc.match(
      /flushNowRef\.current\s*=\s*\(\)\s*=>\s*\{[\s\S]*?\};/,
    );
    expect(flushNowAssignment).not.toBeNull();
    expect(flushNowAssignment![0]).toMatch(/if\s*\(cancelled\)\s*return;/);
  });

  test("the visibility gate in onFrame still skips React commits while hidden", () => {
    // The optimisation that the synchronous flush relies on — if
    // onFrame ALWAYS committed state, there'd be nothing cached
    // in the refs to flush on the visibility flip (because
    // liveFrame would already be current). The whole flush /
    // hidden-cadence design only makes sense together.
    expect(useTerminalSessionSrc).toContain("if (!isVisibleRef.current) return;");
  });
});

describe("isVisible prop propagation — the cross-file contract", () => {
  // Pins the prop name `isVisible` flowing into useTerminalSession.
  // If anyone renames this prop in the hook, the hidden-cadence
  // optimisation breaks silently — no compile error because the
  // default value (true) takes over and everything appears to
  // work… until a tab switch reveals the regression.

  test("useTerminalSession reads isVisible from opts", () => {
    expect(useTerminalSessionSrc).toMatch(
      /const\s+isVisible\s*=\s*opts\.isVisible\s*\?\?\s*true/,
    );
  });

  test("useTerminalSession mirrors isVisible into isVisibleRef", () => {
    // The ref is what the long-lived onFrame closure reads. Without
    // mirroring, the closure would freeze on the mount-time value
    // and the hidden-cadence optimisation would never kick in.
    expect(useTerminalSessionSrc).toContain("isVisibleRef.current = isVisible");
  });
});
