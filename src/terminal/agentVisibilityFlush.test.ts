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
const canvasGridSrc = readFileSync(
  join(import.meta.dir, "CanvasGrid.tsx"),
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

describe("CanvasGrid source pins — visibility-flip signals to GridRenderer", () => {
  test("calls renderer.markHidden() on the visible→hidden edge", () => {
    // Without this signal the GridRenderer's resize() fast path
    // would skip the configure() call when we come back at the
    // same dimensions — which IS the common case for a keepalive-
    // layer tab switch — and the user would land on whatever
    // surface WKWebView happens to have at that moment (often
    // dead = black).
    expect(canvasGridSrc).toContain("renderer.markHidden()");
  });

  test("markHidden() is gated on the visible→hidden edge", () => {
    // Marking hidden on a still-visible canvas would erroneously
    // flag needsReconfigure during a regular size change, doing
    // unnecessary configure() work on every resize tick.
    //
    // The exact line we expect is along the lines of
    // `wasVisibleRef.current && !isVisible` before the markHidden
    // call.
    expect(canvasGridSrc).toMatch(
      /wasVisibleRef\.current\s*&&\s*!isVisible[\s\S]{0,200}?renderer\.markHidden\(\)/,
    );
  });

  test("markHidden() happens inside the existing visibility useEffect", () => {
    // The signal must fire from the same effect that runs the
    // visibility-restore state machine, otherwise we'd need
    // duplicate prop tracking — a code-smell and a chance for the
    // two effects to disagree about whether we're hidden.
    const visibilityEffect = canvasGridSrc.match(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]*?renderer\.markHidden\(\)[\s\S]*?\},\s*\[isVisible\]\)/,
    );
    expect(visibilityEffect).not.toBeNull();
  });

  test("visibility-restore state machine is still invoked from the same effect", () => {
    // The c7ca66b fix (decideVisibilityAction / executeVisibilityAction)
    // is the load-bearing GPU-surface recovery. Pin that markHidden
    // didn't accidentally REPLACE it — both must coexist in the
    // visibility effect.
    expect(canvasGridSrc).toContain("decideVisibilityAction");
    expect(canvasGridSrc).toContain("executeVisibilityAction");
  });
});

describe("CanvasGrid source pins — document.visibilitychange recovery (OS-level occlusion)", () => {
  // The user-reported bug class this guards: "agent was running, I
  // came back from a Zoom call and the terminal was black."
  //
  // WKWebView can release the canvas's GPU surface when the host
  // window becomes occluded (user switches macOS apps, Goonware
  // slides behind another window, App Nap kicks in). None of these
  // fire device.lost, none flip the `isVisible` keepalive-layer
  // prop — but the swapchain is dead. The next paint after the
  // window comes back lands on the dead surface.
  //
  // The fix this pins: a `visibilitychange` listener on `document`
  // that reconfigures + paints on transition to "visible", and
  // signals markHidden on transition away. Same recovery contract
  // as the keepalive-layer restore, just driven by page-level
  // visibility.

  test("registers a visibilitychange listener on document", () => {
    expect(canvasGridSrc).toMatch(
      /document\.addEventListener\(\s*["']visibilitychange["']/,
    );
  });

  test("visibilitychange listener cleans itself up on unmount", () => {
    // Without removeEventListener, every CanvasGrid remount leaks a
    // listener; long sessions accumulate dozens that all fire on
    // every macOS app switch. Cheap to leak per instance, expensive
    // in aggregate (each listener reaches into renderer state).
    expect(canvasGridSrc).toMatch(
      /document\.removeEventListener\(\s*["']visibilitychange["']/,
    );
  });

  test("visibilitychange handler reconfigures on transition to visible", () => {
    // The load-bearing recovery call. Without it, the listener
    // observes the event but doesn't repair the dead surface.
    expect(canvasGridSrc).toMatch(
      /document\.visibilityState\s*===\s*["']visible["'][\s\S]{0,200}?renderer\.reconfigure\(\)/,
    );
  });

  test("visibilitychange handler signals markHidden on transition to hidden", () => {
    // Symmetric to the visible path. On hide, we flag the renderer
    // so the next show-side resize still takes the full configure
    // path even at unchanged dimensions — mirrors the keepalive-layer
    // markHidden contract. Without it a subsequent resize after the
    // hide might take the fast path and skip the recovery configure.
    expect(canvasGridSrc).toMatch(
      /document\.visibilityState[\s\S]{0,200}?renderer\.markHidden\(\)/,
    );
  });
});

describe("CanvasGrid source pins — IntersectionObserver (upstream layout hide/show)", () => {
  // The user-reported bug class this guards: a parent panel collapses
  // / expands, a modal opens, the canvas scrolls out of an overflow
  // container — anything that hides the canvas WITHOUT flipping the
  // `isVisible` prop driven by the keepalive layer. WebKit may
  // release the GPU surface during the hide and the next paint after
  // re-entry lands on a dead swapchain.

  test("constructs an IntersectionObserver to watch the wrapper", () => {
    expect(canvasGridSrc).toMatch(/new\s+IntersectionObserver\(/);
  });

  test("IntersectionObserver is environment-guarded (jsdom / test-safe)", () => {
    // bun's test environment doesn't ship IntersectionObserver. The
    // gate avoids a ReferenceError on import in test runs.
    expect(canvasGridSrc).toMatch(
      /typeof\s+IntersectionObserver\s*===?\s*["']undefined["']/,
    );
  });

  test("IntersectionObserver triggers reconfigure on re-entry", () => {
    // The load-bearing call. Without it the observer fires but
    // doesn't repair the dead surface. We pin the
    // `isIntersecting && !wasVisible` edge → reconfigure chain.
    expect(canvasGridSrc).toContain("entry.isIntersecting");
    // Must call reconfigure in the same block as the intersection
    // re-entry.
    const intersectionBlock = canvasGridSrc.match(
      /new\s+IntersectionObserver\([\s\S]*?\}\);/,
    );
    expect(intersectionBlock).not.toBeNull();
    expect(intersectionBlock![0]).toContain("renderer.reconfigure()");
  });

  test("IntersectionObserver signals markHidden on leave", () => {
    // Symmetric to the entry path — flag the renderer so the next
    // entry's reconfigure path is unconditional.
    const intersectionBlock = canvasGridSrc.match(
      /new\s+IntersectionObserver\([\s\S]*?\}\);/,
    );
    expect(intersectionBlock).not.toBeNull();
    expect(intersectionBlock![0]).toContain("renderer.markHidden()");
  });

  test("IntersectionObserver disconnects on unmount", () => {
    // Same memory hygiene as the visibilitychange listener. Per-mount
    // observers are cheap; leaked-across-remounts observers accumulate
    // GPU-state pokes on every layout shift.
    expect(canvasGridSrc).toMatch(/observer\.disconnect\(\)/);
  });

  test("IntersectionObserver tracks edge transitions via a wrapperVisibleRef", () => {
    // Without an edge tracker the handler would reconfigure on
    // EVERY observation tick (which fires repeatedly while the
    // canvas scrolls past the viewport edge). The ref-based edge
    // detect keeps reconfigure cost at O(transition), not O(tick).
    expect(canvasGridSrc).toMatch(/wrapperVisibleRef\s*=\s*useRef\(true\)/);
  });
});

describe("isVisible prop propagation — the cross-file contract", () => {
  // Pins the prop name `isVisible` flowing from useTerminalSession
  // through LiveBlock to CanvasGrid. If anyone renames this prop in
  // ONE place, the chain breaks silently — no compile error because
  // the default value (true) takes over and everything appears to
  // work… until a tab switch reveals the regression.
  const liveBlockSrc = readFileSync(
    join(import.meta.dir, "LiveBlock.tsx"),
    "utf-8",
  );

  test("LiveBlock forwards isVisible to CanvasGrid in agent mode", () => {
    // The exact prop hand-off that drives the visibility-restore
    // path on the agent CanvasGrid (LiveBlock renders read-only
    // CanvasGrid when preserveGrid is set).
    expect(liveBlockSrc).toMatch(
      /<CanvasGrid[\s\S]*?isVisible=\{isVisible\}/,
    );
  });

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
