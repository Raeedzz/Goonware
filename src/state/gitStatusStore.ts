import { useCallback, useSyncExternalStore } from "react";
import { git, type StatusResult } from "../lib/git";

/**
 * Shared per-cwd `git status` poller.
 *
 * Before this store existed, every mounted TerminalStatusBar (one per
 * kept-alive terminal pane, including hidden ones) plus the file tree
 * ran its own 4s `git_status` interval against the same repo. With N
 * agent panes in a worktree that meant N+ identical `git status`
 * subprocess spawns every 4 seconds, forever, even with the window
 * backgrounded — pure battery burn.
 *
 * This store dedupes to exactly ONE poll per distinct cwd, refcounted
 * by subscriber count, and pauses entirely while the document is
 * hidden (with an immediate reconcile when it becomes visible again).
 * `goonware-git-refresh` nudges (commit/push/merge) refresh the
 * matching cwd immediately, same contract as the old per-component
 * listeners.
 */

const POLL_MS = 4000;

interface Entry {
  refs: number;
  status: StatusResult | null;
  timer: number | null;
  listeners: Set<() => void>;
  inFlight: boolean;
  /** A pull was requested while one was in flight (e.g. a
   *  goonware-git-refresh nudge racing the 4s poll) — run one more
   *  when the current pull settles instead of dropping the nudge. */
  queued: boolean;
}

const entries = new Map<string, Entry>();
let globalHooksInstalled = false;

function installGlobalHooks() {
  if (globalHooksInstalled) return;
  globalHooksInstalled = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      for (const e of entries.values()) stopTimer(e);
    } else {
      for (const [cwd, e] of entries) {
        if (e.refs > 0) {
          void pull(cwd, e);
          startTimer(cwd, e);
        }
      }
    }
  });
  window.addEventListener("goonware-git-refresh", (ev: Event) => {
    const detail = (ev as CustomEvent<{ cwd?: string }>).detail;
    for (const [cwd, e] of entries) {
      if (e.refs > 0 && (!detail?.cwd || detail.cwd === cwd)) {
        void pull(cwd, e);
      }
    }
  });
}

async function pull(cwd: string, e: Entry) {
  if (e.inFlight) {
    e.queued = true;
    return;
  }
  e.inFlight = true;
  try {
    const status = await git.status(cwd);
    e.status = status;
  } catch {
    // Not a git repo / transient failure — expose null so consumers
    // can fall back to their empty state.
    e.status = null;
  } finally {
    e.inFlight = false;
  }
  e.listeners.forEach((fn) => fn());
  if (e.queued && e.refs > 0) {
    e.queued = false;
    void pull(cwd, e);
  }
}

function startTimer(cwd: string, e: Entry) {
  if (e.timer !== null) return;
  e.timer = window.setInterval(() => void pull(cwd, e), POLL_MS);
}

function stopTimer(e: Entry) {
  if (e.timer === null) return;
  window.clearInterval(e.timer);
  e.timer = null;
}

export function subscribeGitStatus(cwd: string, notify: () => void): () => void {
  installGlobalHooks();
  let e = entries.get(cwd);
  if (!e) {
    e = {
      refs: 0,
      status: null,
      timer: null,
      listeners: new Set(),
      inFlight: false,
      queued: false,
    };
    entries.set(cwd, e);
  }
  e.refs += 1;
  e.listeners.add(notify);
  if (e.refs === 1) {
    void pull(cwd, e);
    if (!document.hidden) startTimer(cwd, e);
  }
  return () => {
    e.refs -= 1;
    e.listeners.delete(notify);
    if (e.refs <= 0) {
      stopTimer(e);
      // Drop the entry entirely so long-gone cwds don't accumulate
      // stale StatusResults for the app's lifetime.
      entries.delete(cwd);
    }
  };
}

export function getGitStatusSnapshot(cwd: string): StatusResult | null {
  return entries.get(cwd)?.status ?? null;
}

/** Force an immediate re-poll for a cwd (used by explicit refresh buttons). */
export function refreshGitStatus(cwd: string): void {
  const e = entries.get(cwd);
  if (e && e.refs > 0) void pull(cwd, e);
}

/**
 * React hook: latest StatusResult for `cwd`, shared across all
 * subscribers of the same cwd. Returns null while unknown / not a repo.
 *
 * The subscribe/getSnapshot callbacks MUST be memoized on `cwd`:
 * useSyncExternalStore re-subscribes whenever the subscribe identity
 * changes, and our unsubscribe has real side effects (refcount drop →
 * entry delete → cache loss → fresh `git status` subprocess on
 * resubscribe). An inline closure here turned every consumer render
 * into a poller teardown + subprocess spawn — the exact storm this
 * store exists to prevent.
 */
export function useSharedGitStatus(cwd: string | null): StatusResult | null {
  const subscribe = useCallback(
    (notify: () => void) => (cwd ? subscribeGitStatus(cwd, notify) : () => {}),
    [cwd],
  );
  const getSnapshot = useCallback(
    () => (cwd ? getGitStatusSnapshot(cwd) : null),
    [cwd],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
