import { describe, expect, test } from "bun:test";
import {
  focusTerminalInputLayer,
  shouldPreserveTerminalSelection,
} from "./terminalClickFocus";

describe("shouldPreserveTerminalSelection", () => {
  test("preserves a selection made in the clicked terminal", () => {
    expect(
      shouldPreserveTerminalSelection({
        collapsed: false,
        textLength: 12,
        anchorInside: true,
        focusInside: true,
      }),
    ).toBe(true);
  });

  test("allows focus when the selection belongs to another pane", () => {
    expect(
      shouldPreserveTerminalSelection({
        collapsed: false,
        textLength: 12,
        anchorInside: false,
        focusInside: false,
      }),
    ).toBe(false);
  });

  test("allows focus when there is no active selection", () => {
    expect(
      shouldPreserveTerminalSelection({
        collapsed: true,
        textLength: 0,
        anchorInside: true,
        focusInside: true,
      }),
    ).toBe(false);
  });

  test("preserves a selection dragged beyond the terminal edge", () => {
    expect(
      shouldPreserveTerminalSelection({
        collapsed: false,
        textLength: 12,
        anchorInside: true,
        focusInside: false,
      }),
    ).toBe(true);
  });
});

describe("focusTerminalInputLayer", () => {
  test("focuses the preferred mounted layer", () => {
    const calls: string[] = [];
    const result = focusTerminalInputLayer({
      passthroughPreferred: true,
      passthrough: { focus: () => calls.push("passthrough") },
      prompt: { focus: () => calls.push("prompt") },
    });
    expect(result).toBe("passthrough");
    expect(calls).toEqual(["passthrough"]);
  });

  test("falls back to prompt when passthrough mode commits before its ref", () => {
    const calls: string[] = [];
    const result = focusTerminalInputLayer({
      passthroughPreferred: true,
      passthrough: null,
      prompt: { focus: () => calls.push("prompt") },
    });
    expect(result).toBe("prompt");
    expect(calls).toEqual(["prompt"]);
  });

  test("falls back to passthrough when shell mode commits before prompt mounts", () => {
    const calls: string[] = [];
    const result = focusTerminalInputLayer({
      passthroughPreferred: false,
      passthrough: { focus: () => calls.push("passthrough") },
      prompt: null,
    });
    expect(result).toBe("passthrough");
    expect(calls).toEqual(["passthrough"]);
  });

  test("is a safe no-op while both layers are unmounted", () => {
    expect(
      focusTerminalInputLayer({
        passthroughPreferred: true,
        passthrough: null,
        prompt: null,
      }),
    ).toBeNull();
  });

  test("survives rapid alternating mode snapshots without missing focus", () => {
    let focused = 0;
    const input = { focus: () => focused++ };
    for (let i = 0; i < 1_000; i += 1) {
      const preferPassthrough = i % 2 === 0;
      expect(
        focusTerminalInputLayer({
          passthroughPreferred: preferPassthrough,
          passthrough: preferPassthrough ? input : null,
          prompt: preferPassthrough ? null : input,
        }),
      ).not.toBeNull();
    }
    expect(focused).toBe(1_000);
  });
});
