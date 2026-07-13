import { describe, expect, test } from "bun:test";
import { makeCodexScrollable } from "./agentCommand";

describe("makeCodexScrollable", () => {
  test.each([
    ["codex", "codex --no-alt-screen"],
    ["codex resume --last", "codex --no-alt-screen resume --last"],
    [
      "/opt/homebrew/bin/codex --search",
      "/opt/homebrew/bin/codex --no-alt-screen --search",
    ],
    ["codex-cli", "codex-cli --no-alt-screen"],
    [
      "DEBUG_LABEL='one two' codex -m gpt-5",
      "DEBUG_LABEL='one two' codex --no-alt-screen -m gpt-5",
    ],
    [
      '"/opt/homebrew/bin/codex" resume',
      '"/opt/homebrew/bin/codex" --no-alt-screen resume',
    ],
  ])("adds inline mode to %p", (input, expected) => {
    expect(makeCodexScrollable(input)).toBe(expected);
  });

  test.each([
    "codex --no-alt-screen",
    "codex --no-alt-screen resume --last",
    "claude",
    "echo codex",
    "",
  ])("leaves %p unchanged", (input) => {
    expect(makeCodexScrollable(input)).toBe(input);
  });
});
