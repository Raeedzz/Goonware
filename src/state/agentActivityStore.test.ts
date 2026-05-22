import { afterEach, describe, expect, test } from "bun:test";
import {
  __internals,
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

describe("resolveSessionForCwd — AgentChrome picks the right session", () => {
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
