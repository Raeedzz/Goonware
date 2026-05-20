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
//! The lower-cadence `claude_activity_summary` command (tab subtitle
//! summarizer) still reads transcripts since there's no API
//! equivalent for "what is the user currently working on" — that's
//! covered by the existing `autoSummarize` setting users can switch
//! off if the prompts are unwelcome.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::helper_agent::{run_inline, HelperMode};


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

/// Cache the resolved `claude --version` output so we don't fork a
/// subprocess on every poll. The version is stable for the lifetime
/// of the GLI process (a `claude` upgrade in between would just
/// produce a slightly-stale UA string, which is benign).
static CLAUDE_USER_AGENT: OnceLock<Option<String>> = OnceLock::new();

fn resolve_claude_user_agent() -> Option<String> {
    CLAUDE_USER_AGENT
        .get_or_init(|| {
            // Try the conventional install paths in priority order.
            // PATH is unreliable inside Tauri (the launched binary
            // doesn't inherit a login shell's PATH), so we probe the
            // common locations explicitly.
            let home = dirs::home_dir()?;
            let candidates = [
                home.join(".local/bin/claude"),
                PathBuf::from("/opt/homebrew/bin/claude"),
                PathBuf::from("/usr/local/bin/claude"),
            ];
            for c in candidates.iter() {
                let Ok(output) = Command::new(c)
                    .arg("--version")
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .output()
                else {
                    continue;
                };
                if !output.status.success() {
                    continue;
                }
                let raw = String::from_utf8_lossy(&output.stdout);
                // `claude --version` prints e.g. "1.0.108 (Claude Code)" —
                // grab the first whitespace-delimited token.
                let version = raw.split_whitespace().next()?.to_string();
                return Some(format!("claude-code/{version}"));
            }
            None
        })
        .clone()
}

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
    // own UI plumbing. We send the same User-Agent shape Claude Code
    // sends (resolved from the locally installed `claude` binary) so
    // the request looks identical on the wire — third-party UAs risk
    // 403s if Anthropic ever filters this endpoint.
    let user_agent = resolve_claude_user_agent().unwrap_or_else(|| "claude-code/1.0".to_string());
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(&creds.access_token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("Accept", "application/json")
        .header("User-Agent", user_agent)
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

/// In-memory cache for the natural-language summary, keyed by
/// "<cwd>:<prompt>". As long as the user hasn't submitted a new
/// prompt, the cached creative summary stays valid — so the 4s
/// frontend poll costs zero helper-CLI invocations between turns.
#[derive(Clone)]
struct CachedSummary {
    /// The exact prompt text that produced this summary. Re-checked
    /// against the live `latest_prompt_for_cwd` value on every hit.
    user_uuid: String,
    summary: String,
}

fn summary_cache() -> &'static Mutex<HashMap<String, CachedSummary>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedSummary>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
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
///   - No prompt captured yet for this cwd → `Ok(None)`. Frontend
///     uses `activeCommand` ("claude") as the subtitle.
///   - Helper CLI unreachable → returns the prompt verbatim. Still
///     more informative than just "claude".
///
/// Prompt source: the live in-memory map in `agent_hooks` that the
/// Claude hook script populates on every `UserPromptSubmit` event.
/// We used to read `~/.claude/projects/<cwd>/<session>.jsonl` here,
/// but that fired a macOS App Data Isolation popup every time
/// Claude opened a fresh session (each transcript file carries a
/// unique MACL xattr). The hook-based path runs inside Claude's
/// process tree, so the prompt forwarding is TCC-free.
#[tauri::command]
pub async fn claude_activity_summary(
    project_cwd: String,
    cli: Option<String>,
) -> Result<Option<String>, String> {
    let Some(prompt_text) = crate::agent_hooks::latest_prompt_for_cwd(&project_cwd) else {
        return Ok(None);
    };
    let trimmed = prompt_text.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    // Cache fingerprint = the prompt text itself. If the user hasn't
    // submitted a new prompt since the last summarize, the cached
    // creative summary is still accurate, so the 4s frontend poll
    // costs zero helper-CLI invocations.
    let cache_key = format!("{}:{}", project_cwd, trimmed);
    if let Some(cached) = summary_cache().lock().unwrap().get(&cache_key).cloned() {
        if cached.user_uuid == trimmed {
            return Ok(Some(cached.summary));
        }
    }

    let fallback = cap_inline(trimmed, 80);
    let cli_name = cli.unwrap_or_else(|| "claude".to_string());
    let summary = match summarize_with_helper(&cli_name, trimmed).await {
        Ok(s) if !s.is_empty() => s,
        _ => fallback.clone(),
    };

    summary_cache().lock().unwrap().insert(
        cache_key,
        CachedSummary {
            user_uuid: trimmed.to_string(),
            summary: summary.clone(),
        },
    );
    Ok(Some(summary))
}

/// Ask the helper agent to compress the user's prompt into a single
/// short activity summary. CLI defaults to "claude" but can be any
/// of our supported agents.
async fn summarize_with_helper(cli: &str, user_prompt: &str) -> Result<String, String> {
    let prompt = format!(
        "Below is the most recent prompt a developer typed into a Claude Code \
         session in their terminal:\n\n\
         [USER]\n{user_prompt}\n\n\
         Summarize what the developer is asking Claude to do. One short \
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

}
