//! Real Claude usage scanner — reads Claude Code's own transcript files
//! at `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` and
//! aggregates token counts within the rolling 5-hour usage window.
//!
//! This replaces the previous PTY-banner-sniff heuristic, which only
//! knew "claude was launched at time X in this pane" — useless for
//! actual rate-limit budgeting because:
//!
//!   - it didn't see usage from claude sessions launched outside RLI
//!   - it didn't reset on a real window roll-over (5h after first msg)
//!   - it had no token visibility at all
//!
//! Schema (one JSON per line, append-only). The fields we care about:
//!
//! ```json
//! {
//!   "type": "assistant",
//!   "timestamp": "2026-04-28T01:16:32.435Z",
//!   "message": {
//!     "model": "claude-opus-4-7",
//!     "usage": {
//!       "input_tokens": 6,
//!       "output_tokens": 190,
//!       "cache_read_input_tokens": 14779,
//!       "cache_creation_input_tokens": 14181
//!     }
//!   }
//! }
//! ```
//!
//! User messages don't carry usage; we only count `assistant` rows.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::helper_agent::{run_inline, HelperMode};

/// Process-wide kill switch for transcript scanning. Set to true the
/// first time we hit a permission-style error reading ~/.claude/ —
/// that's macOS Sequoia's "App Data" TCC popup denying us access
/// because the JSONL files have a different "responsible bundle" MACL
/// than `dev.raeedz.gli`. The kernel pops up the consent dialog
/// BEFORE the read returns, so we can't prevent the first prompt, but
/// flipping this flag prevents the polling loop from retriggering the
/// dialog 12 times per minute for every new Claude session whose
/// transcript file has a fresh MACL UUID. The flag resets on app
/// restart so users who later grant Full Disk Access don't have to
/// flush state manually.
static APP_DATA_BLOCKED: AtomicBool = AtomicBool::new(false);

/// True if the last `claude_usage_status` call hit an access error
/// and switched off the transcript scan. Surfaced as a field on the
/// returned status so the frontend can show a "grant Full Disk
/// Access" hint without re-attempting the read and re-spawning the
/// TCC popup.
fn is_app_data_blocked() -> bool {
    APP_DATA_BLOCKED.load(Ordering::Relaxed)
}

fn note_app_data_error(err: &std::io::Error, path: &Path) {
    // PermissionDenied is the canonical error after the user clicks
    // "Don't Allow" on the App Data popup. NotFound means the file
    // genuinely isn't there (no transcripts yet) — that's not a TCC
    // issue and shouldn't trip the breaker. Anything else (e.g.
    // operation timed out while the popup was open) is suspicious
    // enough to back off too.
    if matches!(err.kind(), ErrorKind::PermissionDenied) {
        if !APP_DATA_BLOCKED.swap(true, Ordering::Relaxed) {
            eprintln!(
                "[claude-usage] disabling transcript scan after permission \
                 error on {}: {err}",
                path.display()
            );
        }
    }
}

/// Anthropic's enforced 5-hour session length. A "session" in
/// Claude.ai's UI = a 5h timer that starts on your first message after
/// the previous session expired. We mirror that: walk messages
/// chronologically, restart the session anchor whenever 5h has elapsed
/// since the current anchor.
const WINDOW_MS: i64 = 5 * 60 * 60 * 1000;

/// We need to look back far enough to find the boundary BEFORE the
/// current session — i.e. up to 5h of in-session messages plus a
/// generous gap for the previous session. 12h is enough to anchor
/// any current session correctly even if the user has been active
/// continuously for hours.
const LOOKBACK_MS: i64 = 12 * 60 * 60 * 1000;

#[derive(Debug, Default, Serialize, Clone)]
pub struct ModelBreakdown {
    pub messages: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

#[derive(Debug, Default, Serialize)]
pub struct ClaudeUsageStatus {
    /// True when at least one assistant message was found in the
    /// window. When false the pill should be hidden.
    pub active: bool,
    /// Wall-clock millis of the OLDEST message in the current window
    /// (anchors the 5-hour countdown). `None` when `active = false`.
    pub window_start_ms: Option<i64>,
    /// `window_start_ms + 5h`. Reset time. `None` when `active = false`.
    pub window_ends_ms: Option<i64>,
    pub message_count: u32,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_cache_creation_tokens: u64,
    /// Per-model aggregates. Keyed by the model id Claude wrote into
    /// the transcript (e.g. `claude-opus-4-7`, `claude-sonnet-4-6`).
    pub by_model: HashMap<String, ModelBreakdown>,
    /// How many transcript files we actually opened. Used for the
    /// frontend's "scanned N sessions" hint and for diagnosing empty
    /// readings (no projects, permissions issues).
    pub scanned_files: u32,
    /// EXACT 5-hour usage percent reported by Anthropic (0-100), via
    /// the `rate_limits.five_hour.used_percentage` field that Claude
    /// Code feeds to its status-line hook. `None` when the user
    /// hasn't installed RLI's status-line capture script (in which
    /// case the frontend falls back to a calibrated estimate against
    /// transcript token counts).
    pub real_five_hour_percent: Option<f32>,
    /// EXACT 7-day usage percent. Same provenance as above.
    pub real_seven_day_percent: Option<f32>,
    /// Real reset wall-clock millis for the 5h window, when available.
    pub real_five_hour_resets_ms: Option<i64>,
    /// When the gli-usage-capture.sh hook last wrote the cache file,
    /// in epoch millis. Used by the frontend to age out stale data.
    pub real_captured_at_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct CapturedRateLimit {
    used_percentage: Option<f32>,
    resets_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct CapturedRateLimits {
    five_hour: Option<CapturedRateLimit>,
    seven_day: Option<CapturedRateLimit>,
}

#[derive(Debug, Deserialize)]
struct CapturedUsage {
    rate_limits: Option<CapturedRateLimits>,
    captured_at_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct TranscriptLine {
    #[serde(default, rename = "type")]
    line_type: String,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    message: Option<MessagePayload>,
}

#[derive(Debug, Deserialize)]
struct MessagePayload {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    usage: Option<UsageBlock>,
}

#[derive(Debug, Deserialize, Default)]
struct UsageBlock {
    #[serde(default)]
    input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens: Option<u64>,
    #[serde(default)]
    cache_read_input_tokens: Option<u64>,
    #[serde(default)]
    cache_creation_input_tokens: Option<u64>,
}

/// One assistant message worth of usage data, retained as a flat row
/// so we can sort them across files before walking session boundaries.
#[derive(Debug, Clone)]
struct UsageRow {
    ts_ms: i64,
    model: Option<String>,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
}

#[tauri::command]
pub fn claude_usage_status() -> Result<ClaudeUsageStatus, String> {
    let now_ms = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(_) => 0,
    };
    let lookback_cutoff_ms = now_ms - LOOKBACK_MS;

    // Honor the App Data circuit breaker. Once tripped, we don't
    // open any files under ~/.claude/ for the rest of the session,
    // which stops the 5s polling loop from re-spawning the TCC
    // popup every time Claude creates a new session transcript
    // with a fresh MACL UUID.
    if is_app_data_blocked() {
        return Ok(ClaudeUsageStatus::default());
    }

    let projects_dir = match dirs::home_dir() {
        Some(h) => h.join(".claude").join("projects"),
        None => return Ok(ClaudeUsageStatus::default()),
    };
    // Use metadata() rather than exists() — a permission error here
    // also trips the breaker, so a single "Don't Allow" closes the
    // door on every downstream open() that would re-prompt.
    match fs::metadata(&projects_dir) {
        Ok(_) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => {
            // Claude Code never installed. Empty status — pill stays hidden.
            return Ok(ClaudeUsageStatus::default());
        }
        Err(e) => {
            note_app_data_error(&e, &projects_dir);
            return Ok(ClaudeUsageStatus::default());
        }
    }

    let files = collect_transcript_files(&projects_dir, lookback_cutoff_ms);
    let mut status = ClaudeUsageStatus::default();
    let mut rows: Vec<UsageRow> = Vec::new();

    for path in &files {
        // Stop the moment we hit a permission denial — every
        // subsequent open() would re-fire the macOS App Data popup
        // for files with fresh MACL UUIDs.
        if is_app_data_blocked() {
            break;
        }
        status.scanned_files += 1;
        let file = match File::open(path) {
            Ok(f) => f,
            Err(e) => {
                note_app_data_error(&e, path);
                continue;
            }
        };
        let reader = BufReader::new(file);
        for line in reader.lines() {
            let Ok(raw) = line else { continue };
            if raw.is_empty() {
                continue;
            }
            // Each line is JSON; bad lines are skipped silently —
            // partial writes can happen at the tail of a live file.
            let parsed: TranscriptLine = match serde_json::from_str(&raw) {
                Ok(p) => p,
                Err(_) => continue,
            };
            if parsed.line_type != "assistant" {
                continue;
            }
            let Some(ts_iso) = parsed.timestamp.as_deref() else {
                continue;
            };
            let ts_ms = match parse_iso_to_ms(ts_iso) {
                Some(t) => t,
                None => continue,
            };
            if ts_ms < lookback_cutoff_ms {
                continue;
            }
            let Some(msg) = parsed.message else { continue };
            let Some(usage) = msg.usage else { continue };

            let input = usage.input_tokens.unwrap_or(0);
            let output = usage.output_tokens.unwrap_or(0);
            let cache_read = usage.cache_read_input_tokens.unwrap_or(0);
            let cache_creation = usage.cache_creation_input_tokens.unwrap_or(0);

            // Skip empty-usage entries (some transcript variants emit
            // partial assistant rows during streaming; the final row
            // for the same message id has the real numbers).
            if input == 0 && output == 0 && cache_read == 0 && cache_creation == 0 {
                continue;
            }

            rows.push(UsageRow {
                ts_ms,
                model: msg.model,
                input,
                output,
                cache_read,
                cache_creation,
            });
        }
    }

    // Aggregate transcript rows ONLY when we have any. The cache-file
    // path below runs unconditionally — even with zero transcript rows
    // we still want the pill to appear if the status-line capture hook
    // wrote real data within the freshness window. This was the bug
    // that hid the pill the moment the user hit a quiet stretch in
    // their JSONL (e.g. Claude was idle but the hook kept reporting).
    if !rows.is_empty() {
        // Walk chronologically and find the start of the CURRENT session.
        // Anthropic's "session" is a 5h timer anchored on the first message
        // after the previous session expired. So we scan forward, and each
        // time the next message lands more than 5h after the current
        // session anchor, we treat that message as a new anchor.
        rows.sort_by_key(|r| r.ts_ms);
        let mut session_start_ms = rows[0].ts_ms;
        for r in &rows {
            if r.ts_ms - session_start_ms > WINDOW_MS {
                session_start_ms = r.ts_ms;
            }
        }

        // Aggregate ONLY rows in the current session: ts >= session_start
        // AND ts < session_start + 5h. (Future-dated rows shouldn't exist
        // but we guard the upper bound for safety.)
        let session_end_ms = session_start_ms + WINDOW_MS;
        for r in rows.iter().filter(|r| r.ts_ms >= session_start_ms && r.ts_ms < session_end_ms) {
            status.message_count += 1;
            status.total_input_tokens += r.input;
            status.total_output_tokens += r.output;
            status.total_cache_read_tokens += r.cache_read;
            status.total_cache_creation_tokens += r.cache_creation;
            if let Some(model) = &r.model {
                let entry = status.by_model.entry(model.clone()).or_default();
                entry.messages += 1;
                entry.input_tokens += r.input;
                entry.output_tokens += r.output;
                entry.cache_read_tokens += r.cache_read;
                entry.cache_creation_tokens += r.cache_creation;
            }
        }

        if status.message_count > 0 {
            status.active = true;
            status.window_start_ms = Some(session_start_ms);
            status.window_ends_ms = Some(session_end_ms);
        }
    }

    // Layer in the REAL rate-limit numbers when the user has installed
    // the status-line capture hook. These come straight from Anthropic
    // (Claude Code feeds them to the statusLine command), so they
    // exactly match what claude.ai's settings page shows.
    if let Some(home) = dirs::home_dir() {
        let cache = home.join(".claude").join("cache").join("gli-usage.json");
        // Skip the read entirely once the breaker is tripped — same
        // App Data popup risk as the transcript scan above.
        let read_result = if is_app_data_blocked() {
            Err(std::io::Error::from(ErrorKind::PermissionDenied))
        } else {
            fs::read(&cache).map_err(|e| {
                if e.kind() != ErrorKind::NotFound {
                    note_app_data_error(&e, &cache);
                }
                e
            })
        };
        if let Ok(bytes) = read_result {
            if let Ok(c) = serde_json::from_slice::<CapturedUsage>(&bytes) {
                // Some capture scripts (older versions, or the one
                // Claude installs by default) write the rate-limit
                // body without a `captured_at_ms` field. Fall back to
                // the file's mtime so the frontend's freshness check
                // still has a timestamp to compare against — without
                // this, a perfectly good cache file with a real %
                // value reads as "stale" and the pill stays hidden.
                let mtime_ms = fs::metadata(&cache)
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64);
                status.real_captured_at_ms = c.captured_at_ms.or(mtime_ms);
                if let Some(rl) = c.rate_limits {
                    if let Some(fh) = rl.five_hour {
                        status.real_five_hour_percent = fh.used_percentage;
                        // resets_at is epoch SECONDS in the schema; convert.
                        status.real_five_hour_resets_ms = fh.resets_at.map(|s| s * 1000);
                    }
                    if let Some(sd) = rl.seven_day {
                        status.real_seven_day_percent = sd.used_percentage;
                    }
                }
                // If the real anchor is present, override the
                // transcript-derived window with it. The pill should
                // tick down to the actual reset time, not our guess.
                if let Some(resets_ms) = status.real_five_hour_resets_ms {
                    status.window_ends_ms = Some(resets_ms);
                    status.window_start_ms = Some(resets_ms - WINDOW_MS);
                    // We have data → pill should show even if no
                    // assistant messages happened to be in our scan
                    // (e.g. user just installed the capture hook).
                    status.active = true;
                }
            }
        }
    }

    Ok(status)
}

/// Walk `~/.claude/projects/<*>/<*>.jsonl` and return only files whose
/// mtime is within the window. Older sessions can't contribute to
/// "last 5h" usage, so skipping them avoids parsing megabytes of
/// historical transcripts on every poll.
fn collect_transcript_files(root: &PathBuf, cutoff_ms: i64) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let top = match fs::read_dir(root) {
        Ok(it) => it,
        Err(e) => {
            note_app_data_error(&e, root);
            return out;
        }
    };
    for entry in top.flatten() {
        if is_app_data_blocked() {
            break;
        }
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let inner = match fs::read_dir(&p) {
            Ok(it) => it,
            Err(e) => {
                note_app_data_error(&e, &p);
                continue;
            }
        };
        for f in inner.flatten() {
            let path = f.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            if let Ok(meta) = f.metadata() {
                if let Ok(mtime) = meta.modified() {
                    if let Ok(d) = mtime.duration_since(UNIX_EPOCH) {
                        if (d.as_millis() as i64) < cutoff_ms {
                            // File hasn't been touched in 5h — every
                            // assistant message inside is older than
                            // the window. Skip without opening.
                            continue;
                        }
                    }
                }
            }
            out.push(path);
        }
    }
    out
}

/// Convert an ISO-8601 UTC timestamp ("2026-04-28T01:16:32.435Z") to
/// epoch millis without pulling in `chrono`. Tolerant of either Z or
/// offset suffix; we strip non-digits manually after the date components.
fn parse_iso_to_ms(s: &str) -> Option<i64> {
    // Parse YYYY-MM-DDTHH:MM:SS.mmm
    let bytes = s.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    let second: i64 = s.get(17..19)?.parse().ok()?;
    let millis: i64 = if bytes.len() >= 23 && bytes[19] == b'.' {
        s.get(20..23)?.parse().ok()?
    } else {
        0
    };
    let days = days_from_civil(year, month as u32, day as u32);
    let total_secs = days * 86_400 + hour * 3600 + minute * 60 + second;
    Some(total_secs * 1000 + millis)
}

/// Howard Hinnant's days_from_civil (Public Domain) — converts a UTC
/// Y-M-D to days since 1970-01-01. Avoids a chrono dependency for
/// what's essentially a flat ISO parse.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = (y - era * 400) as u64;
    let m_adj = if m > 2 { m - 3 } else { m + 9 } as u64;
    let doy = (153 * m_adj + 2) / 5 + (d as u64 - 1);
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i64 - 719_468
}

/// One conversational turn extracted from the transcript. We keep
/// just enough text to build a useful summary prompt — full assistant
/// responses can be many KB; we cap each turn so the LLM call stays
/// cheap and fast.
#[derive(Clone, Debug)]
struct Turn {
    role: &'static str, // "user" or "assistant"
    uuid: String,
    text: String,
}

/// In-memory cache for the natural-language summary, keyed by the
/// transcript-file path. We reuse the cached summary as long as the
/// "fingerprint" of recent turns hasn't changed — that's the uuid of
/// the latest user turn AND the latest assistant turn. Both being
/// stable means no new exchange has landed since we last summarized,
/// so there's nothing for Gemini to update. This is what lets the
/// frontend poll on a 4s cadence without lighting up the API.
#[derive(Clone)]
struct CachedSummary {
    user_uuid: String,
    assistant_uuid: String,
    summary: String,
}

fn summary_cache() -> &'static Mutex<HashMap<String, CachedSummary>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedSummary>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve `~/.claude/projects/<encoded-cwd>/` for `project_cwd`. The
/// encoding rule is "every `/` becomes `-`" — same as Claude Code's
/// internal one. Returns `None` for an empty cwd, missing home dir,
/// or a transcript dir that doesn't exist yet.
fn transcript_dir_for(project_cwd: &str) -> Option<PathBuf> {
    if project_cwd.is_empty() {
        return None;
    }
    let encoded = project_cwd.replace('/', "-");
    let dir = dirs::home_dir()?.join(".claude").join("projects").join(&encoded);
    if !dir.exists() {
        return None;
    }
    Some(dir)
}

/// Pick the most-recently-modified .jsonl in a transcript dir. Claude
/// appends to the active session live, so mtime is the right proxy
/// for "which session is the user currently in".
fn latest_transcript_in(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        if best.as_ref().map_or(true, |(t, _)| mtime > *t) {
            best = Some((mtime, path));
        }
    }
    best.map(|(_, p)| p)
}

/// Quick "is Claude actively working in this worktree" check, used to
/// drive the sidebar / tab-strip spinner. Source of truth: the mtime of
/// Claude's transcript file. Each turn, tool-call, and tool-result
/// gets appended as a new line — so mtime advances exactly when Claude
/// is processing. Between turns / while sitting at the prompt waiting
/// for user input, mtime stays put.
///
/// This replaces the byte-rate heuristic in term.rs, which was
/// fundamentally ambiguous (couldn't distinguish shell banner output,
/// window resize repaints, or sub-process noise from actual agent
/// work). Transcript mtime is the same signal Anthropic's own UI
/// uses internally; it's the most authoritative answer to "is the
/// agent doing something right now" that exists outside Claude.
#[derive(Debug, Serialize)]
pub struct ClaudeActiveStatus {
    pub active: bool,
    /// Milliseconds since the transcript file was last modified.
    /// `None` if no transcript exists for this worktree yet.
    pub ms_since_activity: Option<u64>,
}

/// How recent must the transcript mtime be for us to consider Claude
/// actively working? 1500 ms is generous enough to span the gap
/// between an assistant text turn and the subsequent tool-use line
/// (which can take ~200–800 ms while the SDK decides) without
/// blinking the spinner off mid-conversation. Anything older is
/// either between user turns or a finished session.
const CLAUDE_ACTIVE_WINDOW_MS: u64 = 1500;

#[tauri::command]
pub fn claude_active_status(project_cwd: String) -> ClaudeActiveStatus {
    let Some(dir) = transcript_dir_for(&project_cwd) else {
        return ClaudeActiveStatus { active: false, ms_since_activity: None };
    };
    let Some(path) = latest_transcript_in(&dir) else {
        return ClaudeActiveStatus { active: false, ms_since_activity: None };
    };
    let Ok(meta) = fs::metadata(&path) else {
        return ClaudeActiveStatus { active: false, ms_since_activity: None };
    };
    let Ok(mtime) = meta.modified() else {
        return ClaudeActiveStatus { active: false, ms_since_activity: None };
    };
    let now = SystemTime::now();
    let elapsed_ms = now
        .duration_since(mtime)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    ClaudeActiveStatus {
        active: elapsed_ms < CLAUDE_ACTIVE_WINDOW_MS,
        ms_since_activity: Some(elapsed_ms),
    }
}

/// Walk the transcript and pull out the last `n_user` user prompts
/// plus all assistant turns interleaved with them.
///
/// We deliberately skip:
///   - `type:"user"` rows whose `message.content` is an ARRAY (those are
///     tool-result echoes, not what the user typed).
///   - Slash commands and bracketed-paste system messages (start with
///     `/` or `<`).
///   - Assistant tool-use blocks (we keep just the `text` blocks — what
///     the assistant actually said in chat, not which tools it called).
fn read_recent_turns(path: &Path, n_user: usize) -> Result<Vec<Turn>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut all: Vec<Turn> = Vec::new();
    for line in reader.lines() {
        let Ok(raw) = line else { continue };
        if raw.is_empty() {
            continue;
        }
        let parsed: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let line_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let uuid = parsed
            .get("uuid")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if line_type == "user" {
            // Real prompts have content as a string; tool results are arrays.
            let Some(s) = parsed
                .pointer("/message/content")
                .and_then(|v| v.as_str())
            else {
                continue;
            };
            let trimmed = s.trim();
            if trimmed.is_empty() || trimmed.starts_with('<') || trimmed.starts_with('/') {
                continue;
            }
            all.push(Turn {
                role: "user",
                uuid,
                text: cap_inline(trimmed, 600),
            });
        } else if line_type == "assistant" {
            let Some(content) = parsed
                .pointer("/message/content")
                .and_then(|v| v.as_array())
            else {
                continue;
            };
            let mut texts: Vec<&str> = Vec::new();
            for block in content {
                if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                    if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                        let t = t.trim();
                        if !t.is_empty() {
                            texts.push(t);
                        }
                    }
                }
            }
            if texts.is_empty() {
                continue;
            }
            let combined = texts.join(" ");
            all.push(Turn {
                role: "assistant",
                uuid,
                text: cap_inline(&combined, 600),
            });
        }
    }
    // Trim to last `n_user` user turns + every assistant turn that
    // sits between or after them.
    let mut user_seen = 0;
    let mut keep_from = all.len();
    for (i, t) in all.iter().enumerate().rev() {
        if t.role == "user" {
            user_seen += 1;
            keep_from = i;
            if user_seen >= n_user {
                break;
            }
        }
    }
    Ok(all.split_off(keep_from))
}

/// Collapse internal whitespace and cap to `max` chars. The transcript
/// can contain newlines, tabs, and (rarely) control bytes — we want a
/// single-line snippet that reads cleanly when stuffed into a prompt.
fn cap_inline(s: &str, max: usize) -> String {
    let normalized: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() > max {
        let mut out: String = normalized.chars().take(max).collect();
        out.push('…');
        out
    } else {
        normalized
    }
}

/// Strip chatty preamble and trailing punctuation from Gemini's raw
/// reply so the result reads like a status line. Flash-Lite occasionally
/// wraps its answer in quotes or appends a period — both look out of
/// place in the 28px header strip.
fn normalize_summary(raw: &str) -> String {
    // Order matters: strip trailing period FIRST, in case it sits
    // outside the closing quote (`"fix oauth flow".`). Then strip the
    // quote pair. Then strip a trailing period one more time, in case
    // it was sitting INSIDE the quotes (`"fix oauth flow."`). Either
    // shape shows up in Flash-Lite output and we want both to land on
    // the same result.
    let mut s = raw.trim().trim_end_matches('.').trim().to_string();
    if (s.starts_with('"') && s.ends_with('"'))
        || (s.starts_with('\'') && s.ends_with('\''))
    {
        s = s[1..s.len() - 1].to_string();
    }
    let trimmed = s.trim().trim_end_matches('.').trim();
    cap_inline(trimmed, 80)
}

/// Natural-language summary of what the user is working on inside
/// claude / codex / aider, generated by Gemini Flash-Lite from the
/// last 3 user prompts + the assistant's text replies between them.
///
/// Cached in-memory keyed by transcript path; the cache invalidates
/// when either the latest user-turn uuid or the latest assistant-turn
/// uuid changes (i.e. a new turn has actually been written). Polling
/// at 4s from the frontend therefore costs ONE Gemini call per real
/// exchange, not one per poll.
///
/// Falls back gracefully:
///   - No transcript dir / no jsonl → `Ok(None)`. Frontend uses
///     `activeCommand` ("claude") as the subtitle.
///   - No Gemini key configured / API error → returns the most recent
///     user prompt verbatim. Still better than just "claude".
#[tauri::command]
pub async fn claude_activity_summary(
    project_cwd: String,
    cli: Option<String>,
) -> Result<Option<String>, String> {
    let Some(dir) = transcript_dir_for(&project_cwd) else {
        return Ok(None);
    };
    let Some(path) = latest_transcript_in(&dir) else {
        return Ok(None);
    };

    let turns = read_recent_turns(&path, 3)?;
    if turns.is_empty() {
        return Ok(None);
    }

    // Cache fingerprint = latest user uuid + latest assistant uuid. If
    // both still match, nothing new has landed in the transcript and
    // the cached summary is still accurate.
    let path_key = path.to_string_lossy().to_string();
    let latest_user_uuid = turns
        .iter()
        .rev()
        .find(|t| t.role == "user")
        .map(|t| t.uuid.clone())
        .unwrap_or_default();
    let latest_assistant_uuid = turns
        .iter()
        .rev()
        .find(|t| t.role == "assistant")
        .map(|t| t.uuid.clone())
        .unwrap_or_default();
    if let Some(cached) = summary_cache().lock().unwrap().get(&path_key).cloned() {
        if cached.user_uuid == latest_user_uuid
            && cached.assistant_uuid == latest_assistant_uuid
        {
            return Ok(Some(cached.summary));
        }
    }

    // Fallback used when the helper CLI isn't reachable: the most recent
    // real user prompt verbatim. Always populated when we have any turns.
    let fallback = turns
        .iter()
        .rev()
        .find(|t| t.role == "user")
        .map(|t| cap_inline(&t.text, 80))
        .unwrap_or_default();

    let summary = match summarize_with_helper(&cli.unwrap_or_else(|| "claude".to_string()), &turns).await {
        Ok(s) => s,
        Err(_) => fallback.clone(),
    };

    summary_cache().lock().unwrap().insert(
        path_key,
        CachedSummary {
            user_uuid: latest_user_uuid,
            assistant_uuid: latest_assistant_uuid,
            summary: summary.clone(),
        },
    );
    Ok(Some(summary))
}

/// Ask the helper agent to compress recent turns into a single short
/// activity summary. CLI defaults to "claude" but can be any of our
/// supported agents.
async fn summarize_with_helper(cli: &str, turns: &[Turn]) -> Result<String, String> {
    let mut convo = String::new();
    for t in turns {
        convo.push_str(&format!("[{}]\n{}\n\n", t.role.to_uppercase(), t.text));
    }
    let prompt = format!(
        "Recent turns from a Claude Code session in a developer's terminal:\n\n\
         {convo}\
         Summarize what the developer is currently working on. One short \
         phrase, 8 words or fewer, sentence case, no trailing period, no \
         quotes. Use an active verb. Be specific about the task — not \
         \"working on code\".",
    );
    let raw = run_inline("", cli, HelperMode::Summary, &prompt, None).await?;
    Ok(normalize_summary(&raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_iso_with_millis() {
        // 2026-04-28T01:16:32.435Z → 20571 days × 86400000 ms/day
        // + 4592s × 1000 + 435 = 1_777_338_992_435.
        let ms = parse_iso_to_ms("2026-04-28T01:16:32.435Z").unwrap();
        assert_eq!(ms, 1_777_338_992_435);
    }

    #[test]
    fn parses_iso_without_millis() {
        let ms = parse_iso_to_ms("2026-04-28T01:16:32Z").unwrap();
        assert_eq!(ms, 1_777_338_992_000);
    }

    #[test]
    fn epoch_zero_roundtrip() {
        // 1970-01-01T00:00:00Z is day 0 → ms 0. Anchors the math.
        assert_eq!(parse_iso_to_ms("1970-01-01T00:00:00Z").unwrap(), 0);
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_iso_to_ms("not a date").is_none());
        assert!(parse_iso_to_ms("").is_none());
    }

    #[test]
    fn empty_state_when_no_projects_dir() {
        // We can't easily mock `~/.claude/projects` without a temp
        // env var indirection; this test just confirms the public
        // shape is sane. Real behaviour is exercised at runtime.
        let s = ClaudeUsageStatus::default();
        assert!(!s.active);
        assert_eq!(s.message_count, 0);
        assert_eq!(s.total_input_tokens, 0);
    }

    #[test]
    fn cap_inline_collapses_whitespace_and_caps() {
        let out = cap_inline("  hello\n\nworld\t  again  ", 100);
        assert_eq!(out, "hello world again");
    }

    #[test]
    fn cap_inline_truncates_with_ellipsis() {
        let s = "x".repeat(120);
        let out = cap_inline(&s, 50);
        // Keeps `max` chars + the ellipsis sentinel — caller renders
        // the … so they know it's truncated.
        let chars: Vec<char> = out.chars().collect();
        assert_eq!(chars.len(), 51);
        assert_eq!(chars[50], '…');
    }

    #[test]
    fn normalize_summary_strips_quotes_and_trailing_period() {
        assert_eq!(normalize_summary("\"fix oauth flow\"."), "fix oauth flow");
        assert_eq!(normalize_summary("'wire up oscillator'"), "wire up oscillator");
        assert_eq!(normalize_summary("  refactor.  "), "refactor");
    }

    #[test]
    fn read_recent_turns_filters_tool_results_and_keeps_text_blocks() {
        // Build a fake transcript with: prompt, assistant-text+tool_use,
        // tool-result (user/array), prompt, assistant-text. Should
        // return the two prompts + two assistant text turns; the
        // tool-result row is dropped.
        let dir = std::env::temp_dir().join(format!(
            "rli-claude-usage-test-{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("session.jsonl");
        let lines = [
            r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"first prompt"}}"#,
            r#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"sure thing"},{"type":"tool_use","name":"Bash"}]}}"#,
            r#"{"type":"user","uuid":"u2","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}"#,
            r#"{"type":"user","uuid":"u3","message":{"role":"user","content":"second prompt"}}"#,
            r#"{"type":"assistant","uuid":"a2","message":{"content":[{"type":"text","text":"done"}]}}"#,
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();

        let turns = read_recent_turns(&path, 3).unwrap();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);

        let roles: Vec<&str> = turns.iter().map(|t| t.role).collect();
        let texts: Vec<&str> = turns.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(roles, vec!["user", "assistant", "user", "assistant"]);
        assert_eq!(texts, vec!["first prompt", "sure thing", "second prompt", "done"]);
    }

    #[test]
    fn read_recent_turns_skips_slash_commands_and_system_blocks() {
        let dir = std::env::temp_dir().join(format!(
            "rli-claude-usage-test-skip-{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("session.jsonl");
        let lines = [
            r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"/help"}}"#,
            r#"{"type":"user","uuid":"u2","message":{"role":"user","content":"<system-reminder>nope</system-reminder>"}}"#,
            r#"{"type":"user","uuid":"u3","message":{"role":"user","content":"the real one"}}"#,
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();

        let turns = read_recent_turns(&path, 3).unwrap();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);

        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].text, "the real one");
    }
}
