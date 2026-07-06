import { invoke } from "@tauri-apps/api/core";

/**
 * Frontend wrapper around the Rust-side PR commands (gh CLI under the
 * hood). See src-tauri/src/pr.rs.
 */

export interface PrListItem {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  author: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** One of MERGEABLE, CONFLICTING, UNKNOWN. */
  mergeable: string;
  isDraft: boolean;
  updatedAt: string;
}

export interface PrCheckoutResult {
  originalBranch: string;
  stashed: boolean;
}

export interface PrReturnResult {
  /**
   * False when a stash was expected but the tagged stash was gone —
   * the branch switch happened, but nothing was restored.
   */
  stashRestored: boolean;
}

export interface ConflictResult {
  conflicts: boolean;
  files: string[];
  alreadyUpToDate: boolean;
}

export const pr = {
  /** Every open PR on the repo, newest first (gh's default order). */
  list: (cwd: string) => invoke<PrListItem[]>("pr_list", { cwd }),
  /** Full unified diff of a PR without checking it out. */
  diff: (cwd: string, number: number) =>
    invoke<string>("pr_diff", { cwd, number }),
  /**
   * Stash uncommitted work (tagged for restore) and check the PR's
   * branch out into this worktree. The returned record is what the
   * "go back" button needs — persist it on the worktree.
   */
  checkout: (cwd: string, number: number) =>
    invoke<PrCheckoutResult>("pr_checkout", { cwd, number }),
  /** Switch back to `branch` and pop the tagged stash if one was made. */
  checkoutReturn: (cwd: string, branch: string, stashed: boolean) =>
    invoke<PrReturnResult>("pr_checkout_return", { cwd, branch, stashed }),
  /** Server-side merge via gh; deletes the remote branch on success. */
  merge: (cwd: string, number: number, method: "merge" | "squash" | "rebase") =>
    invoke<void>("pr_merge", { cwd, number, method }),
  /**
   * Pull origin/<base> into the checked-out branch. Conflicted files
   * are left in the working tree with markers for resolution.
   */
  mergeBaseIntoBranch: (cwd: string, base: string) =>
    invoke<ConflictResult>("merge_base_into_branch", { cwd, base }),
};
