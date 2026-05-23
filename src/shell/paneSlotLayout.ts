import type { CSSProperties } from "react";

/**
 * Layout invariants for the right-panel `PaneSlot` keepalive layer and
 * the scrollable lists that mount inside it (the FilesView's FileTree,
 * ChangesView's diff list, SkillsView's grid). The bug these helpers
 * exist to pin:
 *
 *   FilesView used to wrap `<FileTree />` in a plain `<div style={{
 *   padding, minHeight: 0 }}>`. PaneSlot is `display: flex;
 *   flex-direction: column; min-height: 0`, so its child needs `flex: 1`
 *   (claim the column space) AND `min-height: 0` (let internal
 *   `overflow-y: auto` actually scroll). A plain block `<div>` defaults
 *   to `flex: 0 1 auto` — sizes to its content, can shrink, but can't
 *   grow to fill the pane. So the wrapper sized to FileTree's content
 *   height, FileTree's own `flex: 1` had no flex parent to claim space
 *   from, and `overflow-y: auto` had no constrained height to scroll
 *   inside. The user-visible symptom: the file tree's content overflowed
 *   the wrapper, the PaneSlot's `overflow: hidden` clipped it, and no
 *   scrollbar ever appeared.
 *
 * The fix: FilesView renders `<FileTree />` directly as the PaneSlot's
 * child. FileTree's outer element carries `paneSlotScrollChildStyle()`,
 * which encodes the contract that any scrollable list mounted in a
 * PaneSlot must satisfy. The tests in `paneSlotLayout.test.ts` lock the
 * exact styles so a future refactor can't reintroduce the wrapper or
 * weaken the scroll chain.
 */

/**
 * The `PaneSlot` outer wrapper. Absolutely positioned to fill the
 * parent's reserved 1fr grid row, flex-column so its child can claim
 * vertical space via `flex: 1`, `min-height: 0` so the child's
 * `overflow-y: auto` can engage. `active` toggles `display: none` (so
 * inactive panes keep scroll position + internal state without taking
 * any layout space) vs. `display: flex` (so the active pane fills the
 * slot).
 */
export function paneSlotStyle(active: boolean): CSSProperties {
  return {
    position: "absolute",
    inset: 0,
    display: active ? "flex" : "none",
    flexDirection: "column",
    minHeight: 0,
  };
}

/**
 * Contract for a scrollable list rendered as a direct child of a
 * `PaneSlot`. Three properties are required and tested:
 *
 *   - `flex: 1`         — claim the PaneSlot's full vertical space so
 *                         there's something for `overflow-y: auto` to
 *                         scroll inside of.
 *   - `minHeight: 0`    — the standard flex-child unlock for
 *                         `overflow: auto` inside a column-flex parent.
 *                         Without it, the child's intrinsic min-content
 *                         height inflates and the overflow never kicks
 *                         in.
 *   - `overflowY: auto` — the scroll itself.
 *
 * Horizontal scroll is hidden by default because nested horizontal
 * scrollbars in a sidebar pane are almost always a layout bug, not a
 * desired UX (panes are narrow and lists are vertical).
 */
export function paneSlotScrollChildStyle(
  extras: CSSProperties = {},
): CSSProperties {
  return {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    overflowX: "hidden",
    ...extras,
  };
}
