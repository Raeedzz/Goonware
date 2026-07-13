import { afterEach, describe, expect, test } from "bun:test";
import {
  __internals,
  forceEvictForCwd,
  forceIdleForCwd,
  type SessionRecord,
} from "./agentActivityStore";

// `useAgentSessionForCwd` is exported but only consumable inside a
// React renderer. The test below reaches into the same internal
// resolver — `getCachedSessionForCwd` — through a thin wrapper
// exported on `__internals`. See agentActivityStore.ts for the
// extension.

/**
 * Regression tests for the Ctrl+C spinner fix.
 *
 * User report: "when I press ctrl c and then claude agent stops
 * going why is the spinner still going it should stop"
 *
 * Root cause: Claude/Codex/Gemini fire their Stop hook at the END
 * of a turn, not on a mid-turn SIGINT. When the user Ctrl+C's an
 * agent that's still computing, the session stays in `working`
 * forever because the hook event for the state flip-back never
 * arrives.
 *
 * Fix: BlockTerminal's onSendBytesVoid + onForceKill call
 * `forceIdleForCwd(worktreePath)` whenever the user sends a 0x03
 * SIGINT byte. The local store flips matching `working` /
 * `compacting` sessions to `idle` and notifies subscribers — the
 * spinner stops within one frame.
 *
 * These tests pin the local-flip behavior so a future refactor
 * can't quietly drop it.
 */

function seedSession(rec: Partial<SessionRecord> & {
  session_id: string;
  cwd: string;
  status: SessionRecord["status"];
}): void {
  __internals.applyRecord({
    provider: "claude",
    last_event: "UserPromptSubmit",
    last_tool: "",
    updated_at_ms: Date.now(),
    ...rec,
  });
}

afterEach(() => {
  __internals.sessions.clear();
});

describe("forceIdleForCwd — Ctrl+C local spinner flip", () => {
  test("flips a working session in the matching cwd to idle", () => {
    seedSession({
      session_id: "abc",
      cwd: "/Users/me/proj",
      status: "working",
    });
    forceIdleForCwd("/Users/me/proj");
    const rec = __internals.sessions.get("claude:abc");
    expect(rec).toBeDefined();
    expect(rec!.status).toBe("idle");
    // Last_event records the local-flip path so a future debug
    // session can disambiguate this from a genuine hook event.
    expect(rec!.last_event).toBe("ctrl_c_local");
  });

  test("flips a compacting session to idle too", () => {
    // Compacting is also a spinner-on state per
    // `computeRunning` — the user pressing Ctrl+C mid-compaction
    // wants the spinner off just as much as mid-turn.
    seedSession({
      session_id: "abc",
      cwd: "/Users/me/proj",
      status: "compacting",
    });
    forceIdleForCwd("/Users/me/proj");
    expect(__internals.sessions.get("claude:abc")!.status).toBe("idle");
  });

  test("flips a session running in a SUBdirectory of the worktree", () => {
    // The user might cd into src/ before launching claude. The
    // hook envelope's cwd reflects the deeper path, but the
    // spinner is keyed on the worktree root.
    seedSession({
      session_id: "abc",
      cwd: "/Users/me/proj/src/components",
      status: "working",
    });
    forceIdleForCwd("/Users/me/proj");
    expect(__internals.sessions.get("claude:abc")!.status).toBe("idle");
  });

  test("does NOT touch sessions in unrelated worktrees", () => {
    seedSession({
      session_id: "abc",
      cwd: "/Users/me/proj-a",
      status: "working",
    });
    seedSession({
      session_id: "xyz",
      cwd: "/Users/me/proj-b",
      status: "working",
    });
    forceIdleForCwd("/Users/me/proj-a");
    expect(__internals.sessions.get("claude:abc")!.status).toBe("idle");
    // proj-b's session must not be touched by a Ctrl+C in proj-a.
    expect(__internals.sessions.get("claude:xyz")!.status).toBe("working");
  });

  test("does NOT touch idle or waiting sessions", () => {
    // Idle / waiting are already spinner-off states. Touching
    // them would still notify subscribers (cheap, but the
    // updated_at_ms churn is wasted work for no UI change), and
    // would also drop the last_event annotation that the hook
    // chain set.
    seedSession({
      session_id: "abc",
      cwd: "/Users/me/proj",
      status: "idle",
      last_event: "Stop",
    });
    forceIdleForCwd("/Users/me/proj");
    const rec = __internals.sessions.get("claude:abc")!;
    expect(rec.status).toBe("idle");
    expect(rec.last_event).toBe("Stop");
  });

  test("does NOT delete the session — interrupted sessions are still sessions", () => {
    seedSession({
      session_id: "abc",
      cwd: "/Users/me/proj",
      status: "working",
    });
    forceIdleForCwd("/Users/me/proj");
    // Session is still in the map — a follow-up UserPromptSubmit
    // (the user typing the next prompt) needs to find the record
    // and flip it back to working. Eviction belongs to the Ended
    // event, not to Ctrl+C.
    expect(__internals.sessions.has("claude:abc")).toBe(true);
  });

  test("ignores an empty cwd (defensive — no agent yet)", () => {
    seedSession({
      session_id: "abc",
      cwd: "/Users/me/proj",
      status: "working",
    });
    forceIdleForCwd("");
    expect(__internals.sessions.get("claude:abc")!.status).toBe("working");
  });

  test("handles trailing-slash mismatch between cwd and worktreePath", () => {
    seedSession({
      session_id: "abc",
      cwd: "/Users/me/proj/",
      status: "working",
    });
    forceIdleForCwd("/Users/me/proj");
    expect(__internals.sessions.get("claude:abc")!.status).toBe("idle");
  });
});

describe("applyRecord — stale-session eviction on new-session edge", () => {
  /**
   * The reported "loading box doesn't fire on restart" bug. A
   * hard-killed Claude leaves its SessionRecord stuck at `working` in
   * the map (SessionEnd never fires). When the user launches a fresh
   * Claude in the same pane, the new SessionStart record joins the
   * old one — the sidebar spinner reads "ANY working session = on"
   * and stays lit even when the new agent is idle. Eviction on the
   * new-session edge drops the stale record so the spinner reflects
   * just the live agent.
   */
  test("new session_id at same (provider, cwd) evicts the stale one", () => {
    seedSession({
      session_id: "old",
      cwd: "/Users/me/proj",
      status: "working",
      updated_at_ms: 1000,
    });
    __internals.applyRecord({
      provider: "claude",
      session_id: "new",
      cwd: "/Users/me/proj",
      status: "idle",
      last_event: "SessionStart",
      last_tool: "",
      updated_at_ms: 2000,
    });
    expect(__internals.sessions.has("claude:old")).toBe(false);
    expect(__internals.sessions.has("claude:new")).toBe(true);
  });

  test("eviction matches when new session's cwd is a subdirectory of the stale one", () => {
    seedSession({
      session_id: "old",
      cwd: "/Users/me/proj",
      status: "working",
      updated_at_ms: 1000,
    });
    __internals.applyRecord({
      provider: "claude",
      session_id: "new",
      cwd: "/Users/me/proj/src",
      status: "idle",
      last_event: "SessionStart",
      last_tool: "",
      updated_at_ms: 2000,
    });
    expect(__internals.sessions.has("claude:old")).toBe(false);
    expect(__internals.sessions.has("claude:new")).toBe(true);
  });

  test("eviction matches when stale session's cwd is a subdirectory of the new one", () => {
    seedSession({
      session_id: "old",
      cwd: "/Users/me/proj/src",
      status: "working",
      updated_at_ms: 1000,
    });
    __internals.applyRecord({
      provider: "claude",
      session_id: "new",
      cwd: "/Users/me/proj",
      status: "idle",
      last_event: "SessionStart",
      last_tool: "",
      updated_at_ms: 2000,
    });
    expect(__internals.sessions.has("claude:old")).toBe(false);
    expect(__internals.sessions.has("claude:new")).toBe(true);
  });

  test("does NOT evict sessions from a different provider", () => {
    // Codex and Claude sharing the same cwd is legitimate — two CLIs
    // pointed at the same repo. Evicting one because the other
    // started would lose live state.
    seedSession({
      provider: "claude",
      session_id: "claude-1",
      cwd: "/Users/me/proj",
      status: "working",
    });
    __internals.applyRecord({
      provider: "codex",
      session_id: "codex-1",
      cwd: "/Users/me/proj",
      status: "idle",
      last_event: "SessionStart",
      last_tool: "",
      updated_at_ms: Date.now(),
    });
    expect(__internals.sessions.has("claude:claude-1")).toBe(true);
    expect(__internals.sessions.has("codex:codex-1")).toBe(true);
  });

  test("does NOT evict sessions in a different cwd", () => {
    seedSession({
      session_id: "other",
      cwd: "/Users/me/different-proj",
      status: "working",
    });
    __internals.applyRecord({
      provider: "claude",
      session_id: "new",
      cwd: "/Users/me/proj",
      status: "idle",
      last_event: "SessionStart",
      last_tool: "",
      updated_at_ms: Date.now(),
    });
    expect(__internals.sessions.has("claude:other")).toBe(true);
    expect(__internals.sessions.has("claude:new")).toBe(true);
  });

  test("re-applying an event for an existing session does NOT trigger self-eviction", () => {
    // The eviction is gated on `prev === null` — i.e. the session_id
    // is new to the map. Without that gate, the very record we're
    // applying would self-evict, blanking the state mid-update.
    seedSession({
      session_id: "abc",
      cwd: "/Users/me/proj",
      status: "working",
    });
    __internals.applyRecord({
      provider: "claude",
      session_id: "abc",
      cwd: "/Users/me/proj",
      status: "compacting",
      last_event: "PreCompact",
      last_tool: "",
      updated_at_ms: Date.now(),
    });
    expect(__internals.sessions.has("claude:abc")).toBe(true);
    expect(__internals.sessions.get("claude:abc")!.status).toBe("compacting");
  });

  // NOTE: multi-pane same-(provider, cwd) is intentionally NOT
  // preserved. Two simultaneous claude sessions in the same worktree
  // is rare; the much more common failure mode is a stale "working"
  // record sitting in the map after a hard-killed agent, which
  // accidentally lights the worktree spinner for the new fresh-launch
  // session. Treating same-(provider, cwd) as one logical session
  // and clobbering the older record on new-session arrival is the
  // explicit trade-off here. The Rust-side PID watchdog catches the
  // dead-but-not-evicted case for the single-pane scenario, and
  // multi-pane users can land in a worktree subdirectory to
  // disambiguate (cwd prefix-matching ensures eviction still respects
  // the descendant relationship).
});

describe("forceEvictForCwd — SIGKILL drops sessions definitively", () => {
  /**
   * Double-Ctrl+C SIGKILL means the agent process is gone and its
   * SessionEnd hook will never fire. forceEvictForCwd is the
   * frontend's only chance to remove the record so the next agent
   * launch in the same pane doesn't inherit a stale "working"
   * spinner from the killed one.
   */
  test("removes every session whose cwd matches the worktree", () => {
    seedSession({
      session_id: "a",
      cwd: "/Users/me/proj",
      status: "working",
    });
    seedSession({
      session_id: "b",
      cwd: "/Users/me/proj/src",
      status: "idle",
    });
    forceEvictForCwd("/Users/me/proj");
    expect(__internals.sessions.has("claude:a")).toBe(false);
    expect(__internals.sessions.has("claude:b")).toBe(false);
  });

  test("does NOT remove sessions in unrelated worktrees", () => {
    seedSession({
      session_id: "a",
      cwd: "/Users/me/proj-a",
      status: "working",
    });
    seedSession({
      session_id: "b",
      cwd: "/Users/me/proj-b",
      status: "working",
    });
    forceEvictForCwd("/Users/me/proj-a");
    expect(__internals.sessions.has("claude:a")).toBe(false);
    expect(__internals.sessions.has("claude:b")).toBe(true);
  });

  test("removes idle / waiting / compacting sessions too — not just working", () => {
    // forceIdleForCwd only flips working/compacting; forceEvictForCwd
    // is stricter because SIGKILL is irreversible. Whatever state
    // the killed agent was in, the record is now meaningless.
    seedSession({
      session_id: "idle-one",
      cwd: "/Users/me/proj",
      status: "idle",
    });
    seedSession({
      session_id: "waiting-one",
      cwd: "/Users/me/proj",
      status: "waiting",
    });
    forceEvictForCwd("/Users/me/proj");
    expect(__internals.sessions.size).toBe(0);
  });

  test("ignores an empty cwd (defensive)", () => {
    seedSession({
      session_id: "a",
      cwd: "/Users/me/proj",
      status: "working",
    });
    forceEvictForCwd("");
    expect(__internals.sessions.has("claude:a")).toBe(true);
  });
});

describe("resolveSessionForCwd — per-pane lookup picks the right session", () => {
  test("returns null for empty cwd", () => {
    expect(__internals.resolveSessionForCwd("")).toBeNull();
  });

  test("returns null when no sessions match", () => {
    seedSession({
      session_id: "abc",
      cwd: "/Users/me/other-proj",
      status: "working",
    });
    expect(__internals.resolveSessionForCwd("/Users/me/proj")).toBeNull();
  });

  test("returns the matching session for exact cwd", () => {
    seedSession({
      session_id: "abc",
      cwd: "/Users/me/proj",
      status: "working",
    });
    const rec = __internals.resolveSessionForCwd("/Users/me/proj");
    expect(rec).not.toBeNull();
    expect(rec!.session_id).toBe("abc");
  });

  test("returns the matching session for a descendant cwd", () => {
    seedSession({
      session_id: "abc",
      cwd: "/Users/me/proj/src/components",
      status: "working",
    });
    const rec = __internals.resolveSessionForCwd("/Users/me/proj");
    expect(rec).not.toBeNull();
    expect(rec!.session_id).toBe("abc");
  });

  test("returns the most-recently-updated session when multiple match", () => {
    seedSession({
      session_id: "older",
      cwd: "/Users/me/proj",
      status: "working",
      updated_at_ms: 1000,
    });
    seedSession({
      provider: "codex",
      session_id: "newer",
      cwd: "/Users/me/proj/src",
      status: "working",
      updated_at_ms: 2000,
    });
    const rec = __internals.resolveSessionForCwd("/Users/me/proj");
    expect(rec).not.toBeNull();
    expect(rec!.session_id).toBe("newer");
    expect(rec!.provider).toBe("codex");
  });

  test("skips sessions whose cwd is outside the worktree", () => {
    seedSession({
      session_id: "outside",
      cwd: "/Users/me/different-proj",
      status: "working",
    });
    seedSession({
      session_id: "inside",
      cwd: "/Users/me/proj",
      status: "idle",
    });
    const rec = __internals.resolveSessionForCwd("/Users/me/proj");
    expect(rec).not.toBeNull();
    expect(rec!.session_id).toBe("inside");
  });
});
