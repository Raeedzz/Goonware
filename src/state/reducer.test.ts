import { describe, expect, test } from "bun:test";
import { INITIAL_STATE, reducer } from "./reducer";
import type { AppState, CommitTab, MarkdownTab, Tab, Worktree } from "./types";

const worktree = (id: string, projectId: string): Worktree => ({
  id,
  projectId,
  branch: id,
  name: id,
  path: `/tmp/${id}`,
  changeCount: 0,
  agentStatus: "idle",
  agentCli: null,
  createdAt: 0,
  tabIds: [],
  activeTabId: null,
  rightPanel: "files",
  rightSplitPct: 50,
  secondaryTab: "terminal",
  secondaryTerminals: [`pty_${id}`],
  secondaryActiveTerminalId: `pty_${id}`,
  secondaryPtyId: `pty_${id}`,
});

const seed = (worktrees: Worktree[]): AppState => ({
  ...INITIAL_STATE,
  worktrees: Object.fromEntries(worktrees.map((w) => [w.id, w])),
});

const commitTab = (id: string, worktreeId: string, hash: string): CommitTab => ({
  id,
  worktreeId,
  kind: "commit",
  hash,
  title: hash,
  summary: hash.slice(0, 7),
  summaryUpdatedAt: 0,
});

const markdownTab = (
  id: string,
  worktreeId: string,
  filePath: string,
  openAt?: { line: number; column: number },
): MarkdownTab => ({
  id,
  worktreeId,
  kind: "markdown",
  filePath,
  mode: "edit",
  content: null,
  savedContent: null,
  title: filePath,
  summary: filePath,
  summaryUpdatedAt: 0,
  openAt,
});

const open = (state: AppState, tab: Tab) =>
  reducer(state, { type: "open-tab", tab });

describe("open-tab dedup", () => {
  test("re-opening the same commit focuses the existing tab", () => {
    let s = seed([worktree("w1", "p1")]);
    s = open(s, commitTab("t1", "w1", "abc123"));
    s = open(s, commitTab("t2", "w1", "abc123"));
    expect(s.worktrees.w1.tabIds).toEqual(["t1"]);
    expect(s.worktrees.w1.activeTabId).toBe("t1");
    expect(s.tabs.t2).toBeUndefined();
  });

  test("a different commit still opens its own tab", () => {
    let s = seed([worktree("w1", "p1")]);
    s = open(s, commitTab("t1", "w1", "abc123"));
    s = open(s, commitTab("t2", "w1", "def456"));
    expect(s.worktrees.w1.tabIds).toEqual(["t1", "t2"]);
    expect(s.worktrees.w1.activeTabId).toBe("t2");
  });

  test("same file in another worktree is NOT deduped", () => {
    let s = seed([worktree("w1", "p1"), worktree("w2", "p1")]);
    s = open(s, markdownTab("t1", "w1", "README.md"));
    s = open(s, markdownTab("t2", "w2", "README.md"));
    expect(s.worktrees.w1.tabIds).toEqual(["t1"]);
    expect(s.worktrees.w2.tabIds).toEqual(["t2"]);
  });

  test("reused editor tab keeps its state but takes the new jump target", () => {
    let s = seed([worktree("w1", "p1")]);
    s = open(s, markdownTab("t1", "w1", "README.md"));
    // Simulate unsaved edits, and another tab being active so the
    // reused tab will remount (and consume openAt) on activation.
    s = {
      ...s,
      tabs: { ...s.tabs, t1: { ...s.tabs.t1, content: "dirty" } as Tab },
    };
    s = open(s, commitTab("tc", "w1", "abc123"));
    s = open(s, markdownTab("t2", "w1", "README.md", { line: 7, column: 2 }));
    const t1 = s.tabs.t1 as MarkdownTab;
    expect(s.worktrees.w1.tabIds).toEqual(["t1", "tc"]);
    expect(s.worktrees.w1.activeTabId).toBe("t1");
    expect(t1.content).toBe("dirty");
    expect(t1.openAt).toEqual({ line: 7, column: 2 });
  });

  test("openAt is NOT carried onto the already-active tab", () => {
    // The active tab's editor consumed openAt at mount; patching it on
    // would never jump and the stale target would persist.
    let s = seed([worktree("w1", "p1")]);
    s = open(s, markdownTab("t1", "w1", "README.md"));
    s = open(s, markdownTab("t2", "w1", "README.md", { line: 7, column: 2 }));
    expect((s.tabs.t1 as MarkdownTab).openAt).toBeUndefined();
  });

  test("clean reused tab adopts freshly-read content; dirty keeps edits", () => {
    let s = seed([worktree("w1", "p1")]);
    s = open(s, {
      ...markdownTab("t1", "w1", "README.md"),
      content: "old",
      savedContent: "old",
    });
    s = open(s, {
      ...markdownTab("t2", "w1", "README.md"),
      content: "fresh",
      savedContent: "fresh",
    });
    expect((s.tabs.t1 as MarkdownTab).content).toBe("fresh");
    expect((s.tabs.t1 as MarkdownTab).savedContent).toBe("fresh");
  });

  test("terminals never dedupe — each is its own session", () => {
    let s = seed([worktree("w1", "p1")]);
    const term = (id: string): Tab => ({
      id,
      worktreeId: "w1",
      kind: "terminal",
      ptyId: `pty_${id}`,
      detectedCli: null,
      agentStatus: "idle",
      title: "shell",
      summary: "ready",
      summaryUpdatedAt: 0,
    });
    s = open(s, term("t1"));
    s = open(s, term("t2"));
    expect(s.worktrees.w1.tabIds).toEqual(["t1", "t2"]);
  });
});

describe("reorder-worktree", () => {
  const order = (s: AppState, projectId: string) =>
    Object.values(s.worktrees)
      .filter((w) => w.projectId === projectId)
      .map((w) => w.id);

  test("moves a worktree above a sibling in the same project", () => {
    const s = seed([
      worktree("a", "p1"),
      worktree("b", "p1"),
      worktree("c", "p1"),
    ]);
    const out = reducer(s, {
      type: "reorder-worktree",
      id: "c",
      targetId: "a",
      edge: "above",
    });
    expect(order(out, "p1")).toEqual(["c", "a", "b"]);
  });

  test("moves a worktree below a sibling", () => {
    const s = seed([
      worktree("a", "p1"),
      worktree("b", "p1"),
      worktree("c", "p1"),
    ]);
    const out = reducer(s, {
      type: "reorder-worktree",
      id: "a",
      targetId: "b",
      edge: "below",
    });
    expect(order(out, "p1")).toEqual(["b", "a", "c"]);
  });

  test("rejects cross-project moves", () => {
    const s = seed([worktree("a", "p1"), worktree("b", "p2")]);
    const out = reducer(s, {
      type: "reorder-worktree",
      id: "a",
      targetId: "b",
      edge: "above",
    });
    expect(out).toBe(s);
  });

  test("no-op dispatches return the same state object (render bail-out)", () => {
    const s = seed([worktree("a", "p1")]);
    const withActive: AppState = {
      ...s,
      activeProjectId: "p1",
      activeWorktreeByProject: { p1: "a" },
    };
    expect(
      reducer(withActive, { type: "set-active-project", id: "p1" }),
    ).toBe(withActive);
    expect(
      reducer(withActive, {
        type: "set-active-worktree",
        projectId: "p1",
        worktreeId: "a",
      }),
    ).toBe(withActive);
    expect(
      reducer(s, { type: "set-change-count", worktreeId: "a", count: 0 }),
    ).toBe(s);
    expect(
      reducer(s, {
        type: "set-agent-status",
        worktreeId: "a",
        status: "idle",
        cli: null,
      }),
    ).toBe(s);
    // …and a real change still lands.
    const changed = reducer(s, {
      type: "set-change-count",
      worktreeId: "a",
      count: 3,
    });
    expect(changed.worktrees.a.changeCount).toBe(3);
  });

  test("reordering inside one project leaves other projects' rows alone", () => {
    const s = seed([
      worktree("a", "p1"),
      worktree("x", "p2"),
      worktree("b", "p1"),
      worktree("y", "p2"),
    ]);
    const out = reducer(s, {
      type: "reorder-worktree",
      id: "b",
      targetId: "a",
      edge: "above",
    });
    expect(order(out, "p1")).toEqual(["b", "a"]);
    expect(order(out, "p2")).toEqual(["x", "y"]);
  });
});

describe("split panes", () => {
  /** Worktree with three commit tabs t1 (active), t2, t3. */
  const seeded = (): AppState => {
    let s = seed([worktree("w1", "p1")]);
    s = open(s, commitTab("t1", "w1", "aaa111"));
    s = open(s, commitTab("t2", "w1", "bbb222"));
    s = open(s, commitTab("t3", "w1", "ccc333"));
    return reducer(s, { type: "select-tab", worktreeId: "w1", id: "t1" });
  };

  test("dropping a non-active tab on the right splits", () => {
    const s = reducer(seeded(), {
      type: "split-tab",
      worktreeId: "w1",
      id: "t2",
      side: "right",
    });
    expect(s.worktrees.w1.activeTabId).toBe("t1");
    expect(s.worktrees.w1.splitTabId).toBe("t2");
  });

  test("dropping the ACTIVE tab on the right backfills the left half", () => {
    const s = reducer(seeded(), {
      type: "split-tab",
      worktreeId: "w1",
      id: "t1",
      side: "right",
    });
    expect(s.worktrees.w1.splitTabId).toBe("t1");
    expect(s.worktrees.w1.activeTabId).toBe("t3");
  });

  test("a single-tab worktree cannot split with itself", () => {
    let s = seed([worktree("w1", "p1")]);
    s = open(s, commitTab("t1", "w1", "aaa111"));
    const out = reducer(s, {
      type: "split-tab",
      worktreeId: "w1",
      id: "t1",
      side: "right",
    });
    expect(out).toBe(s);
  });

  test("dropping a tab on the left of an unsplit view splits (old active → right)", () => {
    const s = reducer(seeded(), {
      type: "split-tab",
      worktreeId: "w1",
      id: "t2",
      side: "left",
    });
    expect(s.worktrees.w1.activeTabId).toBe("t2");
    expect(s.worktrees.w1.splitTabId).toBe("t1");
  });

  test("dropping the split tab on the left swaps halves", () => {
    let s = reducer(seeded(), {
      type: "split-tab",
      worktreeId: "w1",
      id: "t2",
      side: "right",
    });
    s = reducer(s, {
      type: "split-tab",
      worktreeId: "w1",
      id: "t2",
      side: "left",
    });
    expect(s.worktrees.w1.activeTabId).toBe("t2");
    expect(s.worktrees.w1.splitTabId).toBe("t1");
  });

  test("selecting the split tab in the strip swaps instead of duplicating", () => {
    let s = reducer(seeded(), {
      type: "split-tab",
      worktreeId: "w1",
      id: "t2",
      side: "right",
    });
    s = reducer(s, { type: "select-tab", worktreeId: "w1", id: "t2" });
    expect(s.worktrees.w1.activeTabId).toBe("t2");
    expect(s.worktrees.w1.splitTabId).toBe("t1");
  });

  test("re-opening (dedup path) the split tab's target also swaps", () => {
    let s = reducer(seeded(), {
      type: "split-tab",
      worktreeId: "w1",
      id: "t2",
      side: "right",
    });
    s = open(s, commitTab("t9", "w1", "bbb222")); // dedups onto t2
    expect(s.worktrees.w1.activeTabId).toBe("t2");
    expect(s.worktrees.w1.splitTabId).toBe("t1");
  });

  test("unsplit keeping the left half", () => {
    let s = reducer(seeded(), {
      type: "split-tab",
      worktreeId: "w1",
      id: "t2",
      side: "right",
    });
    s = reducer(s, { type: "unsplit", worktreeId: "w1", keep: "left" });
    expect(s.worktrees.w1.activeTabId).toBe("t1");
    expect(s.worktrees.w1.splitTabId).toBeNull();
  });

  test("unsplit keeping the right half", () => {
    let s = reducer(seeded(), {
      type: "split-tab",
      worktreeId: "w1",
      id: "t2",
      side: "right",
    });
    s = reducer(s, { type: "unsplit", worktreeId: "w1", keep: "right" });
    expect(s.worktrees.w1.activeTabId).toBe("t2");
    expect(s.worktrees.w1.splitTabId).toBeNull();
  });

  test("closing the split tab clears the split", () => {
    let s = reducer(seeded(), {
      type: "split-tab",
      worktreeId: "w1",
      id: "t2",
      side: "right",
    });
    s = reducer(s, { type: "close-tab", id: "t2" });
    expect(s.worktrees.w1.activeTabId).toBe("t1");
    expect(s.worktrees.w1.splitTabId).toBeNull();
    expect(s.worktrees.w1.tabIds).toEqual(["t1", "t3"]);
  });

  test("closing the active tab promotes the split tab", () => {
    let s = reducer(seeded(), {
      type: "split-tab",
      worktreeId: "w1",
      id: "t2",
      side: "right",
    });
    s = reducer(s, { type: "close-tab", id: "t1" });
    expect(s.worktrees.w1.activeTabId).toBe("t2");
    expect(s.worktrees.w1.splitTabId).toBeNull();
  });
});
