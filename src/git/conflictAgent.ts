import { pr } from "@/lib/pr";
import { termInput } from "@/lib/tauri/term";
import { projectSettings, type Project, type Tab, type Worktree } from "@/state/types";

/**
 * Shared "merge the base branch in, then hand any conflicts to the
 * worktree's agent" flow. Used by both WindowChrome's Resolve-conflicts
 * button (for the worktree's own PR) and the PRs tab's session banner
 * (for a checked-out PR) — one prompt, one PTY-selection policy.
 */

function isTerminal(t: Tab): t is Extract<Tab, { kind: "terminal" }> {
  return t.kind === "terminal";
}

/** Prefer the active main-column terminal, then any terminal tab,
 *  then the secondary panel's terminal. */
export function findAgentPty(
  worktree: Worktree,
  tabs: Record<string, Tab>,
): string | null {
  const activeTab = worktree.activeTabId ? tabs[worktree.activeTabId] : null;
  if (activeTab && isTerminal(activeTab)) return activeTab.ptyId;
  for (const id of worktree.tabIds) {
    const t = tabs[id];
    if (t && isTerminal(t)) return t.ptyId;
  }
  return worktree.secondaryActiveTerminalId ?? worktree.secondaryPtyId ?? null;
}

export type ConflictHandoff =
  | { kind: "clean"; alreadyUpToDate: boolean }
  | { kind: "sent"; files: number }
  | { kind: "no-agent"; files: number };

/**
 * Pull origin/`base` into the checked-out branch. When that leaves
 * conflicts in the working tree, inject a resolution prompt into the
 * worktree's agent terminal (user watches it work in real time, which
 * beats a one-shot helper run for a multi-file edit). The caller turns
 * the returned outcome into its own toasts.
 */
export async function mergeBaseAndHandOff(opts: {
  path: string;
  /** Base branch to merge in (e.g. the PR's `baseRefName`). */
  base: string;
  /** Spliced into the prompt: "pulling <base> into <branchLabel>". */
  branchLabel: string;
  worktree: Worktree;
  tabs: Record<string, Tab>;
  project: Project | null | undefined;
}): Promise<ConflictHandoff> {
  const result = await pr.mergeBaseIntoBranch(opts.path, opts.base);
  if (!result.conflicts) {
    return { kind: "clean", alreadyUpToDate: result.alreadyUpToDate };
  }
  const fileList = result.files.slice(0, 24).join(", ");
  const cfg = projectSettings(opts.project);
  const extras = [cfg.prefs.general, cfg.prefs.resolveConflicts]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n\n");
  const prompt =
    `Merge conflicts after pulling ${opts.base} into ${opts.branchLabel}. ` +
    `Files: ${fileList}. ` +
    `Read each conflicted file, resolve the <<<<<<<, =======, >>>>>>> markers ` +
    `keeping the correct intent, then run \`git add <files>\`, \`git commit --no-edit\`, ` +
    `and \`git push\`. Don't ask for confirmation between files — just resolve them all.` +
    (extras ? `\n\n${extras}` : "");
  const ptyId = findAgentPty(opts.worktree, opts.tabs);
  if (!ptyId) return { kind: "no-agent", files: result.files.length };
  await termInput(ptyId, new TextEncoder().encode(prompt + "\n")).catch(
    () => undefined,
  );
  return { kind: "sent", files: result.files.length };
}
