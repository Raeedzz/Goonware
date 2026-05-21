/**
 * Module-scoped store of per-terminal-session UI state that needs to
 * survive React unmount.
 *
 * Why this exists: switching sessions/projects unmounts the workspace
 * tree, which would otherwise mean every terminal pane wipes its
 * closed-block scrollback, its typed-input history, AND its visible
 * grid the moment you switch back. We keep all of that here in module
 * scope so it lives for the lifetime of the page, not the lifetime of
 * any component.
 *
 * Companion change on the Rust side: term_start is idempotent — if a
 * session with the same id is still alive in the PTY map, it just
 * re-emits a full frame instead of killing + respawning. So switching
 * sessions never kills the underlying shell. PTYs are only torn down
 * when the session is permanently deleted, via forgetSession (which
 * fires term_close for each matching ptyId).
 *
 * Caps: none. Block scrollback and typed-input history grow without
 * bound — the user wants to see every row of every agent that ever
 * ran in this session. Memory is bounded in practice by how much an
 * actual session produces.
 */
import { invoke } from "@tauri-apps/api/core";
import type { Block, RenderFrame, Span } from "./types";

interface Memory {
  blocks: Block[];
  history: string[];
  /** Snapshot of the live grid's rows, indexed by row number. */
  rows: Span[][];
  /**
   * Accumulated PTY scrollback rows — oldest first. Each frame's
   * `scrollback_appended` from the backend gets pushed onto the tail.
   * Survives remount so a user that switches tabs and comes back keeps
   * their full agent scroll-back. Reset to `[]` whenever a frame
   * carries `scrollback_reset: true` (full re-sync from the backend,
   * or `history_size()` shrunk on resize/clear).
   */
  scrollback: Span[][];
  /** Last frame metadata (cursor + alt-screen flag). When null, the
   *  pane has never received a frame yet. */
  liveFrame: RenderFrame | null;
  altScreen: boolean;
  exited: boolean;
  /** Live cwd as reported by the shell's OSC 7 hook. */
  cwd: string | null;
  bellTick: number;
}

const store = new Map<string, Memory>();

function ensure(id: string): Memory {
  let m = store.get(id);
  if (!m) {
    m = {
      blocks: [],
      history: [],
      rows: [],
      scrollback: [],
      liveFrame: null,
      altScreen: false,
      exited: false,
      cwd: null,
      bellTick: 0,
    };
    store.set(id, m);
  }
  return m;
}

export function getBlocks(id: string): Block[] {
  return ensure(id).blocks;
}

export function setBlocks(id: string, blocks: Block[]): void {
  ensure(id).blocks = blocks;
}

export function getHistory(id: string): string[] {
  return ensure(id).history;
}

export function setHistory(id: string, history: string[]): void {
  ensure(id).history = history;
}

export function getRows(id: string): Span[][] {
  return ensure(id).rows;
}

export function setRows(id: string, rows: Span[][]): void {
  ensure(id).rows = rows;
}

export function getScrollback(id: string): Span[][] {
  return ensure(id).scrollback;
}

export function setScrollback(id: string, scrollback: Span[][]): void {
  ensure(id).scrollback = scrollback;
}

export function getLiveFrame(id: string): RenderFrame | null {
  return ensure(id).liveFrame;
}

export function setLiveFrame(id: string, frame: RenderFrame | null): void {
  ensure(id).liveFrame = frame;
}

export function getAltScreen(id: string): boolean {
  return ensure(id).altScreen;
}

export function setAltScreen(id: string, alt: boolean): void {
  ensure(id).altScreen = alt;
}

export function getExited(id: string): boolean {
  return ensure(id).exited;
}

export function setExited(id: string, exited: boolean): void {
  ensure(id).exited = exited;
}

export function getCwd(id: string): string | null {
  return ensure(id).cwd;
}

export function setCwd(id: string, cwd: string | null): void {
  ensure(id).cwd = cwd;
}

export function getBellTick(id: string): number {
  return ensure(id).bellTick;
}

export function setBellTick(id: string, tick: number): void {
  ensure(id).bellTick = tick;
}

/**
 * Permanently tear down the given pty_ids: in-memory scrollback,
 * live PTY processes, and persisted block history.
 *
 * Use this only on irreversible deletion paths — worktree archive,
 * "Discard branch" from the close dialog, explicit session delete.
 * NEVER on routine session switches or app quit, both of which want
 * the scrollback to be there when the user comes back.
 *
 * Three concerns, fanned out per pty:
 *   1. `store.delete(pty)` — drops the JS-side blocks/rows/cwd cache
 *      so a future remount under the same id (unlikely after archive,
 *      since `worktree_restore` mints fresh ids) doesn't replay
 *      stale state.
 *   2. `term_close` — kills the PTY child if it's still alive.
 *      Idempotent on unknown ids.
 *   3. `term_history_forget` — cascade-deletes the SQLite
 *      `terminal_panes` + `blocks` rows via the FK declared in
 *      persistence migration v2. Idempotent on unknown ids.
 *
 * Earlier this took a `sessionId` and used the prefix
 * `agent-${sessionId}-` to scan `store.keys()`, which silently no-op'd
 * once pty_ids switched to the `pty_<stamp>_<rand>` shape minted by
 * `worktrees.ts` / `useKeyboardShortcuts`. Explicit ids dodge that
 * footgun entirely.
 */
export function forgetPtys(ptyIds: string[]): void {
  for (const id of ptyIds) {
    if (!id) continue;
    store.delete(id);
    void invoke("term_close", { id }).catch(() => {});
    void invoke("term_history_forget", { id }).catch(() => {});
  }
}
