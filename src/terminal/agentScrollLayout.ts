import type { CSSProperties } from "react";

/**
 * Layout decisions for the agent-mode scroll region. Pulled out as
 * pure helpers so the regression pinned by the tests below stays
 * locked-in: while an agent (claude/codex/aider/gemini) is foreground,
 * the user MUST still be able to scroll back through closed blocks.
 *
 * History of the regression these helpers exist to prevent:
 *   - PR #9 made closed agent blocks carry full scrollback. Suddenly
 *     a recently-closed claude block could be hundreds of rows tall.
 *   - PR #10 noticed those tall blocks would squash the new agent's
 *     LiveBlock (flex: 1 1 0 + minHeight: 0 lets it shrink to nothing).
 *     The quick fix: hide BlockList entirely while an agent owns the
 *     foreground.
 *   - That fix broke the ability to scroll back through history during
 *     a live agent session — the user reported "i cant scroll in the
 *     terminal while an agent is running", calling it a huge regression.
 *
 * Correct fix: keep BlockList visible AND give the fill-mode LiveBlock
 * a hard minimum size equal to the scroll container's viewport so it
 * can never be squashed by sibling content. The container query unit
 * `cqh` resolves against the nearest size-typed container (the scroll
 * container, set via `agentScrollContainerStyle`).
 */

/**
 * Should the BlockList render? Always true. The parameter is taken so
 * callers stay honest about WHY they're rendering it — past code
 * gated it on `!foregroundIsAgent` and that's exactly the regression
 * we're guarding against. Take the agent state, ignore it, return true.
 */
export function shouldRenderBlockList(_foregroundIsAgent: boolean): boolean {
  return true;
}

/**
 * Styles for the scroll container that wraps `<BlockList>` + the
 * `<LiveBlock>`. The `containerType: "size"` is what makes `100cqh`
 * inside the LiveBlock resolve to this element's measured height.
 */
export function agentScrollContainerStyle(): CSSProperties {
  return {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
    overflowX: "hidden",
    // Establishes a size-typed query container so the fill-mode
    // LiveBlock below can use `100cqh` to claim a hard min-height
    // equal to this viewport. Without this, the `cqh` units would
    // resolve against the small initial containing block and the
    // LiveBlock would either collapse or grow unbounded.
    containerType: "size",
  };
}

/**
 * Outer-flex layout for the LiveBlock. Returns the props that decide
 * "does this block fill the pane (agent owning the surface) or size
 * to its content (shell command output inline in scrollback)?".
 *
 * The fill case is the one this module exists to defend. It MUST:
 *  - have a non-zero, viewport-sized minimum height (so a tall
 *    BlockList above can't squash it),
 *  - NOT combine `flex-shrink: 1` with `min-height: 0` (the original
 *    PR #9 squash recipe),
 *  - keep `display: flex; flex-direction: column` so the agent canvas
 *    inside can anchor to flex-end (input box flush at bottom).
 */
export function liveBlockOuterStyle(fill: boolean): CSSProperties {
  if (!fill) {
    return {
      flex: "0 0 auto",
      display: "flex",
      flexDirection: "column",
    };
  }
  return {
    // Don't grow, don't shrink — take exactly our min-height.
    flex: "0 0 auto",
    // Hard floor: the scroll container's viewport. With BlockList
    // above (also non-shrinkable, content-sized), the scroll container
    // becomes naturally scrollable whenever there's history — and the
    // LiveBlock itself never collapses below the visible viewport, no
    // matter how tall the history is.
    minHeight: "100cqh",
    display: "flex",
    flexDirection: "column",
    // Clip the agent's own overflow; the parent scroll container is
    // what handles user-visible scrolling, never this block's interior.
    overflow: "hidden",
  };
}
