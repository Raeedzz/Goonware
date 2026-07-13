import { describe, expect, test } from "bun:test";
import { shouldPreserveTerminalSelection } from "./terminalClickFocus";

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
