import { useMemo } from "react";
import { type StatusEntry } from "../lib/git";
import { useSharedGitStatus } from "../state/gitStatusStore";

export type GitStatusMap = Map<string, StatusEntry>;

const EMPTY_MAP: GitStatusMap = new Map();

/**
 * `git status` for the given project root as a path → status entry
 * map. Path keys are absolute (joined with the project root) so the
 * file tree can do an O(1) lookup per row.
 *
 * Backed by the shared per-cwd git-status store, so the file tree and
 * every terminal status bar polling the same repo share one 4s poll
 * (paused while the window is hidden) instead of each running their
 * own subprocess-spawning interval.
 */
export function useGitStatus(projectPath: string | null): GitStatusMap {
  const status = useSharedGitStatus(projectPath);
  return useMemo(() => {
    if (!projectPath || !status) return EMPTY_MAP;
    const root = projectPath.replace(/\/$/, "");
    const next: GitStatusMap = new Map();
    for (const e of status.entries) {
      // Git emits paths relative to the repo root. Normalize to
      // the absolute paths the file tree uses.
      const abs = `${root}/${e.path}`;
      next.set(abs, e);
    }
    return next;
  }, [projectPath, status]);
}

/* ------------------------------------------------------------------
   Color mapping — used by both the file tree and the git panel
   ------------------------------------------------------------------ */

export interface GitStatusVisual {
  /** CSS color expression for the row's text. */
  color: string;
  /** Single-letter status badge shown in the row's right margin. */
  badge: string;
  /** Tooltip-friendly label for the badge. */
  label: string;
}

export function statusVisual(entry: StatusEntry | undefined): GitStatusVisual | null {
  if (!entry) return null;
  switch (entry.kind) {
    case "added":
      return {
        color: "var(--diff-add-fg)",
        badge: "A",
        label: entry.staged ? "added (staged)" : "added",
      };
    case "modified":
      return {
        color: "var(--state-warning)",
        badge: "M",
        label: entry.staged ? "modified (staged)" : "modified",
      };
    case "deleted":
      return {
        color: "var(--diff-remove-fg)",
        badge: "D",
        label: entry.staged ? "deleted (staged)" : "deleted",
      };
    case "renamed":
      return {
        color: "var(--state-info)",
        badge: "R",
        label: "renamed",
      };
    case "untracked":
      return {
        color: "var(--diff-add-fg)",
        badge: "U",
        label: "untracked",
      };
    case "conflicted":
      return {
        color: "var(--state-error)",
        badge: "!",
        label: "conflicted",
      };
    default:
      return null;
  }
}
