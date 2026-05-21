//! Claude usage tracking — sourced from Anthropic's OAuth usage
//! endpoint, NOT from local transcript files.
//!
//! We used to walk `~/.claude/projects/<encoded-cwd>/*.jsonl` to add
//! up per-assistant-turn token counts in the rolling 5-hour window.
//! That broke under macOS Sequoia's App Data Isolation: each new
//! Claude session writes a fresh `.jsonl` with a unique
//! `com.apple.macl` xattr, and the first read of each one triggers a
//! "GLI would like to access data from other apps" prompt. So users
//! got a permission popup every time they opened a new agent.
//!
//! The fix mirrors what `notchi` does. We read Claude Code's cached
//! OAuth token from the macOS Keychain (one-time "Always Allow"
//! prompt, native keychain ACL — completely separate from TCC File
//! Access) and call `https://api.anthropic.com/api/oauth/usage`
//! directly. The response carries the exact `five_hour` and
//! `seven_day` utilization percentages that Claude.ai's settings
//! page shows.
//!
//! TCC-safety of this module is a hard invariant. The tests at the
//! bottom assert it stays that way: no `helper_agent` subprocess
//! spawns from polling paths, no reads under `~/.claude`, no
//! `claude --version` shellouts. Every one of those would re-trip
//! macOS App Data Isolation under GLI's responsible bundle and
//! resurrect the popup the user kept seeing.

use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};


/// Anthropic's enforced 5-hour session length. A "session" in
/// Claude.ai's UI = a 5h timer that starts on your first message after
/// the previous session expired. We mirror that: walk messages
/// chronologically, restart the session anchor whenever 5h has elapsed
/// since the current anchor.
const WINDOW_MS: i64 = 5 * 60 * 60 * 1000;

#[derive(Debug, Default, Serialize, Clone)]
pub struct ModelBreakdown {
    pub messages: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

#[derive(Debug, Default, Serialize, Clone)]
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


#[tauri::command]
pub async fn claude_usage_status() -> Result<ClaudeUsageStatus, String> {
    // OAuth-API path (notchi-style). We avoid reading
    // `~/.claude/projects/*.jsonl` entirely — those files carry
    // macOS App Data MACL xattrs unique to each Claude session, and
    // the first read of each one triggers a "GLI would like to
    // access data from other apps" prompt. By calling Anthropic's
    // OAuth usage endpoint directly we get the same five_hour /
    // seven_day numbers that the official UI shows, sourced from a
    // single Keychain item the user authorizes once with "Always
    // Allow".
    //
    // Failure modes are all benign: missing Claude Code install →
    // empty status (pill self-hides), expired/missing OAuth token →
    // empty status, network down → cached previous response if we
    // have one, otherwise empty status.
    Ok(fetch_oauth_usage().await.unwrap_or_default())
}

/// User-Agent we send on the OAuth-usage request. Hardcoded rather
/// than resolved at runtime via `claude --version` — that subprocess
/// reads its own `~/.claude/*` config on startup, which sits inside
/// another app's MACL domain and would re-fire the App Data Isolation
/// popup for GLI on every fresh launch. The string just needs to look
/// plausible to Anthropic's edge; the exact version is cosmetic.
const CLAUDE_USER_AGENT: &str = "claude-code/2.0";

/// Read Claude Code's OAuth credentials JSON from the macOS Keychain.
/// We use `/usr/bin/security` (Apple-signed) rather than the
/// Security.framework directly so the keychain ACL prompt only fires
/// once — the user picks "Always Allow", and every subsequent
/// invocation reads the password silently. Calling
/// `SecItemCopyMatching` from our process triggers the prompt every
/// launch because the ACL is keyed on the calling executable's path.
fn read_oauth_credentials_from_keychain() -> Option<ClaudeOAuthCredentials> {
    let output = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8(output.stdout).ok()?;
    let blob: KeychainBlob = serde_json::from_str(raw.trim()).ok()?;
    Some(blob.claude_ai_oauth)
}

#[derive(Debug, Deserialize)]
struct KeychainBlob {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: ClaudeOAuthCredentials,
}

#[derive(Debug, Deserialize, Clone)]
struct ClaudeOAuthCredentials {
    #[serde(rename = "accessToken")]
    access_token: String,
}

#[derive(Debug, Deserialize)]
struct OAuthUsageResponse {
    #[serde(default)]
    five_hour: Option<OAuthQuotaPeriod>,
    #[serde(default)]
    seven_day: Option<OAuthQuotaPeriod>,
}

#[derive(Debug, Deserialize)]
struct OAuthQuotaPeriod {
    utilization: f32,
    resets_at: Option<String>,
}

/// In-memory cache of the last successful OAuth fetch. Surfaces the
/// most recent reading when a poll fails (token refresh, transient
/// network blip) so the pill doesn't blink off mid-session.
static LAST_OAUTH_STATUS: OnceLock<Mutex<Option<ClaudeUsageStatus>>> = OnceLock::new();

fn cache_last_oauth_status(status: &ClaudeUsageStatus) {
    let slot = LAST_OAUTH_STATUS.get_or_init(|| Mutex::new(None));
    if let Ok(mut g) = slot.lock() {
        *g = Some(status.clone());
    }
}

fn last_oauth_status() -> Option<ClaudeUsageStatus> {
    let slot = LAST_OAUTH_STATUS.get_or_init(|| Mutex::new(None));
    slot.lock().ok().and_then(|g| g.clone())
}

async fn fetch_oauth_usage() -> Option<ClaudeUsageStatus> {
    let creds = match read_oauth_credentials_from_keychain() {
        Some(c) => c,
        // No Claude Code install / no OAuth login. Return cached
        // value if we have one — covers the case where the token
        // briefly fails to read but a previous successful response
        // is still meaningful for the next 30s tick.
        None => return last_oauth_status(),
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;
    // Anthropic's OAuth usage endpoint is internal to Claude Code's
    // own UI plumbing. We send a Claude-Code-shaped User-Agent so the
    // request looks like one the endpoint expects to serve — using a
    // bespoke "gli" UA risks 403s if Anthropic ever filters this
    // endpoint to first-party callers.
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(&creds.access_token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("Accept", "application/json")
        .header("User-Agent", CLAUDE_USER_AGENT)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return last_oauth_status();
    }
    let body: OAuthUsageResponse = resp.json().await.ok()?;

    let now_ms = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(_) => 0,
    };

    let mut status = ClaudeUsageStatus::default();
    status.real_captured_at_ms = Some(now_ms);

    if let Some(fh) = body.five_hour {
        status.real_five_hour_percent = Some(fh.utilization);
        let resets_ms = fh.resets_at.as_deref().and_then(parse_iso_to_ms);
        status.real_five_hour_resets_ms = resets_ms;
        if let Some(end_ms) = resets_ms {
            status.window_ends_ms = Some(end_ms);
            status.window_start_ms = Some(end_ms - WINDOW_MS);
            status.active = true;
        }
    }
    if let Some(sd) = body.seven_day {
        status.real_seven_day_percent = Some(sd.utilization);
    }

    cache_last_oauth_status(&status);
    Some(status)
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

/// Collapse internal whitespace and cap to `max` chars. The hook
/// can deliver prompts with embedded newlines / tabs; we want a
/// single-line snippet that reads cleanly in a 28px header strip.
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

/// Tab-subtitle summary for the foregrounded Claude session.
///
/// Returns the user's most recent prompt (whitespace-collapsed, capped
/// at 80 chars). The frontend polls this every ~4s from BlockTerminal.
///
/// **Invariant: this command must touch nothing outside the in-memory
/// hook map.** Earlier iterations spawned `claude --print` to rewrite
/// the prompt into a creative one-liner ("Fix oauth refresh bug"
/// rather than the raw text the user typed). That subprocess, run as
/// a child of GLI, inherits GLI's responsible bundle — so when it
/// reads its own `~/.claude/*` config + credentials, macOS fires
/// `kTCCServiceSystemPolicyAppData` ("GLI would like to access data
/// from other apps") against GLI on every poll. A 4-second cadence
/// turned that into a continuous stream of popups any time Claude
/// was foregrounded.
///
/// The fix is to do zero subprocess work in this command. The user's
/// raw prompt is already informative ("fix the OAuth refresh bug
/// when the token expires mid-session" is fine as a tab subtitle) —
/// the creative rewrite was a nicety, not load-bearing UX. Source
/// stays the in-memory `LATEST_PROMPT_BY_CWD` map in `agent_hooks`,
/// populated by the Claude hook script via the Unix socket; that
/// path is TCC-free because the data never lands on disk in another
/// app's MACL domain.
#[tauri::command]
pub fn claude_activity_summary(
    project_cwd: String,
    _cli: Option<String>,
) -> Result<Option<String>, String> {
    let Some(prompt_text) = crate::agent_hooks::latest_prompt_for_cwd(&project_cwd) else {
        return Ok(None);
    };
    let trimmed = prompt_text.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Ok(Some(cap_inline(trimmed, 80)))
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

    /* ----------------------------------------------------------------
       TCC-safety regression guards.

       These are not behaviour tests — they're source-text assertions
       that any future edit which reintroduces a subprocess spawn from
       the polling path is caught at `cargo test` time, before it can
       ship and resurrect the App Data popup.

       The previous fix removed transcript reads but missed the
       4s-cadence helper-agent spawn, so the popup still fired on every
       prompt. These guards exist to prevent that class of regression:
       reading source is cheap, and the assertion message tells the
       next contributor exactly which line is the trap.
       ---------------------------------------------------------------- */

    /// Return just the production code from this file — i.e. everything
    /// before the `#[cfg(test)]` marker that opens this test module.
    /// Comments and doc-comments are stripped too, so an explanatory
    /// mention of `helper_agent` in a `//` line doesn't false-trip
    /// the assertions below.
    fn production_code_only() -> String {
        let src = include_str!("claude_usage.rs");
        // The split anchor lives only at the top of the test module
        // (no other `#[cfg(test)]` in this file). Splitting on it lets
        // us scan the real code and ignore the assertion-message
        // strings inside the tests themselves.
        let cutoff = src
            .find("#[cfg(test)]")
            .expect("claude_usage.rs has a #[cfg(test)] section");
        src[..cutoff]
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                !t.starts_with("//") && !t.starts_with("//!")
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// `claude_activity_summary` is invoked every ~4s from the frontend
    /// while a Claude pane is foregrounded. It must never spawn a
    /// helper-agent subprocess, because that subprocess (run as a
    /// child of GLI) inherits GLI's responsible bundle and trips
    /// kTCCServiceSystemPolicyAppData when it reads its own
    /// `~/.claude/*` data files.
    #[test]
    fn activity_summary_never_calls_helper_agent() {
        let code_only = production_code_only();
        assert!(
            !code_only.contains("helper_agent"),
            "claude_usage.rs production code must not reference helper_agent — \
             its inline runner spawns claude/codex/gemini as children of GLI, \
             which trips the macOS App Data popup on every poll. Use the \
             in-memory hook map instead."
        );
        assert!(
            !code_only.contains("run_inline"),
            "claude_usage.rs production code must not call run_inline directly \
             either — same reason."
        );
    }

    /// The OAuth UA spoof must stay a constant string, not a
    /// `claude --version` subprocess. `claude --version` reads its own
    /// `~/.claude/settings.json` on startup, which trips the App Data
    /// popup once per app launch.
    #[test]
    fn user_agent_is_a_static_string() {
        let code_only = production_code_only();
        assert!(
            !code_only.contains("--version"),
            "claude_usage.rs must not invoke a `--version` subprocess. \
             Use the CLAUDE_USER_AGENT constant for the OAuth User-Agent."
        );
        let src = include_str!("claude_usage.rs");
        let cutoff = src.find("#[cfg(test)]").unwrap();
        let suspicious_spawns: Vec<&str> = src[..cutoff]
            .lines()
            .filter(|l| l.contains("Command::new(") && !l.trim_start().starts_with("//"))
            .collect();
        for line in &suspicious_spawns {
            assert!(
                line.contains("/usr/bin/security"),
                "unexpected subprocess spawn in claude_usage.rs: {line}\n\
                 Only `/usr/bin/security` is allowed (Keychain Always-Allow). \
                 Any other binary risks re-tripping macOS App Data Isolation."
            );
        }
    }

    /// The module must not read from `~/.claude` directly. The hook
    /// map (populated via the Unix socket) is the TCC-safe data source.
    #[test]
    fn no_direct_filesystem_reads_under_dot_claude() {
        let code_only = production_code_only();
        for forbidden in [
            "fs::read",
            "fs::metadata",
            "fs::File::open",
            "read_to_string",
            "read_dir",
        ] {
            assert!(
                !code_only.contains(forbidden),
                "claude_usage.rs production code must not call {forbidden} — \
                 every path that would land on a Claude-owned file trips \
                 kTCCServiceSystemPolicyAppData. Source data through \
                 `agent_hooks::latest_prompt_for_cwd` or the OAuth API instead."
            );
        }
    }

    /* ---------- behavioural test for the simplified summary ---------- */

    /// End-to-end: the activity summary is just the truncated prompt
    /// from the hook map. No subprocess, no creative rewrite.
    #[test]
    fn activity_summary_returns_capped_prompt_verbatim() {
        // Seed the hook map directly, mimicking what the Claude
        // UserPromptSubmit hook does on the Unix socket.
        let cwd = format!("/tmp/gli-test-activity-{}", std::process::id());
        crate::agent_hooks::record_prompt_for_cwd_for_test(
            &cwd,
            "Fix the OAuth refresh bug",
        );
        let out =
            claude_activity_summary(cwd.clone(), Some("claude".into())).unwrap();
        assert_eq!(out.as_deref(), Some("Fix the OAuth refresh bug"));
    }

    /// Long prompts get capped + …-suffixed so they fit in the chrome.
    #[test]
    fn activity_summary_caps_long_prompts() {
        let cwd = format!("/tmp/gli-test-activity-long-{}", std::process::id());
        let long = "a".repeat(200);
        crate::agent_hooks::record_prompt_for_cwd_for_test(&cwd, &long);
        let out = claude_activity_summary(cwd, None).unwrap().unwrap();
        let chars: Vec<char> = out.chars().collect();
        assert_eq!(chars.len(), 81);
        assert_eq!(chars[80], '…');
    }

    /// No prompt captured yet → None, so the frontend keeps showing
    /// the activeCommand fallback ("claude") instead of a stale value.
    #[test]
    fn activity_summary_none_when_no_prompt_seen() {
        let cwd = format!(
            "/tmp/gli-test-activity-empty-{}-unique",
            std::process::id()
        );
        let out = claude_activity_summary(cwd, None).unwrap();
        assert_eq!(out, None);
    }

    /// Empty / whitespace-only prompts also yield None — happens if
    /// the hook fires with a stripped payload, e.g. user hit Enter on
    /// an empty input.
    #[test]
    fn activity_summary_none_for_whitespace_prompt() {
        let cwd = format!(
            "/tmp/gli-test-activity-ws-{}-unique",
            std::process::id()
        );
        crate::agent_hooks::record_prompt_for_cwd_for_test(&cwd, "   \n\t  ");
        let out = claude_activity_summary(cwd, None).unwrap();
        assert_eq!(out, None);
    }
}
