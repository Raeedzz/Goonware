//! Terminal emulator backed by `alacritty_terminal`.
//!
//! Replaces the previous xterm.js-driven `pty.rs`. The Rust side now owns
//! the full terminal grid: a VTE parser feeds PTY bytes into an Alacritty
//! `Term`, we walk the grid into compressed RGB-colored span runs, and
//! emit frame deltas + closed-block events to the frontend over Tauri
//! events. The frontend renders cells as DOM (one styled `<span>` per
//! run), giving us per-cell control for the Warp-style block UI.
//!
//! Key invariants:
//!   * One reader thread per session does PTY reads → VTE parse → frame
//!     diff. All Term mutation lives on that thread; command handlers
//!     only mutate via the shared `Mutex<Session>` (resize, write).
//!   * Frames are throttled to ~60 Hz — heavy output (`seq 1 100000`)
//!     coalesces instead of overwhelming the IPC channel.
//!   * `BlockSegmenter` scans the raw byte stream (parallel to VTE) for
//!     OSC 133 prompt markers AND for Warp-style DCS hooks of the form
//!     `ESC P goonware ; <hook_name> ; <json_payload> ESC \`. The DCS hooks
//!     carry richer metadata (the exact typed command, precise start
//!     timestamp, exact exit code + duration as measured by the shell)
//!     that enrich the resulting `ClosedBlock`. OSC 133 stays as the
//!     compat fallback for shells where DCS hooks aren't installed.
//!     Closed blocks emit their own event. Unmarked shells get an
//!     idle-quiescence fallback.
//!   * When the Term is in alt-screen mode (vim, htop, claude TUI), the
//!     segmenter pauses and the frontend swaps from BlockList to FullGrid.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::thread;
use std::borrow::Cow;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use alacritty_terminal::event::{Event as AlacEvent, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Config as TermConfig, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor, Processor, Rgb};
use alacritty_terminal::Term;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, Wry};

/// Effectively unbounded scrollback. We expose this as `total_lines()`
/// from the `Dimensions` trait (added to `rows`), so the value MUST
/// leave headroom for that addition without overflowing `usize`. Half
/// of `usize::MAX` is the canonical "infinity that survives `+ rows`"
/// pattern; on 64-bit platforms it's ~9.2e18 lines, which no real
/// session will ever reach. alacritty initializes scrollback rows
/// dynamically, so a sky-high cap doesn't pre-allocate memory — rows
/// are only stored when the user actually scrolls into them.
const SCROLLBACK_LIMIT: usize = usize::MAX / 2;

/// `alacritty_terminal::term::Config` with our unbounded scrollback
/// applied. `Config::default()` ships `scrolling_history: 10_000`,
/// which would silently truncate long agent sessions to the most
/// recent 10k rows once they overflow. Always go through this helper
/// instead of calling `TermConfig::default()` directly.
fn term_config() -> TermConfig {
    TermConfig {
        scrolling_history: SCROLLBACK_LIMIT,
        ..TermConfig::default()
    }
}
/// Frame throttle while the session is visible to the user AND the
/// Goonware window has focus. 8 ms ≈ one frame at 120 Hz, matching the
/// MacBook Pro / Pro Display XDR ProMotion refresh rate. On non-
/// ProMotion 60 Hz displays the compositor coalesces back to 60 fps
/// automatically, so the higher cap is free for those users —
/// they get the same 60 fps perception with marginally more headroom
/// for sudden burst output to land in fewer coalesced frames.
const FRAME_THROTTLE_VISIBLE: Duration = Duration::from_millis(8);
/// Frame throttle while the session is currently NOT shown anywhere
/// in the UI but the Goonware window is otherwise focused. Kept close to
/// the visible cadence (32 ms ≈ 30 Hz) so that a worktree-switch
/// race between the user starting to type and `term_set_visible_set`
/// landing on the backend doesn't introduce a perceptible delay
/// before the freshly-active terminal starts echoing keystrokes.
/// The previous 250 ms value visibly stalled the first 1–2 frames
/// after every switch.
const FRAME_THROTTLE_HIDDEN: Duration = Duration::from_millis(32);
/// Frame throttle while the Goonware window is BACKGROUNDED (user is on
/// another app). The webview's JS context is suspended by macOS, so
/// every event we emit just queues in V8's message buffer until the
/// user comes back — and then JS has to drain the entire backlog
/// before it can repaint anything. Dropping to 1 Hz keeps the queue
/// bounded so window-focus return is instant. This is the most
/// restrictive of the three throttles and applies regardless of the
/// per-session visibility flag.
const FRAME_THROTTLE_UNFOCUSED: Duration = Duration::from_millis(1000);

/// True when the Goonware main window currently has user focus. Updated
/// from the window event listener in `lib.rs`. Defaults to true so
/// cold-start (before any focus events have fired) runs at full
/// cadence.
static APP_FOCUSED: AtomicBool = AtomicBool::new(true);

/// Called from the window event listener whenever the main window's
/// focus state flips. Backend frame emit throttles accordingly.
pub fn set_app_focused(focused: bool) {
    APP_FOCUSED.store(focused, Ordering::Relaxed);
}

/// Combined throttle policy: window focus dominates, then per-session
/// visibility. Used by `maybe_flush` to decide whether to emit.
fn session_frame_throttle(session_visible: bool) -> Duration {
    if !APP_FOCUSED.load(Ordering::Relaxed) {
        return FRAME_THROTTLE_UNFOCUSED;
    }
    if session_visible {
        FRAME_THROTTLE_VISIBLE
    } else {
        FRAME_THROTTLE_HIDDEN
    }
}

/// Reach into every live session and trigger one `maybe_flush` so
/// the frontend sees the latest grid as soon as the window comes
/// back to focus, instead of waiting for the next reader-loop tick
/// (which only fires on PTY output — idle terminals would stay
/// stale otherwise). Called from the window-focus listener in
/// `lib.rs` on the `Focused(true)` transition.
pub fn flush_all_sessions(app: &AppHandle<Wry>, state: &TerminalState) {
    let snapshot: Vec<(String, Arc<Mutex<Session>>)> = {
        let sessions = match state.sessions.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        sessions
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    };
    for (id, arc) in snapshot {
        if let Ok(mut s) = arc.lock() {
            // Reset last_flush so the throttle gate doesn't suppress
            // the post-focus catch-up emit.
            s.last_flush = Instant::now() - FRAME_THROTTLE_VISIBLE;
            maybe_flush(&mut s, app, &id);
        }
    }
}

/// Update which terminal sessions are currently visible to the user.
/// Called from the frontend whenever the active worktree, active tab,
/// or secondary terminal selection changes. The set is small — usually
/// 1 to 2 PTYs — but the impact is large: every session NOT in the
/// set drops to `FRAME_THROTTLE_HIDDEN` (4 Hz), so 20 streaming agents
/// with only 1 visible at a time generates ~120 events/sec total
/// instead of the previous ~1200.
///
/// Transitions: any session that just became visible immediately
/// gets one catch-up frame so the user sees current state on switch,
/// instead of waiting up to 250 ms for the next throttled emit.
#[tauri::command]
pub fn term_set_visible_set(
    app: AppHandle<Wry>,
    state: State<TerminalState>,
    ids: Vec<String>,
) -> Result<(), String> {
    let visible: std::collections::HashSet<String> = ids.into_iter().collect();
    let snapshot: Vec<(String, Arc<Mutex<Session>>)> = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    };
    for (id, arc) in snapshot {
        if let Ok(mut s) = arc.lock() {
            let was_visible = s.visible;
            let now_visible = visible.contains(&id);
            s.visible = now_visible;
            if now_visible && !was_visible {
                // Just became visible — push a catch-up frame so the
                // user sees current state without waiting for the
                // next throttled emit. Reset last_flush so the gate
                // doesn't suppress this one.
                s.last_flush = Instant::now() - FRAME_THROTTLE_VISIBLE;
                maybe_flush(&mut s, &app, &id);
            }
        }
    }
    Ok(())
}

/// Return the set of session ids whose `last_command_running` is
/// currently true — i.e. the PTYs sitting between an OSC 133 C marker
/// (command start) and the next D marker (command done). The frontend
/// polls this every ~300 ms from a singleton store; the sidebar reads
/// the resulting per-PTY flags to light up worktree spinners for
/// terminals that aren't currently mounted in React (the scoped
/// keepalive only mounts the active worktree's terminals, so without
/// this backend signal a `npm run build` in a background worktree
/// would have no path to report its running state).
#[tauri::command]
pub fn term_running_session_ids(state: State<TerminalState>) -> Vec<String> {
    let snapshot: Vec<(String, Arc<Mutex<Session>>)> = match state.sessions.lock() {
        Ok(s) => s.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for (id, arc) in snapshot {
        if let Ok(s) = arc.lock() {
            if s.last_command_running {
                out.push(id);
            }
        }
    }
    out
}

/* ------------------------------------------------------------------
   Trailing-edge flush scheduler.
   ------------------------------------------------------------------ */

/// Companion to the leading-edge throttle in `maybe_flush`. The reader
/// thread calls `schedule(deadline)` whenever a frame is gated against
/// the throttle window; a dedicated per-session flusher thread waits on
/// the condvar and re-runs `maybe_flush` once the deadline elapses,
/// guaranteeing the final frame of any burst reaches the frontend even
/// when no further PTY output arrives to drive another wakeup.
///
/// This is Goonware's port of Warp's `app/src/throttle.rs` trailing-edge
/// throttle. Without it, a clear-screen, large agent reply, or any other
/// burst that ends mid-throttle-window leaves the last frame trapped on
/// the backend until the next PTY byte (commonly: the user's next
/// keystroke or Ctrl+C) — which read as "the terminal goes black for a
/// beat after bulk output until I type."
struct TrailingFlusher {
    state: Mutex<TrailingFlushState>,
    cvar: Condvar,
}

#[derive(Clone, Copy)]
enum TrailingFlushState {
    Idle,
    Pending(Instant),
    Stopped,
}

impl TrailingFlusher {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(TrailingFlushState::Idle),
            cvar: Condvar::new(),
        })
    }

    /// Request that `maybe_flush` be re-run no later than `deadline`.
    /// A later deadline than the one already pending is a no-op (the
    /// earlier deadline wins). No-op after `stop()`.
    fn schedule(&self, deadline: Instant) {
        let mut state = match self.state.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        match *state {
            TrailingFlushState::Stopped => return,
            TrailingFlushState::Pending(existing) if existing <= deadline => return,
            _ => *state = TrailingFlushState::Pending(deadline),
        }
        self.cvar.notify_one();
    }

    /// Signal the flusher thread to exit. Idempotent.
    fn stop(&self) {
        if let Ok(mut state) = self.state.lock() {
            *state = TrailingFlushState::Stopped;
        }
        self.cvar.notify_all();
    }
}

/// Per-session flusher thread loop. Sleeps on the condvar until a
/// deadline is scheduled, sleeps with timeout until the deadline, then
/// runs `maybe_flush` on the session — if it can still upgrade the
/// weak reference. Exits when the session is dropped or `stop()` is
/// called.
fn run_trailing_flusher(
    flusher: Arc<TrailingFlusher>,
    session: Weak<Mutex<Session>>,
    app: AppHandle<Wry>,
    id: String,
) {
    loop {
        // Wait for a scheduled deadline (or stop).
        let deadline = {
            let mut state = match flusher.state.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            loop {
                match *state {
                    TrailingFlushState::Stopped => return,
                    TrailingFlushState::Pending(d) => break d,
                    TrailingFlushState::Idle => {
                        state = match flusher.cvar.wait(state) {
                            Ok(g) => g,
                            Err(_) => return,
                        };
                    }
                }
            }
        };
        // Sleep until the deadline (or get notified — schedule pulled
        // it earlier, or stop). After waking, loop to re-check state.
        let now = Instant::now();
        if deadline > now {
            let dur = deadline - now;
            let state = match flusher.state.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            let _ = flusher.cvar.wait_timeout(state, dur);
            continue;
        }
        // Deadline elapsed — atomically claim it (Pending → Idle) and
        // run the flush. If another `schedule()` raced and bumped the
        // deadline past `now`, leave it Pending and loop.
        {
            let mut state = match flusher.state.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            match *state {
                TrailingFlushState::Stopped => return,
                TrailingFlushState::Pending(d) if d > Instant::now() => continue,
                _ => *state = TrailingFlushState::Idle,
            }
        }
        match session.upgrade() {
            Some(arc) => {
                if let Ok(mut s) = arc.lock() {
                    maybe_flush(&mut s, &app, &id);
                }
            }
            None => return,
        }
    }
}

/* ------------------------------------------------------------------
   State container — one entry per running PTY session.
   ------------------------------------------------------------------ */

#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
}

struct Session {
    term: Term<EventProxy>,
    parser: Processor,
    pty_master: Box<dyn MasterPty + Send>,
    pty_writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// PID of the shell process spawned by `term_start`. Captured so
    /// `term_kill_foreground` can refuse to SIGKILL the shell itself
    /// — without this guard, a Ctrl+C-escalation that fires inside the
    /// few-ms race window between `fork()` and the child's
    /// `setpgid()` + `tcsetpgrp()` would read the shell's own pgrp via
    /// `tcgetpgrp(master_fd)` and `kill(-shell_pgrp, SIGKILL)` would
    /// take the shell down with the child. The user-reported symptom
    /// is "after a run is done and I open a new claude, ctrl+c kills
    /// zsh." Storing the shell pid lets us bail before sending the
    /// fatal signal. None when the host platform doesn't expose
    /// `process_id()` from portable_pty (e.g. future Windows path).
    shell_pid: Option<u32>,
    cols: u16,
    rows: u16,
    /// Last full snapshot we sent to the frontend. We diff against this so
    /// only changed rows go over the wire.
    last_snapshot: Vec<RowSnapshot>,
    /// alacritty's `history_size()` at the previous flush. Used to
    /// compute how many rows just scrolled into scrollback (delta > 0
    /// → capture the newest `delta` history rows and ship them as
    /// `scrollback_appended`). When `delta < 0` the history shrunk
    /// (resize-evict, clear-saved); we mark `scrollback_reset` so the
    /// frontend drops its mirror before re-syncing.
    last_history_size: usize,
    /// When we last flushed a frame — used for the throttle.
    last_flush: Instant,
    /// Last `command_running` value we emitted. We send a frame every
    /// time this flips even when no rows are dirty — otherwise the
    /// frontend never sees the running→idle transition that follows a
    /// Ctrl+C kill (zsh's empty PROMPT doesn't repaint anything).
    last_command_running: bool,
    segmenter: BlockSegmenter,
    /// Monotonic frame counter. Increments on every emit (regardless
    /// of whether the frame had dirty rows). Frontend uses this to
    /// dedupe rAF flushes (skip if seq unchanged) and detect dropped
    /// frames for backpressure.
    next_frame_seq: u64,
    /// Whether the frontend currently has this session visible
    /// (active tab in main column, or active secondary terminal).
    /// Drives the per-session frame throttle alongside the window
    /// focus flag. Defaults to true so the first emit after
    /// term_start runs at full cadence — the frontend will report
    /// the real visible set on the next `term_set_visible_set`.
    visible: bool,
    /// Direct-to-frontend channel for terminal frames. Replaces the
    /// old `app.emit("term://{id}/frame", ...)` broadcast path for
    /// the single hottest event source in the app (60 Hz × N
    /// sessions). With `Channel`, each frame flows straight to its
    /// one registered React listener — no event-bus serialisation,
    /// no topic-name string filtering on the JS side. The five
    /// other low-frequency emits (block, cwd, bell, exit, title)
    /// stay on the broadcast path; their volume is tiny.
    ///
    /// Replaced on every `term_start` re-mount so a BlockTerminal
    /// remount points the backend at the new React listener; the
    /// old channel goes dead and any in-flight send is silently
    /// dropped.
    frame_channel: Channel<RenderFrame>,
    /// Trailing-edge flush scheduler — see `TrailingFlusher`. Shared
    /// with the per-session flusher thread spawned in `term_start`.
    /// `maybe_flush` calls `schedule()` when it gates a frame against
    /// the throttle window, so the last frame of any output burst is
    /// guaranteed to ship within one throttle window of output
    /// stopping — even when no further PTY bytes arrive to drive
    /// another wakeup.
    trailing_flusher: Arc<TrailingFlusher>,
}

/* ------------------------------------------------------------------
   EventListener — alacritty wakes us for bell, title changes, etc.
   We forward only what the frontend actually does something with.
   ------------------------------------------------------------------ */

// Locked to `Wry` (Tauri's desktop runtime). Goonware is macOS-desktop-only,
// so we trade the generics for a much simpler `Session` type definition
// — `Session` doesn't have to thread `R` through every field.
#[derive(Clone)]
struct EventProxy(AppHandle<Wry>, String);

impl EventListener for EventProxy {
    fn send_event(&self, event: AlacEvent) {
        match event {
            AlacEvent::Bell => {
                let _ = self
                    .0
                    .emit(&format!("term://{}/bell", self.1), ());
            }
            AlacEvent::Title(title) => {
                let _ = self.0.emit(&format!("term://{}/title", self.1), title);
            }
            AlacEvent::ChildExit(code) => {
                let _ = self
                    .0
                    .emit(&format!("term://{}/exit", self.1), code);
            }
            // PtyWrite happens when the terminal needs to send bytes back
            // to the shell (e.g. cursor position queries). We need to
            // honor these for full TUI app compat.
            AlacEvent::PtyWrite(bytes) => {
                // We can't easily reach the writer from here (no &mut access).
                // Stuff is stashed on Session; callers that care about
                // round-tripping cursor queries would need to wire this
                // through. For v1 we ignore it — most apps don't depend
                // on it, and `claude` certainly doesn't.
                let _ = bytes;
            }
            _ => {}
        }
    }
}

/* ------------------------------------------------------------------
   Dimensions — alacritty's `Dimensions` trait, dirt simple.
   ------------------------------------------------------------------ */

#[derive(Copy, Clone)]
struct Dims {
    cols: usize,
    rows: usize,
}

impl Dimensions for Dims {
    fn total_lines(&self) -> usize {
        self.rows + SCROLLBACK_LIMIT
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

/* ------------------------------------------------------------------
   Wire format — what we ship to the frontend.
   ------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub text: String,
    // fg/bg are Cow<'static, str> so the common cases — named
    // colors, the 16 ANSI palette entries, and the "default fg/bg"
    // fallbacks — emit ZERO per-cell allocations. Only true 24-bit
    // truecolor (rare) and the 6×6×6 cube past index 15 allocate
    // an owned `String`. With typical agent output (Claude, codex,
    // shell ls output) using named or low-index colors, this drops
    // the snapshot_grid allocation count from ~2 per cell to ~0,
    // which at 20 PTYs × 1920 cells per snapshot = thousands of
    // saved allocations per second.
    //
    // Serde serializes Cow<str> as a plain JSON string, so the
    // wire contract is unchanged.
    pub fg: Cow<'static, str>,
    pub bg: Cow<'static, str>,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
    pub dim: bool,
    pub strikeout: bool,
    /// When set, this span is a hyperlink target (a detected URL). The
    /// native renderer paints it underlined and makes it Cmd-clickable.
    /// `#[serde(default)]` keeps the wire contract backward-compatible —
    /// older frontends just ignore the field. Populated at render time by
    /// the native renderer's URL detection (see `warp_term::split_links`),
    /// so the snapshot path leaves it `None`.
    #[serde(default)]
    pub link: Option<Cow<'static, str>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowSnapshot {
    pub spans: Vec<Span>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RenderFrame {
    /// Monotonic frame sequence id. Frontend uses it to dedupe rAF
    /// flushes (skip if unchanged) and detect dropped frames in
    /// burst windows.
    pub seq: u64,
    /// Stable id of the block this frame belongs to (the in-progress
    /// block, between OSC 133 A and the next D). 0 means no block is
    /// active — happens before the first prompt and briefly between
    /// blocks. Renderers can identify which block a frame's content
    /// belongs to without reading the transcript.
    pub block_id: u64,
    pub cols: u16,
    pub rows: u16,
    pub cursor_row: i32,
    pub cursor_col: u16,
    pub alt_screen: bool,
    /// True iff the segmenter is currently between OSC 133 C and D
    /// (i.e. a command is producing output). Frontend uses this to
    /// hide the live grid when no command is running so the empty
    /// rows of the shell prompt don't ghost above the input.
    pub command_running: bool,
    /// DECCKM (application cursor mode). True iff the running program
    /// has issued `ESC[?1h`. Many TUIs (claude, vim insert mode,
    /// readline-based tools) flip this — when set, arrow keys must be
    /// sent as `ESC O A/B/C/D` instead of `ESC [ A/B/C/D`. Frontend's
    /// keyToBytes branches on this. Without it, arrows in claude
    /// are silently dropped.
    pub app_cursor: bool,
    /// DECSET 2004 (bracketed paste). True iff the running program has
    /// issued `ESC[?2004h`. Claude, codex, and most readline-based
    /// TUIs flip this so they can distinguish a paste from typed
    /// input. When set, the frontend must wrap pasted bytes in
    /// `ESC[200~ ... ESC[201~` so the agent renders the whole paste
    /// atomically — without it, multi-line pastes trickle in line by
    /// line and the bottom of a big prompt appears to "load slowly."
    pub bracketed_paste: bool,
    /// DECTCEM (`ESC[?25h/l`). True iff the running program has the
    /// cursor visible. Claude / fzf / readline-based pickers hide
    /// the cursor while their inline UI is open so the user sees
    /// only the picker's own selection chevron — not a stray block
    /// caret in the middle of a description row. Without honoring
    /// this, a spurious cursor paints over picker text wherever
    /// alacritty's last write landed, which is exactly the
    /// "█ in the middle of 'Switch between Clau█'" symptom users
    /// reported.
    pub cursor_visible: bool,
    /// Sparse: only rows that changed since the last frame. Frontend
    /// keeps the rest from its previous snapshot.
    pub dirty: Vec<DirtyRow>,
    /// Rows that have just scrolled OUT of the visible grid into PTY
    /// scrollback since the last frame. Oldest first — so the frontend
    /// can append them verbatim to its scrollback buffer and the agent
    /// history reads top-to-bottom. The `row` field carries the
    /// scrollback row's CURRENT alacritty-grid index (negative; -1 is
    /// the row that just left the visible viewport) at capture time.
    /// Empty in the common case (no scroll between flushes).
    pub scrollback_appended: Vec<DirtyRow>,
    /// When true, the frontend should DROP its scrollback buffer before
    /// applying `scrollback_appended`. Set on term_start re-emit (full
    /// state refresh after remount), and whenever alacritty's
    /// `history_size()` shrinks (resize-evict, clear-saved, etc.) —
    /// either case means the prior buffer's row identities no longer
    /// match the live grid and replaying them would surface stale rows.
    pub scrollback_reset: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DirtyRow {
    pub row: u16,
    pub spans: Vec<Span>,
}

/* ------------------------------------------------------------------
   Native render sink — in-process frame path for the embedded warpui
   terminal (macOS). The native surface mirrors exactly ONE pty at a
   time (the active terminal tab). When that pty's `maybe_flush`/re-emit
   produces a frame, we hand it — by reference, no serde, no IPC — to a
   sink the native renderer registered at startup. The sink patches its
   retained grid and pokes a redraw. On non-macOS builds (or before the
   surface attaches) the sink is absent and these calls are no-ops, so
   `term.rs` stays UI-agnostic.
   ------------------------------------------------------------------ */

/// Sink installed by the native terminal renderer. Receives the same sparse
/// `RenderFrame` that goes to the IPC channel; the renderer maintains its own
/// retained grid by applying `dirty`/cursor/dims.
pub type NativeFrameSink = Box<dyn Fn(&str, &RenderFrame) + Send + Sync + 'static>;

static NATIVE_SINK: std::sync::OnceLock<NativeFrameSink> = std::sync::OnceLock::new();
/// Ids of the ptys the native surface currently mirrors — one per visible pane
/// (the main column + the right-panel side terminal can both be on-screen at
/// once). Empty = none. Frames for any listed pty reach the sink, tagged with
/// the pty id so the renderer routes each to the right pane's grid.
static NATIVE_PTYS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Register the native render sink. Idempotent-ish: only the first wins
/// (the surface is created once for the app's lifetime).
pub fn set_native_frame_sink(sink: NativeFrameSink) {
    let _ = NATIVE_SINK.set(sink);
}

/// Mirror `id` on the native surface (the pane attaching to it), or — with an
/// empty string — stop mirroring everything. Idempotent (no duplicate ids).
pub fn set_native_pty(id: &str) {
    if let Ok(mut g) = NATIVE_PTYS.lock() {
        if id.is_empty() {
            g.clear();
        } else if !g.iter().any(|p| p == id) {
            g.push(id.to_string());
        }
    }
}

/// Stop mirroring a single pty (a pane detached / its tab closed) without
/// disturbing the other mirrored panes.
#[allow(dead_code)] // wired in the per-pane detach increment
pub fn clear_native_pty(id: &str) {
    if let Ok(mut g) = NATIVE_PTYS.lock() {
        g.retain(|p| p != id);
    }
}

/// Hand a freshly-built frame to the native sink iff `id` is a mirrored pty.
#[inline]
fn emit_native_frame(id: &str, frame: &RenderFrame) {
    let is_target = NATIVE_PTYS
        .lock()
        .map(|g| g.iter().any(|p| p == id))
        .unwrap_or(false);
    if is_target {
        if let Some(sink) = NATIVE_SINK.get() {
            sink(id, frame);
        }
    }
}

/// Sink for finished command blocks. Mirrors [`NativeFrameSink`] but for the
/// closed-block list the native renderer stacks above the live grid (M2). The
/// native side clones what it needs off the `ClosedBlock`.
pub type NativeBlockSink = Box<dyn Fn(&str, &ClosedBlock) + Send + Sync + 'static>;

static NATIVE_BLOCK_SINK: std::sync::OnceLock<NativeBlockSink> = std::sync::OnceLock::new();

/// Register the native block sink. First caller wins (surface lives once).
pub fn set_native_block_sink(sink: NativeBlockSink) {
    let _ = NATIVE_BLOCK_SINK.set(sink);
}

/// Hand a finished block to the native sink iff `id` is a mirrored pty.
#[inline]
fn emit_native_block(id: &str, block: &ClosedBlock) {
    let is_target = NATIVE_PTYS
        .lock()
        .map(|g| g.iter().any(|p| p == id))
        .unwrap_or(false);
    if !is_target {
        return;
    }
    if let Some(sink) = NATIVE_BLOCK_SINK.get() {
        sink(id, block);
    }
}

/// Push a full-grid frame for `id` straight to the native sink (no IPC, no
/// scrollback). Called when the native surface (re)attaches to a pty so it
/// repaints immediately from current state instead of waiting for the pty's
/// next output. No-op if the session isn't alive yet — then the first real
/// frame from `term_start` fills the surface.
pub fn reemit_native(state: &TerminalState, id: &str) {
    let sess = {
        let Ok(sessions) = state.sessions.lock() else {
            return;
        };
        match sessions.get(id) {
            Some(s) => s.clone(),
            None => return,
        }
    };
    let Ok(mut s) = sess.lock() else { return };
    let snapshot = snapshot_grid(&s.term);
    let cursor = s.term.grid().cursor.point;
    let dirty: Vec<DirtyRow> = snapshot
        .iter()
        .enumerate()
        .map(|(row, snap)| DirtyRow {
            row: row as u16,
            spans: snap.spans.clone(),
        })
        .collect();
    let seq = s.next_frame_seq;
    s.next_frame_seq = s.next_frame_seq.saturating_add(1);
    let frame = RenderFrame {
        seq,
        block_id: s.segmenter.current_block_id(),
        cols: s.cols,
        rows: s.rows,
        cursor_row: cursor.line.0,
        cursor_col: cursor.column.0 as u16,
        alt_screen: s.term.mode().contains(TermMode::ALT_SCREEN),
        command_running: s.last_command_running,
        app_cursor: s.term.mode().contains(TermMode::APP_CURSOR),
        bracketed_paste: s.term.mode().contains(TermMode::BRACKETED_PASTE),
        cursor_visible: s.term.mode().contains(TermMode::SHOW_CURSOR),
        dirty,
        scrollback_appended: Vec::new(),
        scrollback_reset: false,
    };
    emit_native_frame(id, &frame);
}

/* ------------------------------------------------------------------
   Block segmenter — OSC 133 + idle fallback.
   ------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Eq)]
enum SegState {
    /// Haven't seen the first prompt yet — anything before A is dropped.
    BeforePrompt,
    /// We're inside the prompt itself (between A and B). We don't capture this.
    InPromptDrawing,
    /// User is typing the next command (between B and C).
    AwaitingCommand,
    /// The command's output is streaming (between C and D / next A).
    InOutput,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClosedBlock {
    /// Stable monotonic id minted at OSC 133 A. Renderers use this to
    /// identify a block across reflow / resize / scroll without having
    /// to compare transcript bytes. 0 means "id was never minted"
    /// (shouldn't happen in practice for closed blocks).
    pub block_id: u64,
    /// User's typed command. Populated by the frontend's pending-input
    /// queue (`useTerminalSession`) — Rust always emits this empty
    /// because we deliberately skip OSC 133 B.
    pub input: String,
    /// Full byte transcript for this block, from the OSC 133 A that
    /// opened it through the OSC 133 D that closed it. Includes the
    /// user's PROMPT bytes (with all their SGR styling), the echoed
    /// command, and the command's output. Kept on the wire as a
    /// fallback / for search; the primary render path now uses
    /// [`block_rows`] (see below).
    pub transcript: String,
    /// Per-block grid snapshot — the result of feeding `transcript`
    /// through a fresh `alacritty_terminal::Term` and walking the
    /// resulting grid. Closed blocks render from these rows instead
    /// of running the byte stream through the frontend's much simpler
    /// `parseAnsi.ts` parser, which would mishandle CR overstrike,
    /// line clears, cursor moves, and similar terminal control codes
    /// that alacritty handles correctly. Empty when the transcript
    /// was empty (e.g. block closed by a stray OSC 133 D before any
    /// command output).
    ///
    /// This is the Warp-style "per-block grid" — each closed block
    /// carries an immutable snapshot of what its output rendered to,
    /// rather than relying on the live shared terminal grid (which
    /// can be clobbered by `clear`, alt-screen, scrollback eviction,
    /// or subsequent commands).
    #[serde(rename = "blockRows")]
    pub block_rows: Vec<RowSnapshot>,
    pub exit_code: Option<i32>,
    /// Working directory at the moment the command started running
    /// (OSC 133 C). Populated from the most recent OSC 7 the
    /// segmenter has seen. None if the shell never reported a cwd.
    pub cwd: Option<String>,
    /// Wall-clock duration from OSC 133 C → D in milliseconds. None
    /// if D was never observed (e.g. shell ate the marker or the
    /// command hard-killed before exiting).
    #[serde(rename = "durationMs")]
    pub duration_ms: Option<u64>,
}

struct BlockSegmenter {
    state: SegState,
    osc_buf: Vec<u8>,
    in_osc: bool,
    /// Active DCS-sequence assembly buffer. DCS opens with `ESC P` and
    /// closes with `ESC \` (ST) — same terminator family as OSC. We
    /// only act on DCS payloads with the `goonware;` prefix; anything else
    /// (terminfo definitions, tmux passthrough, etc.) is silently
    /// dropped so the segmenter remains a no-op for non-Goonware tooling.
    dcs_buf: Vec<u8>,
    in_dcs: bool,
    current_input: String,
    /// Raw bytes captured from OSC 133 A through D. See `ClosedBlock::transcript`.
    current_transcript: Vec<u8>,
    /// Latched on the OSC 133 C transition; the reader thread reads &
    /// clears it as a signal to wipe `last_snapshot`. Forces the next
    /// frame to re-emit every row so the new command starts on a
    /// fresh canvas (instead of diffing against the prior command's
    /// trailing output).
    command_just_started: bool,
    /// Latched on each OSC 7 (path-reporting) message. The reader
    /// thread drains this and emits a `term://<id>/cwd` Tauri event so
    /// the chrome's folder pill follows the live terminal cwd.
    pending_cwd: Option<String>,
    /// Most recent OSC 7 cwd. Snapshotted onto each ClosedBlock at
    /// OSC 133 C so each rendered block shows where it ran.
    current_cwd: Option<String>,
    /// Snapshotted at OSC 133 C and copied onto the ClosedBlock when
    /// it closes. Stays None until C fires.
    current_block_cwd: Option<String>,
    /// Wall-clock instant of the last OSC 133 C — used to compute
    /// `duration_ms` when the matching D arrives.
    current_block_start: Option<Instant>,
    /// Monotonic counter for block ids. Incremented at every OSC 133 A
    /// that mints a new block; the previous block's id is captured in
    /// `current_block_id` until the block closes.
    next_block_id: u64,
    /// Id of the block currently being constructed. 0 when no block
    /// is in progress (i.e. before the first prompt or between D and
    /// the next A).
    current_block_id: u64,
    /// Command line reported by the shell via the `preexec` DCS hook.
    /// Latched between hook delivery and the matching OSC 133 C — at C
    /// we drain it into `current_input`, giving the closed block the
    /// exact bytes the user submitted (vs reading them out of zsh's
    /// echo, which is fragile when the user backspaces or uses zle
    /// widgets). None when no DCS hook fired for this block — in which
    /// case the OSC 133 B fallback / frontend pending queue still
    /// populates `input`.
    pending_command: Option<String>,
    /// Wall-clock start timestamp (unix ms) reported by the shell via
    /// the `preexec` DCS hook. Preferred over the local
    /// `current_block_start = Instant::now()` reading because the
    /// shell hook fires before the PTY-side OSC 133 C marker reaches
    /// us, especially under bursty output.
    pending_start_ms: Option<u64>,
    /// Exit code reported by the shell via the `cmd_finished` DCS hook.
    /// Latched between hook delivery and the matching OSC 133 D — at D
    /// we prefer this over `133;D;<code>` because some shells
    /// (notably bash before 5.0) emit `D;0` regardless of the actual
    /// exit status; the DCS hook reads `$?` directly so it's always
    /// correct. None when no DCS hook fired.
    pending_exit_code: Option<i32>,
    /// Wall-clock duration in ms reported by the shell via the
    /// `cmd_finished` DCS hook. Preferred over the locally-computed
    /// duration (start `Instant` → close `Instant`) because the local
    /// timer measures bytes-arriving rather than the shell's actual
    /// command runtime.
    pending_duration_ms: Option<u64>,
}

impl BlockSegmenter {
    fn new() -> Self {
        Self {
            state: SegState::BeforePrompt,
            osc_buf: Vec::with_capacity(64),
            in_osc: false,
            dcs_buf: Vec::with_capacity(256),
            in_dcs: false,
            current_input: String::new(),
            current_transcript: Vec::with_capacity(4096),
            command_just_started: false,
            pending_cwd: None,
            current_cwd: None,
            current_block_cwd: None,
            current_block_start: None,
            next_block_id: 1,
            current_block_id: 0,
            pending_command: None,
            pending_start_ms: None,
            pending_exit_code: None,
            pending_duration_ms: None,
        }
    }

    fn current_block_id(&self) -> u64 {
        self.current_block_id
    }

    fn command_running(&self) -> bool {
        matches!(self.state, SegState::InOutput)
    }

    fn take_command_just_started(&mut self) -> bool {
        let v = self.command_just_started;
        self.command_just_started = false;
        v
    }

    fn take_pending_cwd(&mut self) -> Option<String> {
        self.pending_cwd.take()
    }

    /// Feed a chunk of PTY bytes. Returns Some(block) on close.
    fn feed(&mut self, bytes: &[u8]) -> Vec<ClosedBlock> {
        let mut blocks = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            let b = bytes[i];

            if self.in_osc {
                // Terminate on BEL (\x07) or ST (\x1b\x5c).
                if b == 0x07 {
                    self.handle_osc(&mut blocks);
                    self.osc_buf.clear();
                    self.in_osc = false;
                } else if b == 0x1b
                    && i + 1 < bytes.len()
                    && bytes[i + 1] == 0x5c
                {
                    self.handle_osc(&mut blocks);
                    self.osc_buf.clear();
                    self.in_osc = false;
                    i += 1; // consume the trailing 0x5c too
                } else {
                    self.osc_buf.push(b);
                }
                i += 1;
                continue;
            }

            if self.in_dcs {
                // DCS terminates only on ST (ESC \) per ECMA-48 — BEL
                // is NOT a valid DCS terminator. Tolerating BEL here
                // would corrupt the JSON payload if a glyph in the
                // payload happens to be 0x07 (rare but possible inside
                // command strings that the shell quoted into the
                // payload).
                if b == 0x1b
                    && i + 1 < bytes.len()
                    && bytes[i + 1] == 0x5c
                {
                    self.handle_dcs();
                    self.dcs_buf.clear();
                    self.in_dcs = false;
                    i += 1; // consume the trailing 0x5c too
                } else {
                    // Cap the buffer so a stuck DCS (shell crashed
                    // mid-write, malicious large payload, etc.) can't
                    // grow unbounded. 64 KB is comfortably above any
                    // legitimate command-line; larger payloads get
                    // dropped at the close.
                    if self.dcs_buf.len() < 64 * 1024 {
                        self.dcs_buf.push(b);
                    }
                }
                i += 1;
                continue;
            }

            // Detect ESC ] which begins an OSC sequence.
            if b == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == 0x5d {
                self.in_osc = true;
                i += 2;
                continue;
            }

            // Detect ESC P which begins a DCS sequence. Warp uses DCS
            // for its richer command-lifecycle hooks; we mirror that
            // wire shape so the protocol stays familiar across tools.
            if b == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == 0x50 {
                self.in_dcs = true;
                i += 2;
                continue;
            }

            // Inside an active block (between A and D), accumulate every
            // byte into the transcript. That includes the prompt's SGR
            // codes, the echoed user input, AND the command output, so
            // the frontend can render a faithful styled replay of the
            // block.
            match self.state {
                SegState::InPromptDrawing
                | SegState::AwaitingCommand
                | SegState::InOutput => {
                    self.current_transcript.push(b);
                }
                SegState::BeforePrompt => {}
            }
            // Keep current_input populated only if a shell *does* emit B
            // (we don't, but defensive). It's a fallback used when the
            // frontend's pending queue is empty.
            if matches!(self.state, SegState::AwaitingCommand)
                && b != b'\r'
                && b != b'\n'
            {
                self.current_input.push(b as char);
            }
            i += 1;
        }
        blocks
    }

    fn handle_osc(&mut self, blocks: &mut Vec<ClosedBlock>) {
        let buf = &self.osc_buf;
        // OSC 7 — cwd reporting. Format: `7;file://hostname/path`. We
        // strip the scheme + hostname and stash the path so the reader
        // thread can emit a Tauri event.
        if buf.starts_with(b"7;") {
            if let Ok(s) = std::str::from_utf8(&buf[2..]) {
                if let Some(path) = parse_file_url(s) {
                    self.pending_cwd = Some(path.clone());
                    self.current_cwd = Some(path);
                }
            }
            return;
        }
        // OSC 133 — block boundaries.
        if !buf.starts_with(b"133;") {
            return;
        }
        let kind = buf.get(4).copied();
        let rest = if buf.len() > 5 && buf[5] == b';' {
            std::str::from_utf8(&buf[6..]).unwrap_or("")
        } else {
            ""
        };
        match kind {
            Some(b'A') => {
                // Prompt start. If we were already in a block, the
                // previous one closes here (D may have been omitted by
                // some shells / non-zero-exit paths).
                if matches!(self.state, SegState::InOutput | SegState::AwaitingCommand) {
                    self.close(None, blocks);
                }
                self.state = SegState::InPromptDrawing;
                self.current_transcript.clear();
                // Mint a stable id for the new block. Renderers can
                // identify blocks across reflow/resize/scroll without
                // having to compare transcript bytes.
                self.current_block_id = self.next_block_id;
                self.next_block_id = self.next_block_id.saturating_add(1);
            }
            Some(b'B') => {
                self.state = SegState::AwaitingCommand;
                self.current_input.clear();
            }
            Some(b'C') => {
                self.state = SegState::InOutput;
                self.command_just_started = true;
                self.current_block_cwd = self.current_cwd.clone();
                self.current_block_start = Some(Instant::now());
                // Drain anything stashed by an earlier `preexec` DCS
                // hook into the running block. Both bash and zsh fire
                // preexec just before OSC 133 C, so when we arrive
                // here `pending_command` already holds the exact line
                // the user submitted (more reliable than reading it
                // out of the terminal echo, which moves around with
                // backspaces / completion / zle widgets).
                if let Some(cmd) = self.pending_command.take() {
                    self.current_input = cmd;
                }
                // Note: pending_start_ms is honoured by close() rather
                // than overwriting current_block_start, so the
                // local-fallback path (no DCS) still works unchanged.
            }
            Some(b'D') => {
                let exit = rest.parse::<i32>().ok();
                self.close(exit, blocks);
                self.state = SegState::BeforePrompt;
            }
            _ => {}
        }
    }

    /// Parse the most recently accumulated DCS payload. Recognised
    /// shape: `goonware;<hook>;<json>` where `<hook>` is one of `preexec`,
    /// `cmd_finished`, `bootstrapped`. Anything else (terminfo capability
    /// payloads, tmux passthrough wrappers, etc.) is silently dropped.
    ///
    /// The DCS protocol is intentionally additive on top of OSC 133 —
    /// it surfaces information the OSC markers can't carry (e.g. the
    /// exact command bytes, the shell-side start timestamp, the real
    /// exit code on bash <5.0). Sessions where the integration script
    /// hasn't been installed (custom shells, ssh into a vanilla box)
    /// never emit DCS, and the OSC 133 fallback continues to drive
    /// block segmentation unchanged.
    fn handle_dcs(&mut self) {
        let buf = &self.dcs_buf;
        // Cheap-prefix check before invoking serde_json on every random
        // DCS payload some other process might emit through the PTY.
        const PREFIX: &[u8] = b"goonware;";
        if !buf.starts_with(PREFIX) {
            return;
        }
        let rest = &buf[PREFIX.len()..];
        // Split on the FIRST `;` only — JSON payloads contain `;` freely
        // (commands like `cd a; ls`), so a greedy split would corrupt
        // them.
        let sep = match rest.iter().position(|&b| b == b';') {
            Some(p) => p,
            None => return,
        };
        let hook = match std::str::from_utf8(&rest[..sep]) {
            Ok(s) => s,
            Err(_) => return,
        };
        let json = match std::str::from_utf8(&rest[sep + 1..]) {
            Ok(s) => s,
            Err(_) => return,
        };
        // Parse permissively — missing fields are fine, the shell
        // hook may evolve independently of this code path. Bad JSON
        // (truncated, unbalanced quotes) drops the hook silently
        // rather than blowing up the segmenter.
        let value: serde_json::Value = match serde_json::from_str(json) {
            Ok(v) => v,
            Err(_) => return,
        };
        match hook {
            "preexec" => {
                if let Some(cmd) = value.get("command").and_then(|v| v.as_str()) {
                    self.pending_command = Some(cmd.to_owned());
                }
                if let Some(ms) = value.get("start_ms").and_then(|v| v.as_u64()) {
                    self.pending_start_ms = Some(ms);
                }
            }
            "cmd_finished" => {
                if let Some(code) = value.get("exit_code").and_then(|v| v.as_i64()) {
                    self.pending_exit_code = Some(code as i32);
                }
                if let Some(ms) = value.get("duration_ms").and_then(|v| v.as_u64()) {
                    self.pending_duration_ms = Some(ms);
                }
            }
            "bootstrapped" => {
                // Reserved for future: shell version detection, prompt
                // metadata, capability negotiation. The integration
                // script already emits this on shell startup so the
                // wire shape is locked in even though we don't act on
                // it yet.
            }
            _ => {}
        }
    }

    fn close(&mut self, exit_code: Option<i32>, blocks: &mut Vec<ClosedBlock>) {
        if self.current_input.is_empty() && self.current_transcript.is_empty() {
            return;
        }
        let transcript = String::from_utf8_lossy(&self.current_transcript).into_owned();
        // Prefer the shell-reported duration (measured by the shell
        // around the actual command, before any output reaches the PTY
        // queue) over the local Instant-based reading (start..close,
        // includes the byte-stream travel time).
        let measured_duration_ms = self
            .current_block_start
            .take()
            .map(|start| start.elapsed().as_millis() as u64);
        let duration_ms = self.pending_duration_ms.take().or(measured_duration_ms);
        // Same reasoning for exit code: bash before 5.0 ignores the
        // value passed to OSC 133 D and always reports 0, so the DCS
        // hook (which reads `$?` directly) is more trustworthy when it
        // exists.
        let exit_code = self.pending_exit_code.take().or(exit_code);
        // The locally-measured start gets consumed but never wired up
        // to ClosedBlock — `duration_ms` is the only timing field on
        // the wire today. `pending_start_ms` is reserved for a future
        // ClosedBlock.start_ms field; clear it here so it doesn't leak
        // across blocks.
        self.pending_start_ms = None;
        let cwd = self.current_block_cwd.take();
        let block_id = self.current_block_id;
        self.current_block_id = 0;
        blocks.push(ClosedBlock {
            block_id,
            input: std::mem::take(&mut self.current_input),
            transcript,
            // Populated by the reader thread post-feed; the segmenter
            // doesn't own an alacritty Term so it can't render the
            // transcript itself. See `snapshot_transcript` for the
            // one-shot parse path that lands the grid rows here.
            block_rows: Vec::new(),
            exit_code,
            cwd,
            duration_ms,
        });
        self.current_transcript.clear();
    }
}

/// `file://hostname/path` → `path`. Hostnames are accepted but
/// discarded; we don't render or compare them. URL escapes (`%20`)
/// are decoded in place so paths with spaces show correctly.
fn parse_file_url(s: &str) -> Option<String> {
    let after_scheme = s.strip_prefix("file://")?;
    let path_start = after_scheme.find('/')?;
    let raw = &after_scheme[path_start..];
    Some(percent_decode(raw))
}

fn percent_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push(((h * 16 + l) as u8) as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

/* ------------------------------------------------------------------
   Color → CSS conversion. Uses the same 16-color palette xterm-theme.ts
   shipped with, plus passes through 24-bit truecolor RGB.
   ------------------------------------------------------------------ */

fn color_to_css(c: Color, fallback: &'static str) -> Cow<'static, str> {
    match c {
        Color::Spec(Rgb { r, g, b }) => {
            Cow::Owned(format!("#{:02x}{:02x}{:02x}", r, g, b))
        }
        Color::Indexed(i) => indexed_color(i),
        Color::Named(named) => named_color(named, fallback),
    }
}

fn indexed_color(i: u8) -> Cow<'static, str> {
    if i < 16 {
        return Cow::Borrowed(ANSI_16[i as usize]);
    }
    if (16..=231).contains(&i) {
        // 6×6×6 cube — computed, must allocate.
        let n = i - 16;
        let r = (n / 36) % 6;
        let g = (n / 6) % 6;
        let b = n % 6;
        let conv = |c: u8| -> u8 {
            if c == 0 {
                0
            } else {
                55 + c * 40
            }
        };
        return Cow::Owned(format!(
            "#{:02x}{:02x}{:02x}",
            conv(r),
            conv(g),
            conv(b)
        ));
    }
    // 232..=255 grayscale
    let level = 8 + (i - 232) * 10;
    Cow::Owned(format!("#{level:02x}{level:02x}{level:02x}"))
}

fn named_color(c: NamedColor, fallback: &'static str) -> Cow<'static, str> {
    match c {
        NamedColor::Foreground => Cow::Borrowed("var(--text-primary)"),
        NamedColor::Background => Cow::Borrowed("var(--surface-0)"),
        NamedColor::Cursor => Cow::Borrowed("var(--accent-bright)"),
        NamedColor::DimBlack => Cow::Borrowed(ANSI_16[0]),
        NamedColor::Black => Cow::Borrowed(ANSI_16[0]),
        NamedColor::BrightBlack => Cow::Borrowed(ANSI_16[8]),
        NamedColor::DimRed | NamedColor::Red => Cow::Borrowed(ANSI_16[1]),
        NamedColor::BrightRed => Cow::Borrowed(ANSI_16[9]),
        NamedColor::DimGreen | NamedColor::Green => Cow::Borrowed(ANSI_16[2]),
        NamedColor::BrightGreen => Cow::Borrowed(ANSI_16[10]),
        NamedColor::DimYellow | NamedColor::Yellow => Cow::Borrowed(ANSI_16[3]),
        NamedColor::BrightYellow => Cow::Borrowed(ANSI_16[11]),
        NamedColor::DimBlue | NamedColor::Blue => Cow::Borrowed(ANSI_16[4]),
        NamedColor::BrightBlue => Cow::Borrowed(ANSI_16[12]),
        NamedColor::DimMagenta | NamedColor::Magenta => Cow::Borrowed(ANSI_16[5]),
        NamedColor::BrightMagenta => Cow::Borrowed(ANSI_16[13]),
        NamedColor::DimCyan | NamedColor::Cyan => Cow::Borrowed(ANSI_16[6]),
        NamedColor::BrightCyan => Cow::Borrowed(ANSI_16[14]),
        NamedColor::DimWhite | NamedColor::White => Cow::Borrowed(ANSI_16[7]),
        NamedColor::BrightWhite => Cow::Borrowed(ANSI_16[15]),
        NamedColor::BrightForeground => Cow::Borrowed("var(--text-primary)"),
        _ => Cow::Borrowed(fallback),
    }
}

// 16 ANSI colors tuned to the workshop-pigment palette for visual
// consistency with the rest of the chrome. Same OKLCH values that lived
// in xterm-theme.ts before this migration.
const ANSI_16: [&str; 16] = [
    "#1c1a17", // black
    "#d97757", // red — workshop rust
    "#86a16f", // green — workshop moss
    "#d8b572", // yellow — workshop amber
    "#7fa1c0", // blue — accent steel
    "#a78fc4", // magenta — workshop iris
    "#7ca0a3", // cyan — workshop pine
    "#b9b4ad", // white
    "#403c37", // bright black
    "#e8896d", // bright red
    "#9ec189", // bright green
    "#e8c98c", // bright yellow
    "#9ab9d4", // bright blue
    "#bda9d6", // bright magenta
    "#92b8bb", // bright cyan
    "#dcd6cc", // bright white
];

/* ------------------------------------------------------------------
   Frame snapshot — walk the grid and compress styled runs.
   ------------------------------------------------------------------

   This is the HOT path: called on every frame for every visible
   terminal, including the 60+ Hz live agent stream. It walks
   alacritty's grid directly (no intermediate FlatStorage allocation)
   to keep the per-frame cost minimal.

   Earlier the path was alacritty → FlatStorage → RowSnapshot via
   alac_adapter — that worked but allocated ~3000 Strings per frame
   per terminal, visibly slowing agent load times. The FlatStorage
   bridge stays alive in `alac_adapter` (used by tests + scrollback
   capture); only the live snapshot path went back to direct.

   `flat_storage_to_row_snapshots` is still exported for the day
   FlatTerm replaces alacritty in Session — at that point the input
   becomes a FlatStorage owned by FlatTerm and this function vanishes
   in favor of `flat_storage_to_row_snapshots`. The parity tests in
   `flat_storage_path_matches_legacy_*` lock the two paths together
   so the eventual swap is provably equivalent. */

fn snapshot_grid<E: EventListener>(term: &Term<E>) -> Vec<RowSnapshot> {
    snapshot_grid_range(term, 0)
}

/// Snapshot every row from `first_line` (inclusive, may be negative
/// for history rows) to `term.screen_lines() - 1` (inclusive, the
/// last visible row). The live emit path always passes 0 — it only
/// cares about the visible grid and sends per-row diffs at 125 fps,
/// so dragging the entire scrollback through the wire on each tick
/// would shred IPC bandwidth. The closed-block path (see
/// `snapshot_transcript`) passes `-history_size()` so a finished
/// claude conversation preserves its full scrollback as
/// `block_rows`, which is what users mean by "the closed block
/// should be the entire history, not just the last screen."
fn snapshot_grid_range<E: EventListener>(
    term: &Term<E>,
    first_line: i32,
) -> Vec<RowSnapshot> {
    let cols = term.columns();
    let last_line = term.screen_lines() as i32;
    let row_count = (last_line - first_line).max(0) as usize;
    let mut out = Vec::with_capacity(row_count);

    for row_idx in first_line..last_line {
        let mut spans: Vec<Span> = Vec::new();
        let mut current: Option<Span> = None;
        for col_idx in 0..cols {
            let point = Point::new(Line(row_idx), Column(col_idx));
            let cell: &Cell = &term.grid()[point];
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            let span = cell_to_span(cell);
            match &mut current {
                Some(c) if c.fg == span.fg
                    && c.bg == span.bg
                    && c.bold == span.bold
                    && c.italic == span.italic
                    && c.underline == span.underline
                    && c.inverse == span.inverse
                    && c.dim == span.dim
                    && c.strikeout == span.strikeout =>
                {
                    c.text.push_str(&span.text);
                }
                Some(_) | None => {
                    if let Some(c) = current.take() {
                        spans.push(c);
                    }
                    current = Some(span);
                }
            }
        }
        if let Some(c) = current.take() {
            spans.push(c);
        }
        out.push(RowSnapshot { spans });
    }
    out
}

/// Test-only mirror of `snapshot_grid`. Identical to the prod path —
/// kept under #[cfg(test)] so we can still reference it by a stable
/// name from `flat_storage_path_matches_legacy_*` even after the prod
/// path's name changes in the future.
#[cfg(test)]
fn snapshot_grid_legacy<E: EventListener>(term: &Term<E>) -> Vec<RowSnapshot> {
    let cols = term.columns();
    let rows = term.screen_lines();
    let mut out = Vec::with_capacity(rows);

    for row_idx in 0..rows {
        let mut spans: Vec<Span> = Vec::new();
        let mut current: Option<Span> = None;
        for col_idx in 0..cols {
            let point = Point::new(Line(row_idx as i32), Column(col_idx));
            let cell: &Cell = &term.grid()[point];
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            let span = cell_to_span(cell);
            match &mut current {
                Some(c) if c.fg == span.fg
                    && c.bg == span.bg
                    && c.bold == span.bold
                    && c.italic == span.italic
                    && c.underline == span.underline
                    && c.inverse == span.inverse
                    && c.dim == span.dim
                    && c.strikeout == span.strikeout =>
                {
                    c.text.push_str(&span.text);
                }
                Some(_) | None => {
                    if let Some(c) = current.take() {
                        spans.push(c);
                    }
                    current = Some(span);
                }
            }
        }
        if let Some(c) = current.take() {
            spans.push(c);
        }
        out.push(RowSnapshot { spans });
    }
    out
}

/// Translate a `FlatStorage` into the legacy `RowSnapshot` wire format.
///
/// Walks each row grapheme-by-grapheme, looking up fg + (bg, style) from
/// the interval maps at the grapheme's byte offset and coalescing
/// equal-attribute runs into a single span. Output matches what
/// `snapshot_grid_legacy` produces for the same source grid (proven by
/// the `flat_storage_path_matches_legacy_*` parity tests below).
// FlatStorage → RowSnapshot conversion. Currently used only by the
// flat_storage_path_matches_legacy_* tests; once FlatTerm is wired
// into Session this becomes the prod snapshot path. Gated on test
// for now to keep prod builds free of the unused-fn warning.
#[cfg(test)]
#[allow(dead_code)] // forward-compat scaffold for the FlatTerm migration; see comment above
fn flat_storage_to_row_snapshots(
    fs: &crate::flat_storage::FlatStorage,
) -> Vec<RowSnapshot> {
    let mut out = Vec::with_capacity(fs.row_count());
    for row_idx in 0..fs.row_count() {
        let row_range = fs
            .row_byte_range(row_idx)
            .expect("row_idx < row_count");
        let row_text = fs.row(row_idx).expect("row_idx < row_count");
        let mut spans: Vec<Span> = Vec::new();
        let mut current: Option<Span> = None;
        let mut byte = row_range.start;
        for ch in row_text.chars() {
            let fg = fs.fg_at(byte);
            let bg_and_style = fs.bg_and_style_at(byte);
            let span = packed_cell_to_span(ch, fg, bg_and_style);
            match &mut current {
                Some(c) if spans_match(c, &span) => {
                    c.text.push_str(&span.text);
                }
                _ => {
                    if let Some(c) = current.take() {
                        spans.push(c);
                    }
                    current = Some(span);
                }
            }
            byte += ch.len_utf8();
        }
        if let Some(c) = current.take() {
            spans.push(c);
        }
        out.push(RowSnapshot { spans });
    }
    out
}

#[cfg(test)]
fn spans_match(a: &Span, b: &Span) -> bool {
    a.fg == b.fg
        && a.bg == b.bg
        && a.bold == b.bold
        && a.italic == b.italic
        && a.underline == b.underline
        && a.inverse == b.inverse
        && a.dim == b.dim
        && a.strikeout == b.strikeout
}

/// Build a Span for one grapheme, with attributes lifted from
/// FlatStorage's packed encoding.
#[cfg(test)]
#[allow(dead_code)]
fn packed_cell_to_span(
    ch: char,
    fg: crate::flat_storage::PackedColor,
    bs: crate::flat_storage::BgAndStyle,
) -> Span {
    let mut text = String::new();
    text.push(ch);
    Span {
        text,
        fg: packed_color_to_css(fg, "var(--text-primary)"),
        bg: packed_color_to_css(bs.bg, "var(--surface-0)"),
        bold: bs.style.bold(),
        italic: bs.style.italic(),
        underline: bs.style.underline(),
        inverse: bs.style.inverse(),
        dim: bs.style.dim(),
        strikeout: bs.style.strikeout(),
        link: None,
    }
}

/// PackedColor → CSS, equivalent to `color_to_css(Color, fallback)`
/// for the alacritty Color variants that our adapter actually
/// produces. The `Named` variant uses the raw NamedColor index — see
/// `alac_adapter::color_to_packed` for the mapping.
#[cfg(test)]
#[allow(dead_code)]
fn packed_color_to_css(
    c: crate::flat_storage::PackedColor,
    fallback: &'static str,
) -> Cow<'static, str> {
    use crate::flat_storage::PackedColorKind;
    match c.classify() {
        PackedColorKind::Default => Cow::Borrowed(fallback),
        PackedColorKind::Named(idx) => {
            // Translate the packed named-color index back to alacritty's
            // NamedColor enum, then through the legacy named_color
            // helper so we keep one source of truth for the palette.
            // Variants beyond the printable range produce the fallback.
            named_color_from_raw_index(idx, fallback)
        }
        PackedColorKind::Indexed(idx) => indexed_color(idx),
        PackedColorKind::Rgb(r, g, b) => {
            Cow::Owned(format!("#{:02x}{:02x}{:02x}", r, g, b))
        }
    }
}

/// Translate a raw `NamedColor as u16` discriminant back into the CSS
/// string the legacy path would have produced. The discriminants are
/// the actual u16 values from alacritty's `NamedColor` declaration
/// (`#[repr(u16)]`): 0..=15 for the 16 ANSI base colors, then 256..=268
/// for the Foreground / Background / Cursor / Dim* / Bright* set.
/// Variants outside those ranges produce the fallback.
#[cfg(test)]
#[allow(dead_code)]
fn named_color_from_raw_index(
    idx: u16,
    fallback: &'static str,
) -> Cow<'static, str> {
    let name = match idx {
        // 16 ANSI base colors (0..=15) — see vte::ansi::NamedColor.
        0 => NamedColor::Black,
        1 => NamedColor::Red,
        2 => NamedColor::Green,
        3 => NamedColor::Yellow,
        4 => NamedColor::Blue,
        5 => NamedColor::Magenta,
        6 => NamedColor::Cyan,
        7 => NamedColor::White,
        8 => NamedColor::BrightBlack,
        9 => NamedColor::BrightRed,
        10 => NamedColor::BrightGreen,
        11 => NamedColor::BrightYellow,
        12 => NamedColor::BrightBlue,
        13 => NamedColor::BrightMagenta,
        14 => NamedColor::BrightCyan,
        15 => NamedColor::BrightWhite,
        // Specials (256..=268). 256/257 are Foreground/Background —
        // alac_adapter collapses those to DEFAULT, so they shouldn't
        // reach here; map them anyway so a future caller doesn't get
        // surprise fallback colours.
        256 => NamedColor::Foreground,
        257 => NamedColor::Background,
        258 => NamedColor::Cursor,
        259 => NamedColor::DimBlack,
        260 => NamedColor::DimRed,
        261 => NamedColor::DimGreen,
        262 => NamedColor::DimYellow,
        263 => NamedColor::DimBlue,
        264 => NamedColor::DimMagenta,
        265 => NamedColor::DimCyan,
        266 => NamedColor::DimWhite,
        267 => NamedColor::BrightForeground,
        268 => NamedColor::DimForeground,
        _ => return Cow::Borrowed(fallback),
    };
    named_color(name, fallback)
}

/// A no-op `EventListener` for the throwaway `Term` instances used by
/// `snapshot_transcript`. Those Terms parse a finished block's bytes
/// for the sole purpose of yielding a snapshot — we don't care about
/// bell / title / child-exit events fired while they parse, because
/// no actual PTY is attached and no one's listening.
#[derive(Clone)]
struct NullEventProxy;

impl EventListener for NullEventProxy {
    fn send_event(&self, _event: AlacEvent) {}
}

/// Render a closed block's byte transcript into a `Vec<RowSnapshot>`
/// by replaying it through a fresh `alacritty_terminal::Term` of the
/// requested size, then walking the resulting grid.
///
/// This is the Warp-style block render path. The frontend's small
/// `parseAnsi.ts` handles SGR and line breaks but ignores cursor
/// moves, line clears, CR overstrike, and the rest of the VT
/// repertoire — so progress bars (`\r`-redrawn lines), `clear`,
/// spinners, and TUI redraws all rendered incorrectly when blocks
/// were reconstructed in JS. Replaying through alacritty in Rust
/// gives the closed block the same rendering fidelity the live grid
/// has, at a one-shot CPU cost paid once per block close.
///
/// Trailing all-empty rows are stripped so the block sizes naturally
/// to actual content; otherwise short commands would render with
/// dozens of blank rows below them (one for each unused row of the
/// scratch Term's screen).
pub(crate) fn snapshot_transcript(transcript: &str, cols: u16, rows: u16) -> Vec<RowSnapshot> {
    if transcript.is_empty() {
        return Vec::new();
    }
    let dims = Dims {
        cols: cols.max(1) as usize,
        rows: rows.max(1) as usize,
    };
    // Strip trailing screen-destructive sequences before replay. When
    // an interactive agent (claude / codex / gemini) is Ctrl+C'd, its
    // cleanup emits DECRST 1049 (exit alt-screen) and often an erase-
    // screen + cursor-home. Feeding those through a fresh alacritty
    // Term wipes the alt-screen content that the user was looking at —
    // the closed block ends up empty. Trimming the tail keeps the
    // agent's final TUI state as scrollable history, mirroring
    // Warp's "Ctrl+C preserves the conversation" behaviour.
    let trimmed = strip_trailing_screen_destruction(transcript);
    let mut term = Term::new(term_config(), &dims, NullEventProxy);
    let mut parser: Processor = Processor::new();
    parser.advance(&mut term, trimmed.as_bytes());
    // Walk visible + scrollback. With the default TermConfig the
    // scratch Term has a 10 000-row history, so a long claude
    // session whose UI scrolled past the visible screen still
    // surfaces every row that ever rendered. Walking only the
    // visible grid (the prior behaviour) silently lost everything
    // above the screen at close-time, which is what users mean by
    // "the closed agent block got cut off."
    let first_line = -(term.history_size() as i32);
    let mut snap = snapshot_grid_range(&term, first_line);
    // Drop trailing rows that are empty / all-whitespace. A row is
    // "empty" when its spans contain nothing but whitespace text.
    // Done greedily from the bottom — we never trim from the middle
    // because alacritty already coalesces blank rows in scrollback.
    while let Some(last) = snap.last() {
        let blank = last
            .spans
            .iter()
            .all(|s| s.text.chars().all(|c| c.is_whitespace()));
        if blank {
            snap.pop();
        } else {
            break;
        }
    }
    snap
}

/// Trim trailing "destroy the screen state we just wrote" sequences
/// from a transcript before it gets replayed for a closed-block
/// snapshot. The goal is to preserve the agent's last visible TUI
/// frame as scrollable history — Warp's "Ctrl+C keeps the
/// conversation" behaviour.
///
/// Sequences trimmed (greedy, repeated from the tail):
///   * DECRST 1049  (`ESC [ ? 1049 l`) — exit alt-screen
///   * DECRST 1047  (`ESC [ ? 1047 l`) — exit alt-screen (older variant)
///   * DECRST 47    (`ESC [ ? 47 l`)   — exit alt-screen (oldest)
///   * Erase-display-all (`ESC [ 2 J`)
///   * Erase-display-saved (`ESC [ 3 J`)
///   * Cursor home (`ESC [ H` / `ESC [ ; H` / `ESC [ 1 ; 1 H`)
///   * Show cursor (`ESC [ ? 25 h`) — common in cleanup
///   * Reset SGR (`ESC [ 0 m` / `ESC [ m`)
///   * Plain whitespace (CR / LF / spaces)
///
/// The match is byte-level on a suffix-stripping loop — order
/// matters: we strip one sequence at a time from the tail, repeating
/// until nothing in the trim set is found. Conservative on what gets
/// trimmed; anything we don't recognise is preserved.
fn strip_trailing_screen_destruction(transcript: &str) -> &str {
    let mut bytes = transcript.as_bytes();
    // Suffix patterns to strip, longest first so e.g. `ESC[?1049l`
    // matches before `ESC[?47l` (substring-style overlap).
    const PATTERNS: &[&[u8]] = &[
        b"\x1b[?1049l",
        b"\x1b[?1047l",
        b"\x1b[?47l",
        b"\x1b[?25h",
        b"\x1b[?25l",
        b"\x1b[2J",
        b"\x1b[3J",
        b"\x1b[1;1H",
        b"\x1b[;H",
        b"\x1b[H",
        b"\x1b[0m",
        b"\x1b[m",
    ];
    loop {
        let original_len = bytes.len();
        // Strip trailing whitespace bytes that the agent's cleanup
        // pad emits between escape sequences (CR / LF / SPACE / TAB).
        while let Some(&b) = bytes.last() {
            if b == b'\r' || b == b'\n' || b == b' ' || b == b'\t' {
                bytes = &bytes[..bytes.len() - 1];
            } else {
                break;
            }
        }
        // Strip one escape-sequence suffix per outer loop iteration.
        let mut matched = false;
        for pat in PATTERNS {
            if bytes.ends_with(pat) {
                bytes = &bytes[..bytes.len() - pat.len()];
                matched = true;
                break;
            }
        }
        if !matched && bytes.len() == original_len {
            // Nothing stripped this round — fixed point.
            break;
        }
    }
    // Safe because `bytes` is always a UTF-8-aligned suffix of the
    // original string: every byte we strip is either ASCII or part of
    // an ASCII-only escape sequence, so cutting at the trim point
    // never lands inside a multi-byte UTF-8 character.
    std::str::from_utf8(bytes).unwrap_or(transcript)
}

fn cell_to_span(cell: &Cell) -> Span {
    let mut text = String::new();
    text.push(cell.c);
    if let Some(zw) = cell.zerowidth() {
        for ch in zw {
            text.push(*ch);
        }
    }
    Span {
        text,
        fg: color_to_css(cell.fg, "var(--text-primary)"),
        bg: color_to_css(cell.bg, "var(--surface-0)"),
        bold: cell.flags.contains(Flags::BOLD),
        italic: cell.flags.contains(Flags::ITALIC),
        underline: cell.flags.intersects(Flags::ALL_UNDERLINES),
        inverse: cell.flags.contains(Flags::INVERSE),
        dim: cell.flags.contains(Flags::DIM),
        strikeout: cell.flags.contains(Flags::STRIKEOUT),
        link: None,
    }
}

fn diff_rows(prev: &[RowSnapshot], next: &[RowSnapshot]) -> Vec<DirtyRow> {
    let mut out = Vec::new();
    for (i, row) in next.iter().enumerate() {
        match prev.get(i) {
            Some(p) if p == row => {}
            _ => out.push(DirtyRow {
                row: i as u16,
                spans: row.spans.clone(),
            }),
        }
    }
    out
}

/* ------------------------------------------------------------------
   Shell integration — drops a .zshrc that emits OSC 133 markers + an
   empty PS1, spawned zsh sees it via ZDOTDIR. Lets the BlockSegmenter
   close blocks at the right boundaries, and hides the noisy host/cwd
   prompt that duplicated our breadcrumb pill bar.
   ------------------------------------------------------------------ */

const ZSH_INTEGRATION: &str = r#"# Goonware shell integration — auto-generated, do not edit.
# Sources the user's real configuration first, then installs OSC 133
# semantic-prompt markers + OSC 7 cwd reporting + Warp-style DCS hooks
# carrying richer command metadata + an empty PROMPT. The empty PROMPT
# is intentional: Goonware's chrome already shows folder / branch / diff in
# a pill row above the input, so the shell's own host@machine cwd %
# line would just duplicate that and eat vertical space inside every
# closed block.

# Save the integration ZDOTDIR before any user config can clobber it.
GOONWARE_INTEGRATION_DIR="$ZDOTDIR"

# Restore the original ZDOTDIR (or fall back to HOME) so the user's
# real .zshrc and the rest of zsh's config files (.zlogin, .zprofile,
# etc.) load from where the user keeps them.
if [ -n "$GOONWARE_USER_ZDOTDIR" ]; then
    export ZDOTDIR="$GOONWARE_USER_ZDOTDIR"
elif [ -n "$ZDOTDIR" ]; then
    unset ZDOTDIR
fi

# Source user config from its real location.
if [ -n "$ZDOTDIR" ] && [ -f "$ZDOTDIR/.zshrc" ]; then
    source "$ZDOTDIR/.zshrc"
elif [ -f "$HOME/.zshrc" ]; then
    source "$HOME/.zshrc"
fi

# JSON-escape a string for DCS payload bodies. We avoid shelling out
# (jq, python) because (a) jq isn't guaranteed to be installed and
# (b) the precmd / preexec path runs around every prompt and a subshell
# round-trip adds visible latency.
_goonware_json_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\t'/\\t}"
    printf '%s' "$s"
}

# Wall-clock milliseconds. zsh's $EPOCHREALTIME (e.g. "1700000000.123")
# requires the zsh/datetime module which is bundled with every modern
# zsh build but we still fall back to `date +%s000` for paranoia.
_goonware_now_ms() {
    if [[ -n "$EPOCHREALTIME" ]]; then
        # Truncate fractional seconds to ms (3 digits).
        printf '%s' "${EPOCHREALTIME//./}" | cut -c1-13
    else
        printf '%s' "$(date +%s)000"
    fi
}
zmodload zsh/datetime 2>/dev/null

# OSC 133 semantic-prompt markers. The segmenter on the Rust side
# slices the byte stream at these points to build per-command blocks.
#
#   A — prompt about to be drawn (also closes the previous command via D)
#   C — command output starts (preexec, after the user pressed Enter)
#
# We deliberately omit B (end-of-prompt) because the React-side
# PromptInput captures the user's input directly — far more reliable
# than fishing it out of the byte stream.
#
# DCS hooks — Warp-style enriched lifecycle events. Wire format:
#   ESC P goonware ; <hook> ; <json> ESC \
# Fired alongside OSC 133 so a session whose Rust side speaks only
# OSC 133 still segments correctly, and a session that speaks both
# gets the richer metadata. The hooks ARE ordered relative to the OSC
# markers:
#   preexec:      before OSC 133 C  → carries the user's command + start_ms
#   cmd_finished: before OSC 133 D  → carries exact exit + duration
_goonware_precmd() {
    local _exit=$?
    local _now_ms="$(_goonware_now_ms)"
    local _duration_ms=0
    if [[ -n "$_GOONWARE_BLOCK_START_MS" ]]; then
        _duration_ms=$(( _now_ms - _GOONWARE_BLOCK_START_MS ))
        unset _GOONWARE_BLOCK_START_MS
    fi
    printf '\eP'"goonware;cmd_finished;{\"exit_code\":%d,\"duration_ms\":%d}"'\e\\' \
        "$_exit" "$_duration_ms"
    print -Pn "\e]133;D;${_exit}\a"
    print -Pn "\e]133;A\a"
    # Defensively re-empty PROMPT every time a prompt is about to draw.
    # Some Oh-My-Zsh / Powerlevel10k themes recompute PROMPT inside
    # their own precmd; appending us last in precmd_functions means we
    # run after them and the empty value wins.
    PROMPT=''
    RPROMPT=''
}
_goonware_preexec() {
    # `$1` is the unexpanded command line as the user typed it. zsh's
    # preexec callback signature: preexec <typed> <expanded> <fullhist>.
    local _cmd="$1"
    local _now_ms="$(_goonware_now_ms)"
    export _GOONWARE_BLOCK_START_MS="$_now_ms"
    printf '\eP'"goonware;preexec;{\"command\":\"%s\",\"start_ms\":%s}"'\e\\' \
        "$(_goonware_json_escape "$_cmd")" "$_now_ms"
    print -Pn "\e]133;C\a"
}

# OSC 7 cwd reporting. Emitted on shell startup and on every cd, so
# the chrome's folder pill tracks the *live* terminal cwd instead of
# only the launch cwd.
_goonware_chpwd() {
    print -Pn "\e]7;file://%m%d\a"
}

typeset -ag precmd_functions
typeset -ag preexec_functions
typeset -ag chpwd_functions
precmd_functions+=(_goonware_precmd)
preexec_functions+=(_goonware_preexec)
chpwd_functions+=(_goonware_chpwd)

# One-shot startup hook — surfaces shell type + pid to the Rust side
# for future capability negotiation (Phase 2+). The Rust segmenter
# parses this but doesn't act on it yet, so it's harmless if unread.
printf '\eP'"goonware;bootstrapped;{\"shell\":\"zsh\",\"shell_pid\":%d,\"version\":\"1\"}"'\e\\' "$$"

# Initial cwd report — fires once at startup so the pill shows the
# launch directory before any cd happens.
_goonware_chpwd

# Initial PROMPT wipe — covers the very first prompt drawn before
# any precmd runs.
PROMPT=''
RPROMPT=''
"#;

/// Write the zsh integration script into the app data dir and return
/// the directory we want zsh to treat as its ZDOTDIR. Idempotent —
/// rewritten on every spawn so updates ship without manual cleanup.
fn ensure_zsh_integration_dir(app: &AppHandle<Wry>) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let dir = base.join("shell-integration").join("zsh");
    fs::create_dir_all(&dir).map_err(|e| format!("create integration dir: {e}"))?;
    let path = dir.join(".zshrc");
    fs::write(&path, ZSH_INTEGRATION).map_err(|e| format!("write zshrc: {e}"))?;
    Ok(dir)
}

/* ------------------------------------------------------------------
   Bash shell integration. Bash can't be ZDOTDIR-hijacked, but
   `bash --rcfile <path>` will load `<path>` instead of the default
   `~/.bashrc`. We point bash at a generated rc that sources the
   user's real `~/.bashrc` first and then installs the same OSC 133
   markers + DCS hooks that the zsh integration uses. Bash gets the
   preexec equivalent via `trap DEBUG`; the flag-guarded pattern
   (set in PROMPT_COMMAND, unset in the trap) prevents the trap from
   firing on every subshell inside the user's command.
   ------------------------------------------------------------------ */

const BASH_INTEGRATION: &str = r#"# Goonware shell integration for bash — auto-generated, do not edit.
# Loaded via `bash --rcfile <this-file>`. We source the user's real
# .bashrc first so their aliases / completions / PATH all still work,
# then install OSC 133 segmentation markers + Warp-style DCS hooks.

# Source user config from the standard locations, in the order bash
# itself would, then carry on with our own setup.
if [ -f "$HOME/.bashrc" ]; then
    source "$HOME/.bashrc"
elif [ -f "$HOME/.bash_profile" ]; then
    source "$HOME/.bash_profile"
fi

# JSON-escape a string for DCS payload bodies. Same logic as the zsh
# version; bash's parameter expansion is close enough that the body
# is identical.
_goonware_json_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\t'/\\t}"
    printf '%s' "$s"
}

# Wall-clock milliseconds. Bash 5+ has $EPOCHREALTIME natively; older
# bash falls back to `date +%s%3N` on Linux or `date +%s000` on macOS
# where date doesn't support %N.
_goonware_now_ms() {
    if [[ -n "${EPOCHREALTIME-}" ]]; then
        local sec="${EPOCHREALTIME%.*}"
        local frac="${EPOCHREALTIME#*.}"
        # Pad / truncate frac to exactly 3 digits.
        frac="${frac}000"
        printf '%s' "${sec}${frac:0:3}"
    else
        # %3N is GNU-only; on macOS (BSD date) the fallback adds three
        # zeros so we at least produce a sane ms-resolution value.
        local out
        out="$(date +%s%3N 2>/dev/null)"
        if [[ "$out" == *N ]]; then
            out="$(date +%s)000"
        fi
        printf '%s' "$out"
    fi
}

# preexec via trap DEBUG. Only fires when armed by PROMPT_COMMAND —
# without the flag guard the trap fires inside every subshell of every
# pipeline (e.g. `ls | grep x` would emit two preexec markers, one for
# each side of the pipe).
_goonware_preexec_armed=0
_goonware_preexec() {
    if [[ "$_goonware_preexec_armed" != "1" ]]; then return; fi
    _goonware_preexec_armed=0
    # BASH_COMMAND holds the command about to run. For pipelines bash
    # invokes the trap with the leftmost command; that's a reasonable
    # approximation of "the line the user typed" for display purposes.
    local _cmd="${BASH_COMMAND:-}"
    local _now_ms
    _now_ms="$(_goonware_now_ms)"
    export _GOONWARE_BLOCK_START_MS="$_now_ms"
    printf '\eP''goonware;preexec;{"command":"%s","start_ms":%s}''\e\\' \
        "$(_goonware_json_escape "$_cmd")" "$_now_ms"
    printf '\e]133;C\a'
}
trap '_goonware_preexec' DEBUG

# precmd via PROMPT_COMMAND. We chain ourselves AFTER whatever the
# user already had so their setup (e.g. `__git_ps1`, history sync)
# runs first; if it overwrote PS1, we silence it below.
_goonware_precmd() {
    local _exit=$?
    local _now_ms
    _now_ms="$(_goonware_now_ms)"
    local _duration_ms=0
    if [[ -n "${_GOONWARE_BLOCK_START_MS-}" ]]; then
        _duration_ms=$(( _now_ms - _GOONWARE_BLOCK_START_MS ))
        unset _GOONWARE_BLOCK_START_MS
    fi
    printf '\eP''goonware;cmd_finished;{"exit_code":%d,"duration_ms":%d}''\e\\' \
        "$_exit" "$_duration_ms"
    printf '\e]133;D;%d\a' "$_exit"
    printf '\e]133;A\a'
    # Goonware's chrome shows folder + branch above the input; silence the
    # shell's own prompt so the block doesn't duplicate that line.
    PS1=''
    PS2=''
    # Re-arm the preexec trap for the next command.
    _goonware_preexec_armed=1
}

# OSC 7 cwd reporting via PROMPT_COMMAND wrapping. Bash doesn't have
# a chpwd hook, so we emit on every prompt — cheap (printf to PTY).
_goonware_chpwd_emit() {
    printf '\e]7;file://%s%s\a' "$HOSTNAME" "$PWD"
}

# Hook ourselves into PROMPT_COMMAND. Bash 5.1+ supports arrays; older
# versions get a string concatenation. Either way we run *after* the
# user's existing PROMPT_COMMAND so their setup still works.
if [[ "${BASH_VERSINFO[0]}" -ge 5 && "${BASH_VERSINFO[1]}" -ge 1 ]] 2>/dev/null; then
    if ! declare -p PROMPT_COMMAND 2>/dev/null | grep -q 'declare -a'; then
        # Convert scalar to array preserving the existing value.
        PROMPT_COMMAND=("${PROMPT_COMMAND-}")
    fi
    PROMPT_COMMAND+=('_goonware_chpwd_emit' '_goonware_precmd')
else
    PROMPT_COMMAND="${PROMPT_COMMAND:+${PROMPT_COMMAND}$'\n'}_goonware_chpwd_emit; _goonware_precmd"
fi

# Bootstrapped hook + initial cwd emit so the chrome has data before
# the user's first command.
printf '\eP''goonware;bootstrapped;{"shell":"bash","shell_pid":%d,"version":"1"}''\e\\' "$$"
_goonware_chpwd_emit
PS1=''
PS2=''
_goonware_preexec_armed=1
"#;

/// Write the bash integration rc file into the app data dir and
/// return its absolute path. The bash command is then launched as
/// `bash --rcfile <path> -i`. Idempotent.
fn ensure_bash_integration_rc(app: &AppHandle<Wry>) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let dir = base.join("shell-integration").join("bash");
    fs::create_dir_all(&dir).map_err(|e| format!("create integration dir: {e}"))?;
    let path = dir.join("goonware-bashrc");
    fs::write(&path, BASH_INTEGRATION).map_err(|e| format!("write goonware-bashrc: {e}"))?;
    Ok(path)
}

/* ------------------------------------------------------------------
   Tauri commands.
   ------------------------------------------------------------------ */

#[derive(Debug, Deserialize)]
pub struct StartArgs {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub rows: u16,
    pub cols: u16,
    /// Active project id (e.g. `p_rli_l2k4j`). Injected into the PTY's
    /// env as `GOONWARE_PROJECT_ID` / `GLI_PROJECT_ID` / `RLI_PROJECT_ID`
    /// so in-pane agents can identify which project they're running
    /// in.
    #[serde(default)]
    pub project_id: Option<String>,
    /// Active session id. Injected as `GOONWARE_SESSION_ID` /
    /// `GLI_SESSION_ID` / `RLI_SESSION_ID`.
    /// Same intent as `project_id` but scoped one level finer.
    #[serde(default)]
    pub session_id: Option<String>,
}

#[tauri::command]
pub fn term_start(
    app: AppHandle<Wry>,
    state: State<TerminalState>,
    args: StartArgs,
    // Frame channel must be a top-level command arg — `Channel<T>`
    // implements `CommandArg` for IPC deserialization, but it does
    // NOT implement Deserialize, so it can't sit inside a nested
    // struct. The frontend invokes with `{ args: {...}, frameChannel }`.
    frame_channel: Channel<RenderFrame>,
) -> Result<(), String> {
    // Idempotent path: if a PTY with this id is already alive, reuse
    // it and re-emit the full grid as a single "all rows dirty" frame
    // so the freshly-mounted React component can hydrate without ever
    // having seen the original startup events. This is what makes
    // session/project switches stop wiping the terminal — the React
    // component can unmount and remount freely; the PTY stays alive
    // and resyncs on each remount.
    {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = sessions.get(&args.id).cloned() {
            drop(sessions);
            if let Ok(mut s) = existing.lock() {
                // Replace the channel — the old one belonged to the
                // previous BlockTerminal mount which is now gone.
                // Any further frame emit needs to land on the freshly
                // mounted React listener, which owns this new channel.
                s.frame_channel = frame_channel.clone();
                let snapshot = snapshot_grid(&s.term);
                let cursor = s.term.grid().cursor.point;
                let dirty: Vec<DirtyRow> = snapshot
                    .iter()
                    .enumerate()
                    .map(|(row, snap)| DirtyRow {
                        row: row as u16,
                        spans: snap.spans.clone(),
                    })
                    .collect();
                // Full scrollback snapshot — remount needs the entire
                // history so the user's pre-remount scroll position is
                // recoverable. `scrollback_reset: true` tells the
                // frontend to drop whatever it had and rebuild from
                // these rows.
                let history_size = s.term.grid().history_size();
                let scrollback_appended = sample_scrollback_rows(&s.term, history_size);
                s.last_history_size = history_size;
                let seq = s.next_frame_seq;
                s.next_frame_seq = s.next_frame_seq.saturating_add(1);
                let frame = RenderFrame {
                    seq,
                    block_id: s.segmenter.current_block_id(),
                    cols: s.cols,
                    rows: s.rows,
                    cursor_row: cursor.line.0,
                    cursor_col: cursor.column.0 as u16,
                    alt_screen: s.term.mode().contains(TermMode::ALT_SCREEN),
                    command_running: s.last_command_running,
                    app_cursor: s.term.mode().contains(TermMode::APP_CURSOR),
                    bracketed_paste: s.term.mode().contains(TermMode::BRACKETED_PASTE),
                    cursor_visible: s.term.mode().contains(TermMode::SHOW_CURSOR),
                    dirty,
                    scrollback_appended,
                    scrollback_reset: true,
                };
                emit_native_frame(&args.id, &frame);
                let _ = s.frame_channel.send(frame);
            }
            return Ok(());
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: args.rows,
            cols: args.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = CommandBuilder::new(&args.command);
    cmd.args(&args.args);
    if let Some(cwd) = args.cwd.as_deref() {
        cmd.cwd(cwd);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Tells `claude` / `codex` / hand-rolled shell scripts running
    // inside this PTY where to find the in-house browser daemon.
    // Without this, `claude` would reach for its `claude-in-chrome`
    // MCP server (which drives the user's real Chrome — not what we
    // want for app testing).
    //
    // We read the **actual** bound port from `BrowserState` instead
    // of hardcoding 4000 — the daemon may have landed anywhere in
    // 4000..=4199 (collision case) or even on an OS-assigned port if
    // the whole preferred range was taken. Hardcoding 4000 meant
    // agents inside PTYs were sometimes pointed at nothing.
    //
    // If the daemon hasn't finished binding yet (rare race on app
    // boot), fall back to the default 4000 — at worst the agent will
    // get a connection-refused on the first call and recover when
    // the daemon comes up, which is the same failure mode the old
    // hardcoded value had.
    #[cfg(target_os = "macos")]
    let browser_port = app
        .try_state::<crate::browser::BrowserState>()
        .and_then(|s| s.port())
        .unwrap_or(4000);
    #[cfg(not(target_os = "macos"))]
    let browser_port = 4000u16;
    let browser_url = format!("http://127.0.0.1:{browser_port}");
    // Export GOONWARE_* (current), GLI_* (prior name), and RLI_*
    // (legacy) so user-side tooling that hardcodes any spelling keeps
    // working through the rename window.
    cmd.env("GOONWARE_BROWSER_URL", &browser_url);
    cmd.env("GLI_BROWSER_URL", &browser_url);
    cmd.env("RLI_BROWSER_URL", &browser_url);

    // Per-pane scoping: in-pane agents (claude, codex, gemini) read
    // these env vars to scope their behavior to the project + session
    // they're running in. Not memory-specific — kept as generic
    // session metadata after the memory subsystem was removed.
    if let Some(pid) = args.project_id.as_deref() {
        cmd.env("GOONWARE_PROJECT_ID", pid);
        cmd.env("GLI_PROJECT_ID", pid);
        cmd.env("RLI_PROJECT_ID", pid);
    }
    if let Some(sid) = args.session_id.as_deref() {
        cmd.env("GOONWARE_SESSION_ID", sid);
        cmd.env("GLI_SESSION_ID", sid);
        cmd.env("RLI_SESSION_ID", sid);
    }
    // Tag the PTY with THIS Goonware instance's id so the agent hook script can
    // route its events back to the instance that spawned it. Without this, when
    // two instances run (e.g. `tauri dev` + the installed app) the hook can't
    // tell whose agent fired, and the per-instance socket fan-out can't filter
    // — see `agent_hooks::should_drop_envelope`.
    cmd.env("GOONWARE_INSTANCE_ID", crate::agent_hooks::instance_id());

    // Install shell integration so the BlockSegmenter sees the OSC
    // 133 markers + Warp-style DCS hooks. Behavior differs by shell:
    //
    //   zsh:  hijack ZDOTDIR → load our generated .zshrc, which
    //         sources the user's real .zshrc first then installs the
    //         hooks via precmd_functions / preexec_functions /
    //         chpwd_functions.
    //
    //   bash: pass `--rcfile <path>` so bash loads our goonware-bashrc
    //         instead of the default. The rc sources ~/.bashrc first
    //         then installs the trap DEBUG / PROMPT_COMMAND hooks.
    //         `--rcfile` requires the shell to be interactive; we
    //         pass `-i` to be safe even when the spawn cwd is set.
    //
    // Shells we don't recognise (fish, pwsh, plain `sh`, custom
    // shells) launch unmodified — the user just doesn't get block
    // segmentation in that PTY. Future work: fish + pwsh bootstrap.
    let command_basename = std::path::Path::new(&args.command)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&args.command);
    if command_basename == "zsh" {
        if let Ok(dir) = ensure_zsh_integration_dir(&app) {
            // Stash the user's existing ZDOTDIR (if any) so the
            // integration script can chain-source from there.
            if let Ok(prev) = std::env::var("ZDOTDIR") {
                cmd.env("GOONWARE_USER_ZDOTDIR", prev);
            }
            cmd.env("ZDOTDIR", dir.to_string_lossy().into_owned());
        }
    } else if command_basename == "bash" {
        if let Ok(rc) = ensure_bash_integration_rc(&app) {
            // Only inject the flags when the caller didn't already
            // supply their own — respecting any explicit override
            // they passed in args.args.
            let already_set = args
                .args
                .iter()
                .any(|a| a == "--rcfile" || a == "--noprofile" || a == "-i");
            if !already_set {
                cmd.arg("--rcfile");
                cmd.arg(rc.to_string_lossy().into_owned());
                cmd.arg("-i");
            }
        }
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| classify_spawn_error(&args.command, &e.to_string()))?;
    drop(pair.slave);

    let killer = child.clone_killer();
    // Snapshot the shell's pid BEFORE we move `child` into the reader
    // thread below. `term_kill_foreground` uses this to refuse a kill
    // when the foreground pgrp is still the shell's own — the race
    // window after `fork()` but before the child has `setpgid()` +
    // `tcsetpgrp()`'d into its own pgrp. Without this guard a
    // double-tap Ctrl+C right as a new agent launches takes the
    // shell down with the child.
    let shell_pid = child.process_id();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;

    let proxy = EventProxy(app.clone(), args.id.clone());
    let dims = Dims {
        cols: args.cols as usize,
        rows: args.rows as usize,
    };
    let term = Term::new(term_config(), &dims, proxy);
    let initial_snapshot = snapshot_grid(&term);

    let trailing_flusher = TrailingFlusher::new();

    let session = Arc::new(Mutex::new(Session {
        term,
        parser: Processor::new(),
        pty_master: pair.master,
        pty_writer: writer,
        killer,
        shell_pid,
        cols: args.cols,
        rows: args.rows,
        last_snapshot: initial_snapshot,
        last_history_size: 0,
        last_flush: Instant::now() - FRAME_THROTTLE_VISIBLE,
        visible: true,
        last_command_running: false,
        segmenter: BlockSegmenter::new(),
        next_frame_seq: 0,
        frame_channel,
        trailing_flusher: trailing_flusher.clone(),
    }));

    {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.insert(args.id.clone(), session.clone());
    }

    // Trailing-edge flusher thread. Holds a `Weak` to the session so it
    // doesn't keep the session alive past its useful life; if the
    // session is dropped while the flusher is between wakeups, the
    // next upgrade fails and the thread exits cleanly. `term_close`
    // also calls `trailing_flusher.stop()` to wake the thread early
    // when it would otherwise be parked on the condvar.
    {
        let flusher = trailing_flusher;
        let session_weak = Arc::downgrade(&session);
        let app_for_flusher = app.clone();
        let id_for_flusher = args.id.clone();
        thread::spawn(move || {
            run_trailing_flusher(flusher, session_weak, app_for_flusher, id_for_flusher);
        });
    }

    // Reader thread.
    let id_for_reader = args.id.clone();
    let app_for_reader = app.clone();
    let session_for_reader = session.clone();
    thread::spawn(move || {
        // 64 KB read buffer — sized for big agent replies and large
        // pastes. Each read holds the session mutex to feed the
        // segmenter + parser, so larger reads = fewer mutex
        // acquisitions during a burst. Sized to one PTY-typical page
        // chunk; the kernel won't usually fill it, and that's fine —
        // we reuse the stack buffer every iteration.
        let mut buf = [0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let bytes = &buf[..n];
                    let blocks = {
                        let mut s = match session_for_reader.lock() {
                            Ok(g) => g,
                            Err(_) => break,
                        };
                        // ORDER MATTERS — see comments below.
                        //
                        // 1) Run the segmenter FIRST so we know whether
                        //    this chunk contains an OSC 133 C (command
                        //    start). Doing this before the alacritty
                        //    parser means we can decide whether to wipe
                        //    the grid BEFORE the chunk's output bytes
                        //    are written into it.
                        let mut blocks = s.segmenter.feed(bytes);
                        let just_started = s.segmenter.take_command_just_started();
                        // For each block the segmenter just closed,
                        // render its byte transcript into a per-block
                        // grid snapshot (Warp-style) so the frontend
                        // can paint the block via the same RowSnapshot
                        // shape it uses for the live grid. The width
                        // we render at is the session's current width;
                        // closed blocks reflow alongside live frames
                        // so this matches what the user expects when
                        // resizing.
                        let snap_cols = s.cols;
                        let snap_rows = s.rows;
                        for block in blocks.iter_mut() {
                            block.block_rows = snapshot_transcript(
                                &block.transcript,
                                snap_cols,
                                snap_rows,
                            );
                        }
                        // 2) If C just fired, clear the grid + diff
                        //    baseline NOW. The previous command's TUI
                        //    (e.g. claude's UI after a Ctrl+C exit)
                        //    must not ghost into the next command's
                        //    live view.
                        //
                        //    PREVIOUSLY we ran parser.advance first and
                        //    cleared after — which wiped the new
                        //    command's first burst of output whenever
                        //    it shared a PTY read with the OSC 133 C
                        //    marker (very common for fast tools like
                        //    vite that print their banner in the same
                        //    tick zsh's preexec fires). The user saw
                        //    an empty live block and no "VITE ready in
                        //    Xms" text. Clearing first fixes that
                        //    — the parser then writes the chunk's
                        //    output bytes into a freshly-cleared grid.
                        if just_started {
                            s.last_snapshot.clear();
                            let Session { parser, term, .. } = &mut *s;
                            parser.advance(term, b"\x1b[2J\x1b[H");
                        }
                        // 3) Now feed the actual chunk to the alacritty
                        //    parser. The OSC 133 bytes themselves are
                        //    no-ops to alacritty (no registered
                        //    handler), so only the real terminal
                        //    payload lands in the grid.
                        {
                            let Session { parser, term, .. } = &mut *s;
                            parser.advance(term, bytes);
                        }
                        let cwd_change = s.segmenter.take_pending_cwd();
                        // Flush a frame if we're past the throttle window.
                        maybe_flush(&mut s, &app_for_reader, &id_for_reader);
                        if let Some(cwd) = cwd_change {
                            let _ = app_for_reader
                                .emit(&format!("term://{id_for_reader}/cwd"), cwd);
                        }
                        blocks
                    };
                    for block in blocks {
                        // Persist the finished block to SQLite before
                        // emitting it to the frontend. The save is
                        // fire-and-forget — the writer thread owns
                        // back-pressure (drops on a full mailbox), so
                        // the reader thread is never blocked by disk
                        // I/O even with 20 PTYs producing in parallel.
                        if let Some(p) = app_for_reader
                            .try_state::<crate::persistence::PersistenceState>(
                            )
                        {
                            p.writer.save_block(
                                crate::persistence::writer::SavedBlockPayload {
                                    pty_id: id_for_reader.clone(),
                                    block_id: block.block_id as i64,
                                    input: block.input.clone(),
                                    transcript: block.transcript.clone(),
                                    block_rows_json: serde_json::to_string(
                                        &block.block_rows,
                                    )
                                    .unwrap_or_else(|_| "[]".to_string()),
                                    exit_code: block.exit_code,
                                    cwd: block.cwd.clone(),
                                    duration_ms: block
                                        .duration_ms
                                        .map(|d| d as i64),
                                },
                            );
                        }
                        // In-process path to the native surface (no serde/IPC)
                        // — mirrors emit_native_frame for the closed-block list.
                        emit_native_block(&id_for_reader, &block);
                        let _ = app_for_reader
                            .emit(&format!("term://{id_for_reader}/block"), block);
                    }
                }
            }
        }
        let _ = app_for_reader.emit(&format!("term://{id_for_reader}/exit"), ());
    });

    // Wait thread — child status to surface clean exits.
    let app_for_wait = app.clone();
    let id_for_wait = args.id.clone();
    thread::spawn(move || {
        let _ = child.wait();
        let _ = app_for_wait.emit(&format!("term://{id_for_wait}/exit"), ());
    });

    Ok(())
}

#[tauri::command]
pub fn term_input(
    state: State<TerminalState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let arc = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&id).cloned().ok_or("unknown term session")?
    };
    let mut s = arc.lock().map_err(|e| e.to_string())?;
    s.pty_writer.write_all(&data).map_err(|e| e.to_string())?;
    s.pty_writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Forward a mouse-wheel scroll to the PTY for an alt-screen / mouse-mode app
/// (vim, htop, claude's TUI) so the APP scrolls its own view — exactly what a
/// real terminal does. The normal-screen shell scrolls the native transcript
/// instead (via `term_native_scroll`); this is the alt-screen path. Encoding
/// follows the pty's current mode:
///   - mouse reporting on  → mouse-wheel buttons (SGR `\e[<64/65;c;rM`, else X10)
///   - else alternate-scroll (DECSET 1007, alacritty's alt-screen default)
///     → arrow keys (cursor-app-mode aware)
/// `delta_lines` is signed wheel notches: negative = up/older, positive =
/// down/newer. No-op when the app wants neither (nothing to scroll).
#[tauri::command]
pub fn term_native_wheel(
    state: State<TerminalState>,
    id: String,
    delta_lines: i32,
    col: u16,
    row: u16,
) -> Result<(), String> {
    let arc = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&id).cloned().ok_or("unknown term session")?
    };
    let mut s = arc.lock().map_err(|e| e.to_string())?;
    let mode = s.term.mode();
    let notches = (delta_lines.unsigned_abs() as usize).clamp(1, 8);
    let up = delta_lines < 0;
    let c = col.clamp(1, s.cols.max(1));
    let r = row.clamp(1, s.rows.max(1));
    let mut out: Vec<u8> = Vec::new();
    // Send mouse-wheel events — a smooth, app-native scroll — to any TUI that is
    // mouse/SGR aware (claude sets SGR mode 1006). We do NOT fall back to arrow
    // keys: `ALTERNATE_SCROLL` is alacritty's *default*, not something the app
    // opted into, so translating the wheel to arrows fires for every alt-screen
    // app and an app like claude reads those arrows as input-cursor movement,
    // not scroll — which is the "scroll sends arrows / doesn't scroll" report.
    // An app that ignores mouse reports simply discards the CSI sequence (no
    // stray characters), so this is safe even when only the SGR encoding is set.
    if mode.contains(TermMode::MOUSE_MODE) || mode.contains(TermMode::SGR_MOUSE) {
        // Wheel button codes: 64 = up, 65 = down.
        let btn: u32 = if up { 64 } else { 65 };
        for _ in 0..notches {
            if mode.contains(TermMode::SGR_MOUSE) {
                out.extend_from_slice(format!("\x1b[<{btn};{c};{r}M").as_bytes());
            } else {
                out.extend_from_slice(&[
                    0x1b,
                    b'[',
                    b'M',
                    (32 + btn) as u8,
                    32u8.saturating_add(c.min(223) as u8),
                    32u8.saturating_add(r.min(223) as u8),
                ]);
            }
        }
    } else {
        // App isn't mouse-aware — forwarding anything (arrows included) would
        // mis-drive it. No-op; a future enhancement can scroll native scrollback.
        return Ok(());
    }
    s.pty_writer.write_all(&out).map_err(|e| e.to_string())?;
    s.pty_writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn term_resize(
    state: State<TerminalState>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let arc = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&id).cloned().ok_or("unknown term session")?
    };
    let mut s = arc.lock().map_err(|e| e.to_string())?;
    // No-op if the dimensions haven't actually changed. Every call to
    // `pty_master.resize` sends a SIGWINCH to the child, and TUI agents
    // (claude, codex, …) redraw on every SIGWINCH — so duplicate
    // resizes (e.g. the frontend remounting a tab and re-running its
    // ResizeObserver) cause visible UI flicker mid-session. This guard
    // also avoids the alacritty grid reflow + tab-state churn.
    if s.rows == rows && s.cols == cols {
        return Ok(());
    }
    s.cols = cols;
    s.rows = rows;
    s.term.resize(Dims {
        cols: cols as usize,
        rows: rows as usize,
    });
    s.pty_master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    s.last_snapshot.clear();
    // Release the session lock before `reemit_native` re-acquires it.
    drop(s);
    // Push the freshly reflowed grid to the native renderer NOW. `term.resize`
    // above reflowed alacritty's grid to the new width, but the native surface
    // only repaints on the pty's next frame — and an idle shell prompt emits
    // nothing on SIGWINCH, so without this the embedded main pane keeps showing
    // stale-width text after a sidebar / right-panel drag (the "main shell
    // doesn't re-wrap on resize" report). Re-emitting snapshots the reflowed
    // grid and feeds it straight to the surface. No-op for non-mirrored ptys.
    reemit_native(&state, &id);
    Ok(())
}

/// Out-of-band grid reset. Feeds `ESC[2J ESC[H` straight into the
/// alacritty parser (NOT the PTY writer — we don't want zsh to see
/// or echo it) and clears `last_snapshot` so the next emit lands as
/// a full-frame redraw of an empty grid.
///
/// Why this exists: OSC 133 C already triggers an equivalent clear
/// inside the reader loop, so most new-command transitions are
/// covered. But "Ctrl+C an agent → type a new agent immediately"
/// can outrun the OSC 133 path on flaky integration setups, leaving
/// the previous claude's TUI cells ghosting through the new claude's
/// banner — exactly the "new agent doesn't show up properly" symptom
/// users report. Calling this from `onSubmit` whenever the typed
/// command line is an agent makes the reset frontend-driven and
/// race-free.
#[tauri::command]
pub fn term_reset_grid(
    state: State<TerminalState>,
    id: String,
) -> Result<(), String> {
    let arc = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&id).cloned().ok_or("unknown term session")?
    };
    let mut s = arc.lock().map_err(|e| e.to_string())?;
    s.last_snapshot.clear();
    let Session { parser, term, .. } = &mut *s;
    parser.advance(term, b"\x1b[2J\x1b[H");
    Ok(())
}

#[tauri::command]
pub fn term_close(
    state: State<TerminalState>,
    id: String,
) -> Result<(), String> {
    let arc = {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(&id)
    };
    if let Some(arc) = arc {
        if let Ok(mut s) = arc.lock() {
            // Wake the trailing-edge flusher thread out of its
            // condvar wait so it exits promptly. Without this it
            // would sit parked on `cvar.wait` until the next
            // notify, which — for a dead session — never comes.
            s.trailing_flusher.stop();
            let _ = s.killer.kill();
        }
    }
    Ok(())
}

/// Load the persisted block history for a pty_id. Frontend calls this
/// on `useTerminalSession` mount when in-memory `sessionMemory.blocks`
/// is empty — typically the first mount after an app restart, when
/// the live PTY has been torn down but the saved scrollback should
/// survive.
///
/// Empty vec for unknown pty_ids (fresh session) — never an error.
#[tauri::command]
pub fn term_history_load<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
) -> Result<Vec<crate::persistence::SavedBlock>, String> {
    let Some(state) = app.try_state::<crate::persistence::PersistenceState>()
    else {
        // Persistence init failed earlier; degrade to no history.
        return Ok(Vec::new());
    };
    crate::persistence::load_blocks(&state.db_path, &id)
}

/// Permanently forget every block for a pty_id. Paired with the
/// frontend's `forgetSession` — distinct from `term_close`, which is
/// the transient kill path that keeps scrollback for a potential
/// restart.
#[tauri::command]
pub fn term_history_forget<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
) -> Result<(), String> {
    let Some(state) = app.try_state::<crate::persistence::PersistenceState>()
    else {
        return Ok(());
    };
    state.writer.forget_pty(id)
}

/// Pure decision: given the foreground pgrp the kernel reports for
/// the PTY and the shell's own pid (which equals the shell's pgrp,
/// since the shell is the session leader of its own pgrp), decide
/// whether `term_kill_foreground` should send SIGKILL.
///
/// The default is yes — single SIGKILL on the foreground pgrp is
/// exactly the escape hatch users want for `bun run` / trapped-SIGINT
/// processes. The guards encode the cases where SIGKILL would
/// over-reach:
///
///   - pgrp <= 1 — broadcast (`kill(0, ...)` semantic) or init. The
///     tcgetpgrp returned a suspicious value; refuse rather than punch
///     outside the PTY.
///   - pgrp == shell_pid — the foreground pgrp IS still the shell's.
///     This happens in the few-hundred-microsecond race window
///     between the shell's `fork()` and the child's `setpgid()` +
///     `tcsetpgrp()` — typical when launching a new agent right
///     after a previous one has exited. The user reports it as
///     "after a run is done, I open a new claude, ctrl+c kills zsh."
///     Refuse here; by the time the child has its own pgrp, this
///     check passes and the kill goes through normally.
///
/// `shell_pid` is `Option` because portable_pty's `process_id()`
/// returns `Option<u32>` — on hosts where it can't be read we lose the
/// guard but still preserve the pgrp<=1 floor.
pub(crate) fn should_skip_kill(pgrp: i32, shell_pid: Option<u32>) -> KillDecision {
    if pgrp <= 1 {
        return KillDecision::RefuseSuspiciousPgrp;
    }
    if let Some(spid) = shell_pid {
        if pgrp == spid as i32 {
            return KillDecision::SkipShellRace;
        }
    }
    KillDecision::Proceed
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KillDecision {
    /// Send SIGKILL to -pgrp.
    Proceed,
    /// pgrp matched the shell's pid; the child hasn't pgrp'd into its
    /// own group yet. Quietly skip the kill.
    SkipShellRace,
    /// pgrp <= 1 — refuse with an error rather than silently
    /// broadcasting to the whole session or signalling init.
    RefuseSuspiciousPgrp,
}

/// Terminal cleanup a force-killed full-screen app never got to send itself:
/// leave the alternate screen (1049/1047/47), disable every mouse-reporting +
/// extended-encoding mode, turn off bracketed paste, and show the cursor.
/// Without this, SIGKILLing an alt-screen TUI (claude, vim, htop) leaves the
/// emulator pinned in alt-screen — and since the UI treats alt-screen as "an
/// agent owns the pane", the shell prompt/input never returns ("Ctrl+C doesn't
/// bring the input box back").
#[cfg(unix)]
const KILL_TERM_RESET: &[u8] = b"\x1b[?1049l\x1b[?1047l\x1b[?47l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?25h";

/// SIGKILL the PTY's foreground process group. The escape hatch when
/// a single Ctrl+C didn't take — bun's run wrapper, some node/python
/// dev servers, and certain build watchers trap SIGINT and refuse to
/// exit. Sending 0x03 to the PTY just echoes more `^C`s; this bypasses
/// the signal handler entirely by reading the foreground pgrp out of
/// the PTY master (`tcgetpgrp`) and `kill(-pgrp, SIGKILL)`-ing it.
///
/// The shell process itself is NOT touched: it's the SESSION leader,
/// not the foreground pgrp leader, so the PTY stays alive and the
/// user is dumped back at the prompt the moment the stuck job dies.
/// On non-unix targets (we don't build for any today, but the cfg
/// makes future cross-compile attempts honest) this is a no-op that
/// returns an explanatory error.
#[tauri::command]
pub fn term_kill_foreground(
    state: State<TerminalState>,
    id: String,
) -> Result<(), String> {
    let arc = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&id).cloned().ok_or("unknown term session")?
    };
    let mut s = arc.lock().map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        // process_group_leader() returns the foreground pgrp's pid via
        // tcgetpgrp(master_fd). If no foreground job is set (shell is
        // idle at a prompt and zsh hasn't re-claimed fg, exotic shells
        // that don't do job control, etc.) we get None — there's
        // nothing to kill, so just succeed quietly.
        let Some(pgrp) = s.pty_master.process_group_leader() else {
            return Ok(());
        };
        // All "should we even send the signal?" logic lives in the
        // pure `should_skip_kill` helper so it can be unit-tested
        // without spinning up a real PTY. See its doc comment for
        // the rationale on each branch.
        match should_skip_kill(pgrp, s.shell_pid) {
            KillDecision::SkipShellRace => return Ok(()),
            KillDecision::RefuseSuspiciousPgrp => {
                return Err(format!("refusing to signal pgrp {pgrp}"));
            }
            KillDecision::Proceed => {}
        }
        // Negate the pid to address the whole process group — that's
        // POSIX `kill(2)`'s contract for `pid < -1`. SIGKILL cannot be
        // caught, blocked, or ignored, so trapped-SIGINT processes
        // (bun et al) die immediately.
        let rc = unsafe { libc::kill(-pgrp, libc::SIGKILL) };
        if rc != 0 {
            let err = std::io::Error::last_os_error();
            // ESRCH = the pgrp already exited between the tcgetpgrp
            // read and the kill call — a benign race, the user got
            // what they wanted. Still reset: it may have died dirty.
            if err.raw_os_error() == Some(libc::ESRCH) {
                s.last_snapshot.clear();
                let Session { parser, term, .. } = &mut *s;
                parser.advance(term, KILL_TERM_RESET);
                return Ok(());
            }
            return Err(format!("kill(-{pgrp}, SIGKILL) failed: {err}"));
        }
        // A SIGKILLed full-screen TUI (claude, vim) never got to leave the
        // alternate screen or disable mouse reporting — so the emulator stays
        // stuck in alt-screen. The UI gates "agent mode" on alt-screen, so the
        // shell PromptInput would never come back. Feed alacritty the cleanup
        // the dead app owed us (clearing last_snapshot forces a full re-emit of
        // the now normal-screen grid).
        s.last_snapshot.clear();
        let Session { parser, term, .. } = &mut *s;
        parser.advance(term, KILL_TERM_RESET);
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = s;
        Err("term_kill_foreground is unix-only".to_string())
    }
}

/* ------------------------------------------------------------------
   Frame flush — throttled to ~60 Hz, only sends dirty rows.
   ------------------------------------------------------------------ */

fn maybe_flush(s: &mut Session, app: &AppHandle<Wry>, id: &str) {
    let cmd_running = s.segmenter.command_running();
    let cmd_running_changed = cmd_running != s.last_command_running;
    let throttle = session_frame_throttle(s.visible);
    // Throttle paints only — state changes (command_running flip)
    // always go out immediately. Without this bypass, a Ctrl+C kill
    // can land within 16ms of the previous paint, hit the throttle,
    // and never get re-flushed because zsh's empty PROMPT produces
    // no further bytes for the reader loop to wake on. Frontend
    // would stay stuck in agent mode with PromptInput hidden.
    if !cmd_running_changed && s.last_flush.elapsed() < throttle {
        // Trailing-edge flush. This frame is gated, but it might be
        // the LAST one of a burst — if no more PTY output arrives
        // before the throttle window closes, the trapped frame stays
        // invisible until the next byte (commonly the user's next
        // keystroke, which is why bulk agent output looked like "the
        // screen goes black until I type something"). Schedule a
        // re-run of `maybe_flush` for when the throttle window
        // closes; if more output beats the timer, the reader thread
        // calls `maybe_flush` first, advances `last_flush`, and the
        // timer's eventual re-run is an idempotent no-op.
        s.trailing_flusher.schedule(s.last_flush + throttle);
        return;
    }
    let snapshot = snapshot_grid(&s.term);
    let dirty = diff_rows(&s.last_snapshot, &snapshot);
    // Scrollback delta — capture rows that just left the visible grid
    // since the last flush. The visible grid only sees the bottom
    // `screen_lines()` of the buffer, so without this the user has no
    // way to scroll back to anything an agent (claude / codex) wrote
    // more than a screenful ago. alt-screen swap suspends this because
    // alt-screen content (vim/htop) doesn't go through main scrollback.
    let in_alt_screen = s.term.mode().contains(TermMode::ALT_SCREEN);
    let current_history_size = s.term.grid().history_size();
    let mut scrollback_appended: Vec<DirtyRow> = Vec::new();
    let mut scrollback_reset = false;
    if !in_alt_screen {
        if current_history_size < s.last_history_size {
            // History shrunk (resize-evict, clear-saved). Frontend's
            // mirror is no longer in sync — tell it to drop and rebuild
            // from a fresh snapshot of whatever's currently in history.
            scrollback_reset = true;
            scrollback_appended =
                sample_scrollback_rows(&s.term, current_history_size);
        } else if current_history_size > s.last_history_size {
            let delta = current_history_size - s.last_history_size;
            scrollback_appended = sample_scrollback_rows(&s.term, delta);
        }
        s.last_history_size = current_history_size;
    }
    if dirty.is_empty() && scrollback_appended.is_empty() && !cmd_running_changed
        && !scrollback_reset
    {
        return;
    }
    let cursor = s.term.grid().cursor.point;
    let seq = s.next_frame_seq;
    s.next_frame_seq = s.next_frame_seq.saturating_add(1);
    let frame = RenderFrame {
        seq,
        block_id: s.segmenter.current_block_id(),
        cols: s.cols,
        rows: s.rows,
        cursor_row: cursor.line.0,
        cursor_col: cursor.column.0 as u16,
        alt_screen: in_alt_screen,
        command_running: cmd_running,
        app_cursor: s.term.mode().contains(TermMode::APP_CURSOR),
        bracketed_paste: s.term.mode().contains(TermMode::BRACKETED_PASTE),
        cursor_visible: s.term.mode().contains(TermMode::SHOW_CURSOR),
        dirty,
        scrollback_appended,
        scrollback_reset,
    };
    // In-process native path (macOS embedded warpui): mirror this frame to
    // the native surface iff it's the active terminal's pty. By reference —
    // no serde, no IPC — before the channel send consumes `frame`.
    emit_native_frame(id, &frame);
    let _ = s.frame_channel.send(frame);
    s.last_snapshot = snapshot;
    s.last_flush = Instant::now();
    s.last_command_running = cmd_running;
    let _ = (app, id);
}

/// Snapshot the most-recently-scrolled-out `count` rows of alacritty's
/// history. Returned in temporal order (oldest first), so a caller can
/// `Vec::extend` them onto a tail-growing scrollback buffer and the
/// agent's history reads top-to-bottom.
///
/// `Line(-1)` is the row that just left the visible grid; `Line(-N)`
/// is the row that left N flushes ago. Walking from `-count` up to
/// `-1` therefore yields the new rows in the order they entered
/// history. Each row's `DirtyRow.row` field is set to the row's
/// **current** alacritty index at capture time (negative), so any
/// future debugging that needs to correlate rows back to the live
/// grid can; the frontend ignores it for scrollback display (rows
/// are positional in the buffer).
fn sample_scrollback_rows<E: EventListener>(
    term: &Term<E>,
    count: usize,
) -> Vec<DirtyRow> {
    if count == 0 {
        return Vec::new();
    }
    let cols = term.columns();
    let history_size = term.grid().history_size();
    let take = count.min(history_size);
    let mut out: Vec<DirtyRow> = Vec::with_capacity(take);
    // Oldest-first: start at Line(-take) and walk toward Line(-1).
    for offset in (1..=take).rev() {
        let row_idx = -(offset as i32);
        let mut spans: Vec<Span> = Vec::new();
        let mut current: Option<Span> = None;
        for col_idx in 0..cols {
            let point = Point::new(Line(row_idx), Column(col_idx));
            let cell: &Cell = &term.grid()[point];
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            let span = cell_to_span(cell);
            match &mut current {
                Some(c) if c.fg == span.fg
                    && c.bg == span.bg
                    && c.bold == span.bold
                    && c.italic == span.italic
                    && c.underline == span.underline
                    && c.inverse == span.inverse
                    && c.dim == span.dim
                    && c.strikeout == span.strikeout =>
                {
                    c.text.push_str(&span.text);
                }
                Some(_) | None => {
                    if let Some(c) = current.take() {
                        spans.push(c);
                    }
                    current = Some(span);
                }
            }
        }
        if let Some(c) = current.take() {
            spans.push(c);
        }
        // `row` is informational here — the frontend treats scrollback
        // as positional. Cast saturates at i16::MIN for very deep
        // histories rather than panicking.
        let stored_row = if row_idx >= i16::MIN as i32 {
            row_idx as i16
        } else {
            i16::MIN
        };
        // DirtyRow.row is u16 in the wire format. Use the bit pattern
        // of the i16 so the negative value round-trips losslessly if
        // anyone inspects it on the JS side.
        out.push(DirtyRow {
            row: stored_row as u16,
            spans,
        });
    }
    out
}

/* ------------------------------------------------------------------
   Spawn-error classifier (carried over from pty.rs).
   ------------------------------------------------------------------ */

fn classify_spawn_error(command: &str, raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("no such file") || lower.contains("not found") || lower.contains("enoent") {
        format!("command not found: '{command}' — check it's installed and on PATH")
    } else if lower.contains("permission denied") {
        format!("permission denied launching '{command}'")
    } else {
        format!("spawn '{command}': {raw}")
    }
}

/* ------------------------------------------------------------------
   Tests
   ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    /* ---------- JS ↔ Rust wire format contract ----------
       These tests lock the JSON shape the frontend sends when it
       calls `invoke("term_start", ...)` (and friends). They exist
       because we hit a runtime bug where the JS side sent
       `frameChannel` as a top-level arg key while the Rust command
       expected `frame_channel` — Tauri's name-matching for
       `Channel<T>` args doesn't auto-convert across the case
       boundary, so the bug only surfaced as a "missing required key"
       error the moment a terminal tried to start. Locking the shape
       here means a future schema change has to update BOTH the Rust
       side AND the matching test in lockstep, with the JSON fixture
       acting as the source of truth that the frontend's
       `src/lib/tauri/term.ts` wrapper mirrors.
       ----------------------------------------------------------- */

    /// The exact JSON shape `useTerminalSession` sends inside the
    /// `args` value when invoking `term_start`. Mirror of the
    /// TypeScript `TermStartArgs` interface in
    /// `src/lib/tauri/term.ts`. If you change either, change both
    /// AND keep this test passing.
    #[test]
    fn term_start_args_match_frontend_wire_format() {
        let json = serde_json::json!({
            "id": "pty_test",
            "command": "zsh",
            "args": ["-l"],
            "cwd": "/tmp/goonware-test",
            "rows": 24,
            "cols": 80,
            "project_id": "p_test",
            "session_id": "s_test"
        });
        let parsed: StartArgs = serde_json::from_value(json)
            .expect("frontend wire format must deserialize into StartArgs");
        assert_eq!(parsed.id, "pty_test");
        assert_eq!(parsed.command, "zsh");
        assert_eq!(parsed.args, vec!["-l".to_string()]);
        assert_eq!(parsed.cwd.as_deref(), Some("/tmp/goonware-test"));
        assert_eq!(parsed.rows, 24);
        assert_eq!(parsed.cols, 80);
        assert_eq!(parsed.project_id.as_deref(), Some("p_test"));
        assert_eq!(parsed.session_id.as_deref(), Some("s_test"));
    }

    /// The optional fields (`cwd`, `project_id`, `session_id`)
    /// must accept being omitted from the JSON. Frontend
    /// `useTerminalSession` can pass `undefined` for any of them,
    /// which serializes to a missing key.
    #[test]
    fn term_start_args_optional_fields_can_be_absent() {
        let json = serde_json::json!({
            "id": "pty_no_opts",
            "command": "zsh",
            "args": [],
            "rows": 24,
            "cols": 80,
        });
        let parsed: StartArgs = serde_json::from_value(json)
            .expect("absent optional fields must still deserialize");
        assert!(parsed.cwd.is_none());
        assert!(parsed.project_id.is_none());
        assert!(parsed.session_id.is_none());
    }

    /// The frontend MUST send snake_case keys inside the `args`
    /// value. camelCase would silently drop the field on the Rust
    /// side because serde defaults to snake_case matching for the
    /// struct (no `#[serde(rename_all = "camelCase")]` here). This
    /// guards against someone "fixing" the field names to camelCase
    /// in a future refactor.
    #[test]
    fn term_start_args_reject_camel_case_keys() {
        let json = serde_json::json!({
            "id": "pty_x",
            "command": "zsh",
            "args": [],
            "rows": 24,
            "cols": 80,
            // intentionally camelCase — must not be picked up.
            "projectId": "p_x",
            "sessionId": "s_x",
        });
        let parsed: StartArgs = serde_json::from_value(json)
            .expect("unknown camelCase keys are ignored, not errors");
        // The snake_case fields stay None because the camelCase
        // versions didn't match — this is the property we want.
        assert!(parsed.project_id.is_none());
        assert!(parsed.session_id.is_none());
    }

    /// Compile-time guard: the `term_start` command keeps the exact
    /// signature the frontend wrapper depends on. If a future
    /// refactor renames or reorders parameters here, this fails to
    /// compile — making the schema change loud instead of silently
    /// breaking the IPC at runtime. The function pointer assignment
    /// has no runtime effect; it exists purely for the type check.
    #[test]
    fn term_start_signature_is_stable() {
        let _f: fn(
            tauri::AppHandle<tauri::Wry>,
            tauri::State<TerminalState>,
            StartArgs,
            tauri::ipc::Channel<RenderFrame>,
        ) -> Result<(), String> = term_start;
    }

    /// Same guard for the visibility-set command. The frontend
    /// `termSetVisibleSet` wrapper invokes with `{ ids: string[] }`,
    /// matching this signature; if the Rust signature drifts (e.g.
    /// renames the param or accepts a struct instead), the wrapper
    /// must update too — and this test catches the gap.
    #[test]
    fn term_set_visible_set_signature_is_stable() {
        let _f: fn(
            tauri::AppHandle<tauri::Wry>,
            tauri::State<TerminalState>,
            Vec<String>,
        ) -> Result<(), String> = term_set_visible_set;
    }

    /// `term_kill_foreground` is the double-tap-Ctrl+C escape hatch.
    /// Its wire shape is `{ id: string }` and the JS wrapper
    /// (`termKillForeground` in `src/lib/tauri/term.ts`) calls
    /// `invoke("term_kill_foreground", { id })`. The signature MUST
    /// stay `(State<TerminalState>, String) -> Result<(), String>` —
    /// adding a required field or renaming `id` would silently
    /// break the kill path the moment a user mashes Ctrl+C and ship
    /// the regression to anyone with a stuck dev server.
    #[test]
    fn term_kill_foreground_signature_is_stable() {
        let _f: fn(tauri::State<TerminalState>, String) -> Result<(), String> =
            term_kill_foreground;
    }

    /* ---------- should_skip_kill (shell-pgrp race guard) ---------- */

    /// Normal path: foreground pgrp is some real child process,
    /// distinct from the shell. Kill proceeds.
    #[test]
    fn skip_kill_proceeds_for_real_child_pgrp() {
        assert_eq!(
            should_skip_kill(54321, Some(12345)),
            KillDecision::Proceed,
        );
    }

    /// Suspicious pgrp 0 (broadcast) is refused with an explicit
    /// error so the caller doesn't silently signal every process in
    /// the session.
    #[test]
    fn skip_kill_refuses_pgrp_zero() {
        assert_eq!(
            should_skip_kill(0, Some(12345)),
            KillDecision::RefuseSuspiciousPgrp,
        );
    }

    /// init (pid 1) is also refused — `kill(-1, ...)` would broadcast
    /// per POSIX, and the only legitimate fg pgrp for a user terminal
    /// is >1.
    #[test]
    fn skip_kill_refuses_pgrp_one() {
        assert_eq!(
            should_skip_kill(1, Some(12345)),
            KillDecision::RefuseSuspiciousPgrp,
        );
    }

    /// Even a negative pgrp (cannot happen from a healthy tcgetpgrp
    /// but defends against future changes to the upstream) is treated
    /// as the suspicious branch.
    #[test]
    fn skip_kill_refuses_negative_pgrp() {
        assert_eq!(
            should_skip_kill(-5, Some(12345)),
            KillDecision::RefuseSuspiciousPgrp,
        );
    }

    /// The race-window guard: a kill request lands while the fg pgrp
    /// is still the shell's own (post-fork, pre-setpgid/tcsetpgrp
    /// window). Skip silently — by the time the child has its own
    /// pgrp, this branch falls through to Proceed.
    #[test]
    fn skip_kill_protects_shell_in_fork_window() {
        // shell pid 12345 IS the foreground pgrp — child hasn't
        // pgrp'd into its own group yet.
        assert_eq!(
            should_skip_kill(12345, Some(12345)),
            KillDecision::SkipShellRace,
        );
    }

    /// When shell_pid is None (portable_pty couldn't read it), the
    /// race-window guard is unavailable but the pgrp<=1 floor still
    /// holds. A legitimate-looking pgrp goes through.
    #[test]
    fn skip_kill_falls_back_without_shell_pid() {
        assert_eq!(should_skip_kill(54321, None), KillDecision::Proceed);
        assert_eq!(
            should_skip_kill(1, None),
            KillDecision::RefuseSuspiciousPgrp,
        );
    }

    /* ---------- BlockSegmenter ---------- */

    fn osc(content: &str) -> Vec<u8> {
        let mut v = vec![0x1b, 0x5d];
        v.extend_from_slice(content.as_bytes());
        v.push(0x07);
        v
    }

    #[test]
    fn segmenter_emits_block_on_osc133_d() {
        // The transcript should now include the prompt bytes between
        // A and C, the (optional B-bracketed) input, AND the output —
        // a faithful replay of the block as it scrolled past.
        let mut seg = BlockSegmenter::new();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&osc("133;A"));
        bytes.extend_from_slice(b"$ "); // prompt
        bytes.extend_from_slice(&osc("133;B"));
        bytes.extend_from_slice(b"ls");
        bytes.extend_from_slice(&osc("133;C"));
        bytes.extend_from_slice(b"file1\nfile2\n");
        bytes.extend_from_slice(&osc("133;D;0"));

        let blocks = seg.feed(&bytes);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].input, "ls");
        assert!(blocks[0].transcript.contains("$ "));
        assert!(blocks[0].transcript.contains("ls"));
        assert!(blocks[0].transcript.contains("file1\nfile2\n"));
        assert_eq!(blocks[0].exit_code, Some(0));
    }

    #[test]
    fn segmenter_closes_block_on_next_prompt_a_when_d_omitted() {
        // Some shells omit D — closing on the next A is a safety net.
        let mut seg = BlockSegmenter::new();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&osc("133;A"));
        bytes.extend_from_slice(&osc("133;B"));
        bytes.extend_from_slice(b"echo hi");
        bytes.extend_from_slice(&osc("133;C"));
        bytes.extend_from_slice(b"hi\n");
        // No D — instead the next prompt
        bytes.extend_from_slice(&osc("133;A"));
        let blocks = seg.feed(&bytes);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].input, "echo hi");
        assert!(blocks[0].transcript.contains("hi"));
        assert_eq!(blocks[0].exit_code, None);
    }

    #[test]
    fn segmenter_ignores_pre_first_prompt_output() {
        // Anything before the first A is dropped (login banner, etc.).
        let mut seg = BlockSegmenter::new();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"Welcome to zsh!\n");
        bytes.extend_from_slice(&osc("133;A"));
        bytes.extend_from_slice(&osc("133;B"));
        let blocks = seg.feed(&bytes);
        assert!(blocks.is_empty());
        assert_eq!(seg.state, SegState::AwaitingCommand);
    }

    #[test]
    fn segmenter_handles_st_terminator() {
        // ESC \\ (ST) is the alternative OSC terminator. Must work
        // identically to BEL.
        let mut seg = BlockSegmenter::new();
        let mut bytes = vec![0x1b, 0x5d];
        bytes.extend_from_slice(b"133;A");
        bytes.extend_from_slice(&[0x1b, 0x5c]); // ST
        bytes.extend_from_slice(&[0x1b, 0x5d]);
        bytes.extend_from_slice(b"133;B");
        bytes.extend_from_slice(&[0x1b, 0x5c]);
        let _ = seg.feed(&bytes);
        assert_eq!(seg.state, SegState::AwaitingCommand);
    }

    #[test]
    fn segmenter_tolerates_chunked_input() {
        // Bytes can arrive split across read() calls — feeding piece by
        // piece must produce the same block as feeding all at once.
        let mut seg = BlockSegmenter::new();
        seg.feed(&osc("133;A"));
        seg.feed(&osc("133;B"));
        seg.feed(b"pwd");
        seg.feed(&osc("133;C"));
        seg.feed(b"/home\n");
        let blocks = seg.feed(&osc("133;D;0"));
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].input, "pwd");
        assert!(blocks[0].transcript.contains("/home\n"));
    }

    #[test]
    fn segmenter_extracts_cwd_from_osc7() {
        // OSC 7 messages must surface as pending_cwd so the reader
        // thread can emit a Tauri event. URL-encoded spaces decode.
        let mut seg = BlockSegmenter::new();
        seg.feed(&osc("7;file://localhost/Users/bob/My%20Projects/site"));
        assert_eq!(
            seg.take_pending_cwd().as_deref(),
            Some("/Users/bob/My Projects/site"),
        );
        // Drain semantics: once read, the pending value is gone.
        assert!(seg.take_pending_cwd().is_none());
    }

    #[test]
    fn segmenter_ignores_malformed_osc7() {
        // OSC 7 without `file://` — silently dropped, no crash, no
        // bogus pending_cwd.
        let mut seg = BlockSegmenter::new();
        seg.feed(&osc("7;not-a-url"));
        assert!(seg.take_pending_cwd().is_none());
    }

    #[test]
    fn transcript_includes_prompt_bytes() {
        // Anything between A and D must end up in the block transcript.
        // This is what lets the user's Spaceship/p10k prompt render
        // inside the closed block as the natural header.
        let mut seg = BlockSegmenter::new();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&osc("133;A"));
        bytes.extend_from_slice(b"\x1b[34mPROMPT\x1b[0m ");
        bytes.extend_from_slice(&osc("133;C"));
        bytes.extend_from_slice(b"output\n");
        bytes.extend_from_slice(&osc("133;D;0"));
        let blocks = seg.feed(&bytes);
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].transcript.contains("PROMPT"));
        // SGR styling preserved verbatim — frontend parses it.
        assert!(blocks[0].transcript.contains("\x1b[34m"));
    }

    #[test]
    fn segmenter_ignores_other_osc_codes() {
        // OSC 0 (set window title) must not interfere with state.
        let mut seg = BlockSegmenter::new();
        seg.feed(&osc("133;A"));
        seg.feed(&osc("0;new title"));
        seg.feed(&osc("133;B"));
        assert_eq!(seg.state, SegState::AwaitingCommand);
    }

    #[test]
    fn command_running_only_true_between_c_and_d() {
        // Drives the live-frame visibility on the frontend. Must be
        // false before C, true between C and D, false after D.
        let mut seg = BlockSegmenter::new();
        assert!(!seg.command_running());
        seg.feed(&osc("133;A"));
        assert!(!seg.command_running()); // prompt drawing
        seg.feed(&osc("133;B"));
        assert!(!seg.command_running()); // awaiting input
        seg.feed(&osc("133;C"));
        assert!(seg.command_running()); // command actively producing output
        seg.feed(b"some output");
        assert!(seg.command_running()); // still streaming
        seg.feed(&osc("133;D;0"));
        assert!(!seg.command_running()); // command finished
    }

    #[test]
    fn command_just_started_latches_on_c() {
        // Reader thread reads & clears this to know when to nuke the
        // last_snapshot baseline so the new command paints fresh.
        let mut seg = BlockSegmenter::new();
        seg.feed(&osc("133;A"));
        assert!(!seg.take_command_just_started());
        seg.feed(&osc("133;C"));
        assert!(seg.take_command_just_started()); // first read returns true
        assert!(!seg.take_command_just_started()); // and clears
    }

    /* ---------- Warp-style DCS hook protocol ---------- */

    /// Wrap a payload in a DCS sequence: `ESC P <payload> ESC \`.
    fn dcs(payload: &str) -> Vec<u8> {
        let mut v = vec![0x1b, 0x50];
        v.extend_from_slice(payload.as_bytes());
        v.extend_from_slice(&[0x1b, 0x5c]); // ST
        v
    }

    #[test]
    fn dcs_preexec_populates_command_at_c() {
        // The shell fires `preexec` DCS just before OSC 133 C, so the
        // resulting ClosedBlock.input must come from the DCS payload —
        // not from echoed PTY bytes between B and C.
        let mut seg = BlockSegmenter::new();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&osc("133;A"));
        bytes.extend_from_slice(&osc("133;B"));
        bytes.extend_from_slice(&dcs(
            r#"goonware;preexec;{"command":"git status","start_ms":1700000000000}"#,
        ));
        bytes.extend_from_slice(&osc("133;C"));
        bytes.extend_from_slice(b"output\n");
        bytes.extend_from_slice(&osc("133;D;0"));
        let blocks = seg.feed(&bytes);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].input, "git status");
        assert_eq!(blocks[0].exit_code, Some(0));
    }

    #[test]
    fn dcs_cmd_finished_overrides_osc133_d_exit() {
        // bash <5.0 always reports `D;0` regardless of the real exit.
        // When the DCS `cmd_finished` hook fires, its exit code wins.
        let mut seg = BlockSegmenter::new();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&osc("133;A"));
        bytes.extend_from_slice(&osc("133;C"));
        bytes.extend_from_slice(b"oops\n");
        bytes.extend_from_slice(&dcs(
            r#"goonware;cmd_finished;{"exit_code":127,"duration_ms":42}"#,
        ));
        // OSC 133 D claims success — DCS must win.
        bytes.extend_from_slice(&osc("133;D;0"));
        let blocks = seg.feed(&bytes);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].exit_code, Some(127));
        assert_eq!(blocks[0].duration_ms, Some(42));
    }

    #[test]
    fn dcs_chunked_input_assembles_correctly() {
        // DCS sequence split across multiple feed() calls — must parse
        // the same as if fed in one shot. Mirrors a real PTY read
        // boundary landing mid-payload.
        let mut seg = BlockSegmenter::new();
        seg.feed(&osc("133;A"));
        seg.feed(b"\x1b\x50goonware;preexec;{\"comm");
        seg.feed(b"and\":\"echo hi\",\"start_ms\":42}");
        seg.feed(&[0x1b, 0x5c]); // ST in its own chunk
        seg.feed(&osc("133;C"));
        seg.feed(b"hi\n");
        let blocks = seg.feed(&osc("133;D;0"));
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].input, "echo hi");
    }

    #[test]
    fn dcs_ignores_non_goonware_prefix() {
        // Terminfo definitions, tmux passthrough, and other tools all
        // use DCS for their own purposes. We must not interpret any
        // DCS sequence whose prefix isn't `goonware;` — confirm by feeding
        // a tmux-style payload and verifying no command gets latched.
        let mut seg = BlockSegmenter::new();
        seg.feed(&dcs(r#"tmux;\033[31mred\033[0m"#));
        seg.feed(&osc("133;A"));
        seg.feed(&osc("133;B"));
        seg.feed(&osc("133;C"));
        seg.feed(b"output\n");
        let blocks = seg.feed(&osc("133;D;0"));
        assert_eq!(blocks.len(), 1);
        // No DCS preexec fired → input stays empty (the frontend's
        // pending queue would fill it in a real session).
        assert_eq!(blocks[0].input, "");
    }

    #[test]
    fn dcs_malformed_json_dropped_silently() {
        // Bad JSON must not crash the segmenter — the rest of the
        // session keeps working.
        let mut seg = BlockSegmenter::new();
        seg.feed(&dcs(r#"goonware;preexec;{not really json"#));
        seg.feed(&osc("133;A"));
        seg.feed(&osc("133;C"));
        seg.feed(b"output\n");
        let blocks = seg.feed(&osc("133;D;0"));
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].input, "");
        assert_eq!(blocks[0].exit_code, Some(0));
    }

    #[test]
    fn dcs_bel_does_not_terminate() {
        // DCS terminates ONLY on ESC \\ (ST), never on BEL — tolerating
        // BEL would split a DCS sequence at any 0x07 byte and leave
        // the segmenter desynced for the rest of the session. Confirm
        // by sending a DCS-with-BEL followed by a clean OSC 133 cycle:
        // if BEL had terminated DCS, the trailing `}` and ESC \\ would
        // have been parsed as random output and the next OSC 133 cycle
        // would still segment, but the segmenter would have processed
        // an additional spurious handle_dcs() call. We can't observe
        // that directly here without poking internals, so we settle
        // for the structural check: the next clean cycle works.
        let mut seg = BlockSegmenter::new();
        let mut bytes = vec![0x1b, 0x50];
        // Use `` JSON-encoded BEL in the payload so the wire byte
        // is the escape sequence (valid JSON), and add a raw 0x07 in
        // the binary tail (after the JSON close) so the segmenter sees
        // a literal BEL inside the DCS. The literal BEL must NOT close
        // the sequence.
        bytes.extend_from_slice(b"goonware;pree");
        bytes.push(0x07); // raw BEL mid-marker — must NOT terminate DCS
        bytes.extend_from_slice(b"xec;{\"command\":\"hi\",\"start_ms\":1}");
        bytes.extend_from_slice(&[0x1b, 0x5c]); // real ST terminator
        bytes.extend_from_slice(&osc("133;A"));
        bytes.extend_from_slice(&osc("133;C"));
        bytes.extend_from_slice(b"output\n");
        bytes.extend_from_slice(&osc("133;D;0"));
        let blocks = seg.feed(&bytes);
        assert_eq!(blocks.len(), 1);
        // The hook name `pree<BEL>xec` isn't recognised so no metadata
        // latches — but the segmenter stayed responsive and produced
        // a clean block from the subsequent OSC 133 cycle, which is
        // the property under test.
        assert!(blocks[0].transcript.contains("output\n"));
    }

    /* ---------- snapshot_transcript (per-block grid render) ---------- */

    /// Flatten a row's spans into the plain text the user would read.
    fn row_text(row: &RowSnapshot) -> String {
        row.spans.iter().map(|s| s.text.as_str()).collect()
    }

    #[test]
    fn snapshot_transcript_empty_returns_empty() {
        let out = snapshot_transcript("", 80, 24);
        assert!(out.is_empty());
    }

    #[test]
    fn snapshot_transcript_plain_text_lays_out_lines() {
        // Real shells emit CRLF, not bare LF — alacritty (correctly)
        // treats LF as cursor-down-only, so without the leading CR
        // the second line would start at column 5 ("     beta").
        let out = snapshot_transcript("alpha\r\nbeta\r\ngamma\r\n", 80, 24);
        assert_eq!(out.len(), 3);
        assert_eq!(row_text(&out[0]).trim_end(), "alpha");
        assert_eq!(row_text(&out[1]).trim_end(), "beta");
        assert_eq!(row_text(&out[2]).trim_end(), "gamma");
    }

    #[test]
    fn snapshot_transcript_handles_cr_overstrike() {
        // Progress bars use CR (no LF) to redraw the same line. The
        // OLD parseAnsi.ts dropped CR and concatenated everything,
        // producing nonsense like "[####] 25%[######] 50%[########] 75%".
        // The alacritty-backed snapshot must show ONLY the last state.
        let bytes = "[####    ] 25%\r[######  ] 50%\r[########] 75%\n";
        let out = snapshot_transcript(bytes, 80, 24);
        // First row holds the final redraw; the next print should land
        // on row 1 (after the trailing \n). Row 0's text must match
        // the LAST progress-bar state, not a concatenation.
        assert!(!out.is_empty());
        let first = row_text(&out[0]);
        assert!(first.contains("[########] 75%"), "got `{first}`");
        // None of the earlier states should leak in — they all got
        // overwritten by the CR-redraw.
        assert!(!first.contains("25%"), "got `{first}`");
        assert!(!first.contains("50%"), "got `{first}`");
    }

    #[test]
    fn snapshot_transcript_honors_line_clear() {
        // CSI K (clear-to-end-of-line) is what `clear` and most TUIs
        // use to wipe a line before redrawing. parseAnsi.ts dropped
        // these silently and left ghost text behind; alacritty
        // implements them correctly.
        let bytes = "long line of text\r\x1b[Kshort\n";
        let out = snapshot_transcript(bytes, 80, 24);
        assert!(!out.is_empty());
        let first = row_text(&out[0]);
        assert!(first.contains("short"), "got `{first}`");
        // The long text must have been erased — no leakage past
        // "short" except trailing whitespace.
        let trimmed = first.trim_end();
        assert_eq!(trimmed, "short", "got `{first}` trimmed `{trimmed}`");
    }

    #[test]
    fn snapshot_transcript_preserves_sgr_styling() {
        let bytes = "\x1b[31mred\x1b[0m normal\n";
        let out = snapshot_transcript(bytes, 80, 24);
        assert!(!out.is_empty());
        // The "red" segment must come back as a span with the ANSI red
        // foreground; the " normal" tail must NOT inherit the colour.
        let row = &out[0];
        let red = row.spans.iter().find(|s| s.text.contains("red")).unwrap();
        // `&*` pins the Cow<str> to a concrete `&str` so the comparison resolves
        // to core's PartialEq (a bare `.as_ref()` leaves `&_` ambiguous between
        // core and muda's `impl PartialEq<&str> for &MenuId`, which fails to infer).
        assert_eq!(&*red.fg, ANSI_16[1]);
        let after = row
            .spans
            .iter()
            .find(|s| s.text.contains("normal"))
            .unwrap();
        // SGR 0 reset means the trailing span's fg goes back to the
        // default ("var(--text-primary)") — anything but the red.
        assert_ne!(&*after.fg, ANSI_16[1]);
    }

    #[test]
    fn snapshot_transcript_trims_trailing_blank_rows() {
        // A 3-line transcript rendered into a 24-row scratch Term must
        // produce 3 rows, not 24 — otherwise short commands waste
        // vertical space in the block list.
        let bytes = "one\ntwo\nthree\n";
        let out = snapshot_transcript(bytes, 80, 24);
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn strip_trailing_alt_screen_exit_preserves_content() {
        // Simulate claude's Ctrl+C cleanup: enter alt-screen, draw,
        // exit alt-screen + erase + cursor home.
        let transcript = "\x1b[?1049hHELLO FROM AGENT\r\nLINE 2\x1b[?1049l\x1b[2J\x1b[H";
        let trimmed = strip_trailing_screen_destruction(transcript);
        // The trim should drop the trailing cleanup so the alt-screen
        // content survives a replay.
        assert!(!trimmed.contains("\x1b[?1049l"));
        assert!(!trimmed.ends_with("\x1b[2J"));
        assert!(!trimmed.ends_with("\x1b[H"));
        assert!(trimmed.contains("HELLO FROM AGENT"));
    }

    #[test]
    fn strip_trailing_does_not_touch_mid_transcript_clears() {
        // A clear-screen in the MIDDLE (e.g. `clear` then `ls`)
        // shouldn't be removed — only trailing destruction is.
        let transcript = "before\x1b[2Jafter";
        let trimmed = strip_trailing_screen_destruction(transcript);
        assert_eq!(trimmed, transcript);
    }

    #[test]
    fn strip_trailing_handles_multiple_stacked_sequences() {
        // Real cleanup typically stacks: show cursor + reset SGR +
        // alt-screen-exit + erase + home, sometimes with whitespace
        // between. All should be peeled off the tail.
        let transcript = "content\x1b[0m\x1b[?25h\x1b[?1049l\x1b[2J\x1b[H\r\n";
        let trimmed = strip_trailing_screen_destruction(transcript);
        assert_eq!(trimmed, "content");
    }

    #[test]
    fn strip_trailing_no_op_on_clean_transcripts() {
        // Shell command output that ends with a newline shouldn't lose
        // anything meaningful. The trailing `\n` gets stripped (the
        // whitespace branch) but the visible content is preserved.
        let transcript = "ls output\nmore\n";
        let trimmed = strip_trailing_screen_destruction(transcript);
        assert_eq!(trimmed, "ls output\nmore");
    }

    #[test]
    fn snapshot_transcript_preserves_alt_screen_content_post_ctrl_c() {
        // End-to-end: feed in a claude-style alt-screen session whose
        // tail looks like a Ctrl+C cleanup. The closed block should
        // still carry the agent's last visible state.
        let transcript = "\x1b[?1049hHello, agent here\r\nworking…\x1b[?1049l\x1b[2J\x1b[H";
        let snap = snapshot_transcript(transcript, 30, 5);
        let any_hello = snap.iter().any(|row| {
            row.spans.iter().any(|s| s.text.contains("Hello, agent here"))
        });
        assert!(
            any_hello,
            "alt-screen content should survive the trailing cleanup, but got rows: {:?}",
            snap.iter()
                .map(|r| r.spans.iter().map(|s| s.text.as_str()).collect::<String>())
                .collect::<Vec<_>>(),
        );
    }

    #[test]
    fn snapshot_transcript_safe_with_zero_dims() {
        // Defensive: a session where rows/cols are momentarily 0
        // (mid-resize race, malformed startup args) must not panic.
        let out = snapshot_transcript("hello\n", 0, 0);
        // Caps to 1x1 internally — content gets clipped but no crash.
        assert!(!out.is_empty() || out.is_empty()); // tautology to assert "no panic"
        let _ = out;
    }

    /* ----------------------------------------------------------------
       FlatStorage parity tests — feed identical bytes through both
       paths (legacy direct alacritty walk vs. new FlatStorage pipeline)
       and assert byte-identical RowSnapshot output. Locks the
       migration in: any future drift between the paths trips a test.
       ---------------------------------------------------------------- */

    fn run_both_paths(transcript: &[u8], cols: usize, rows: usize) -> (Vec<RowSnapshot>, Vec<RowSnapshot>) {
        let dims = Dims { cols: cols.max(1), rows: rows.max(1) };
        let mut term = Term::new(term_config(), &dims, NullEventProxy);
        let mut parser: Processor = Processor::new();
        parser.advance(&mut term, transcript);
        let new_path = snapshot_grid(&term);
        let legacy_path = snapshot_grid_legacy(&term);
        (new_path, legacy_path)
    }

    #[test]
    fn flat_storage_path_matches_legacy_plain_text() {
        let (new_p, legacy_p) = run_both_paths(b"hello\r\nworld\r\n", 20, 4);
        assert_eq!(new_p, legacy_p);
    }

    #[test]
    fn flat_storage_path_matches_legacy_sgr_runs() {
        // Multiple SGR transitions in one line — exercises the
        // interval-map walk + span coalesce path.
        let bytes = b"\x1b[31mRED \x1b[32mGREEN \x1b[1;33mBOLD-YELLOW\x1b[0m default";
        let (new_p, legacy_p) = run_both_paths(bytes, 60, 2);
        assert_eq!(new_p, legacy_p);
    }

    #[test]
    fn flat_storage_path_matches_legacy_cr_overstrike() {
        // Progress-bar-style CR redraw. The two paths must agree that
        // only the FINAL row state shows, with no leaked attributes.
        let bytes = b"first line\rSECOND";
        let (new_p, legacy_p) = run_both_paths(bytes, 20, 2);
        assert_eq!(new_p, legacy_p);
    }

    #[test]
    fn flat_storage_path_matches_legacy_line_clear() {
        // CSI K (erase-line) — same semantics check as CR overstrike,
        // but the parser handles it via a different Handler method.
        let bytes = b"keep this\x1b[2K\rgone";
        let (new_p, legacy_p) = run_both_paths(bytes, 20, 2);
        assert_eq!(new_p, legacy_p);
    }

    #[test]
    fn flat_storage_path_matches_legacy_dim_and_underline() {
        // Style bits — dim + underline + their cancels.
        let bytes = b"\x1b[2;4mdim-under\x1b[22;24mclear\x1b[0m";
        let (new_p, legacy_p) = run_both_paths(bytes, 40, 2);
        assert_eq!(new_p, legacy_p);
    }

    #[test]
    fn flat_storage_path_matches_legacy_truecolor() {
        // 24-bit RGB SGR — exercises the PackedColor Rgb branch of
        // the round-trip.
        let bytes = b"\x1b[38;2;255;100;50mwarm\x1b[0m cool";
        let (new_p, legacy_p) = run_both_paths(bytes, 20, 2);
        assert_eq!(new_p, legacy_p);
    }

    #[test]
    fn flat_storage_path_matches_legacy_inverse() {
        // SGR 7 / 27 — inverse video.
        let bytes = b"normal\x1b[7minv\x1b[27mnormal";
        let (new_p, legacy_p) = run_both_paths(bytes, 30, 2);
        assert_eq!(new_p, legacy_p);
    }

    #[test]
    fn dcs_buffer_caps_to_prevent_unbounded_growth() {
        // If the shell starts a DCS but never closes it (crash, hang,
        // hostile payload), we must not OOM. Confirm that feeding a
        // huge payload without a terminator still leaves the segmenter
        // responsive on the next clean OSC 133 cycle. We add an output
        // byte between C and D so the empty-block guard in close()
        // doesn't suppress the resulting block.
        let mut seg = BlockSegmenter::new();
        let mut huge = vec![0x1b, 0x50];
        huge.extend(std::iter::repeat(b'x').take(128 * 1024));
        seg.feed(&huge);
        // Even though the DCS was never closed, normal OSC 133 must
        // still segment correctly once we resync (e.g. on the next
        // ST that does arrive).
        seg.feed(&[0x1b, 0x5c]); // close the DCS
        seg.feed(&osc("133;A"));
        seg.feed(&osc("133;C"));
        seg.feed(b"ok\n");
        let blocks = seg.feed(&osc("133;D;0"));
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].transcript.contains("ok\n"));
    }

    /* ---------- spawn-error classifier (regression from pty.rs) ---------- */

    #[test]
    fn missing_command_friendly_error() {
        let msg = classify_spawn_error("claude", "No such file or directory");
        assert!(msg.contains("command not found"));
        assert!(msg.contains("claude"));
    }

    /* ---------- Color → CSS ---------- */

    #[test]
    fn rgb_color_serializes_to_hex() {
        let css = color_to_css(
            Color::Spec(Rgb { r: 255, g: 0, b: 128 }),
            "x",
        );
        assert_eq!(css, "#ff0080");
    }

    #[test]
    fn indexed_palette_color_resolves() {
        // index 1 = ANSI red
        assert_eq!(color_to_css(Color::Indexed(1), "x"), ANSI_16[1]);
    }

    #[test]
    fn named_foreground_uses_css_var() {
        let css = color_to_css(Color::Named(NamedColor::Foreground), "x");
        assert!(css.starts_with("var("));
    }

    /* ---------- frame diffing ---------- */

    #[test]
    fn diff_returns_only_changed_rows() {
        let row_a = RowSnapshot {
            spans: vec![Span {
                text: "a".into(),
                fg: "x".into(),
                bg: "y".into(),
                bold: false,
                italic: false,
                underline: false,
                inverse: false,
                dim: false,
                strikeout: false,
                link: None,
            }],
        };
        let row_b = RowSnapshot {
            spans: vec![Span {
                text: "b".into(),
                fg: "x".into(),
                bg: "y".into(),
                bold: false,
                italic: false,
                underline: false,
                inverse: false,
                dim: false,
                strikeout: false,
                link: None,
            }],
        };
        let prev = vec![row_a.clone(), row_a.clone(), row_a.clone()];
        let next = vec![row_a.clone(), row_b.clone(), row_a.clone()];
        let diff = diff_rows(&prev, &next);
        assert_eq!(diff.len(), 1);
        assert_eq!(diff[0].row, 1);
    }

    /* ---------- scrollback sampling ---------- */
    //
    // Pins the agent-scroll-history fix: rows that scroll out of the
    // visible grid must surface in `sample_scrollback_rows` in temporal
    // order (oldest first), so the frontend can `Vec::extend` them onto
    // its scrollback buffer and the user can scroll back through
    // everything an agent (claude/codex/aider) has ever written —
    // not just the last screenful that happens to still be in the
    // visible PTY grid.

    #[test]
    fn sample_scrollback_returns_empty_when_no_history() {
        let term = Term::new(
            term_config(),
            &Dims { cols: 10, rows: 4 },
            NullEventProxy,
        );
        let rows = sample_scrollback_rows(&term, 0);
        assert!(rows.is_empty(), "zero count → no rows");
        let rows = sample_scrollback_rows(&term, 10);
        assert!(
            rows.is_empty(),
            "fresh term has no history; should still return empty"
        );
    }

    #[test]
    fn sample_scrollback_captures_rows_in_temporal_order() {
        // 4-row visible grid; print 6 lines so the first 2 spill into
        // history. Order: oldest scrollback row must come first.
        let mut term = Term::new(
            term_config(),
            &Dims { cols: 10, rows: 4 },
            NullEventProxy,
        );
        let mut parser: Processor = Processor::new();
        // Six rows of distinct content separated by CRLF so each line
        // lands on its own row.
        parser.advance(
            &mut term,
            b"row-1\r\nrow-2\r\nrow-3\r\nrow-4\r\nrow-5\r\nrow-6",
        );
        let history = term.grid().history_size();
        assert!(history >= 2, "expected ≥2 rows in history, got {history}");
        let rows = sample_scrollback_rows(&term, history);
        assert_eq!(rows.len(), history);
        // Oldest first: row-1 must precede row-2 in the result.
        let text_of = |spans: &[Span]| -> String {
            let mut out = String::new();
            for s in spans {
                out.push_str(&s.text);
            }
            out.trim_end().to_string()
        };
        let oldest = text_of(&rows[0].spans);
        let next = text_of(&rows[1].spans);
        assert!(
            oldest.starts_with("row-1"),
            "expected oldest row to start with row-1, got {oldest:?}"
        );
        assert!(
            next.starts_with("row-2"),
            "expected second row to start with row-2, got {next:?}"
        );
    }

    #[test]
    fn sample_scrollback_caps_to_history_size() {
        let mut term = Term::new(
            term_config(),
            &Dims { cols: 10, rows: 4 },
            NullEventProxy,
        );
        let mut parser: Processor = Processor::new();
        parser.advance(&mut term, b"a\r\nb\r\nc\r\nd\r\ne\r\nf");
        let history = term.grid().history_size();
        let rows = sample_scrollback_rows(&term, history + 100);
        assert_eq!(
            rows.len(),
            history,
            "asking for more rows than exist must clamp to history size",
        );
    }
}
