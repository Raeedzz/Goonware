/**
 * Wire format mirroring Rust's `term.rs` serde shapes. Keep in sync.
 */

export interface Span {
  text: string;
  fg: string;
  bg: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  dim: boolean;
  strikeout: boolean;
}

export interface DirtyRow {
  row: number;
  spans: Span[];
}

export interface RenderFrame {
  /**
   * Monotonic frame sequence id. The rAF flush in `useTerminalSession`
   * uses it to dedupe (skip if unchanged since the last flush) and to
   * detect dropped frames in heavy bursts (gaps in seq imply
   * coalescing under load — log + drop).
   */
  seq: number;
  /**
   * Stable id of the block this frame belongs to. 0 means no block is
   * active (before the first prompt or briefly between blocks).
   * Survives reflow / resize / scroll so the canvas renderer can
   * identify which block a row belongs to without comparing text.
   */
  block_id: number;
  cols: number;
  rows: number;
  cursor_row: number;
  cursor_col: number;
  alt_screen: boolean;
  /**
   * True iff the segmenter is between OSC 133 C and D. The block-mode
   * BlockList only paints the live grid while a command is producing
   * output — between commands the empty zsh prompt rows would otherwise
   * ghost above the input box.
   */
  command_running: boolean;
  /**
   * DECCKM (application cursor mode). When true, the running program
   * has issued `ESC[?1h` — arrows must be sent as `ESC O A/B/C/D` not
   * `ESC [ A/B/C/D`. Claude / vim insert / readline TUIs all flip this.
   * Without honoring it, the agent never sees the user's arrow keys.
   */
  app_cursor: boolean;
  /**
   * DECSET 2004 (bracketed paste). When true, the running program has
   * issued `ESC[?2004h` and expects pasted bytes wrapped in
   * `ESC[200~ ... ESC[201~`. Without those markers a multi-line paste
   * gets read line-by-line by the agent (each newline triggers a
   * partial redraw), making the bottom of a big prompt appear to
   * "load slowly." Frontend's PtyPassthrough wraps paste events when
   * this is set.
   */
  bracketed_paste: boolean;
  /**
   * DECTCEM (`ESC[?25h/l`). True when the running program has the
   * cursor visible. Claude / fzf / readline pickers flip this off
   * while their inline UI is open — we honor it by suppressing our
   * own cursor draw so a stray block caret doesn't land in the
   * middle of a picker description row.
   */
  cursor_visible: boolean;
  dirty: DirtyRow[];
  /**
   * Rows that just scrolled OUT of the visible grid into PTY scrollback
   * since the previous frame. Oldest first — the frontend appends them
   * verbatim to its scrollback buffer so the agent's history reads
   * top-to-bottom. Empty in the common case; only populated by the
   * scroll-on-LF path in alacritty's main screen (alt-screen apps like
   * vim/htop never push to main scrollback, so this stays empty while
   * `alt_screen` is true).
   */
  scrollback_appended: DirtyRow[];
  /**
   * When true, the frontend MUST drop its scrollback buffer before
   * applying `scrollback_appended`. The backend sets this on the
   * term_start re-emit (full state refresh, used after a React remount)
   * and whenever alacritty's `history_size()` shrinks (resize-evict,
   * Ctrl+L clear-saved). In both cases, the prior buffer's row
   * identities no longer line up with the live grid.
   */
  scrollback_reset: boolean;
}

/**
 * One row of a closed block's rendered grid snapshot. Mirrors Rust's
 * `RowSnapshot` shape (`{ spans: Span[] }`). Shipped on `ClosedBlock`
 * as `blockRows` — see the comment below for why this exists.
 */
export interface BlockRow {
  spans: Span[];
}

export interface ClosedBlock {
  /** Stable id minted by the Rust segmenter at OSC 133 A. */
  block_id: number;
  input: string;
  /**
   * Full byte transcript from OSC 133 A → D. Kept as a fallback /
   * for search; the primary render path uses `blockRows` (below).
   */
  transcript: string;
  /**
   * Pre-rendered grid snapshot of this block's transcript, produced
   * on the Rust side by feeding the bytes through a fresh alacritty
   * `Term` and walking the resulting grid. Rendering from this
   * (instead of running the byte stream through the small
   * `parseAnsi.ts`) is what lets progress bars, `\r`-overstrike,
   * line clears, and other cursor-driven redraws come out the way
   * they looked live. Empty when the transcript was empty.
   */
  blockRows: BlockRow[];
  exit_code: number | null;
  /** cwd at OSC 133 C — where the command actually ran. */
  cwd: string | null;
  /** Wall-clock duration in ms from OSC 133 C → D. */
  durationMs: number | null;
}

export interface Block {
  /** Stable id we generate on receipt for React keys. */
  id: string;
  /** Stable id minted by Rust at OSC 133 A. Survives reflow/resize. */
  block_id: number;
  input: string;
  transcript: string;
  /** See `ClosedBlock.blockRows`. */
  blockRows: BlockRow[];
  exit_code: number | null;
  cwd: string | null;
  durationMs: number | null;
}
