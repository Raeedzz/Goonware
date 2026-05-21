import { invoke } from "@tauri-apps/api/core";
import type {
  AppState,
  ArchiveRecord,
  ProjectId,
  TerminalTab,
  Worktree,
  WorktreeId,
} from "@/state/types";

/**
 * Worktree lifecycle wrappers around the Rust commands. Backend lives
 * in `src-tauri/src/worktree.rs`.
 */

export async function worktreeList(projectPath: string): Promise<Worktree[]> {
  return invoke<Worktree[]>("worktree_list", { projectPath });
}

export interface WorktreeCreateOptions {
  /** Ref to branch off of (e.g. `origin/main`). Empty string = HEAD. */
  baseRef?: string;
  /** Glob patterns to copy from the repo root into the new checkout. */
  filesToCopy?: string[];
  /** Shell snippet run in the new worktree dir after `git worktree add`. */
  setupScript?: string;
}

export async function worktreeCreate(
  projectId: string,
  projectPath: string,
  branch: string,
  label: string,
  options: WorktreeCreateOptions = {},
): Promise<Worktree> {
  return invoke<Worktree>("worktree_create", {
    projectId,
    projectPath,
    branch,
    label,
    baseRef: options.baseRef ?? null,
    filesToCopy: options.filesToCopy ?? null,
    setupScript: options.setupScript ?? null,
  });
}

export interface ArchiveOptions {
  /** Stash dirty changes before removing the worktree (recommended). */
  stash: boolean;
  /** Pass --force to git worktree remove. */
  force: boolean;
  /** Delete the local branch after removing. */
  deleteBranch: boolean;
  /** Shell snippet run in the worktree dir before stash/remove. */
  archiveScript?: string;
}

export async function worktreeArchive(
  worktree: Worktree,
  projectPath: string | null,
  opts: ArchiveOptions,
): Promise<ArchiveRecord> {
  return invoke<ArchiveRecord>("worktree_archive", {
    worktreeId: worktree.id,
    projectId: worktree.projectId,
    projectPath,
    branch: worktree.branch,
    name: worktree.name,
    path: worktree.path,
    createdAt: worktree.createdAt,
    lastSummary: "",
    changeCountAtArchive: worktree.changeCount,
    agentCli: worktree.agentCli,
    stash: opts.stash,
    force: opts.force,
    deleteBranch: opts.deleteBranch,
    archiveScript: opts.archiveScript ?? null,
  });
}

export async function worktreeRestore(
  archiveId: string,
  projectId: string,
  projectPath: string,
): Promise<Worktree> {
  return invoke<Worktree>("worktree_restore", {
    archiveId,
    projectId,
    projectPath,
  });
}

export async function archiveList(
  projectId: string,
): Promise<ArchiveRecord[]> {
  return invoke<ArchiveRecord[]>("archive_list", { projectId });
}

/**
 * Gather every pty_id a worktree is currently holding alive:
 *   - the primary terminal tab(s) inside `worktree.tabIds`
 *   - the secondary-panel terminal strip (`secondaryTerminals[]`)
 *   - the legacy single `secondaryPtyId` (only if not already in the
 *     strip, which it should be after the v2 hydration migration)
 *
 * Used by the archive flow to feed `forgetPtys()` — without it the
 * SQLite block history + the live PTY processes hang around forever
 * after the user archives a worktree, since `worktree_restore` mints
 * fresh ids and never reuses the originals.
 */
export function collectWorktreePtyIds(
  worktree: Worktree,
  tabs: AppState["tabs"],
): string[] {
  const ids = new Set<string>();
  for (const tid of worktree.tabIds) {
    const tab = tabs[tid];
    if (tab && tab.kind === "terminal") {
      ids.add((tab as TerminalTab).ptyId);
    }
  }
  for (const pty of worktree.secondaryTerminals ?? []) {
    if (pty) ids.add(pty);
  }
  if (worktree.secondaryPtyId) ids.add(worktree.secondaryPtyId);
  return Array.from(ids);
}

export type { WorktreeId };

/**
 * Build the primary terminal tab record for a freshly-created worktree.
 * The backend mints a stable tab id in `worktree.tabIds[0]` but does
 * not write the actual Tab record — that's the frontend's job, since
 * `Tab` carries runtime fields (PTY id, summary text, agent status).
 *
 * Both ⌘N and the sidebar `+` button funnel through this so a new
 * worktree always opens onto a live shell instead of an empty pane.
 */
export function primaryTerminalTab(worktree: Worktree): TerminalTab {
  const id = worktree.tabIds[0] ?? `t_${Math.random().toString(36).slice(2, 10)}`;
  const ptyId = `pty_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    worktreeId: worktree.id,
    kind: "terminal",
    ptyId,
    detectedCli: null,
    agentStatus: "idle",
    title: "shell",
    summary: "ready",
    summaryUpdatedAt: Date.now(),
  };
}

/**
 * Single-word landmark / monument names used as auto-generated branch
 * names. Picked deterministically (ordered by string hash so two
 * worktrees in the same project don't accidentally collide on the
 * same name) and sourced from a wide enough pool that the user can
 * make ~80 worktrees per project before we wrap to numeric fallbacks.
 *
 * Rules: lowercase, ASCII-only, hyphens not underscores (git branch
 * legal everywhere), no whitespace. Curated for memorability — the
 * user reads them at a glance in the sidebar, so distinct first
 * syllables matter more than depth.
 */
const LANDMARK_NAMES: readonly string[] = [
  "eiffel",
  "stonehenge",
  "colosseum",
  "parthenon",
  "pyramid",
  "kremlin",
  "pantheon",
  "acropolis",
  "petra",
  "machu-picchu",
  "alhambra",
  "angkor",
  "borobudur",
  "chichen-itza",
  "moai",
  "sphinx",
  "taj-mahal",
  "notre-dame",
  "sagrada",
  "duomo",
  "louvre",
  "uffizi",
  "prado",
  "hermitage",
  "vatican",
  "sistine",
  "westminster",
  "tower-bridge",
  "big-ben",
  "buckingham",
  "windsor",
  "edinburgh",
  "neuschwanstein",
  "brandenburg",
  "rijksmuseum",
  "anne-frank",
  "auschwitz",
  "matterhorn",
  "mont-blanc",
  "everest",
  "kilimanjaro",
  "fuji",
  "denali",
  "rushmore",
  "liberty",
  "brooklyn",
  "manhattan",
  "chrysler",
  "empire",
  "guggenheim",
  "moma",
  "white-house",
  "lincoln",
  "jefferson",
  "alamo",
  "hoover",
  "yosemite",
  "yellowstone",
  "grand-canyon",
  "niagara",
  "banff",
  "louvre-pyramid",
  "versailles",
  "champs",
  "trevi",
  "ponte-vecchio",
  "san-marco",
  "rialto",
  "leaning-tower",
  "sydney-opera",
  "harbour-bridge",
  "uluru",
  "great-wall",
  "forbidden-city",
  "summer-palace",
  "kinkaku",
  "fushimi",
  "itsukushima",
  "shwedagon",
  "bagan",
  "victoria-falls",
  "table-mountain",
  "kruger",
  "serengeti",
  "ngorongoro",
  "iguazu",
  "amazon",
  "atacama",
  "patagonia",
  "torres-del-paine",
  "santorini",
  "meteora",
  "hagia-sophia",
  "blue-mosque",
  "cappadocia",
  "ephesus",
  "masada",
  "wailing-wall",
  "bethlehem",
  "dome-of-the-rock",
];

/**
 * Compute the next auto-named branch for a project. Picks a random
 * unused landmark name; falls back to `<landmark>-N` when every name
 * in the pool is already taken by an active or archived worktree.
 * Existing branch names (including legacy `agent-N`) still count as
 * "used" so we don't collide with old saved state.
 */
export function nextAutoBranch(
  projectId: ProjectId,
  state: Pick<AppState, "worktrees" | "archivedWorktrees">,
): string {
  void projectId;
  const used = new Set<string>();
  for (const w of Object.values(state.worktrees)) {
    used.add(w.branch.toLowerCase());
  }
  for (const a of state.archivedWorktrees) {
    used.add(a.branch.toLowerCase());
  }
  const available = LANDMARK_NAMES.filter((n) => !used.has(n));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)];
  }
  // Pool exhausted — append a numeric suffix to a random landmark.
  const base =
    LANDMARK_NAMES[Math.floor(Math.random() * LANDMARK_NAMES.length)];
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
