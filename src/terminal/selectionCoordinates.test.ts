import { describe, expect, test } from "bun:test";
import { gridSelectionToWindow } from "./CanvasGrid";

/**
 * Pins the grid→window selection translation that anchors a user's
 * mouse-drag selection to original-grid coordinates instead of
 * window-relative ones. The regression class: when a large agent
 * output arrives mid-selection (or the user selects, then scrollback
 * grows), the visible highlight used to drift to a different cell
 * range because the stored coords were window-relative. After this
 * change the highlight stays anchored to the cells the user actually
 * clicked, regardless of `firstRowOffset` shifts.
 */

describe("gridSelectionToWindow", () => {
  test("returns null for a null selection", () => {
    expect(gridSelectionToWindow(null, 0, 30)).toBeNull();
  });

  test("identity translation when offset is 0", () => {
    const sel = { startRow: 3, startCol: 1, endRow: 5, endCol: 7 };
    expect(gridSelectionToWindow(sel, 0, 30)).toEqual(sel);
  });

  test("subtracts the offset from both rows; cols pass through", () => {
    // Scrollback grew by 50 rows, so firstRowOffset is -50. The
    // user's drag at window rows 5..10 was stored as grid rows
    // -45..-40. Translating back to window for the renderer must
    // give 5..10 again.
    const grid = { startRow: -45, startCol: 4, endRow: -40, endCol: 18 };
    const win = gridSelectionToWindow(grid, -50, 24);
    expect(win).toEqual({ startRow: 5, startCol: 4, endRow: 10, endCol: 18 });
  });

  test("translation survives a firstRowOffset shift (round-trip)", () => {
    // User drags at window rows 5..10 with offset=-50: grid coords
    // become -45..-40. A large output arrives, scrollback prepends
    // another 100 rows, offset drops to -150. The renderer should
    // now paint the highlight at window rows 105..110 — same cells
    // (in grid space) the user originally clicked, just further down
    // the visible window after the shift.
    const grid = { startRow: -45, startCol: 4, endRow: -40, endCol: 18 };
    const win = gridSelectionToWindow(grid, -150, 200);
    expect(win).toEqual({
      startRow: 105,
      startCol: 4,
      endRow: 110,
      endCol: 18,
    });
  });

  test("returns null when the selection is entirely above the window", () => {
    // Grid rows -100..-90 with offset=-50, windowSize=24 →
    // window rows -50..-40, all negative → outside window → null.
    const grid = { startRow: -100, startCol: 0, endRow: -90, endCol: 10 };
    expect(gridSelectionToWindow(grid, -50, 24)).toBeNull();
  });

  test("returns null when the selection is entirely below the window", () => {
    const grid = { startRow: 50, startCol: 0, endRow: 60, endCol: 10 };
    expect(gridSelectionToWindow(grid, 0, 24)).toBeNull();
  });

  test("keeps a selection that partially overlaps the window (above)", () => {
    // Selection spans grid -10..5, window is rows 0..23 (offset 0).
    // Translated: -10..5. lo=-10, hi=5, hi>=0 and lo<24, so the
    // helper returns the un-clipped translated selection — the
    // renderer's own per-cell test then naturally ignores the
    // negative rows.
    const grid = { startRow: -10, startCol: 0, endRow: 5, endCol: 10 };
    const win = gridSelectionToWindow(grid, 0, 24);
    expect(win).toEqual({ startRow: -10, startCol: 0, endRow: 5, endCol: 10 });
  });

  test("keeps a selection that partially overlaps the window (below)", () => {
    const grid = { startRow: 20, startCol: 0, endRow: 35, endCol: 10 };
    const win = gridSelectionToWindow(grid, 0, 24);
    expect(win).toEqual({
      startRow: 20,
      startCol: 0,
      endRow: 35,
      endCol: 10,
    });
  });

  test("handles reversed-order selection (drag from end to start)", () => {
    // The renderer canonicalises start/end, so we don't need to —
    // just translate both points as-given.
    const grid = { startRow: 10, startCol: 5, endRow: 3, endCol: 0 };
    const win = gridSelectionToWindow(grid, 0, 24);
    expect(win).toEqual({ startRow: 10, startCol: 5, endRow: 3, endCol: 0 });
  });
});
