import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createGridRenderer, type GridRenderer } from "./gpu/GridRenderer";
import {
  decideVisibilityAction,
  executeVisibilityAction,
} from "./gpu/visibilityRestore";
import {
  BOOTSTRAP_RETRY_DELAYS_MS,
  decideEscalation,
  ESCALATION_DELAYS_MS,
  LADDER_GIVE_UP_MS,
  MAX_REBUILD_ATTEMPTS,
} from "./canvasGridEscalation";
import { isGlobalChord, keyToBytes } from "./keyEncoding";
import type { DirtyRow, RenderFrame } from "./types";

/**
 * Imperative handle for parents that need to poke the renderer
 * directly. Today the soft-reset path in BlockTerminal calls
 * `invalidate()` so a stuck-but-alive canvas (typical post-sleep
 * symptom: surface configured, last frame still on screen, no new
 * frames arriving) gets a synchronous re-render before the existing
 * watchdog ticks. Heavier escalation (rendererEpoch bump) stays
 * internal to CanvasGrid.
 */
export interface CanvasGridHandle {
  /**
   * Force the renderer to redraw the current frame on the next rAF,
   * even if the seq hasn't changed. No-op if the renderer is null
   * (pre-mount or post-tear-down).
   */
  invalidate: () => void;
}

/**
 * Half-open cell-coord range. `start` is the anchor (mouse-down
 * cell); `end` is the live mouse position. Either end can be
 * lexicographically less than the other — the renderer canonicalises.
 *
 * **Coordinate space**: `startRow` and `endRow` are ORIGINAL-GRID
 * row indices (the same coordinate space `firstRowOffset` lives in),
 * NOT window-relative indices. Mouse events arrive in window coords
 * and are translated to grid coords on the way in (`eventToCell`);
 * the renderer expects window coords and gets them via translation
 * on the way out (`renderRequest`). Anchoring to the grid makes the
 * selection survive row shifts caused by scrollback growth from
 * large agent output — without it, the user-visible selection drifts
 * to a different cell every time `firstRowOffset` changes.
 */
interface Selection {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * Translate a grid-coords selection to window-relative coords for the
 * renderer. Returns null when the entire selection lies outside the
 * visible window — the renderer's `selection: null` path short-
 * circuits selection painting entirely, which is what we want when
 * the user's selection has scrolled out of view above the window.
 *
 * Exported for unit testing; consumed locally by `renderRequest`
 * and (via the inverse) by `extractSelectionText`.
 */
export function gridSelectionToWindow(
  sel: Selection | null,
  offset: number,
  windowSize: number,
): Selection | null {
  if (!sel) return null;
  const startWin = sel.startRow - offset;
  const endWin = sel.endRow - offset;
  // Canonicalise to test against the window range without caring
  // which end is the anchor vs. the live drag head.
  const lo = Math.min(startWin, endWin);
  const hi = Math.max(startWin, endWin);
  if (hi < 0 || lo >= windowSize) return null;
  return {
    startRow: startWin,
    startCol: sel.startCol,
    endRow: endWin,
    endCol: sel.endCol,
  };
}

interface Props {
  /**
   * Source frame. Provides cursor + cols + seq even when `rows` is
   * a windowed subset.
   */
  frame: RenderFrame | null;
  /**
   * When set, render this row sequence instead of `frame.dirty`.
   * Used by inline LiveBlock to render the trimmed visibleRows.
   * Cursor is hidden in this mode unless explicitly passed.
   */
  rows?: DirtyRow[];
  /**
   * Layout mode:
   *   - "fill": canvas fills its parent vertically (alt-screen).
   *   - "auto": canvas height = (rows.length × cellHeightCss);
   *     used for inline LiveBlock so the canvas sits in the
   *     conversation scroll like a regular block.
   */
  mode?: "fill" | "auto";
  /** PTY input forwarding. Optional — when undefined, no textarea
   *  overlay is mounted (read-only display). */
  onSendBytes?: (bytes: Uint8Array) => void;
  /** Optional override for the monospace font. */
  font?: string;
  /** Font size in CSS pixels (kept in sync with terminal cell metrics). */
  fontSizeCss?: number;
  lineHeight?: number;
  /**
   * For inline/windowed mode (`rows` prop set): the original-grid row
   * index of `rows[0]`. Used to translate `frame.cursor_row` (in
   * original grid coords) into a window-relative row so the cursor
   * draws at the correct cell.
   *
   * Defaults to `frame.rows - rows.length` (treat the window as the
   * tail of the grid). LiveBlock passes an explicit value because
   * `trimEchoAndBlanks` drops leading blanks + the command echo, so
   * the window is NOT the tail — using the default offset paints the
   * cursor a few rows above where it should be.
   */
  firstRowOffset?: number;
  /**
   * Whether this canvas is currently the visible one in its parent's
   * keepalive layer. Used to gate two things:
   *
   *   1. The ResizeObserver no-ops when the wrapper went `display:
   *      none` (contentRect = 0×0). Without the gate the renderer
   *      would resize its backbuffer down to 1×1 physical pixels —
   *      visible as the entire agent pane going black, and the
   *      symptom the user reports as "switch tabs → terminal stays
   *      blank after I come back."
   *
   *   2. On hidden→visible transition we rebuild the renderer from
   *      scratch. macOS's WKWebView releases GPU surface resources
   *      for `display: none` views without firing a `device.lost`
   *      callback, so the existing renderer may have a dead GPU
   *      context that paints nothing while reporting no error.
   *      Force-bumping the bootstrap epoch tears the renderer down
   *      and spawns a fresh one against the now-live canvas surface.
   *
   * Defaults to `true` so standalone callers (and the alt-screen
   * branch in BlockTerminal that hasn't been wired up yet) keep
   * working unchanged.
   */
  isVisible?: boolean;
  /**
   * Fired when the canvas's recovery ladder has exhausted its budget
   * (max rebuild attempts + bootstrap retries) without ever producing
   * a successful paint. The parent should swap this block to DOM
   * rendering so the user sees text rather than indefinite black.
   *
   * Called at most once per CanvasGrid mount. After it fires, the
   * canvas stops scheduling further recovery work — the parent's
   * fallback path takes over.
   *
   * The signal exists because WKWebView occasionally hands back a GPU
   * surface that silently paints into the void: no `device.lost`, no
   * thrown error, no way to detect it except observing that
   * `successfulDrawCount` never advances. The user sees that as
   * "Claude opens, the entire block is black, killing the agent is
   * the only way back to readable text." This callback is the
   * structural escape hatch when no amount of reconfigure /
   * rebuild gets us live pixels.
   */
  onCanvasUnrecoverable?: () => void;
}

/**
 * WebGPU canvas grid renderer (Phase 3).
 *
 * Two layout modes:
 *   - "fill" (default) — canvas fills its parent height; used for
 *     alt-screen apps (vim, htop, alt-screen claude).
 *   - "auto" — canvas height = rows.length × cellHeightCss; used by
 *     inline LiveBlock so canvas blocks sit in the column-reverse
 *     conversation scroll alongside DOM-rendered closed blocks.
 *
 * Input flows through a hidden textarea overlaid on the canvas
 * (same pattern as FullGrid + PtyPassthrough). All three paths
 * encode keys via the shared keyEncoding module.
 */
export const CanvasGrid = forwardRef<CanvasGridHandle, Props>(function CanvasGrid({
  frame,
  rows,
  mode = "fill",
  onSendBytes,
  font,
  fontSizeCss = 13,
  lineHeight = 1.35,
  firstRowOffset,
  isVisible = true,
  onCanvasUnrecoverable,
}, ref) {
  // Cache the latest unrecoverable callback so the bootstrap effect's
  // setTimeout closures always fire the current parent's handler even
  // if React swaps the callback identity between renders.
  const onCanvasUnrecoverableRef = useRef(onCanvasUnrecoverable);
  onCanvasUnrecoverableRef.current = onCanvasUnrecoverable;
  // Per-mount flag set when the escalation ladder gives up. Once set,
  // the timer chain no-ops itself so a retry that arrives mid-tear-
  // down can't double-fire the callback or schedule new rebuilds.
  const gaveUpRef = useRef(false);
  // Cumulative rebuild attempts this mount. Each timer fire that
  // decides "escalate" increments this; the next timer compares
  // against MAX_REBUILD_ATTEMPTS to decide whether the budget is
  // spent. Refs (not state) because we don't want to re-render on
  // ticks — only the rendererEpoch bump should trigger a React commit.
  const rebuildAttemptRef = useRef(0);
  // Mirror of the latest `isVisible` prop so the escalation ladder's
  // setTimeout callbacks read the current state when they fire (not
  // the value at scheduling time). The `frame` prop already has a
  // synchronously-updated `frameRef` below (used by the render path),
  // so the ladder reads from that — no second ref needed for it.
  const isVisibleRefForLadder = useRef(isVisible);
  isVisibleRefForLadder.current = isVisible;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rendererRef = useRef<GridRenderer | null>(null);
  // Imperative escape hatch for parents (currently BlockTerminal's
  // soft-reset path). `invalidate` is the lightest poke possible: it
  // tells the existing rAF-coalesced render loop "redraw the current
  // frame even if seq hasn't changed." Heavier escalation (renderer
  // rebuild via rendererEpoch) is intentionally NOT exposed — the
  // existing 1 s watchdog and the canvasGridEscalation ladder already
  // own the rebuild path, and exposing both would create two callers
  // racing the same recovery.
  useImperativeHandle(ref, () => ({
    invalidate: () => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      renderer.invalidate();
      renderRequest(renderer);
    },
  }));
  const frameRef = useRef<RenderFrame | null>(frame);
  const rowsRef = useRef<DirtyRow[] | undefined>(rows);
  // Synchronously-updated `firstRowOffset` mirror so the selection
  // translation in eventToCell + renderRequest reads the latest
  // window→grid offset without the callback closures rebinding
  // every render. The renderer's selection input is window-relative;
  // our stored Selection is grid-relative. This ref bridges the two
  // at runtime, not at closure-capture time, so a row-window shift
  // mid-drag (large agent output arrives while user is selecting)
  // keeps the selection anchored to the cells the user actually
  // clicked.
  const firstRowOffsetRef = useRef<number | undefined>(firstRowOffset);
  frameRef.current = frame;
  rowsRef.current = rows;
  firstRowOffsetRef.current = firstRowOffset;

  // rAF-coalesced render scheduling. React can land several state
  // updates (a fresh frame, a rows window change, a selection drag
  // tick) within a single paint cycle; without coalescing each one
  // triggers an independent `renderer.render()` call. The renderer
  // dedupes by seq, but we still pay for the per-call setup +
  // closure churn. Mirror the trailing-edge flush we just added on
  // the backend: queue at most one rAF callback at a time and let
  // every caller in the same frame fold into it.
  //
  // Kept out of `useCallback` because the captured `renderRequest`
  // closure must be the latest one (it reads `firstRowOffset` from
  // the closing scope on each call, not via ref). Storing the
  // pending id in a ref keeps the scheduler stable across renders.
  const rafIdRef = useRef<number | null>(null);

  // Selection state. `selection` is the visible (committed or
  // live-during-drag) range; null means no selection. `dragging`
  // tracks whether a mouse drag is currently in flight — used to
  // route mousemove and pickup-mouseup-anywhere via a document-level
  // listener so the user can drag past the canvas edge.
  const [selection, setSelection] = useState<Selection | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  const draggingRef = useRef(false);
  selectionRef.current = selection;

  // Auto-height: compute pixel height from row count + line metric.
  //
  // CRITICAL — must match the atlas's cell-height formula exactly, not
  // the unrounded `fontSizeCss * lineHeight`. The atlas rounds UP to
  // integer physical pixels:
  //
  //     cellHeightPx  = ceil(fontSizeCss * lineHeight * dpr)
  //     cellHeightCss = cellHeightPx / dpr
  //
  // For 13px / 1.35 lineHeight at dpr=2 that's
  // `ceil(35.1) / 2 = 18 CSS px` per row, NOT `17.55`. If we asked
  // the wrapper for `rowCount × 17.55 px` while the renderer drew
  // each row at 18 px, the bottom rows would visibly clip — the bug
  // the user reported as "the bottom of the text is getting cut."
  //
  // The atlas constructor isn't reachable here (async creation), but
  // we can replay its formula. We use `window.devicePixelRatio || 1`
  // for the DPR — same value Atlas.ts reads, so they can never
  // disagree.
  const cellHeightCss = useMemo(() => {
    const dpr = (typeof window !== "undefined"
      ? window.devicePixelRatio
      : 1) || 1;
    const cellHeightPx = Math.ceil(fontSizeCss * lineHeight * dpr);
    return cellHeightPx / dpr;
  }, [fontSizeCss, lineHeight]);
  const autoHeightPx = useMemo(() => {
    if (mode !== "auto") return undefined;
    const rowCount = rows ? rows.length : (frame?.dirty.length ?? 0);
    const raw = Math.max(cellHeightCss, rowCount * cellHeightCss);
    // Snap to an integer number of physical pixels so the renderer's
    // `resize()` ceil math never has to round up — that round-up
    // would produce a 1-physical-pixel mismatch between the wrapper
    // height (CSS) and the canvas height (CSS after re-derivation),
    // visible as a stray blank stripe at the bottom of the block.
    // Explicit snapping here also defends against future renderer
    // changes that might switch the resize rounding strategy.
    const dpr = (typeof window !== "undefined"
      ? window.devicePixelRatio
      : 1) || 1;
    return Math.ceil(raw * dpr) / dpr;
  }, [mode, rows, frame?.dirty.length, cellHeightCss]);

  // Renderer bootstrap with device-loss recovery. `epoch` is bumped
  // whenever the GPUDevice is lost — the effect tears down the dead
  // renderer (which is already a no-op because the device is gone)
  // and bootstraps a fresh one. Users see a single frame of black
  // during the swap, then painting resumes from the next backend seq.
  const [rendererEpoch, setRendererEpoch] = useState(0);
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return;
    let cancelled = false;
    let bootstrapStarted = false;
    // All deferred work scheduled inside this bootstrap pass. The
    // cleanup loops through and clears each one so a rendererEpoch
    // bump (or unmount) doesn't leave timers firing against a
    // destroyed renderer.
    const pendingTimers: number[] = [];
    const fontFamily =
      font ??
      "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace";

    // device.lost handler — called from the renderer when the GPU
    // device dies (driver reset, sleep/wake on some configs, unhandled
    // validation failure). Bumping `rendererEpoch` re-runs this effect
    // with a fresh bootstrap. Guarded by `cancelled` so we don't trigger
    // a rebuild during normal unmount.
    const handleDeviceLost = (info: { reason: string; message: string }) => {
      if (cancelled) return;
      // eslint-disable-next-line no-console
      console.warn(
        `[CanvasGrid] WebGPU device lost (${info.reason}): ${info.message} — rebuilding`,
      );
      rendererRef.current = null;
      setRendererEpoch((n) => n + 1);
    };

    // Final-failure sink. Called when both the bootstrap retry budget
    // and the rebuild escalation ladder have been exhausted without
    // ever producing a successful paint. Sets gaveUpRef so any
    // straggler timer fires no-op, then notifies the parent so it
    // can swap this block to the DOM fallback path.
    const giveUp = (reason: string) => {
      if (gaveUpRef.current) return;
      gaveUpRef.current = true;
      // eslint-disable-next-line no-console
      console.warn(`[CanvasGrid] giving up after ${reason}; DOM fallback`);
      onCanvasUnrecoverableRef.current?.();
    };

    // ── Bulletproof black-surface recovery, take 2 ─────────────────
    //
    // Goonware has spent months fighting the "open agent → all
    // black, never recovers" bug. Existing safety nets (visibility
    // restore, 1 s watchdog reconfigure, 60-frame heartbeat,
    // intersection observer, document.visibilitychange) all assume
    // the swapchain is recoverable via `context.configure()`. But on
    // WKWebView the GPU device itself can die WITHOUT `device.lost`
    // ever resolving — `getCurrentTexture()` returns a texture that
    // paints into the void, no error fires, and no amount of
    // reconfigure helps. Earlier work added a one-shot hard rebuild
    // at 2500 ms (089ff63) to convert a black canvas into a
    // recoverable one. That fix assumed a single fresh adapter +
    // device + context would land on a live surface — but users
    // are still seeing persistent black: the FIRST rebuild
    // attempt itself can hand back another dead surface.
    //
    // The recovery is now split across two effects:
    //
    //   - THIS effect (deps: [rendererEpoch]) handles the bootstrap
    //     and the soft warmup. It re-runs on each rebuild — soft
    //     warmups are per-renderer-instance.
    //
    //   - The escalation ladder effect (below, deps: []) runs ONCE
    //     per mount and drives the timer chain that decides when to
    //     rebuild. Living outside this effect's dep list means a
    //     rebuild doesn't reset the ladder's clock — the user gets
    //     an honest 37.5 s budget from initial mount to DOM
    //     fallback regardless of how many rebuilds happen in
    //     between.
    //
    // This effect's onBootstrapSuccess: bring up the renderer + soft
    // warmups. The escalation timer chain bumps `rendererEpoch`
    // independently to trigger fresh-adapter rebuilds.
    const onBootstrapSuccess = (renderer: GridRenderer) => {
      if (cancelled) {
        renderer.destroy();
        return;
      }
      rendererRef.current = renderer;
      const rect = wrapper.getBoundingClientRect();
      renderer.resize(
        rect.width,
        rect.height,
        window.devicePixelRatio || 1,
      );
      renderRequest(renderer);

      // Soft warmup — reconfigure + repaint at 50/200/500/1200 ms
      // post-bootstrap. Catches the "first paint into a stale
      // swapchain" cases without any rebuild cost. Per-renderer-
      // instance: cleared by this effect's cleanup on epoch bump.
      for (const delay of [50, 200, 500, 1200]) {
        const id = window.setTimeout(() => {
          const r = rendererRef.current;
          if (!r) return;
          r.reconfigure();
          renderRequest(r);
        }, delay);
        pendingTimers.push(id);
      }
    };

    // Bootstrap with retry-on-failure. `attemptIndex` walks through
    // BOOTSTRAP_RETRY_DELAYS_MS; once exhausted, give up.
    const attemptBootstrap = (attemptIndex: number): void => {
      if (cancelled || gaveUpRef.current) return;
      createGridRenderer(
        canvas,
        fontFamily,
        fontSizeCss,
        lineHeight,
        handleDeviceLost,
      )
        .then(onBootstrapSuccess)
        .catch((err) => {
          if (cancelled || gaveUpRef.current) return;
          // eslint-disable-next-line no-console
          console.warn(
            `[CanvasGrid] WebGPU init failed (attempt ${attemptIndex}):`,
            err,
          );
          if (attemptIndex >= BOOTSTRAP_RETRY_DELAYS_MS.length) {
            giveUp(`${attemptIndex + 1} bootstrap attempts`);
            return;
          }
          const delay = BOOTSTRAP_RETRY_DELAYS_MS[attemptIndex];
          const id = window.setTimeout(() => {
            attemptBootstrap(attemptIndex + 1);
          }, delay);
          pendingTimers.push(id);
        });
    };

    // ── Primary prevention: gate the FIRST context.configure() on a
    // sized canvas ────────────────────────────────────────────────
    //
    // The escalation ladder + DOM fallback below are the safety net
    // for cases we can't predict (driver hiccup, GPU process reset).
    // The root cause of the "open agent → all black, never recovers"
    // bug is upstream of all that: createGridRenderer calls
    // context.configure() synchronously, and WKWebView returns a
    // zombie swapchain if that call runs against a 0×0 canvas (no
    // backing surface yet). All later getCurrentTexture() calls
    // succeed from JS — no device.lost, no exception — but the
    // textures paint into the void. No subsequent context.configure
    // (resize-driven or otherwise) reliably rescues this state, which
    // is why a fresh adapter+device+context rebuild was needed at all.
    //
    // The fix is to never enter that state. Wait for the wrapper to
    // have nonzero CSS dimensions, pre-size the canvas to match, THEN
    // bootstrap. The first swapchain is born on a real surface and
    // the rebuild ladder almost never has to fire.
    //
    // Normal path: useEffect runs after React's layout commit, so the
    // wrapper is already sized — startBootstrapIfSized fires
    // synchronously here and bootstrapStarted flips to true before
    // we ever set up the observer.
    //
    // Slow path: the wrapper is 0×0 (rare — initial mount under a
    // keepalive layer that's currently `display: none`, or a
    // first-paint reflow that hasn't settled). The ResizeObserver
    // waits for the first nonzero rect and starts bootstrap then.
    const startBootstrapIfSized = () => {
      if (bootstrapStarted || cancelled || gaveUpRef.current) return;
      const rect = wrapper.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      // Pre-size the canvas so the very first context.configure() in
      // createGridRenderer lands on a properly-sized backing store.
      // The renderer's own resize() will re-run configure if the
      // wrapper later changes size, but starting at the wrapper's
      // measured size means most agent panes never hit that path.
      const dpr = window.devicePixelRatio || 1;
      const physWidth = Math.max(1, Math.floor(rect.width * dpr));
      const physHeight = Math.max(1, Math.ceil(rect.height * dpr));
      canvas.width = physWidth;
      canvas.height = physHeight;
      canvas.style.width = `${physWidth / dpr}px`;
      canvas.style.height = `${physHeight / dpr}px`;
      bootstrapStarted = true;
      attemptBootstrap(0);
    };

    // Try synchronously first — covers the common case where layout
    // is already complete by the time this effect fires.
    startBootstrapIfSized();

    // Fallback observer for the 0×0-at-mount edge case. Disconnects
    // itself the moment bootstrap actually starts so a wrapper resize
    // doesn't trigger a second createGridRenderer call.
    let sizeObserver: ResizeObserver | null = null;
    if (!bootstrapStarted) {
      sizeObserver = new ResizeObserver(() => {
        startBootstrapIfSized();
        if (bootstrapStarted) {
          sizeObserver?.disconnect();
          sizeObserver = null;
        }
      });
      sizeObserver.observe(wrapper);
    }

    return () => {
      cancelled = true;
      sizeObserver?.disconnect();
      for (const id of pendingTimers) window.clearTimeout(id);
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendererEpoch]);

  // Escalation ladder. ABSOLUTE delays from mount, independent of the
  // bootstrap effect's epoch lifecycle — so a rebuild doesn't reset
  // the user's recovery budget. Each tick reads
  // `rendererRef.current?.successfulDrawCount`: 0 means the canvas
  // has never painted, so the canvas is the persistent-black case
  // the user reports as "Claude opens, the entire block is black."
  //
  // Pure `decideEscalation` keeps the timer body trivial:
  //   - "stop" — healthy paint observed (or wait state with hasFrame
  //     /isVisible false), no action this tick.
  //   - "escalate" — bump `rendererEpoch`; the bootstrap effect
  //     rebuilds against a fresh adapter + device + context.
  //   - "give-up" — fire `onCanvasUnrecoverable` so the parent swaps
  //     to DOM rendering.
  //
  // Runs once per mount (`deps: []`). Subsequent renderer rebuilds
  // do NOT re-schedule this ladder; the timers keep ticking against
  // whichever renderer instance is current at fire time.
  useEffect(() => {
    const timers: number[] = [];
    const checkAndAct = () => {
      if (gaveUpRef.current) return;
      const r = rendererRef.current;
      const drawCount = r?.successfulDrawCount ?? 0;
      const decision = decideEscalation({
        attempt: rebuildAttemptRef.current,
        currentDrawCount: drawCount,
        isVisible: isVisibleRefForLadder.current,
        hasFrame: frameRef.current !== null,
        maxAttempts: MAX_REBUILD_ATTEMPTS,
      });
      if (decision === "stop") return;
      if (decision === "give-up") {
        if (!gaveUpRef.current) {
          gaveUpRef.current = true;
          // eslint-disable-next-line no-console
          console.warn(
            `[CanvasGrid] giving up after ${rebuildAttemptRef.current} rebuild attempts; DOM fallback`,
          );
          onCanvasUnrecoverableRef.current?.();
        }
        return;
      }
      rebuildAttemptRef.current += 1;
      // eslint-disable-next-line no-console
      console.warn(
        `[CanvasGrid] escalating to rebuild attempt ${rebuildAttemptRef.current}`,
      );
      setRendererEpoch((n) => n + 1);
    };
    for (const delay of ESCALATION_DELAYS_MS) {
      const id = window.setTimeout(checkAndAct, delay);
      timers.push(id);
    }
    // Final give-up timer. Fires after every escalation tick has
    // had its chance — by then either the canvas painted (no-op) or
    // attempt is at the cap and decideEscalation returns "give-up".
    const giveUpId = window.setTimeout(() => {
      if (gaveUpRef.current) return;
      const drawCount = rendererRef.current?.successfulDrawCount ?? 0;
      if (drawCount > 0) return;
      gaveUpRef.current = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[CanvasGrid] giving up after ${rebuildAttemptRef.current} rebuild attempts at ${LADDER_GIVE_UP_MS}ms; DOM fallback`,
      );
      onCanvasUnrecoverableRef.current?.();
    }, LADDER_GIVE_UP_MS);
    timers.push(giveUpId);
    return () => {
      for (const id of timers) window.clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Repaint on frame / rows / cursor change. Coalesced via rAF so
  // that a burst of backend frame events (or React landing a frame
  // commit and a rows-window change in the same tick) pays for at
  // most one renderer.render() per paint. The renderer also dedupes
  // by seq, but folding upstream avoids the per-call setup cost.
  useEffect(() => {
    if (!rendererRef.current) return;
    scheduleRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, rows]);

  // Cancel any pending rAF on unmount so the queued callback doesn't
  // fire against a renderer that's already been destroyed.
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, []);

  // Resize the canvas when the container changes.
  //
  // Run SYNCHRONOUSLY inside the ResizeObserver callback. ResizeObserver
  // already fires once per frame, between layout and paint, so the
  // backbuffer realloc + render land in the same frame as the wrapper's
  // CSS size change. Deferring via rAF (the prior approach) cost a full
  // frame in which the wrapper had the new size but `renderer.resize`
  // hadn't yet updated the canvas's inline `style.width/height` — the
  // gap rendered as `var(--surface-0)` (oklch 7%, indistinguishable
  // from black) and read as "the entire terminal goes black during a
  // resize."
  //
  // This matches Warp's split between expensive PTY reflow (debounced
  // via warpdotdev/warp `app/src/throttle.rs`) and the visual render
  // loop (every frame, no throttle). Goonware's SIGWINCH side already has a
  // 140 ms debounce in BlockTerminal.tsx; the canvas paint must NOT be
  // delayed.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    // Sub-pixel reflow suppression. Some siblings of the canvas
    // (notably AgentChrome's status pill, but also any future text
    // strip whose content varies by status) can shift their rendered
    // height by 1–2 px when their content changes. That tiny delta
    // ripples through flex layout and lands here as a ResizeObserver
    // tick with a fractional CSS-pixel rect change.
    //
    // `renderer.resize()` short-circuits when the resulting PHYSICAL
    // pixel count is unchanged, so sub-pixel deltas at integer DPRs
    // are mostly no-ops anyway. But at fractional DPRs (1.5, 2.5)
    // and at certain ResizeObserver-rounded values, a sub-CSS-pixel
    // shift can still cross an integer physical-pixel boundary,
    // trigger the slow path (canvas.width = ...; context.configure;
    // lastSeq = -1), and on WKWebView produce one frame of blank
    // swapchain before the synchronous `renderRequest` lands the
    // next paint. The user-reported symptom was "screen instantly
    // blank when Claude asks for permission" — the permission pill
    // in AgentChrome was changing the strip's rendered height by a
    // couple of CSS px even though BlockTerminal had reserved a
    // fixed 32px row for it.
    //
    // Defense: track the last rect we forwarded and ignore ticks
    // whose CSS-pixel delta is below SUBPIXEL_REFLOW_THRESHOLD_PX in
    // both dimensions. Real resizes (sidebar collapse, window
    // resize, tab switch landing a different layout) are always
    // many pixels and pass through immediately. Status-pill churn
    // is sub-pixel and gets dropped — the swapchain stays alive and
    // the renderer's per-second watchdog keeps painting.
    //
    // The 2 px threshold is chosen against JetBrains Mono at 13 px /
    // 1.35 lh — one row of canvas is 17.5–18 CSS px, so a 2 px shift
    // is still far below "one row gained/lost" territory. Anything
    // larger than that legitimately needs a backbuffer realloc.
    const SUBPIXEL_REFLOW_THRESHOLD_PX = 2;
    let lastForwardedWidth = -1;
    let lastForwardedHeight = -1;
    const observer = new ResizeObserver((entries) => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      const rect = entries[0].contentRect;
      // Skip when either dimension is 0 — that's the keepalive
      // layer flipping us to `display: none`. Pushing a 0×0 into
      // `renderer.resize` would clamp the canvas backbuffer to 1×1
      // physical pixels; the wrapper coming back to its real size
      // wouldn't always re-fire ResizeObserver (WKWebView is flaky
      // about display:none → display:flex transitions when the
      // restored CSS size matches the cached pre-hide size), and
      // the user lands on a black pane. Letting the renderer keep
      // its pre-hide backbuffer means the next visibility tick can
      // paint the cached frame without a re-fit round-trip.
      if (rect.width === 0 || rect.height === 0) return;
      // Sub-pixel reflow suppression — see comment above the
      // observer. Only applies AFTER the first forwarded resize so
      // the initial mount measurement always goes through.
      if (lastForwardedWidth > 0 && lastForwardedHeight > 0) {
        const dw = Math.abs(rect.width - lastForwardedWidth);
        const dh = Math.abs(rect.height - lastForwardedHeight);
        if (
          dw < SUBPIXEL_REFLOW_THRESHOLD_PX &&
          dh < SUBPIXEL_REFLOW_THRESHOLD_PX
        ) {
          return;
        }
      }
      lastForwardedWidth = rect.width;
      lastForwardedHeight = rect.height;
      renderer.resize(
        rect.width,
        rect.height,
        window.devicePixelRatio || 1,
      );
      // Defense in depth: even if `resize()` took its dimensions-
      // unchanged fast path (no reconfigure, no canvas clear), force
      // a fresh paint. The cost is one renderer.render() call which
      // dedupes by seq when nothing actually changed.
      renderer.invalidate();
      renderRequest(renderer);
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  // Hidden→visible restore hook. Driven by the pure state machine
  // in `gpu/visibilityRestore.ts` — see that file's header for the
  // full root-cause writeup (TL;DR: WKWebView releases the GPU
  // swapchain during `display: none` without firing `device.lost`,
  // and the next render paints into a dead surface = black canvas).
  //
  // useLayoutEffect (not useEffect) so the reconfigure + paint runs
  // synchronously during the commit, BEFORE the browser paints. A
  // useEffect would let the browser paint into a dead swapchain on
  // the visibility-restore frame, producing one frame of black before
  // the recovery runs — and on WebKit that single frame can stick
  // until something else (resize, scroll, etc.) forces a redraw.
  //
  // `wasVisibleRef` only advances when the decision is "restore" or
  // "noop" — a "defer" leaves it at false so the next ResizeObserver
  // tick (with a real rect this time) can still trigger the restore.
  const wasVisibleRef = useRef(isVisible);
  const deferRafRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const renderer = rendererRef.current;
    // On the visible→hidden edge, signal the renderer that its
    // swapchain may be released while we sit behind `display: none`.
    // Without this signal, `resize()`'s dimensions-unchanged fast
    // path would happily skip the reconfigure when we come back
    // (because the wrapper's box geometry doesn't change with
    // display), landing the user on a dead GPU surface = black pane.
    if (renderer && wasVisibleRef.current && !isVisible) {
      renderer.markHidden();
    }
    const tryRestore = (): boolean => {
      const r = rendererRef.current;
      const w = wrapperRef.current;
      if (!r) return false;
      const rect = w?.getBoundingClientRect();
      const rectWidth = rect?.width ?? 0;
      const rectHeight = rect?.height ?? 0;
      const action = decideVisibilityAction({
        wasVisible: wasVisibleRef.current,
        isVisible,
        rectWidth,
        rectHeight,
      });
      if (action !== "defer") wasVisibleRef.current = isVisible;
      executeVisibilityAction(
        action,
        {
          reconfigure: () => r.reconfigure(),
          resizeFromRect: (rw, rh, dpr) => r.resize(rw, rh, dpr),
          invalidate: () => r.invalidate(),
          // Paint SYNCHRONOUSLY (not via rAF). The whole reason this
          // effect is now a layout effect is so the reconfigure +
          // first paint land in the same frame as the visibility
          // flip. Going through scheduleRender's rAF would defer
          // the paint into the next frame, re-introducing the
          // single-frame black flash this fix is supposed to kill.
          paint: () => renderRequest(r),
        },
        rectWidth,
        rectHeight,
        window.devicePixelRatio || 1,
      );
      return action !== "defer";
    };
    const restored = tryRestore();
    // Defer-retry: when the wrapper's rect was 0×0 at effect time
    // (React fired the layout effect inside the same commit that
    // toggled visibility, before WebKit had a chance to settle the
    // layout), schedule one rAF retry. By then layout has run and
    // the rect will be non-zero — `tryRestore` succeeds and the
    // canvas reads the live frame for its first paint instead of
    // sitting black until the next ResizeObserver tick.
    if (deferRafRef.current !== null) {
      cancelAnimationFrame(deferRafRef.current);
      deferRafRef.current = null;
    }
    if (!restored && isVisible) {
      deferRafRef.current = requestAnimationFrame(() => {
        deferRafRef.current = null;
        tryRestore();
      });
    }
    return () => {
      if (deferRafRef.current !== null) {
        cancelAnimationFrame(deferRafRef.current);
        deferRafRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible]);

  // Watchdog timer. Independent of the visibility / heartbeat /
  // resize paths — runs every second while the canvas is visible
  // and pre-emptively reconfigures + repaints. This is the
  // belt-and-suspenders safety net for the class of WKWebView
  // surface-loss bugs that don't fire any signal we can hook:
  //
  //   - The renderer is mid-stream and `draw()`'s heartbeat is
  //     paused because no new frames are coming in (idle agent).
  //   - The `isVisible` prop didn't change (the keepalive layer's
  //     visibility flip is the dominant trigger but not the only
  //     one — an OS-level app switch, window minimize/restore, or
  //     full-screen toggle can release the surface too).
  //   - The page-level `visibilitychange` event fires only for
  //     full-document visibility, not for window-occlusion-by-
  //     other-app cases on macOS.
  //
  // 1000 ms is slow enough that the configure cost is negligible
  // (~0.1% frame time at 60 Hz) but fast enough that a stuck-dead
  // surface recovers within one second of visible perception. The
  // user's "switch back to the tab and it's still black" complaint
  // is exactly the symptom this guards against — they were waiting
  // longer than a second.
  useEffect(() => {
    if (!isVisible) return;
    const id = window.setInterval(() => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      renderer.reconfigure();
      renderer.invalidate();
      renderRequest(renderer);
    }, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible]);

  // Page-level visibility tracking. WKWebView can release a canvas's
  // GPU surface when the host window becomes occluded — user switches
  // to another macOS app, the Goonware window slides behind another
  // window, the system enters App Nap, etc. None of these fire
  // `device.lost` or change our `isVisible` prop (which only tracks
  // the keepalive layer's intra-app visibility), but the surface is
  // dead all the same. The next paint after the window comes back
  // lands on a dead swapchain and the user sees the canvas as black
  // until something else (tab switch, resize) triggers a reconfigure.
  //
  // The bug class users describe as "agent was running, I came back
  // from a Zoom call and the terminal was black" lives here. The
  // visibility-restore state machine elsewhere in this file covers
  // the in-app `display: none ↔ flex` flip but is blind to OS-level
  // window occlusion.
  //
  // On `visibilitychange` → visible we reconfigure + force a paint.
  // On → hidden we signal markHidden so the next come-back resize
  // takes the slow path even at unchanged dimensions (mirrors the
  // isVisible-driven path's contract).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibilityChange = () => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      if (document.visibilityState === "visible") {
        renderer.reconfigure();
        renderRequest(renderer);
      } else {
        renderer.markHidden();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Viewport-intersection guard. The `isVisible` prop is driven by the
  // keepalive layer's intra-app visibility (which tab is active). But
  // upstream UI can hide / reveal the canvas without flipping that
  // prop — collapsing a side panel, opening a modal, scrolling the
  // canvas off-screen inside an overflow container. WebKit may release
  // the GPU surface during any such hide; the next render after the
  // canvas re-enters the viewport lands on a dead swapchain.
  //
  // IntersectionObserver fires whenever the wrapper crosses 0% / 100%
  // intersection with the viewport. On a re-entry we reconfigure +
  // paint, same recovery as the keepalive-layer restore. The leave
  // edge flips needsReconfigure via markHidden so the next entry
  // still takes the configure path even if the dimensions never
  // changed in between.
  //
  // Gated by `if (typeof IntersectionObserver !== 'undefined')` — Bun
  // / jsdom test environments don't ship it and we'd crash on import
  // otherwise.
  const wrapperVisibleRef = useRef(true);
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const renderer = rendererRef.current;
        if (!renderer) return;
        const nowVisible = entry.isIntersecting;
        const wasVisible = wrapperVisibleRef.current;
        if (nowVisible && !wasVisible) {
          renderer.reconfigure();
          renderRequest(renderer);
        } else if (!nowVisible && wasVisible) {
          renderer.markHidden();
        }
        wrapperVisibleRef.current = nowVisible;
      },
      { threshold: 0 },
    );
    observer.observe(wrapper);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Repaint at the new DPR when the user drags Goonware between a Retina
  // and an external 1x monitor mid-session. Without this, the canvas
  // stays at its mount-time DPR — glyphs look fuzzy (1x → 2x) or
  // pixel-doubled (2x → 1x) until the user resizes the pane.
  //
  // matchMedia(resolution) fires whenever the DPR changes. Each change
  // recreates the listener for the new DPR value (it's a one-shot
  // listener per query), which is why the cleanup tears down the old
  // one before registering the next.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    let mq: MediaQueryList | null = null;
    let onChange: (() => void) | null = null;
    const setup = () => {
      const dpr = window.devicePixelRatio || 1;
      mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
      onChange = () => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        const rect = wrapper.getBoundingClientRect();
        renderer.resize(
          rect.width,
          rect.height,
          window.devicePixelRatio || 1,
        );
        renderRequest(renderer);
        // Re-register at the new DPR so the next change fires.
        if (mq && onChange) {
          mq.removeEventListener("change", onChange);
        }
        setup();
      };
      mq.addEventListener("change", onChange);
    };
    setup();
    return () => {
      if (mq && onChange) {
        mq.removeEventListener("change", onChange);
      }
    };
  }, []);

  // Drive a render based on whichever input mode the caller chose.
  // Always reads via the refs so it stays valid through async resize
  // and frame events.
  function renderRequest(r: GridRenderer): void {
    const f = frameRef.current;
    const explicitRows = rowsRef.current;
    const sel = selectionRef.current;
    if (explicitRows) {
      // Inline mode — caller-provided row window. The backend frame's
      // `cursor_row` is in original-grid coordinates (0..frame.rows),
      // but `explicitRows` may be any contiguous slice of the grid
      // (LiveBlock's `trimEchoAndBlanks` drops leading blanks + the
      // command echo, so the slice usually starts past row 0 and
      // sometimes ends short of the last row).
      //
      // `firstRowOffset` tells us where `explicitRows[0]` sits in the
      // original grid. Without it we'd guess "the slice is the tail
      // of the grid" — fine for many shell commands, wrong for any
      // agent TUI where the trim moved the slice's start.
      const windowSize = explicitRows.length;
      const offset =
        firstRowOffset ?? (f ? Math.max(0, f.rows - windowSize) : 0);
      let cursor: { row: number; col: number; visible: boolean } | null = null;
      if (f) {
        const cursorRowInWindow = f.cursor_row - offset;
        if (cursorRowInWindow >= 0 && cursorRowInWindow < windowSize) {
          cursor = {
            row: cursorRowInWindow,
            col: f.cursor_col,
            // Honor DECTCEM. Claude hides the cursor while its slash-
            // command picker is open; without this gate a spurious
            // block caret paints over whatever picker cell happens to
            // sit at (cursor_row, cursor_col) and the user sees a
            // "stuck" cursor in the middle of a description.
            visible: f.cursor_visible !== false,
          };
        }
      }
      r.render({
        rows: explicitRows,
        cols: f?.cols ?? 80,
        seq: f?.seq ?? 0,
        cursor,
        // Selection is stored in grid coords; renderer wants window
        // coords. Translate here so a firstRowOffset shift mid-drag
        // (large output arrives while the user is selecting) keeps
        // the highlight on the same cells the user clicked.
        selection: gridSelectionToWindow(sel, offset, windowSize),
      });
    } else if (f) {
      // For the full-frame path we can't use renderFrame() because
      // it doesn't forward selection. Reconstruct the input shape.
      // Full-frame path has no explicit window — original-grid and
      // window-relative coords coincide (offset = 0), so the
      // translation is a no-op pass-through.
      r.render({
        rows: f.dirty,
        cols: f.cols,
        seq: f.seq,
        cursor: {
          row: f.cursor_row,
          col: f.cursor_col,
          visible: f.cursor_visible !== false,
        },
        selection: gridSelectionToWindow(sel, 0, f.rows),
      });
    } else {
      r.renderFrame(null);
    }
  }

  // Queue a render for the next animation frame, deduping multiple
  // requests inside the same paint cycle. Synchronous render paths
  // (initial bootstrap, ResizeObserver, DPR change) still call
  // `renderRequest` directly — see the comment on the ResizeObserver
  // effect about why deferring resize-time paint causes a black
  // flash. This coalescer is only for cheap state-driven repaints.
  function scheduleRender(): void {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      const r = rendererRef.current;
      if (!r) return;
      renderRequest(r);
    });
  }

  // ---- Selection + clipboard ----------------------------------------
  //
  // Mouse-driven cell selection. The flow:
  //   1. mousedown on the wrapper  → record anchor cell, set dragging
  //   2. mousemove (document-level) → update end cell while dragging
  //   3. mouseup   (document-level) → finalise; keep selection visible
  //   4. mousedown elsewhere       → clears the previous selection
  //                                  (handled by setting a new anchor)
  //   5. cmd+C while focused       → extract text from the selected
  //                                  cell range and write to clipboard
  //
  // Coordinates are window-relative: cell (0,0) is the top-left of
  // whatever's currently rendered (the full grid in fill mode, the
  // windowed tail in auto mode). The renderer applies the same
  // mapping when it walks the instance buffer, so the rendered
  // highlight aligns with the cells the copy step extracts from.

  /**
   * Convert a mouse event to (gridRow, col) cell coordinates. The
   * returned `row` is in ORIGINAL-GRID coordinates (windowRow +
   * firstRowOffset), so the selection state survives a row-window
   * shift mid-drag (e.g. large agent output prepends scrollback while
   * the user is selecting). Returns null when the renderer hasn't
   * booted yet (early frames before WebGPU init resolves).
   */
  const eventToCell = useCallback(
    (e: ReactMouseEvent | MouseEvent): { row: number; col: number } | null => {
      const wrapper = wrapperRef.current;
      const renderer = rendererRef.current;
      if (!wrapper || !renderer) return null;
      const rect = wrapper.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const { widthCss, heightCss } = renderer.cellSize;
      if (widthCss <= 0 || heightCss <= 0) return null;
      const col = Math.max(0, Math.floor(x / widthCss));
      const windowRow = Math.max(0, Math.floor(y / heightCss));
      // Translate window-relative → original-grid coordinates so the
      // stored Selection is stable across firstRowOffset shifts.
      const row = windowRow + (firstRowOffsetRef.current ?? 0);
      return { row, col };
    },
    [],
  );

  /**
   * Repaint the renderer right now without waiting for a fresh frame.
   * Selection changes don't bump the backend's frame seq, so the
   * renderer's dedupe would otherwise skip our request.
   */
  const repaint = useCallback(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.invalidate();
    // Selection drags fire mousemove many times per frame; coalesce
    // through scheduleRender so a burst of cell-range updates flushes
    // as a single paint instead of N renders within the same tick.
    scheduleRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    // Only react to left-clicks. Right-clicks open context menus and
    // middle-click is paste — both must pass through.
    if (e.button !== 0) return;
    const cell = eventToCell(e);
    if (!cell) return;
    // Shift+click extends from the existing anchor if there is one;
    // otherwise it starts a fresh selection at this cell. Mirrors how
    // every other text-editing surface treats shift-click.
    const prev = selectionRef.current;
    if (e.shiftKey && prev) {
      const next: Selection = {
        startRow: prev.startRow,
        startCol: prev.startCol,
        endRow: cell.row,
        endCol: cell.col,
      };
      selectionRef.current = next;
      setSelection(next);
    } else {
      const next: Selection = {
        startRow: cell.row,
        startCol: cell.col,
        endRow: cell.row,
        endCol: cell.col,
      };
      selectionRef.current = next;
      setSelection(next);
    }
    draggingRef.current = true;
    inputRef.current?.focus();
    repaint();
  };

  // Document-level mouse handlers so a drag continues even when the
  // pointer leaves the canvas (the user goes selecting past the edge).
  // The handlers are only installed while a drag is in flight to keep
  // mouse processing for every other canvas zero-cost.
  useEffect(() => {
    if (!selection) return;
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const cell = eventToCell(e);
      if (!cell) return;
      const prev = selectionRef.current;
      if (!prev) return;
      const next: Selection = {
        startRow: prev.startRow,
        startCol: prev.startCol,
        endRow: cell.row,
        endCol: cell.col,
      };
      // Skip the work if the cell hasn't actually changed — mousemove
      // fires many times per pixel and recomputing the same selection
      // would burn GPU bandwidth for no visible difference.
      if (
        prev.endRow === next.endRow &&
        prev.endCol === next.endCol
      ) {
        return;
      }
      selectionRef.current = next;
      setSelection(next);
      repaint();
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      // Empty-range collapse: if the user mouse-downed and released
      // without dragging, drop the selection so they don't see a
      // single-cell stripe and so cmd+C reads as "nothing selected".
      const cur = selectionRef.current;
      if (
        cur &&
        cur.startRow === cur.endRow &&
        cur.startCol === cur.endCol
      ) {
        selectionRef.current = null;
        setSelection(null);
        repaint();
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [selection, eventToCell, repaint]);

  /**
   * Extract the selected cells as plain text. Trims trailing
   * whitespace on each row (alacritty pads rows with blanks past
   * the printed content) and joins with \n — the standard
   * terminal selection-copy shape every shell + agent expects on
   * paste. Returns an empty string when nothing is selected or the
   * range collapses (defensive — caller should already have
   * cleared the selection in that case).
   */
  const extractSelectionText = useCallback((): string => {
    const sel = selectionRef.current;
    if (!sel) return "";
    // Canonicalise so startRow,startCol is lexicographically before
    // endRow,endCol — same logic the renderer uses.
    const aBefore =
      sel.startRow < sel.endRow ||
      (sel.startRow === sel.endRow && sel.startCol <= sel.endCol);
    const srGrid = aBefore ? sel.startRow : sel.endRow;
    const sc = aBefore ? sel.startCol : sel.endCol;
    const erGrid = aBefore ? sel.endRow : sel.startRow;
    const ec = aBefore ? sel.endCol : sel.startCol;
    const sourceRows: DirtyRow[] | undefined =
      rowsRef.current ?? frameRef.current?.dirty;
    if (!sourceRows || sourceRows.length === 0) return "";
    // Translate grid → window. Selection is stored in original-grid
    // coords; sourceRows is window-relative (indices 0..length-1
    // correspond to the current windowed slice). Without this
    // translation, large scrollback (firstRowOffset deeply negative)
    // would have us slicing at negative or far-future indices and
    // returning empty / mangled text.
    const offset = firstRowOffsetRef.current ?? 0;
    const sr = srGrid - offset;
    const er = erGrid - offset;
    const lines: string[] = [];
    for (let r = sr; r <= er; r++) {
      if (r < 0 || r >= sourceRows.length) continue;
      const row = sourceRows[r];
      const rowStart = r === sr ? sc : 0;
      // Inclusive end-of-row when the selection extends past this row.
      const rowEnd = r === er ? ec : Infinity;
      let col = 0;
      let line = "";
      for (const span of row.spans) {
        for (const ch of span.text) {
          if (col >= rowStart && col < rowEnd) {
            line += ch;
          }
          col++;
        }
      }
      // Trim only trailing whitespace — leading whitespace might be
      // intentional indent that the user is selecting (e.g., a Python
      // diff hunk).
      lines.push(line.replace(/\s+$/, ""));
    }
    return lines.join("\n");
  }, []);

  // Window-level Cmd+C copy. When this CanvasGrid is rendered read-only
  // (no onSendBytes — e.g. inside an inline LiveBlock in agent mode),
  // there's no input textarea to host the onKeyDown handler. The
  // textarea-level Cmd+C path below is never reached, so a canvas-
  // drag selection has no way out to the clipboard. The window
  // listener handles that case: when this grid has a live selection
  // AND no DOM selection is competing, copy the selection text
  // directly. The textarea-level handler still runs first when the
  // grid IS interactive, so this doesn't double-copy.
  //
  // Guardrails — we must NEVER intercept Cmd+C while the user has
  // focus inside a real editable surface (code editor, markdown view,
  // commit composer, branch switcher input, …). Without these gates a
  // *stale* `selectionRef.current` (user dragged-selected in the
  // canvas earlier, then clicked away to a different pane) would let
  // this handler steal Cmd+C *in the editor* and write the stale
  // canvas selection to the clipboard. That regression is invisible
  // to the user — Cmd+C just "doesn't work" anywhere outside the
  // canvas. The active-element check below is the load-bearing one
  // that keeps this handler from leaking outside the grid.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "c") return;
      if (!selectionRef.current) return;
      // If focus is on a real editable element (textarea, input, or
      // any contenteditable surface like CodeMirror / TipTap), let
      // the native Cmd+C path run — the user is trying to copy from
      // that input, not from a stale canvas selection.
      const active = document.activeElement;
      if (active && active !== document.body) {
        if (
          active instanceof HTMLTextAreaElement ||
          active instanceof HTMLInputElement
        ) {
          return;
        }
        if (active instanceof HTMLElement && active.isContentEditable) {
          return;
        }
      }
      const docSel = window.getSelection();
      if (docSel && !docSel.isCollapsed && docSel.toString().length > 0) {
        // A live DOM selection exists somewhere on the page (e.g. the
        // user dragged across markdown rendered text). If that
        // selection is inside an editable, also bail — Cmd+C must
        // copy what the user just highlighted, not our stale state.
        const anchor = docSel.anchorNode;
        const anchorEl =
          anchor instanceof Element ? anchor : anchor?.parentElement ?? null;
        if (anchorEl) {
          if (anchorEl.closest("textarea, input")) return;
          if (anchorEl instanceof HTMLElement && anchorEl.isContentEditable) {
            return;
          }
        }
        return;
      }
      const text = extractSelectionText();
      if (text.length === 0) return;
      e.preventDefault();
      void navigator.clipboard.writeText(text).catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [extractSelectionText]);

  // Input handling. Mirrors FullGrid / PtyPassthrough so all three
  // paths agree on encoding. Read-only when onSendBytes is omitted.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd+C while a selection is active → copy the selected cells to
    // the clipboard. Cmd+C only — NOT Ctrl+C. In a terminal context
    // Ctrl+C means "interrupt the foreground process," and on macOS
    // Cmd+C is the universal copy shortcut. Conflating them here was
    // the bug: a stale selectionRef (e.g. user click-dragged once and
    // never clicked away to clear it) caused Ctrl+C to copy that
    // stale text instead of sending SIGINT to the running TUI.
    if (e.metaKey && !e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "c") {
      if (selectionRef.current) {
        const text = extractSelectionText();
        if (text.length > 0) {
          e.preventDefault();
          // navigator.clipboard.writeText is the Tauri-friendly path
          // — it round-trips through the OS clipboard rather than
          // depending on the focused-element selection model.
          void navigator.clipboard.writeText(text).catch(() => {
            // Silent — if the user has clipboard permissions denied
            // there's nothing useful we can show, and they'll learn
            // by the missing paste.
          });
          return;
        }
      }
    }
    if (!onSendBytes) return;
    if (isGlobalChord(e)) return;
    const seq = keyToBytes(e, frame?.app_cursor ?? false);
    if (seq) {
      e.preventDefault();
      onSendBytes(seq);
    }
  };

  const pendingPasteRef = useRef<string | null>(null);
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onSendBytes) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text.length === 0) return;
    pendingPasteRef.current = text;
  };

  const onInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!onSendBytes) return;
    const value = e.target.value;
    if (value.length === 0) return;
    const pasted = pendingPasteRef.current;
    pendingPasteRef.current = null;
    const enc = new TextEncoder();
    if (frame?.bracketed_paste && pasted !== null && value === pasted) {
      const PASTE_START = enc.encode("\x1b[200~");
      const PASTE_END = enc.encode("\x1b[201~");
      const payload = enc.encode(value);
      const out = new Uint8Array(
        PASTE_START.length + payload.length + PASTE_END.length,
      );
      out.set(PASTE_START, 0);
      out.set(payload, PASTE_START.length);
      out.set(PASTE_END, PASTE_START.length + payload.length);
      onSendBytes(out);
    } else {
      onSendBytes(enc.encode(value));
    }
    e.target.value = "";
  };

  return (
    <div
      ref={wrapperRef}
      onMouseDown={onMouseDown}
      style={{
        width: "100%",
        height: mode === "auto" ? `${autoHeightPx}px` : "100%",
        position: "relative",
        backgroundColor: "var(--surface-0)",
        // I-beam cursor so users know the surface is selectable; the
        // I-beam also reads correctly in read-only mode (browsing
        // scrollback) where we still allow selection + copy.
        cursor: "text",
        // Suppress the OS' native text-select behaviour over the
        // canvas — we draw our own highlight via the WGSL shader and
        // the OS selection would do nothing useful (the canvas has
        // no DOM text nodes to select).
        userSelect: "none",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
        }}
      />
      {onSendBytes && (
        <textarea
          ref={inputRef}
          onKeyDown={onKeyDown}
          onChange={onInput}
          onPaste={onPaste}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-label="Terminal input passthrough"
          style={{
            position: "absolute",
            left: -10000,
            top: -10000,
            width: 1,
            height: 1,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
});

