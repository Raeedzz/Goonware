import { describe, expect, test } from "bun:test";
import {
  detectAgentBanner,
  detectClaude,
  formatDuration,
  formatTokenCount,
} from "./claudeUsage";

describe("detectClaude", () => {
  test("matches the Claude Code banner case-insensitively", () => {
    expect(detectClaude("Claude Code v1.2.3")).toBe(true);
    expect(detectClaude("CLAUDE CODE")).toBe(true);
    expect(detectClaude("welcome to claude code, raeed")).toBe(true);
  });

  test("matches the Claude TUI welcome glyph", () => {
    expect(detectClaude("│ ✻ Welcome to Claude")).toBe(true);
  });

  test("matches anthropic.com mentions", () => {
    expect(detectClaude("Visit https://anthropic.com for docs")).toBe(true);
  });

  test("returns false for unrelated terminal output", () => {
    expect(detectClaude("$ ls -la\ntotal 42\ndrwxr-xr-x ...")).toBe(false);
    expect(detectClaude("npm install ✓")).toBe(false);
    expect(detectClaude("")).toBe(false);
  });

  test("returns false for the substring 'claude' alone (must be Claude Code)", () => {
    expect(detectClaude("claude")).toBe(false);
    expect(detectClaude("a user named claude")).toBe(false);
  });
});

describe("detectAgentBanner", () => {
  test("classifies the Claude banner", () => {
    expect(detectAgentBanner("│ ✻ Welcome to Claude")).toBe("claude");
    expect(detectAgentBanner("Claude Code v1.2.3")).toBe("claude");
  });

  test("classifies the Codex banner case-insensitively", () => {
    expect(detectAgentBanner("OpenAI Codex (v0.42.0)")).toBe("codex");
    expect(detectAgentBanner(">_ openai codex")).toBe("codex");
  });

  test("classifies the Gemini banner", () => {
    expect(detectAgentBanner("Tips for getting started:")).toBe("gemini");
  });

  test("returns null for plain shell output", () => {
    expect(detectAgentBanner("$ ls -la\ntotal 42")).toBe(null);
    expect(detectAgentBanner("")).toBe(null);
  });

  test("the bare CLI name is not a banner", () => {
    expect(detectAgentBanner("codex")).toBe(null);
    expect(detectAgentBanner("gemini")).toBe(null);
  });
});

describe("formatTokenCount", () => {
  test("under 1k stays as a plain integer", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(42)).toBe("42");
    expect(formatTokenCount(999)).toBe("999");
  });

  test("uses one decimal place between 1k and 10k", () => {
    expect(formatTokenCount(1000)).toBe("1.0k");
    expect(formatTokenCount(2_500)).toBe("2.5k");
    expect(formatTokenCount(9_900)).toBe("9.9k");
  });

  test("drops the decimal between 10k and 1M", () => {
    expect(formatTokenCount(10_000)).toBe("10k");
    expect(formatTokenCount(123_456)).toBe("123k");
    expect(formatTokenCount(999_999)).toBe("1000k");
  });

  test("switches to M-suffix above 1M", () => {
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
    expect(formatTokenCount(2_500_000)).toBe("2.5M");
    expect(formatTokenCount(15_000_000)).toBe("15M");
  });
});

describe("formatDuration", () => {
  test("returns '0m' for non-positive input", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(-500)).toBe("0m");
  });

  test("uses seconds when under a minute", () => {
    expect(formatDuration(45_000)).toBe("45s");
  });

  test("uses minutes-only when under an hour", () => {
    expect(formatDuration(30 * 60 * 1000)).toBe("30m");
    expect(formatDuration(59 * 60 * 1000)).toBe("59m");
  });

  test("uses hours+minutes when over an hour, zero-padding the minutes", () => {
    expect(formatDuration(60 * 60 * 1000)).toBe("1h 00m");
    expect(formatDuration(2 * 60 * 60 * 1000 + 5 * 60 * 1000)).toBe("2h 05m");
    expect(formatDuration(5 * 60 * 60 * 1000)).toBe("5h 00m");
  });
});
