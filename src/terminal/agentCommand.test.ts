import { describe, expect, test } from "bun:test";
import {
  detectAgentCommand,
  makeCodexScrollable,
} from "./agentCommand";

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
    ["  codex\tresume --last", "  codex --no-alt-screen\tresume --last"],
    ["command codex", "command codex --no-alt-screen"],
    ["command -- codex", "command -- codex --no-alt-screen"],
    ["command -p codex", "command -p codex --no-alt-screen"],
    ["exec codex", "exec codex --no-alt-screen"],
    ["exec -a agent-session codex", "exec -a agent-session codex --no-alt-screen"],
    ["time codex", "time codex --no-alt-screen"],
    ["time -p codex", "time -p codex --no-alt-screen"],
    ["noglob codex", "noglob codex --no-alt-screen"],
    [
      "env DEBUG_LABEL='one two' codex --search",
      "env DEBUG_LABEL='one two' codex --no-alt-screen --search",
    ],
    ["env -i codex", "env -i codex --no-alt-screen"],
    ["env -u HOME codex", "env -u HOME codex --no-alt-screen"],
    ["env -- codex", "env -- codex --no-alt-screen"],
    ["CODEX_HOME=/tmp CODEX", "CODEX_HOME=/tmp CODEX --no-alt-screen"],
  ])("adds inline mode to %p", (input, expected) => {
    expect(makeCodexScrollable(input)).toBe(expected);
  });

  test.each([
    "codex --no-alt-screen",
    "codex --no-alt-screen resume --last",
    "claude",
    "echo codex",
    "command -v codex",
    "env -S 'codex --search'",
    "env --split-string 'codex --search'",
    "codex '--no-alt-screen'",
    "env",
    "env -u HOME",
    "printf '%s' codex",
    "",
  ])("leaves %p unchanged", (input) => {
    expect(makeCodexScrollable(input)).toBe(input);
  });
});

describe("detectAgentCommand", () => {
  const cases: Array<[string, ReturnType<typeof detectAgentCommand>]> = [
    ["claude", "claude"],
    ["claude-code --resume", "claude"],
    ["env TOKEN='one two' codex resume --last", "codex"],
    ["command /opt/homebrew/bin/gemini-cli", "gemini"],
    ["exec aider-chat", "aider"],
    ["copilot", "copilot"],
    ["env GH_TOKEN=x github-copilot", "copilot"],
    ["time noglob codex", "codex"],
    ["env DEBUG=1 time -p codex", "codex"],
    ["echo codex", null],
    ["command -v codex", null],
    ["", null],
  ];
  test.each(cases)("detects %p as %p", (input, expected) => {
    expect(detectAgentCommand(input)).toBe(expected);
  });
});
