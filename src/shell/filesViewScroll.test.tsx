import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

/**
 * Render-level regression guard for the right-panel file tree scroll.
 *
 * Pure-helper tests in `paneSlotLayout.test.ts` lock the CSS contract.
 * This test catches the OTHER half of the same bug: a wrapper component
 * being added between `PaneSlot` and `FileTree` that breaks the flex
 * chain even though the helper itself is unchanged.
 *
 * The specific regression: FilesView used to return
 *
 *     <div style={{ padding, minHeight: 0 }}>
 *       <FileTree ... />
 *     </div>
 *
 * The outer `<div>` defaulted to `flex: 0 1 auto` inside PaneSlot's
 * column-flex layout, so FileTree's `flex: 1 + overflow-y: auto`
 * never engaged. The fix removes the wrapper. This test pins it: the
 * rendered HTML's root element MUST be FileTree's scroll container,
 * not a wrapper.
 *
 * `bun test` does not resolve runtime `@/...` aliases (only type-only
 * imports). All imports are relative.
 */

// Stub the dispatch hook so FilesView can render without a Provider.
// We don't care what dispatch does — we only care about the rendered
// DOM structure. The hook is called during render, so the stub MUST
// be installed before importing the component module.
mock.module("../state/AppState", () => ({
  useAppDispatch: () => () => {},
  useAppState: () => ({}),
  useActiveWorktree: () => null,
  useActiveProject: () => null,
  useActiveTab: () => null,
  useWorktreeTabs: () => [],
}));

const { FilesView } = await import("./RightPanel");

const mockWorktree = {
  id: "w_test",
  projectId: "p_test",
  branch: "main",
  name: "test",
  path: "/tmp/test",
  changeCount: 0,
  agentStatus: "idle" as const,
  agentCli: null,
  createdAt: Date.now(),
  tabIds: [],
  activeTabId: null,
  rightPanel: "files" as const,
  rightSplitPct: 50,
  secondaryTab: "terminal" as const,
  secondaryTerminals: [],
  secondaryActiveTerminalId: null,
  secondaryPtyId: "pty_test",
};

function renderFilesView(): string {
  return renderToStaticMarkup(
    createElement(FilesView, { worktree: mockWorktree as never }),
  );
}

describe("FilesView renders FileTree's scroll container directly", () => {
  test("the root element has overflow-y: auto — proves no non-flex wrapper", () => {
    const html = renderFilesView();
    // The first opening tag must carry `overflow-y: auto`. If FilesView
    // adds a `<div>` wrapper around `<FileTree />`, the first tag will
    // be that wrapper (no overflow-y) and this assertion fails. Pinned
    // bug: a `<div style={{ padding, minHeight: 0 }}>` wrapper used to
    // sit here and broke FileTree's flex/scroll chain.
    expect(html).toMatch(/^<div[^>]*style="[^"]*overflow-y:\s*auto/i);
  });

  test("the root element has flex: 1 — claims the PaneSlot's full height", () => {
    const html = renderFilesView();
    // FileTree's `flex: 1` requires that ITS direct DOM parent be the
    // PaneSlot (a flex column). An intermediate wrapper changes the
    // direct parent and silently strips the effective flex sizing.
    expect(html).toMatch(/^<div[^>]*style="[^"]*flex:\s*1/i);
  });

  test("the root element has min-height: 0 — overflow-auto unlock", () => {
    const html = renderFilesView();
    expect(html).toMatch(/^<div[^>]*style="[^"]*min-height:\s*0/i);
  });

  test("loading state is rendered NESTED inside the scroll container, not as a replacement root", () => {
    // FileTree returns its scroll container as the outer element in
    // every render state (loading / error / loaded). Without that
    // invariant, the "loading…" placeholder (which is what SSR sees
    // because useEffect doesn't fire) would render a wrapper-less
    // padded text div and fool this test into passing while the real
    // loaded-state outer is broken.
    const html = renderFilesView();
    expect(html).toContain("loading");
    // "loading" appears inside the outer scroll container, not as the
    // outer itself — i.e. it sits after the outer div's opening `>`.
    const loadingTextIndex = html.indexOf("loading");
    const outerCloseIndex = html.indexOf(">");
    expect(loadingTextIndex).toBeGreaterThan(outerCloseIndex);
  });
});
