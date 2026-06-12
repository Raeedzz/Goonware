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
    // Simulate unsaved edits on the open tab.
    s = {
      ...s,
      tabs: { ...s.tabs, t1: { ...s.tabs.t1, content: "dirty" } as Tab },
    };
    s = open(s, markdownTab("t2", "w1", "README.md", { line: 7, column: 2 }));
    const t1 = s.tabs.t1 as MarkdownTab;
    expect(s.worktrees.w1.tabIds).toEqual(["t1"]);
    expect(t1.content).toBe("dirty");
    expect(t1.openAt).toEqual({ line: 7, column: 2 });
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
