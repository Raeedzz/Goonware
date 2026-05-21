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
 * Drop every memory entry associated with a session AND tear down its
 * Rust-side PTYs. Memory is keyed by ptyId (`agent-${sessionId}-${paneId}`),
 * and a session can have any number of terminal panes — so we sweep
 * every entry whose key contains the session id. Call this only when
 * the session itself is being permanently removed (user closes the
 * tab) — never on routine session switches.
 */
export function forgetSession(sessionId: string): void {
  // Match the ptyId pattern from WorkspaceLayout. Any future change to
  // that pattern needs to update this prefix in lockstep.
  const prefix = `agent-${sessionId}-`;
  for (const key of Array.from(store.keys())) {
    if (key === sessionId || key.startsWith(prefix)) {
      store.delete(key);
      // Fire-and-forget: failing to kill a stale PTY isn't worth
      // surfacing to the user (the session is being deleted anyway).
      void invoke("term_close", { id: key }).catch(() => {});
    }
  }
}
