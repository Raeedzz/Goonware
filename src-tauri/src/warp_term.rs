//! Native warpui terminal surface (M1: live grid renderer).
//!
//! Hosts a warpui render surface inside the existing Tauri window via
//! `AppBuilder::attach_embedded` — i.e. without a second `[NSApp run]`
//! (Tauri already owns `NSApplication` and the main run loop).
//!
//! The surface mirrors exactly ONE pty at a time — the active terminal tab,
//! selected by the React `WarpSurfaceTracker` via `term_native_attach`. Its
//! frames reach us through an in-process sink registered on `term.rs`
//! (`set_native_frame_sink`): the sink runs on the PTY reader thread, patches
//! a retained [`TermGrid`], and pokes a redraw on the AppKit main thread. No
//! serde, no IPC, no webview on the per-frame path — this is the whole point
//! of the rewrite (and what makes the WKWebView black-canvas race structurally
//! impossible).
//!
//! `TerminalRootView::render` rebuilds the visible grid as warpui styled text:
//! a `Stack` of a full-surface black `Rect` under a `Flex::column` of rows,
//! each row a `Flex::row` of per-span `Text` runs (fg/bold/italic, bg via
//! `Container`, inverse/dim folded into colors), with a block cursor.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use warpui::color::ColorU;
use warpui::elements::{
    Border, ClippedScrollStateHandle, ClippedScrollable, ConstrainedBox, Container,
    CrossAxisAlignment, Fill, Flex, Highlight, MainAxisAlignment, MainAxisSize, ParentElement,
    PartialClickableElement, Rect, ScrollbarWidth, SelectableArea, SelectionHandle, Stack, Text,
};
use warpui::fonts::{FamilyId, Properties, Style, Weight};
use warpui::text_layout::TextStyle;
use warpui::units::Pixels;
use warpui::{AppContext, Element, Entity, SingletonEntity as _, TypedActionView, View, ViewContext};

use crate::term::{ClosedBlock, RenderFrame, RowSnapshot, Span};

/* ------------------------------------------------------------------
   Tunables + palette. Colors mirror term.rs's CSS theme tokens so the
   native surface matches the (unchanged) React chrome around it.
   ------------------------------------------------------------------ */

const FONT_SIZE: f32 = 13.0;
const LINE_HEIGHT_RATIO: f32 = 1.3;
/// Approximate painted height of one text row (px). Used only to estimate
/// transcript content height for the scroll-back top spacer + the "does it
/// fit?" decision — never for actual layout (warpui measures that). Biased to
/// slightly UNDER-count real height (see `est_block_height`) so the spacer can
/// only ever leave a little blank scroll-space ABOVE old content, never a gap
/// below the newest line.
const LINE_PX: f32 = FONT_SIZE * LINE_HEIGHT_RATIO;
/// Monospace cell advance (px) on the native panes — SF Mono / Menlo / Monaco
/// measure ~0.6 em. Used both for the horizontal-scroll overflow check and for
/// mapping a mouse x back to a grid column in the link hit-test.
const CELL_ADVANCE: f32 = FONT_SIZE * 0.6;
/// Painted height of the gray meta line (cwd + duration). It renders at a
/// 1px-smaller font than the body, so its line box is shorter than `LINE_PX`;
/// `est_block_height` + `build_block` use this so block heights are exact.
const META_LINE_PX: f32 = (FONT_SIZE - 1.0) * LINE_HEIGHT_RATIO;
/// `var(--text-primary)` — default foreground (warm light gray).
const DEFAULT_FG: ColorU = ColorU { r: 0xc9, g: 0xc3, b: 0xb9, a: 255 };
/// Block cursor fill. Char under it is painted black for contrast.
const CURSOR_COLOR: ColorU = ColorU { r: 0xc9, g: 0xc3, b: 0xb9, a: 255 };
/// Vertical gap between blocks — zero; adjacent blocks are separated by a
/// hairline divider + each block's vertical padding (the Warp look), not a gap.
const BLOCK_GAP: f32 = 0.0;
/// Block command color — bright white, bold. Warp shows the command prominently
/// with no prompt glyph; the cwd + duration meta sits above it in gray.
const COMMAND_FG: ColorU = ColorU { r: 0xe6, g: 0xe6, b: 0xe6, a: 255 };
/// Block meta line color (cwd + duration), tertiary gray, ABOVE the command.
const META_FG: ColorU = ColorU { r: 0x7a, g: 0x76, b: 0x70, a: 255 };
/// Failed-command accent: a red left stripe over a dark maroon block fill.
const ERROR_FG: ColorU = ColorU { r: 0xff, g: 0x7b, b: 0x72, a: 255 };
const FAIL_BG: ColorU = ColorU { r: 0x2a, g: 0x15, b: 0x17, a: 255 };
/// Hairline divider drawn beneath each block (the transcript separator).
const DIVIDER: ColorU = ColorU { r: 0x28, g: 0x28, b: 0x2d, a: 255 };
/// Hyperlink color: a soft accent blue, used for both the link text and its
/// underline so detected URLs read as clickable (Cmd+click opens them).
const LINK_FG: ColorU = ColorU { r: 0x6c, g: 0xb6, b: 0xff, a: 255 };
/// Block inner padding (px): horizontal gutter + vertical breathing room.
const BLOCK_PAD_X: f32 = 14.0;
const BLOCK_PAD_Y: f32 = 8.0;
/// Width (px) of the red left stripe on a failed block.
const STRIPE_W: f32 = 2.0;
/* ------------------------------------------------------------------
   Assets — warpui loads fonts from the OS, so the embedded surface
   needs no bundled assets. Surface a clear error if it asks for one.
   ------------------------------------------------------------------ */

pub struct TermAssets;

impl warpui::AssetProvider for TermAssets {
    fn get(&self, path: &str) -> anyhow::Result<Cow<'_, [u8]>> {
        anyhow::bail!("warpui requested unavailable embedded asset: {path}")
    }
}

/* ------------------------------------------------------------------
   Retained model — what the native renderer paints from. Patched in
   place by the sinks (frame: dirty rows + gate flags; block: appended
   closed blocks); read by `render`.
   ------------------------------------------------------------------ */

/// One finished command block: the user's command line + the immutable
/// per-block grid snapshot (`block_rows` from term.rs) plus header metadata.
/// Stacked above the live grid by `render`, oldest first — the Warp transcript.
struct NativeBlock {
    /// Stable per-PTY identity. Used to merge a background SQLite hydration
    /// with blocks that may have closed while that read was in flight.
    block_id: u64,
    command: String,
    rows: Vec<RowSnapshot>,
    /// The block's raw output transcript (bytes, with ANSI + hard newlines).
    /// Kept so the block can RE-WRAP on a column change, Warp-style: replaying
    /// it through the VT at the new width re-soft-wraps the text while the hard
    /// newlines (real line breaks) stay put. `rows` above is just the cached
    /// wrap at the current width; this is the source of truth for reflow.
    transcript: String,
    cwd: Option<String>,
    duration_ms: Option<u64>,
    exit_code: Option<i32>,
    /// Cached painted height (px), computed ONCE at construction via
    /// `est_block_height`. A closed block is immutable, so its height never
    /// changes — caching it keeps the per-frame virtualization Pass-1 O(blocks)
    /// instead of O(total rows), which matters now that the render cap is deep
    /// (hundreds of blocks). Exact (see `est_block_height`), so it doubles as the
    /// off-screen spacer height with zero drift.
    height: f32,
}

impl NativeBlock {
    fn new(
        block_id: u64,
        command: String,
        rows: Vec<RowSnapshot>,
        transcript: String,
        cwd: Option<String>,
        duration_ms: Option<u64>,
        exit_code: Option<i32>,
    ) -> Self {
        let mut b = Self {
            block_id,
            command,
            rows,
            transcript,
            cwd,
            duration_ms,
            exit_code,
            height: 0.0,
        };
        b.height = est_block_height(&b);
        b
    }
}

struct TermGrid {
    rows: Vec<RowSnapshot>,
    n_rows: u16,
    n_cols: u16,
    cursor_row: i32,
    cursor_col: u16,
    cursor_visible: bool,
    /// The live grid only paints while a command runs or in alt-screen —
    /// matches the React model (an idle shell prompt is NOT shown as a full
    /// grid; the closed blocks + the React input box carry the idle state).
    command_running: bool,
    alt_screen: bool,
    /// Closed command blocks (history), oldest first.
    blocks: Vec<NativeBlock>,
    /// Rows that have scrolled OFF the top of the visible grid during the CURRENT
    /// in-progress command/agent block (oldest first). For a long-running inline
    /// agent (claude/codex in the normal screen) the whole conversation lives
    /// here until the block closes — without it only the last `n_rows` visible
    /// lines survive and the conversation is "cut from the top" / unscrollable.
    /// Fed by `RenderFrame::scrollback_appended`. Scoped to the live block via
    /// `live_block_id`: cleared on a block boundary so it never double-renders
    /// the content a closed block already carries (a finished command's output
    /// is re-rendered from its transcript, not from here).
    scrollback: Vec<RowSnapshot>,
    /// `block_id` of the frame whose scrolled-off rows currently fill
    /// `scrollback`. When the next frame reports a different id (a new prompt /
    /// command, or the block closing to 0) the buffer is dropped.
    live_block_id: u64,
    /// Scroll-back offset (px from the top of the transcript content), mirrored
    /// into the `ClippedScrollStateHandle` each render. Only meaningful while
    /// `stick_bottom` is false.
    scroll_px: f32,
    /// Canonical maximum vertical offset computed from transcript height minus
    /// viewport height during render. Wheel input uses this instead of reading
    /// `ClippedScrollStateHandle`, whose temporary 1e9 bottom sentinel can be
    /// observed before layout clamps it and make an upward gesture snap back.
    max_scroll_px: f32,
    /// When true (the default), the transcript auto-follows new output: render
    /// hands the scroll handle a huge sentinel offset that `after_layout` clamps
    /// to the true bottom, so the newest line is always pinned to the viewport
    /// bottom. An upward scroll clears this; scrolling back to the bottom (or the
    /// content shrinking to fit) re-arms it.
    stick_bottom: bool,
    /// Frames applied since attach — diagnostic only.
    frames: u64,
    /// Whether persisted closed blocks have been hydrated for this PTY. Live
    /// frames can create a hidden snapshot before its history is loaded; the
    /// attach path paints that snapshot immediately and hydrates history off
    /// the interaction path.
    history_loaded: bool,
    /// Direct-launched agents have no OSC 133 block id. Preserve their normal-
    /// screen scrollback while hidden once the visible pane has identified the
    /// session as an agent.
    retain_unscoped_scrollback: bool,
}

impl TermGrid {
    fn empty() -> Self {
        Self {
            rows: Vec::new(),
            n_rows: 0,
            n_cols: 0,
            cursor_row: -1,
            cursor_col: 0,
            cursor_visible: false,
            command_running: false,
            alt_screen: false,
            blocks: Vec::new(),
            scrollback: Vec::new(),
            live_block_id: 0,
            scroll_px: 0.0,
            max_scroll_px: 0.0,
            stick_bottom: true,
            frames: 0,
            history_loaded: false,
            retain_unscoped_scrollback: false,
        }
    }

    /// Apply a sparse frame: resize to the frame's grid height, overwrite the
    /// dirty rows, and track cursor + dims + the live-grid gate flags. Cheap —
    /// clones only changed rows.
    fn apply_frame(&mut self, f: &RenderFrame, retain_unscoped_scrollback: bool) {
        if self.n_rows != f.rows {
            self.rows
                .resize(f.rows as usize, RowSnapshot { spans: Vec::new() });
            self.n_rows = f.rows;
        }
        // Reflow stored closed blocks when the column count changes (a pane /
        // window resize), Warp-style — see `rewrap_blocks`. Skip the first frame
        // (n_cols == 0: nothing stored yet) and alt-screen (the app owns the
        // grid; blocks aren't painted there).
        if self.n_cols != 0 && f.cols != self.n_cols && !f.alt_screen {
            self.rewrap_blocks(f.cols);
        }
        self.n_cols = f.cols;
        for d in &f.dirty {
            let idx = d.row as usize;
            if idx < self.rows.len() {
                self.rows[idx].spans = d.spans.clone();
            }
        }
        self.cursor_row = f.cursor_row;
        self.cursor_col = f.cursor_col;
        self.cursor_visible = f.cursor_visible;
        self.command_running = f.command_running;
        self.alt_screen = f.alt_screen;

        // Mirror the rows that scrolled off the visible grid into PTY scrollback
        // so the in-progress command/agent's full output stays scrollable (not
        // just the last screenful). Scope the buffer to the current block:
        //   - `scrollback_reset` (term_start re-emit / history reflow-evict) →
        //      drop and re-sync from the appended snapshot,
        //   - a new `block_id` (new prompt/command, or the block closing to 0) →
        //      drop, since a closed command's output is rendered from its own
        //      closed-block transcript and would otherwise appear twice.
        // We normally retain while a shell block is live (`block_id != 0`);
        // idle-shell scroll deltas are dropped because closed blocks carry that
        // history. A directly-launched agent has no shell OSC 133 lifecycle,
        // however, so every frame has block_id=0. The pane's explicit agent-mode
        // bit keeps that session's normal-screen history instead of silently
        // limiting it to the visible grid.
        if f.scrollback_reset || f.block_id != self.live_block_id {
            self.scrollback.clear();
        }
        self.live_block_id = f.block_id;
        if (f.block_id != 0 || retain_unscoped_scrollback) && !f.alt_screen {
            self.scrollback.reserve(f.scrollback_appended.len());
            for d in &f.scrollback_appended {
                self.scrollback.push(RowSnapshot {
                    spans: d.spans.clone(),
                });
            }
        }

        self.frames = self.frames.wrapping_add(1);
    }

    /// Apply one vertical scroll delta against canonical transcript geometry.
    /// Positive moves toward newer output; negative reveals older output.
    fn scroll_by(&mut self, delta_px: f32) {
        if self.max_scroll_px <= 0.0 {
            self.scroll_px = 0.0;
            self.stick_bottom = true;
            return;
        }
        let current = if self.stick_bottom {
            self.max_scroll_px
        } else {
            self.scroll_px
        };
        self.scroll_px = (current + delta_px).clamp(0.0, self.max_scroll_px);
        self.stick_bottom = false;
    }

    /// Re-wrap every stored closed block to `cols`, recomputing each cached
    /// height. This is the Warp reflow: a block keeps its raw `transcript`
    /// (bytes + hard newlines), so replaying it through the VT at the new width
    /// re-soft-wraps the text while real line breaks stay put — identical in
    /// effect to Warp rebuilding its soft-wrap index. Only invoked when the
    /// width actually changes (the React resize is debounced). Runs on the pty
    /// reader thread (the frame sink), off the render thread. Every retained
    /// block is rewrapped because every retained block is scroll-reachable.
    fn rewrap_blocks(&mut self, cols: u16) {
        if cols == 0 {
            return;
        }
        let rows = self.n_rows.max(1);
        for b in &mut self.blocks {
            if b.transcript.is_empty() {
                continue;
            }
            b.rows = crate::term::snapshot_transcript(&b.transcript, cols, rows);
            b.height = est_block_height(b);
        }
    }
}

/// All native state for ONE pane. The embedded surface hosts up to two panes
/// side-by-side — the main column + the right-panel side terminal — each
/// mirroring its own pty. This was process-global singletons (one pane); it's
/// now per-pane so both terminals can render in the single surface at once.
struct Pane {
    /// The pty this pane mirrors ("" = none / detached). Used for sink routing.
    pty: Mutex<String>,
    /// Retained grid the frame sink patches and `build_pane_column` paints from.
    grid: Arc<Mutex<TermGrid>>,
    /// Scroll-back handle for this pane's `ClippedScrollable` (survives the
    /// per-frame element rebuild; render mirrors scroll_px/stick_bottom in).
    scroll: ClippedScrollStateHandle,
    /// Horizontal scroll-back handle for the panes whose PTY grid is wider than
    /// their on-screen width (the narrow right-panel side terminal pins a wide
    /// PTY so `ls` lays out in columns; the user pans to the off-screen columns).
    /// `term_native_hscroll` writes it; render clamps to the real range.
    hscroll: ClippedScrollStateHandle,
    /// Selection handle for this pane's `SelectableArea` (driven by injected mouse).
    sel: SelectionHandle,
    /// Latest selected text in this pane (read by `term_native_selection_text`).
    selection: Mutex<Option<String>>,
    /// Agent-mode latch: a foreground agent / alt-screen TUI owns the pane, so
    /// the live grid keeps painting across the React exit debounce. Kept out of
    /// `TermGrid` so attach's grid reset can't race it.
    agent_mode: std::sync::atomic::AtomicBool,
    /// This pane's rect in window-content CSS px (x, y, w, h), reported by React.
    /// Drives surface coverage (the combined bounding box) + side-by-side layout.
    /// w/h ≈ 0 → pane not placed (collapsed / detached).
    rect: Mutex<(f32, f32, f32, f32)>,
    /// Content region within the pane (top offset + height, CSS px) — the area
    /// clear of React chrome (input bar below, AgentChrome strip above). `0` =
    /// not reported → fall back to the pane's full height.
    viewport_top: Mutex<f32>,
    viewport_h: Mutex<f32>,
    /// Detected-hyperlink rectangles in SURFACE coordinates (x0, y0, x1, y1),
    /// recomputed every render for the agent grid. `term_native_link_at` tests a
    /// mouse point against these so React can flip the pane cursor to a pointing
    /// hand while Cmd is held over a link (the embedded surface ignores OS mouse
    /// events, so the cursor is owned by the DOM and must be driven from there).
    link_rects: Mutex<Vec<(f32, f32, f32, f32)>>,
}

impl Pane {
    fn new() -> Self {
        Self {
            pty: Mutex::new(String::new()),
            grid: Arc::new(Mutex::new(TermGrid::empty())),
            scroll: ClippedScrollStateHandle::new(),
            hscroll: ClippedScrollStateHandle::new(),
            sel: SelectionHandle::default(),
            selection: Mutex::new(None),
            agent_mode: std::sync::atomic::AtomicBool::new(false),
            rect: Mutex::new((0.0, 0.0, 0.0, 0.0)),
            viewport_top: Mutex::new(0.0),
            viewport_h: Mutex::new(0.0),
            link_rects: Mutex::new(Vec::new()),
        }
    }
    fn pty_id(&self) -> String {
        self.pty.lock().map(|g| g.clone()).unwrap_or_default()
    }
    fn rect(&self) -> (f32, f32, f32, f32) {
        *self.rect.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// Placed on-screen: has a non-trivial rect (an unattached placed pane just
    /// renders empty/black, which is harmless and avoids attach-vs-rect races).
    fn active(&self) -> bool {
        let (_, _, w, h) = self.rect();
        w > 1.0 && h > 1.0
    }
}

/// The panes: index 0 = main column (or the LEFT half of a main-column
/// split), 1 = right-panel side terminal, 2 = the RIGHT half of a
/// main-column split. Created lazily before attach so the sinks and the
/// view share the same `Pane`s.
static PANES: OnceLock<[Pane; 3]> = OnceLock::new();
fn panes() -> &'static [Pane; 3] {
    PANES.get_or_init(|| [Pane::new(), Pane::new(), Pane::new()])
}
/// Resolve a React pane key to its `Pane`. Anything but "side" / "main2" is
/// the main pane (so a missing/legacy key maps safely to main).
fn pane(key: &str) -> &'static Pane {
    &panes()[match key {
        "side" => 1,
        "main2" => 2,
        _ => 0,
    }]
}
/// The pane currently mirroring `pty_id`, if any (frame/block sink routing).
fn pane_for_pty(pty_id: &str) -> Option<&'static Pane> {
    panes().iter().find(|p| p.pty_id() == pty_id)
}

/// Retained native models for PTYs that are not currently assigned to a pane.
/// A worktree switch moves the model between a pane and this map; it does not
/// rebuild the model from SQLite. Hidden frame/block events keep these entries
/// current at the backend's already-throttled hidden cadence.
static HIDDEN_GRIDS: OnceLock<Mutex<HashMap<String, TermGrid>>> = OnceLock::new();
static HISTORY_LOADS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
/// Serializes the tiny ownership handoff between pane grids and hidden grids.
/// Frame delivery, attach/detach, and background hydration can run on different
/// threads; without one routing critical section, a completed history read
/// could merge into a pane just after that pane switched to a different PTY.
static GRID_ROUTING: Mutex<()> = Mutex::new(());

fn hidden_grids() -> &'static Mutex<HashMap<String, TermGrid>> {
    HIDDEN_GRIDS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn history_loads() -> &'static Mutex<HashSet<String>> {
    HISTORY_LOADS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn grid_has_retained_state(g: &TermGrid) -> bool {
    g.history_loaded
        || g.frames > 0
        || !g.rows.is_empty()
        || !g.blocks.is_empty()
        || !g.scrollback.is_empty()
}

fn stash_pane_grid(pty_id: &str, p: &'static Pane) {
    if pty_id.is_empty() {
        return;
    }
    let old = {
        let mut g = p.grid.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::replace(&mut *g, TermGrid::empty())
    };
    // During a split-pane swap the destination steals the source grid before
    // that source receives its own attach call. Do not overwrite the stolen,
    // current cache entry with the empty placeholder left behind.
    if grid_has_retained_state(&old) {
        hidden_grids()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(pty_id.to_string(), old);
    }
}

fn take_retained_grid(pty_id: &str, destination: &'static Pane) -> TermGrid {
    // Split-pane swaps briefly ask one pane to display the PTY still owned by
    // its sibling. Move that exact model instead of falling through to disk.
    for source in panes() {
        if std::ptr::eq(source, destination) || source.pty_id() != pty_id {
            continue;
        }
        let mut g = source.grid.lock().unwrap_or_else(|e| e.into_inner());
        return std::mem::replace(&mut *g, TermGrid::empty());
    }
    hidden_grids()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(pty_id)
        .unwrap_or_else(TermGrid::empty)
}

fn native_block_from_saved(sb: crate::persistence::SavedBlock) -> NativeBlock {
    NativeBlock::new(
        sb.block_id.max(0) as u64,
        sb.input,
        serde_json::from_value(sb.block_rows_json).unwrap_or_default(),
        sb.transcript,
        sb.cwd,
        sb.duration_ms.map(|d| d.max(0) as u64),
        sb.exit_code,
    )
}

fn merge_saved_history(g: &mut TermGrid, saved: Vec<crate::persistence::SavedBlock>) {
    let mut merged: Vec<NativeBlock> = saved.into_iter().map(native_block_from_saved).collect();
    let mut ids: HashSet<u64> = merged.iter().map(|b| b.block_id).collect();
    for block in std::mem::take(&mut g.blocks) {
        if ids.insert(block.block_id) {
            merged.push(block);
        }
    }
    merged.sort_by_key(|b| b.block_id);
    g.blocks = merged;
    g.history_loaded = true;
}

/// Hydrate persisted history away from the instance-switch command. The pane
/// paints its retained live model immediately; deep history joins it when the
/// read finishes. `HISTORY_LOADS` deduplicates StrictMode/effect races.
fn hydrate_history_in_background(pty_id: String) {
    let should_start = history_loads()
        .lock()
        .map(|mut loads| loads.insert(pty_id.clone()))
        .unwrap_or(false);
    if !should_start {
        return;
    }
    let Some(app) = APP_HANDLE.get().cloned() else {
        if let Ok(mut loads) = history_loads().lock() {
            loads.remove(&pty_id);
        }
        return;
    };
    std::thread::spawn(move || {
        use tauri::Manager as _;
        let saved = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())
            .and_then(|dir| crate::persistence::load_blocks(&dir.join("goonware.db"), &pty_id));
        let mut visible = false;
        if let Ok(saved) = saved {
            let _routing = GRID_ROUTING.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(p) = pane_for_pty(&pty_id) {
                let mut g = p.grid.lock().unwrap_or_else(|e| e.into_inner());
                merge_saved_history(&mut g, saved);
                visible = true;
            } else {
                let mut cache = hidden_grids().lock().unwrap_or_else(|e| e.into_inner());
                let g = cache.entry(pty_id.clone()).or_insert_with(TermGrid::empty);
                merge_saved_history(g, saved);
            }
        }
        if let Ok(mut loads) = history_loads().lock() {
            loads.remove(&pty_id);
        }
        if visible {
            let _ = app.run_on_main_thread(|| warpui::platform::poke_embedded_redraw());
        }
    });
}

/// Combined surface rect (window-content CSS px) = bounding box of the placed
/// panes. The single embedded surface covers exactly this; `term_native_mouse`
/// subtracts its origin to map window coords → surface coords. Recomputed each
/// time a pane reports its rect. When only the main pane is placed this equals
/// the main pane's rect (i.e. unchanged from the single-pane layout).
static COMBINED: Mutex<(f32, f32, f32, f32)> = Mutex::new((0.0, 0.0, 0.0, 0.0));

/// Recompute the combined surface rect from the placed panes and reposition the
/// embedded child window to cover it. Main-thread reposition; safe to call from
/// any thread (it hops via `run_on_main_thread`).
fn reposition_surface() {
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, 0.0f32, 0.0f32);
    let mut any = false;
    for p in panes() {
        let (x, y, w, h) = p.rect();
        if w > 1.0 && h > 1.0 {
            any = true;
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x + w);
            y1 = y1.max(y + h);
        }
    }
    let combined = if any {
        (x0, y0, x1 - x0, y1 - y0)
    } else {
        (0.0, 0.0, 0.0, 0.0)
    };
    if let Ok(mut c) = COMBINED.lock() {
        *c = combined;
    }
    if let Some(app) = APP_HANDLE.get() {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            use tauri::Manager as _;
            if let Some(win) = app2.get_webview_window("main") {
                if let Ok(parent) = win.ns_window() {
                    warpui::platform::reposition_embedded_surface(
                        parent,
                        combined.0 as f64,
                        combined.1 as f64,
                        combined.2 as f64,
                        combined.3 as f64,
                    );
                }
            }
        });
    }
}

/// Intercept the host window's fullscreen action (green button / ⌃⌘F / View ▸
/// Enter Full Screen) so it does borderless full-bleed fullscreen in the same
/// Space — where the native surface keeps compositing below the webview —
/// instead of native fullscreen (whose separate Space breaks that compositing).
/// Called once from `lib.rs` setup (main thread) with the host `NSWindow`.
pub fn configure_fullscreen(parent_nswindow: *mut std::ffi::c_void) {
    warpui::platform::configure_host_fullscreen(parent_nswindow);
}

/// Tauri handle, stashed at attach for `run_on_main_thread` (sink redraw poke
/// + commands that touch AppKit).
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// The warpui window id (from `add_window`), for off-screen frame capture.
static CAPTURE_WID: Mutex<Option<warpui::WindowId>> = Mutex::new(None);

/// Dev-only: write a captured RGBA frame to `path` as PNG so we can inspect the
/// native render without Screen Recording permission.
fn save_capture_png(frame: &warpui::platform::CapturedFrame, path: &str) {
    use image::ImageEncoder;
    let Ok(file) = std::fs::File::create(path) else {
        return;
    };
    let mut w = std::io::BufWriter::new(file);
    let enc = image::codecs::png::PngEncoder::new(&mut w);
    // The Metal framebuffer is BGRA; swap R/B so the PNG's colors are accurate
    // (otherwise e.g. warpui's blue selection highlight reads as orange).
    let mut buf = frame.data.to_vec();
    for px in buf.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    let _ = enc.write_image(
        &buf,
        frame.width,
        frame.height,
        image::ExtendedColorType::Rgba8,
    );
    eprintln!(
        "[warpui] capture saved {}x{} -> {path}",
        frame.width, frame.height
    );
}

/* ------------------------------------------------------------------
   Color conversion — term.rs emits `#rrggbb` hex (ANSI palette,
   256-cube, truecolor) plus a few CSS theme vars. Map to ColorU.
   ------------------------------------------------------------------ */

fn parse_hex(s: &str) -> Option<ColorU> {
    let h = s.strip_prefix('#')?;
    if h.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&h[0..2], 16).ok()?;
    let g = u8::from_str_radix(&h[2..4], 16).ok()?;
    let b = u8::from_str_radix(&h[4..6], 16).ok()?;
    Some(ColorU::new(r, g, b, 255))
}

/// Resolve a foreground color string to a concrete color.
fn fg_color(s: &str) -> ColorU {
    if let Some(c) = parse_hex(s) {
        return c;
    }
    match s {
        "var(--accent-bright)" => CURSOR_COLOR,
        "var(--surface-0)" => ColorU::black(),
        _ => DEFAULT_FG, // text-primary / bright-foreground / anything unknown
    }
}

/// Resolve a background color string. The default terminal background
/// (`--surface-0`) is `None` — the surface's black `Rect` shows through, so we
/// skip a per-cell `Container`.
fn bg_color(s: &str) -> Option<ColorU> {
    parse_hex(s)
}

fn dim(c: ColorU) -> ColorU {
    let f = |v: u8| (v as f32 * 0.6) as u8;
    ColorU::new(f(c.r), f(c.g), f(c.b), c.a)
}

/* ------------------------------------------------------------------
   Element builders.
   ------------------------------------------------------------------ */

fn text_props(bold: bool, italic: bool) -> Properties {
    Properties {
        weight: if bold { Weight::Bold } else { Weight::Normal },
        style: if italic { Style::Italic } else { Style::Normal },
    }
}

/// One styled run of a span's text (fg/bold/italic; bg via Container).
fn styled_run(text: String, span: &Span, mono: FamilyId) -> Box<dyn Element> {
    // Hyperlink run: accent color + underline + Cmd-click to open. The injected
    // embedded mouse events (`term_native_mouse`) drive warpui's own hit-testing
    // here, so a Cmd+left-click landing on this run fires the handler. We gate on
    // `modifiers.cmd` so a plain click still flows to selection (Warp behavior).
    if let Some(url) = &span.link {
        let char_len = text.chars().count();
        let url = url.to_string();
        // Underline is applied as a full-run Highlight carrying a TextStyle —
        // plain `Text` has no direct underline setter; the underline lives on
        // TextStyle (mirrors warpui's own FormattedText hyperlink path).
        let link_style = TextStyle::new()
            .with_foreground_color(LINK_FG)
            .with_underline_color(LINK_FG);
        return Text::new(text, mono, FONT_SIZE)
            .with_color(LINK_FG)
            .with_style(text_props(span.bold, span.italic))
            .with_line_height_ratio(LINE_HEIGHT_RATIO)
            .soft_wrap(false)
            .with_single_highlight(
                Highlight::new().with_text_style(link_style),
                (0..char_len).collect(),
            )
            .with_clickable_char_range(0..char_len, move |modifiers, _ctx, _app| {
                if modifiers.cmd {
                    open_url(&url);
                }
            })
            .finish();
    }
    let mut fg = fg_color(&span.fg);
    let mut bg = bg_color(&span.bg);
    if span.inverse {
        let new_fg = bg.unwrap_or_else(ColorU::black);
        bg = Some(fg);
        fg = new_fg;
    }
    if span.dim {
        fg = dim(fg);
    }
    let t = Text::new(text, mono, FONT_SIZE)
        .with_color(fg)
        .with_style(text_props(span.bold, span.italic))
        .with_line_height_ratio(LINE_HEIGHT_RATIO)
        .soft_wrap(false)
        .finish();
    match bg {
        Some(c) => Container::new(t).with_background_color(c).finish(),
        None => t,
    }
}

/// A default-styled run (used for padding before an end-of-row cursor and to
/// give blank rows a line's worth of height).
fn plain_run(text: String, mono: FamilyId) -> Box<dyn Element> {
    Text::new(text, mono, FONT_SIZE)
        .with_color(DEFAULT_FG)
        .with_line_height_ratio(LINE_HEIGHT_RATIO)
        .soft_wrap(false)
        .finish()
}

/// A block cursor cell: the glyph painted black over a solid fill.
fn cursor_cell(ch: &str, mono: FamilyId) -> Box<dyn Element> {
    let display = if ch.is_empty() { " " } else { ch };
    Container::new(
        Text::new(display.to_string(), mono, FONT_SIZE)
            .with_color(ColorU::black())
            .with_line_height_ratio(LINE_HEIGHT_RATIO)
            .soft_wrap(false)
            .finish(),
    )
    .with_background_color(CURSOR_COLOR)
    .finish()
}

/// Open a detected URL in the user's default browser. macOS-only surface, so
/// `open` is always available; only http(s) URLs reach here (see
/// `find_url_ranges`), so handing the string to `open` is safe.
fn open_url(url: &str) {
    let _ = std::process::Command::new("/usr/bin/open").arg(url).spawn();
}

/// Case-insensitive check that `chars[i..]` begins with `pat` (used for the URL
/// scheme, which is matched case-insensitively).
fn starts_with_at(chars: &[char], i: usize, pat: &str) -> bool {
    let mut ci = i;
    for pc in pat.chars() {
        match chars.get(ci) {
            Some(c) if c.eq_ignore_ascii_case(&pc) => ci += 1,
            _ => return false,
        }
    }
    true
}

/// Characters that never appear mid-URL in terminal output — used as hard URL
/// terminators alongside whitespace.
fn is_url_stop(c: char) -> bool {
    c.is_control() || matches!(c, '"' | '\'' | '`' | '<' | '>' | '|')
}

/// Trailing punctuation that's almost always prose, not part of the URL
/// (trimmed off the end of a detected run).
fn is_trailing_punct(c: char) -> bool {
    matches!(c, '.' | ',' | ';' | ':' | '!' | '?' | ')' | ']' | '}' | '"' | '\'' | '>')
}

/// Find http(s) URL char-ranges (half-open) in a reconstructed row's chars.
/// Dependency-free scan: locate a scheme, consume to a terminator, trim
/// trailing prose punctuation, require at least one char past the scheme.
fn find_url_ranges(chars: &[char]) -> Vec<(usize, usize)> {
    let n = chars.len();
    let mut out = Vec::new();
    let mut i = 0;
    while i < n {
        let scheme_len = if starts_with_at(chars, i, "https://") {
            8
        } else if starts_with_at(chars, i, "http://") {
            7
        } else {
            i += 1;
            continue;
        };
        let start = i;
        let mut end = i;
        while end < n && !chars[end].is_whitespace() && !is_url_stop(chars[end]) {
            end += 1;
        }
        while end > start + 1 && is_trailing_punct(chars[end - 1]) {
            end -= 1;
        }
        if end > start + scheme_len {
            out.push((start, end));
        }
        i = end.max(start + 1);
    }
    out
}

/// Split a row's spans at URL boundaries, tagging each URL run with `link` and
/// forcing `underline`. Detection runs over the full reconstructed row text so a
/// URL crossing multiple style runs is still found; the affected spans are then
/// re-split so each URL is its own contiguous run. Returns the spans unchanged
/// (cloned) when no URL is present.
fn split_links(spans: &[Span]) -> Vec<Span> {
    let chars: Vec<char> = spans.iter().flat_map(|s| s.text.chars()).collect();
    let ranges = find_url_ranges(&chars);
    if ranges.is_empty() {
        return spans.to_vec();
    }
    let url_strings: Vec<String> = ranges
        .iter()
        .map(|&(s, e)| chars[s..e].iter().collect())
        .collect();
    // Per absolute char index: which URL range (if any) owns it.
    let mut owner: Vec<Option<usize>> = vec![None; chars.len()];
    for (ri, &(s, e)) in ranges.iter().enumerate() {
        for slot in owner.iter_mut().take(e).skip(s) {
            *slot = Some(ri);
        }
    }
    let mut result: Vec<Span> = Vec::with_capacity(spans.len() + ranges.len());
    let mut abs = 0usize;
    for s in spans {
        let span_chars: Vec<char> = s.text.chars().collect();
        let mut i = 0;
        while i < span_chars.len() {
            let cur = owner[abs + i];
            let mut j = i + 1;
            while j < span_chars.len() && owner[abs + j] == cur {
                j += 1;
            }
            let mut ns = s.clone();
            ns.text = span_chars[i..j].iter().collect();
            if let Some(ri) = cur {
                ns.link = Some(Cow::Owned(url_strings[ri].clone()));
                ns.underline = true;
            }
            result.push(ns);
            i = j;
        }
        abs += span_chars.len();
    }
    result
}

/// Detected-URL hit rectangles (surface coords) for a block of consecutive grid
/// rows whose first row's top edge sits at `top_surface_y`, each `LINE_PX` tall,
/// left-aligned at `left_surface_x` with `CELL_ADVANCE`-wide cells. Reuses the
/// renderer's own URL scan so the hit zones line up exactly with the underlined
/// glyphs. (1 char ≈ 1 column; wide glyphs are rare in agent output and only
/// nudge the right edge of a hit zone by part of a cell.)
fn link_rects_for_rows(
    rows: &[RowSnapshot],
    left_surface_x: f32,
    top_surface_y: f32,
) -> Vec<(f32, f32, f32, f32)> {
    let mut out = Vec::new();
    for (r, row) in rows.iter().enumerate() {
        let chars: Vec<char> = row.spans.iter().flat_map(|s| s.text.chars()).collect();
        if !chars.iter().collect::<String>().contains("http") {
            continue;
        }
        let y0 = top_surface_y + r as f32 * LINE_PX;
        for (c0, c1) in find_url_ranges(&chars) {
            out.push((
                left_surface_x + c0 as f32 * CELL_ADVANCE,
                y0,
                left_surface_x + c1 as f32 * CELL_ADVANCE,
                y0 + LINE_PX,
            ));
        }
    }
    out
}

/// Build one grid row: per-span runs, splitting the span under the cursor (and
/// padding/appending a cursor cell at/after the row's end). Spans are first
/// split at URL boundaries so detected links render underlined + Cmd-clickable
/// (see `split_links` / `styled_run`); the cheap `http` pre-check keeps the
/// no-link common case allocation-free.
fn build_row(spans: &[Span], cursor_col: Option<u16>, mono: FamilyId) -> Box<dyn Element> {
    let split_storage;
    let spans: &[Span] = if spans.iter().any(|s| s.text.contains("http")) {
        split_storage = split_links(spans);
        &split_storage
    } else {
        spans
    };

    let mut runs: Vec<Box<dyn Element>> = Vec::new();
    let mut col: u16 = 0;

    for span in spans {
        let len = span.text.chars().count() as u16;
        match cursor_col {
            Some(cc) if cc >= col && cc < col + len => {
                let rel = (cc - col) as usize;
                let chars: Vec<char> = span.text.chars().collect();
                let pre: String = chars[..rel].iter().collect();
                let cur: String = chars[rel..=rel].iter().collect();
                let post: String = chars[rel + 1..].iter().collect();
                if !pre.is_empty() {
                    runs.push(styled_run(pre, span, mono));
                }
                runs.push(cursor_cell(&cur, mono));
                if !post.is_empty() {
                    runs.push(styled_run(post, span, mono));
                }
            }
            _ => {
                if !span.text.is_empty() {
                    runs.push(styled_run(span.text.clone(), span, mono));
                }
            }
        }
        col += len;
    }

    // Cursor sitting at or past the end of the row's text (e.g. on a prompt).
    if let Some(cc) = cursor_col {
        if cc >= col {
            let pad = (cc - col) as usize;
            if pad > 0 {
                runs.push(plain_run(" ".repeat(pad), mono));
            }
            runs.push(cursor_cell(" ", mono));
        }
    }

    if runs.is_empty() {
        runs.push(plain_run(" ".to_string(), mono));
    }

    // `without_selection_separators`: the runs are contiguous slices of ONE
    // grid line, so Flex's implicit " " between children's selection fragments
    // injected a phantom space at every style boundary into copied text
    // (the "copy doesn't preserve exact spacing" bug). The real spaces are
    // already present in the span text (blank cells serialize as ' ').
    Flex::row()
        .without_selection_separators()
        .with_spacing(0.0)
        .with_children(runs)
        .finish()
}

/// Collapse a leading `$HOME` to `~` for compact block-header cwds.
fn collapse_home(path: &str) -> String {
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            if let Some(rest) = path.strip_prefix(&home) {
                return format!("~{rest}");
            }
        }
    }
    path.to_string()
}

/// Human-readable command duration for the block meta line.
fn format_duration(ms: u64) -> String {
    if ms < 1000 {
        format!("{:.3}s", ms as f64 / 1000.0)
    } else if ms < 60_000 {
        format!("{:.2}s", ms as f64 / 1000.0)
    } else {
        let secs = ms / 1000;
        format!("{}m{:02}s", secs / 60, secs % 60)
    }
}

/// True if a row carries any non-space glyph. Used to trim trailing blank rows
/// off the live grid (an idle / just-finished screen otherwise pads the
/// transcript with empty lines below the prompt).
fn row_has_content(row: &RowSnapshot) -> bool {
    row.spans
        .iter()
        .any(|s| s.text.chars().any(|c| c != ' '))
}

/// zsh's `PROMPT_EOL_MARK`: a lone reverse-video `%` shown when a command's last
/// line lacks a trailing newline. Our inverse rendering paints it as a stray
/// filled box, so strip rows that are just this marker from the transcript.
fn is_zsh_eol_marker(row: &RowSnapshot) -> bool {
    let mut seen = false;
    for s in &row.spans {
        for c in s.text.chars() {
            if c == ' ' {
                continue;
            }
            if seen || c != '%' || !s.inverse {
                return false;
            }
            seen = true;
        }
    }
    seen
}

/// Concatenated glyph text of a row with trailing blanks trimmed — the identity
/// we match on when measuring how far an alt-screen app scrolled. We compare
/// TEXT (not the full styled spans) so a pager re-coloring a line (e.g. moving
/// its highlighted current line, or a cursor landing on it) doesn't defeat the
/// match.
fn row_text(row: &RowSnapshot) -> String {
    let mut s = String::new();
    for sp in &row.spans {
        s.push_str(&sp.text);
    }
    s.trim_end().to_string()
}

/// Measure how many rows an alt-screen app scrolled between two consecutive grid
/// snapshots, by content matching. Returns `k` such that the new grid shows, at
/// row `i`, what the old grid had at row `i + k`:
///   - `k > 0` → content moved UP by k rows (scrolled toward newer / down)
///   - `k < 0` → content moved DOWN by k rows (scrolled toward older / up)
///   - `0`     → no clear scroll (partial repaint, spinner tick, cursor blink,
///                a page swap, or genuinely nothing moved)
///
/// This is the source of truth for gluing a selection to alt-screen text, and it
/// replaces the old "assume the app scrolls one row per wheel notch" guess —
/// which drifts on any app that scrolls several rows per notch (vim's default,
/// most pagers). Because it reads the app's ACTUAL response it's correct
/// regardless of the app's wheel-to-rows ratio.
///
/// Deliberately conservative: it reports a non-zero shift only when a clear
/// majority of the NON-BLANK rows line up at exactly one offset AND that offset
/// explains more rows than staying put (k = 0). A one-line spinner update or a
/// single streamed character leaves k = 0 unbeaten, so a completed selection is
/// never nudged by a non-scroll repaint — the exact "jumpy / stuck selection"
/// artifact a naive always-shift approach produces.
fn detect_scroll_shift(old: &[RowSnapshot], new: &[RowSnapshot]) -> i32 {
    let n = old.len().min(new.len());
    if n < 4 {
        return 0; // too little signal to be confident
    }
    let o: Vec<String> = old.iter().take(n).map(row_text).collect();
    let e: Vec<String> = new.iter().take(n).map(row_text).collect();

    // Count indices where new[i] equals old[i + k], ignoring blank rows (a blank
    // line matches every other blank line and would inflate every offset).
    let score = |k: i32| -> usize {
        let mut c = 0usize;
        for i in 0..n {
            let j = i as i32 + k;
            if j < 0 || j as usize >= n {
                continue;
            }
            if !e[i].is_empty() && e[i] == o[j as usize] {
                c += 1;
            }
        }
        c
    };

    let base = score(0); // non-blank rows still in place
    let mut best_k = 0i32;
    let mut best = base;
    let range = (n as i32) - 1;
    for k in -range..=range {
        if k == 0 {
            continue;
        }
        let s = score(k);
        if s > best {
            best = s;
            best_k = k;
        }
    }

    // Require the winning offset to be genuinely dominant: it must line up a solid
    // block of rows and clearly beat the in-place score, else treat it as noise.
    if best_k != 0 && best >= 3 && best > base + 1 {
        best_k
    } else {
        0
    }
}

/// How many leading rows of the live grid to render: trims trailing blank rows
/// (keeping through the cursor row) so an idle / just-finished shell screen sits
/// compactly above the input instead of padding the transcript with blanks.
fn live_row_count(rows: &[RowSnapshot], cursor_on: bool, cursor_row: usize) -> usize {
    if rows.is_empty() {
        return 0;
    }
    // Find the last row with actual glyphs.
    let mut last_content = 0usize;
    let mut found = false;
    for (i, row) in rows.iter().enumerate() {
        if row_has_content(row) {
            last_content = i;
            found = true;
        }
    }
    // Trailing blank rows are trimmed so an agent (claude) that paints its UI in
    // the top N rows of a tall PTY and leaves the rest blank renders as an
    // N-row block anchored at the bottom of the pane — NOT floating at the top
    // with black below it. Crucially the cursor only EXTENDS the count when it
    // sits at (or one row past) the content: a cursor parked deep in the blank
    // tail — which is what was re-including rows 27..44 and pushing claude's
    // content up — must not re-pad the grid. (claude's own input cursor lives
    // inside its content, so this keeps the input row visible.)
    let mut end = if found { last_content } else { 0 };
    if cursor_on && cursor_row <= end + 1 {
        end = end.max(cursor_row.min(rows.len() - 1));
    }
    end + 1
}

/// Normalize extracted selection text before caching it for Cmd+C.
///
/// Grid rows serialize EVERY column — a line's tail of blank cells comes
/// through as a run of real spaces padding the row to the terminal width.
/// Copying that padding makes every line end in invisible whitespace (and
/// blank rows render a single ' ' for height), so trim each line's trailing
/// whitespace. Leading/interior spacing is untouched — that's the user's
/// actual indentation and alignment, preserved exactly.
fn clean_selection_text(s: Option<String>) -> Option<String> {
    s.map(|s| {
        s.split('\n')
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join("\n")
    })
}

/// A fixed-height transparent box — the stand-in for content the virtualizer
/// skips (off-screen blocks, or off-screen rows inside a tall block). Holding
/// the skipped height keeps the scroll geometry identical to building it all.
fn spacer_box(h: f32) -> Box<dyn Element> {
    Box::new(ConstrainedBox::new(Rect::new().finish()).with_height(h))
}

/// Painted height (px) of one closed block — EXACT, matching what `build_block`
/// lays out, so it doubles as the off-screen spacer height with ZERO drift at any
/// scroll depth (this is what lets the render cap go deep). warpui line boxes are
/// `font_size * line_height_ratio` with no rounding (`text.rs::line_height`), and
/// `Container::layout` adds padding + border to the child size, so the height is
/// fully determined:
///   - gray meta line (cwd/duration), if present: `META_LINE_PX` — it renders at
///     a 1px-smaller font, the ONE term that used to be approximated
///   - bold command line, if present: `LINE_PX`
///   - each visible output row (zsh EOL marker stripped): `LINE_PX`
///   - the block's vertical padding (`2 * BLOCK_PAD_Y`) + the 1px bottom divider
fn est_block_height(block: &NativeBlock) -> f32 {
    let mut h = 2.0 * BLOCK_PAD_Y + 1.0;
    if block.cwd.is_some() || block.duration_ms.is_some() {
        h += META_LINE_PX;
    }
    if !block.command.is_empty() {
        h += LINE_PX;
    }
    h += block.rows.iter().filter(|r| !is_zsh_eol_marker(r)).count() as f32 * LINE_PX;
    h
}

/// Build one closed block, Warp-style: a gray meta line (`cwd (duration)`) on
/// top, then the command in bold white (no prompt glyph), then the output rows,
/// with a hairline divider beneath. A failed command gets a dark maroon fill and
/// a red left stripe — its only status accents (no "exit N" text).
///
/// `win = Some((block_top_y, build_top, build_bot))` (all content-px) enables
/// ROW-LEVEL virtualization: only output rows intersecting `[build_top,
/// build_bot]` are built; the rest collapse into exact-height spacer rects
/// above/below. This bounds the cost of a single block TALLER than the viewport
/// (a long `cat`, a deep agent session — `block_rows` is uncapped) to one screen
/// of rows. It degrades to "build every row" automatically when the block fits
/// inside the window, so the caller passes it unconditionally; `None` (the
/// height-unknown fallback path) also builds everything.
fn build_block(
    block: &NativeBlock,
    mono: FamilyId,
    win: Option<(f32, f32, f32)>,
) -> Box<dyn Element> {
    let failed = matches!(block.exit_code, Some(c) if c != 0);

    // Header: gray meta line ("{cwd} ({duration})") then the bold command line.
    // Always built — two lines at most.
    let mut header: Vec<Box<dyn Element>> = Vec::new();
    let mut meta = String::new();
    if let Some(cwd) = &block.cwd {
        meta.push_str(&collapse_home(cwd));
    }
    if let Some(d) = block.duration_ms {
        if !meta.is_empty() {
            meta.push(' ');
        }
        meta.push_str(&format!("({})", format_duration(d)));
    }
    let has_meta = !meta.is_empty();
    if has_meta {
        header.push(
            Text::new(meta, mono, FONT_SIZE - 1.0)
                .with_color(META_FG)
                .with_line_height_ratio(LINE_HEIGHT_RATIO)
                .soft_wrap(false)
                .finish(),
        );
    }
    let has_command = !block.command.is_empty();
    if has_command {
        header.push(
            Text::new(block.command.clone(), mono, FONT_SIZE)
                .with_color(COMMAND_FG)
                .with_style(text_props(true, false))
                .with_line_height_ratio(LINE_HEIGHT_RATIO)
                .soft_wrap(false)
                .finish(),
        );
    }
    // Exact header height — the meta line renders at a smaller font than the
    // command — so the row window below lands on the correct output rows.
    let header_h = (if has_meta { META_LINE_PX } else { 0.0 })
        + (if has_command { LINE_PX } else { 0.0 });

    // Output rows (zsh's stray reverse-video EOL marker stripped).
    let out_rows: Vec<&RowSnapshot> =
        block.rows.iter().filter(|r| !is_zsh_eol_marker(r)).collect();
    let n = out_rows.len();

    // The window of output rows to actually build. Rows are a contiguous run of
    // `LINE_PX`-tall boxes starting at `block_top + padding + header`, so the
    // first/last visible indices fall straight out of the build region. Clamped
    // to [0, n]; an empty or fully-in-window block yields (0, n) → build all.
    let (i0, i1) = match win {
        Some((block_top, build_top, build_bot)) => {
            let rows_top = block_top + BLOCK_PAD_Y + header_h;
            let lo = ((((build_top - rows_top) / LINE_PX).floor()) as isize).max(0) as usize;
            let lo = lo.min(n);
            let hi = ((((build_bot - rows_top) / LINE_PX).ceil()) as isize).max(0) as usize;
            (lo, hi.clamp(lo, n))
        }
        None => (0, n),
    };

    // Output rows in their own zero-spacing column; off-screen runs become
    // spacer rects so the block's height is identical to building every row.
    let mut rows_col: Vec<Box<dyn Element>> = Vec::with_capacity(i1 - i0 + 2);
    if i0 > 0 {
        rows_col.push(spacer_box(i0 as f32 * LINE_PX));
    }
    for row in &out_rows[i0..i1] {
        rows_col.push(build_row(&row.spans, None, mono));
    }
    if i1 < n {
        rows_col.push(spacer_box((n - i1) as f32 * LINE_PX));
    }

    let mut children = header;
    children.push(
        Flex::column()
            .with_spacing(0.0)
            .with_children(rows_col)
            .finish(),
    );

    // Zero inter-line spacing: terminal output is contiguous, and it keeps every
    // row exactly `LINE_PX` tall — which `est_block_height` and the row windowing
    // above both rely on.
    let content = Flex::column()
        .with_spacing(0.0)
        .with_children(children)
        .finish();

    // Body: padded. A failed command gets a dark maroon fill + a red left stripe;
    // its left padding is reduced by the stripe width so text stays aligned with
    // successful blocks.
    let body: Box<dyn Element> = if failed {
        Container::new(content)
            .with_background_color(FAIL_BG)
            .with_border(Border {
                width: STRIPE_W,
                color: Fill::Solid(ERROR_FG),
                top: false,
                left: true,
                bottom: false,
                right: false,
                dash: None,
            })
            .with_padding_left(BLOCK_PAD_X - STRIPE_W)
            .with_padding_right(BLOCK_PAD_X)
            .with_vertical_padding(BLOCK_PAD_Y)
            .finish()
    } else {
        Container::new(content)
            .with_horizontal_padding(BLOCK_PAD_X)
            .with_vertical_padding(BLOCK_PAD_Y)
            .finish()
    };

    // Hairline divider beneath each block (the transcript separator).
    Container::new(body)
        .with_border(Border {
            width: 1.0,
            color: Fill::Solid(DIVIDER),
            top: false,
            left: false,
            bottom: true,
            right: false,
            dash: None,
        })
        .finish()
}

/// Pin `content` to the region `[top, top + height]` of the surface: an optional
/// top spacer of `top` px, then `content` clipped to `height`, in a top-anchored
/// full-surface column (the area below `top + height` stays black behind React
/// chrome). Lets the shell transcript clear the bottom input bar AND an agent
/// grid clear the top AgentChrome strip with one mechanism. With `top == 0` and
/// `height ==` the surface height this degenerates to "content fills the surface".
fn pin_region(content: Box<dyn Element>, top: f32, height: f32) -> Box<dyn Element> {
    let mut kids: Vec<Box<dyn Element>> = Vec::new();
    if top > 0.5 {
        kids.push(Box::new(
            ConstrainedBox::new(Rect::new().finish()).with_height(top),
        ));
    }
    kids.push(Box::new(ConstrainedBox::new(content).with_height(height)));
    Flex::column()
        .with_main_axis_size(MainAxisSize::Max)
        .with_main_axis_alignment(MainAxisAlignment::Start)
        .with_cross_axis_alignment(CrossAxisAlignment::Stretch)
        .with_children(kids)
        .finish()
}

/* ------------------------------------------------------------------
   Root view.
   ------------------------------------------------------------------ */

/// Build one pane's content column from its retained grid + handles: the
/// alt-screen full grid (top-anchored), an inline agent's bottom-anchored live
/// grid (pinned below the AgentChrome strip), or the scroll-back shell transcript
/// (blocks + running-command grid, pinned above the input bar). This was the body
/// of `render` before multi-pane; now called once per visible pane, reading that
/// pane's state. `p` is `&'static` so the selection handler closure can cache
/// into `p.selection`.
fn build_pane_column(p: &'static Pane, mono: FamilyId) -> Box<dyn Element> {
    let agent_on = p.agent_mode.load(std::sync::atomic::Ordering::Relaxed);
    let (pane_x, pane_top, pane_w, pane_h) = p.rect();
    let combined_left = COMBINED.lock().map(|c| c.0).unwrap_or(0.0);
    // This pane's left edge in surface coords — the origin the link hit-test
    // maps a mouse column from. Cleared each render below; populated for the
    // agent grid so `term_native_link_at` can answer Cmd-hover queries.
    let pane_left_surface = (pane_x - combined_left).max(0.0);
    // Vertical offset of THIS pane inside the combined surface. The surface
    // covers the bounding box of all placed panes, and `render` lays them out
    // side-by-side as equal-height columns from the surface top. When two panes
    // have DIFFERENT tops — the right-panel terminal sits below that panel's
    // upper section, so its top is lower than the main column's — the lower pane
    // must be pushed down by (its top − the combined-box top) or its content
    // paints at the surface top, behind the panel's opaque chrome (the "side
    // panel renders nothing" bug). Zero for a single pane and for the topmost.
    let combined_top = COMBINED.lock().map(|c| c.1).unwrap_or(0.0);
    let surface_offset_y = (pane_top - combined_top).max(0.0);
    let mut g = p.grid.lock().unwrap_or_else(|e| e.into_inner());
    let alt_mode = g.alt_screen;
    let cursor_on = g.cursor_visible && g.cursor_row >= 0;
    let cursor_row = g.cursor_row.max(0) as usize;
    let cursor_col = g.cursor_col;
    // Reset hyperlink hit-zones each render; the active branch repopulates them
    // for the agent grid (shell mode leaves them empty — the Cmd-hover cursor is
    // an agent affordance, and shell links still Cmd-click via warpui).
    *p.link_rects.lock().unwrap_or_else(|e| e.into_inner()) = Vec::new();

    if alt_mode {
        // Alt-screen: the app owns a fixed full grid, painted top-down, pushed
        // down by the pane's offset within the combined surface.
        let mut row_els: Vec<Box<dyn Element>> = Vec::with_capacity(g.rows.len());
        for (r, row) in g.rows.iter().enumerate() {
            let cur = if cursor_on && r == cursor_row {
                Some(cursor_col)
            } else {
                None
            };
            row_els.push(build_row(&row.spans, cur, mono));
        }
        // Hyperlink hit-zones for the Cmd-hover cursor. The alt grid is painted
        // top-down from `surface_offset_y` (same origin used in `pin_region`
        // below), so the rects line up with the underlined glyphs.
        *p.link_rects.lock().unwrap_or_else(|e| e.into_inner()) =
            link_rects_for_rows(&g.rows, pane_left_surface, surface_offset_y);
        let grid = Flex::column()
            .with_main_axis_size(MainAxisSize::Max)
            .with_main_axis_alignment(MainAxisAlignment::Start)
            .with_cross_axis_alignment(CrossAxisAlignment::Stretch)
            .with_spacing(0.0)
            .with_children(row_els)
            .finish();
        // Make the alt-screen agent grid selectable, exactly like the shell
        // transcript below. Without this an alt-screen agent (claude's TUI,
        // vim, htop) painted a bare grid the user couldn't drag-select. The
        // injected mouse events from `term_native_mouse` drive warpui's own
        // hit-testing here, and the selection text is cached into
        // `p.selection` so Cmd+C (`term_native_selection_text`) copies it.
        let selectable = SelectableArea::new(
            p.sel.clone(),
            move |args, _ctx, _app| {
                *p.selection.lock().unwrap_or_else(|e| e.into_inner()) =
                    clean_selection_text(args.selection);
            },
            grid,
        );
        // Clip a wide alt grid to the pane. The narrow side pane pins a wide
        // PTY (PAN_MIN_COLS) for shell layout, and an alt-screen TUI paints
        // rows at that full grid width — ConstrainedBox only bounds layout,
        // it doesn't clip painting — so without this the rows draw straight
        // past the pane's right edge, over the neighbouring React panels
        // ("terminal pokes out the side"). Same horizontal ClippedScrollable
        // as the shell transcript below, gated on real overflow.
        let grid_px = g.n_cols as f32 * CELL_ADVANCE;
        let h_overflow = pane_w > 1.0 && grid_px > pane_w + 2.0;
        let clipped: Box<dyn Element> = if h_overflow {
            let max_hscroll = (grid_px - pane_w).max(0.0);
            let hx = p.hscroll.scroll_start().as_f32().clamp(0.0, max_hscroll);
            p.hscroll.scroll_to(Pixels::new(hx));
            let bounded = ConstrainedBox::new(Box::new(selectable)).with_width(grid_px);
            Box::new(
                ClippedScrollable::horizontal(
                    p.hscroll.clone(),
                    Box::new(bounded),
                    ScrollbarWidth::None,
                    Fill::None,
                    Fill::None,
                    Fill::None,
                )
                .with_overlayed_scrollbar(),
            )
        } else {
            Box::new(selectable)
        };
        // Bound the full grid to the pane's height at its surface offset.
        // `pin_region`'s ConstrainedBox gives this MainAxisSize::Max grid a FINITE
        // height; nesting it raw under the side pane's column instead left it in
        // an infinite max constraint and warpui ABORTED (the "claude in the side
        // panel crashes everything" panic at flex/mod.rs:206). `pane_h <= 1`
        // (rect not reported yet — only the topmost pane, briefly) returns the raw
        // grid, which the Stack bounds.
        if pane_h > 1.0 {
            pin_region(clipped, surface_offset_y, pane_h)
        } else {
            clipped
        }
    } else {
        // Shell transcript AND inline agents (claude/codex): closed blocks
        // (oldest first, capped) + the live grid, top→bottom, wrapped for
        // scroll-back — one continuous scroll flow, exactly like Warp. The
        // agent is just the newest content in the stream (NOT a separate
        // live-grid-only mode), so the user can scroll the whole terminal up
        // through history while an agent is foregrounded. The live grid is
        // rendered while a command runs OR an agent owns the pane (`agent_on`),
        // so claude stays visible across the command_running flicker between
        // its turns.
        // VIRTUALIZED. `ClippedScrollable` lays out AND paints its entire child
        // every frame and only THEN clips (see its own doc comment — "by its
        // nature slow"), so building every block made scroll-back O(transcript)
        // per frame and janky on deep history. We instead build only the blocks
        // intersecting the visible window (± one viewport of overscan) and stand
        // in a single fixed-height spacer rect for each off-screen run. Total
        // content height, scroll offset, and clamping stay byte-identical to
        // building everything (each spacer == `est_block_height`, which now
        // matches a block's true laid-out height) — but layout + paint drop to
        // O(viewport).
        let start = 0;
        let mut heights: Vec<f32> = Vec::with_capacity(g.blocks.len());
        let mut content_est = 0.0f32;
        for block in &g.blocks[start..] {
            content_est += block.height;
            heights.push(block.height);
        }
        // The live grid (running command / foregrounded agent) is the active
        // tail — always built (one screen of rows at most, the same cheap cost
        // as the smooth alt-screen path) and stacked last; its height feeds the
        // total so the scroll range stays right while it's pinned to the bottom.
        // Takes `&TermGrid` as an arg (captures nothing of `g`) so it can be
        // called after the `stick_bottom` mutation below.
        let live_on = g.command_running || agent_on;
        let live_count = if live_on {
            live_row_count(&g.rows, cursor_on, cursor_row)
        } else {
            0
        };
        // The in-progress block's scrolled-off rows sit BETWEEN the last closed
        // block and the live grid in the scroll flow (oldest first). Their height
        // feeds the total so the scroll range covers the whole agent conversation.
        let sb_count = g.scrollback.len();
        let sb_height = sb_count as f32 * LINE_PX;
        content_est += live_count as f32 * LINE_PX + sb_height;
        let build_live = |g: &TermGrid| -> Box<dyn Element> {
            let mut row_els: Vec<Box<dyn Element>> = Vec::with_capacity(live_count);
            for (r, row) in g.rows.iter().take(live_count).enumerate() {
                let cur = if cursor_on && r == cursor_row {
                    Some(cursor_col)
                } else {
                    None
                };
                row_els.push(build_row(&row.spans, cur, mono));
            }
            Flex::column()
                .with_spacing(0.0)
                .with_children(row_els)
                .finish()
        };

        let viewport = pane_h;
        if viewport <= 1.0 {
            // Pane height not reported yet — bottom-anchored fallback, build all
            // (only the first frame or two, before React reports the rect).
            let mut children: Vec<Box<dyn Element>> = Vec::with_capacity(heights.len() + 1);
            for block in &g.blocks[start..] {
                children.push(build_block(block, mono, None));
            }
            for row in &g.scrollback {
                children.push(build_row(&row.spans, None, mono));
            }
            if live_on {
                children.push(build_live(&g));
            }
            Flex::column()
                .with_main_axis_size(MainAxisSize::Max)
                .with_main_axis_alignment(MainAxisAlignment::End)
                .with_cross_axis_alignment(CrossAxisAlignment::Stretch)
                .with_spacing(BLOCK_GAP)
                .with_children(children)
                .finish()
        } else {
            let content_vp = {
                let vp = *p.viewport_h.lock().unwrap_or_else(|e| e.into_inner());
                if vp > 1.0 {
                    vp
                } else {
                    viewport
                }
            };
            // The TRUE maximum scroll offset. `est_block_height` is exact, so
            // `content_est - content_vp` IS the bottom — we no longer LEARN it
            // from the scroll handle. That learning raced the user's scroll
            // clearing `stick_bottom`, so on the side pane the learned max never
            // moved off 0 and the bottom re-arm was always satisfied, snapping
            // every scroll straight back to the bottom ("can't scroll").
            let fit_spacer = (content_vp - content_est).max(0.0);
            let max_scroll = (content_est - content_vp).max(0.0);
            g.max_scroll_px = max_scroll;
            if content_est <= content_vp {
                // Everything fits — nothing to scroll, pin to bottom.
                g.stick_bottom = true;
            } else if !g.stick_bottom && g.scroll_px >= max_scroll - 4.0 {
                // Scrolled all the way back down to the bottom — re-arm follow.
                g.stick_bottom = true;
            }
            // Clamp to the real range so a scroll past the end can't satisfy the
            // re-arm above and snap, and a scroll-up can't run negative.
            g.scroll_px = g.scroll_px.clamp(0.0, max_scroll);
            if g.stick_bottom {
                p.scroll.scroll_to(Pixels::new(1.0e9));
            } else {
                p.scroll.scroll_to(Pixels::new(g.scroll_px));
            }

            let win_top = if g.stick_bottom { max_scroll } else { g.scroll_px };
            let overscan = content_vp;
            let build_top = (win_top - overscan).max(0.0);
            let build_bot = win_top + content_vp + overscan;

            // Hyperlink hit-zones for the inline agent's live grid (claude/codex
            // rendering in the normal screen). The live grid is the tail of the
            // content; its top in content space is `content_est - live_height`,
            // shifted by the scroll window and the pane's chrome offset into
            // surface coords — the same transform `pin_region` uses below.
            if agent_on && live_on {
                let live_top_content = (content_est - live_count as f32 * LINE_PX).max(0.0);
                let vtop = *p.viewport_top.lock().unwrap_or_else(|e| e.into_inner());
                let live_top_surface = vtop + surface_offset_y + (live_top_content - win_top);
                let end = live_count.min(g.rows.len());
                *p.link_rects.lock().unwrap_or_else(|e| e.into_inner()) =
                    link_rects_for_rows(&g.rows[..end], pane_left_surface, live_top_surface);
            }

            let mut col_children: Vec<Box<dyn Element>> = Vec::new();
            if fit_spacer > 0.5 {
                col_children.push(spacer_box(fit_spacer));
            }
            // Walk blocks top→bottom; build those intersecting the window,
            // coalescing each off-screen run into one spacer of its summed height.
            let mut y = fit_spacer;
            let mut skipped = 0.0f32;
            for (block, &h) in g.blocks[start..].iter().zip(heights.iter()) {
                let on = (y + h) > build_top && y < build_bot;
                if on {
                    if skipped > 0.5 {
                        col_children.push(spacer_box(skipped));
                        skipped = 0.0;
                    }
                    // Pass the window so a block taller than the viewport only
                    // builds its on-screen rows (row-level virtualization).
                    col_children.push(build_block(block, mono, Some((y, build_top, build_bot))));
                } else {
                    skipped += h;
                }
                y += h;
            }
            if skipped > 0.5 {
                col_children.push(spacer_box(skipped));
            }
            // In-progress command/agent scrolled-off rows (e.g. claude's whole
            // conversation history) sit here, flush between the closed blocks and
            // the live grid. Row-level virtualization, same as a tall block: build
            // only the rows intersecting the window, coalesce the rest into top /
            // bottom spacers. Uniform LINE_PX rows, so the index math is exact.
            if sb_count > 0 {
                let sb_top = y;
                let first =
                    (((build_top - sb_top) / LINE_PX).floor()).clamp(0.0, sb_count as f32) as usize;
                let last =
                    (((build_bot - sb_top) / LINE_PX).ceil()).clamp(0.0, sb_count as f32) as usize;
                if first > 0 {
                    col_children.push(spacer_box(first as f32 * LINE_PX));
                }
                for row in &g.scrollback[first..last] {
                    col_children.push(build_row(&row.spans, None, mono));
                }
                if last < sb_count {
                    col_children.push(spacer_box((sb_count - last) as f32 * LINE_PX));
                }
            }
            if live_on {
                col_children.push(build_live(&g));
            }

            let content = Flex::column()
                .with_main_axis_size(MainAxisSize::Min)
                .with_main_axis_alignment(MainAxisAlignment::Start)
                .with_cross_axis_alignment(CrossAxisAlignment::Stretch)
                .with_spacing(BLOCK_GAP)
                .with_children(col_children)
                .finish();
            let selectable = SelectableArea::new(
                p.sel.clone(),
                move |args, _ctx, _app| {
                    *p.selection.lock().unwrap_or_else(|e| e.into_inner()) =
                        clean_selection_text(args.selection);
                },
                content,
            );
            // Horizontal scroll. When the PTY grid is wider than the pane — the
            // narrow right-panel side terminal pins a wide PTY (PAN_MIN_COLS) so
            // `ls` lays out in columns instead of one-per-line — wrap the content
            // in a horizontal ClippedScrollable so the user can pan to the
            // off-screen columns (`term_native_hscroll` feeds the offset). Gated
            // on real overflow: the main pane is sized to fit, so it skips this
            // and keeps the plain vertical path (and full-width row backgrounds
            // via the column's Stretch).
            //
            // The content is bounded to the EXACT grid width with a ConstrainedBox
            // before the horizontal scroll. Without it the wide rows would lay out
            // under the horizontal scrollable's free (infinite) main-axis width
            // constraint and panic warpui's flex; the bound also fixes the scroll
            // range to (grid_px − pane_w).
            let grid_px = g.n_cols as f32 * CELL_ADVANCE;
            let h_overflow = pane_w > 1.0 && grid_px > pane_w + 2.0;
            let scroll_child: Box<dyn Element> = if h_overflow {
                // Clamp the offset to the real range and mirror it into the handle
                // (the same render-time clamp the vertical axis does for scroll_px).
                let max_hscroll = (grid_px - pane_w).max(0.0);
                let hx = p.hscroll.scroll_start().as_f32().clamp(0.0, max_hscroll);
                p.hscroll.scroll_to(Pixels::new(hx));
                let bounded = ConstrainedBox::new(Box::new(selectable)).with_width(grid_px);
                Box::new(
                    ClippedScrollable::horizontal(
                        p.hscroll.clone(),
                        Box::new(bounded),
                        ScrollbarWidth::None,
                        Fill::None,
                        Fill::None,
                        Fill::None,
                    )
                    .with_overlayed_scrollbar(),
                )
            } else {
                Box::new(selectable)
            };
            let scrollable = ClippedScrollable::vertical(
                p.scroll.clone(),
                scroll_child,
                ScrollbarWidth::None,
                Fill::None,
                Fill::None,
                Fill::None,
            )
            .with_overlayed_scrollbar();
            let viewport_top = *p.viewport_top.lock().unwrap_or_else(|e| e.into_inner());
            // `surface_offset_y` pushes a lower-topped pane (the right-panel
            // terminal) down to its real region within the combined surface;
            // `viewport_top` is the chrome offset within the pane itself.
            pin_region(Box::new(scrollable), viewport_top + surface_offset_y, content_vp)
        }
    }
}

/* ------------------------------------------------------------------
   Root view.
   ------------------------------------------------------------------ */

/// Stateless: reads the pane registry directly (the panes hold all state).
pub struct TerminalRootView {
    mono: FamilyId,
}

impl Entity for TerminalRootView {
    type Event = ();
}

impl View for TerminalRootView {
    fn ui_name() -> &'static str {
        "TerminalRootView"
    }

    fn render(&self, _: &AppContext) -> Box<dyn Element> {
        // Every placed pane (non-trivial rect), laid out left-to-right by
        // reported x: main (or the split's left half), the split's right
        // half (main2), and the right-panel side terminal — any subset of
        // which can be present. The surface covers the combined bounding
        // box; the gaps between panes (React dividers) stay black.
        //
        // NOTE: the MAIN pane keeps its rect even when it's showing a
        // non-terminal tab (editor/diff) — see `term_native_detach` /
        // `term_surface_set_rect`, which detach the pty + clear the grid but
        // DON'T zero the rect. So `main.rect()` is the real main-column box
        // here and the combined surface size is unchanged when a main tab
        // switch lands on an editor. That's what keeps the other terminals
        // in place: the surface never resizes on a main tab switch, it just
        // paints the main column empty/black behind the opaque editor DOM.
        // (A detached main renders an empty grid, hidden.)
        let mut placed: Vec<&'static Pane> =
            panes().iter().filter(|p| p.active()).collect();
        placed.sort_by(|a, b| {
            a.rect()
                .0
                .partial_cmp(&b.rect().0)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let column: Box<dyn Element> = if placed.len() <= 1 {
            // Single (or no) placed pane — degenerate to the plain column,
            // exactly the pre-split single-pane layout. `pane("main")` keeps
            // the startup path (no rect reported yet) painting the main grid.
            let p = placed.first().copied().unwrap_or(pane("main"));
            build_pane_column(p, self.mono)
        } else {
            // Combined surface height. EVERY column must be height-bounded to
            // it: each pane's column is a MainAxisSize::Max flex (it fills the
            // surface, with a lower pane's content pushed down by
            // surface_offset_y), and a Max flex PANICS under an unbounded/
            // infinite max constraint — which is what a width-only
            // ConstrainedBox left the side column with, so a claude/alt-screen
            // full grid in the side pane aborted the app (flex/mod.rs "can't
            // be rendered in an infinite max constraint").
            let mut top = f32::MAX;
            let mut bot = 0.0f32;
            for p in &placed {
                let (_, y, _, h) = p.rect();
                top = top.min(y);
                bot = bot.max(y + h);
            }
            let ch = (bot - top).max(1.0);
            let mut kids: Vec<Box<dyn Element>> = Vec::new();
            for (i, p) in placed.iter().enumerate() {
                let (x, _, w, _) = p.rect();
                // Clamp each column so it can't overlap the next pane — a
                // stale retained main rect (e.g. full-width from before a
                // split opened) must not push its neighbours off the surface.
                let w = match placed.get(i + 1) {
                    Some(n) => w.min((n.rect().0 - x).max(1.0)),
                    None => w,
                };
                kids.push(Box::new(
                    ConstrainedBox::new(build_pane_column(p, self.mono))
                        .with_width(w.max(1.0))
                        .with_height(ch),
                ));
                if let Some(n) = placed.get(i + 1) {
                    let gap = n.rect().0 - (x + w);
                    if gap > 0.5 {
                        kids.push(Box::new(
                            ConstrainedBox::new(Rect::new().finish()).with_width(gap),
                        ));
                    }
                }
            }
            Flex::row()
                .with_main_axis_size(MainAxisSize::Max)
                .with_cross_axis_alignment(CrossAxisAlignment::Stretch)
                .with_children(kids)
                .finish()
        };

        Stack::new()
            .with_child(Rect::new().with_background_color(ColorU::black()).finish())
            .with_child(column)
            .finish()
    }
}

impl TypedActionView for TerminalRootView {
    type Action = ();
}

/// Load a monospace family, preferring SF Mono → Menlo → Monaco.
fn load_mono(cx: &mut ViewContext<TerminalRootView>) -> FamilyId {
    warpui::fonts::Cache::handle(cx).update(cx, |cache, _| {
        ["SF Mono", "Menlo", "Monaco"]
            .iter()
            .find_map(|n| cache.get_or_load_system_font(n).ok())
            .unwrap_or(FamilyId(0))
    })
}

/* ------------------------------------------------------------------
   Attach + commands.
   ------------------------------------------------------------------ */

/// Stand up the embedded warpui surface and wire the in-process frame path.
/// Call once from the Tauri `.setup()` on the main thread.
pub fn attach(app: &tauri::AppHandle) {
    use tauri::Manager as _;

    let _ = APP_HANDLE.set(app.clone());

    // Register the frame sink BEFORE any pty starts. Runs on the PTY reader
    // thread: patch the shared grid, then poke a redraw on the main thread.
    let app_for_sink = app.clone();
    crate::term::set_native_frame_sink(Box::new(move |pty_id: &str, frame: &RenderFrame| {
        let routing = GRID_ROUTING.lock().unwrap_or_else(|e| e.into_inner());
        // Route the frame to whichever pane mirrors this pty (main or side).
        let visible = if let Some(p) = pane_for_pty(pty_id) {
            let mut g = p.grid.lock().unwrap_or_else(|e| e.into_inner());
            // Alt-screen scroll-glue: an alt-screen app (git log / less / man /
            // vim / htop) repaints its grid in place when it scrolls, so a
            // completed selection anchored to fixed grid coordinates would slide
            // off the text it was started on. Measure how far the grid ACTUALLY
            // scrolled (content match — robust to the app's rows-per-wheel-notch,
            // which the old React-side line-count guess got wrong) and shift the
            // selection to track it. Gated to when something is actually selected
            // AND the app owns the screen: the normal shell/inline-agent
            // transcript glues for free (its SelectableArea lives inside the
            // ClippedScrollable, whose scroll translation already moves the
            // selection with the content), so we must NOT double-shift it here.
            let detect = frame.alt_screen && p.sel.has_selection();
            let old_rows = if detect { g.rows.clone() } else { Vec::new() };
            let retain_unscoped_scrollback = g.retain_unscoped_scrollback
                || p.agent_mode.load(std::sync::atomic::Ordering::Relaxed);
            g.apply_frame(frame, retain_unscoped_scrollback);
            if detect {
                let k = detect_scroll_shift(&old_rows, &g.rows);
                if k != 0 {
                    p.sel.shift_relative_y(-(k as f32) * LINE_PX);
                }
            }
            true
        } else {
            // Hidden PTYs update only their retained Rust model. No AppKit
            // redraw is scheduled, so the 4 Hz hidden cadence does not create
            // main-thread work; it simply makes the next switch warm.
            let mut cache = hidden_grids().lock().unwrap_or_else(|e| e.into_inner());
            let g = cache
                .entry(pty_id.to_string())
                .or_insert_with(TermGrid::empty);
            let retain_unscoped_scrollback = g.retain_unscoped_scrollback;
            g.apply_frame(frame, retain_unscoped_scrollback);
            false
        };
        drop(routing);
        if visible {
            let _ = app_for_sink.run_on_main_thread(|| {
                warpui::platform::poke_embedded_redraw();
            });
        }
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        // Dev-only off-screen snapshot, gated behind WARP_CAPTURE (off by
        // default). The PNG encode + disk write runs on the main thread, so
        // leaving it on injects a periodic multi-ms hitch during output bursts —
        // bad for the 120fps / smooth-throughput budget. Set WARP_CAPTURE=1 to
        // re-enable for render debugging.
        if visible
            && (n == 4 || n == 12 || (n > 0 && n % 60 == 0))
            && std::env::var("WARP_CAPTURE").is_ok()
        {
            if let Some(wid) = CAPTURE_WID.lock().ok().and_then(|g| *g) {
                let _ = app_for_sink.run_on_main_thread(move || {
                    warpui::platform::capture_embedded(
                        wid,
                        Box::new(|frame| save_capture_png(&frame, "/tmp/warpui_capture.png")),
                    );
                });
            }
        }
    }));

    // Block sink: append each finished command block to the shared model and
    // poke a redraw. Runs on the PTY reader thread, like the frame sink.
    let app_for_block = app.clone();
    crate::term::set_native_block_sink(Box::new(move |pty_id: &str, block: &ClosedBlock| {
        let routing = GRID_ROUTING.lock().unwrap_or_else(|e| e.into_inner());
        let visible = if let Some(p) = pane_for_pty(pty_id) {
            let mut g = p.grid.lock().unwrap_or_else(|e| e.into_inner());
            g.blocks.push(NativeBlock::new(
                block.block_id,
                block.input.clone(),
                block.block_rows.clone(),
                block.transcript.clone(),
                block.cwd.clone(),
                block.duration_ms,
                block.exit_code,
            ));
            true
        } else {
            let mut cache = hidden_grids().lock().unwrap_or_else(|e| e.into_inner());
            let g = cache
                .entry(pty_id.to_string())
                .or_insert_with(TermGrid::empty);
            if !g.blocks.iter().any(|b| b.block_id == block.block_id) {
                g.blocks.push(NativeBlock::new(
                    block.block_id,
                    block.input.clone(),
                    block.block_rows.clone(),
                    block.transcript.clone(),
                    block.cwd.clone(),
                    block.duration_ms,
                    block.exit_code,
                ));
            }
            false
        };
        drop(routing);
        if visible {
            let _ = app_for_block.run_on_main_thread(|| {
                warpui::platform::poke_embedded_redraw();
            });
        }
    }));

    let parent = app
        .get_webview_window("main")
        .and_then(|w| w.ns_window().ok())
        .unwrap_or(std::ptr::null_mut());

    warpui::platform::AppBuilder::new(
        warpui::platform::AppCallbacks::default(),
        Box::new(TermAssets),
        None,
    )
    .attach_embedded(parent, |ctx| {
        let (window_id, _view) = ctx.add_window(warpui::AddWindowOptions::default(), |cx| {
            let mono = load_mono(cx);
            TerminalRootView { mono }
        });
        if let Ok(mut w) = CAPTURE_WID.lock() {
            *w = Some(window_id);
        }
    });

    // Dev self-test (WARP_SELFTEST=1): since a headless agent can't drive the
    // macOS mouse, synthesize a drag over the shell transcript once it has
    // rendered, then log the extracted selection text and (with WARP_CAPTURE=1)
    // snapshot the frame so the highlight can be inspected. Verifies the whole
    // inject -> SelectableArea -> highlight/extract chain end-to-end.
    if std::env::var("WARP_SELFTEST").is_ok() {
        let app_for_test = app.clone();
        std::thread::spawn(move || {
            use std::time::Duration;
            // Wait for a pty to attach + the surface to size + content to paint.
            let mut waited = 0u32;
            loop {
                std::thread::sleep(Duration::from_millis(500));
                waited += 500;
                let h = pane("main").rect().3;
                if (h > 50.0 && waited >= 2000) || waited > 9000 {
                    break;
                }
            }
            // If the rect was never reported (the dev window can launch
            // unfocused → WarpSurfaceTracker's rAF is paused → no set_rect), the
            // render would stay on the no-selection fallback path. Force a
            // viewport so the SelectableArea path engages, then repaint before
            // injecting. (In real use the window is focused and set_rect fires.)
            let mp = pane("main");
            let h = {
                let mut r = mp.rect.lock().unwrap_or_else(|e| e.into_inner());
                if r.3 <= 50.0 {
                    *r = (0.0, 0.0, 800.0, 800.0);
                }
                r.3 as f64
            };
            // Also simulate the transcript region (above the input bar) at 80% of
            // the surface, so the test exercises the Warp-style bottom inset:
            // content should occupy only the top `vp` px, the rest black.
            let vp = {
                let mut g = mp.viewport_h.lock().unwrap_or_else(|e| e.into_inner());
                if *g <= 50.0 {
                    *g = (h * 0.8) as f32;
                }
                *g as f64
            };
            let _ = app_for_test.run_on_main_thread(|| warpui::platform::poke_embedded_redraw());
            std::thread::sleep(Duration::from_millis(300));
            let Some(wid) = CAPTURE_WID.lock().ok().and_then(|g| *g) else {
                eprintln!("[selftest] no window id; aborting");
                return;
            };
            eprintln!("[selftest] injecting drag over transcript (surface_h={h} viewport_h={vp})");
            use warpui::platform::EmbeddedMouseKind as K;
            // Drag from low-left up toward the right within the transcript region
            // [0, vp] — sweeps a multi-line swath of the newest content.
            let steps: [(K, f64, f64); 4] = [
                (K::Down, 24.0, vp - 28.0),
                (K::Dragged, 220.0, vp * 0.6),
                (K::Dragged, 420.0, 48.0),
                (K::Up, 420.0, 48.0),
            ];
            for (k, x, y) in steps {
                let _ = app_for_test.run_on_main_thread(move || {
                    warpui::platform::dispatch_embedded_mouse(
                        wid, k, x, y, 1, false, false, false, false,
                    );
                });
                std::thread::sleep(Duration::from_millis(150));
            }
            std::thread::sleep(Duration::from_millis(200));
            let sel = mp
                .selection
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .map(|s| s.chars().take(200).collect::<String>());
            eprintln!("[selftest] extracted selection ({:?} chars): {:?}", sel.as_ref().map(|s| s.len()), sel);
            let _ = app_for_test.run_on_main_thread(move || {
                warpui::platform::capture_embedded(
                    wid,
                    Box::new(|frame| save_capture_png(&frame, "/tmp/warpui_selftest.png")),
                );
            });
            std::thread::sleep(Duration::from_millis(300));

            // Agent-mode capture: flip the main pane into agent mode and snapshot
            // so the agent grid's bottom-anchor + viewport pinning can be
            // inspected off-screen (the "claude spawns half above the viewport"
            // report). Uses the real shell grid content already loaded above.
            {
                let mp = pane("main");
                mp.agent_mode
                    .store(true, std::sync::atomic::Ordering::Relaxed);
                let _ =
                    app_for_test.run_on_main_thread(|| warpui::platform::poke_embedded_redraw());
                std::thread::sleep(Duration::from_millis(300));
                let vt = *mp.viewport_top.lock().unwrap_or_else(|e| e.into_inner());
                let vh = *mp.viewport_h.lock().unwrap_or_else(|e| e.into_inner());
                eprintln!("[selftest] agent-mode capture: viewport_top={vt} viewport_h={vh}");
                if let Some(wid) = CAPTURE_WID.lock().ok().and_then(|g| *g) {
                    let _ = app_for_test.run_on_main_thread(move || {
                        warpui::platform::capture_embedded(
                            wid,
                            Box::new(|frame| save_capture_png(&frame, "/tmp/warpui_agent.png")),
                        );
                    });
                }
                std::thread::sleep(Duration::from_millis(500));
                mp.agent_mode
                    .store(false, std::sync::atomic::Ordering::Relaxed);
            }
        });
    }
}

/// Tauri command: report a pane's on-screen rect (CSS px from the webview
/// top-left), reported by each pane's `WarpSurfaceTracker`. Stored per pane; the
/// single embedded surface is then repositioned to cover the combined bounding
/// box of all placed panes (just the main pane's rect when the side is closed).
#[tauri::command]
pub fn term_surface_set_rect(pane_key: String, x: f64, y: f64, width: f64, height: f64) {
    let p = pane(&pane_key);
    let zero = width <= 1.0 || height <= 1.0;
    // The MAIN pane keeps its last real rect across a zero report. Its
    // `WarpSurfaceTracker` reports (0,0,0,0) whenever a non-terminal tab
    // (editor/diff/markdown) is active — but the main column ALWAYS sits behind
    // either a transparent terminal-hole or an OPAQUE non-terminal DOM panel, so
    // the surface covering that box is never visible when no terminal is there.
    // Keeping the rect means the combined surface DOESN'T resize on a main tab
    // switch (the detached pane just paints empty/black behind the editor), which
    // is what stops the right-panel side terminal from blanking / shrinking: the
    // shared GPU surface is fragile to resize, and a zeroed main both collapsed
    // the box AND broke the side's side-by-side gap math. The side pane is NOT
    // retained — collapsing the right panel SHOULD shrink the surface. Neither
    // is main2 (the split's right half): closing the split zero-reports it,
    // and retaining would leave a stale column painting over the re-widened
    // main pane.
    let is_main = pane_key != "side" && pane_key != "main2";
    if is_main && zero {
        // Drop the stale report; keep the prior rect.
    } else if let Ok(mut r) = p.rect.lock() {
        *r = (x as f32, y as f32, width as f32, height as f32);
    }
    reposition_surface();
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.run_on_main_thread(|| warpui::platform::poke_embedded_redraw());
    }
}

/// Tauri command: point the native surface at `id`'s pty (the active terminal
/// tab). The retained model moves with the PTY, making a warm instance switch
/// an in-memory state swap rather than a synchronous full-history SQLite read.
#[tauri::command]
pub fn term_native_attach(
    pane_key: String,
    id: String,
    state: tauri::State<crate::term::TerminalState>,
) {
    let routing = GRID_ROUTING.lock().unwrap_or_else(|e| e.into_inner());
    let p = pane(&pane_key);
    let prev = p.pty_id();

    // React effects can legitimately republish the same attachment. Keep this
    // path fully idempotent: clearing/rebuilding an already-visible Codex grid
    // is both unnecessary and conspicuously slow with deep scrollback.
    if prev == id {
        crate::term::set_native_pty(&id);
        drop(routing);
        crate::term::reemit_native(&state, &id);
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.run_on_main_thread(|| warpui::platform::poke_embedded_redraw());
        }
        return;
    }

    // Grab the incoming model before changing pane ownership. During a split
    // swap it may still live in the sibling pane; otherwise it comes from the
    // hidden cache (or starts empty on the first visit).
    let next_grid = take_retained_grid(&id, p);
    let needs_history = !next_grid.history_loaded;

    // Preserve the outgoing model, including live Codex scrollback and scroll
    // position, then publish the new pane owner.
    stash_pane_grid(&prev, p);
    // Attach may reuse a pane that was previously showing an agent. Clear the
    // old mode before the first re-emit so a new shell cannot inherit the prior
    // PTY's unscoped-scrollback policy; BlockTerminal immediately publishes the
    // correct mode for the newly attached target.
    p.agent_mode
        .store(false, std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut g) = p.pty.lock() {
        g.clear();
        g.push_str(&id);
    }
    // Unregister the previous pty ONLY if no other pane mirrors it now.
    // When two terminals swap halves (main ⇄ main2) the two attach calls
    // land back-to-back, and the second pane's "previous" pty is exactly
    // the one the first pane just claimed — clearing it unconditionally
    // froze that pane (frames stopped reaching the sink).
    if !prev.is_empty() && prev != id && panes().iter().all(|q| q.pty_id() != prev) {
        crate::term::clear_native_pty(&prev);
    }
    crate::term::set_native_pty(&id);
    {
        let mut g = p.grid.lock().unwrap_or_else(|e| e.into_inner());
        *g = next_grid;
    }
    drop(routing);
    // Repaint immediately from the pty's current grid (no-op if it hasn't
    // started yet — the first `term_start` frame fills the surface then).
    crate::term::reemit_native(&state, &id);
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.run_on_main_thread(|| warpui::platform::poke_embedded_redraw());
    }
    if needs_history {
        hydrate_history_in_background(id);
    }
}

/// Tauri command: stop mirroring any pty (a non-terminal tab is active). Clears
/// the pty + retained grid so the pane paints empty/black. For the MAIN pane the
/// rect is deliberately KEPT (not zeroed) so the combined surface doesn't resize
/// on a tab switch — see `term_surface_set_rect` for the full rationale. The
/// empty main pane then paints black behind the opaque editor DOM, while the
/// side terminal keeps its place. The side pane still zeroes (collapsing the
/// right panel should shrink the surface).
#[tauri::command]
pub fn term_native_detach(pane_key: String) {
    let routing = GRID_ROUTING.lock().unwrap_or_else(|e| e.into_inner());
    let p = pane(&pane_key);
    let prev = p.pty_id();
    stash_pane_grid(&prev, p);
    if let Ok(mut g) = p.pty.lock() {
        g.clear();
    }
    // Same other-pane guard as `term_native_attach`: during a half-swap the
    // pty this pane is letting go of may have just been claimed by another
    // pane — don't yank its frames.
    if !prev.is_empty() && panes().iter().all(|q| q.pty_id() != prev) {
        crate::term::clear_native_pty(&prev);
    }
    if pane_key == "side" || pane_key == "main2" {
        if let Ok(mut r) = p.rect.lock() {
            *r = (0.0, 0.0, 0.0, 0.0);
        }
    }
    drop(routing);
    reposition_surface();
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.run_on_main_thread(|| warpui::platform::poke_embedded_redraw());
    }
}

/// Tauri command: report whether the active pane is in agent mode (foreground
/// agent / alt-screen with the React input in raw passthrough). Keeps the live
/// grid painting across the agent-exit debounce so a killed agent's shell
/// prompt stays visible — see `AGENT_MODE`.
#[tauri::command]
pub fn term_native_set_agent_mode(
    pane_key: String,
    active: bool,
    state: tauri::State<crate::term::TerminalState>,
) {
    let routing = GRID_ROUTING.lock().unwrap_or_else(|e| e.into_inner());
    let p = pane(&pane_key);
    let was_active = p
        .agent_mode
        .swap(active, std::sync::atomic::Ordering::Relaxed);
    {
        let mut g = p.grid.lock().unwrap_or_else(|e| e.into_inner());
        g.retain_unscoped_scrollback = active;
    }
    let id = p.pty_id();
    drop(routing);
    // A directly-launched agent has no parent shell and therefore no OSC 133
    // block id. Frames that arrived before this mode bit was set could only
    // retain the visible grid. Re-emit the complete PTY snapshot on the false →
    // true edge so all pre-existing normal-screen history becomes scrollable.
    if active && !was_active {
        if !id.is_empty() {
            crate::term::reemit_native_unscoped_agent(&state, &id);
        }
    }
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.run_on_main_thread(|| warpui::platform::poke_embedded_redraw());
    }
}

/// Tauri command: forward a wheel delta (CSS px, +down/newer) from the React
/// overlay to the native shell-transcript scroll-back. The embedded child window
/// has `ignoresMouseEvents: YES`, so the webview captures the wheel and relays it
/// here. The delta is applied to `TermGrid`'s canonical offset/range rather than
/// the renderer handle: while pinned, that handle briefly carries a 1e9 sentinel
/// until layout clamps it, and reading it during that window made upward wheel
/// gestures snap straight back to the bottom. Render re-arms follow mode once
/// scrolled back down or when the content fits.
#[tauri::command]
pub fn term_native_scroll(pane_key: String, delta_px: f64) {
    let p = pane(&pane_key);
    {
        let mut g = p.grid.lock().unwrap_or_else(|e| e.into_inner());
        g.scroll_by(delta_px as f32);
    }
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.run_on_main_thread(|| warpui::platform::poke_embedded_redraw());
    }
}

/// Tauri command: pan the native shell transcript horizontally. Only meaningful
/// for a pane whose PTY grid is wider than its on-screen width (the narrow
/// right-panel side terminal); render bounds the offset to the real range and is
/// a no-op when the content fits (no horizontal ClippedScrollable is built).
/// Mirrors `term_native_scroll` on the X axis — accumulate, clamp ≥ 0 here, and
/// the render-time clamp caps it at (grid width − pane width).
#[tauri::command]
pub fn term_native_hscroll(pane_key: String, delta_px: f64) {
    let p = pane(&pane_key);
    let cur = p.hscroll.scroll_start().as_f32();
    p.hscroll
        .scroll_to(Pixels::new((cur + delta_px as f32).max(0.0)));
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.run_on_main_thread(|| warpui::platform::poke_embedded_redraw());
    }
}

/// Tauri command: forward a left-mouse event (captured by the React overlay over
/// the transparent pane) into the native surface, so warpui's hit-testing +
/// selection runs on it. `(x, y)` are WINDOW-content CSS px (clientX/clientY);
/// we subtract the combined surface origin to get surface-local coords, so the
/// event lands in the correct pane's region (warpui hit-tests by position). No
/// pane key needed — the coordinates route it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn term_native_mouse(
    kind: String,
    x: f64,
    y: f64,
    click_count: u32,
    shift: bool,
    cmd: bool,
    alt: bool,
    ctrl: bool,
) {
    let Some(wid) = CAPTURE_WID.lock().ok().and_then(|g| *g) else {
        return;
    };
    let (ox, oy) = COMBINED
        .lock()
        .map(|c| (c.0 as f64, c.1 as f64))
        .unwrap_or((0.0, 0.0));
    let (sx, sy) = (x - ox, y - oy);
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.run_on_main_thread(move || {
            use warpui::platform::EmbeddedMouseKind as K;
            let k = match kind.as_str() {
                "down" => K::Down,
                "drag" => K::Dragged,
                _ => K::Up,
            };
            warpui::platform::dispatch_embedded_mouse(
                wid,
                k,
                sx,
                sy,
                click_count,
                shift,
                cmd,
                alt,
                ctrl,
            );
        });
    }
}

/// Tauri command: the latest selected transcript text (cached by the
/// `SelectableArea` selection handler), or `None` if nothing is selected. React
/// reads this on Cmd+C in the shell and writes it to the clipboard via the
/// existing pbcopy path.
#[tauri::command]
pub fn term_native_selection_text(pane_key: String) -> Option<String> {
    pane(&pane_key)
        .selection
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .filter(|s| !s.is_empty())
}

/// Tauri command: is a detected hyperlink under this window-content point?
/// React polls this (rAF-throttled) while Cmd is held so it can flip the pane
/// cursor to a pointing hand over a link — the embedded surface has
/// `ignoresMouseEvents: YES`, so the macOS cursor is owned by the DOM and must
/// be driven from JS. `(x, y)` are clientX/clientY; we subtract the combined
/// surface origin to match the render-time rects (surface coords).
#[tauri::command]
pub fn term_native_link_at(pane_key: String, x: f64, y: f64) -> bool {
    let p = pane(&pane_key);
    let (ox, oy) = COMBINED
        .lock()
        .map(|c| (c.0 as f64, c.1 as f64))
        .unwrap_or((0.0, 0.0));
    let (sx, sy) = ((x - ox) as f32, (y - oy) as f32);
    p.link_rects
        .lock()
        .map(|rects| {
            rects
                .iter()
                .any(|&(x0, y0, x1, y1)| sx >= x0 && sx < x1 && sy >= y0 && sy < y1)
        })
        .unwrap_or(false)
}

/// Tauri command: report the transcript region height (CSS px) — the React
/// scroll container that sits above the input bar + status strip. Pins the
/// native shell transcript to this region so the newest block lands just above
/// the input (Warp layout) instead of behind it.
#[tauri::command]
pub fn term_native_set_viewport(pane_key: String, top: f64, height: f64) {
    let p = pane(&pane_key);
    if let Ok(mut t) = p.viewport_top.lock() {
        *t = top as f32;
    }
    if let Ok(mut h) = p.viewport_h.lock() {
        *h = height as f32;
    }
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.run_on_main_thread(|| warpui::platform::poke_embedded_redraw());
    }
}

#[cfg(test)]
mod scroll_shift_tests {
    use super::*;

    fn plain_span(text: &str) -> Span {
        Span {
            text: text.to_string(),
            fg: "var(--text-primary)".into(),
            bg: "var(--surface-0)".into(),
            bold: false,
            italic: false,
            underline: false,
            inverse: false,
            dim: false,
            strikeout: false,
            link: None,
        }
    }
    fn rows(lines: &[&str]) -> Vec<RowSnapshot> {
        lines
            .iter()
            .map(|l| RowSnapshot {
                spans: vec![plain_span(l)],
            })
            .collect()
    }

    fn scrollback_frame(text: &str, reset: bool) -> RenderFrame {
        RenderFrame {
            seq: 1,
            block_id: 0,
            cols: 80,
            rows: 24,
            cursor_row: 0,
            cursor_col: 0,
            alt_screen: false,
            command_running: false,
            app_cursor: false,
            bracketed_paste: false,
            cursor_visible: true,
            raw_input: true,
            dirty: Vec::new(),
            scrollback_appended: vec![crate::term::DirtyRow {
                row: 0,
                spans: vec![plain_span(text)],
            }],
            scrollback_reset: reset,
        }
    }

    #[test]
    fn direct_agent_retains_scrollback_without_shell_block_id() {
        let mut grid = TermGrid::empty();
        let first = scrollback_frame("oldest", true);

        // An idle shell has the same block_id=0 shape, but its closed blocks
        // already own history, so it must not duplicate raw PTY scrollback.
        grid.apply_frame(&first, false);
        assert!(grid.scrollback.is_empty());

        // Explicit agent mode distinguishes a direct-launched Codex/Claude
        // session and retains the exact same unscoped frame.
        grid.apply_frame(&first, true);
        grid.apply_frame(&scrollback_frame("newer", false), true);
        assert_eq!(grid.scrollback.len(), 2);
        assert_eq!(grid.scrollback[0].spans[0].text, "oldest");
        assert_eq!(grid.scrollback[1].spans[0].text, "newer");
    }

    #[test]
    fn upward_scroll_from_pinned_bottom_uses_real_range_not_render_sentinel() {
        let mut grid = TermGrid::empty();
        // Render has established an 800px scroll range. While stick_bottom is
        // true, the renderer handle itself may still contain its temporary 1e9
        // sentinel; scroll_by must be independent of that handle.
        grid.max_scroll_px = 800.0;
        grid.scroll_px = 0.0;
        grid.stick_bottom = true;

        grid.scroll_by(-120.0);

        assert_eq!(grid.scroll_px, 680.0);
        assert!(!grid.stick_bottom);
    }

    #[test]
    fn scroll_delta_clamps_to_transcript_bounds() {
        let mut grid = TermGrid::empty();
        grid.max_scroll_px = 500.0;
        grid.scroll_px = 200.0;
        grid.stick_bottom = false;

        grid.scroll_by(-1_000.0);
        assert_eq!(grid.scroll_px, 0.0);
        grid.scroll_by(1_000.0);
        assert_eq!(grid.scroll_px, 500.0);

        grid.max_scroll_px = 0.0;
        grid.scroll_by(-100.0);
        assert_eq!(grid.scroll_px, 0.0);
        assert!(grid.stick_bottom);
    }

    #[test]
    fn scroll_down_shifts_content_up() {
        // Ten distinct rows; the app scrolls DOWN by 3 (content moves up 3, three
        // fresh rows appear at the bottom). new[i] == old[i+3] for the retained
        // rows, so the measured shift is +3.
        let old = rows(&[
            "r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9",
        ]);
        let new = rows(&[
            "r3", "r4", "r5", "r6", "r7", "r8", "r9", "n7", "n8", "n9",
        ]);
        assert_eq!(detect_scroll_shift(&old, &new), 3);
    }

    #[test]
    fn scroll_up_shifts_content_down() {
        // The app scrolls UP by 2 (content moves down 2, two older rows appear at
        // the top). new[i] == old[i-2] → measured shift is -2.
        let old = rows(&[
            "r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9",
        ]);
        let new = rows(&[
            "p0", "p1", "r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7",
        ]);
        assert_eq!(detect_scroll_shift(&old, &new), -2);
    }

    #[test]
    fn identical_grids_report_no_scroll() {
        let g = rows(&["a", "b", "c", "d", "e", "f", "g", "h"]);
        assert_eq!(detect_scroll_shift(&g, &g), 0);
    }

    #[test]
    fn spinner_tick_reports_no_scroll() {
        // Only one row changes (a spinner glyph / streamed char). Staying put
        // explains far more rows than any shift, so no shift is reported — this
        // is what keeps a completed selection from jumping on a non-scroll frame.
        let old = rows(&["a", "b", "c", "d", "e", "f", "g", "loading |"]);
        let new = rows(&["a", "b", "c", "d", "e", "f", "g", "loading /"]);
        assert_eq!(detect_scroll_shift(&old, &new), 0);
    }

    #[test]
    fn full_page_swap_reports_no_scroll() {
        // A page jump replaces every row with unrelated content — no offset lines
        // anything up, so we conservatively report no scroll rather than guess.
        let old = rows(&["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"]);
        let new = rows(&["z0", "z1", "z2", "z3", "z4", "z5", "z6", "z7"]);
        assert_eq!(detect_scroll_shift(&old, &new), 0);
    }

    #[test]
    fn blank_rows_do_not_inflate_a_false_shift() {
        // A grid that is mostly blank with a couple of content rows must not
        // report a shift just because the blank rows "match" at every offset.
        let old = rows(&["", "", "hello", "world", "", "", "", ""]);
        let new = rows(&["", "", "hello", "world", "", "", "", ""]);
        assert_eq!(detect_scroll_shift(&old, &new), 0);
    }

    #[test]
    fn ignores_color_only_changes() {
        // A pager re-coloring its current line (same text, different style) is not
        // a scroll. row_text compares glyphs only, so this stays at 0.
        let old = vec![
            RowSnapshot { spans: vec![plain_span("line one")] },
            RowSnapshot { spans: vec![plain_span("line two")] },
            RowSnapshot { spans: vec![plain_span("line three")] },
            RowSnapshot { spans: vec![plain_span("line four")] },
            RowSnapshot { spans: vec![plain_span("line five")] },
        ];
        let mut recolored = plain_span("line three");
        recolored.inverse = true;
        let new = vec![
            RowSnapshot { spans: vec![plain_span("line one")] },
            RowSnapshot { spans: vec![plain_span("line two")] },
            RowSnapshot { spans: vec![recolored] },
            RowSnapshot { spans: vec![plain_span("line four")] },
            RowSnapshot { spans: vec![plain_span("line five")] },
        ];
        assert_eq!(detect_scroll_shift(&old, &new), 0);
    }

    #[test]
    fn tiny_grids_bail_out() {
        let old = rows(&["a", "b", "c"]);
        let new = rows(&["b", "c", "d"]);
        assert_eq!(detect_scroll_shift(&old, &new), 0);
    }
}

#[cfg(test)]
mod instance_switch_tests {
    use super::*;

    fn saved(block_id: i64, input: &str) -> crate::persistence::SavedBlock {
        crate::persistence::SavedBlock {
            block_id,
            input: input.to_string(),
            transcript: format!("output-{block_id}"),
            block_rows_json: serde_json::json!([]),
            exit_code: Some(0),
            cwd: Some("/tmp/project".into()),
            duration_ms: Some(1),
        }
    }

    #[test]
    fn background_history_merge_preserves_blocks_closed_during_read() {
        let mut grid = TermGrid::empty();
        // Block 2 appears in both the DB result and the live cache (the writer
        // committed while hydration was in flight); block 3 exists only in the
        // live cache. The merge must dedupe 2 without losing 3.
        grid.blocks.push(native_block_from_saved(saved(2, "cached-two")));
        grid.blocks.push(native_block_from_saved(saved(3, "cached-three")));

        merge_saved_history(&mut grid, vec![saved(1, "saved-one"), saved(2, "saved-two")]);

        assert_eq!(
            grid.blocks.iter().map(|b| b.block_id).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert!(grid.history_loaded);
    }

    #[test]
    fn attach_never_reads_sqlite_on_the_instance_switch_path() {
        let source = include_str!("warp_term.rs");
        let attach = source
            .split("pub fn term_native_attach")
            .nth(1)
            .and_then(|tail| tail.split("pub fn term_native_detach").next())
            .expect("term_native_attach source");

        assert!(attach.contains("take_retained_grid"));
        assert!(attach.contains("hydrate_history_in_background"));
        assert!(
            !attach.contains("load_blocks"),
            "instance switching must never synchronously rebuild history from SQLite"
        );
    }
}

#[cfg(test)]
mod link_tests {
    use super::*;

    fn span(text: &str) -> Span {
        Span {
            text: text.to_string(),
            fg: "var(--text-primary)".into(),
            bg: "var(--surface-0)".into(),
            bold: false,
            italic: false,
            underline: false,
            inverse: false,
            dim: false,
            strikeout: false,
            link: None,
        }
    }
    fn chars(s: &str) -> Vec<char> {
        s.chars().collect()
    }

    #[test]
    fn finds_https_url() {
        let text = "go to https://example.com/x now";
        let r = find_url_ranges(&chars(text));
        assert_eq!(r.len(), 1);
        let (s, e) = r[0];
        let got: String = text.chars().collect::<Vec<_>>()[s..e].iter().collect();
        assert_eq!(got, "https://example.com/x");
    }

    #[test]
    fn trims_trailing_prose_punctuation() {
        // A trailing period / close-paren is prose, not part of the URL.
        let text = "(see https://example.com).";
        let r = find_url_ranges(&chars(text));
        assert_eq!(r.len(), 1);
        let (s, e) = r[0];
        let got: String = text.chars().collect::<Vec<_>>()[s..e].iter().collect();
        assert_eq!(got, "https://example.com");
    }

    #[test]
    fn ignores_non_urls_and_bare_http_word() {
        assert!(find_url_ranges(&chars("just some text, no links")).is_empty());
        // "http" without "://" is not a URL.
        assert!(find_url_ranges(&chars("the http protocol")).is_empty());
    }

    #[test]
    fn split_links_isolates_url_run() {
        let spans = vec![span("see "), span("https://a.com"), span(" ok")];
        let out = split_links(&spans);
        let linked: Vec<&Span> = out.iter().filter(|s| s.link.is_some()).collect();
        assert_eq!(linked.len(), 1);
        assert_eq!(linked[0].text, "https://a.com");
        assert!(linked[0].underline, "link run must be underlined");
        // Non-link text is preserved and unlinked.
        let joined: String = out.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(joined, "see https://a.com ok");
    }

    #[test]
    fn split_links_handles_url_spanning_multiple_style_runs() {
        // A URL whose characters are split across two color runs still collapses
        // into one linked run.
        let spans = vec![span("https://ex"), span("ample.com")];
        let out = split_links(&spans);
        let linked: Vec<&Span> = out.iter().filter(|s| s.link.is_some()).collect();
        assert_eq!(linked.iter().map(|s| s.text.clone()).collect::<String>(), "https://example.com");
        assert!(linked.iter().all(|s| s.link.as_deref() == Some("https://example.com")));
    }

    #[test]
    fn link_rects_align_to_grid_cells() {
        // One row, URL at columns [4, 4+len). Rect x spans those columns at the
        // given origin; y is the row band.
        let url = "https://a.com";
        let row = RowSnapshot { spans: vec![span("cmd "), span(url)] };
        let rects = link_rects_for_rows(std::slice::from_ref(&row), 100.0, 50.0);
        assert_eq!(rects.len(), 1);
        let (x0, y0, x1, y1) = rects[0];
        assert!((x0 - (100.0 + 4.0 * CELL_ADVANCE)).abs() < 0.01, "x0={x0}");
        assert!((x1 - (100.0 + (4 + url.chars().count()) as f32 * CELL_ADVANCE)).abs() < 0.01, "x1={x1}");
        assert!((y0 - 50.0).abs() < 0.01);
        assert!((y1 - (50.0 + LINE_PX)).abs() < 0.01);
    }

    #[test]
    fn link_rects_empty_when_no_url() {
        let row = RowSnapshot { spans: vec![span("no links here")] };
        assert!(link_rects_for_rows(std::slice::from_ref(&row), 0.0, 0.0).is_empty());
    }

    #[test]
    fn clean_selection_trims_row_padding_only() {
        // Grid rows arrive padded to the terminal width with spaces; that
        // trailing pad is stripped per line. Leading + interior spacing (the
        // user's real indentation/alignment) survives byte-for-byte, and
        // blank rows stay as empty lines.
        let raw = "    fn main() {      \n\n        body   x      ".to_string();
        assert_eq!(
            clean_selection_text(Some(raw)).as_deref(),
            Some("    fn main() {\n\n        body   x")
        );
        assert_eq!(clean_selection_text(None), None);
    }
}
