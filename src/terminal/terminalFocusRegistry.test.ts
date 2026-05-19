import { beforeEach, describe, expect, test } from "bun:test";
import {
  focusTerminal,
  getLastInteractedTerminal,
  markTerminalInteracted,
  registerTerminalFocus,
  unregisterTerminalFocus,
} from "./terminalFocusRegistry";

describe("terminalFocusRegistry — focus dispatch", () => {
  beforeEach(() => {
    // Module-scoped state; clear between tests so they're independent.
    unregisterTerminalFocus("tab-a");
    unregisterTerminalFocus("tab-b");
  });

  test("focusTerminal calls the registered function", () => {
    let called = 0;
    registerTerminalFocus("tab-a", () => {
      called++;
    });
    expect(focusTerminal("tab-a")).toBe(true);
    expect(called).toBe(1);
  });

  test("focusTerminal returns false for unknown ids", () => {
    expect(focusTerminal("does-not-exist")).toBe(false);
  });

  test("unregisterTerminalFocus removes the entry", () => {
    registerTerminalFocus("tab-a", () => {});
    unregisterTerminalFocus("tab-a");
    expect(focusTerminal("tab-a")).toBe(false);
  });
});

describe("terminalFocusRegistry — last-interacted disambiguation", () => {
  // The Ctrl+C window-level fallback in BlockTerminal uses
  // getLastInteractedTerminal() to pick exactly one PTY when multiple
  // panes are mounted at once. These tests pin that contract so the
  // multi-pane Ctrl+C path can't regress to "fire 0x03 on every PTY."

  beforeEach(() => {
    unregisterTerminalFocus("tab-a");
    unregisterTerminalFocus("tab-b");
    // Clear "last interacted" by registering+unregistering — there's
    // no public clear() and that's by design (the state is implicit).
    markTerminalInteracted("__reset__");
    unregisterTerminalFocus("__reset__");
  });

  test("markTerminalInteracted records the most recent tab id", () => {
    markTerminalInteracted("tab-a");
    expect(getLastInteractedTerminal()).toBe("tab-a");
    markTerminalInteracted("tab-b");
    expect(getLastInteractedTerminal()).toBe("tab-b");
  });

  test("unregistering the last-interacted tab clears it", () => {
    // Prevents a stale tab id from claiming Ctrl+C after its terminal
    // has been closed — the next Ctrl+C with body focus would
    // otherwise dispatch to a PTY that no longer exists.
    markTerminalInteracted("tab-a");
    unregisterTerminalFocus("tab-a");
    expect(getLastInteractedTerminal()).toBeNull();
  });

  test("unregistering a DIFFERENT tab leaves the last-interacted alone", () => {
    markTerminalInteracted("tab-a");
    registerTerminalFocus("tab-b", () => {});
    unregisterTerminalFocus("tab-b");
    expect(getLastInteractedTerminal()).toBe("tab-a");
  });
});
