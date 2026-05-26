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
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use warpui::color::ColorU;
use warpui::elements::{
    Border, ClippedScrollStateHandle, ClippedScrollable, ConstrainedBox, Container,
    CrossAxisAlignment, Fill, Flex, MainAxisAlignment, MainAxisSize, ParentElement, Rect,
    ScrollbarWidth, SelectableArea, SelectionHandle, Stack, Text,
};
use warpui::fonts::{FamilyId, Properties, Style, Weight};
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
/// Block inner padding (px): horizontal gutter + vertical breathing room.
const BLOCK_PAD_X: f32 = 14.0;
const BLOCK_PAD_Y: f32 = 8.0;
/// Width (px) of the red left stripe on a failed block.
const STRIPE_W: f32 = 2.0;
/// Cap on closed blocks rendered per frame (newest-first). Bounds the
/// retained-tree rebuild cost until M2.4 adds windowed scrollback. Older
/// history is retained in the model, just not painted past this depth.
const BLOCK_RENDER_CAP: usize = 24;

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
    command: String,
    rows: Vec<RowSnapshot>,
    cwd: Option<String>,
    duration_ms: Option<u64>,
    exit_code: Option<i32>,
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
    /// Scroll-back offset (px from the top of the transcript content), mirrored
    /// into the `ClippedScrollStateHandle` each render. Only meaningful while
    /// `stick_bottom` is false.
    scroll_px: f32,
    /// When true (the default), the transcript auto-follows new output: render
    /// hands the scroll handle a huge sentinel offset that `after_layout` clamps
    /// to the true bottom, so the newest line is always pinned to the viewport
    /// bottom. An upward scroll clears this; scrolling back to the bottom (or the
    /// content shrinking to fit) re-arms it.
    stick_bottom: bool,
    /// Frames applied since attach — diagnostic only.
    frames: u64,
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
            scroll_px: 0.0,
            stick_bottom: true,
            frames: 0,
        }
    }

    /// Apply a sparse frame: resize to the frame's grid height, overwrite the
    /// dirty rows, and track cursor + dims + the live-grid gate flags. Cheap —
    /// clones only changed rows.
    fn apply_frame(&mut self, f: &RenderFrame) {
        if self.n_rows != f.rows {
            self.rows
                .resize(f.rows as usize, RowSnapshot { spans: Vec::new() });
            self.n_rows = f.rows;
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
        self.frames = self.frames.wrapping_add(1);
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
    /// per-frame element rebuild; render mirrors scroll_px/stick_bottom in,
    /// `term_native_scroll` reads the clamped offset back out).
    scroll: ClippedScrollStateHandle,
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
}

impl Pane {
    fn new() -> Self {
        Self {
            pty: Mutex::new(String::new()),
            grid: Arc::new(Mutex::new(TermGrid::empty())),
            scroll: ClippedScrollStateHandle::new(),
            sel: SelectionHandle::default(),
            selection: Mutex::new(None),
            agent_mode: std::sync::atomic::AtomicBool::new(false),
            rect: Mutex::new((0.0, 0.0, 0.0, 0.0)),
            viewport_top: Mutex::new(0.0),
            viewport_h: Mutex::new(0.0),
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

/// The panes: index 0 = main column, 1 = right-panel side terminal. Created
/// lazily before attach so the sinks and the view share the same `Pane`s.
static PANES: OnceLock<[Pane; 2]> = OnceLock::new();
fn panes() -> &'static [Pane; 2] {
    PANES.get_or_init(|| [Pane::new(), Pane::new()])
}
/// Resolve a React pane key to its `Pane`. Anything but "side" is the main pane
/// (so a missing/legacy key maps safely to main).
fn pane(key: &str) -> &'static Pane {
    &panes()[if key == "side" { 1 } else { 0 }]
}
/// The pane currently mirroring `pty_id`, if any (frame/block sink routing).
fn pane_for_pty(pty_id: &str) -> Option<&'static Pane> {
    panes().iter().find(|p| p.pty_id() == pty_id)
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

/// Build one grid row: per-span runs, splitting the span under the cursor (and
/// padding/appending a cursor cell at/after the row's end).
fn build_row(spans: &[Span], cursor_col: Option<u16>, mono: FamilyId) -> Box<dyn Element> {
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

    Flex::row().with_spacing(0.0).with_children(runs).finish()
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

/// How many leading rows of the live grid to render: trims trailing blank rows
/// (keeping through the cursor row) so an idle / just-finished shell screen sits
/// compactly above the input instead of padding the transcript with blanks.
fn live_row_count(rows: &[RowSnapshot], cursor_on: bool, cursor_row: usize) -> usize {
    if rows.is_empty() {
        return 0;
    }
    let mut last = if cursor_on {
        cursor_row.min(rows.len() - 1)
    } else {
        0
    };
    for (i, row) in rows.iter().enumerate() {
        if row_has_content(row) {
            last = last.max(i);
        }
    }
    last + 1
}

/// Estimated painted height (px) of one closed block — for the scroll-back top
/// spacer + fit decision only, NOT layout. Counts the meta line, command line,
/// and visible output rows at `LINE_PX` plus the block's vertical padding, but
/// deliberately omits the 1px divider and 2px inter-row spacing so the estimate
/// runs slightly UNDER the true height (a safe bias: the spacer can only leave a
/// little blank scroll-space above old content, never a gap below the newest).
fn est_block_height(block: &NativeBlock) -> f32 {
    let mut lines = 0usize;
    if block.cwd.is_some() || block.duration_ms.is_some() {
        lines += 1;
    }
    if !block.command.is_empty() {
        lines += 1;
    }
    lines += block.rows.iter().filter(|r| !is_zsh_eol_marker(r)).count();
    lines as f32 * LINE_PX + 2.0 * BLOCK_PAD_Y
}

/// Build one closed block, Warp-style: a gray meta line (`cwd (duration)`) on
/// top, then the command in bold white (no prompt glyph), then the output rows,
/// with a hairline divider beneath. A failed command gets a dark maroon fill and
/// a red left stripe — its only status accents (no "exit N" text).
fn build_block(block: &NativeBlock, mono: FamilyId) -> Box<dyn Element> {
    let failed = matches!(block.exit_code, Some(c) if c != 0);
    let mut children: Vec<Box<dyn Element>> = Vec::new();

    // Meta line FIRST (above the command): "{cwd} ({duration})", gray.
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
    if !meta.is_empty() {
        children.push(
            Text::new(meta, mono, FONT_SIZE - 1.0)
                .with_color(META_FG)
                .with_line_height_ratio(LINE_HEIGHT_RATIO)
                .soft_wrap(false)
                .finish(),
        );
    }

    // Command line: bright white, bold, no prompt glyph.
    if !block.command.is_empty() {
        children.push(
            Text::new(block.command.clone(), mono, FONT_SIZE)
                .with_color(COMMAND_FG)
                .with_style(text_props(true, false))
                .with_line_height_ratio(LINE_HEIGHT_RATIO)
                .soft_wrap(false)
                .finish(),
        );
    }

    // Output rows (strip zsh's stray reverse-video EOL marker).
    for row in &block.rows {
        if is_zsh_eol_marker(row) {
            continue;
        }
        children.push(build_row(&row.spans, None, mono));
    }

    let content = Flex::column()
        .with_spacing(2.0)
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
    let (_, _, _, pane_h) = p.rect();
    let mut g = p.grid.lock().unwrap_or_else(|e| e.into_inner());
    let alt_mode = g.alt_screen;
    let cursor_on = g.cursor_visible && g.cursor_row >= 0;
    let cursor_row = g.cursor_row.max(0) as usize;
    let cursor_col = g.cursor_col;
    let n_blocks = g.blocks.len();

    if alt_mode {
        // Alt-screen: the app owns a fixed full grid, painted top-down.
        let mut row_els: Vec<Box<dyn Element>> = Vec::with_capacity(g.rows.len());
        for (r, row) in g.rows.iter().enumerate() {
            let cur = if cursor_on && r == cursor_row {
                Some(cursor_col)
            } else {
                None
            };
            row_els.push(build_row(&row.spans, cur, mono));
        }
        Flex::column()
            .with_main_axis_size(MainAxisSize::Max)
            .with_main_axis_alignment(MainAxisAlignment::Start)
            .with_cross_axis_alignment(CrossAxisAlignment::Stretch)
            .with_spacing(0.0)
            .with_children(row_els)
            .finish()
    } else if agent_on {
        // Agent owns the pane: live grid only, bottom-anchored, NO scroll-back.
        let row_count = live_row_count(&g.rows, cursor_on, cursor_row);
        let mut row_els: Vec<Box<dyn Element>> = Vec::with_capacity(row_count);
        for (r, row) in g.rows.iter().take(row_count).enumerate() {
            let cur = if cursor_on && r == cursor_row {
                Some(cursor_col)
            } else {
                None
            };
            row_els.push(build_row(&row.spans, cur, mono));
        }
        let grid = Flex::column()
            .with_main_axis_size(MainAxisSize::Max)
            .with_main_axis_alignment(MainAxisAlignment::End)
            .with_cross_axis_alignment(CrossAxisAlignment::Stretch)
            .with_spacing(0.0)
            .with_children(row_els)
            .finish();
        // Pin below the AgentChrome strip when React has reported the content
        // region; otherwise fill the pane (prior behavior).
        let top = *p.viewport_top.lock().unwrap_or_else(|e| e.into_inner());
        let h = *p.viewport_h.lock().unwrap_or_else(|e| e.into_inner());
        if h > 1.0 {
            pin_region(grid, top, h)
        } else {
            grid
        }
    } else {
        // Shell transcript: closed blocks (oldest first, capped) + the running
        // command's live grid, top→bottom, wrapped for scroll-back.
        let mut children: Vec<Box<dyn Element>> = Vec::new();
        let mut content_est = 0.0f32;
        let start = n_blocks.saturating_sub(BLOCK_RENDER_CAP);
        for block in &g.blocks[start..] {
            content_est += est_block_height(block);
            children.push(build_block(block, mono));
        }
        if g.command_running {
            let row_count = live_row_count(&g.rows, cursor_on, cursor_row);
            content_est += row_count as f32 * LINE_PX;
            let mut row_els: Vec<Box<dyn Element>> = Vec::with_capacity(row_count);
            for (r, row) in g.rows.iter().take(row_count).enumerate() {
                let cur = if cursor_on && r == cursor_row {
                    Some(cursor_col)
                } else {
                    None
                };
                row_els.push(build_row(&row.spans, cur, mono));
            }
            children.push(
                Flex::column()
                    .with_spacing(0.0)
                    .with_children(row_els)
                    .finish(),
            );
        }

        let viewport = pane_h;
        if viewport <= 1.0 {
            // Pane height not reported yet — bottom-anchored fallback.
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
            if content_est < content_vp {
                g.stick_bottom = true;
            } else if !g.stick_bottom && g.scroll_px > p.scroll.scroll_start().as_f32() + 1.0 {
                g.stick_bottom = true;
            }
            if g.stick_bottom {
                p.scroll.scroll_to(Pixels::new(1.0e9));
            } else {
                p.scroll.scroll_to(Pixels::new(g.scroll_px));
            }
            let spacer = (content_vp - content_est).max(0.0);
            let mut col_children: Vec<Box<dyn Element>> = Vec::new();
            if spacer > 0.5 {
                col_children.push(Box::new(
                    ConstrainedBox::new(Rect::new().finish()).with_height(spacer),
                ));
            }
            col_children.extend(children);
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
                    *p.selection.lock().unwrap_or_else(|e| e.into_inner()) = args.selection;
                },
                content,
            );
            let scrollable = ClippedScrollable::vertical(
                p.scroll.clone(),
                Box::new(selectable),
                ScrollbarWidth::None,
                Fill::None,
                Fill::None,
                Fill::None,
            )
            .with_overlayed_scrollbar();
            let viewport_top = *p.viewport_top.lock().unwrap_or_else(|e| e.into_inner());
            pin_region(Box::new(scrollable), viewport_top, content_vp)
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
        let t0 = Instant::now();
        let ps = panes();
        let main = &ps[0];
        let side = &ps[1];

        let main_col = build_pane_column(main, self.mono);
        let side_on = side.active();
        let column: Box<dyn Element> = if side_on {
            // Both panes visible (the right-panel split is open). The surface
            // covers the combined bounding box; lay the panes side-by-side by
            // width (they share the AppShell row's top + height), with the gap
            // between them (the React divider) left black.
            let (mx, _my, mw, _mh) = main.rect();
            let (sx, _sy, sw, _sh) = side.rect();
            let gap = (sx - (mx + mw)).max(0.0);
            let side_col = build_pane_column(side, self.mono);
            let mut kids: Vec<Box<dyn Element>> = Vec::new();
            kids.push(Box::new(ConstrainedBox::new(main_col).with_width(mw.max(1.0))));
            if gap > 0.5 {
                kids.push(Box::new(
                    ConstrainedBox::new(Rect::new().finish()).with_width(gap),
                ));
            }
            kids.push(Box::new(ConstrainedBox::new(side_col).with_width(sw.max(1.0))));
            Flex::row()
                .with_main_axis_size(MainAxisSize::Max)
                .with_cross_axis_alignment(CrossAxisAlignment::Stretch)
                .with_children(kids)
                .finish()
        } else {
            main_col
        };

        let root = Stack::new()
            .with_child(Rect::new().with_background_color(ColorU::black()).finish())
            .with_child(column)
            .finish();

        use std::sync::atomic::{AtomicU64, Ordering};
        static RENDERS: AtomicU64 = AtomicU64::new(0);
        let n = RENDERS.fetch_add(1, Ordering::Relaxed);
        if n < 5 || n % 120 == 0 {
            eprintln!(
                "[warpui] render #{n}: side={side_on} build={:.2}ms",
                t0.elapsed().as_secs_f64() * 1000.0
            );
        }

        root
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
        // Route the frame to whichever pane mirrors this pty (main or side).
        if let Some(p) = pane_for_pty(pty_id) {
            let mut g = p.grid.lock().unwrap_or_else(|e| e.into_inner());
            g.apply_frame(frame);
        }
        let _ = app_for_sink.run_on_main_thread(|| {
            warpui::platform::poke_embedded_redraw();
        });
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        // Dev-only off-screen snapshot, gated behind WARP_CAPTURE (off by
        // default). The PNG encode + disk write runs on the main thread, so
        // leaving it on injects a periodic multi-ms hitch during output bursts —
        // bad for the 120fps / smooth-throughput budget. Set WARP_CAPTURE=1 to
        // re-enable for render debugging.
        if (n == 4 || n == 12 || (n > 0 && n % 60 == 0)) && std::env::var("WARP_CAPTURE").is_ok() {
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
        if let Some(p) = pane_for_pty(pty_id) {
            let mut g = p.grid.lock().unwrap_or_else(|e| e.into_inner());
            g.blocks.push(NativeBlock {
                command: block.input.clone(),
                rows: block.block_rows.clone(),
                cwd: block.cwd.clone(),
                duration_ms: block.duration_ms,
                exit_code: block.exit_code,
            });
        }
        let _ = app_for_block.run_on_main_thread(|| {
            warpui::platform::poke_embedded_redraw();
        });
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

            // Two-pane layout check: shrink main and place a (content-less) side
            // pane to its right, reposition the surface to the combined box, and
            // capture — verifies the Flex::row side-by-side render + combined
            // surface geometry that real multi-pane (right panel open) exercises.
            {
                let mp = pane("main");
                if let Ok(mut r) = mp.rect.lock() {
                    *r = (0.0, 0.0, 500.0, 800.0);
                }
                let sp = pane("side");
                if let Ok(mut g) = sp.pty.lock() {
                    g.clear();
                    g.push_str("selftest-side");
                }
                if let Ok(mut r) = sp.rect.lock() {
                    *r = (508.0, 0.0, 300.0, 800.0);
                }
                reposition_surface();
                let _ =
                    app_for_test.run_on_main_thread(|| warpui::platform::poke_embedded_redraw());
                std::thread::sleep(Duration::from_millis(400));
                eprintln!("[selftest] two-pane: main(0,0,500,800) + side(508,0,300,800)");
                if let Some(wid) = CAPTURE_WID.lock().ok().and_then(|g| *g) {
                    let _ = app_for_test.run_on_main_thread(move || {
                        warpui::platform::capture_embedded(
                            wid,
                            Box::new(|frame| save_capture_png(&frame, "/tmp/warpui_twopane.png")),
                        );
                    });
                }
                std::thread::sleep(Duration::from_millis(300));
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
    if let Ok(mut r) = p.rect.lock() {
        *r = (x as f32, y as f32, width as f32, height as f32);
    }
    reposition_surface();
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.run_on_main_thread(|| warpui::platform::poke_embedded_redraw());
    }
}

/// Tauri command: point the native surface at `id`'s pty (the active terminal
/// tab). Clears the retained grid so the prior pty's content can't bleed
/// through before the new pty's first frame / `term_start` re-emit arrives.
#[tauri::command]
pub fn term_native_attach(
    pane_key: String,
    id: String,
    state: tauri::State<crate::term::TerminalState>,
) {
    use tauri::Manager as _;
    eprintln!("[warpui] term_native_attach: pane={pane_key} id={id}");
    let p = pane(&pane_key);
    // Stop mirroring this pane's previous pty, then mirror the new one.
    let prev = p.pty_id();
    if !prev.is_empty() && prev != id {
        crate::term::clear_native_pty(&prev);
    }
    if let Ok(mut g) = p.pty.lock() {
        g.clear();
        g.push_str(&id);
    }
    crate::term::set_native_pty(&id);
    {
        let mut g = p.grid.lock().unwrap_or_else(|e| e.into_inner());
        *g = TermGrid::empty();
    }
    // Rehydrate saved closed blocks so history survives tab switches and
    // restarts (Warp-parity: terminal history is never cut off). `load_blocks`
    // windows to the most-recent; older blocks page in on scroll-back (M2.4).
    // Best-effort — a missing DB or brand-new pty just yields an empty grid.
    if let Some(app) = APP_HANDLE.get() {
        if let Ok(dir) = app.path().app_data_dir() {
            if let Ok(saved) = crate::persistence::load_blocks(&dir.join("goonware.db"), &id) {
                if !saved.is_empty() {
                    let mut g = p.grid.lock().unwrap_or_else(|e| e.into_inner());
                    g.blocks = saved
                        .into_iter()
                        .map(|sb| NativeBlock {
                            command: sb.input,
                            rows: serde_json::from_value(sb.block_rows_json)
                                .unwrap_or_default(),
                            cwd: sb.cwd,
                            duration_ms: sb.duration_ms.map(|d| d.max(0) as u64),
                            exit_code: sb.exit_code,
                        })
                        .collect();
                }
            }
        }
    }
    // Repaint immediately from the pty's current grid (no-op if it hasn't
    // started yet — the first `term_start` frame fills the surface then).
    crate::term::reemit_native(&state, &id);
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.run_on_main_thread(|| warpui::platform::poke_embedded_redraw());
    }
}

/// Tauri command: stop mirroring any pty (a non-terminal tab is active). The
/// surface is also hidden via a zero rect by `WarpSurfaceTracker`.
#[tauri::command]
pub fn term_native_detach(pane_key: String) {
    let p = pane(&pane_key);
    let prev = p.pty_id();
    if !prev.is_empty() {
        crate::term::clear_native_pty(&prev);
    }
    if let Ok(mut g) = p.pty.lock() {
        g.clear();
    }
    if let Ok(mut r) = p.rect.lock() {
        *r = (0.0, 0.0, 0.0, 0.0);
    }
    if let Ok(mut g) = p.grid.lock() {
        *g = TermGrid::empty();
    }
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
pub fn term_native_set_agent_mode(pane_key: String, active: bool) {
    pane(&pane_key)
        .agent_mode
        .store(active, std::sync::atomic::Ordering::Relaxed);
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.run_on_main_thread(|| warpui::platform::poke_embedded_redraw());
    }
}

/// Tauri command: forward a wheel delta (CSS px, +down/newer) from the React
/// overlay to the native shell-transcript scroll-back. The embedded child window
/// has `ignoresMouseEvents: YES`, so the webview captures the wheel and relays it
/// here. We read the post-layout-clamped offset back out of the scroll handle
/// (so scrolling up from the bottom starts at the true bottom), apply the delta,
/// and drop stick-to-bottom; render re-arms stick once scrolled back down or when
/// the content fits. No-op effect in alt-screen / agent mode (render ignores the
/// offset there).
#[tauri::command]
pub fn term_native_scroll(pane_key: String, delta_px: f64) {
    let p = pane(&pane_key);
    {
        let mut g = p.grid.lock().unwrap_or_else(|e| e.into_inner());
        let cur = p.scroll.scroll_start().as_f32();
        g.scroll_px = (cur + delta_px as f32).max(0.0);
        g.stick_bottom = false;
    }
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
