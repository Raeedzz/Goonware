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
  /**
   * The PR branch's real head sha (the review flow soft-resets the
   * branch to its merge-base so the diff reads as staged changes;
   * this is what Return resets back to). Null when review state
   * couldn't be established.
   */
  headSha: string | null;
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
  /**
   * Stash uncommitted work (tagged for restore), check the PR's branch
   * out into this worktree, and soft-reset to the merge-base with
   * `base` so the PR's whole diff shows as staged changes in the
   * normal changes UI. `head` is the PR's head branch — the backend
   * refuses when it's the branch already checked out here (reviewing
   * your own worktree's PR would rewrite the branch in place). The
   * returned record is what the "go back" button needs — persist it
   * on the worktree.
   */
  checkout: (cwd: string, number: number, base: string, head: string) =>
    invoke<PrCheckoutResult>("pr_checkout", { cwd, number, base, head }),
  /**
   * Put the PR branch back on its real head, switch back to `branch`,
   * and pop the tagged stash if one was made.
   */
  checkoutReturn: (
    cwd: string,
    branch: string,
    stashed: boolean,
    headSha: string | null,
  ) =>
    invoke<PrReturnResult>("pr_checkout_return", {
      cwd,
      branch,
      stashed,
      headSha,
    }),
  /**
   * Re-establish review state (staged PR diff) on the checked-out
   * branch — used after a clean base merge. Returns the new head sha.
   */
  reviewEnter: (cwd: string, base: string) =>
    invoke<string | null>("pr_review_enter", { cwd, base }),
  /**
   * Leave review state (branch ref back on its real head) without
   * switching branches. No-op when commits were made on top.
   */
  reviewRestore: (cwd: string, headSha: string) =>
    invoke<boolean>("pr_review_restore", { cwd, headSha }),
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
