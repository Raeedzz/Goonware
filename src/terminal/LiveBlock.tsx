import { useEffect, useMemo, useRef } from "react";
import { CanvasGrid } from "./CanvasGrid";
import { CellRow } from "./CellRow";
import { formatCwd, formatDuration } from "./formatBlockMeta";
import { liveBlockOuterStyle } from "./agentScrollLayout";
import type { DirtyRow, RenderFrame } from "./types";

interface Props {
  /** What the user typed to start the running command. */
  command: string;
  /** Live rows from the current command's output. */
  frame: RenderFrame | null;
  /**
   * When true, the block fills the pane (claude/codex own the surface).
   * Otherwise it sizes to content and shares scroll with BlockList.
   */
  fill?: boolean;
  /** cwd at command start, for the small dim header. */
  cwd?: string;
  /**
   * When true, render rows as a fixed-grid TUI surface — no wrap, no
   * width-driven reflow. Used when the running command is an
   * interactive agent (claude / codex / aider) whose UI assumes one
   * visual line per grid row. Independent of `fill` so the block can
   * sit inline in the conversation scroll without breaking the
   * agent's layout.
   */
  preserveGrid?: boolean;
  /**
   * Disable soft-wrap on shell output rows. Used by the narrow
   * right-panel secondary terminal so long lines pan via horizontal
   * scroll instead of wrapping. Has no effect in agent mode
   * (`preserveGrid`/`fill`), which already runs grid-mode no-wrap.
   */
  noWrap?: boolean;
  /**
   * Forwarded to the embedded CanvasGrid so it can rebuild / repaint
   * on the keepalive layer's `display: none → flex` transition. See
   * the doc on `CanvasGrid.Props.isVisible` for the WKWebView surface-
   * release dance this works around. Defaults to true.
   */
  isVisible?: boolean;
}

/**
 * The "in-progress block" — what's running right now. In shell mode it
 * shares its parent scroll with the BlockList above; in agent mode
 * (claude/codex) it gets the full pane height since the agent owns the
 * surface.
 */

function rowIsBlank(row: DirtyRow): boolean {
  for (const s of row.spans) {
    if (s.text.trim().length > 0) return false;
  }
  return true;
}

function rowText(row: DirtyRow): string {
  return row.spans.map((s) => s.text).join("").trim();
}

/**
 * Strip leading blanks + zsh's echo of the typed command, plus
 * trailing blanks. Same shape as the closed-block transcript trim
 * (`Block.tsx` skips line 0 when input matches), kept consistent so
 * a running block and its eventual closed block look visually
 * continuous when the command finishes.
 *
 * `footerKeepThroughRow` (optional) — minimum original-grid row
 * index that must remain in the trimmed slice even when its tail is
 * blank. Used by agent TUIs (claude/codex/gemini) where the input
 * cursor sits above the meta + auto-mode hint and those rows are
 * momentarily blank mid-redraw. Pass `frame.cursor_row + 5` for
 * agents and `undefined` for shell commands.
 */
function trimEchoAndBlanks(
  rows: DirtyRow[],
  command: string,
  footerKeepThroughRow?: number,
): DirtyRow[] {
  const target = command.trim();
  let i = 0;
  while (i < rows.length && rowIsBlank(rows[i])) i++;
  if (i < rows.length && target.length > 0 && rowText(rows[i]) === target) {
    i++;
  }
  let j = rows.length - 1;
  while (j >= i && rowIsBlank(rows[j])) j--;
  if (typeof footerKeepThroughRow === "number") {
    const minJ = Math.min(rows.length - 1, footerKeepThroughRow);
    if (minJ > j) j = minJ;
  }
  if (i > j) return [];
  return rows.slice(i, j + 1);
}

/**
 * The "in-progress block" — what's running right now. Visually
 * matches `Block.tsx` so the moment a command finishes and the live
 * block is replaced by a closed block, the swap is invisible. The
 * synthetic ❯ + command header makes the user's input look like a
 * "user message" in a chat (Warp-style) instead of a floating echo.
 */
export function LiveBlock({
  command,
  frame,
  fill = false,
  cwd,
  preserveGrid = false,
  noWrap = false,
  isVisible = true,
}: Props) {
  const visibleRows = useMemo(() => {
    if (!frame) return [];
    // Tight trim of leading + trailing blanks. For agents, keep
    // cursor + 5 rows so the meta/hint footer that paints just below
    // the input cursor still has canvas space when claude is mid-
    // redraw. The pinned-bottom layout in BlockTerminal anchors this
    // tight slice to the bottom of the pane, so the result is: as
    // much vertical space as claude's actual UI needs, no more, no
    // less, always visible.
    const footerKeep = preserveGrid ? frame.cursor_row + 5 : undefined;
    return trimEchoAndBlanks(frame.dirty, command, footerKeep);
  }, [frame, command, preserveGrid]);

  // Concatenate scrollback above visibleRows. Each entry in
  // `frame.scrollback_appended` (in this code path, the full
  // accumulated scrollback — see flushFrame in useTerminalSession)
  // becomes a row at the top of the rendered canvas, then the trimmed
  // visible grid follows. Without this concat, the only thing the user
  // can scroll back through is whatever currently fits in alacritty's
  // visible grid — anything an agent wrote earlier has already moved
  // to PTY scrollback and is invisible to the canvas.
  //
  // Row-index space. The cursor's row index (`frame.cursor_row`) is in
  // alacritty's visible-grid coords (0..screen_lines-1). `visibleRows`
  // already preserves those indices verbatim (trim drops leading
  // blanks but keeps `row.row` set to the original grid index). To
  // keep the cursor translation in CanvasGrid working unchanged
  // (`cursorRowInWindow = cursor_row - firstRowOffset` must land at
  // the correct array index in `combinedRows`), the scrollback rows
  // we prepend MUST extend that same coordinate space — i.e. carry
  // synthetic indices `(visibleRows[0].row - K)..(visibleRows[0].row - 1)`.
  // Then `combinedRows[0].row` is the correct `firstRowOffset` for
  // both the no-scrollback and with-scrollback cases.
  const combinedRows = useMemo(() => {
    if (!frame) return visibleRows;
    const scrollback = frame.scrollback_appended ?? [];
    if (scrollback.length === 0) return visibleRows;
    const out: typeof visibleRows = new Array(
      scrollback.length + visibleRows.length,
    );
    const visibleStart = visibleRows.length > 0 ? visibleRows[0].row : 0;
    const scrollbackStart = visibleStart - scrollback.length;
    for (let i = 0; i < scrollback.length; i++) {
      out[i] = { row: scrollbackStart + i, spans: scrollback[i].spans };
    }
    for (let j = 0; j < visibleRows.length; j++) {
      out[scrollback.length + j] = visibleRows[j];
    }
    return out;
  }, [frame, visibleRows]);

  // Original-grid row index of `combinedRows[0]`. Used by the canvas
  // path to translate `frame.cursor_row` (in visible-grid coords) into
  // a window-relative row. When scrollback is non-empty this is
  // negative (extends the visible-grid coord space upward into
  // scrollback); without it the cursor would paint several rows above
  // where it should be the moment scrollback grew beyond zero rows.
  const firstRowOffset = useMemo(() => {
    if (!frame || combinedRows.length === 0) return 0;
    return combinedRows[0].row;
  }, [frame, combinedRows]);

  const hasBody = combinedRows.length > 0;
  const cwdLabel = formatCwd(cwd);

  // Live duration counter — same look as closed blocks but updated
  // every animation frame so the user sees the command time accumulate
  // smoothly. The label is written directly into a ref-bound <span>
  // via `textContent`, never via React state. This avoids ~10
  // unnecessary commits per second per running command — at 20 active
  // panes that's ~200 component-level rerenders/s, all on the React
  // critical path. rAF + DOM write puts the work on the compositor
  // instead and frees the main thread for actual user input.
  const startRef = useRef<number>(Date.now());
  const durationRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    startRef.current = Date.now();
    let cancelled = false;
    let raf = 0;
    let lastLabel = "";
    const paint = () => {
      if (cancelled) return;
      const label = formatDuration(Date.now() - startRef.current);
      if (label !== lastLabel) {
        lastLabel = label;
        const node = durationRef.current;
        if (node) node.textContent = `(${label})`;
      }
      raf = requestAnimationFrame(paint);
    };
    // Prime once synchronously so the first paint already shows a
    // sensible duration; rAF takes over after that.
    paint();
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [command]);
  // Initial label at first render. Subsequent updates are written
  // directly into `durationRef.current` by the rAF loop — React never
  // commits them.
  const initialElapsedLabel = formatDuration(Date.now() - startRef.current);

  return (
    <div
      style={{
        // Outer-flex sizing comes from agentScrollLayout so the
        // squash-prevention invariant (fill mode must have a hard,
        // viewport-sized min-height and zero flex-shrink) stays
        // pinned by tests in agentScrollLayout.test.ts.
        ...liveBlockOuterStyle(fill),
        padding: "var(--space-2) var(--space-3)",
        borderTop: "var(--border-1)",
        fontFamily: "var(--font-mono)",
        fontSize: 13,
        fontVariantLigatures: "none",
        color: "var(--text-primary)",
        // Selection rules:
        //  - Shell command output (preserveGrid=false): allow DOM
        //    selection — users want to copy `git log` output, etc.
        //  - Agent TUI (preserveGrid=true): disallow DOM selection.
        //    Browser-painted selection would paint over the agent's
        //    cursor cell and hide it (the cursor is just an inverse-
        //    coloured <span> in the DOM path; the OS selection
        //    overlay erases it). This is the symptom users see as
        //    "shift-click makes the cursor disappear in the agent."
        //    Canvas-rendered agent blocks (below) get their own
        //    shader-driven selection, so DOM selection adds nothing
        //    there either. The selection chrome above (the closed
        //    blocks in BlockList) is unaffected — each closed Block
        //    sets its own userSelect.
        userSelect: preserveGrid ? "none" : "text",
      }}
    >
      {(cwdLabel || initialElapsedLabel) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            color: "var(--text-tertiary)",
            fontSize: "var(--text-2xs)",
            marginBottom: 2,
            flexShrink: 0,
          }}
        >
          {cwdLabel && <span>{cwdLabel}</span>}
          {initialElapsedLabel && (
            <span ref={durationRef}>({initialElapsedLabel})</span>
          )}
          <span
            aria-label="running"
            style={{
              marginLeft: "auto",
              color: "var(--accent-bright)",
              letterSpacing: "var(--tracking-caps)",
              textTransform: "uppercase",
              fontFamily: "var(--font-sans)",
            }}
          >
            running
          </span>
        </div>
      )}
      <div
        style={{
          fontWeight: 600,
          color: "var(--text-primary)",
          paddingBottom: hasBody ? "var(--space-1-5)" : 0,
          marginBottom: hasBody ? "var(--space-1-5)" : 0,
          borderBottom: hasBody ? "var(--border-1)" : "none",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {command}
      </div>
      {hasBody ? (
        <div
          style={{
            color: "var(--text-secondary)",
            // Fill mode: `flex: 1 1 auto` — basis is the canvas's
            // natural height, so the body grows with its content.
            // The OUTER scroll container handles overflow, never this
            // body. Critical: do NOT set `minHeight: 0` here — combined
            // with the default `flex-shrink: 1` on the CanvasGrid
            // wrapper, that would let flex layout cap the canvas height
            // at the body's viewport allotment. The wrapper's
            // ResizeObserver would then push the shrunk height into
            // `renderer.resize()` and the bottom rows of the canvas
            // (claude's input box + footer) would simply never be
            // painted. flex-end keeps the canvas hugging the bottom of
            // the body whenever it IS shorter than the body — so a
            // freshly-started agent's input row sits flush against the
            // agent status bar below instead of floating in the middle.
            flex: fill ? "1 1 auto" : undefined,
            display: fill ? "flex" : undefined,
            flexDirection: fill ? "column" : undefined,
            justifyContent: fill ? "flex-end" : undefined,
            // Horizontal clip protects against the CanvasGrid briefly
            // rendering wider than the pane while the SIGWINCH debounce
            // settles (otherwise the right edge spills under the right
            // sidebar). In `noWrap` shell mode we WANT lines to overflow
            // outward so the side terminal's outer scroll container can
            // pan them — and there's no CanvasGrid in that path (canvas
            // is `preserveGrid`-only), so dropping the clip is safe.
            overflowX: noWrap && !preserveGrid && !fill ? "visible" : "hidden",
          }}
        >
          {/* Agent TUI blocks (preserveGrid) always render through the
              WebGPU CanvasGrid — it owns its own selection + cursor
              painting, so no browser-selection-eats-cursor issue and
              the cursor draws on top of any selection overlay. Shell
              command output stays on the DOM CellRow path because
              canvas doesn't soft-wrap yet (the wrap mode is what
              keeps long lines readable in narrow panes — promoting
              canvas here is a follow-up that needs wrap support). */}
          {preserveGrid && frame ? (
            <CanvasGrid
              frame={frame}
              rows={combinedRows}
              mode="auto"
              firstRowOffset={firstRowOffset}
              isVisible={isVisible}
            />
          ) : (
            combinedRows.map((row) => (
              <CellRow
                key={row.row}
                spans={row.spans}
                wrap={!preserveGrid && !fill && !noWrap}
              />
            ))
          )}
        </div>
      ) : (
        // Empty-body state. In agent mode (fill=true) this is the gap
        // between OSC 133 C clearing the grid and the agent painting
        // its first frame — without a placeholder the pane flashes
        // pure surface-0 (looks black) for ~50–200 ms while claude
        // initializes its TUI. A subtle "starting…" matches the
        // header's monospace and makes the gap feel intentional.
        fill && (
          <div
            style={{
              flex: "1 1 0",
              minHeight: 0,
              display: "grid",
              placeItems: "center",
              color: "var(--text-tertiary)",
              fontSize: "var(--text-xs)",
              fontFamily: "var(--font-mono)",
              userSelect: "none",
            }}
          >
            starting {command}…
          </div>
        )
      )}
    </div>
  );
}
