import {
  useCallback,
  useEffect,
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
import { isGlobalChord, keyToBytes } from "./keyEncoding";
import type { DirtyRow, RenderFrame } from "./types";

/**
 * Half-open cell-coord range. `start` is the anchor (mouse-down
 * cell); `end` is the live mouse position. Either end can be
 * lexicographically less than the other — the renderer canonicalises.
 */
interface Selection {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
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
export function CanvasGrid({
  frame,
  rows,
  mode = "fill",
  onSendBytes,
  font,
  fontSizeCss = 13,
  lineHeight = 1.35,
  firstRowOffset,
  isVisible = true,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rendererRef = useRef<GridRenderer | null>(null);
  const frameRef = useRef<RenderFrame | null>(frame);
  const rowsRef = useRef<DirtyRow[] | undefined>(rows);
  frameRef.current = frame;
  rowsRef.current = rows;

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

    void createGridRenderer(
      canvas,
      fontFamily,
      fontSizeCss,
      lineHeight,
      handleDeviceLost,
    )
      .then((renderer) => {
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
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[CanvasGrid] WebGPU init failed:", err);
      });

    return () => {
      cancelled = true;
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendererEpoch]);

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
      renderer.resize(
        rect.width,
        rect.height,
        window.devicePixelRatio || 1,
      );
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
  // `wasVisibleRef` only advances when the decision is "restore" or
  // "noop" — a "defer" leaves it at false so the next ResizeObserver
  // tick (with a real rect this time) can still trigger the restore.
  const wasVisibleRef = useRef(isVisible);
  useEffect(() => {
    const renderer = rendererRef.current;
    const wrapper = wrapperRef.current;
    const rect = wrapper?.getBoundingClientRect();
    const rectWidth = rect?.width ?? 0;
    const rectHeight = rect?.height ?? 0;
    const action = decideVisibilityAction({
      wasVisible: wasVisibleRef.current,
      isVisible,
      rectWidth,
      rectHeight,
    });
    // On `defer` the ref stays at false so the next observer tick
    // (with real rect) decides "restore" instead of "noop". On
    // anything else, the ref advances to mirror the current value.
    if (action !== "defer") wasVisibleRef.current = isVisible;
    if (!renderer) return;
    executeVisibilityAction(
      action,
      {
        reconfigure: () => renderer.reconfigure(),
        resizeFromRect: (w, h, dpr) => renderer.resize(w, h, dpr),
        invalidate: () => renderer.invalidate(),
        paint: () => renderRequest(renderer),
      },
      rectWidth,
      rectHeight,
      window.devicePixelRatio || 1,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible]);

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
      let cursor: { row: number; col: number; visible: boolean } | null = null;
      if (f) {
        const windowSize = explicitRows.length;
        const offset = firstRowOffset ?? Math.max(0, f.rows - windowSize);
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
        selection: sel,
      });
    } else if (f) {
      // For the full-frame path we can't use renderFrame() because
      // it doesn't forward selection. Reconstruct the input shape.
      r.render({
        rows: f.dirty,
        cols: f.cols,
        seq: f.seq,
        cursor: {
          row: f.cursor_row,
          col: f.cursor_col,
          visible: f.cursor_visible !== false,
        },
        selection: sel,
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
   * Convert a mouse event to (row, col) cell coordinates relative to
   * the rendered grid. Returns null when the renderer hasn't booted
   * yet (early frames before WebGPU init resolves).
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
      const row = Math.max(0, Math.floor(y / heightCss));
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
    const sr = aBefore ? sel.startRow : sel.endRow;
    const sc = aBefore ? sel.startCol : sel.endCol;
    const er = aBefore ? sel.endRow : sel.startRow;
    const ec = aBefore ? sel.endCol : sel.startCol;
    const sourceRows: DirtyRow[] | undefined =
      rowsRef.current ?? frameRef.current?.dirty;
    if (!sourceRows || sourceRows.length === 0) return "";
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
}

