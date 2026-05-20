import type { CSSProperties } from "react";

/**
 * Layout decisions for the agent-mode scroll region. Pulled out as
 * pure helpers so the regressions pinned by the tests below stay
 * locked-in: while an agent (claude/codex/aider/gemini) is foreground,
 * the user MUST still be able to scroll back through closed blocks
 * AND see the entire live agent UI (including the bottom input row).
 *
 * History of the regressions these helpers exist to prevent:
 *   - PR #9 made closed agent blocks carry full scrollback. Suddenly
 *     a recently-closed claude block could be hundreds of rows tall.
 *   - PR #10 noticed those tall blocks would squash the new agent's
 *     LiveBlock (flex: 1 1 0 + minHeight: 0 lets it shrink to nothing).
 *     The quick fix: hide BlockList entirely while an agent owns the
 *     foreground.
 *   - That fix broke the ability to scroll back through history during
 *     a live agent session — the user reported "i cant scroll in the
 *     terminal while an agent is running", calling it a huge regression.
 *   - PR #11 fixed scrollback by keeping BlockList visible and pinning
 *     the fill-mode LiveBlock with `minHeight: 100cqh + overflow: hidden`.
 *     But the body inside had `flex: 1 1 0 + overflow: hidden`, capping
 *     its height at the LiveBlock viewport. The CanvasGrid wrapper
 *     (default `flex-shrink: 1`) then shrank to fit, the ResizeObserver
 *     pushed those shrunk dimensions to the renderer, and any agent
 *     rows past the shrunk height — including claude's input row at
 *     the bottom of its grid — never got painted. User report: "the
 *     bottom part of the agent is being cut, I cant scroll".
 *
 * Correct fix (Warp-style): keep BlockList visible, give the fill-mode
 * LiveBlock a viewport-sized MINIMUM (so a freshly-started agent fills
 * the pane and the input box sits at the bottom), but let the LiveBlock
 * GROW past 100cqh when the canvas has more content than fits. The
 * outer scroll container then handles all scrolling — closed blocks
 * above and the full live agent canvas below are one continuous
 * transcript, just like Warp. No `overflow: hidden` anywhere on the
 * LiveBlock path, so the canvas is always rendered at its natural
 * row × cellHeight size and nothing is silently clipped.
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
 *
 * `allowHorizontalScroll` opts an individual terminal into a
 * horizontally-scrollable viewport. Default is off because the PTY
 * already sizes its grid to the container width — horizontal scroll
 * is normally just a footgun. The right-panel secondary terminal
 * passes true so long lines in closed blocks (and the narrow live
 * grid) can be panned via trackpad without truncation. Pair with
 * the `gli-no-horizontal-scrollbar` class to suppress the track.
 */
export function agentScrollContainerStyle(
  allowHorizontalScroll = false,
): CSSProperties {
  return {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
    overflowX: allowHorizontalScroll ? "auto" : "hidden",
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
 *    BlockList above can't squash it AND a freshly-started agent fills
 *    the pane rather than floating as a small box above empty space),
 *  - NOT combine `flex-shrink: 1` with `min-height: 0` (the original
 *    PR #9 squash recipe),
 *  - NOT clip its own overflow — the canvas must be allowed to render
 *    at its full row × cellHeight size, and any excess above the
 *    viewport is handled by the outer scroll container.
 *  - keep `display: flex; flex-direction: column` so the agent canvas
 *    inside can anchor to flex-end when shorter than the viewport
 *    (input box flush at the bottom) and grow naturally past 100cqh
 *    when taller.
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
    // Don't grow, don't shrink — natural-size to children, which
    // means the LiveBlock grows past 100cqh whenever the canvas is
    // taller than the viewport. The outer scroll container then has
    // enough scrollHeight to expose every row.
    flex: "0 0 auto",
    // Hard floor: the scroll container's viewport. With BlockList
    // above (also non-shrinkable, content-sized), the scroll container
    // becomes naturally scrollable whenever there's history — and the
    // LiveBlock itself never collapses below the visible viewport, no
    // matter how tall the history is. NOTE: this is a MIN, not a max:
    // when the agent's canvas is taller than 100cqh the LiveBlock
    // grows to fit and the outer scroll handles the overflow.
    minHeight: "100cqh",
    display: "flex",
    flexDirection: "column",
    // Intentionally NO `overflow: hidden`. Past versions clipped here
    // and the canvas wrapper inside got shrunk by flex layout, which
    // wiped the bottom rows (claude's input box). The outer scroll
    // container owns scroll; this block just sizes to its contents.
  };
}
