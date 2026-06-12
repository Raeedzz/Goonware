import type { GraphCommit } from "@/lib/git";

/**
 * Lane layout for the commit graph — the classic "railway tracks"
 * algorithm every git GUI uses. Input commits must be ordered
 * children-before-parents (`git log --date-order` guarantees this);
 * each commit is assigned a lane (column), and every row records the
 * line segments to draw in its cell:
 *
 *   passes — lanes flowing straight through this row (top → bottom)
 *   ins    — lines converging INTO this commit's node from the top
 *            edge (children on other lanes whose parent this is)
 *   outs   — lines leaving the node toward the bottom edge (first
 *            parent continues on the node's own lane; extra parents
 *            of a merge curve out to their lanes)
 *
 * Colors are assigned per lane allocation and cycle through a small
 * palette index — the renderer maps index → CSS variable.
 */

export interface GraphSegment {
  /** Lane index at the relevant edge (top edge for ins, bottom for outs). */
  lane: number;
  color: number;
}

export interface GraphRow {
  hash: string;
  /** Column of this commit's node dot. */
  lane: number;
  color: number;
  passes: GraphSegment[];
  ins: GraphSegment[];
  outs: GraphSegment[];
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Widest lane index used + 1 — sizes the fixed graph gutter. */
  laneCount: number;
}

interface Lane {
  /** Hash this lane expects to meet next (null = free slot). */
  expects: string | null;
  color: number;
}

export function computeGraphLayout(commits: GraphCommit[]): GraphLayout {
  const lanes: Lane[] = [];
  let nextColor = 0;
  let laneCount = 0;
  const rows: GraphRow[] = [];

  const alloc = (expects: string): number => {
    const free = lanes.findIndex((l) => l.expects === null);
    const idx = free >= 0 ? free : lanes.length;
    lanes[idx] = { expects, color: nextColor++ };
    return idx;
  };

  for (const commit of commits) {
    // Every lane waiting for this commit — the first becomes the
    // node's own column, the rest are branch lines merging into it.
    const targets: number[] = [];
    lanes.forEach((l, i) => {
      if (l.expects === commit.hash) targets.push(i);
    });

    const nodeLane = targets.length > 0 ? targets[0] : alloc(commit.hash);
    const color = lanes[nodeLane].color;

    const ins: GraphSegment[] =
      targets.length > 0
        ? targets.map((lane) => ({ lane, color: lanes[lane].color }))
        : [];

    // Lanes that continue through this row untouched.
    const passes: GraphSegment[] = [];
    lanes.forEach((l, i) => {
      if (l.expects !== null && !targets.includes(i) && i !== nodeLane) {
        passes.push({ lane: i, color: l.color });
      }
    });

    // Free the merged-in lanes, then point the node's lane at the
    // first parent so the line continues downward.
    for (const t of targets) lanes[t].expects = null;
    const firstParent = commit.parents[0] ?? null;
    lanes[nodeLane].expects = firstParent;

    const outs: GraphSegment[] = [];
    if (firstParent !== null) {
      outs.push({ lane: nodeLane, color });
    }
    // Extra parents (merge commits): join a lane already heading to
    // that parent if one exists, else open a new lane for it.
    for (const parent of commit.parents.slice(1)) {
      const existing = lanes.findIndex(
        (l, i) => l.expects === parent && i !== nodeLane,
      );
      const lane = existing >= 0 ? existing : alloc(parent);
      outs.push({ lane, color: lanes[lane].color });
    }

    // Trim trailing free lanes so laneCount reflects real width.
    while (lanes.length > 0 && lanes[lanes.length - 1].expects === null) {
      lanes.pop();
    }
    laneCount = Math.max(
      laneCount,
      nodeLane + 1,
      ...passes.map((p) => p.lane + 1),
      ...ins.map((s) => s.lane + 1),
      ...outs.map((s) => s.lane + 1),
    );

    rows.push({ hash: commit.hash, lane: nodeLane, color, passes, ins, outs });
  }

  return { rows, laneCount };
}
