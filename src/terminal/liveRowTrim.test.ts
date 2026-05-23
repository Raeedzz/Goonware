import { describe, expect, test } from "bun:test";
import { fallbackTail, trimEchoAndBlanks } from "./liveRowTrim";
import type { DirtyRow, Span } from "./types";

/**
 * Pins the agent-row trimming behavior LiveBlock relies on. The
 * critical regression class: when an agent emits clear-screen +
 * cursor-home mid-redraw, `cursor_row` lands near 0 and the
 * `footerKeep = cursor_row + 5` floor in LiveBlock used to drop
 * every populated row in the grid. Trim returned [], the canvas
 * painted nothing, the user saw "content gone, chrome visible"
 * with no recovery. `fallbackTail` is the safety net for that case.
 */

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

function row(index: number, text: string): DirtyRow {
  return { row: index, spans: [span(text)] };
}

function blank(index: number): DirtyRow {
  return { row: index, spans: [span("")] };
}

describe("trimEchoAndBlanks", () => {
  test("drops leading blanks and the echoed command", () => {
    const rows = [blank(0), row(1, "echo hi"), row(2, "hi")];
    const trimmed = trimEchoAndBlanks(rows, "echo hi");
    expect(trimmed.map((r) => r.row)).toEqual([2]);
  });

  test("drops trailing blanks when no footer floor", () => {
    const rows = [row(0, "a"), row(1, "b"), blank(2), blank(3)];
    const trimmed = trimEchoAndBlanks(rows, "");
    expect(trimmed.map((r) => r.row)).toEqual([0, 1]);
  });

  test("keeps trailing blanks through footerKeepThroughRow", () => {
    const rows = [row(0, "a"), blank(1), blank(2), blank(3)];
    const trimmed = trimEchoAndBlanks(rows, "", 3);
    expect(trimmed.map((r) => r.row)).toEqual([0, 1, 2, 3]);
  });

  test("returns [] when all rows are blank and no floor protects them", () => {
    const rows = [blank(0), blank(1), blank(2)];
    expect(trimEchoAndBlanks(rows, "")).toEqual([]);
  });

  test("footerKeep floor below the populated tail does NOT discard populated rows", () => {
    // The trim is conservative: i walks past leading blanks to the
    // first non-blank, j walks back from end to the last non-blank,
    // and footerKeepThroughRow can only PROMOTE j upward (never demote).
    // So populated content at rows 20..29 with footerKeep=5 still
    // survives — slice is [20, 29] inclusive. The bug class fallbackTail
    // exists to defend against is the i > j case, not this one.
    const rows: DirtyRow[] = [];
    for (let i = 0; i < 20; i++) rows.push(blank(i));
    for (let i = 20; i < 30; i++) rows.push(row(i, `content ${i}`));
    const trimmed = trimEchoAndBlanks(rows, "", 5);
    expect(trimmed.map((r) => r.row)).toEqual([
      20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
    ]);
  });
});

describe("fallbackTail", () => {
  test("anchors at the last populated row and walks back maxRows", () => {
    // The agent-mode rescue case: blank rows 0-19, populated 20-29.
    // With maxRows=10, the function should return exactly the
    // populated tail [20..29] — no leading blank padding.
    const rows: DirtyRow[] = [];
    for (let i = 0; i < 20; i++) rows.push(blank(i));
    for (let i = 20; i < 30; i++) rows.push(row(i, `content ${i}`));
    const tail = fallbackTail(rows, 10);
    expect(tail.map((r) => r.row)).toEqual([
      20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
    ]);
  });

  test("when maxRows exceeds the grid, returns from row 0 through last populated", () => {
    // Includes intervening blanks. The canvas paints them as blank
    // lines — cheaper than a per-row skip and preserves any
    // intentional spacing in the agent's layout.
    const rows: DirtyRow[] = [];
    for (let i = 0; i < 20; i++) rows.push(blank(i));
    for (let i = 20; i < 30; i++) rows.push(row(i, `content ${i}`));
    const tail = fallbackTail(rows, 100);
    expect(tail.length).toBe(30);
    expect(tail[0].row).toBe(0);
    expect(tail[tail.length - 1].row).toBe(29);
  });

  test("caps at maxRows when populated region is larger", () => {
    const rows: DirtyRow[] = [];
    for (let i = 0; i < 30; i++) rows.push(row(i, `content ${i}`));
    const tail = fallbackTail(rows, 5);
    expect(tail.map((r) => r.row)).toEqual([25, 26, 27, 28, 29]);
  });

  test("ignores trailing blanks when anchoring to the last populated row", () => {
    const rows: DirtyRow[] = [
      row(0, "a"),
      row(1, "b"),
      blank(2),
      blank(3),
      blank(4),
    ];
    const tail = fallbackTail(rows, 10);
    expect(tail.map((r) => r.row)).toEqual([0, 1]);
  });

  test("returns [] when the grid is entirely blank", () => {
    const rows = [blank(0), blank(1), blank(2)];
    expect(fallbackTail(rows, 10)).toEqual([]);
  });

  test("returns [] for an empty input", () => {
    expect(fallbackTail([], 10)).toEqual([]);
  });
});
