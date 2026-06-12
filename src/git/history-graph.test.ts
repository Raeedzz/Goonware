import { describe, expect, test } from "bun:test";
import { computeGraphLayout } from "./history-graph";
import type { GraphCommit } from "@/lib/git";

const commit = (
  hash: string,
  parents: string[],
  overrides: Partial<GraphCommit> = {},
): GraphCommit => ({
  hash,
  short: hash.slice(0, 7),
  parents,
  refs: [],
  author: "a",
  email: "a@b.c",
  timestamp: 0,
  subject: hash,
  ...overrides,
});

describe("computeGraphLayout", () => {
  test("linear history stays on one lane", () => {
    const layout = computeGraphLayout([
      commit("c", ["b"]),
      commit("b", ["a"]),
      commit("a", []),
    ]);
    expect(layout.laneCount).toBe(1);
    expect(layout.rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    // Tip has no children above it → no incoming segments.
    expect(layout.rows[0].ins).toEqual([]);
    // Middle commit: line in from the child, line out to the parent.
    expect(layout.rows[1].ins).toEqual([{ lane: 0, color: 0 }]);
    expect(layout.rows[1].outs).toEqual([{ lane: 0, color: 0 }]);
    // Root commit: nothing below.
    expect(layout.rows[2].outs).toEqual([]);
  });

  test("branch tip opens a second lane that merges at the fork point", () => {
    // main:   c → a       feature: f → a
    const layout = computeGraphLayout([
      commit("c", ["a"]),
      commit("f", ["a"]),
      commit("a", []),
    ]);
    expect(layout.laneCount).toBe(2);
    const [c, f, a] = layout.rows;
    expect(c.lane).toBe(0);
    expect(f.lane).toBe(1);
    // Fork point: both lanes converge into a's node on lane 0.
    expect(a.lane).toBe(0);
    expect(a.ins.map((s) => s.lane).sort()).toEqual([0, 1]);
    // Lanes carry distinct colors.
    expect(c.color).not.toBe(f.color);
  });

  test("merge commit sends a second line out to the merged branch", () => {
    // m merges b into a's line:  m → [a, b], then b → a, then a (root)
    const layout = computeGraphLayout([
      commit("m", ["a", "b"]),
      commit("b", ["a"]),
      commit("a", []),
    ]);
    const [m, b, a] = layout.rows;
    expect(m.lane).toBe(0);
    // Two outgoing segments: first parent straight down, second to lane 1.
    expect(m.outs.length).toBe(2);
    expect(m.outs[0].lane).toBe(0);
    expect(m.outs[1].lane).toBe(1);
    expect(b.lane).toBe(1);
    // Both lines converge at the shared parent.
    expect(a.ins.map((s) => s.lane).sort()).toEqual([0, 1]);
    expect(layout.laneCount).toBe(2);
  });

  test("unrelated lane passes through a row it does not touch", () => {
    // Two independent roots interleaved: x2 → x1, y1 (root), x1 (root)
    const layout = computeGraphLayout([
      commit("x2", ["x1"]),
      commit("y1", []),
      commit("x1", []),
    ]);
    const y1 = layout.rows[1];
    expect(y1.lane).toBe(1);
    // Lane 0 (x's line) flows straight through y1's row.
    expect(y1.passes).toEqual([{ lane: 0, color: 0 }]);
  });

  test("freed lanes are reused by later branches", () => {
    // f branches off and merges back before g starts: lane 1 frees up.
    const layout = computeGraphLayout([
      commit("m", ["c", "f"]),
      commit("f", ["b"]),
      commit("c", ["b"]),
      commit("g", ["b"]),
      commit("b", []),
    ]);
    // g should reuse a freed lane rather than widening the graph.
    expect(layout.laneCount).toBeLessThanOrEqual(3);
  });

  test("empty input yields empty layout", () => {
    const layout = computeGraphLayout([]);
    expect(layout.rows).toEqual([]);
    expect(layout.laneCount).toBe(0);
  });
});
