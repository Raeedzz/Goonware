import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Singleton, app-lifetime-scoped store that drives the worktree
 * spinner. Source of truth: agent CLI hook systems (Claude Code,
 * OpenAI Codex CLI, Google Gemini CLI). The Rust side installs a
 * small shell script into each agent's hooks directory, registers it
 * for every interesting event (turn start, tool use, turn end, …),
 * and forwards each fired event to a single Unix socket. The socket
 * server normalizes the event into a `SessionStatus` and emits an
 * `agent://session/state` Tauri event that this store listens for.
 *
 * The spinner reflects ONLY this hook signal. Any OSC 133 / shell
 * command state lives in `terminalActivityStore` and is reserved for
 * the per-block command indicator inside the terminal pane — never
 * for the worktree spinner. Mixing the two (OSC 133 as a fallback)
 * caused the spinner to fire for every `ls` and every long-running
 * `npm run dev`, and pinned it on for the lifetime of a Claude TUI
 * even when the agent was idle at its input box. Pure hook events
 * are the only signal that cleanly toggles on "agent is computing"
 * and off "agent is awaiting user input".
 *
 * Architecture:
 *
 *   claude / codex / gemini  ─[hook event]─▶  ~/.<cli>/hooks/goonware-<cli>-hook.sh
 *                                                    │  (JSON envelope)
 *                                                    ▼
 *                                         /tmp/goonware-agent.sock
 *                                                    │
 *                                                    ▼
 *                                      Rust AgentHookState
 *                                      (HashMap by provider:session_id)
 *                                                    │
 *                                                    ▼
 *                                  "agent://session/state" Tauri event
 *                                                    │
 *                                                    ▼
 *                                  this module's `sessions` Map
 *                                                    │
 *                                                    ▼
 *                          `useTrackAgentActivity(cwd)` → spinner
 *
 * Worktree mapping happens here in the frontend: each `SessionRecord`
 * carries its `cwd` (set on every hook fire) and a `provider` tag
 * (claude / codex / gemini). The UI doesn't care which provider —
 * any working session whose cwd is at or below the worktree path
 * lights the spinner.
 */

type SessionStatus =
  | "working"
  | "compacting"
  | "waiting"
  | "idle"
  | "ended";

type Provider = "claude" | "codex" | "gemini";

export interface SessionRecord {
  provider: Provider;
  session_id: string;
  cwd: string;
  status: SessionStatus;
  last_event: string;
  last_tool: string;
  updated_at_ms: number;
}

/** Composite key — two providers can legitimately reuse a session_id. */
function sessionKey(rec: { provider: Provider; session_id: string }): string {
  return `${rec.provider}:${rec.session_id}`;
}

const sessions = new Map<string, SessionRecord>();
const listeners = new Set<() => void>();
let bootstrapped = false;
let unlistenFn: UnlistenFn | null = null;

function notifyAll() {
  // Bump the generation so the per-path snapshot cache is dropped
  // before any consumer's getSnapshot re-reads. Without this, a
  // consumer would see the cached pre-change value and skip the
  // rerender.
  snapshotGeneration += 1;
  listeners.forEach((fn) => fn());
}

function applyRecord(record: SessionRecord) {
  // eslint-disable-next-line no-console
  console.debug(
    `[agent-hook ${record.provider}]`,
    record.last_event,
    "→",
    record.status,
    "cwd=",
    record.cwd,
  );
  const key = sessionKey(record);
  // SessionEnd / Ended evicts so a long-lived app doesn't accumulate
  // dead sessions. The Rust side already drops Ended from its own
  // map; we mirror that here.
  if (record.status === "ended") {
    if (sessions.delete(key)) notifyAll();
    return;
  }
  const prev = sessions.get(key);
  if (!prev) {
    // First event for this session_id — a fresh agent process. Stale
    // same-(provider, cwd) cleanup is NOT done here: the frontend has
    // no pid knowledge, so a client-side sweep can't tell a dead
    // hard-killed session from a live peer running in a sibling pane
    // of the same worktree (two agents would mutually evict each
    // other's records and the spinner ping-pongs). The Rust backend
    // owns that decision — on a new session's first event it evicts
    // same-provider overlapping-cwd sessions only when their pid is
    // missing or dead, and broadcasts each eviction as a synthetic
    // Ended record over agent://session/state, which the `ended`
    // branch above handles generically.
    sessions.set(key, record);
    notifyAll();
    return;
  }
  if (
    prev.status === record.status &&
    prev.cwd === record.cwd &&
    prev.last_event === record.last_event &&
    prev.last_tool === record.last_tool
  ) {
    // Mutating updated_at_ms alone never affects any visible state,
    // so skip the rerender it would otherwise force on every event.
    prev.updated_at_ms = record.updated_at_ms;
    return;
  }
  sessions.set(key, record);
  notifyAll();
}

async function bootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;
  // Listener FIRST, then snapshot — the other order drops any event
  // fired in the gap between the two awaits (e.g. a working→idle flip
  // during startup leaves a spinner stuck on until the next event).
  try {
    unlistenFn = await listen<SessionRecord>(
      "agent://session/state",
      (e) => applyRecord(e.payload),
    );
  } catch {
    // Listener bind failure is fatal-but-silent: the rest of the app
    // works without spinners. Surface via console for diagnosis.
    // eslint-disable-next-line no-console
    console.warn("goonware agent hook listener bind failed");
  }
  // Initial snapshot in case the user starts Goonware while an agent
  // session is already mid-turn — the hook events for that turn
  // have already fired and we'd otherwise have nothing in the map
  // until the next event. Live events that beat the snapshot win:
  // a session already in the map is newer than the snapshot row.
  try {
    const initial = await invoke<SessionRecord[]>("agent_sessions");
    let added = false;
    for (const rec of initial) {
      const k = sessionKey(rec);
      if (sessions.has(k)) continue;
      sessions.set(k, rec);
      added = true;
    }
    if (added) notifyAll();
  } catch {
    // Backend not ready — the listener above will catch up.
  }
}

/**
 * Mount once at app shell level. Lazily bootstraps the listener +
 * initial snapshot on first call; subsequent calls are no-ops.
 */
export function useAgentHookSubscription(): void {
  useEffect(() => {
    void bootstrap();
    return () => {
      void unlistenFn;
    };
  }, []);
}

/** @deprecated kept as an alias during the rename; prefer useAgentHookSubscription. */
export const useClaudeHookSubscription = useAgentHookSubscription;

/**
 * Path-prefix match. Strips a single trailing slash on both sides so
 * `/foo/bar` and `/foo/bar/` both match, then accepts either an exact
 * equality OR a `cwd` that's a descendant of `worktreePath`. The
 * descendant case matters: a user can run `claude` from any
 * subdirectory of a worktree (e.g. cd into `src/` first) and the
 * hook envelope's cwd will reflect that deeper path. Exact-match
 * would silently drop those events from the spinner.
 */
function cwdMatchesWorktree(cwd: string, worktreePath: string): boolean {
  if (!cwd || !worktreePath) return false;
  const a = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  const b = worktreePath.endsWith("/")
    ? worktreePath.slice(0, -1)
    : worktreePath;
  return a === b || a.startsWith(b + "/");
}

/**
 * Spinner-relevant boolean per worktree path. Cached so
 * `useSyncExternalStore` sees a stable reference across renders when
 * the underlying state hasn't changed.
 */
const snapshotCache = new Map<string, boolean>();
let snapshotGeneration = 0;
let lastNotifiedGeneration = 0;

function computeRunning(worktreePath: string): boolean {
  if (!worktreePath) return false;
  for (const rec of sessions.values()) {
    if (!cwdMatchesWorktree(rec.cwd, worktreePath)) continue;
    if (rec.status === "working" || rec.status === "compacting") return true;
  }
  return false;
}

function getCachedRunning(worktreePath: string): boolean {
  // Invalidate cache on every state generation bump. Prefix matching
  // means a single session event can affect multiple worktree paths,
  // so we clear globally rather than per-path.
  if (lastNotifiedGeneration !== snapshotGeneration) {
    snapshotCache.clear();
    lastNotifiedGeneration = snapshotGeneration;
  }
  const cached = snapshotCache.get(worktreePath);
  if (cached !== undefined) return cached;
  const fresh = computeRunning(worktreePath);
  snapshotCache.set(worktreePath, fresh);
  return fresh;
}

/**
 * Force-flip every working/compacting agent session whose cwd is at
 * or below `cwd` to Idle, locally. This is the Ctrl+C path: the user
 * pressed Ctrl+C to stop a running agent, but Claude/Codex don't
 * always fire their Stop hook on a mid-turn SIGINT — Stop is the
 * end-of-turn signal, not the abort signal. The session stays in
 * "working" forever and the worktree spinner keeps spinning even
 * though the agent has actually been interrupted.
 *
 * Mutating the local Map is sufficient: the worktree spinner is
 * driven by this store's snapshot, and a subsequent real hook event
 * (e.g. the user starting a new prompt → UserPromptSubmit) will
 * re-set the status to Working through the normal applyRecord path.
 * Rust-side state may still report Working until the next hook
 * fires, but no UI reads that — the snapshot below is the
 * frontend's source of truth.
 *
 * Does NOT delete the session: an in-flight session that's been
 * interrupted is still a session (next UserPromptSubmit should
 * resume it cleanly). Eviction happens on the real Ended event.
 */
export function forceIdleForCwd(cwd: string): void {
  if (!cwd) return;
  let changed = false;
  for (const [key, rec] of sessions) {
    if (!cwdMatchesWorktree(rec.cwd, cwd)) continue;
    if (rec.status !== "working" && rec.status !== "compacting") continue;
    sessions.set(key, {
      ...rec,
      status: "idle",
      last_event: "ctrl_c_local",
      updated_at_ms: Date.now(),
    });
    changed = true;
  }
  if (changed) notifyAll();
}

/**
 * Definitive eviction: remove EVERY session whose cwd is at or below
 * `cwd`, regardless of status. The double-Ctrl+C SIGKILL path in
 * `BlockTerminal.onForceKill` calls this — the process group has been
 * killed, so there is genuinely no agent to track and the SessionEnd
 * hook will never arrive. Without this, the next time the user runs
 * `claude` in the same pane the old record is still in the map; the
 * sidebar spinner stays on (any working session counts) and the
 * per-pane session consumers can briefly show the killed agent's last
 * status before the new SessionStart record overrides it.
 *
 * This is intentionally more aggressive than `forceIdleForCwd`. That
 * helper handles single-Ctrl+C (agent traps SIGINT, process is still
 * alive, the next UserPromptSubmit will resume the same session); we
 * only want to stop the spinner. SIGKILL is the irreversible signal
 * — the session is gone.
 */
export function forceEvictForCwd(cwd: string): void {
  if (!cwd) return;
  let changed = false;
  for (const [key, rec] of sessions) {
    if (!cwdMatchesWorktree(rec.cwd, cwd)) continue;
    sessions.delete(key);
    changed = true;
  }
  if (changed) notifyAll();
}

/**
 * Spinner signal for a worktree. ONLY sourced from agent CLI hook
 * events — no OSC 133, no per-tab agentStatus, no transcript mtime
 * polling. Returns true iff at least one Claude/Codex/Gemini session
 * whose cwd is at-or-below `cwd` is in the `working` (or
 * `compacting`) state.
 *
 * The first arg used to be a worktreeId; it's kept positional for
 * call-site stability but is now unused.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useTrackAgentActivity(_worktreeId: string, cwd: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => getCachedRunning(cwd),
    () => getCachedRunning(cwd),
  );
}

/**
 * Return the most-recently-updated SessionRecord whose cwd is at or
 * below `cwd`, or null if none. Used by per-pane session consumers to
 * show "Claude is using Read" / "waiting for permission" / etc.
 *
 * "Most recent" matters when the user has multiple agents touching
 * overlapping subtrees of a worktree (a Claude session at the root
 * and a Codex session in `src/`, say). The freshest event is the one
 * the user just observed, so the chrome reflects what just happened
 * rather than randomly picking from the matching set.
 */
const sessionForCwdCache = new Map<string, SessionRecord | null>();

function computeSessionForCwd(cwd: string): SessionRecord | null {
  if (!cwd) return null;
  let best: SessionRecord | null = null;
  for (const rec of sessions.values()) {
    if (!cwdMatchesWorktree(rec.cwd, cwd)) continue;
    if (!best || rec.updated_at_ms > best.updated_at_ms) best = rec;
  }
  return best;
}

function getCachedSessionForCwd(cwd: string): SessionRecord | null {
  if (lastSessionCacheGeneration !== snapshotGeneration) {
    sessionForCwdCache.clear();
    lastSessionCacheGeneration = snapshotGeneration;
  }
  if (sessionForCwdCache.has(cwd)) {
    return sessionForCwdCache.get(cwd) ?? null;
  }
  const fresh = computeSessionForCwd(cwd);
  sessionForCwdCache.set(cwd, fresh);
  return fresh;
}

let lastSessionCacheGeneration = 0;

export function useAgentSessionForCwd(cwd: string): SessionRecord | null {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => getCachedSessionForCwd(cwd),
    () => getCachedSessionForCwd(cwd),
  );
}

// Re-exported for tests / scripts that want to inspect store state.
// Not part of the supported API.
export const __internals = {
  sessions,
  applyRecord,
  resolveSessionForCwd: getCachedSessionForCwd,
};
