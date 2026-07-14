import { describe, expect, test } from "bun:test";
import { computeClosedBlockLines, isAgentInput } from "./blockLogic";
import type { BlockRow, Span } from "./types";

function span(text: string): Span {
  return {
    text,
    fg: "",
    bg: "",
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
    dim: false,
    strikeout: false,
  };
}

function row(text: string): BlockRow {
  return { spans: [span(text)] };
}

describe("isAgentInput — recognise TUI agents", () => {
  test.each([
    ["claude", true],
    ["codex", true],
    ["aider", true],
    ["gemini", true],
    ["copilot", true],
    ["ls -la", false],
    ["", false],
    ["git status", false],
  ])("isAgentInput(%p) → %p", (input, expected) => {
    expect(isAgentInput(input)).toBe(expected);
  });

  test("strips env-var prefixes (`FOO=bar claude`)", () => {
    expect(isAgentInput("DEBUG=1 claude")).toBe(true);
    expect(isAgentInput("ANTHROPIC_API_KEY=sk-… claude --resume")).toBe(true);
  });

  test("resolves absolute-path wrappers (`/usr/local/bin/claude`)", () => {
    expect(isAgentInput("/usr/local/bin/claude")).toBe(true);
    expect(isAgentInput("~/.bun/bin/codex --json")).toBe(true);
  });

  test("recognises agents behind shell launch wrappers", () => {
    expect(isAgentInput("env TOKEN=x codex")).toBe(true);
    expect(isAgentInput("command gemini")).toBe(true);
    expect(isAgentInput("exec copilot")).toBe(true);
  });
});

describe("computeClosedBlockLines — Ctrl+C preserves agent TUI content", () => {
  // The user-facing regression: pre-fix, agent blocks always rendered
  // as empty because the lines path was unconditionally `[]` for agent
  // inputs. After Ctrl+C the user saw a bare "claude" header with no
  // body — losing the entire conversation. Warp keeps it visible; we
  // now do too. These tests pin the new behaviour so a future
  // refactor can't silently strip agent block bodies again.

  test("agent block with blockRows snapshot → renders the snapshot", () => {
    const snapshot = [row("│ ✻ Welcome to Claude"), row("│ /help for commands")];
    const lines = computeClosedBlockLines(snapshot, "", true);
    expect(lines.length).toBe(2);
    expect(lines[0][0].text).toBe("│ ✻ Welcome to Claude");
    expect(lines[1][0].text).toBe("│ /help for commands");
  });

  test("agent block WITHOUT a snapshot → empty (transcript would be garbage)", () => {
    // No blockRows → fall through. Agent transcripts are TUI redraws
    // that linearise into illegible characters, so the helper returns
    // `[]` rather than calling parseAnsi.
    const lines = computeClosedBlockLines(
      undefined,
      "\x1b[?1049h\x1b[2J\x1b[Hclaude ui\x1b[?1049l",
      true,
    );
    expect(lines).toEqual([]);
  });

  test("agent block with EMPTY blockRows → falls through to []", () => {
    // The Rust side trims trailing blank rows from the snapshot; an
    // agent that emitted only "screen-destruction" output would land
    // here. Better an empty body than garbage transcript bytes.
    const lines = computeClosedBlockLines([], "garbage", true);
    expect(lines).toEqual([]);
  });

  test("shell block with blockRows → renders the snapshot (no parseAnsi fallback)", () => {
    const snapshot = [row("total 42"), row("drwxr-xr-x raeedz")];
    const lines = computeClosedBlockLines(snapshot, "raw transcript", false);
    expect(lines.length).toBe(2);
    expect(lines[0][0].text).toBe("total 42");
  });

  test("shell block without blockRows → parseAnsi(transcript)", () => {
    // Legacy in-memory blocks predating the per-block snapshot wire
    // field still need to render. parseAnsi handles SGR + line breaks
    // for shell output. The test asserts at a coarse level (row count
    // > 0) rather than pinning parseAnsi's internals — that's tested
    // elsewhere.
    const lines = computeClosedBlockLines(undefined, "hello\nworld", false);
    expect(lines.length).toBeGreaterThan(0);
  });
});
