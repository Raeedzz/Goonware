//! FlatTerm — Warp-style terminal emulator backend.
//!
//! Implements `vte::ansi::Handler` against an `ActiveGrid` (the live
//! screen — random-access writes for cursor moves, clears, scroll
//! regions) plus a `FlatStorage` for scrollback (append-only, the
//! flat-buffer + interval-map representation in `flat_storage.rs`).
//! The same `vte::ansi::Processor` that drives alacritty's `Term`
//! can drive FlatTerm — `Processor::advance(&mut flat_term, bytes)`.
//!
//! ## Scope
//!
//! Implemented (the shell + agent traffic surface):
//!   - input(c) with wrap-pending edge-of-line semantics
//!   - cursor moves: goto/goto_line/goto_col/move_up/move_down/
//!     move_forward/move_backward, backspace, save/restore
//!   - CR, LF, NEL (newline), reverse index, tab stops
//!   - SGR (terminal_attribute): all common color + style + cancel
//!   - clear_line, clear_screen, erase_chars, delete_chars,
//!     insert_blank_lines, delete_lines, scroll_up, scroll_down
//!   - scroll regions (DECSTBM)
//!   - alt-screen swap (private mode 1049 — with cursor save/restore)
//!   - app cursor mode tracking (private mode 1)
//!   - bracketed paste mode tracking (private mode 2004)
//!   - line wrap mode tracking (private mode 7)
//!
//! Not yet (default no-op via the Handler trait defaults):
//!   - title push/pop stack
//!   - dynamic color sequences (OSC 4/10/11/12)
//!   - clipboard OSC 52
//!   - mouse mode reporting (1000/1002/1003/1006)
//!   - sixel / iTerm image protocols
//!   - DECSC/DECRC outside the standard save/restore_cursor pair
//!   - charset selection (G0/G1/...)
//!
//! Most of those don't affect rendering. The ones that do (charset
//! selection mostly) can be added incrementally.
//!
//! ## Wiring
//!
//! Not yet hooked into `term.rs`. The live PTY path still routes
//! bytes through `alacritty_terminal::Term`. The parity tests below
//! prove FlatTerm produces identical row snapshots; once we're
//! confident enough to flip, term.rs::Session swaps Term → FlatTerm.

#![allow(dead_code)]

use crate::flat_storage::{
    BgAndStyle, FlatStorage, PackedColor, Style as PackedStyle,
};

// `vte` is re-exported through alacritty_terminal — that's the only
// path that's already in our dep tree.
use alacritty_terminal::vte::ansi::{
    Attr, ClearMode, Color, Handler, LineClearMode, NamedColor,
    NamedPrivateMode, PrivateMode, Rgb,
};

/// Per-cell style bits. Same flag set as the Span wire format —
/// keeping a single bag of flags makes Handler::terminal_attribute
/// a straightforward bitmask flip.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CellFlags(pub u16);

impl CellFlags {
    pub const BOLD: u16 = 1 << 0;
    pub const ITALIC: u16 = 1 << 1;
    pub const UNDERLINE: u16 = 1 << 2;
    pub const INVERSE: u16 = 1 << 3;
    pub const DIM: u16 = 1 << 4;
    pub const STRIKEOUT: u16 = 1 << 5;
    pub const HIDDEN: u16 = 1 << 6;
    pub const WIDE_CHAR: u16 = 1 << 7;
    pub const WIDE_CHAR_SPACER: u16 = 1 << 8;

    pub fn contains(self, bit: u16) -> bool { self.0 & bit != 0 }
    pub fn insert(&mut self, bit: u16) { self.0 |= bit; }
    pub fn remove(&mut self, bit: u16) { self.0 &= !bit; }
}

/// Single grid cell. Wide-character handling: the LEFT half of a
/// wide char has `c` set and `WIDE_CHAR` flag; the RIGHT half is a
/// "spacer" with `c == ' '` and `WIDE_CHAR_SPACER` flag. Mirrors
/// alacritty's representation so snapshot consumers don't need a
/// special path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cell {
    pub c: char,
    pub fg: Color,
    pub bg: Color,
    pub flags: CellFlags,
    /// Zero-width combining marks attached to this cell (acute,
    /// grave, umlaut, etc). Rendered as `c + zerowidth.join("")`.
    pub zerowidth: Vec<char>,
}

impl Default for Cell {
    fn default() -> Self {
        Self {
            c: ' ',
            fg: Color::Named(NamedColor::Foreground),
            bg: Color::Named(NamedColor::Background),
            flags: CellFlags::default(),
            zerowidth: Vec::new(),
        }
    }
}

/// Cursor state. Carries the current "pen" (fg/bg/flags) that
/// future `input()` calls stamp into newly-written cells, plus the
/// position and the wrap-pending flag.
///
/// `wrap_pending` semantics: when input writes a cell at the
/// rightmost column, the cursor doesn't advance off-grid — it stays
/// at col=N-1 and sets `wrap_pending = true`. The next input
/// triggers the wrap (CR + LF + clear of pending). This matches
/// xterm / VT100 behaviour and avoids double-advancing.
#[derive(Clone, Debug)]
pub struct Cursor {
    pub row: usize,
    pub col: usize,
    pub fg: Color,
    pub bg: Color,
    pub flags: CellFlags,
    pub wrap_pending: bool,
}

impl Default for Cursor {
    fn default() -> Self {
        Self {
            row: 0,
            col: 0,
            fg: Color::Named(NamedColor::Foreground),
            bg: Color::Named(NamedColor::Background),
            flags: CellFlags::default(),
            wrap_pending: false,
        }
    }
}

impl Cursor {
    fn new_for(cols: usize, rows: usize) -> Self {
        let _ = (cols, rows);
        Self::default()
    }
}

/// Saved cursor for DECSC/DECRC. We snapshot the position +
/// attributes so a `restore_cursor_position` returns to the exact
/// state the save was taken at.
#[derive(Clone, Debug)]
struct SavedCursor {
    row: usize,
    col: usize,
    fg: Color,
    bg: Color,
    flags: CellFlags,
}

impl Default for SavedCursor {
    fn default() -> Self {
        Self {
            row: 0,
            col: 0,
            fg: Color::Named(NamedColor::Foreground),
            bg: Color::Named(NamedColor::Background),
            flags: CellFlags::default(),
        }
    }
}

/// The active screen grid. Indexed as `cells[row][col]`. Always
/// `rows × cols` in size — resizes reallocate and copy.
pub struct ActiveGrid {
    rows: usize,
    cols: usize,
    cells: Vec<Vec<Cell>>,
    cursor: Cursor,
    saved_cursor: Option<SavedCursor>,
    /// Scroll region top (inclusive, 0-based row index). DECSTBM.
    scroll_top: usize,
    /// Scroll region bottom (inclusive, 0-based row index).
    scroll_bottom: usize,
}

impl ActiveGrid {
    pub fn new(cols: usize, rows: usize) -> Self {
        let cols = cols.max(1);
        let rows = rows.max(1);
        Self {
            rows,
            cols,
            cells: (0..rows).map(|_| vec![Cell::default(); cols]).collect(),
            cursor: Cursor::new_for(cols, rows),
            saved_cursor: None,
            scroll_top: 0,
            scroll_bottom: rows - 1,
        }
    }

    pub fn rows(&self) -> usize { self.rows }
    pub fn cols(&self) -> usize { self.cols }
    pub fn cursor(&self) -> &Cursor { &self.cursor }
    pub fn row(&self, idx: usize) -> Option<&[Cell]> {
        self.cells.get(idx).map(|v| v.as_slice())
    }

    fn clear_region(&mut self, from_row: usize, to_row: usize) {
        for r in from_row..=to_row.min(self.rows - 1) {
            for c in 0..self.cols {
                self.cells[r][c] = self.blank_cell();
            }
        }
    }

    /// Blank cell stamped with the cursor's CURRENT background
    /// attribute. SGR-tinted blanks come from e.g. an erase-line
    /// while the pen has bg=red — the erased region paints red.
    fn blank_cell(&self) -> Cell {
        Cell {
            c: ' ',
            fg: self.cursor.fg,
            bg: self.cursor.bg,
            flags: CellFlags::default(),
            zerowidth: Vec::new(),
        }
    }

    /// Scroll the rows in `[scroll_top ..= scroll_bottom]` up by `n`
    /// rows. The top `n` rows are LOST (callers that need scrollback
    /// must capture them BEFORE calling). New blank rows fill the
    /// bottom.
    fn scroll_up_in_region(&mut self, n: usize) {
        let region_height = self.scroll_bottom - self.scroll_top + 1;
        let n = n.min(region_height);
        for r in self.scroll_top..(self.scroll_bottom + 1 - n) {
            self.cells.swap(r, r + n);
        }
        // Blank the now-stale bottom n rows.
        for r in (self.scroll_bottom + 1 - n)..=self.scroll_bottom {
            let blank = self.blank_cell();
            for c in 0..self.cols {
                self.cells[r][c] = blank.clone();
            }
        }
    }

    fn scroll_down_in_region(&mut self, n: usize) {
        let region_height = self.scroll_bottom - self.scroll_top + 1;
        let n = n.min(region_height);
        // Move bottom-up to avoid clobbering.
        let mut r = self.scroll_bottom;
        while r >= self.scroll_top + n {
            self.cells.swap(r, r - n);
            if r == 0 { break; }
            r -= 1;
        }
        // Blank the new top n rows.
        for r in self.scroll_top..(self.scroll_top + n) {
            let blank = self.blank_cell();
            for c in 0..self.cols {
                self.cells[r][c] = blank.clone();
            }
        }
    }
}

/// Captured before a scroll-up so callers can push into scrollback.
fn take_top_row(grid: &mut ActiveGrid) -> Vec<Cell> {
    if grid.cells.is_empty() {
        return Vec::new();
    }
    grid.cells[grid.scroll_top].clone()
}

/// Scrollback row cap for FlatTerm's primary-grid history. Finite by
/// design — see the comment in `FlatTerm::new`.
const SCROLLBACK_CAP_ROWS: usize = 100_000;

/// FlatTerm — the full terminal model. Owns:
///   - `primary` active grid (the default screen)
///   - `alt` active grid (swapped in on DECSET 1049)
///   - `scrollback` FlatStorage (rows evicted from the primary scroll
///     region top get pushed here)
///   - mode flags + saved-cursor-across-altscreen
pub struct FlatTerm {
    primary: ActiveGrid,
    alt: ActiveGrid,
    scrollback: FlatStorage,
    /// True iff the alt-screen grid is active. Mirrors
    /// TermMode::ALT_SCREEN in alacritty.
    use_alt: bool,
    /// DECCKM (application cursor mode). `keyEncoding.ts` reads this
    /// via the wire format; FlatTerm just tracks it.
    app_cursor: bool,
    /// DECSET 2004 (bracketed paste).
    bracketed_paste: bool,
    /// Line wrap mode (DECSET 7). Off disables automatic wrap.
    line_wrap: bool,
    /// Saved cursor for the 1049 swap path (the OUTER save —
    /// separate from save_cursor_position's saved_cursor on the
    /// individual grid).
    saved_cursor_for_swap: Option<SavedCursor>,
    /// Tab stops, one per column. True = a tab stop lives at that
    /// column. Standard: every 8 columns.
    tab_stops: Vec<bool>,
    /// Scrollback cap — primary grid only. Alt-screen rows never
    /// flow into scrollback (they belong to the alt session).
    scrollback_cap: usize,
}

impl FlatTerm {
    pub fn new(cols: usize, rows: usize) -> Self {
        let cols = cols.max(1);
        let rows = rows.max(1);
        let mut tab_stops = vec![false; cols];
        for c in (8..cols).step_by(8) {
            tab_stops[c] = true;
        }
        Self {
            primary: ActiveGrid::new(cols, rows),
            alt: ActiveGrid::new(cols, rows),
            // Bounded scrollback. FlatStorage::with_capacity decouples
            // the cap from the initial Vec allocation, so a large cap
            // costs nothing until rows actually arrive — but the cap
            // must be FINITE before FlatTerm replaces alacritty:
            // usize::MAX here meant every agent pane retained every
            // row it ever produced for the app's lifetime. 100k rows
            // is days of continuous agent output; older rows live in
            // the persisted block history, not the live grid.
            scrollback: FlatStorage::with_capacity(SCROLLBACK_CAP_ROWS),
            use_alt: false,
            app_cursor: false,
            bracketed_paste: false,
            line_wrap: true,
            saved_cursor_for_swap: None,
            tab_stops,
            scrollback_cap: SCROLLBACK_CAP_ROWS,
        }
    }

    pub fn columns(&self) -> usize { self.primary.cols }
    pub fn screen_lines(&self) -> usize { self.primary.rows }
    pub fn alt_screen(&self) -> bool { self.use_alt }
    pub fn app_cursor(&self) -> bool { self.app_cursor }
    pub fn bracketed_paste(&self) -> bool { self.bracketed_paste }
    pub fn scrollback(&self) -> &FlatStorage { &self.scrollback }
    pub fn cursor(&self) -> &Cursor { &self.active().cursor }

    pub fn active(&self) -> &ActiveGrid {
        if self.use_alt { &self.alt } else { &self.primary }
    }

    fn active_mut(&mut self) -> &mut ActiveGrid {
        if self.use_alt { &mut self.alt } else { &mut self.primary }
    }

    /// Push the primary grid's top row into scrollback. Called from
    /// `linefeed_in_active` when the cursor would move past the
    /// scroll region's bottom on the primary screen. Alt-screen
    /// scrolls are local — content never spills out.
    fn push_top_row_to_scrollback(&mut self) {
        if self.use_alt { return; }
        let cells = take_top_row(&mut self.primary);
        // Encode + push into FlatStorage. Build a Vec of (str, fg,
        // bg+style) tuples; FlatStorage borrows the str lifetime
        // only for the duration of push_row.
        let mut graphemes: Vec<String> = Vec::with_capacity(cells.len());
        let mut fgs: Vec<PackedColor> = Vec::with_capacity(cells.len());
        let mut bgs: Vec<BgAndStyle> = Vec::with_capacity(cells.len());
        for cell in &cells {
            if cell.flags.contains(CellFlags::WIDE_CHAR_SPACER) {
                // Right half of a wide char — already emitted with
                // the left half. Skip.
                continue;
            }
            let mut g = String::new();
            g.push(cell.c);
            for z in &cell.zerowidth {
                g.push(*z);
            }
            graphemes.push(g);
            fgs.push(color_to_packed(cell.fg));
            bgs.push(BgAndStyle {
                bg: color_to_packed(cell.bg),
                style: cellflags_to_style(cell.flags),
            });
        }
        let cells_iter = graphemes
            .iter()
            .zip(fgs.iter())
            .zip(bgs.iter())
            .map(|((g, fg), bs)| (g.as_str(), *fg, *bs));
        self.scrollback.push_row(cells_iter);
    }

    /// LF behavior: advance cursor.row by 1; if it would leave the
    /// scroll region's bottom, capture the top row into scrollback
    /// (primary only) and scroll the region up by 1.
    fn linefeed_in_active(&mut self) {
        let next_row = self.active().cursor.row + 1;
        if next_row > self.active().scroll_bottom {
            // Scroll the region up. On primary, the displaced top row
            // becomes scrollback. On alt, it's discarded.
            self.push_top_row_to_scrollback();
            self.active_mut().scroll_up_in_region(1);
            // Cursor stays at the scroll_bottom row.
        } else {
            self.active_mut().cursor.row = next_row;
        }
    }

    fn carriage_return_in_active(&mut self) {
        let a = self.active_mut();
        a.cursor.col = 0;
        a.cursor.wrap_pending = false;
    }

    /// Stamp the cursor's pen onto the cell under the cursor and
    /// advance. Handles wrap-pending, wide chars, and combining
    /// marks.
    fn write_char_at_cursor(&mut self, c: char) {
        // Combining mark: attach to the previous cell instead of
        // writing a new one. unicode-width crate would be ideal but
        // we approximate with a hard-coded check on the most common
        // ranges. Anything else gets a new cell (degrading slightly
        // but never wrong).
        if is_combining_mark(c) {
            let a = self.active_mut();
            // The "previous" cell sits at cursor.col - 1 if we're
            // past col 0, otherwise at the end of the row above.
            // For first-pass simplicity attach to current-col cell
            // even if cursor hasn't advanced (a base-then-combiner
            // call usually arrives in that order from the parser).
            let row = a.cursor.row.min(a.rows - 1);
            let col = if a.cursor.col == 0 {
                0
            } else {
                a.cursor.col - 1
            };
            if let Some(cell) = a
                .cells
                .get_mut(row)
                .and_then(|r| r.get_mut(col))
            {
                cell.zerowidth.push(c);
            }
            return;
        }

        // Wrap-pending — execute the deferred wrap before writing.
        let needs_wrap = {
            let a = self.active();
            a.cursor.wrap_pending && self.line_wrap
        };
        if needs_wrap {
            self.carriage_return_in_active();
            self.linefeed_in_active();
        } else if self.active().cursor.wrap_pending {
            // wrap_pending but line_wrap disabled — clear the flag
            // so we don't keep re-stamping the last column.
            self.active_mut().cursor.wrap_pending = false;
        }

        let wide = is_wide_char(c);
        let a = self.active_mut();
        let row = a.cursor.row.min(a.rows - 1);
        let col = a.cursor.col.min(a.cols - 1);

        let (fg, bg, mut flags) = (a.cursor.fg, a.cursor.bg, a.cursor.flags);
        if wide {
            flags.insert(CellFlags::WIDE_CHAR);
        }
        a.cells[row][col] = Cell {
            c,
            fg,
            bg,
            flags,
            zerowidth: Vec::new(),
        };
        if wide && col + 1 < a.cols {
            let mut spacer_flags = a.cursor.flags;
            spacer_flags.insert(CellFlags::WIDE_CHAR_SPACER);
            a.cells[row][col + 1] = Cell {
                c: ' ',
                fg,
                bg,
                flags: spacer_flags,
                zerowidth: Vec::new(),
            };
        }

        // Advance cursor. Stop at right edge — set wrap_pending
        // instead of moving past it. Wide chars advance by 2.
        let advance = if wide { 2 } else { 1 };
        let new_col = col + advance;
        if new_col >= a.cols {
            a.cursor.col = a.cols - 1;
            a.cursor.wrap_pending = true;
        } else {
            a.cursor.col = new_col;
            a.cursor.wrap_pending = false;
        }
    }
}

/* ------------------------------------------------------------------
   Handler implementation
   ------------------------------------------------------------------ */

impl Handler for FlatTerm {
    fn input(&mut self, c: char) {
        self.write_char_at_cursor(c);
    }

    fn carriage_return(&mut self) {
        self.carriage_return_in_active();
    }

    fn linefeed(&mut self) {
        self.linefeed_in_active();
    }

    fn newline(&mut self) {
        // NEL — CR then LF.
        self.carriage_return_in_active();
        self.linefeed_in_active();
    }

    fn backspace(&mut self) {
        let a = self.active_mut();
        if a.cursor.col > 0 {
            a.cursor.col -= 1;
        }
        a.cursor.wrap_pending = false;
    }

    fn bell(&mut self) {
        // Notification only — no grid mutation. Production code can
        // hook this for UI feedback (status bar pulse, etc.) via a
        // wrapper that observes calls; FlatTerm itself stays silent.
    }

    fn goto(&mut self, line: i32, col: usize) {
        let a = self.active_mut();
        let row = line.max(0) as usize;
        a.cursor.row = row.min(a.rows - 1);
        a.cursor.col = col.min(a.cols - 1);
        a.cursor.wrap_pending = false;
    }

    fn goto_line(&mut self, line: i32) {
        let a = self.active_mut();
        let row = line.max(0) as usize;
        a.cursor.row = row.min(a.rows - 1);
        a.cursor.wrap_pending = false;
    }

    fn goto_col(&mut self, col: usize) {
        let a = self.active_mut();
        a.cursor.col = col.min(a.cols - 1);
        a.cursor.wrap_pending = false;
    }

    fn move_up(&mut self, n: usize) {
        let a = self.active_mut();
        a.cursor.row = a.cursor.row.saturating_sub(n);
        a.cursor.wrap_pending = false;
    }

    fn move_down(&mut self, n: usize) {
        let a = self.active_mut();
        a.cursor.row = (a.cursor.row + n).min(a.rows - 1);
        a.cursor.wrap_pending = false;
    }

    fn move_forward(&mut self, n: usize) {
        let a = self.active_mut();
        a.cursor.col = (a.cursor.col + n).min(a.cols - 1);
        a.cursor.wrap_pending = false;
    }

    fn move_backward(&mut self, n: usize) {
        let a = self.active_mut();
        a.cursor.col = a.cursor.col.saturating_sub(n);
        a.cursor.wrap_pending = false;
    }

    fn move_up_and_cr(&mut self, n: usize) {
        self.move_up(n);
        self.carriage_return_in_active();
    }

    fn move_down_and_cr(&mut self, n: usize) {
        self.move_down(n);
        self.carriage_return_in_active();
    }

    fn save_cursor_position(&mut self) {
        let a = self.active_mut();
        a.saved_cursor = Some(SavedCursor {
            row: a.cursor.row,
            col: a.cursor.col,
            fg: a.cursor.fg,
            bg: a.cursor.bg,
            flags: a.cursor.flags,
        });
    }

    fn restore_cursor_position(&mut self) {
        let a = self.active_mut();
        if let Some(s) = a.saved_cursor.clone() {
            a.cursor.row = s.row.min(a.rows - 1);
            a.cursor.col = s.col.min(a.cols - 1);
            a.cursor.fg = s.fg;
            a.cursor.bg = s.bg;
            a.cursor.flags = s.flags;
            a.cursor.wrap_pending = false;
        }
    }

    fn reverse_index(&mut self) {
        // RI — move cursor up by 1, scrolling region DOWN if at top.
        let needs_scroll = {
            let a = self.active();
            a.cursor.row == a.scroll_top
        };
        if needs_scroll {
            self.active_mut().scroll_down_in_region(1);
        } else {
            let a = self.active_mut();
            if a.cursor.row > 0 { a.cursor.row -= 1; }
        }
    }

    fn put_tab(&mut self, count: u16) {
        // Matching alacritty: if a wrap is pending, a tab is treated
        // as a line break (do nothing here besides clearing the
        // wrap — the next input will trigger the wrap on its own).
        // Then, for each tab in `count`, stamp '\t' into the starting
        // cell (only if it currently holds the default space) and
        // walk the cursor to the next tab stop.
        if self.active().cursor.wrap_pending {
            self.active_mut().cursor.wrap_pending = false;
            return;
        }
        let mut left = count.max(1);
        while left > 0 {
            let cols = self.active().cols;
            let cur_col = self.active().cursor.col;
            if cur_col >= cols - 1 { break; }
            // Stamp '\t' in the cell under the cursor if it's blank.
            // Alacritty does this so the grid carries the tab sentinel
            // (used by selection / line-reflow logic). Without the
            // sentinel, parity tests against alacritty fail.
            {
                let a = self.active_mut();
                let row = a.cursor.row.min(a.rows - 1);
                let cell = &mut a.cells[row][cur_col];
                if cell.c == ' ' {
                    cell.c = '\t';
                }
            }
            // Advance to the next tab stop (or right edge).
            let mut next = cur_col + 1;
            while next + 1 < cols && !self.tab_stops.get(next).copied().unwrap_or(false) {
                next += 1;
            }
            self.active_mut().cursor.col = next.min(cols - 1);
            left -= 1;
        }
        self.active_mut().cursor.wrap_pending = false;
    }

    fn set_horizontal_tabstop(&mut self) {
        let col = self.active().cursor.col;
        if let Some(stop) = self.tab_stops.get_mut(col) {
            *stop = true;
        }
    }

    fn terminal_attribute(&mut self, attr: Attr) {
        let a = self.active_mut();
        let cur = &mut a.cursor;
        match attr {
            Attr::Reset => {
                cur.fg = Color::Named(NamedColor::Foreground);
                cur.bg = Color::Named(NamedColor::Background);
                cur.flags = CellFlags::default();
            }
            Attr::Foreground(c) => cur.fg = c,
            Attr::Background(c) => cur.bg = c,
            Attr::Bold => cur.flags.insert(CellFlags::BOLD),
            Attr::Dim => cur.flags.insert(CellFlags::DIM),
            Attr::Italic => cur.flags.insert(CellFlags::ITALIC),
            Attr::Underline
            | Attr::DoubleUnderline
            | Attr::Undercurl
            | Attr::DottedUnderline
            | Attr::DashedUnderline => {
                cur.flags.insert(CellFlags::UNDERLINE);
            }
            Attr::Reverse => cur.flags.insert(CellFlags::INVERSE),
            Attr::Hidden => cur.flags.insert(CellFlags::HIDDEN),
            Attr::Strike => cur.flags.insert(CellFlags::STRIKEOUT),
            Attr::CancelBold => cur.flags.remove(CellFlags::BOLD),
            Attr::CancelBoldDim => {
                cur.flags.remove(CellFlags::BOLD);
                cur.flags.remove(CellFlags::DIM);
            }
            Attr::CancelItalic => cur.flags.remove(CellFlags::ITALIC),
            Attr::CancelUnderline => cur.flags.remove(CellFlags::UNDERLINE),
            Attr::CancelBlink => {}
            Attr::CancelReverse => cur.flags.remove(CellFlags::INVERSE),
            Attr::CancelHidden => cur.flags.remove(CellFlags::HIDDEN),
            Attr::CancelStrike => cur.flags.remove(CellFlags::STRIKEOUT),
            // Underline color, blink-{slow,fast} — not visually
            // distinguished by our wire format. No-op preserves the
            // rest of the pen.
            _ => {}
        }
    }

    fn clear_line(&mut self, mode: LineClearMode) {
        let a = self.active_mut();
        let row = a.cursor.row.min(a.rows - 1);
        let col = a.cursor.col.min(a.cols - 1);
        let blank = a.blank_cell();
        match mode {
            LineClearMode::Right => {
                for c in col..a.cols {
                    a.cells[row][c] = blank.clone();
                }
            }
            LineClearMode::Left => {
                for c in 0..=col {
                    a.cells[row][c] = blank.clone();
                }
            }
            LineClearMode::All => {
                for c in 0..a.cols {
                    a.cells[row][c] = blank.clone();
                }
            }
        }
    }

    fn clear_screen(&mut self, mode: ClearMode) {
        match mode {
            ClearMode::Below => {
                let row = self.active().cursor.row;
                let col = self.active().cursor.col;
                let a = self.active_mut();
                let blank = a.blank_cell();
                for c in col..a.cols {
                    a.cells[row][c] = blank.clone();
                }
                for r in (row + 1)..a.rows {
                    for c in 0..a.cols {
                        a.cells[r][c] = blank.clone();
                    }
                }
            }
            ClearMode::Above => {
                let row = self.active().cursor.row;
                let col = self.active().cursor.col;
                let a = self.active_mut();
                let blank = a.blank_cell();
                for r in 0..row {
                    for c in 0..a.cols {
                        a.cells[r][c] = blank.clone();
                    }
                }
                for c in 0..=col {
                    a.cells[row][c] = blank.clone();
                }
            }
            ClearMode::All => {
                let a = self.active_mut();
                let rows = a.rows;
                a.clear_region(0, rows - 1);
            }
            ClearMode::Saved => {
                // Scrollback wipe. Reset the FlatStorage to an empty
                // state — cheaper than implementing FlatStorage::clear.
                self.scrollback = FlatStorage::with_capacity(self.scrollback_cap);
            }
        }
    }

    fn erase_chars(&mut self, n: usize) {
        let a = self.active_mut();
        let row = a.cursor.row.min(a.rows - 1);
        let col = a.cursor.col;
        let blank = a.blank_cell();
        for c in col..(col + n).min(a.cols) {
            a.cells[row][c] = blank.clone();
        }
    }

    fn delete_chars(&mut self, n: usize) {
        let a = self.active_mut();
        let row = a.cursor.row.min(a.rows - 1);
        let col = a.cursor.col;
        let n = n.min(a.cols.saturating_sub(col));
        let row_cells = &mut a.cells[row];
        for c in col..(a.cols - n) {
            row_cells[c] = row_cells[c + n].clone();
        }
        // Blank the tail.
        let blank = Cell {
            c: ' ',
            fg: a.cursor.fg,
            bg: a.cursor.bg,
            flags: CellFlags::default(),
            zerowidth: Vec::new(),
        };
        for c in (a.cols - n)..a.cols {
            a.cells[row][c] = blank.clone();
        }
    }

    fn insert_blank(&mut self, n: usize) {
        let a = self.active_mut();
        let row = a.cursor.row.min(a.rows - 1);
        let col = a.cursor.col;
        let n = n.min(a.cols.saturating_sub(col));
        // Shift right, dropping the rightmost n.
        let cols = a.cols;
        for c in (col + n..cols).rev() {
            a.cells[row][c] = a.cells[row][c - n].clone();
        }
        let blank = Cell {
            c: ' ',
            fg: a.cursor.fg,
            bg: a.cursor.bg,
            flags: CellFlags::default(),
            zerowidth: Vec::new(),
        };
        for c in col..(col + n) {
            a.cells[row][c] = blank.clone();
        }
    }

    fn insert_blank_lines(&mut self, n: usize) {
        let row = self.active().cursor.row;
        let a = self.active_mut();
        if row < a.scroll_top || row > a.scroll_bottom { return; }
        let old_top = a.scroll_top;
        a.scroll_top = row;
        a.scroll_down_in_region(n);
        a.scroll_top = old_top;
    }

    fn delete_lines(&mut self, n: usize) {
        let row = self.active().cursor.row;
        let a = self.active_mut();
        if row < a.scroll_top || row > a.scroll_bottom { return; }
        let old_top = a.scroll_top;
        a.scroll_top = row;
        a.scroll_up_in_region(n);
        a.scroll_top = old_top;
    }

    fn scroll_up(&mut self, n: usize) {
        // SU — content moves up. The top n rows of the scroll region
        // are evicted to scrollback (on primary) or discarded (alt).
        for _ in 0..n {
            self.push_top_row_to_scrollback();
            self.active_mut().scroll_up_in_region(1);
        }
    }

    fn scroll_down(&mut self, n: usize) {
        self.active_mut().scroll_down_in_region(n);
    }

    fn set_scrolling_region(&mut self, top: usize, bottom: Option<usize>) {
        let a = self.active_mut();
        let top = top.saturating_sub(1).min(a.rows - 1);
        let bottom = match bottom {
            Some(b) => b.saturating_sub(1).min(a.rows - 1),
            None => a.rows - 1,
        };
        if top < bottom {
            a.scroll_top = top;
            a.scroll_bottom = bottom;
        }
        // DECSTBM homes cursor to screen origin (0,0), NOT to the top
        // of the scroll region — that's only the behaviour with DECOM
        // (origin mode) enabled. Most shells run with DECOM off, and
        // alacritty matches the spec by going to (0,0) regardless.
        a.cursor.row = 0;
        a.cursor.col = 0;
        a.cursor.wrap_pending = false;
    }

    fn set_private_mode(&mut self, mode: PrivateMode) {
        if let PrivateMode::Named(n) = mode {
            match n {
                NamedPrivateMode::CursorKeys => self.app_cursor = true,
                NamedPrivateMode::BracketedPaste => self.bracketed_paste = true,
                NamedPrivateMode::LineWrap => self.line_wrap = true,
                NamedPrivateMode::SwapScreenAndSetRestoreCursor => {
                    self.enter_alt_screen();
                }
                _ => {}
            }
        }
    }

    fn unset_private_mode(&mut self, mode: PrivateMode) {
        if let PrivateMode::Named(n) = mode {
            match n {
                NamedPrivateMode::CursorKeys => self.app_cursor = false,
                NamedPrivateMode::BracketedPaste => self.bracketed_paste = false,
                NamedPrivateMode::LineWrap => self.line_wrap = false,
                NamedPrivateMode::SwapScreenAndSetRestoreCursor => {
                    self.exit_alt_screen();
                }
                _ => {}
            }
        }
    }

    fn set_keypad_application_mode(&mut self) {
        // Tracked alongside app_cursor by some callers, but DECPAM
        // is keypad-only; the Goonware wire format doesn't expose it
        // separately. No-op.
    }
    fn unset_keypad_application_mode(&mut self) {}

    fn reset_state(&mut self) {
        // RIS — full terminal reset. Re-create everything.
        let cols = self.primary.cols;
        let rows = self.primary.rows;
        *self = Self::new(cols, rows);
    }
}

impl FlatTerm {
    fn enter_alt_screen(&mut self) {
        if self.use_alt { return; }
        // Save primary cursor + attrs for the eventual restore.
        let cur = &self.primary.cursor;
        self.saved_cursor_for_swap = Some(SavedCursor {
            row: cur.row,
            col: cur.col,
            fg: cur.fg,
            bg: cur.bg,
            flags: cur.flags,
        });
        // Alt-screen always starts cleared.
        let rows = self.alt.rows;
        self.alt.clear_region(0, rows - 1);
        self.alt.cursor = Cursor::new_for(self.alt.cols, self.alt.rows);
        self.use_alt = true;
    }

    fn exit_alt_screen(&mut self) {
        if !self.use_alt { return; }
        self.use_alt = false;
        if let Some(s) = self.saved_cursor_for_swap.take() {
            let p = &mut self.primary;
            p.cursor.row = s.row.min(p.rows - 1);
            p.cursor.col = s.col.min(p.cols - 1);
            p.cursor.fg = s.fg;
            p.cursor.bg = s.bg;
            p.cursor.flags = s.flags;
            p.cursor.wrap_pending = false;
        }
    }
}

/* ------------------------------------------------------------------
   Helpers — char classification + Color packing.
   ------------------------------------------------------------------ */

/// Approximate combining-mark detector. Covers the most common
/// blocks (Combining Diacritical Marks, Arabic combining, Hebrew
/// niqqud, the Devanagari/Bengali/etc. Indic vowel signs that are
/// zero-width). A complete check would use the `unicode-width` crate
/// — punt on adding it as a dep until shell traffic actually needs it.
fn is_combining_mark(c: char) -> bool {
    matches!(
        c as u32,
        0x0300..=0x036F // Combining Diacritical Marks
            | 0x0483..=0x0489
            | 0x0591..=0x05BD
            | 0x05BF
            | 0x05C1..=0x05C2
            | 0x05C4..=0x05C5
            | 0x05C7
            | 0x0610..=0x061A
            | 0x064B..=0x065F
            | 0x0670
            | 0x06D6..=0x06DC
            | 0x06DF..=0x06E4
            | 0x06E7..=0x06E8
            | 0x06EA..=0x06ED
            | 0x0711
            | 0x0730..=0x074A
            | 0x200C..=0x200D // ZWJ / ZWNJ
            | 0xFE00..=0xFE0F // variation selectors
            | 0xE0100..=0xE01EF // language tags + variation selectors
    )
}

/// Approximate wide-char (East Asian Fullwidth/Wide + Emoji) check.
/// Same trade-off as above — covers the practical cases (CJK +
/// emoji) without pulling in unicode-width.
fn is_wide_char(c: char) -> bool {
    let v = c as u32;
    matches!(
        v,
        // CJK Unified Ideographs + Hangul + Hiragana + Katakana + ...
        0x1100..=0x115F     // Hangul Jamo
            | 0x2E80..=0x303E
            | 0x3041..=0x33FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xA000..=0xA4CF
            | 0xAC00..=0xD7A3 // Hangul Syllables
            | 0xF900..=0xFAFF
            | 0xFE30..=0xFE4F
            | 0xFF00..=0xFF60 // Fullwidth ASCII variants
            | 0xFFE0..=0xFFE6
            | 0x1F300..=0x1F9FF // Emoji + Misc Symbols + Pictographs
            | 0x1FA70..=0x1FAFF
            | 0x20000..=0x2FFFD
            | 0x30000..=0x3FFFD
    )
}

fn color_to_packed(c: Color) -> PackedColor {
    match c {
        Color::Named(NamedColor::Foreground)
        | Color::Named(NamedColor::Background) => PackedColor::DEFAULT,
        Color::Named(name) => PackedColor::named(name as u16),
        Color::Indexed(idx) => PackedColor::indexed(idx),
        Color::Spec(Rgb { r, g, b }) => PackedColor::rgb(r, g, b),
    }
}

fn cellflags_to_style(flags: CellFlags) -> PackedStyle {
    let mut bits = 0u8;
    if flags.contains(CellFlags::BOLD) { bits |= PackedStyle::BOLD; }
    if flags.contains(CellFlags::ITALIC) { bits |= PackedStyle::ITALIC; }
    if flags.contains(CellFlags::UNDERLINE) { bits |= PackedStyle::UNDERLINE; }
    if flags.contains(CellFlags::INVERSE) { bits |= PackedStyle::INVERSE; }
    if flags.contains(CellFlags::DIM) { bits |= PackedStyle::DIM; }
    if flags.contains(CellFlags::STRIKEOUT) { bits |= PackedStyle::STRIKEOUT; }
    PackedStyle(bits)
}

/* ------------------------------------------------------------------
   Tests — parity against alacritty's Term for the same byte stream.
   ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::event::{Event as AlacEvent, EventListener};
    use alacritty_terminal::grid::Dimensions;
    use alacritty_terminal::index::{Column, Line, Point};
    use alacritty_terminal::term::cell::{Cell as AlacCell, Flags as AlacFlags};
    use alacritty_terminal::term::{Config as TermConfig};
    use alacritty_terminal::vte::ansi::Processor;
    use alacritty_terminal::Term;

    #[derive(Clone)]
    struct NullProxy;
    impl EventListener for NullProxy {
        fn send_event(&self, _e: AlacEvent) {}
    }
    struct Dims(usize, usize);
    impl Dimensions for Dims {
        fn total_lines(&self) -> usize { self.1 }
        fn screen_lines(&self) -> usize { self.1 }
        fn columns(&self) -> usize { self.0 }
    }

    /// Drive both FlatTerm and alacritty's Term with the same bytes
    /// and compare their visible-cell projections row-by-row.
    /// "Projection" = the cell's (c, fg, bg, bold/italic/underline/
    /// inverse/dim/strikeout) tuple, modulo wide-char spacer skipping.
    fn assert_parity(bytes: &[u8], cols: usize, rows: usize) {
        let dims = Dims(cols.max(1), rows.max(1));
        let mut alac = Term::new(TermConfig::default(), &dims, NullProxy);
        let mut parser: Processor = Processor::new();
        parser.advance(&mut alac, bytes);

        let mut flat = FlatTerm::new(cols, rows);
        let mut flat_parser: Processor = Processor::new();
        flat_parser.advance(&mut flat, bytes);

        let f_active = flat.active();
        assert_eq!(
            f_active.rows(), rows,
            "row count drift (flat={}, expected={})",
            f_active.rows(), rows,
        );

        for r in 0..rows {
            let flat_row = f_active.row(r).expect("row in range");
            for c in 0..cols {
                let pt = Point::new(Line(r as i32), Column(c));
                let alac_cell: &AlacCell = &alac.grid()[pt];
                let flat_cell = &flat_row[c];

                // Compare base char first.
                assert_eq!(
                    flat_cell.c, alac_cell.c,
                    "char mismatch at ({r},{c}) for bytes {:?}",
                    String::from_utf8_lossy(bytes),
                );

                // Wide-char-spacer status must agree.
                let a_spacer = alac_cell.flags.contains(AlacFlags::WIDE_CHAR_SPACER);
                let f_spacer = flat_cell.flags.contains(CellFlags::WIDE_CHAR_SPACER);
                assert_eq!(
                    a_spacer, f_spacer,
                    "wide spacer mismatch at ({r},{c}) for bytes {:?}",
                    String::from_utf8_lossy(bytes),
                );
                if a_spacer { continue; }

                // Compare style flags.
                let a_bold = alac_cell.flags.contains(AlacFlags::BOLD);
                let f_bold = flat_cell.flags.contains(CellFlags::BOLD);
                let a_italic = alac_cell.flags.contains(AlacFlags::ITALIC);
                let f_italic = flat_cell.flags.contains(CellFlags::ITALIC);
                let a_under = alac_cell.flags.intersects(AlacFlags::ALL_UNDERLINES);
                let f_under = flat_cell.flags.contains(CellFlags::UNDERLINE);
                let a_inv = alac_cell.flags.contains(AlacFlags::INVERSE);
                let f_inv = flat_cell.flags.contains(CellFlags::INVERSE);
                let a_dim = alac_cell.flags.contains(AlacFlags::DIM);
                let f_dim = flat_cell.flags.contains(CellFlags::DIM);
                let a_strike = alac_cell.flags.contains(AlacFlags::STRIKEOUT);
                let f_strike = flat_cell.flags.contains(CellFlags::STRIKEOUT);
                assert_eq!(a_bold, f_bold, "bold ({r},{c})");
                assert_eq!(a_italic, f_italic, "italic ({r},{c})");
                assert_eq!(a_under, f_under, "underline ({r},{c})");
                assert_eq!(a_inv, f_inv, "inverse ({r},{c})");
                assert_eq!(a_dim, f_dim, "dim ({r},{c})");
                assert_eq!(a_strike, f_strike, "strikeout ({r},{c})");

                // Compare colors.
                assert_eq!(
                    flat_cell.fg, alac_cell.fg,
                    "fg mismatch at ({r},{c})"
                );
                assert_eq!(
                    flat_cell.bg, alac_cell.bg,
                    "bg mismatch at ({r},{c})"
                );
            }
        }
    }

    #[test]
    fn parity_plain_ascii() {
        assert_parity(b"hello\r\nworld", 20, 4);
    }

    #[test]
    fn parity_sgr_red_run() {
        assert_parity(b"ab\x1b[31mRED\x1b[0mz", 20, 2);
    }

    #[test]
    fn parity_cr_overstrike() {
        assert_parity(b"first line\rSECOND", 20, 2);
    }

    #[test]
    fn parity_erase_in_line_right() {
        assert_parity(b"keep this\x1b[Kremoved?", 30, 2);
    }

    #[test]
    fn parity_erase_in_line_all() {
        assert_parity(b"keep this\x1b[2K\rgone", 20, 2);
    }

    #[test]
    fn parity_clear_screen_all() {
        assert_parity(b"some content\r\nmore\x1b[2J", 20, 4);
    }

    #[test]
    fn parity_bold_italic_underline_dim() {
        assert_parity(
            b"\x1b[1mB\x1b[2mD\x1b[3mI\x1b[4mU\x1b[0m end",
            30,
            2,
        );
    }

    #[test]
    fn parity_truecolor() {
        assert_parity(
            b"\x1b[38;2;255;100;50mwarm\x1b[0m cool",
            20,
            2,
        );
    }

    #[test]
    fn parity_inverse() {
        assert_parity(b"normal\x1b[7minv\x1b[27mback", 25, 2);
    }

    #[test]
    fn parity_cursor_movement() {
        // Goto + write — CSI H is cursor home; CSI <row>;<col> H moves.
        assert_parity(b"\x1b[2;3HXY", 10, 4);
    }

    #[test]
    fn parity_backspace_overwrites() {
        assert_parity(b"abc\x08X", 10, 2);
    }

    #[test]
    fn parity_linefeed_at_bottom_scrolls() {
        // Drive past the bottom — content should scroll on both
        // backends. (Scrollback semantics differ — we just compare
        // the visible grid.)
        let mut bytes = Vec::new();
        for i in 0..10 {
            bytes.extend_from_slice(format!("row{i}\r\n").as_bytes());
        }
        assert_parity(&bytes, 10, 5);
    }

    #[test]
    fn parity_alt_screen_swap_and_back() {
        // Enter alt screen, write, exit — primary content should be
        // intact (saved cursor restored). Alt-screen specific state
        // isn't visible after the exit.
        let bytes = b"primary\r\n\x1b[?1049hINSIDE-ALT\x1b[?1049lback";
        assert_parity(bytes, 20, 4);
    }

    #[test]
    fn parity_set_scroll_region_decstbm() {
        // CSI 2;3 r — scroll region rows 2-3. Cursor homes to row 2.
        assert_parity(b"\x1b[2;3rabc\r\ndef\r\nghi", 10, 5);
    }

    #[test]
    fn parity_save_restore_cursor() {
        // ESC 7 saves, ESC 8 restores.
        assert_parity(b"abc\x1b7XYZ\x1b8def", 20, 2);
    }

    #[test]
    fn parity_tab_stops() {
        assert_parity(b"a\tb\tc\tend", 30, 2);
    }

    /* --- Module-level structural tests (not vs alacritty) --- */

    #[test]
    fn input_writes_at_cursor_and_advances() {
        let mut t = FlatTerm::new(10, 3);
        t.input('h');
        t.input('i');
        let row = t.active().row(0).unwrap();
        assert_eq!(row[0].c, 'h');
        assert_eq!(row[1].c, 'i');
        assert_eq!(t.active().cursor.col, 2);
        assert!(!t.active().cursor.wrap_pending);
    }

    #[test]
    fn input_at_right_edge_defers_wrap() {
        let mut t = FlatTerm::new(3, 2);
        t.input('a');
        t.input('b');
        t.input('c');
        // Cursor stays at col 2 with wrap_pending set; the cell is
        // already written at col 2.
        assert_eq!(t.active().cursor.col, 2);
        assert!(t.active().cursor.wrap_pending);
        let row0 = t.active().row(0).unwrap();
        assert_eq!(row0[2].c, 'c');
        // Next input wraps before writing.
        t.input('d');
        let row1 = t.active().row(1).unwrap();
        assert_eq!(row1[0].c, 'd');
        assert_eq!(t.active().cursor.row, 1);
        assert_eq!(t.active().cursor.col, 1);
    }

    #[test]
    fn alt_screen_swap_preserves_primary() {
        let mut t = FlatTerm::new(10, 3);
        t.input('A');
        t.input('B');
        let mut parser: Processor = Processor::new();
        parser.advance(&mut t, b"\x1b[?1049h"); // enter alt
        assert!(t.use_alt);
        t.input('X');
        // Switch back; primary should still have "AB" at row 0.
        let mut p2: Processor = Processor::new();
        p2.advance(&mut t, b"\x1b[?1049l");
        assert!(!t.use_alt);
        let row = t.active().row(0).unwrap();
        assert_eq!(row[0].c, 'A');
        assert_eq!(row[1].c, 'B');
    }

    #[test]
    fn scroll_evicts_top_row_into_scrollback() {
        let mut t = FlatTerm::new(5, 2);
        let mut parser: Processor = Processor::new();
        parser.advance(&mut t, b"aaaaa\r\nbbbbb\r\nccccc");
        // Cap is 2 rows; first "aaaaa" should now live in scrollback.
        assert_eq!(t.scrollback.row_count(), 1);
        let evicted = t.scrollback.row(0).unwrap();
        assert!(evicted.starts_with("aaaaa"));
    }
}
