/**
 * Real Claude usage tracking — sourced from the actual transcript
 * files Claude Code writes under `~/.claude/projects/<cwd>/<session>.jsonl`.
 *
 * The Rust side (`claude_usage::claude_usage_status`) walks those
 * files, picks every `assistant` message in the rolling 5-hour window,
 * sums tokens, and reports the OLDEST in-window timestamp as the
 * window anchor. That gives us the real reset clock (5h after the
 * first message in the window) plus actual token spend — both of
 * which the prior PTY-banner-sniff approach could only approximate.
 *
 * `detectClaude` stays around because BlockTerminal still uses it for
 * UI-mode switching ("we should hand the pane over to the agent's TUI
 * because the banner just appeared"). That's a separate concern from
 * usage budgeting.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Anthropic's published rolling-window length. Kept here only for
 *  rendering math; the backend is the source of truth for both the
 *  start anchor and the end anchor. */
export const CLAUDE_WINDOW_MS = 5 * 60 * 60 * 1000;

/**
 * Approximate per-session token budget per plan, calibrated against
 * Claude.ai's "Current session" indicator. These are the denominator
 * we use to render a real "% used" number — the API does not publish
 * exact caps, so users can override via localStorage key
 * `rli.claudePlan` (one of "pro" | "max5" | "max20"). Default is
 * Max 20x because that is the most common Max tier.
 *
 * Calibrated against a Max 20x account showing 13% used at ≈ 108M
 * total tokens (1.33h into a 5h session) — back-solving gives a
 * Max 20x budget around 830M total tokens per session. Lower tiers
 * scale 1/4 (Max 5x) and 1/20 (Pro). These are approximations; if
 * Anthropic adjusts caps the user can correct via the picker (which
 * persists their pick to localStorage so they don't see the drift
 * again on next launch).
 */
export const CLAUDE_PLAN_BUDGETS: Record<ClaudePlanTier, number> = {
  pro: 42_000_000,
  max5: 210_000_000,
  max20: 830_000_000,
};

export type ClaudePlanTier = "pro" | "max5" | "max20";

const PLAN_STORAGE_KEY = "goonware.claudePlan";

export function readClaudePlan(): ClaudePlanTier {
  try {
    const v = localStorage.getItem(PLAN_STORAGE_KEY);
    if (v === "pro" || v === "max5" || v === "max20") return v;
  } catch {
    // ignore
  }
  return "max20";
}

export function writeClaudePlan(tier: ClaudePlanTier): void {
  try {
    localStorage.setItem(PLAN_STORAGE_KEY, tier);
  } catch {
    // ignore
  }
}

const CLAUDE_MARKERS = [
  "claude code",
  "welcome to claude",
  "anthropic.com",
  "✻ welcome",
];

/**
 * Returns true when `text` contains a confident marker that Claude is
 * running in this PTY. Used by BlockTerminal for UI-mode switching —
 * NOT for usage budgeting (that's done from real transcript data).
 */
export function detectClaude(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CLAUDE_MARKERS.some((m) => lower.includes(m));
}

export interface ModelBreakdown {
  messages: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export interface ClaudeUsageStatus {
  active: boolean;
  window_start_ms: number | null;
  window_ends_ms: number | null;
  message_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  by_model: Record<string, ModelBreakdown>;
  scanned_files: number;
  /** Real % from Anthropic via the status-line capture hook. When
   *  populated this replaces the calibrated estimate. */
  real_five_hour_percent: number | null;
  real_seven_day_percent: number | null;
  real_five_hour_resets_ms: number | null;
  real_captured_at_ms: number | null;
}

/** How often we re-walk the transcript dir + re-read the captured
 *  rate-limit cache. Claude rewrites the cache file on every status-
 *  line redraw (≈ every keystroke / agent step), so a 30s cadence
 *  keeps the displayed % reasonably current without re-spawning the
 *  macOS App Data TCC popup every five seconds. (In Sequoia 15+ each
 *  ~/.claude/projects/*.jsonl carries the creator app's MACL xattr,
 *  so reading it from Goonware triggers a "would like to access data from
 *  other apps" prompt — the cadence change is half of the fix; the
 *  Rust-side circuit breaker stops the retry loop once any read
 *  fails.) The full transcript walk is bounded by the 5h lookback
 *  window so it stays cheap. */
const POLL_MS = 30_000;

/** Polling cadence once we know the backend short-circuited — there's
 *  nothing to retry every minute, and tighter cadences just keep the
 *  IPC channel warm for no benefit. */
const POLL_MS_BLOCKED = 5 * 60_000;

// ── Singleton polling store ──────────────────────────────────────
// Every `useClaudeUsage()` consumer shares one polling loop. Without
// this, each TerminalStatusBar mount (which happens on every tab
// switch since the active-tab content remounts via `key={tab.id}`)
// would kick off its own Tauri invocation + setInterval — fast in
// the abstract, but the cumulative React commit cost of every tab
// switch starting two new background loops was noticeable. With the
// singleton, the poll loop starts on the first subscriber and stays
// running for the rest of the session; tab switches just attach/
// detach a listener to the shared cache.
let storeStatus: ClaudeUsageStatus | null = null;
let pollStarted = false;
let pollTimer: number | null = null;
let consecutiveEmpty = 0;
const storeListeners = new Set<() => void>();

function ensurePolling() {
  if (pollStarted) return;
  pollStarted = true;
  const pull = async () => {
    try {
      storeStatus = await invoke<ClaudeUsageStatus>("claude_usage_status");
    } catch {
      storeStatus = null;
    }
    storeListeners.forEach((fn) => fn());
    // Adaptive cadence: once the backend has repeatedly returned an
    // empty payload (the shape the Rust circuit breaker emits after a
    // permission error or a never-installed Claude), stretch out the
    // poll interval. Tight polling at that point is wasted IPC and,
    // worse, keeps macOS's per-app energy budget warm.
    const empty = !storeStatus || (!storeStatus.active && !storeStatus.real_captured_at_ms);
    consecutiveEmpty = empty ? consecutiveEmpty + 1 : 0;
    const next = consecutiveEmpty >= 3 ? POLL_MS_BLOCKED : POLL_MS;
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(pull, next);
  };
  void pull();
}

function subscribeStore(notify: () => void): () => void {
  ensurePolling();
  storeListeners.add(notify);
  return () => storeListeners.delete(notify);
}

function getStoreStatus(): ClaudeUsageStatus | null {
  return storeStatus;
}

/**
 * Subscribes to the singleton polling store. `status` only changes
 * when the underlying Tauri response changes; consumers get the
 * cached value instantly on mount instead of waiting for a fresh
 * IPC call. `now` ticks 1Hz locally so the time-remaining label
 * still updates smoothly between polls.
 */
export function useClaudeUsage(): {
  status: ClaudeUsageStatus | null;
  derived: ClaudeUsageDerived | null;
  refresh: () => void;
} {
  const status = useSyncExternalStore(
    subscribeStore,
    getStoreStatus,
    getStoreStatus,
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return {
    status,
    derived: status ? deriveStatus(status, now) : null,
    refresh: () => {
      // Forces an immediate re-pull on next render — currently
      // unused since the singleton polls on its own; kept on the
      // surface for callers that want to nudge.
    },
  };
}

export interface ClaudeUsageDerived {
  remainingMs: number;
  remainingLabel: string;
  /** Sum of (in + out + cache_read + cache_creation) — the headline
   *  number for "how much have I burned this session." */
  totalTokens: number;
  totalTokensLabel: string;
  /** 0–1 fraction used. When `realSource = true` this is Anthropic's
   *  exact reading; otherwise it's our calibrated estimate against
   *  the configured plan budget. */
  fractionUsed: number;
  /** Pre-formatted, e.g. "13%". */
  percentUsedLabel: string;
  plan: ClaudePlanTier;
  /** True when the % came from the status-line capture hook (=
   *  identical to claude.ai's reading). False = local estimate. */
  realSource: boolean;
  /** Optional 7-day usage % when the capture hook has it. */
  sevenDayPercent: number | null;
}

/**
 * Cache freshness for the captured rate-limit data. The status-line
 * fires every time Claude redraws its TUI (so essentially any user
 * action). 30 minutes is generous — anything older suggests Claude
 * Code hasn't been used recently, in which case the underlying
 * percent is still reasonable but the user should be aware. */
const REAL_FRESHNESS_MS = 30 * 60 * 1000;

function deriveStatus(s: ClaudeUsageStatus, now: number): ClaudeUsageDerived {
  const plan = readClaudePlan();
  const budget = CLAUDE_PLAN_BUDGETS[plan];

  // PREFERRED PATH: real % from Anthropic via the capture hook.
  const captureFresh =
    s.real_captured_at_ms != null &&
    now - s.real_captured_at_ms < REAL_FRESHNESS_MS;
  if (captureFresh && s.real_five_hour_percent != null) {
    const remainingMs =
      s.real_five_hour_resets_ms != null
        ? Math.max(0, s.real_five_hour_resets_ms - now)
        : s.window_ends_ms != null
          ? Math.max(0, s.window_ends_ms - now)
          : CLAUDE_WINDOW_MS;
    const totalTokens =
      s.total_input_tokens +
      s.total_output_tokens +
      s.total_cache_read_tokens +
      s.total_cache_creation_tokens;
    const fractionUsed = Math.max(0, Math.min(1, s.real_five_hour_percent / 100));
    return {
      remainingMs,
      remainingLabel: formatDuration(remainingMs),
      totalTokens,
      totalTokensLabel: formatTokenCount(totalTokens),
      fractionUsed,
      percentUsedLabel: `${Math.round(fractionUsed * 100)}%`,
      plan,
      realSource: true,
      sevenDayPercent: s.real_seven_day_percent,
    };
  }

  // FALLBACK: estimate from transcript token totals against the
  // configured plan budget. This runs when the user hasn't installed
  // the status-line hook yet.
  if (!s.active || s.window_ends_ms == null || s.window_start_ms == null) {
    return {
      remainingMs: CLAUDE_WINDOW_MS,
      remainingLabel: formatDuration(CLAUDE_WINDOW_MS),
      totalTokens: 0,
      totalTokensLabel: "0",
      fractionUsed: 0,
      percentUsedLabel: "0%",
      plan,
      realSource: false,
      sevenDayPercent: null,
    };
  }
  const remainingMs = Math.max(0, s.window_ends_ms - now);
  const totalTokens =
    s.total_input_tokens +
    s.total_output_tokens +
    s.total_cache_read_tokens +
    s.total_cache_creation_tokens;
  const fractionUsed = Math.max(0, Math.min(1, totalTokens / budget));
  return {
    remainingMs,
    remainingLabel: formatDuration(remainingMs),
    totalTokens,
    totalTokensLabel: formatTokenCount(totalTokens),
    fractionUsed,
    percentUsedLabel: `${Math.round(fractionUsed * 100)}%`,
    plan,
    realSource: false,
    sevenDayPercent: null,
  };
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "0m";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m`;
  return `${totalSec}s`;
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}
