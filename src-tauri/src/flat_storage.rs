//! Warp-style flat-storage grid.
//!
//! A space-efficient grid optimized for terminal scrollback. Supports
//! O(1) random-access reads of any row, append-only writes at the
//! tail, and bounded scrollback with FIFO truncation. Does NOT
//! support Insert at arbitrary positions — terminal scrollback
//! doesn't need it, and supporting it would force either a B-tree
//! or O(N) shifts that defeat the point.
//!
//! Layout (mirrors Warp's `crates/warp_terminal/src/model/grid/flat_storage/mod.rs`):
//!
//!   * `text`              — flat `String` containing every row's
//!                           characters concatenated. Row N starts at
//!                           `row_index[N]` and ends at `row_index[N+1]`.
//!   * `row_index`         — `Vec<usize>` with `rows+1` entries; the
//!                           last entry is `text.len()`. Lets random-
//!                           access lookups be a slice operation.
//!   * `fg_color_map`      — interval map: ranges of byte indices
//!                           in `text` carrying a foreground color.
//!   * `bg_and_style_map`  — interval map: ranges of byte indices
//!                           carrying a packed background + style
//!                           byte (bold/italic/underline/inverse/dim/strike).
//!   * `max_rows`          — scrollback cap; once exceeded, oldest
//!                           rows are truncated from the front.
//!   * `truncated_rows`    — how many rows have been dropped from
//!                           the front since creation. Lets consumers
//!                           map their stable row indices through.
//!   * `end_of_prompt_marker` — optional row index where the most
//!                           recent OSC 133 B marker landed. Used by
//!                           the block segmenter to know where the
//!                           current command's output starts.
//!
//! This module is data-only — it deliberately doesn't know about
//! ANSI parsing, cursor handling, or modes. Higher layers (a future
//! VTE handler) feed it rows.

// Phase 4 is in-progress: this module is built and tested, but the
// VTE wiring that drives it hasn't landed yet, so many helpers look
// unused to the borrow checker. Suppress globally rather than dotting
// the file with #[allow(dead_code)] per item.
#![allow(dead_code)]

use std::ops::Range;

/// Packed color encoded as a tagged `u32`. The top two bits select the
/// variant; the lower 30 carry the payload.
///
///   0x0000_0000                                  → DEFAULT
///   0x4000_0000 | u16_discriminant               → Named (alacritty's
///                                                  NamedColor as u16)
///   0x8000_0000 | u8_index                       → Indexed (256-color)
///   0xC000_0000 | (R<<16 | G<<8 | B)             → Rgb truecolor
///
/// Named carries a full u16 because alacritty's `NamedColor` is
/// `#[repr(u16)]` with discriminants in two ranges (0..=15 for the
/// 16 ANSI base colors, 256+ for Foreground/Background/Cursor/Dim*).
/// Truncating to u8 here would collide Black (0) with Foreground (256).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PackedColor(pub u32);

const TAG_MASK: u32 = 0xC000_0000;
const TAG_NAMED: u32 = 0x4000_0000;
const TAG_INDEXED: u32 = 0x8000_0000;
const TAG_RGB: u32 = 0xC000_0000;
const PAYLOAD_MASK: u32 = !TAG_MASK;

impl PackedColor {
    pub const DEFAULT: Self = Self(0);

    /// Named color from its raw alacritty `NamedColor as u16`
    /// discriminant. The conversion preserves all 65k possible
    /// discriminants — `NamedColor::Foreground` (256) and friends
    /// no longer alias the 0..=15 ANSI base colors.
    pub fn named(discriminant: u16) -> Self {
        Self(TAG_NAMED | u32::from(discriminant))
    }

    pub fn indexed(idx: u8) -> Self {
        Self(TAG_INDEXED | u32::from(idx))
    }

    pub fn rgb(r: u8, g: u8, b: u8) -> Self {
        let payload =
            (u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b);
        Self(TAG_RGB | payload)
    }

    /// True iff `self` is `DEFAULT`. Used by the interval map to fold
    /// adjacent default-color runs (the dominant case for shell
    /// prompts — nothing colored, no span entries to track).
    pub fn is_default(self) -> bool {
        self.0 == 0
    }

    /// Classified view used by consumers that need to map the packed
    /// encoding back to a richer color representation (e.g., CSS
    /// strings for the wire format).
    pub fn classify(self) -> PackedColorKind {
        if self.0 == 0 {
            return PackedColorKind::Default;
        }
        let payload = self.0 & PAYLOAD_MASK;
        match self.0 & TAG_MASK {
            TAG_NAMED => PackedColorKind::Named(payload as u16),
            TAG_INDEXED => PackedColorKind::Indexed(payload as u8),
            TAG_RGB => {
                let r = ((payload >> 16) & 0xff) as u8;
                let g = ((payload >> 8) & 0xff) as u8;
                let b = (payload & 0xff) as u8;
                PackedColorKind::Rgb(r, g, b)
            }
            _ => PackedColorKind::Default,
        }
    }
}

/// Decoded view of a `PackedColor`. The `Named` variant carries the
/// full u16 discriminant from alacritty's `NamedColor` so callers can
/// map back through their own enum table without `flat_storage` taking
/// an alacritty dependency.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackedColorKind {
    Default,
    Named(u16),
    Indexed(u8),
    Rgb(u8, u8, u8),
}

/// Style bits packed into a single byte. Layout — order matters
/// because the bytes are persisted to interval maps in this shape:
///
///   bit 0 — bold
///   bit 1 — italic
///   bit 2 — underline
///   bit 3 — inverse
///   bit 4 — dim
///   bit 5 — strikeout
///   bits 6-7 — reserved
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Style(pub u8);

impl Style {
    pub const BOLD: u8 = 1 << 0;
    pub const ITALIC: u8 = 1 << 1;
    pub const UNDERLINE: u8 = 1 << 2;
    pub const INVERSE: u8 = 1 << 3;
    pub const DIM: u8 = 1 << 4;
    pub const STRIKEOUT: u8 = 1 << 5;

    pub fn bold(self) -> bool { self.0 & Self::BOLD != 0 }
    pub fn italic(self) -> bool { self.0 & Self::ITALIC != 0 }
    pub fn underline(self) -> bool { self.0 & Self::UNDERLINE != 0 }
    pub fn inverse(self) -> bool { self.0 & Self::INVERSE != 0 }
    pub fn dim(self) -> bool { self.0 & Self::DIM != 0 }
    pub fn strikeout(self) -> bool { self.0 & Self::STRIKEOUT != 0 }
}

/// Packed background color + style bits. Co-located in the same
/// interval map because they change together for the typical SGR
/// sequence (the parser sets bg/style as one unit per attribute
/// run, so adjacent cells share both values; tracking them in one
/// map roughly halves the interval entry count).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BgAndStyle {
    pub bg: PackedColor,
    pub style: Style,
}

impl BgAndStyle {
    pub fn is_default(self) -> bool {
        self.bg.is_default() && self.style.0 == 0
    }
}

/// Interval map keyed by byte offsets into `FlatStorage::text`.
/// Stored as a parallel `Vec<usize>` of starts + `Vec<V>` of values;
/// the run at index `i` covers `[starts[i] .. starts[i+1])`. The
/// last entry's value extends to the end of `text`.
///
/// Adjacent runs with equal values are merged on insert. The
/// special value `V::default()` is treated as "no record" — we
/// don't allocate entries for default runs, which is the dominant
/// case for ordinary shell prompts.
#[derive(Debug, Default, Clone)]
pub struct IntervalMap<V: Clone + PartialEq + Default> {
    starts: Vec<usize>,
    values: Vec<V>,
}

impl<V: Clone + PartialEq + Default> IntervalMap<V> {
    pub fn new() -> Self {
        Self { starts: Vec::new(), values: Vec::new() }
    }

    pub fn is_empty(&self) -> bool {
        self.starts.is_empty()
    }

    pub fn len(&self) -> usize {
        self.starts.len()
    }

    /// Append a run `[start .. end)` carrying `value`. Callers must
    /// pass monotonically increasing `start`s — the map is built
    /// strictly forward as the flat buffer grows.
    ///
    /// Compaction rules:
    ///   * A run with `value == V::default()` is dropped iff the map
    ///     is still empty (leading default runs leave no record;
    ///     `value_at` falls back to default for uncovered offsets).
    ///   * If the previous run's value equals this one, the new run
    ///     is coalesced into it — no new entry is recorded.
    ///   * If the previous run's value differs (including a non-
    ///     default → default transition), a new entry is appended.
    ///     The transition entry is REQUIRED — without it, `value_at`
    ///     for offsets inside the default tail would incorrectly
    ///     return the non-default predecessor's value.
    pub fn push_run(&mut self, start: usize, end: usize, value: V) {
        debug_assert!(end >= start);
        if start == end { return; }
        if self.values.is_empty() && value == V::default() {
            // Leading default region — no entry needed.
            return;
        }
        if let Some(last_value) = self.values.last() {
            if *last_value == value {
                // Adjacent equal runs fold into the prior entry.
                return;
            }
        }
        self.starts.push(start);
        self.values.push(value);
    }

    /// Read the value covering byte offset `pos`. Returns
    /// `V::default()` for any offset not covered by an explicit run.
    pub fn value_at(&self, pos: usize) -> V {
        // Binary search for the rightmost start ≤ pos.
        match self.starts.binary_search(&pos) {
            Ok(idx) => self.values[idx].clone(),
            Err(0) => V::default(),
            Err(idx) => self.values[idx - 1].clone(),
        }
    }

    /// Shift the buffer left by `cut` bytes. Entries whose runs fully
    /// fall in the dropped region are removed. The entry whose run
    /// straddles the cut (started before, extends past) is promoted
    /// to start = 0 — its style still applies to the surviving bytes.
    /// Remaining entries have their starts shifted down by `cut`.
    pub fn shift_left(&mut self, cut: usize) {
        if cut == 0 || self.starts.is_empty() { return; }
        // Index of the first entry whose start is ≥ cut. `None` means
        // every entry started before the cut — the last one straddles
        // (its tail extends to the end of the buffer, which is past
        // the cut by precondition).
        let first_keep_opt = self.starts.iter().position(|&s| s >= cut);
        let (drain_count, promote_first) = match first_keep_opt {
            Some(idx) if idx > 0 => (idx - 1, true),
            Some(_) => (0, false),
            None => (self.starts.len() - 1, true),
        };
        self.starts.drain(0..drain_count);
        self.values.drain(0..drain_count);
        if promote_first {
            self.starts[0] = 0;
            for s in &mut self.starts[1..] {
                *s -= cut;
            }
        } else {
            for s in &mut self.starts {
                *s -= cut;
            }
        }
    }

    /// Iterate (start, value) for diagnostics + tests.
    pub fn iter(&self) -> impl Iterator<Item = (usize, &V)> {
        self.starts.iter().copied().zip(self.values.iter())
    }
}

/// The flat grid itself. Construct with `with_capacity` to pre-allocate
/// the row index; `text` grows on demand.
#[derive(Debug, Clone)]
pub struct FlatStorage {
    text: String,
    /// `rows+1` byte offsets. `row_index[i] .. row_index[i+1]` is the
    /// byte range covering row `i`.
    row_index: Vec<usize>,
    fg_color_map: IntervalMap<PackedColor>,
    bg_and_style_map: IntervalMap<BgAndStyle>,
    /// Soft cap on the number of rows kept in memory. When `push_row`
    /// would exceed this, the oldest row is evicted (text + row_index
    /// shifted, interval maps `shift_left`'d).
    max_rows: usize,
    /// Cumulative count of rows evicted from the front since
    /// creation. Lets external row indices be translated through.
    truncated_rows: u64,
    /// Optional row index (after applying `truncated_rows` offset)
    /// where the most recent OSC 133 B (end-of-prompt) marker fell.
    /// `None` until set.
    end_of_prompt_marker: Option<u64>,
}

impl FlatStorage {
    /// Construct an empty grid with `max_rows` scrollback cap. The cap
    /// and the initial Vec capacity are decoupled — callers can pass
    /// `usize::MAX` for "unbounded scrollback" without trying to
    /// pre-allocate a usize::MAX-sized Vec. Actual storage grows
    /// dynamically as rows are pushed.
    pub fn with_capacity(max_rows: usize) -> Self {
        // Cap the initial Vec allocation. The row index grows on demand
        // via the usual amortized doubling — this is just a hint to
        // avoid the first few reallocations.
        let initial_capacity = max_rows.saturating_add(1).min(4096);
        let mut row_index = Vec::with_capacity(initial_capacity);
        row_index.push(0);
        Self {
            text: String::new(),
            row_index,
            fg_color_map: IntervalMap::new(),
            bg_and_style_map: IntervalMap::new(),
            max_rows: max_rows.max(1),
            truncated_rows: 0,
            end_of_prompt_marker: None,
        }
    }

    /// Number of rows currently in memory (excludes truncated).
    pub fn row_count(&self) -> usize {
        self.row_index.len().saturating_sub(1)
    }

    /// Total rows ever pushed (including ones since evicted).
    pub fn total_rows(&self) -> u64 {
        self.truncated_rows + self.row_count() as u64
    }

    pub fn truncated_rows(&self) -> u64 {
        self.truncated_rows
    }

    pub fn end_of_prompt_marker(&self) -> Option<u64> {
        self.end_of_prompt_marker
    }

    /// Mark the current tail row as the end of the most recent
    /// prompt. Stores the global row index (truncated_rows-adjusted)
    /// so the marker survives eviction without dangling.
    pub fn mark_end_of_prompt(&mut self) {
        self.end_of_prompt_marker = Some(self.total_rows());
    }

    /// Append a row. `cells` is an iterator of `(grapheme, fg, bg_and_style)`
    /// in display order. The grapheme can be a multi-byte UTF-8 cluster
    /// (an emoji, a CJK char, an ASCII letter); the storage doesn't
    /// distinguish cell widths — that's the caller's concern.
    pub fn push_row<'a, I>(&mut self, cells: I)
    where
        I: IntoIterator<Item = (&'a str, PackedColor, BgAndStyle)>,
    {
        let row_start = self.text.len();
        for (grapheme, fg, bg_style) in cells {
            let cell_start = self.text.len();
            self.text.push_str(grapheme);
            let cell_end = self.text.len();
            self.fg_color_map.push_run(cell_start, cell_end, fg);
            self.bg_and_style_map
                .push_run(cell_start, cell_end, bg_style);
        }
        let row_end = self.text.len();
        // Update the sentinel — the last entry in row_index always
        // points at the end of the text buffer.
        self.row_index.push(row_end);
        let _ = row_start;
        if self.row_count() > self.max_rows {
            self.truncate_front_to(self.max_rows);
        }
    }

    /// Read a row as a string slice + the interval-map records that
    /// cover it. Returns `None` for indices outside `[0 .. row_count())`.
    pub fn row(&self, idx: usize) -> Option<&str> {
        if idx >= self.row_count() { return None; }
        let start = self.row_index[idx];
        let end = self.row_index[idx + 1];
        Some(&self.text[start..end])
    }

    /// Byte range of row `idx` in the flat text buffer.
    pub fn row_byte_range(&self, idx: usize) -> Option<Range<usize>> {
        if idx >= self.row_count() { return None; }
        Some(self.row_index[idx]..self.row_index[idx + 1])
    }

    /// Foreground color at a given byte offset in the flat text.
    pub fn fg_at(&self, byte_offset: usize) -> PackedColor {
        self.fg_color_map.value_at(byte_offset)
    }

    /// Combined background + style at a given byte offset.
    pub fn bg_and_style_at(&self, byte_offset: usize) -> BgAndStyle {
        self.bg_and_style_map.value_at(byte_offset)
    }

    /// Evict the front until at most `keep` rows remain. Maintains
    /// the interval maps + truncated_rows counter so external
    /// indexing stays coherent.
    fn truncate_front_to(&mut self, keep: usize) {
        let total = self.row_count();
        if total <= keep { return; }
        let drop_count = total - keep;
        let cut_byte = self.row_index[drop_count];
        // Drop dropped rows from row_index and shift the remainder.
        self.row_index.drain(0..drop_count);
        for offset in &mut self.row_index {
            *offset -= cut_byte;
        }
        // Cut text in place. drain is O(N) once but happens rarely
        // (only when scrollback caps).
        self.text.drain(0..cut_byte);
        self.fg_color_map.shift_left(cut_byte);
        self.bg_and_style_map.shift_left(cut_byte);
        self.truncated_rows += drop_count as u64;
        // If the prompt marker was in the evicted region, drop it.
        if let Some(marker) = self.end_of_prompt_marker {
            if marker < self.truncated_rows {
                self.end_of_prompt_marker = None;
            }
        }
    }
}

/// Adapter — build a FlatStorage from a live `alacritty_terminal::Term`.
///
/// This is the "bridge" step that lets the new storage layer coexist
/// with the legacy alacritty pipeline. alacritty still owns the parser
/// + cursor + modes; we just walk its grid once into a flat shape.
///
/// Useful for:
///   * Validating FlatStorage's data design against real terminal
///     output (round-trip: bytes → alacritty Term → FlatStorage → row
///     read should match `snapshot_grid`).
///   * Replacing `snapshot_transcript` incrementally — we can produce
///     a FlatStorage and serialise from there.
///
/// Not the final shape — once the FlatStorage parser pipeline lands,
/// the alacritty Term goes away entirely and this adapter retires.
pub mod alac_adapter {
    use super::{BgAndStyle, FlatStorage, PackedColor, Style};
    use alacritty_terminal::event::EventListener;
    use alacritty_terminal::grid::Dimensions;
    use alacritty_terminal::index::{Column, Line, Point};
    use alacritty_terminal::term::cell::{Cell, Flags};
    use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};
    use alacritty_terminal::Term;

    /// Walk a `Term`'s visible grid and produce a `FlatStorage`. The
    /// resulting storage has `term.screen_lines()` rows; each row's
    /// text is the concatenation of the row's cells' grapheme content
    /// (skipping WIDE_CHAR_SPACER cells, which are placeholders for
    /// the right half of CJK / wide glyphs).
    pub fn from_alacritty_term<E: EventListener>(term: &Term<E>) -> FlatStorage {
        let cols = term.columns();
        let rows = term.screen_lines();
        let mut out = FlatStorage::with_capacity(rows.max(1));

        for row_idx in 0..rows {
            let cells_iter = (0..cols).filter_map(|col_idx| {
                let point = Point::new(Line(row_idx as i32), Column(col_idx));
                let cell: &Cell = &term.grid()[point];
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    return None;
                }
                Some(cell_to_packed(cell))
            });
            // Materialise per row because push_row borrows the
            // grapheme strings for the duration of the call.
            let rows_buf: Vec<(String, PackedColor, BgAndStyle)> =
                cells_iter.collect();
            out.push_row(rows_buf.iter().map(|(s, fg, bs)| {
                (s.as_str(), *fg, *bs)
            }));
        }
        out
    }

    /// Translate one alacritty `Cell` into the packed FlatStorage
    /// shape. Returns the cell's grapheme (base char + any zero-width
    /// combining marks) as an owned String so the caller can stash
    /// per-row buffers and lend `&str` to `push_row`.
    fn cell_to_packed(cell: &Cell) -> (String, PackedColor, BgAndStyle) {
        let mut grapheme = String::new();
        grapheme.push(cell.c);
        if let Some(zw) = cell.zerowidth() {
            for ch in zw {
                grapheme.push(*ch);
            }
        }
        let fg = color_to_packed(cell.fg);
        let bg = color_to_packed(cell.bg);
        let mut style_bits = 0u8;
        if cell.flags.contains(Flags::BOLD) { style_bits |= Style::BOLD; }
        if cell.flags.contains(Flags::ITALIC) { style_bits |= Style::ITALIC; }
        if cell.flags.intersects(Flags::ALL_UNDERLINES) { style_bits |= Style::UNDERLINE; }
        if cell.flags.contains(Flags::INVERSE) { style_bits |= Style::INVERSE; }
        if cell.flags.contains(Flags::DIM) { style_bits |= Style::DIM; }
        if cell.flags.contains(Flags::STRIKEOUT) { style_bits |= Style::STRIKEOUT; }
        let bg_and_style = BgAndStyle { bg, style: Style(style_bits) };
        (grapheme, fg, bg_and_style)
    }

    /// Translate alacritty's color enum into the packed encoding.
    /// `Foreground` / `Background` named colors collapse to DEFAULT
    /// — they're the "use whatever the renderer's default is"
    /// placeholders, which is exactly what DEFAULT signals.
    ///
    /// All other Named variants pass through with their full u16
    /// discriminant. That's important because `NamedColor` is
    /// `#[repr(u16)]` with a gap between the basic 16 (0..=15) and
    /// the special set (256+) — truncating to u8 would alias them.
    fn color_to_packed(c: Color) -> PackedColor {
        match c {
            Color::Named(NamedColor::Foreground)
            | Color::Named(NamedColor::Background) => PackedColor::DEFAULT,
            Color::Named(name) => PackedColor::named(name as u16),
            Color::Indexed(idx) => PackedColor::indexed(idx),
            Color::Spec(Rgb { r, g, b }) => PackedColor::rgb(r, g, b),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Convenience: push every char of `s` as its own ASCII cell with
    /// default attributes. Holds the source string for the duration of
    /// the call so the iterator-yielded `&str` slices outlive the push.
    fn push_ascii(g: &mut FlatStorage, s: &str) {
        // Build a Vec of (start, end) byte ranges per char, then
        // borrow back into `s` when pushing — no allocation tricks.
        let mut ranges: Vec<(usize, usize)> = Vec::with_capacity(s.len());
        let mut byte = 0;
        for ch in s.chars() {
            let next = byte + ch.len_utf8();
            ranges.push((byte, next));
            byte = next;
        }
        let cells = ranges.iter().map(|(a, b)| {
            (&s[*a..*b], PackedColor::DEFAULT, BgAndStyle::default())
        });
        g.push_row(cells);
    }

    #[test]
    fn push_and_read_back_a_row() {
        let mut g = FlatStorage::with_capacity(10);
        push_ascii(&mut g, "hi");
        assert_eq!(g.row(0), Some("hi"));
        assert_eq!(g.row_count(), 1);
        assert_eq!(g.total_rows(), 1);
        assert_eq!(g.truncated_rows(), 0);
    }

    #[test]
    fn multi_row_indexing_is_independent() {
        let mut g = FlatStorage::with_capacity(10);
        push_ascii(&mut g, "first");
        push_ascii(&mut g, "second");
        push_ascii(&mut g, "third");
        assert_eq!(g.row(0), Some("first"));
        assert_eq!(g.row(1), Some("second"));
        assert_eq!(g.row(2), Some("third"));
        assert_eq!(g.row(3), None);
        assert_eq!(g.row_count(), 3);
    }

    #[test]
    fn interval_map_coalesces_adjacent_equal_values() {
        let mut m: IntervalMap<PackedColor> = IntervalMap::new();
        m.push_run(0, 3, PackedColor::named(2));
        m.push_run(3, 6, PackedColor::named(2));
        assert_eq!(m.len(), 1, "adjacent equal runs should fold");
        assert_eq!(m.value_at(0), PackedColor::named(2));
        assert_eq!(m.value_at(5), PackedColor::named(2));
    }

    #[test]
    fn interval_map_skips_default_runs() {
        let mut m: IntervalMap<PackedColor> = IntervalMap::new();
        m.push_run(0, 3, PackedColor::DEFAULT);
        m.push_run(3, 6, PackedColor::named(2));
        assert_eq!(m.len(), 1);
        assert_eq!(m.value_at(0), PackedColor::DEFAULT);
        assert_eq!(m.value_at(3), PackedColor::named(2));
    }

    #[test]
    fn interval_map_value_at_uses_rightmost_le() {
        let mut m: IntervalMap<PackedColor> = IntervalMap::new();
        m.push_run(0, 3, PackedColor::named(1));
        m.push_run(3, 6, PackedColor::named(2));
        m.push_run(6, 9, PackedColor::named(3));
        assert_eq!(m.value_at(0), PackedColor::named(1));
        assert_eq!(m.value_at(2), PackedColor::named(1));
        assert_eq!(m.value_at(3), PackedColor::named(2));
        assert_eq!(m.value_at(5), PackedColor::named(2));
        assert_eq!(m.value_at(6), PackedColor::named(3));
    }

    #[test]
    fn interval_map_shift_left_promotes_straddling_entry() {
        let mut m: IntervalMap<PackedColor> = IntervalMap::new();
        m.push_run(0, 3, PackedColor::named(1));
        m.push_run(3, 6, PackedColor::named(2));
        m.push_run(6, 9, PackedColor::named(3));
        m.shift_left(4);
        // Entry (0,3,c1) fully evicted. Entry (3,6,c2) straddles cut —
        // promoted to start=0 because its tail (bytes 4,5 → new 0,1)
        // survives. Entry (6,9,c3) shifted to (2,_,c3).
        let collected: Vec<_> = m.iter().map(|(s, v)| (s, *v)).collect();
        assert_eq!(collected.len(), 2);
        assert_eq!(collected[0], (0, PackedColor::named(2)));
        assert_eq!(collected[1], (2, PackedColor::named(3)));
        // value_at across the surviving region returns the right
        // attribute for the byte that originally carried it.
        assert_eq!(m.value_at(0), PackedColor::named(2));
        assert_eq!(m.value_at(1), PackedColor::named(2));
        assert_eq!(m.value_at(2), PackedColor::named(3));
    }

    #[test]
    fn interval_map_shift_left_clean_drop() {
        let mut m: IntervalMap<PackedColor> = IntervalMap::new();
        m.push_run(4, 6, PackedColor::named(1));
        m.push_run(6, 9, PackedColor::named(2));
        // cut=4 aligns with the first entry's start → no straddle,
        // entries simply shift down by cut.
        m.shift_left(4);
        let collected: Vec<_> = m.iter().map(|(s, v)| (s, *v)).collect();
        assert_eq!(collected, vec![(0, PackedColor::named(1)), (2, PackedColor::named(2))]);
    }

    #[test]
    fn push_run_records_default_terminator_after_non_default() {
        // Tests the fix for the lookup-bug: a non-default run followed
        // by a default run must record the default transition, or
        // value_at past the non-default boundary still returns the
        // non-default value.
        let mut m: IntervalMap<PackedColor> = IntervalMap::new();
        m.push_run(0, 3, PackedColor::named(2));
        m.push_run(3, 6, PackedColor::DEFAULT);
        assert_eq!(m.len(), 2);
        assert_eq!(m.value_at(0), PackedColor::named(2));
        assert_eq!(m.value_at(2), PackedColor::named(2));
        assert_eq!(m.value_at(3), PackedColor::DEFAULT);
        assert_eq!(m.value_at(5), PackedColor::DEFAULT);
    }

    #[test]
    fn scrollback_cap_evicts_oldest_rows() {
        let mut g = FlatStorage::with_capacity(2);
        for line in ["aaa", "bbb", "ccc", "ddd"] {
            push_ascii(&mut g, line);
        }
        assert_eq!(g.row_count(), 2);
        assert_eq!(g.row(0), Some("ccc"));
        assert_eq!(g.row(1), Some("ddd"));
        assert_eq!(g.truncated_rows(), 2);
        assert_eq!(g.total_rows(), 4);
    }

    #[test]
    fn end_of_prompt_marker_survives_some_eviction() {
        let mut g = FlatStorage::with_capacity(2);
        push_ascii(&mut g, "prompt");
        g.mark_end_of_prompt();
        let marker = g.end_of_prompt_marker().unwrap();
        assert_eq!(marker, 1);
        push_ascii(&mut g, "out1");
        assert_eq!(g.end_of_prompt_marker(), Some(1));
        // Cap is 2; pushing another row evicts "prompt" (truncated
        // count -> 1). Marker (1) still >= truncated (1) → kept.
        push_ascii(&mut g, "out2");
        assert_eq!(g.truncated_rows(), 1);
        assert_eq!(g.end_of_prompt_marker(), Some(1));
        // Another push → truncated (2) > marker (1) → marker dropped.
        push_ascii(&mut g, "out3");
        assert_eq!(g.truncated_rows(), 2);
        assert_eq!(g.end_of_prompt_marker(), None);
    }

    #[test]
    fn packed_color_default_helpers() {
        assert!(PackedColor::DEFAULT.is_default());
        assert!(!PackedColor::named(0).is_default());
    }

    /// Adapter round-trip: feed bytes into an alacritty Term, walk
    /// the resulting grid into a FlatStorage, and confirm the row
    /// text matches what alacritty would have rendered.
    #[test]
    fn adapter_round_trip_plain_ascii() {
        use crate::flat_storage::alac_adapter;
        use alacritty_terminal::event::{Event as AlacEvent, EventListener};
        use alacritty_terminal::grid::Dimensions;
        use alacritty_terminal::term::{Config as TermConfig, TermMode};
        use alacritty_terminal::vte::ansi::Processor;
        use alacritty_terminal::Term;

        #[derive(Clone)]
        struct NullProxy;
        impl EventListener for NullProxy {
            fn send_event(&self, _e: AlacEvent) {}
        }
        struct Dims;
        impl Dimensions for Dims {
            fn total_lines(&self) -> usize { 4 }
            fn screen_lines(&self) -> usize { 4 }
            fn columns(&self) -> usize { 10 }
        }

        let mut term = Term::new(TermConfig::default(), &Dims, NullProxy);
        let mut parser: Processor = Processor::new();
        parser.advance(&mut term, b"hello\r\nworld");
        let _ = TermMode::default(); // silence unused-import lint on cold runs

        let fs = alac_adapter::from_alacritty_term(&term);
        assert_eq!(fs.row_count(), 4);
        // Trim trailing spaces — alacritty pads rows with blanks.
        let trim = |r: &str| r.trim_end_matches(' ').to_string();
        assert_eq!(trim(fs.row(0).unwrap()), "hello");
        assert_eq!(trim(fs.row(1).unwrap()), "world");
        assert_eq!(trim(fs.row(2).unwrap()), "");
        assert_eq!(trim(fs.row(3).unwrap()), "");
    }

    /// SGR runs survive the adapter — a red `RED` substring in the
    /// middle of a default-color row should produce a red interval
    /// entry but leave the surrounding bytes default.
    #[test]
    fn adapter_round_trip_colored_run() {
        use crate::flat_storage::alac_adapter;
        use alacritty_terminal::event::{Event as AlacEvent, EventListener};
        use alacritty_terminal::grid::Dimensions;
        use alacritty_terminal::term::Config as TermConfig;
        use alacritty_terminal::vte::ansi::Processor;
        use alacritty_terminal::Term;

        #[derive(Clone)]
        struct NullProxy;
        impl EventListener for NullProxy {
            fn send_event(&self, _e: AlacEvent) {}
        }
        struct Dims;
        impl Dimensions for Dims {
            fn total_lines(&self) -> usize { 2 }
            fn screen_lines(&self) -> usize { 2 }
            fn columns(&self) -> usize { 20 }
        }

        let mut term = Term::new(TermConfig::default(), &Dims, NullProxy);
        let mut parser: Processor = Processor::new();
        // "ab\x1b[31mRED\x1b[0mz"  →  "ab" default, "RED" red, "z" default
        parser.advance(&mut term, b"ab\x1b[31mRED\x1b[0mz");

        let fs = alac_adapter::from_alacritty_term(&term);
        let row0 = fs.row(0).unwrap();
        assert!(row0.starts_with("abREDz"));

        // 'a' (offset 0) is default fg.
        assert_eq!(fs.fg_at(0), PackedColor::DEFAULT);
        // 'R' lands at byte offset 2, should be red. PackedColor encoding
        // maps NamedColor::Red (= 1) to named(1).
        let red = PackedColor::named(1);
        assert_eq!(fs.fg_at(2), red);
        // 'z' (after the reset SGR) is back to default.
        assert_eq!(fs.fg_at(5), PackedColor::DEFAULT);
    }

    #[test]
    fn fg_and_bg_lookup_at_byte_offsets() {
        let mut g = FlatStorage::with_capacity(8);
        // Build a single row "ab" where 'a' is red fg and 'b' is
        // default. Pass per-cell records manually so we exercise the
        // interval map path.
        let s = "ab";
        let red = PackedColor::named(1);
        let cells = [
            (&s[0..1], red, BgAndStyle::default()),
            (&s[1..2], PackedColor::DEFAULT, BgAndStyle::default()),
        ];
        g.push_row(cells.iter().copied());
        assert_eq!(g.fg_at(0), red);
        assert_eq!(g.fg_at(1), PackedColor::DEFAULT);
        assert_eq!(g.row(0), Some("ab"));
    }
}
