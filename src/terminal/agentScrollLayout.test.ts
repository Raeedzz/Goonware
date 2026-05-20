import { describe, expect, test } from "bun:test";
import {
  agentScrollContainerStyle,
  liveBlockOuterStyle,
  shouldRenderBlockList,
} from "./agentScrollLayout";

/**
 * Regression guards. Two user-reported bugs are pinned here:
 *
 *   A. "i cant scroll in the terminal while an agent is running" —
 *      caused by PR #10 hiding <BlockList /> during agent sessions.
 *   B. "the bottom part of the agent is being cut, I cant scroll" —
 *      caused by the LiveBlock body's `flex: 1 1 0 + overflow: hidden`
 *      capping the canvas wrapper's height. The ResizeObserver on the
 *      wrapper pushed the shrunk height into `renderer.resize()`, and
 *      claude's input row (at the bottom of its grid) was never painted.
 *
 * The invariants below ensure both regressions stay fixed:
 *
 *   1. BlockList renders regardless of agent state — the user must be
 *      able to scroll back into closed-block history during a live
 *      agent session.
 *   2. The fill-mode LiveBlock has a hard, viewport-sized minimum
 *      height (`100cqh`) — a freshly-started agent fills the pane and
 *      a tall sibling BlockList can't squash it to zero.
 *   3. The fill-mode LiveBlock NEVER combines `flex-shrink: 1` with
 *      `min-height: 0` — that's literally the squash recipe.
 *   4. The fill-mode LiveBlock has NO `overflow: hidden`. Otherwise
 *      the canvas inside gets shrunk by flex layout and the
 *      ResizeObserver clips the bottom rows of the agent grid (bug B).
 *      The OUTER scroll container is what owns scrolling.
 *   5. The scroll container declares `container-type: size` so
 *      `100cqh` resolves against its viewport.
 */

describe("shouldRenderBlockList — never hide history during an agent session", () => {
  test("renders BlockList when foregroundIsAgent is true", () => {
    expect(shouldRenderBlockList(true)).toBe(true);
  });

  test("renders BlockList when foregroundIsAgent is false", () => {
    expect(shouldRenderBlockList(false)).toBe(true);
  });
});

describe("liveBlockOuterStyle — fill mode cannot be squashed by sibling history", () => {
  test("fill mode declares a non-zero viewport-sized minHeight", () => {
    const style = liveBlockOuterStyle(true);
    expect(style.minHeight).toBe("100cqh");
  });

  test("fill mode does NOT allow flex-shrink (the squash component)", () => {
    const style = liveBlockOuterStyle(true);
    // `flex` shorthand: `<grow> <shrink> <basis>`. Anything starting
    // with "0 0" (no grow, no shrink) is squash-proof. The legacy
    // value "1 1 0" is what produced the regression — explicitly
    // forbid it (and any shrink: 1).
    expect(style.flex).toBe("0 0 auto");
  });

  test("fill mode preserves flex-column so the canvas can bottom-anchor", () => {
    const style = liveBlockOuterStyle(true);
    expect(style.display).toBe("flex");
    expect(style.flexDirection).toBe("column");
  });

  test("fill mode does NOT set overflow: hidden — that clips the canvas", () => {
    // Bug B regression: `overflow: hidden` here combined with the
    // body's `flex: 1 1 0` caps the canvas wrapper's height at the
    // body viewport. The CanvasGrid wrapper's ResizeObserver then
    // hands the shrunk height to `renderer.resize()` and any rows
    // past that height — claude's input box, the "Press Ctrl-C
    // again" hint — are silently never painted.
    const style = liveBlockOuterStyle(true);
    expect(style.overflow).toBeUndefined();
    expect(style.overflowY).toBeUndefined();
  });

  test("non-fill mode (shell command output) sizes to content", () => {
    const style = liveBlockOuterStyle(false);
    expect(style.flex).toBe("0 0 auto");
    // No viewport-sized min-height in the inline case — shell
    // command output should size to its rows so it scrolls with
    // sibling closed blocks.
    expect(style.minHeight).toBeUndefined();
  });
});

describe("agentScrollContainerStyle — must establish a size containment for cqh", () => {
  test("declares container-type: size so 100cqh resolves to its viewport", () => {
    const style = agentScrollContainerStyle();
    expect(style.containerType).toBe("size");
  });

  test("is itself a column flex container with overflow-y auto", () => {
    const style = agentScrollContainerStyle();
    expect(style.display).toBe("flex");
    expect(style.flexDirection).toBe("column");
    expect(style.overflowY).toBe("auto");
    // Horizontal scroll is the user's enemy in a terminal by default
    // — never auto unless the caller explicitly opts in (right-panel
    // secondary terminal threads `allowHorizontalScroll` so long
    // lines pan instead of clip).
    expect(style.overflowX).toBe("hidden");
  });

  test("opt-in flag enables horizontal scroll for narrow side terminals", () => {
    const style = agentScrollContainerStyle(true);
    expect(style.overflowX).toBe("auto");
    // Vertical scroll behavior must remain unchanged.
    expect(style.overflowY).toBe("auto");
  });

  test("takes the remaining vertical space from its parent", () => {
    const style = agentScrollContainerStyle();
    expect(style.flex).toBe(1);
    // minHeight: 0 is the standard flex-child trick to make the
    // overflow:auto actually take effect inside a column-flex parent.
    expect(style.minHeight).toBe(0);
  });
});
