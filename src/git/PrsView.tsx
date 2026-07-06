import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, ArrowsLeftRight, GitMerge } from "@phosphor-icons/react";
import { IconRefresh } from "@/design/icons";
import {
  AnimatePresence,
  Tooltip,
  useTooltipAnchor,
} from "@/primitives/Tooltip";
import { useAppDispatch, useAppState } from "@/state/AppState";
import { type Worktree } from "@/state/types";
import { pr, type PrListItem } from "@/lib/pr";
import { git } from "@/lib/git";
import { system } from "@/lib/fs";
import { mergeBaseAndHandOff } from "./conflictAgent";
import { useToast } from "@/primitives/Toast";

const PR_LIST_POLL_MS = 30_000;

type Busy =
  | { kind: "checkout" | "merge"; number: number }
  | { kind: "return" }
  | { kind: "conflicts" }
  | null;

/**
 * Right-panel PRs tab: every open PR on the repo, live from `gh pr
 * list`. A row click checks the PR out into this worktree (stashing
 * whatever was in progress) and soft-resets to the merge-base with the
 * PR's base, so the whole PR reads as *staged changes* in the app's
 * normal review surfaces — the Changes tab lists the files, the
 * all-changes view is the total diff. No bespoke PR-diff tab.
 *
 * Checking a PR out flips the worktree into a review session — the
 * banner at the top names the PR, offers "Resolve conflicts" when
 * GitHub reports the PR conflicting, and a Return button that restores
 * the branch head, the original branch, and the stashed work. The
 * session record lives on the worktree (persisted), so the way back
 * survives restarts.
 */
export function PrsView({
  worktree,
  isVisible,
}: {
  worktree: Worktree;
  isVisible: boolean;
}) {
  const dispatch = useAppDispatch();
  const state = useAppState();
  const toast = useToast();
  const [prs, setPrs] = useState<PrListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const path = worktree.path;
  const session = worktree.prSession ?? null;

  // One in-flight fetch at a time; stale responses for a previous
  // worktree path are dropped rather than painted.
  const pathRef = useRef(path);
  pathRef.current = path;
  const refresh = useCallback(async () => {
    try {
      const rows = await pr.list(path);
      if (pathRef.current !== path) return;
      setPrs(rows);
      setError(null);
    } catch (e) {
      if (pathRef.current !== path) return;
      setError(String(e));
    }
  }, [path]);

  // Fetch when the pane is actually showing (it stays mounted behind
  // display:none like the other right-panel panes) — gh shells out a
  // network call per poll, so hidden panes stay quiet.
  useEffect(() => {
    if (!isVisible || worktree.missing) return;
    void refresh();
    const t = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refresh();
    }, PR_LIST_POLL_MS);
    const onGitRefresh = (e: Event) => {
      const detail = (e as CustomEvent<{ cwd?: string }>).detail;
      if (!detail?.cwd || detail.cwd === path) void refresh();
    };
    window.addEventListener("goonware-git-refresh", onGitRefresh);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("goonware-git-refresh", onGitRefresh);
    };
  }, [isVisible, worktree.missing, path, refresh]);

  const notifyGitRefresh = () => {
    window.dispatchEvent(
      new CustomEvent("goonware-git-refresh", { detail: { cwd: path } }),
    );
  };

  // Put the review on screen using the app's normal surfaces: the
  // right panel's Changes tab (the PR's files, staged) and the main
  // column's all-changes tab (the total diff). The reducer dedupes
  // all-changes per worktree, so repeat calls focus the existing tab.
  const openChangesUi = () => {
    dispatch({
      type: "set-right-panel",
      worktreeId: worktree.id,
      panel: "changes",
    });
    dispatch({
      type: "open-tab",
      tab: {
        id: `t_changes_${Date.now().toString(36)}`,
        worktreeId: worktree.id,
        kind: "all-changes",
        title: "Changes",
        summary: "",
        summaryUpdatedAt: Date.now(),
      },
    });
  };

  const checkout = async (item: PrListItem) => {
    if (busy) return;
    if (session) {
      if (session.number === item.number) {
        // Already reviewing this PR — just bring the review back up.
        openChangesUi();
        return;
      }
      toast.show({
        message: `Return to ${session.originalBranch} before checking out another PR.`,
      });
      return;
    }
    // This worktree's own PR: its changes ARE the worktree. Checking
    // it out would stash the user's WIP and soft-reset their working
    // branch in place (the backend refuses too — this is the friendly
    // early exit). Just show the changes that are already here.
    if (item.headRefName === worktree.branch) {
      openChangesUi();
      toast.show({
        message: `PR #${item.number} is this worktree's own branch — its changes are already here.`,
      });
      return;
    }
    setBusy({ kind: "checkout", number: item.number });
    try {
      const result = await pr.checkout(
        path,
        item.number,
        item.baseRefName,
        item.headRefName,
      );
      dispatch({
        type: "update-worktree",
        id: worktree.id,
        patch: {
          prSession: {
            number: item.number,
            branch: item.headRefName,
            title: item.title,
            originalBranch: result.originalBranch,
            baseBranch: item.baseRefName,
            headSha: result.headSha ?? undefined,
            stashed: result.stashed,
          },
        },
      });
      notifyGitRefresh();
      // Reviewing means reading the changes — land on the staged-diff
      // review (Changes tab + total diff) in the same gesture.
      openChangesUi();
      toast.show({
        message: `Reviewing PR #${item.number} (${item.headRefName}) — its diff is staged in Changes${
          result.stashed ? "; your work is stashed" : ""
        }.`,
      });
    } catch (e) {
      toast.show({ message: `Checkout failed: ${e}` });
    } finally {
      setBusy(null);
    }
  };

  // Switch back to the session's original branch, pop the tagged
  // stash, and clear the session record. Shared by the Return button
  // and the merged-the-reviewed-PR path in merge().
  const endSession = async (s: NonNullable<Worktree["prSession"]>) => {
    const result = await pr.checkoutReturn(
      path,
      s.originalBranch,
      s.stashed,
      s.headSha ?? null,
    );
    dispatch({
      type: "update-worktree",
      id: worktree.id,
      patch: { prSession: null },
    });
    return result;
  };

  const returnToBranch = async () => {
    if (!session || busy) return;
    setBusy({ kind: "return" });
    try {
      const result = await endSession(session);
      notifyGitRefresh();
      toast.show({
        message:
          session.stashed && !result.stashRestored
            ? `Back on ${session.originalBranch} — heads-up: the tagged stash was gone, nothing was restored.`
            : `Back on ${session.originalBranch}${
                session.stashed ? " — stashed changes restored" : ""
              }.`,
      });
    } catch (e) {
      toast.show({ message: `Return failed: ${e}` });
    } finally {
      setBusy(null);
    }
  };

  const merge = async (item: PrListItem) => {
    if (busy) return;
    setBusy({ kind: "merge", number: item.number });
    try {
      await pr.merge(path, item.number, "merge");
      // If we merged the PR we were reviewing, the session's branch is
      // gone on the remote — send the user home in the same gesture.
      // A failed return must be visible: the session stays so the
      // Return button can retry, and the toast says what went wrong.
      let suffix = "";
      if (session && session.number === item.number) {
        try {
          await endSession(session);
          suffix = ` — back on ${session.originalBranch}`;
        } catch (e) {
          suffix = `, but returning to ${session.originalBranch} failed: ${e}`;
        }
      }
      // The goonware-git-refresh event re-runs this pane's own list
      // fetch (listener above), so no explicit refresh() on top of it.
      notifyGitRefresh();
      toast.show({ message: `Merged PR #${item.number}${suffix}.` });
    } catch (e) {
      toast.show({ message: `Merge failed: ${e}` });
    } finally {
      setBusy(null);
    }
  };

  const openExternal = (item: PrListItem) => {
    void system.open(item.url).catch(() => undefined);
  };

  const sessionItem = session
    ? prs?.find((p) => p.number === session.number)
    : undefined;

  // Pull origin/<base> into the checked-out PR branch, then hand any
  // conflicted files to the worktree's agent — shared flow with the
  // chrome's Resolve-conflicts button (see conflictAgent.ts).
  const resolveConflicts = async () => {
    if (!session || busy) return;
    // The base captured at checkout is authoritative; the list row is
    // only a fallback for sessions persisted before baseBranch existed.
    // Never guess a branch name — merging the wrong base makes a mess
    // the agent would then push.
    const base = session.baseBranch ?? sessionItem?.baseRefName;
    if (!base) {
      toast.show({
        message:
          "Can't determine the PR's base branch — refresh the PR list and try again.",
      });
      return;
    }
    setBusy({ kind: "conflicts" });
    try {
      // The branch is soft-reset to its merge-base while under review
      // (that's what makes the diff read as staged changes) — a merge
      // can't run in that state, so restore the real head first.
      if (session.headSha) {
        await pr.reviewRestore(path, session.headSha);
      }
      const result = await mergeBaseAndHandOff({
        path,
        base,
        branchLabel: `PR #${session.number}'s branch`,
        worktree,
        tabs: state.tabs,
        project: state.projects[worktree.projectId],
      });
      if (result.kind === "clean") {
        // Push the merge commit so the PR actually updates on GitHub,
        // then drop back into review state (staged diff) with the new
        // head recorded on the session.
        let pushNote = "";
        if (!result.alreadyUpToDate) {
          try {
            await git.push(path, "origin", session.branch);
          } catch (e) {
            pushNote = ` Push failed — the merge commit is still local: ${e}`;
          }
        }
        const newHead = await pr.reviewEnter(path, base).catch(() => null);
        dispatch({
          type: "update-worktree",
          id: worktree.id,
          patch: {
            prSession: { ...session, headSha: newHead ?? session.headSha },
          },
        });
        notifyGitRefresh();
        toast.show({
          message: result.alreadyUpToDate
            ? "PR branch is already up to date with its base."
            : `Merged ${base} into the PR branch — no conflicts.${
                pushNote || " Pushed to update the PR."
              }`,
        });
      } else {
        notifyGitRefresh();
        const files = `${result.files} file${result.files === 1 ? "" : "s"}`;
        toast.show({
          message:
            result.kind === "sent"
              ? `Conflicts in ${files} — sent to agent.`
              : `Conflicts in ${files}. Open your agent terminal and ask it to resolve.`,
        });
      }
    } catch (e) {
      toast.show({ message: `Resolve failed: ${e}` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        backgroundColor: "var(--surface-1)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          height: 30,
          flexShrink: 0,
          padding: "0 var(--space-3)",
          borderBottom: "var(--border-1)",
          userSelect: "none",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--text-secondary)",
            textTransform: "uppercase",
            letterSpacing: "var(--tracking-caps)",
          }}
        >
          open pull requests
        </span>
        {prs && prs.length > 0 && (
          <span
            className="tabular"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-2xs)",
              color: "var(--text-tertiary)",
            }}
          >
            {prs.length}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => void refresh()}
          title="Refresh PR list"
          aria-label="Refresh PR list"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            borderRadius: "var(--radius-xs)",
            backgroundColor: "transparent",
            color: "var(--text-tertiary)",
            cursor: "pointer",
          }}
        >
          <IconRefresh size={12} />
        </button>
      </div>

      {session && (
        <SessionBanner
          session={session}
          conflicting={sessionItem?.mergeable === "CONFLICTING"}
          busy={busy}
          onReturn={() => void returnToBranch()}
          onResolve={() => void resolveConflicts()}
        />
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {prs === null && !error && <Empty label="loading PRs…" />}
        {error && <Empty label={`error: ${error}`} />}
        {!error && prs !== null && prs.length === 0 && (
          <Empty label="no open PRs" />
        )}
        {!error &&
          prs?.map((item) => (
            <PrRow
              key={item.number}
              item={item}
              checkedOut={session?.number === item.number}
              isOwn={item.headRefName === worktree.branch}
              busy={busy}
              onOpen={() => void checkout(item)}
              onCheckout={() => void checkout(item)}
              onMerge={() => void merge(item)}
              onOpenExternal={() => openExternal(item)}
            />
          ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------
   Session banner — "you are reviewing PR #N" + the way back.
   ------------------------------------------------------------------ */

function SessionBanner({
  session,
  conflicting,
  busy,
  onReturn,
  onResolve,
}: {
  session: NonNullable<Worktree["prSession"]>;
  conflicting: boolean;
  busy: Busy;
  onReturn: () => void;
  onResolve: () => void;
}) {
  const returning = busy?.kind === "return";
  const resolving = busy?.kind === "conflicts";
  return (
    <div
      style={{
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        padding: "var(--space-3)",
        borderBottom: "var(--border-1)",
        backgroundColor: "var(--surface-2)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-xs)",
          color: "var(--text-primary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={session.title}
      >
        Reviewing{" "}
        <span style={{ fontWeight: "var(--weight-semibold)" }}>
          PR #{session.number}
        </span>{" "}
        — {session.title}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
          color: "var(--text-tertiary)",
        }}
      >
        on {session.branch}
        {session.stashed && " · your changes are stashed"}
      </div>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <BannerButton
          label={
            returning
              ? "Returning…"
              : `Back to ${session.originalBranch}`
          }
          primary
          disabled={busy !== null}
          onClick={onReturn}
        />
        {/* Always reachable — GitHub's mergeable flag lags pushes and
            the session PR may not even be in the polled list, so the
            user must be able to sync/resolve regardless. */}
        <BannerButton
          label={
            resolving
              ? "Resolving…"
              : conflicting
                ? "Resolve conflicts"
                : "Sync with base"
          }
          disabled={busy !== null}
          onClick={onResolve}
        />
      </div>
    </div>
  );
}

function BannerButton({
  label,
  primary,
  disabled,
  onClick,
}: {
  label: string;
  primary?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        height: 24,
        padding: "0 var(--space-3)",
        borderRadius: "var(--radius-sm)",
        backgroundColor: primary ? "var(--accent-press)" : "var(--surface-3)",
        color: primary ? "#fff" : "var(--text-primary)",
        fontSize: "var(--text-xs)",
        fontWeight: "var(--weight-medium)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------
   One PR row — click opens the diff; hover actions do the rest.
   ------------------------------------------------------------------ */

function PrRow({
  item,
  checkedOut,
  isOwn,
  busy,
  onOpen,
  onCheckout,
  onMerge,
  onOpenExternal,
}: {
  item: PrListItem;
  checkedOut: boolean;
  /** True when the PR's head is the branch this worktree is on. */
  isOwn: boolean;
  busy: Busy;
  onOpen: () => void;
  onCheckout: () => void;
  onMerge: () => void;
  onOpenExternal: () => void;
}) {
  const [hover, setHover] = useState(false);
  const conflicting = item.mergeable === "CONFLICTING";
  // Any in-flight operation (including numberless ones like Return)
  // disables every row's git-mutating actions — checkout/merge racing
  // a checkout/pop in the same worktree corrupts the restore.
  const anyBusy = busy !== null;
  const rowBusy = anyBusy && "number" in busy && busy.number === item.number;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        padding: "var(--space-2) var(--space-3)",
        borderBottom: "var(--border-1)",
        backgroundColor: hover ? "var(--surface-2)" : "transparent",
        cursor: "pointer",
        transition: "background-color var(--motion-fast) var(--ease-out-quart)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
        <span
          className="tabular"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
            flexShrink: 0,
          }}
        >
          #{item.number}
        </span>
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-xs)",
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            flex: 1,
          }}
          title={item.title}
        >
          {item.title}
        </span>
        {checkedOut && <Chip label="checked out" tone="accent" />}
        {isOwn && !checkedOut && <Chip label="this worktree" tone="accent" />}
        {item.isDraft && <Chip label="draft" tone="muted" />}
        {conflicting && <Chip label="conflicts" tone="warning" />}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          minWidth: 0,
          height: 18,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            flex: 1,
          }}
          title={`${item.headRefName} → ${item.baseRefName}`}
        >
          {item.author && `${item.author} · `}
          {item.headRefName} → {item.baseRefName}
          {" · "}
          <span style={{ color: "var(--diff-add-fg)" }}>+{item.additions}</span>{" "}
          <span style={{ color: "var(--diff-remove-fg)" }}>
            −{item.deletions}
          </span>
        </span>
        {(hover || rowBusy) && (
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <RowAction
              tip={
                checkedOut
                  ? "Checked out — open its review in Changes"
                  : isOwn
                    ? "This worktree's own PR — its changes are already here"
                    : "Review: check out and stage the PR's diff in Changes (stashes current work)"
              }
              disabled={anyBusy}
              onClick={onCheckout}
            >
              <ArrowsLeftRight size={13} />
            </RowAction>
            <RowAction tip="Open on GitHub" disabled={false} onClick={onOpenExternal}>
              <ArrowSquareOut size={13} />
            </RowAction>
            <RowAction
              tip={
                item.isDraft
                  ? "Draft PR — mark it ready for review first"
                  : conflicting
                    ? "Has conflicts — check out and resolve first"
                    : "Merge this PR into its base branch"
              }
              disabled={anyBusy || conflicting || item.isDraft}
              onClick={onMerge}
              label={rowBusy && busy?.kind === "merge" ? "Merging…" : "Merge"}
            >
              <GitMerge size={12} weight="bold" />
            </RowAction>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * One hover action on a PR row. The tip renders through the shared
 * Tooltip primitive (not the native `title`) so it appears fast and
 * matches the sidebar/tab-strip tips. Disabled state is aria-disabled
 * with a guarded click rather than the `disabled` attribute — a truly
 * disabled button swallows mouse events, and the tip is most useful
 * exactly when the action is unavailable ("draft — mark ready first").
 *
 * With `label` the action renders as a prominent filled pill (the
 * Merge button) instead of a bare 20px icon.
 */
function RowAction({
  tip,
  label,
  disabled,
  onClick,
  children,
}: {
  tip: string;
  label?: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const { ref, anchor, beginShow, cancelShow } =
    useTooltipAnchor<HTMLButtonElement>();
  const prominent = label !== undefined;
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={tip}
        aria-disabled={disabled}
        onMouseEnter={beginShow}
        onMouseLeave={cancelShow}
        onClick={() => {
          cancelShow();
          if (!disabled) onClick();
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 4,
          height: 20,
          width: prominent ? undefined : 20,
          padding: prominent ? "0 var(--space-2)" : 0,
          borderRadius: "var(--radius-xs)",
          backgroundColor: prominent ? "var(--state-success-bg)" : "transparent",
          border: prominent ? "1px solid var(--state-success)" : "none",
          color: prominent
            ? "var(--state-success-bright)"
            : "var(--text-secondary)",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-semibold)",
          whiteSpace: "nowrap",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.4 : 1,
        }}
      >
        {children}
        {label}
      </button>
      <AnimatePresence>
        {anchor && <Tooltip label={tip} anchor={anchor} placement="above" />}
      </AnimatePresence>
    </>
  );
}

function Chip({
  label,
  tone,
}: {
  label: string;
  tone: "accent" | "muted" | "warning";
}) {
  const color =
    tone === "warning"
      ? "var(--state-warning)"
      : tone === "accent"
        ? "var(--accent-press)"
        : "var(--text-tertiary)";
  return (
    <span
      style={{
        flexShrink: 0,
        padding: "1px 6px",
        borderRadius: "var(--radius-pill)",
        border: `1px solid ${color}`,
        color,
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        lineHeight: 1.4,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: "var(--space-6) var(--space-4)",
        textAlign: "center",
        color: "var(--text-tertiary)",
        fontSize: "var(--text-xs)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {label}
    </div>
  );
}

