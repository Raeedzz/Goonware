import { describe, expect, test } from "bun:test";
import {
  classifyPromptSubmission,
  deriveInputMode,
  nextRawLatch,
  type InputModeInput,
} from "./inputModeDecision";

describe("classifyPromptSubmission", () => {
  test("idle input is a new shell command", () => {
    expect(classifyPromptSubmission(false)).toBe("shell-command");
  });

  test("a line entered for a running command is foreground stdin", () => {
    // Canonical prompts such as `gh auth login` may ask for `Y` + Enter
    // without putting the tty into raw mode. The answer must go to gh, not
    // command history or the pending label for the next shell block.
    expect(classifyPromptSubmission(true)).toBe("foreground-stdin");
  });
});

// A bare interactive shell prompt: zsh's ZLE holds the tty in raw mode
// (rawInput true) even though no command is running. This MUST stay in
// shell mode — the whole reason inlineRawPrompt is gated on
// commandRunning.
const idleShell: InputModeInput = {
  exited: false,
  altScreen: false,
  commandRunning: false,
  rawInput: true,
  foregroundIsAgent: false,
  nativeSurface: false,
};

describe("deriveInputMode", () => {
  test("idle shell prompt stays in shell mode despite raw tty (ZLE)", () => {
    const d = deriveInputMode(idleShell);
    expect(d.inlineRawPrompt).toBe(false);
    expect(d.agentMode).toBe(false);
    expect(d.passthroughActive).toBe(false);
  });

  test("non-interactive command (canonical mode) stays in shell mode", () => {
    // e.g. `npm install` — runs in canonical mode, output streams into
    // the LiveBlock. No passthrough; arrows still drive history.
    const d = deriveInputMode({ ...idleShell, commandRunning: true, rawInput: false });
    expect(d.inlineRawPrompt).toBe(false);
    expect(d.agentMode).toBe(false);
    expect(d.passthroughActive).toBe(false);
  });

  test("interactive raw prompt (inquirer/fzf) flips to passthrough", () => {
    // `npx skill download` menu: raw mode + a command running + inline.
    const d = deriveInputMode({ ...idleShell, commandRunning: true, rawInput: true });
    expect(d.inlineRawPrompt).toBe(true);
    expect(d.agentMode).toBe(true);
    expect(d.passthroughActive).toBe(true);
  });

  test("inline agent (claude) uses passthrough regardless of raw flag", () => {
    const d = deriveInputMode({
      ...idleShell,
      commandRunning: true,
      rawInput: false,
      foregroundIsAgent: true,
    });
    expect(d.agentMode).toBe(true);
    expect(d.passthroughActive).toBe(true);
  });

  test("alt-screen TUI: passthrough only on native panes", () => {
    const base = {
      ...idleShell,
      altScreen: true,
      commandRunning: true,
      rawInput: true,
    };
    // Non-native: CanvasGrid owns input, so PtyPassthrough is NOT mounted.
    const nonNative = deriveInputMode({ ...base, nativeSurface: false });
    expect(nonNative.agentMode).toBe(true);
    expect(nonNative.passthroughActive).toBe(false);
    // alt-screen never counts as an inline raw prompt.
    expect(nonNative.inlineRawPrompt).toBe(false);
    // Native: PtyPassthrough forwards keys (no CanvasGrid).
    const native = deriveInputMode({ ...base, nativeSurface: true });
    expect(native.passthroughActive).toBe(true);
  });

  test("anti-jitter latch: feeding latched raw holds passthrough through a canonical gap", () => {
    // Simulate a wizard that flips canonical between questions. The
    // latch keeps rawInput effectively true for the whole command, so
    // deriveInputMode never flips back to shell mid-command.
    const base = { ...idleShell, commandRunning: true };
    let latched = false;
    // Q1 prompt draws raw → latch on.
    latched = nextRawLatch(latched, { ...base, rawInput: true });
    expect(latched).toBe(true);
    expect(deriveInputMode({ ...base, rawInput: latched }).agentMode).toBe(true);
    // Brief canonical gap between Q1 and Q2 (raw bit reads false) — but
    // the latch holds, so the pane does NOT flip back to shell.
    latched = nextRawLatch(latched, { ...base, rawInput: false });
    expect(latched).toBe(true);
    expect(deriveInputMode({ ...base, rawInput: latched }).agentMode).toBe(true);
  });

  describe("nextRawLatch", () => {
    const running = {
      exited: false,
      altScreen: false,
      commandRunning: true,
    };
    test("turns on when a running command goes raw", () => {
      expect(nextRawLatch(false, { ...running, rawInput: true })).toBe(true);
    });
    test("stays on across a canonical gap while the command runs", () => {
      expect(nextRawLatch(true, { ...running, rawInput: false })).toBe(true);
    });
    test("resets when the command ends", () => {
      expect(
        nextRawLatch(true, { ...running, commandRunning: false, rawInput: true }),
      ).toBe(false);
    });
    test("resets on exit and on alt-screen takeover", () => {
      expect(nextRawLatch(true, { ...running, exited: true, rawInput: true })).toBe(
        false,
      );
      expect(
        nextRawLatch(true, { ...running, altScreen: true, rawInput: true }),
      ).toBe(false);
    });
    test("never latches when no command is running (idle shell ZLE)", () => {
      expect(
        nextRawLatch(false, { ...running, commandRunning: false, rawInput: true }),
      ).toBe(false);
    });
  });

  test("after exit, all live flags are ignored and chrome resets to shell", () => {
    const d = deriveInputMode({
      exited: true,
      altScreen: true,
      commandRunning: true,
      rawInput: true,
      foregroundIsAgent: true,
      nativeSurface: true,
    });
    expect(d.inlineRawPrompt).toBe(false);
    expect(d.agentMode).toBe(false);
    expect(d.passthroughActive).toBe(false);
  });

  test("after an inline agent exits, its stale foreground flag cannot keep passthrough mounted", () => {
    const d = deriveInputMode({
      ...idleShell,
      exited: true,
      commandRunning: false,
      rawInput: false,
      foregroundIsAgent: true,
    });
    expect(d).toEqual({
      inlineRawPrompt: false,
      agentMode: false,
      passthroughActive: false,
    });
  });
});
