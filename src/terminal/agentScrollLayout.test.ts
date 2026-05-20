import { describe, expect, test } from "bun:test";
import {
  agentScrollContainerStyle,
  liveBlockOuterStyle,
  shouldRenderBlockList,
} from "./agentScrollLayout";

/**
 * Regression guard: the user reported "i cant scroll in the terminal
 * while an agent is running" after PR #10 hid <BlockList /> entirely
 * during agent sessions. These tests pin three invariants so the
 * regression can't sneak back:
 *
 *   1. BlockList renders regardless of agent state — the user must be
 *      able to scroll back into closed-block history during a live
 *      agent session.
 *   2. The fill-mode LiveBlock has a hard, viewport-sized minimum
 *      height (`100cqh`). Without this, a tall sibling BlockList
 *      would squash the LiveBlock to zero (the original PR #9 bug
 *      that PR #10 tried to side-step the wrong way).
 *   3. The fill-mode LiveBlock NEVER combines `flex-shrink: 1` with
 *      `min-height: 0` — that's literally the squash recipe.
 *   4. The scroll container declares `container-type: size` so
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
    // Horizontal scroll is the user's enemy in a terminal — never auto.
    expect(style.overflowX).toBe("hidden");
  });

  test("takes the remaining vertical space from its parent", () => {
    const style = agentScrollContainerStyle();
    expect(style.flex).toBe(1);
    // minHeight: 0 is the standard flex-child trick to make the
    // overflow:auto actually take effect inside a column-flex parent.
    expect(style.minHeight).toBe(0);
  });
});
