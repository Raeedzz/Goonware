//! Agent CLI hook integration — Claude Code, OpenAI Codex CLI, Google Gemini CLI.
//!
//! Modeled after Notchi (sk-ruban/notchi) — same basic shape: per-CLI
//! shell scripts installed into each tool's hooks directory forward
//! lifecycle events to a single Unix socket, the Rust side maps them
//! into a normalized `SessionStatus`, and the frontend listens for the
//! resulting Tauri event to drive the worktree spinner.
//!
//! Flow:
//!
//! ```text
//!   claude / codex / gemini  ─[hook event]─▶  goonware-<cli>-hook.sh
//!                                                  │
//!                                                  ▼
//!                                       /tmp/goonware-agent.sock
//!                                                  │
//!                                                  ▼
//!                                AgentHookState (session map)
//!                                                  │
//!                                                  ▼
//!                          "agent://session/state" Tauri event
//!                                                  │
//!                                                  ▼
//!                                React sidebar spinner
//! ```
//!
//! Each provider installs differently:
//!   * Claude   → `~/.claude/settings.json` (hooks block per event name).
//!   * Codex    → `~/.codex/hooks.json` + `codex_hooks = true` flag in `~/.codex/config.toml`.
//!   * Gemini   → `~/.gemini/settings.json` (hooks block per event name).
//!
//! Codex's hook coverage is the thinnest — only SessionStart /
//! UserPromptSubmit / Stop fire reliably. There's no SessionEnd, so the
//! Rust side does PID-based liveness monitoring: every 2s, walk all
//! known Codex sessions and `kill(pid, 0)`. After two consecutive
//! misses, synthesize a SessionEnd to evict the session from the map.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Wry};

const CLAUDE_HOOK_SCRIPT: &str = include_str!("../resources/goonware-claude-hook.sh");
const CODEX_HOOK_SCRIPT: &str = include_str!("../resources/goonware-codex-hook.sh");
const GEMINI_HOOK_SCRIPT: &str = include_str!("../resources/goonware-gemini-hook.sh");

/// Shared Unix socket. All three providers' scripts forward to the
/// same path; the envelope's `provider` field disambiguates.
const SOCKET_PATH: &str = "/tmp/goonware-agent.sock";

/// Event name emitted on every state change. Frontend listens once at
/// app boot and updates a singleton store.
pub const SESSION_STATE_EVENT: &str = "agent://session/state";

/// Per-session status. The sidebar spinner only spins on
/// `Working`/`Compacting` — the other states render as idle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Working,
    Compacting,
    Waiting,
    Idle,
    Ended,
}

impl SessionStatus {
    #[allow(dead_code)]
    pub fn is_running(self) -> bool {
        matches!(self, SessionStatus::Working | SessionStatus::Compacting)
    }
}

/// Which agent CLI emitted the event. Used in the session-map key so
/// two providers can legitimately reuse the same `session_id`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Claude,
    Codex,
    Gemini,
}

impl Provider {
    fn as_str(&self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::Gemini => "gemini",
        }
    }
}

/// Composite key for the session map. `provider:session_id`.
type SessionKey = String;
fn make_key(provider: Provider, session_id: &str) -> SessionKey {
    format!("{}:{}", provider.as_str(), session_id)
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionRecord {
    pub provider: Provider,
    pub session_id: String,
    pub cwd: String,
    pub status: SessionStatus,
    pub last_event: String,
    pub last_tool: String,
    /// Codex-only — the CLI's process id, captured so the PID monitor
    /// can detect exits that Codex itself doesn't notify us about.
    pub codex_process_id: Option<i32>,
    pub updated_at_ms: u64,
}

#[derive(Default)]
pub struct AgentHookState {
    sessions: Mutex<std::collections::HashMap<SessionKey, SessionRecord>>,
    /// Per-session consecutive PID-miss count for Codex liveness
    /// monitoring. Reset to zero on a successful liveness check.
    codex_miss_counts: Mutex<std::collections::HashMap<SessionKey, u32>>,
    /// Per-session "is the agent currently inside a user-initiated
    /// turn?" flag. Set by turn-start events (UserPromptSubmit /
    /// BeforeAgent), cleared by turn-end events (Stop / AfterAgent /
    /// SessionStart / SessionEnd / Notification[idle_prompt]) and by
    /// the staleness watchdog. Tool / model events outside an active
    /// turn are ignored — without this gate, Claude's startup
    /// context-loading fires PreToolUse and the spinner flashes
    /// before the user has typed anything.
    in_user_turn: Mutex<std::collections::HashMap<SessionKey, bool>>,
}

impl AgentHookState {
    pub fn snapshot(&self) -> Vec<SessionRecord> {
        match self.sessions.lock() {
            Ok(g) => g.values().cloned().collect(),
            Err(_) => Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct HookEnvelope {
    #[serde(default)]
    provider: Option<Provider>,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    event: String,
    #[serde(default)]
    tool: String,
    /// Sub-classifier for events whose meaning depends on a secondary
    /// payload field (today: Claude's Notification → notification_type).
    #[serde(default)]
    aux: String,
    /// Codex-only. The CLI process id we should watch for liveness.
    #[serde(default)]
    codex_process_id: Option<i32>,
    /// True iff this envelope is from a Goonware helper-agent invocation
    /// (commit-message draft, PR description, etc.). Belt-and-braces:
    /// the hook script already exits early when `GOONWARE_HELPER_AGENT` is
    /// set, so this should never reach us in practice — but if a
    /// future script regression skips that check, the Rust side still
    /// drops the envelope and the spinner stays quiet.
    ///
    /// `alias = "gli_helper"` so stale hook scripts left on disk from
    /// the prior GLI name still parse during the upgrade window.
    #[serde(default, alias = "gli_helper")]
    goonware_helper: Option<bool>,
    /// The Goonware session id from the spawning PTY (GOONWARE_SESSION_ID env
    /// var, with GLI_SESSION_ID / RLI_SESSION_ID as legacy fallbacks).
    /// Hook scripts are installed globally, so they fire for *every*
    /// agent invocation on the machine — including ones launched from
    /// Warp, iTerm, or a bare terminal. When that env var is absent,
    /// the agent isn't running inside a Goonware PTY and the envelope
    /// must be dropped so the worktree spinner doesn't fire for
    /// unrelated activity. The script also exits early in that case;
    /// this is belt-and-braces.
    ///
    /// `alias = "gli_session_id"` so stale hook scripts left on disk
    /// from the prior GLI name still parse during the upgrade window.
    #[serde(default, alias = "gli_session_id")]
    goonware_session_id: Option<String>,
    /// User's typed prompt text. Populated for UserPromptSubmit
    /// events; empty for everything else. Fed into the tab-subtitle
    /// summarizer (`claude_activity_summary`) so we can render a
    /// creative "what are you working on" label without reading
    /// `~/.claude/projects/*.jsonl` — which would trigger macOS App
    /// Data Isolation prompts every time Claude opens a new session
    /// (each transcript file gets a fresh MACL UUID).
    #[serde(default)]
    prompt: String,
}

/// Drop envelopes that shouldn't move the spinner at all. Two rules:
///   1. `goonware_helper=true` — internal helper-agent one-shot, never a
///      user-visible turn.
///   2. `goonware_session_id` missing/empty — agent isn't running inside a
///      Goonware PTY (e.g. user is using Claude in Warp at the same time).
/// Factored as a pure predicate so the rules are testable without
/// standing up an AppHandle.
fn should_drop_envelope(envelope: &HookEnvelope) -> bool {
    if envelope.goonware_helper.unwrap_or(false) {
        return true;
    }
    match envelope.goonware_session_id.as_deref() {
        None | Some("") => true,
        Some(_) => false,
    }
}

/// Map a (provider, event, aux) tuple plus the prior `in_user_turn`
/// flag to a transition: `(new_status, new_in_user_turn)`. Returns
/// `None` when the event should be dropped entirely — either because
/// it isn't a state we track, or because it's a tool/model event
/// arriving outside of an active user turn (which we ignore to avoid
/// startup-context-load spinners).
///
/// The turn flag is what separates real work from background
/// housekeeping. Three classes of event:
///   * Turn-start (UserPromptSubmit / BeforeAgent) → Working, set turn
///   * Turn-end   (Stop / AfterAgent / SessionStart / SessionEnd /
///                 Notification[idle_prompt]) → Idle, clear turn
///   * In-turn   (PreToolUse / PostToolUse / BeforeTool / etc.) →
///                 Working only if a turn is active; otherwise ignored.
///
/// Compaction events keep the existing turn state — auto-compact can
/// fire while idle (preserving idle) or mid-turn (preserving working).
fn classify_event(
    provider: Provider,
    event: &str,
    aux: &str,
    in_user_turn: bool,
) -> Option<(SessionStatus, bool)> {
    match provider {
        Provider::Claude => match event {
            "UserPromptSubmit" => Some((SessionStatus::Working, true)),

            "PreToolUse"
            | "PostToolUse"
            | "PostToolUseFailure"
            | "PostToolBatch"
            | "SubagentStart" => {
                if in_user_turn {
                    Some((SessionStatus::Working, true))
                } else {
                    None
                }
            }

            "PreCompact" => Some((SessionStatus::Compacting, in_user_turn)),
            "PostCompact" => Some((SessionStatus::Idle, in_user_turn)),

            "PermissionRequest" => Some((SessionStatus::Waiting, in_user_turn)),

            "Notification" => match aux {
                "permission_prompt" => Some((SessionStatus::Waiting, in_user_turn)),
                "idle_prompt" => Some((SessionStatus::Idle, false)),
                _ => None,
            },

            "Stop" | "SubagentStop" => Some((SessionStatus::Idle, false)),
            "SessionStart" => Some((SessionStatus::Idle, false)),
            "SessionEnd" => Some((SessionStatus::Ended, false)),
            _ => None,
        },

        Provider::Codex => match event {
            // Codex emits these three reliably. The fourth state
            // (Ended) is synthesized by the PID monitor, not by the
            // CLI itself.
            "UserPromptSubmit" => Some((SessionStatus::Working, true)),
            "SessionStart" => Some((SessionStatus::Idle, false)),
            "Stop" => Some((SessionStatus::Idle, false)),
            _ => None,
        },

        Provider::Gemini => match event {
            "BeforeAgent" => Some((SessionStatus::Working, true)),
            "AfterAgent" => Some((SessionStatus::Idle, false)),
            "BeforeTool" | "BeforeModel" | "AfterTool" | "AfterModel" => {
                if in_user_turn {
                    Some((SessionStatus::Working, true))
                } else {
                    None
                }
            }
            "PreCompress" => Some((SessionStatus::Compacting, in_user_turn)),
            "SessionStart" => Some((SessionStatus::Idle, false)),
            "SessionEnd" => Some((SessionStatus::Ended, false)),
            "Notification" => match aux {
                "permission_prompt" => Some((SessionStatus::Waiting, in_user_turn)),
                _ => None,
            },
            _ => None,
        },
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Latest user-prompt text per cwd, captured live from
/// UserPromptSubmit hook events. This is the TCC-safe data source
/// for the tab-subtitle summarizer — Claude's hook script runs
/// inside Claude's process tree (so reading the stdin payload
/// doesn't trip macOS App Data Isolation) and forwards just the
/// prompt string to Goonware via the existing Unix socket. Goonware never has
/// to touch `~/.claude/projects/*.jsonl`, which is the only way to
/// avoid the "would like to access data from other apps" popup that
/// fires on every fresh transcript file's MACL xattr.
static LATEST_PROMPT_BY_CWD: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn record_prompt_for_cwd(cwd: &str, prompt: &str) {
    if cwd.is_empty() || prompt.is_empty() {
        return;
    }
    let store = LATEST_PROMPT_BY_CWD.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut g) = store.lock() {
        g.insert(cwd.to_string(), prompt.to_string());
    }
}

/// Fetch the most recent user prompt observed for `cwd`. Returns
/// `None` until the user submits at least one prompt in a Claude
/// session running in that working directory.
pub fn latest_prompt_for_cwd(cwd: &str) -> Option<String> {
    let store = LATEST_PROMPT_BY_CWD.get_or_init(|| Mutex::new(HashMap::new()));
    store.lock().ok().and_then(|g| g.get(cwd).cloned())
}

/// Test-only seam: lets `claude_usage`'s regression tests drive the
/// hook map without standing up a full Unix-socket listener. Kept
/// `pub(crate)` and `#[cfg(test)]` so it can't leak into shipped code.
#[cfg(test)]
pub(crate) fn record_prompt_for_cwd_for_test(cwd: &str, prompt: &str) {
    record_prompt_for_cwd(cwd, prompt);
}

/// Spawn the Unix-socket listener + the Codex liveness watchdog.
pub fn start_socket_server(app: AppHandle<Wry>) {
    let _ = fs::remove_file(SOCKET_PATH);

    let listener = match UnixListener::bind(SOCKET_PATH) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[goonware-hooks] socket bind failed: {e}");
            return;
        }
    };

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(SOCKET_PATH) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = fs::set_permissions(SOCKET_PATH, perms);
        }
    }

    // Accept loop.
    let accept_app = app.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            handle_connection(stream, &accept_app);
        }
    });

    // Codex PID watchdog. Wakes every 2s, checks `kill(pid, 0)` on
    // every Codex session we know about, and synthesizes a SessionEnd
    // after two consecutive misses (matches notchi's 2-miss debounce
    // — guards against a transient ps glitch falsely killing a live
    // session). Codex has no SessionEnd hook of its own, so liveness
    // checking is the only way we learn it exited.
    //
    // Claude and Gemini deliberately have NO watchdog: they emit
    // reliable Stop / AfterAgent / SessionEnd events at end-of-turn,
    // and any time-based "force idle" we used to run would lie about
    // agent state during normal long turns (extended thinking blocks,
    // multi-minute tool calls). The cost of the missing watchdog is
    // that a hard-killed Claude / Gemini CLI leaves the spinner on
    // until the next real event — strictly preferable to falsely
    // claiming idle while the agent is actively working.
    let watchdog_app = app;
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(2));
        reconcile_codex_liveness(&watchdog_app);
    });
}

fn handle_connection(mut stream: UnixStream, app: &AppHandle<Wry>) {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let mut buf = Vec::with_capacity(2048);
    if let Err(e) = stream.read_to_end(&mut buf) {
        eprintln!("[goonware-hooks] socket read failed: {e}");
        return;
    }
    let envelope: HookEnvelope = match serde_json::from_slice(&buf) {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "[goonware-hooks] decode failed: {e}; raw={}",
                String::from_utf8_lossy(&buf)
            );
            return;
        }
    };
    let provider = envelope.provider.unwrap_or(Provider::Claude);
    if envelope.session_id.is_empty() {
        eprintln!(
            "[goonware-hooks] dropping {} event with empty session_id",
            provider.as_str()
        );
        return;
    }
    if should_drop_envelope(&envelope) {
        let reason = if envelope.goonware_helper.unwrap_or(false) {
            "helper-agent"
        } else {
            "outside-goonware-pty"
        };
        eprintln!(
            "[goonware-hooks] dropping {} envelope ({}: event={} session={})",
            provider.as_str(),
            reason,
            envelope.event,
            envelope.session_id
        );
        return;
    }

    // Capture the user's prompt text for the tab-subtitle summarizer
    // before the event flows through the spinner state machine. This
    // is the only hook field the summarizer needs, and stashing it
    // up here means we don't have to thread it through the rest of
    // the handler.
    if envelope.event == "UserPromptSubmit" && !envelope.prompt.is_empty() {
        record_prompt_for_cwd(&envelope.cwd, &envelope.prompt);
    }

    let state = match app.try_state::<AgentHookState>() {
        Some(s) => s,
        None => return,
    };

    let key = make_key(provider, &envelope.session_id);
    let prior_in_turn = state
        .in_user_turn
        .lock()
        .ok()
        .and_then(|m| m.get(&key).copied())
        .unwrap_or(false);

    let Some((status, new_in_turn)) =
        classify_event(provider, &envelope.event, &envelope.aux, prior_in_turn)
    else {
        eprintln!(
            "[goonware-hooks] {} event '{}' (aux='{}') ignored (in_turn={})",
            provider.as_str(),
            envelope.event,
            envelope.aux,
            prior_in_turn,
        );
        return;
    };
    eprintln!(
        "[goonware-hooks] {} {}{} → {:?} (in_turn {}→{}) cwd={} session={}",
        provider.as_str(),
        envelope.event,
        if envelope.aux.is_empty() {
            String::new()
        } else {
            format!("[{}]", envelope.aux)
        },
        status,
        prior_in_turn,
        new_in_turn,
        envelope.cwd,
        envelope.session_id
    );

    // Apply the turn-flag update. We do this before touching the
    // sessions map so the flag stays consistent even if a later lock
    // acquisition fails.
    if let Ok(mut m) = state.in_user_turn.lock() {
        if new_in_turn {
            m.insert(key.clone(), true);
        } else {
            m.remove(&key);
        }
    }

    let record = {
        let mut sessions = match state.sessions.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if status == SessionStatus::Ended {
            sessions.remove(&key);
            if let Ok(mut misses) = state.codex_miss_counts.lock() {
                misses.remove(&key);
            }
            SessionRecord {
                provider,
                session_id: envelope.session_id.clone(),
                cwd: envelope.cwd.clone(),
                status,
                last_event: envelope.event.clone(),
                last_tool: envelope.tool.clone(),
                codex_process_id: envelope.codex_process_id,
                updated_at_ms: now_ms(),
            }
        } else {
            let entry = sessions
                .entry(key.clone())
                .or_insert(SessionRecord {
                    provider,
                    session_id: envelope.session_id.clone(),
                    cwd: envelope.cwd.clone(),
                    status,
                    last_event: envelope.event.clone(),
                    last_tool: envelope.tool.clone(),
                    codex_process_id: envelope.codex_process_id,
                    updated_at_ms: now_ms(),
                });
            entry.cwd = envelope.cwd.clone();
            entry.status = status;
            entry.last_event = envelope.event.clone();
            if !envelope.tool.is_empty() {
                entry.last_tool = envelope.tool.clone();
            }
            // Keep the most recent non-None pid. Codex hook fires
            // include the PID on every event; this is just defensive
            // in case some event omits it.
            if envelope.codex_process_id.is_some() {
                entry.codex_process_id = envelope.codex_process_id;
            }
            entry.updated_at_ms = now_ms();
            // Successful event for this session resets its miss count.
            if provider == Provider::Codex {
                if let Ok(mut misses) = state.codex_miss_counts.lock() {
                    misses.remove(&key);
                }
            }
            entry.clone()
        }
    };

    let _ = app.emit(SESSION_STATE_EVENT, &record);
}

/// True iff a process with this PID is currently in the kernel's
/// process table. Uses `kill(pid, 0)` — the canonical Unix liveness
/// idiom. `ESRCH` = dead; `EPERM` = alive but inaccessible (treated
/// as alive since the entry still exists); `0` = alive.
fn pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: kill(pid, 0) is a no-op signal that only checks
    // existence + permission. No side effects.
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if result == 0 {
        return true;
    }
    // SAFETY: errno is read immediately after the failed syscall on
    // the same thread, before any other libc call could clobber it.
    let err = unsafe { *libc::__error() };
    err == libc::EPERM
}

const CODEX_MISS_LIMIT: u32 = 2;

/// Walk every Codex session, check liveness, evict on second miss.
/// Synthesizes a SessionEnd record and emits it so the frontend store
/// drops the session — same wire format as a real Ended event.
fn reconcile_codex_liveness(app: &AppHandle<Wry>) {
    let state = match app.try_state::<AgentHookState>() {
        Some(s) => s,
        None => return,
    };

    // Snapshot the Codex sessions first; don't hold the lock across
    // the eviction emit.
    let codex_sessions: Vec<SessionRecord> = match state.sessions.lock() {
        Ok(g) => g
            .values()
            .filter(|r| r.provider == Provider::Codex && r.codex_process_id.is_some())
            .cloned()
            .collect(),
        Err(_) => return,
    };

    let mut to_evict: Vec<SessionRecord> = Vec::new();
    for sess in codex_sessions {
        let pid = match sess.codex_process_id {
            Some(p) => p,
            None => continue,
        };
        let key = make_key(sess.provider, &sess.session_id);
        if pid_alive(pid) {
            if let Ok(mut misses) = state.codex_miss_counts.lock() {
                misses.remove(&key);
            }
            continue;
        }
        let new_miss_count = if let Ok(mut misses) = state.codex_miss_counts.lock() {
            let entry = misses.entry(key.clone()).or_insert(0);
            *entry += 1;
            *entry
        } else {
            0
        };
        if new_miss_count >= CODEX_MISS_LIMIT {
            to_evict.push(sess);
        }
    }

    for mut sess in to_evict {
        eprintln!(
            "[goonware-hooks] codex pid {} exited; ending session {}",
            sess.codex_process_id.unwrap_or(-1),
            sess.session_id
        );
        let key = make_key(sess.provider, &sess.session_id);
        if let Ok(mut sessions) = state.sessions.lock() {
            sessions.remove(&key);
        }
        if let Ok(mut misses) = state.codex_miss_counts.lock() {
            misses.remove(&key);
        }
        if let Ok(mut turns) = state.in_user_turn.lock() {
            turns.remove(&key);
        }
        sess.status = SessionStatus::Ended;
        sess.last_event = "SessionEnd".to_string();
        sess.updated_at_ms = now_ms();
        let _ = app.emit(SESSION_STATE_EVENT, &sess);
    }
}

/// Tauri command — current snapshot of all known agent sessions.
#[tauri::command]
pub fn agent_sessions(state: tauri::State<AgentHookState>) -> Vec<SessionRecord> {
    state.snapshot()
}

/* ------------------------------------------------------------------
   Hook installer — Claude / Codex / Gemini
   ------------------------------------------------------------------ */

fn home_subdir(name: &str) -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(name))
}

/// Install all available hooks. Each CLI is detected by the presence
/// of its config directory; if it isn't installed, we silently skip
/// it. Idempotent — re-running is safe.
pub fn install_hooks() {
    install_claude_hooks();
    install_codex_hooks();
    install_gemini_hooks();
}

/* ---------- Claude ---------- */

fn install_claude_hooks() {
    let Some(dir) = home_subdir(".claude") else {
        return;
    };
    // Claude lazily creates ~/.claude on first run. We create it
    // proactively so a freshly-installed Claude that hasn't been
    // launched yet still picks up our hook on its first run.
    if let Err(e) = fs::create_dir_all(&dir) {
        eprintln!("[goonware-hooks] mkdir {} failed: {e}", dir.display());
        return;
    }
    let hooks_dir = dir.join("hooks");
    if let Err(e) = fs::create_dir_all(&hooks_dir) {
        eprintln!("[goonware-hooks] mkdir claude/hooks failed: {e}");
        return;
    }
    let script_path = hooks_dir.join("goonware-claude-hook.sh");
    if let Err(e) = fs::write(&script_path, CLAUDE_HOOK_SCRIPT) {
        eprintln!("[goonware-hooks] write claude script failed: {e}");
        return;
    }
    chmod_executable(&script_path);
    eprintln!("[goonware-hooks] wrote {}", script_path.display());

    let settings_path = dir.join("settings.json");
    let existing: Value = fs::read_to_string(&settings_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    let updated = upsert_claude_settings(existing);
    write_pretty_json(&settings_path, &updated, "claude settings");
}

fn upsert_claude_settings(mut root: Value) -> Value {
    let command =
        "\"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/goonware-claude-hook.sh\"";
    let hook_entry = json!([{"type": "command", "command": command}]);
    let with_matcher = json!([{"matcher": "*", "hooks": hook_entry}]);
    let without_matcher = json!([{"hooks": hook_entry}]);
    let pre_compact = json!([
        {"matcher": "auto", "hooks": hook_entry},
        {"matcher": "manual", "hooks": hook_entry}
    ]);

    let events: &[(&str, &Value)] = &[
        ("UserPromptSubmit", &without_matcher),
        ("SessionStart", &without_matcher),
        ("PreToolUse", &with_matcher),
        ("PostToolUse", &with_matcher),
        ("PermissionRequest", &with_matcher),
        ("Notification", &without_matcher),
        ("PreCompact", &pre_compact),
        ("PostCompact", &pre_compact),
        ("Stop", &without_matcher),
        ("SubagentStop", &without_matcher),
        ("SessionEnd", &without_matcher),
    ];

    upsert_settings_hooks(&mut root, events, "goonware-claude-hook.sh");
    root
}

/* ---------- Codex ---------- */

fn install_codex_hooks() {
    let Some(dir) = home_subdir(".codex") else {
        return;
    };
    if !dir.exists() {
        // Codex isn't installed. Unlike Claude, we don't create the
        // directory — the user clearly hasn't set up Codex yet, and
        // creating it would mislead future Codex installer logic.
        return;
    }
    let hooks_dir = dir.join("hooks");
    if let Err(e) = fs::create_dir_all(&hooks_dir) {
        eprintln!("[goonware-hooks] mkdir codex/hooks failed: {e}");
        return;
    }
    let script_path = hooks_dir.join("goonware-codex-hook.sh");
    if let Err(e) = fs::write(&script_path, CODEX_HOOK_SCRIPT) {
        eprintln!("[goonware-hooks] write codex script failed: {e}");
        return;
    }
    chmod_executable(&script_path);
    eprintln!("[goonware-hooks] wrote {}", script_path.display());

    // Codex registers hooks in ~/.codex/hooks.json (separate from
    // config.toml). The script path is absolute since Codex doesn't
    // expose a CLAUDE_CONFIG_DIR-equivalent env var.
    let hooks_json_path = dir.join("hooks.json");
    let existing_hooks: Value = fs::read_to_string(&hooks_json_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    let updated_hooks = upsert_codex_hooks_json(existing_hooks, &script_path);
    write_pretty_json(&hooks_json_path, &updated_hooks, "codex hooks.json");

    // Codex hooks are gated behind a feature flag in config.toml.
    let config_path = dir.join("config.toml");
    let existing_cfg = fs::read_to_string(&config_path).unwrap_or_default();
    let updated_cfg = upsert_codex_feature_flag(&existing_cfg);
    if let Err(e) = fs::write(&config_path, &updated_cfg) {
        eprintln!("[goonware-hooks] write codex config.toml failed: {e}");
    } else {
        eprintln!(
            "[goonware-hooks] enabled codex_hooks in {}",
            config_path.display()
        );
    }
}

fn upsert_codex_hooks_json(mut root: Value, script_path: &Path) -> Value {
    let command = script_path.to_string_lossy().into_owned();
    let hook_entry = json!([{"type": "command", "command": command}]);
    let with_matcher = json!([{"matcher": "startup|resume", "hooks": hook_entry}]);
    let without_matcher = json!([{"hooks": hook_entry}]);
    let with_timeout =
        json!([{"hooks": [{"type": "command", "command": command, "timeout": 30}]}]);

    // Codex's reliable hook surface is small — these three events
    // cover spinner-on / spinner-off / fresh-start.
    let events: &[(&str, &Value)] = &[
        ("SessionStart", &with_matcher),
        ("UserPromptSubmit", &without_matcher),
        ("Stop", &with_timeout),
    ];

    if !root.is_object() {
        root = json!({});
    }
    let root_obj = root.as_object_mut().expect("object");
    let hooks_value = root_obj
        .entry("hooks".to_string())
        .or_insert_with(|| json!({}));
    if !hooks_value.is_object() {
        *hooks_value = json!({});
    }
    let hooks_obj = hooks_value.as_object_mut().expect("object");

    for (event, config) in events {
        let entry = hooks_obj
            .entry((*event).to_string())
            .or_insert_with(|| json!([]));
        if !entry.is_array() {
            *entry = json!([]);
        }
        let arr = entry.as_array_mut().expect("array");

        // Strip any prior Goonware entries (different absolute path on a
        // moved install), then re-append the current one.
        arr.retain(|item| {
            !item
                .get("hooks")
                .and_then(|h| h.as_array())
                .map(|inner| {
                    inner.iter().any(|h| {
                        h.get("command")
                            .and_then(|c| c.as_str())
                            .map(|s| s.contains("goonware-codex-hook.sh"))
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false)
        });
        if let Value::Array(extras) = (*config).clone() {
            for x in extras {
                arr.push(x);
            }
        }
    }

    root
}

/// Ensure `codex_hooks = true` exists under `[features]`. Preserves
/// the rest of config.toml byte-for-byte. Lightweight string editing
/// is enough — no need to pull in a full TOML parser.
fn upsert_codex_feature_flag(existing: &str) -> String {
    let target_line = "codex_hooks = true";

    // 1. If a `codex_hooks = ...` line already exists, rewrite it.
    if existing
        .lines()
        .any(|l| l.trim_start().starts_with("codex_hooks"))
    {
        let mut out = String::with_capacity(existing.len());
        for line in existing.split_inclusive('\n') {
            let stripped = line.trim_start();
            if stripped.starts_with("codex_hooks") {
                out.push_str(target_line);
                out.push('\n');
            } else {
                out.push_str(line);
            }
        }
        return out;
    }

    // 2. If `[features]` exists, insert immediately after the header.
    if existing.contains("[features]") {
        let mut out = String::with_capacity(existing.len() + target_line.len() + 1);
        for line in existing.split_inclusive('\n') {
            out.push_str(line);
            if line.trim() == "[features]" {
                out.push_str(target_line);
                out.push('\n');
            }
        }
        return out;
    }

    // 3. Neither exists — append a fresh `[features]` block.
    let mut out = existing.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str("\n[features]\n");
    out.push_str(target_line);
    out.push('\n');
    out
}

/* ---------- Gemini ---------- */

fn install_gemini_hooks() {
    let Some(dir) = home_subdir(".gemini") else {
        return;
    };
    // Proactively create ~/.gemini even if Gemini CLI has never been
    // launched yet — mirrors the Claude installer path. Without this,
    // a fresh Gemini install (binary in PATH but no ~/.gemini directory
    // yet) silently runs without Goonware's hooks attached, so the agent's
    // BeforeAgent / AfterAgent lifecycle events never reach the
    // spinner / activity-tracker on the Goonware side. That manifests as
    // "I typed `gemini` and nothing shows up" — the binary IS running,
    // it just doesn't surface in Goonware's chrome.
    //
    // Gemini reads settings.json eagerly on first invocation, so a
    // pre-created file with our hooks is honoured the first time the
    // user actually launches the CLI.
    if let Err(e) = fs::create_dir_all(&dir) {
        eprintln!("[goonware-hooks] mkdir {} failed: {e}", dir.display());
        return;
    }
    let hooks_dir = dir.join("hooks");
    if let Err(e) = fs::create_dir_all(&hooks_dir) {
        eprintln!("[goonware-hooks] mkdir gemini/hooks failed: {e}");
        return;
    }
    let script_path = hooks_dir.join("goonware-gemini-hook.sh");
    if let Err(e) = fs::write(&script_path, GEMINI_HOOK_SCRIPT) {
        eprintln!("[goonware-hooks] write gemini script failed: {e}");
        return;
    }
    chmod_executable(&script_path);
    eprintln!("[goonware-hooks] wrote {}", script_path.display());

    let settings_path = dir.join("settings.json");
    let existing: Value = fs::read_to_string(&settings_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    let updated = upsert_gemini_settings(existing, &script_path);
    write_pretty_json(&settings_path, &updated, "gemini settings");
}

fn upsert_gemini_settings(mut root: Value, script_path: &Path) -> Value {
    let command = script_path.to_string_lossy().into_owned();
    let hook_entry = json!([{"type": "command", "command": command}]);
    let without_matcher = json!([{"hooks": hook_entry}]);
    let with_matcher = json!([{"matcher": "*", "hooks": hook_entry}]);

    // Gemini's lifecycle vocabulary: BeforeAgent / AfterAgent bookend
    // a turn, SessionStart / SessionEnd bookend a session, and the
    // tool / model hooks fire in between.
    let events: &[(&str, &Value)] = &[
        ("SessionStart", &without_matcher),
        ("BeforeAgent", &without_matcher),
        ("AfterAgent", &without_matcher),
        ("BeforeTool", &with_matcher),
        ("AfterTool", &with_matcher),
        ("Notification", &without_matcher),
        ("PreCompress", &without_matcher),
        ("SessionEnd", &without_matcher),
    ];

    upsert_settings_hooks(&mut root, events, "goonware-gemini-hook.sh");
    root
}

/* ---------- shared helpers ---------- */

/// Shared upsert for the Claude- and Gemini-style nested `hooks` map.
/// Reads any existing entries and appends ours only if our marker
/// filename isn't already present.
fn upsert_settings_hooks(
    root: &mut Value,
    events: &[(&str, &Value)],
    marker_filename: &str,
) {
    if !root.is_object() {
        *root = json!({});
    }
    let root_obj = root.as_object_mut().expect("object");
    let hooks_value = root_obj
        .entry("hooks".to_string())
        .or_insert_with(|| json!({}));
    if !hooks_value.is_object() {
        *hooks_value = json!({});
    }
    let hooks_obj = hooks_value.as_object_mut().expect("object");

    for (event, config) in events {
        let entry = hooks_obj
            .entry((*event).to_string())
            .or_insert_with(|| json!([]));
        if !entry.is_array() {
            *entry = json!([]);
        }
        let arr = entry.as_array_mut().expect("array");

        let mut found = false;
        for item in arr.iter() {
            let Some(inner) = item.get("hooks").and_then(|h| h.as_array()) else {
                continue;
            };
            if inner.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|s| s.contains(marker_filename))
                    .unwrap_or(false)
            }) {
                found = true;
                break;
            }
        }
        if !found {
            if let Value::Array(extras) = (*config).clone() {
                for x in extras {
                    arr.push(x);
                }
            }
        }
    }
}

fn chmod_executable(path: &PathBuf) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = fs::set_permissions(path, perms);
        }
    }
    let _ = path;
}

fn write_pretty_json(path: &PathBuf, value: &Value, label: &str) {
    match serde_json::to_string_pretty(value) {
        Ok(s) => match fs::write(path, &s) {
            Ok(()) => eprintln!("[goonware-hooks] wrote {} ({label})", path.display()),
            Err(e) => eprintln!("[goonware-hooks] write {label} failed: {e}"),
        },
        Err(e) => eprintln!("[goonware-hooks] serialize {label} failed: {e}"),
    }
}

/* ------------------------------------------------------------------
   Tests
   ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: classify and pull just the status, assuming the
    /// session is already mid-turn. Used by tests that just care
    /// about the event→status mapping.
    fn classify_in_turn(provider: Provider, event: &str, aux: &str) -> Option<SessionStatus> {
        classify_event(provider, event, aux, true).map(|(s, _)| s)
    }

    #[test]
    fn classify_claude_events() {
        assert_eq!(
            classify_in_turn(Provider::Claude, "UserPromptSubmit", ""),
            Some(SessionStatus::Working)
        );
        assert_eq!(
            classify_in_turn(Provider::Claude, "PreToolUse", ""),
            Some(SessionStatus::Working)
        );
        assert_eq!(
            classify_in_turn(Provider::Claude, "PreCompact", ""),
            Some(SessionStatus::Compacting)
        );
        assert_eq!(
            classify_in_turn(Provider::Claude, "PermissionRequest", ""),
            Some(SessionStatus::Waiting)
        );
        assert_eq!(
            classify_in_turn(Provider::Claude, "Stop", ""),
            Some(SessionStatus::Idle)
        );
        assert_eq!(
            classify_in_turn(Provider::Claude, "SessionEnd", ""),
            Some(SessionStatus::Ended)
        );
        assert_eq!(classify_in_turn(Provider::Claude, "UnknownEvent", ""), None);
    }

    #[test]
    fn classify_claude_notification_by_aux() {
        assert_eq!(
            classify_in_turn(Provider::Claude, "Notification", "idle_prompt"),
            Some(SessionStatus::Idle)
        );
        assert_eq!(
            classify_in_turn(Provider::Claude, "Notification", "permission_prompt"),
            Some(SessionStatus::Waiting)
        );
        assert_eq!(classify_in_turn(Provider::Claude, "Notification", ""), None);
    }

    #[test]
    fn classify_codex_events() {
        assert_eq!(
            classify_in_turn(Provider::Codex, "UserPromptSubmit", ""),
            Some(SessionStatus::Working)
        );
        assert_eq!(
            classify_in_turn(Provider::Codex, "SessionStart", ""),
            Some(SessionStatus::Idle)
        );
        assert_eq!(
            classify_in_turn(Provider::Codex, "Stop", ""),
            Some(SessionStatus::Idle)
        );
        // Codex never emits SessionEnd — PID monitor synthesizes it.
        assert_eq!(classify_in_turn(Provider::Codex, "SessionEnd", ""), None);
    }

    #[test]
    fn classify_gemini_events() {
        assert_eq!(
            classify_in_turn(Provider::Gemini, "BeforeAgent", ""),
            Some(SessionStatus::Working)
        );
        assert_eq!(
            classify_in_turn(Provider::Gemini, "AfterAgent", ""),
            Some(SessionStatus::Idle)
        );
        assert_eq!(
            classify_in_turn(Provider::Gemini, "PreCompress", ""),
            Some(SessionStatus::Compacting)
        );
        assert_eq!(
            classify_in_turn(Provider::Gemini, "SessionEnd", ""),
            Some(SessionStatus::Ended)
        );
    }

    /* ---------- in_user_turn gating ---------- */

    /// The reported bug: opening Claude lights the spinner before the
    /// user has typed anything. Cause: Claude's startup
    /// (resume-from-prior-session, context loading) fires PreToolUse
    /// for internal reads. Without gating, that flips status to
    /// Working and the spinner fires.
    ///
    /// Fix: PreToolUse (and the other tool/model events) are dropped
    /// entirely when no turn-start event has been observed first.
    #[test]
    fn claude_tool_event_before_user_prompt_is_dropped() {
        // No prior UserPromptSubmit → in_user_turn = false.
        assert_eq!(
            classify_event(Provider::Claude, "PreToolUse", "", false),
            None
        );
        assert_eq!(
            classify_event(Provider::Claude, "PostToolUse", "", false),
            None
        );
        assert_eq!(
            classify_event(Provider::Claude, "PostToolUseFailure", "", false),
            None
        );
        assert_eq!(
            classify_event(Provider::Claude, "SubagentStart", "", false),
            None
        );
    }

    /// Same gating applies to Gemini's tool / model events. Without
    /// it, Gemini's startup model-prep would spin the worktree.
    #[test]
    fn gemini_tool_event_before_user_prompt_is_dropped() {
        assert_eq!(
            classify_event(Provider::Gemini, "BeforeTool", "", false),
            None
        );
        assert_eq!(
            classify_event(Provider::Gemini, "AfterTool", "", false),
            None
        );
        assert_eq!(
            classify_event(Provider::Gemini, "BeforeModel", "", false),
            None
        );
        assert_eq!(
            classify_event(Provider::Gemini, "AfterModel", "", false),
            None
        );
    }

    /// Turn-start events register regardless of prior state — they
    /// SET the turn flag, so they don't depend on it.
    #[test]
    fn turn_start_events_always_register() {
        assert_eq!(
            classify_event(Provider::Claude, "UserPromptSubmit", "", false),
            Some((SessionStatus::Working, true))
        );
        assert_eq!(
            classify_event(Provider::Claude, "UserPromptSubmit", "", true),
            Some((SessionStatus::Working, true))
        );
        assert_eq!(
            classify_event(Provider::Codex, "UserPromptSubmit", "", false),
            Some((SessionStatus::Working, true))
        );
        assert_eq!(
            classify_event(Provider::Gemini, "BeforeAgent", "", false),
            Some((SessionStatus::Working, true))
        );
    }

    /// Tool events DO register once a user turn is active — the gate
    /// only fires before the first UserPromptSubmit, not after.
    #[test]
    fn tool_events_register_inside_user_turn() {
        assert_eq!(
            classify_event(Provider::Claude, "PreToolUse", "", true),
            Some((SessionStatus::Working, true))
        );
        assert_eq!(
            classify_event(Provider::Claude, "PostToolUse", "", true),
            Some((SessionStatus::Working, true))
        );
        assert_eq!(
            classify_event(Provider::Gemini, "BeforeTool", "", true),
            Some((SessionStatus::Working, true))
        );
        assert_eq!(
            classify_event(Provider::Gemini, "AfterTool", "", true),
            Some((SessionStatus::Working, true))
        );
    }

    /// Turn-end events clear the flag so a subsequent stray tool
    /// event (rare, but possible from a buggy agent) doesn't reignite
    /// the spinner.
    #[test]
    fn turn_end_events_clear_in_user_turn() {
        // After Stop, in_user_turn is false → subsequent tool event drops.
        let (status, in_turn) =
            classify_event(Provider::Claude, "Stop", "", true).unwrap();
        assert_eq!(status, SessionStatus::Idle);
        assert!(!in_turn);

        let (status, in_turn) =
            classify_event(Provider::Claude, "SubagentStop", "", true).unwrap();
        assert_eq!(status, SessionStatus::Idle);
        assert!(!in_turn);

        let (status, in_turn) =
            classify_event(Provider::Gemini, "AfterAgent", "", true).unwrap();
        assert_eq!(status, SessionStatus::Idle);
        assert!(!in_turn);

        let (status, in_turn) =
            classify_event(Provider::Claude, "SessionStart", "", true).unwrap();
        assert_eq!(status, SessionStatus::Idle);
        assert!(!in_turn);
    }

    /// PreCompact / PreCompress preserve the existing turn state.
    /// Auto-compact can fire mid-turn (compacting working state) or
    /// out-of-turn (just session housekeeping); in either case the
    /// status itself transitions to Compacting but the turn flag is
    /// unchanged.
    #[test]
    fn compaction_events_preserve_turn_flag() {
        // Mid-turn: in_user_turn stays true.
        let (status, in_turn) =
            classify_event(Provider::Claude, "PreCompact", "", true).unwrap();
        assert_eq!(status, SessionStatus::Compacting);
        assert!(in_turn);

        // Out-of-turn: stays false.
        let (status, in_turn) =
            classify_event(Provider::Claude, "PreCompact", "", false).unwrap();
        assert_eq!(status, SessionStatus::Compacting);
        assert!(!in_turn);
    }

    /// PermissionRequest preserves the turn flag — the user is
    /// pausing the agent, but the turn hasn't ended.
    #[test]
    fn permission_request_preserves_turn_flag() {
        let (status, in_turn) =
            classify_event(Provider::Claude, "PermissionRequest", "", true).unwrap();
        assert_eq!(status, SessionStatus::Waiting);
        assert!(in_turn);
    }

    /// Notification[idle_prompt] is Claude's "agent is back at its
    /// input box" safety-net signal (fires e.g. after Ctrl+C when
    /// Stop didn't). It must clear the turn flag — the user is no
    /// longer being processed for.
    #[test]
    fn idle_prompt_notification_clears_turn() {
        let (status, in_turn) =
            classify_event(Provider::Claude, "Notification", "idle_prompt", true).unwrap();
        assert_eq!(status, SessionStatus::Idle);
        assert!(!in_turn);
    }

    #[test]
    fn upsert_claude_into_empty_settings() {
        let out = upsert_claude_settings(json!({}));
        let hooks = out.get("hooks").and_then(|h| h.as_object()).unwrap();
        assert!(hooks.contains_key("UserPromptSubmit"));
        assert!(hooks.contains_key("Stop"));
        assert!(hooks.contains_key("PreCompact"));
        assert_eq!(
            hooks
                .get("PreCompact")
                .and_then(|v| v.as_array())
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn upsert_claude_is_idempotent_on_re_install() {
        let once = upsert_claude_settings(json!({}));
        let twice = upsert_claude_settings(once.clone());
        assert_eq!(once, twice);
    }

    #[test]
    fn upsert_claude_preserves_unrelated_user_hooks() {
        let user = json!({
            "hooks": {
                "Stop": [
                    {"hooks": [{"type": "command", "command": "echo done"}]}
                ]
            },
            "somethingElse": "untouched"
        });
        let out = upsert_claude_settings(user);
        assert_eq!(out.get("somethingElse").and_then(|v| v.as_str()), Some("untouched"));
        let stop = out
            .get("hooks")
            .and_then(|h| h.get("Stop"))
            .and_then(|v| v.as_array())
            .unwrap();
        assert_eq!(stop.len(), 2);
    }

    #[test]
    fn upsert_codex_feature_flag_into_empty() {
        let out = upsert_codex_feature_flag("");
        assert!(out.contains("[features]"));
        assert!(out.contains("codex_hooks = true"));
    }

    #[test]
    fn upsert_codex_feature_flag_idempotent() {
        let once = upsert_codex_feature_flag("");
        let twice = upsert_codex_feature_flag(&once);
        assert_eq!(once.matches("codex_hooks = true").count(), 1);
        assert_eq!(twice.matches("codex_hooks = true").count(), 1);
    }

    #[test]
    fn upsert_codex_feature_flag_rewrites_existing() {
        let prior = "[features]\ncodex_hooks = false\nother = 1\n";
        let out = upsert_codex_feature_flag(prior);
        assert!(out.contains("codex_hooks = true"));
        assert!(!out.contains("codex_hooks = false"));
        assert!(out.contains("other = 1"));
    }

    #[test]
    fn upsert_codex_feature_flag_inserts_under_existing_features() {
        let prior = "[features]\nother = 1\n";
        let out = upsert_codex_feature_flag(prior);
        assert!(out.contains("codex_hooks = true"));
        assert!(out.contains("other = 1"));
        let header_pos = out.find("[features]").unwrap();
        let flag_pos = out.find("codex_hooks = true").unwrap();
        assert!(flag_pos > header_pos);
    }

    #[test]
    fn running_states_classification() {
        assert!(SessionStatus::Working.is_running());
        assert!(SessionStatus::Compacting.is_running());
        assert!(!SessionStatus::Waiting.is_running());
        assert!(!SessionStatus::Idle.is_running());
        assert!(!SessionStatus::Ended.is_running());
    }

    #[test]
    fn pid_alive_self() {
        assert!(pid_alive(std::process::id() as i32));
    }

    #[test]
    fn pid_alive_zero_and_negative() {
        assert!(!pid_alive(0));
        assert!(!pid_alive(-1));
    }

    /* ---------- helper-agent envelope drop ---------- */

    /// Helper for these tests: build a HookEnvelope from a JSON
    /// fragment. Pure JSON path so the test stays focused on
    /// semantics, not struct boilerplate.
    fn envelope_from_json(v: serde_json::Value) -> HookEnvelope {
        serde_json::from_value(v).expect("envelope decodes")
    }

    /// The reported bug: pressing "draft commit message" / "draft PR
    /// description" runs claude --print, which fires UserPromptSubmit
    /// / Stop just like an interactive turn. Without the helper-agent
    /// marker we'd light the worktree spinner for those one-shot
    /// calls. The marker must cause the envelope to be dropped
    /// outright — no session creation, no event emission.
    #[test]
    fn helper_envelope_is_dropped() {
        let helper = envelope_from_json(serde_json::json!({
            "provider": "claude",
            "session_id": "abc-123",
            "cwd": "/Users/x/repo",
            "event": "UserPromptSubmit",
            "goonware_helper": true,
        }));
        assert!(should_drop_envelope(&helper));
    }

    /// The same envelope without the marker must NOT be dropped —
    /// that's a real user turn, the spinner should fire normally.
    /// `goonware_session_id` is included so the "agent must be running
    /// inside Goonware" guard doesn't drop it for an unrelated reason.
    #[test]
    fn non_helper_envelope_is_kept() {
        let interactive = envelope_from_json(serde_json::json!({
            "provider": "claude",
            "session_id": "abc-123",
            "cwd": "/Users/x/repo",
            "event": "UserPromptSubmit",
            "goonware_session_id": "goonware-session-1",
        }));
        assert!(!should_drop_envelope(&interactive));

        let explicit_false = envelope_from_json(serde_json::json!({
            "provider": "claude",
            "session_id": "abc-123",
            "cwd": "/Users/x/repo",
            "event": "UserPromptSubmit",
            "goonware_helper": false,
            "goonware_session_id": "goonware-session-1",
        }));
        assert!(!should_drop_envelope(&explicit_false));
    }

    /// The marker applies regardless of provider — helper agents can
    /// run claude / codex / gemini and the spinner-suppression rule
    /// is the same for all three.
    #[test]
    fn helper_envelope_dropped_for_every_provider() {
        for provider in ["claude", "codex", "gemini"] {
            let env = envelope_from_json(serde_json::json!({
                "provider": provider,
                "session_id": "x",
                "cwd": "/tmp",
                "event": "UserPromptSubmit",
                "goonware_helper": true,
                "goonware_session_id": "goonware-session-1",
            }));
            assert!(
                should_drop_envelope(&env),
                "helper envelope from provider={} should be dropped",
                provider
            );
        }
    }

    /* ---------- external-agent envelope drop (Warp / iTerm / etc.) ---------- */

    /// The reported bug: user runs Claude from Warp at the same time
    /// Goonware is open. Warp's PTY has no GOONWARE_SESSION_ID, so the hook
    /// envelope has no `goonware_session_id` field. Without this guard, the
    /// spinner would fire in Goonware for an agent that isn't even running
    /// inside the app.
    #[test]
    fn envelope_without_goonware_session_id_is_dropped() {
        let external = envelope_from_json(serde_json::json!({
            "provider": "claude",
            "session_id": "abc-123",
            "cwd": "/Users/x/repo",
            "event": "UserPromptSubmit",
        }));
        assert!(should_drop_envelope(&external));
    }

    /// An empty-string `goonware_session_id` is treated the same as missing
    /// — the bash hook may emit `"goonware_session_id": ""` when the env
    /// var is unset (depending on quoting), so we must drop that too.
    #[test]
    fn envelope_with_empty_goonware_session_id_is_dropped() {
        let external = envelope_from_json(serde_json::json!({
            "provider": "claude",
            "session_id": "abc-123",
            "cwd": "/Users/x/repo",
            "event": "UserPromptSubmit",
            "goonware_session_id": "",
        }));
        assert!(should_drop_envelope(&external));
    }

    /// External-agent rule applies to every provider — same as
    /// helper-agent — since Codex and Gemini hooks are installed
    /// globally too.
    #[test]
    fn external_envelope_dropped_for_every_provider() {
        for provider in ["claude", "codex", "gemini"] {
            let env = envelope_from_json(serde_json::json!({
                "provider": provider,
                "session_id": "x",
                "cwd": "/tmp",
                "event": "UserPromptSubmit",
            }));
            assert!(
                should_drop_envelope(&env),
                "external (no goonware_session_id) envelope from provider={} should be dropped",
                provider
            );
        }
    }

    /// Any non-empty `goonware_session_id` keeps the envelope — the value
    /// itself isn't validated here, only its presence. (The session id
    /// is informational; cwd-based worktree matching is what actually
    /// routes the spinner.)
    #[test]
    fn envelope_with_goonware_session_id_is_kept() {
        for sid in ["goonware-1", "abc", "x"] {
            let env = envelope_from_json(serde_json::json!({
                "provider": "claude",
                "session_id": "s",
                "cwd": "/tmp",
                "event": "UserPromptSubmit",
                "goonware_session_id": sid,
            }));
            assert!(
                !should_drop_envelope(&env),
                "envelope with goonware_session_id={:?} must be kept",
                sid
            );
        }
    }

    /// Sanity check on the script-level guard: the bundled hook
    /// scripts must exit early when `GOONWARE_HELPER_AGENT` is set. The
    /// script-level skip is the primary defense (no socket write at
    /// all); the envelope-level `goonware_helper` drop is just
    /// belt-and-braces. Asserting on the embedded `include_str!`
    /// content catches an accidental removal of the guard during
    /// refactors.
    #[test]
    fn hook_scripts_check_helper_env_var() {
        assert!(
            CLAUDE_HOOK_SCRIPT.contains("GOONWARE_HELPER_AGENT"),
            "claude hook script must skip when GOONWARE_HELPER_AGENT is set"
        );
        assert!(
            CODEX_HOOK_SCRIPT.contains("GOONWARE_HELPER_AGENT"),
            "codex hook script must skip when GOONWARE_HELPER_AGENT is set"
        );
        assert!(
            GEMINI_HOOK_SCRIPT.contains("GOONWARE_HELPER_AGENT"),
            "gemini hook script must skip when GOONWARE_HELPER_AGENT is set"
        );
    }

    /// Hook scripts are installed globally and fire for every agent
    /// invocation, including ones from Warp / iTerm / bare Terminal.
    /// Each script must check for GOONWARE_SESSION_ID (with RLI_SESSION_ID
    /// as the legacy fallback) and exit early when neither is set. If
    /// this assertion fails, the script has lost its guard and the
    /// spinner will fire for agents outside Goonware.
    #[test]
    fn hook_scripts_check_goonware_session_id() {
        for (name, body) in [
            ("claude", CLAUDE_HOOK_SCRIPT),
            ("codex", CODEX_HOOK_SCRIPT),
            ("gemini", GEMINI_HOOK_SCRIPT),
        ] {
            assert!(
                body.contains("GOONWARE_SESSION_ID"),
                "{} hook script must read GOONWARE_SESSION_ID",
                name
            );
            assert!(
                body.contains("GLI_SESSION_ID"),
                "{} hook script must fall back to GLI_SESSION_ID",
                name
            );
            assert!(
                body.contains("RLI_SESSION_ID"),
                "{} hook script must fall back to RLI_SESSION_ID",
                name
            );
        }
    }
}
