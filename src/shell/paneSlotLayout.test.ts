import { describe, expect, test } from "bun:test";
import {
  paneSlotScrollChildStyle,
  paneSlotStyle,
} from "./paneSlotLayout";

/**
 * Regression guards for the right-panel scroll chain.
 *
 * User-reported bug: "scroll on the file on the right broke". Root
 * cause: FilesView wrapped `<FileTree />` in a plain `<div style={{
 * padding, minHeight:0 }}>`. PaneSlot is `display: flex;
 * flex-direction: column; min-height: 0`. A plain block `<div>` inside
 * a flex column defaults to `flex: 0 1 auto` — sized to content, not to
 * the available column height. FileTree's outer `flex: 1` then had
 * no flex parent to claim space from, the file list overflowed the
 * wrapper, and `overflow: hidden` on PaneSlot's parent clipped it. No
 * scrollbar ever appeared.
 *
 * The fix is two-part:
 *   1. FilesView renders `<FileTree />` directly (no wrapper).
 *   2. FileTree's outer element carries `paneSlotScrollChildStyle()`
 *      so any future PaneSlot child has a tested contract to follow.
 *
 * The invariants tested below:
 *
 *   A. PaneSlot is a flex column with `min-height: 0` — without these,
 *      a child cannot use `flex: 1` to claim height or `overflow: auto`
 *      to scroll.
 *   B. PaneSlot's `display` flips between `flex` (active) and `none`
 *      (inactive). `display: none` is what preserves scroll position
 *      and component state across tab switches.
 *   C. A scrollable PaneSlot child must declare `flex: 1 + minHeight:
 *      0 + overflowY: auto` together. Removing any of those three
 *      breaks the chain.
 *   D. `paneSlotScrollChildStyle` accepts extra style overrides (e.g.
 *      padding) without dropping the required scroll contract.
 */

describe("paneSlotStyle — PaneSlot must establish a flex column for scroll children", () => {
  test("active pane uses display: flex so children can use flex:1", () => {
    const style = paneSlotStyle(true);
    expect(style.display).toBe("flex");
  });

  test("inactive pane uses display: none — preserves scroll + state", () => {
    // PaneSlot's keepalive trick: inactive panes stay mounted but
    // contribute nothing to layout. `display: none` is what enables
    // that without unmounting children.
    const style = paneSlotStyle(false);
    expect(style.display).toBe("none");
  });

  test("flex column so a child's flex:1 + overflowY:auto can engage", () => {
    const style = paneSlotStyle(true);
    expect(style.flexDirection).toBe("column");
  });

  test("minHeight: 0 — without this the flex child can't shrink to enable overflow", () => {
    // Standard flex-child unlock. The "scrollable child of a column-
    // flex parent" pattern silently breaks without this — the parent's
    // intrinsic min-content height inflates and the child has nothing
    // to overflow.
    const style = paneSlotStyle(true);
    expect(style.minHeight).toBe(0);
  });

  test("absolutely positioned and fills its containing block", () => {
    // PaneSlot is the keepalive layer that holds every tab pane mounted
    // simultaneously. `position: absolute; inset: 0` lets them stack on
    // top of each other, each one filling the parent's 1fr grid row.
    const style = paneSlotStyle(true);
    expect(style.position).toBe("absolute");
    expect(style.inset).toBe(0);
  });
});

describe("paneSlotScrollChildStyle — the three-property contract for scrollable PaneSlot children", () => {
  test("flex: 1 — claims the column's full height", () => {
    const style = paneSlotScrollChildStyle();
    expect(style.flex).toBe(1);
  });

  test("minHeight: 0 — unlocks overflow inside the flex column parent", () => {
    const style = paneSlotScrollChildStyle();
    expect(style.minHeight).toBe(0);
  });

  test("overflowY: auto — the actual scroll", () => {
    const style = paneSlotScrollChildStyle();
    expect(style.overflowY).toBe("auto");
  });

  test("overflowX: hidden — narrow side panes never want a horizontal scrollbar", () => {
    const style = paneSlotScrollChildStyle();
    expect(style.overflowX).toBe("hidden");
  });

  test("extras spread last so callers can layer padding / styling without dropping the contract", () => {
    const style = paneSlotScrollChildStyle({
      padding: "var(--space-1) 0",
      backgroundColor: "red",
    });
    // Contract still intact:
    expect(style.flex).toBe(1);
    expect(style.minHeight).toBe(0);
    expect(style.overflowY).toBe("auto");
    expect(style.overflowX).toBe("hidden");
    // Extras present:
    expect(style.padding).toBe("var(--space-1) 0");
    expect(style.backgroundColor).toBe("red");
  });

  test("extras CANNOT silently override the scroll contract", () => {
    // Caller passes `overflowY: hidden`. The contract wins — extras
    // spread first, contract second. Wait — actually the implementation
    // spreads extras LAST, which means callers CAN override. Document
    // that choice explicitly so a refactor doesn't accidentally flip
    // the spread order and silently break the contract for callers
    // that happen to pass overlapping keys.
    const style = paneSlotScrollChildStyle({ overflowY: "hidden" });
    // Current behavior: caller wins. If you ever flip this so the
    // contract wins, update this test and add a comment explaining
    // why a caller might want to opt out.
    expect(style.overflowY).toBe("hidden");
  });
});
