import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Per-PTY "is a command currently running" tracker.
 *
 * Source: the backend OSC 133 segmenter sets `command_running=true`
 * between an OSC 133 C marker (command start) and the next OSC 133 D
 * marker (command done). BlockTerminal sees this on every frame and
 * calls `setTerminalRunning(ptyId, frame.command_running)` so the
 * sidebar's worktree spinner can light up whenever ANY pty in the
 * worktree has an active command — `npm run build`, `pytest`, a long
 * `find`, whatever.
 *
 * This is the same signal Warp uses for its per-block spinner: OSC 133
 * is the standard shell-integration marker for "command is processing
 * vs. waiting at prompt". It does NOT remain true while the user is
 * sitting at the shell prompt or while a TUI agent (claude/codex) is
 * idle inside its own input box — those are the cases the user
 * specifically called out as "spinner shouldn't be on right now".
 *
 * For Claude specifically we ALSO OR in transcript-file mtime polling
 * (`agentActivityStore`) so the spinner reflects active agent turns
 * even when claude's TUI doesn't emit OSC 133 between turns.
 */

const states = new Map<string, boolean>();
const listeners = new Set<() => void>();

function notifyAll() {
  listeners.forEach((fn) => fn());
}

export function setTerminalRunning(ptyId: string, running: boolean): void {
  const prev = states.get(ptyId) ?? false;
  if (prev === running) return;
  if (running) {
    states.set(ptyId, true);
  } else {
    states.delete(ptyId);
  }
  notifyAll();
}

export function clearTerminalRunning(ptyId: string): void {
  if (!states.has(ptyId)) return;
  states.delete(ptyId);
  notifyAll();
}

function snapshot(ptyIds: readonly string[]): boolean {
  for (const id of ptyIds) {
    if (states.get(id)) return true;
  }
  return false;
}

/**
 * True iff at least one of `ptyIds` currently has an OSC 133 command
 * running. Wires into useSyncExternalStore so consumers only rerender
 * when the OR'd state flips, not on every poll tick.
 *
 * Cache the joined-string key so the snapshot fn we hand React is
 * referentially stable across renders for the same id set — otherwise
 * useSyncExternalStore tears on every parent render.
 */
export function useAnyTerminalRunning(ptyIds: readonly string[]): boolean {
  const key = ptyIds.join("|");
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => snapshotByKey(key, ptyIds),
    () => snapshotByKey(key, ptyIds),
  );
}

// Memoize the snapshot result per key so React's strict comparison
// inside useSyncExternalStore returns the same boolean reference when
// nothing changed. (Booleans are referentially stable in JS, but the
// concern is that calling snapshot() on every render would re-iterate
// the id list — the cache short-circuits that.)
const snapshotCache = new Map<string, boolean>();
function snapshotByKey(key: string, ptyIds: readonly string[]): boolean {
  const v = snapshot(ptyIds);
  snapshotCache.set(key, v);
  return v;
}

/**
 * Global poll loop that asks the Rust backend which PTY sessions
 * currently have `last_command_running=true`, and reconciles the
 * frontend store with that set. This is the cross-worktree signal
 * path: the per-worktree TerminalKeepaliveLayer only mounts the
 * active worktree's BlockTerminals, so without this poll a
 * `npm run build` in a background worktree's PTY would have no
 * way to surface its running state to the sidebar spinner.
 *
 * Mounted BlockTerminals also call `setTerminalRunning` directly
 * from their per-frame effect — that path is lower-latency (no
 * 500 ms poll gap) and authoritative when both paths agree. The
 * poll just covers the unmounted case. Both write the same
 * underlying `states` map.
 *
 * 500 ms poll cadence: matches the user-perceived "is something
 * happening" tempo while keeping the IPC volume well below the
 * frame-emit budget. The Rust side is O(N) over open sessions and
 * a few microseconds in practice, so this is cheap.
 *
 * The poll pauses entirely while the window is hidden (nobody can
 * see the spinner) and reconciles immediately on the visibilitychange
 * back to visible, so no stale state survives un-hiding.
 */
const POLL_INTERVAL_MS = 500;
let pollHandle: number | null = null;
let pollSubscribers = 0;
let visibilityHooked = false;

async function pollRunningSessions() {
  try {
    const ids = await invoke<string[]>("term_running_session_ids");
    const seen = new Set(ids);
    let changed = false;
    // Add newly-running sessions.
    for (const id of ids) {
      if (!states.get(id)) {
        states.set(id, true);
        changed = true;
      }
    }
    // Drop sessions that the backend no longer reports as running.
    for (const id of Array.from(states.keys())) {
      if (!seen.has(id)) {
        states.delete(id);
        changed = true;
      }
    }
    if (changed) notifyAll();
  } catch {
    // Soft-fail: leave the prior state in place. Worst case is one
    // stale tick before the next successful poll reconciles.
  }
}

function ensurePoll() {
  if (!visibilityHooked) {
    visibilityHooked = true;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        stopPoll();
      } else if (pollSubscribers > 0) {
        startPoll();
      }
    });
  }
  if (document.hidden) return;
  startPoll();
}

function startPoll() {
  if (pollHandle !== null) return;
  void pollRunningSessions();
  pollHandle = window.setInterval(
    () => void pollRunningSessions(),
    POLL_INTERVAL_MS,
  );
}

function stopPoll() {
  if (pollHandle === null) return;
  window.clearInterval(pollHandle);
  pollHandle = null;
}

/**
 * Mount once at app shell level. Refcount-gated so the poll only
 * runs while at least one consumer cares, but in practice the
 * AppShell mounts it for the app lifetime.
 */
export function useTerminalRunningPoll(): void {
  useEffect(() => {
    pollSubscribers += 1;
    ensurePoll();
    return () => {
      pollSubscribers -= 1;
      if (pollSubscribers <= 0) {
        pollSubscribers = 0;
        stopPoll();
      }
    };
  }, []);
}
