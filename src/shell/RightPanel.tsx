import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion } from "motion/react";
import { invoke } from "@tauri-apps/api/core";
import {
  IconCheck,
  IconChevronDown,
  IconPlus,
  IconPush,
  IconRevert,
  IconSparkles,
} from "@/design/icons";
import { ArrowSquareOut, CaretRight } from "@phosphor-icons/react";
import {
  useActiveWorktree,
  useAppDispatch,
  useAppState,
} from "@/state/AppState";
import {
  projectSettings,
  type RightPanelTab,
  type SecondaryTab,
  type Worktree,
} from "@/state/types";
import { fs } from "@/lib/fs";
import { git, type StatusEntry } from "@/lib/git";
import { FileTree } from "@/files/FileTree";
import { HistoryView } from "@/git/HistoryView";
import { paneSlotStyle } from "./paneSlotLayout";
import { BlockTerminal } from "@/terminal/BlockTerminal";
import { WarpSurfaceTracker } from "@/terminal/WarpSurfaceTracker";
import { useToast } from "@/primitives/Toast";
import { Loader } from "@/primitives/Loader";
import { BrowserPane } from "@/browser/BrowserPane";
import { SkillsView } from "@/skills/SkillsView";
import { forgetPtys } from "@/terminal/sessionMemory";

/**
 * Right panel: top tabs (All files / Changes / Checks / Memory) + Review
 * + ⋮(Create PR), with a vertical splitter to a secondary section
 * (Setup / Run / Terminal subtabs).
 *
 * A worktree's secondary terminal is always-on — its PTY is bound to
 * `worktree.secondaryPtyId` and survives tab switches.
 */
export function RightPanel() {
  const worktree = useActiveWorktree();
  if (!worktree) return null;
  const splitPct = Math.min(80, Math.max(20, worktree.rightSplitPct));
  const collapsed = worktree.secondaryCollapsed === true;
  // The secondary panel collapses to just its tab header (32px). We
  // animate `grid-template-rows` directly — modern WebKit blends % and
  // px row tracks smoothly, and motion's MotionConfig sees the same
  // ease-out-quart curve for consistency with the rest of the chrome.
  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateRows: collapsed ? "1fr 32px" : `${splitPct}% 1fr`,
        transition:
          "grid-template-rows var(--motion-base) var(--ease-out-quart)",
      }}
    >
      <UpperPanel worktree={worktree} />
      <SecondaryPanel worktree={worktree} collapsed={collapsed} />
    </div>
  );
}

/* ------------------------------------------------------------------
   Upper section: All files / Changes / Checks / Memory
   ------------------------------------------------------------------ */

function UpperPanel({ worktree }: { worktree: Worktree }) {
  const dispatch = useAppDispatch();

  // Single source of truth for this worktree's git status. Polls
  // once at 4s, dispatches `set-change-count` so the tab badge and
  // sidebar `+N` indicator stay fresh, AND surfaces the full entries
  // list so ChangesView can render the file rows without running a
  // duplicate poll of its own. Previously UpperPanel and ChangesView
  // each had their own 4s poll on the same `git.status` call — two
  // IPC round-trips, twice the work, possible to drift out of sync.
  // Missing-directory worktrees skip the poll entirely — `git.status`
  // would fail every tick with `cwd does not exist`, spamming the
  // console and racing the recovery panel in MainColumn.
  const status = useWorktreeStatus(
    worktree.id,
    worktree.path,
    worktree.missing === true,
  );

  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: "auto 1fr",
        minHeight: 0,
        backgroundColor: "var(--surface-1)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: "var(--tab-height)",
          padding: "0 var(--space-2)",
          gap: 2,
          borderBottom: "var(--border-1)",
        }}
      >
        <PanelTab
          worktreeId={worktree.id}
          label="All files"
          tab="files"
          active={worktree.rightPanel === "files"}
        />
        <PanelTab
          worktreeId={worktree.id}
          label="Changes"
          tab="changes"
          active={worktree.rightPanel === "changes"}
          badge={worktree.changeCount > 0 ? worktree.changeCount : undefined}
        />
        <PanelTab
          worktreeId={worktree.id}
          label="Skills"
          tab="skills"
          active={worktree.rightPanel === "skills"}
        />
        <PanelTab
          worktreeId={worktree.id}
          label="Browser"
          tab="browser"
          active={worktree.rightPanel === "browser"}
        />
      </div>

      {/*
        All three panes stay mounted across right-panel tab switches.
        Inactive panes are hidden with `display: none` — they keep
        their scroll position, their internal state (composer text,
        expanded folders, console scroll), and the BrowserPane keeps
        its long-lived screenshot polling and Chrome session alive.
        Flipping tabs is now instant: zero remount cost, zero refetch
        flash. Previously Files and Changes remounted on every switch,
        which threw away expanded-folder state and re-ran git.status
        every time.

        FilesView's FileTree is lazy (reads only on expand), so the
        always-mounted cost is negligible. ChangesView reads its data
        from props (no poll of its own anymore). BrowserPane's polling
        already pauses on `document.visibilityState`.
       */}
      <div style={{ minHeight: 0, overflow: "hidden", position: "relative" }}>
        <PaneSlot active={worktree.rightPanel === "files"}>
          <FilesView worktree={worktree} />
        </PaneSlot>
        <PaneSlot active={worktree.rightPanel === "changes"}>
          <ChangesView
            worktree={worktree}
            entries={status.entries}
            ahead={status.ahead}
            behind={status.behind}
            branch={status.branch}
            error={status.error}
            refresh={status.refresh}
          />
        </PaneSlot>
        <PaneSlot active={worktree.rightPanel === "skills"}>
          <SkillsView worktree={worktree} />
        </PaneSlot>
        <PaneSlot active={worktree.rightPanel === "browser"}>
          <BrowserPane
            embedded
            // Passing the active-pane flag through tells BrowserPane
            // to skip its 1Hz health/status/screenshot tick when the
            // pane is sitting behind display:none. With 20 worktrees
            // this is the difference between zero browser IPC traffic
            // (every other tab is on Files or Changes) and 20 IPC
            // round-trips per second for previews nobody is watching.
            isVisible={worktree.rightPanel === "browser"}
            onClose={() =>
              dispatch({
                type: "set-right-panel",
                worktreeId: worktree.id,
                panel: "files",
              })
            }
          />
        </PaneSlot>
      </div>
    </div>
  );
}

/**
 * Absolute-positioned wrapper used to mount every right-panel pane
 * once and toggle visibility via `display`. Browser used to be the
 * only pane with this treatment — extending it to Files and Changes
 * eliminates the remount-on-switch tax that the user complained about
 * ("going from browser to git tree" felt slow). Each pane gets
 * `pointer-events: none` + `display: none` when inactive so neither
 * focus nor accidental clicks hit the hidden tree.
 */
function PaneSlot({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return <div style={paneSlotStyle(active)}>{children}</div>;
}

function PanelTab({
  worktreeId,
  label,
  tab,
  active,
  badge,
}: {
  worktreeId: string;
  label: string;
  tab: RightPanelTab;
  active: boolean;
  badge?: number;
}) {
  const dispatch = useAppDispatch();
  const [hover, setHover] = useState(false);
  // Two stacked highlights, both absolutely positioned behind the
  // label so the click target stays one cohesive rect:
  //
  //   - The *active* highlight is a motion.span with a shared
  //     `layoutId` scoped to this worktree's tab strip. When the
  //     active prop flips, the span unmounts from the old tab and
  //     mounts on the new one — motion sees the layoutId match and
  //     interpolates the transform between the two bounding rects.
  //     That's the "slide" effect: a single rect glides from Files
  //     → Changes → Browser instead of disappearing and reappearing.
  //   - The *hover* highlight is a plain span — fades in on enter,
  //     out on leave. Only renders when the tab is inactive; the
  //     active highlight already covers the surface treatment.
  //
  // Active tab fades its hover highlight away (covered by the active
  // rect anyway) so the two never visually overlap.
  return (
    <button
      type="button"
      onClick={() => dispatch({ type: "set-right-panel", worktreeId, panel: tab })}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        height: 28,
        padding: "0 var(--space-2)",
        backgroundColor: "transparent",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        fontSize: "var(--text-sm)",
        fontWeight: active ? "var(--weight-medium)" : "var(--weight-regular)",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        cursor: "pointer",
        transition: "color var(--motion-fast) var(--ease-out-quart)",
      }}
    >
      {active && (
        <motion.span
          layoutId={`right-panel-tab-active-${worktreeId}`}
          transition={{
            // Tween with ease-out-quart — same curve as the rest of
            // the chrome's punctuation animations. 240ms reads as
            // "considered" without feeling slow; the rectangle has
            // real distance to cover when jumping tab-to-tab so we
            // want enough duration to convey continuity.
            duration: 0.24,
            ease: [0.25, 1, 0.5, 1],
          }}
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "var(--radius-xs)",
            backgroundColor: "var(--surface-3)",
            zIndex: 0,
          }}
          aria-hidden
        />
      )}
      {!active && (
        <span
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "var(--radius-xs)",
            // --surface-3 (same as the active rect). The previous
            // --surface-2 sat only ~3% lightness above the panel
            // background, which read as "no highlight at all" on
            // near-black. Matching the active rect makes the hover
            // a preview of the would-be-active state.
            backgroundColor: "var(--surface-3)",
            opacity: hover ? 1 : 0,
            transition: "opacity var(--motion-fast) var(--ease-out-quart)",
            zIndex: 0,
            pointerEvents: "none",
          }}
          aria-hidden
        />
      )}
      <span
        style={{
          position: "relative",
          zIndex: 1,
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        {label}
        {badge !== undefined && (
          <span
            className="tabular"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: 18,
              height: 16,
              padding: "0 4px",
              borderRadius: "var(--radius-pill)",
              fontSize: "var(--text-2xs)",
              color: "var(--text-tertiary)",
              backgroundColor: "var(--surface-4)",
            }}
          >
            {badge}
          </span>
        )}
      </span>
    </button>
  );
}

function hoverableIcon(active: boolean): CSSProperties {
  return {
    width: 26,
    height: 26,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: active ? "var(--text-primary)" : "var(--text-tertiary)",
    backgroundColor: active ? "var(--surface-3)" : "transparent",
    borderRadius: "var(--radius-sm)",
    transition: "background-color var(--motion-instant) var(--ease-out-quart)",
  };
}

/* ------------------------------------------------------------------
   Files view — embeds the existing FileTree, opens .md as a markdown
   tab; everything else as an editor tab in the main column.
   ------------------------------------------------------------------ */

export function FilesView({ worktree }: { worktree: Worktree }) {
  const dispatch = useAppDispatch();
  const state = useAppState();

  const onOpen = (path: string) => {
    const id = `t_${Date.now().toString(36)}`;
    dispatch({
      type: "open-tab",
      tab: {
        id,
        worktreeId: worktree.id,
        kind: "markdown",
        filePath: path,
        mode: "edit",
        content: null,
        savedContent: null,
        title: path.split("/").pop() ?? path,
        summary: relPath(path, worktree.path),
        summaryUpdatedAt: Date.now(),
      },
    });
  };

  // After a rename in the tree, follow any open editor/diff tab that
  // pointed at the moved path — or at anything under a renamed folder —
  // so the tab keeps showing the same file instead of going stale.
  const onRenamed = (from: string, to: string) => {
    const tabs = state.tabs ?? {};
    for (const tab of Object.values(tabs)) {
      const fp = (tab as { filePath?: unknown }).filePath;
      if (typeof fp !== "string") continue;
      const isExact = fp === from;
      const isUnder = fp.startsWith(from + "/");
      if (!isExact && !isUnder) continue;
      const next = isExact ? to : to + fp.slice(from.length);
      dispatch({
        type: "update-tab",
        id: tab.id,
        patch: {
          filePath: next,
          title: next.split("/").pop() ?? next,
          summary: relPath(next, worktree.path),
        },
      });
    }
  };

  // After a delete, close any open tab for the removed path (or for a
  // file under a removed folder) — its backing file is gone.
  const onDeleted = (path: string) => {
    const tabs = state.tabs ?? {};
    for (const tab of Object.values(tabs)) {
      const fp = (tab as { filePath?: unknown }).filePath;
      if (typeof fp !== "string") continue;
      if (fp === path || fp.startsWith(path + "/")) {
        dispatch({ type: "close-tab", id: tab.id });
      }
    }
  };

  // FileTree is the direct child of the PaneSlot flex column — its
  // outer element carries the `flex:1 + minHeight:0 + overflowY:auto`
  // contract that makes the right-panel file list scrollable. An
  // intermediate wrapper here used to break that contract (default
  // `flex:0 1 auto` sized the wrapper to content, so FileTree's `flex:1`
  // had no flex parent to claim and the list overflowed silently into
  // the PaneSlot's `overflow:hidden`). Pinned by `paneSlotLayout.test.ts`
  // and `filesViewScroll.test.tsx`. FileTree itself renders a fragment
  // (tree + portaled context menu); the scroll container is its first
  // child, so the contract still holds.
  return (
    <FileTree
      root={worktree.path}
      onOpenFile={onOpen}
      onRenamed={onRenamed}
      onDeleted={onDeleted}
    />
  );
}

function relPath(abs: string, root: string): string {
  if (abs.startsWith(root + "/")) return abs.slice(root.length + 1);
  return abs;
}

/**
 * One poll per worktree, shared by every consumer that needs git
 * status. UpperPanel runs this hook; ChangesView reads `entries`,
 * `ahead`, `error`, `refresh` from props. Before this consolidation
 * UpperPanel ran a count-only poll and ChangesView ran a separate
 * entries poll, both at 4s cadence — two `git.status` IPC calls
 * with the same payload, doubling the Tauri traffic for nothing.
 *
 * Returns the live entries+ahead+error so anyone passing the result
 * into a child can render diff rows without spinning up their own
 * poll. The count is dispatched into worktree state for the badge.
 *
 * Refresh hooks:
 *   - 4 s interval — ambient edits made outside Goonware (e.g. VS Code,
 *     manual `git checkout`) land in the badge within one tick.
 *   - `rli-git-refresh` CustomEvent — emitted by commit / push /
 *     merge paths so the UI doesn't lag the action by 4 s.
 *   - `refresh()` return — imperative re-poll for callers that just
 *     ran a write op and want the panel to land before the next tick.
 */
interface WorktreeStatusState {
  entries: StatusEntry[];
  ahead: number;
  behind: number;
  branch: string | null;
  error: string | null;
  refresh: () => Promise<void>;
}

/** Last successful status per worktree — lets a worktree switch paint
    the previous result instantly while the fresh poll runs. Module-
    level so it survives pane/panel remounts; entries are tiny. */
const statusCache = new Map<
  string,
  {
    entries: StatusEntry[];
    ahead: number;
    behind: number;
    branch: string | null;
  }
>();

function sameStatusEntries(a: StatusEntry[], b: StatusEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].path !== b[i].path ||
      a[i].kind !== b[i].kind ||
      a[i].staged !== b[i].staged
    )
      return false;
  }
  return true;
}

function useWorktreeStatus(
  worktreeId: string,
  worktreePath: string,
  skip: boolean = false,
): WorktreeStatusState {
  const dispatch = useAppDispatch();
  const [entries, setEntries] = useState<StatusEntry[]>([]);
  const [ahead, setAhead] = useState<number>(0);
  const [behind, setBehind] = useState<number>(0);
  const [branch, setBranch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stable refresh fn — the dependent effect re-creates it on
  // worktreePath change, but consumers (ChangesView) call it from
  // event handlers without needing to re-run their useCallbacks.
  const pathRef = useRef(worktreePath);
  useEffect(() => {
    pathRef.current = worktreePath;
  }, [worktreePath]);

  const refresh = useCallback(async () => {
    if (skip) return;
    const path = pathRef.current;
    try {
      const result = await git.status(path);
      // Don't land if the path has rotated underneath us (worktree
      // switch in flight) — the next effect will fire a fresh poll
      // against the new path.
      if (path !== pathRef.current) return;
      statusCache.set(worktreeId, {
        entries: result.entries,
        ahead: result.ahead,
        behind: result.behind,
        branch: result.branch,
      });
      // Keep the previous array identity when the entries are
      // equivalent — the 4s poll usually returns the same status, and
      // a fresh identity would re-render ChangesView's file rows for
      // nothing.
      setEntries((prev) =>
        sameStatusEntries(prev, result.entries) ? prev : result.entries,
      );
      setAhead(result.ahead);
      setBehind(result.behind);
      setBranch(result.branch);
      setError(null);
      dispatch({
        type: "set-change-count",
        worktreeId,
        count: result.entries.length,
      });
    } catch (e) {
      if (path !== pathRef.current) return;
      setError(String(e));
    }
  }, [worktreeId, dispatch, skip]);

  useEffect(() => {
    if (skip) {
      setEntries([]);
      setAhead(0);
      setBehind(0);
      setBranch(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await refresh();
    };
    // Seed from the last-known status for this worktree so a switch
    // paints real data immediately (refreshed in the background by
    // the tick below) instead of flashing an empty pane. Worktrees
    // we've never polled start blank as before.
    const cached = statusCache.get(worktreeId);
    setEntries(cached?.entries ?? []);
    setAhead(cached?.ahead ?? 0);
    setBehind(cached?.behind ?? 0);
    setBranch(cached?.branch ?? null);
    setError(null);
    void tick();
    const t = window.setInterval(() => void tick(), 4000);
    const onRefresh = (e: Event) => {
      const detail = (e as CustomEvent<{ cwd?: string }>).detail;
      if (!detail?.cwd || detail.cwd === worktreePath) {
        void tick();
      }
    };
    window.addEventListener("goonware-git-refresh", onRefresh);
    return () => {
      cancelled = true;
      window.clearInterval(t);
      window.removeEventListener("goonware-git-refresh", onRefresh);
    };
  }, [worktreeId, worktreePath, refresh, skip]);

  return { entries, ahead, behind, branch, error, refresh };
}

/* ------------------------------------------------------------------
   Changes view — git status + click → open diff tab in main column.
   ------------------------------------------------------------------ */

function ChangesView({
  worktree,
  entries,
  ahead,
  behind,
  branch,
  error,
  refresh,
}: {
  worktree: Worktree;
  entries: StatusEntry[];
  ahead: number;
  behind: number;
  branch: string | null;
  error: string | null;
  refresh: () => Promise<void>;
}) {
  const dispatch = useAppDispatch();
  const state = useAppState();
  const toast = useToast();
  const [message, setMessage] = useState<string>("");
  const [busy, setBusy] = useState<null | "stage" | "unstage" | "commit" | "push" | "draft">(null);

  const stagedCount = useMemo(
    () => entries.filter((e) => e.staged).length,
    [entries],
  );
  const unstagedCount = entries.length - stagedCount;

  const stageAll = async () => {
    if (entries.length === 0) return;
    setBusy("stage");
    try {
      await git.stage(
        worktree.path,
        Array.from(new Set(entries.map((e) => e.path))),
      );
      await refresh();
    } catch (e) {
      toast.show({ message: `Stage failed: ${e}` });
    } finally {
      setBusy(null);
    }
  };

  const unstageAll = async () => {
    const staged = entries.filter((e) => e.staged);
    if (staged.length === 0) return;
    setBusy("unstage");
    try {
      await git.unstage(worktree.path, staged.map((e) => e.path));
      await refresh();
    } catch (e) {
      toast.show({ message: `Unstage failed: ${e}` });
    } finally {
      setBusy(null);
    }
  };

  const draftMessage = async () => {
    if (stagedCount === 0) {
      toast.show({ message: "Stage some changes first to draft a message." });
      return;
    }
    setBusy("draft");
    try {
      const cli =
        worktree.agentCli ?? state.settings.helperCliCommit ?? "claude";
      // Model only applies when the user hasn't been overridden by the
      // worktree's running CLI — otherwise we'd pass a Claude model
      // string to a Codex run, etc.
      const model =
        cli === state.settings.helperCliCommit
          ? state.settings.helperModelCommit
          : "";
      const project = state.projects[worktree.projectId];
      const cfgPrefs = projectSettings(project).prefs;
      const extras = cfgPrefs.general.trim();
      const text = await git.aiCommitMessage(
        worktree.path,
        cli,
        model,
        extras || undefined,
      );
      setMessage(text.trim());
    } catch (e) {
      toast.show({ message: `AI draft failed: ${e}` });
    } finally {
      setBusy(null);
    }
  };

  const commit = async () => {
    if (stagedCount === 0) {
      toast.show({ message: "Nothing staged to commit." });
      return;
    }
    if (!message.trim()) {
      toast.show({ message: "Write a commit message first." });
      return;
    }
    setBusy("commit");
    try {
      await git.commit(worktree.path, message.trim());
      toast.show({ message: "Committed." });
      setMessage("");
      await refresh();
      window.dispatchEvent(
        new CustomEvent("goonware-git-refresh", {
          detail: { cwd: worktree.path },
        }),
      );
    } catch (e) {
      toast.show({ message: `Commit failed: ${e}` });
    } finally {
      setBusy(null);
    }
  };

  const push = async () => {
    setBusy("push");
    try {
      await git.push(worktree.path);
      toast.show({ message: "Pushed." });
      await refresh();
      window.dispatchEvent(
        new CustomEvent("goonware-git-refresh", {
          detail: { cwd: worktree.path },
        }),
      );
    } catch (e) {
      toast.show({ message: `Push failed: ${e}` });
    } finally {
      setBusy(null);
    }
  };

  // Combined commit + push for the "staged changes AND branch is
  // already ahead" case. Sequential so the button label can morph
  // through `Committing → Pushing → idle`, giving the user real
  // progress feedback rather than one opaque "working" state.
  // Errors from either phase abort and surface a toast; the partial
  // state (e.g. commit succeeded but push failed) is fine — the user
  // can hit Push again from the resulting "Push 1" state.
  const commitPush = async () => {
    if (stagedCount === 0) {
      toast.show({ message: "Nothing staged to commit." });
      return;
    }
    if (!message.trim()) {
      toast.show({ message: "Write a commit message first." });
      return;
    }
    setBusy("commit");
    try {
      await git.commit(worktree.path, message.trim());
      setMessage("");
      await refresh();
      window.dispatchEvent(
        new CustomEvent("goonware-git-refresh", {
          detail: { cwd: worktree.path },
        }),
      );
    } catch (e) {
      toast.show({ message: `Commit failed: ${e}` });
      setBusy(null);
      return;
    }
    setBusy("push");
    try {
      await git.push(worktree.path);
      toast.show({ message: "Committed & pushed." });
      await refresh();
      window.dispatchEvent(
        new CustomEvent("goonware-git-refresh", {
          detail: { cwd: worktree.path },
        }),
      );
    } catch (e) {
      toast.show({ message: `Commit ok, push failed: ${e}` });
    } finally {
      setBusy(null);
    }
  };

  const openDiff = (entry: StatusEntry) => {
    const id = `t_diff_${Date.now().toString(36)}`;
    dispatch({
      type: "open-tab",
      tab: {
        id,
        worktreeId: worktree.id,
        kind: "diff",
        filePath: entry.path,
        staged: entry.staged,
        title: entry.path.split("/").pop() ?? entry.path,
        summary: entry.path,
        summaryUpdatedAt: Date.now(),
      },
    });
  };

  const toggleStage = async (entry: StatusEntry) => {
    try {
      if (entry.staged) {
        await git.unstage(worktree.path, [entry.path]);
      } else {
        await git.stage(worktree.path, [entry.path]);
      }
      await refresh();
    } catch (e) {
      toast.show({ message: `${entry.staged ? "Unstage" : "Stage"} failed: ${e}` });
    }
  };

  // Reverts a single file to HEAD (staged + worktree); untracked files
  // are deleted. Destructive and unrecoverable, so gate behind a confirm.
  const discardFile = async (entry: StatusEntry) => {
    const ok = window.confirm(
      `Discard changes in ${entry.path}?\n\nTracked files are reverted to HEAD; new files are deleted. This cannot be undone.`,
    );
    if (!ok) return;
    try {
      await git.discard(worktree.path, [entry.path]);
      await refresh();
    } catch (e) {
      toast.show({ message: `Discard failed: ${e}` });
    }
  };

  if (error) {
    return (
      <div style={{ padding: "var(--space-3)", color: "var(--state-error)" }}>
        {error}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div style={{ flexShrink: 0 }}>
        <CommitComposer
          message={message}
          onChange={setMessage}
          onDraft={draftMessage}
          onCommit={commit}
          onPush={push}
          onCommitPush={commitPush}
          busy={busy}
          stagedCount={stagedCount}
          ahead={ahead}
        />
      </div>

      {/* Changed-files list sizes to content up to ~40% of the pane,
          then scrolls — the History graph below keeps the remainder.
          Before the graph existed this region simply took everything. */}
      <div
        style={{
          flex: "0 1 auto",
          maxHeight: "40%",
          minHeight: 0,
          overflow: "auto",
        }}
      >
        {entries.length === 0 ? (
          <div
            style={{
              padding: "var(--space-3)",
              color: "var(--text-tertiary)",
              fontSize: "var(--text-xs)",
            }}
          >
            No changes
          </div>
        ) : (
          <>
            {stagedCount > 0 && (
              <ChangesGroup
                label="Staged"
                count={stagedCount}
                actionLabel="Unstage all"
                actionDisabled={busy !== null}
                onAction={unstageAll}
              />
            )}
            {stagedCount > 0 && (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {entries
                  .filter((e) => e.staged)
                  .map((entry) => (
                    <ChangeRow
                      key={`s:${entry.path}`}
                      entry={entry}
                      onOpen={openDiff}
                      onToggle={toggleStage}
                      onRevert={discardFile}
                    />
                  ))}
              </ul>
            )}
            {unstagedCount > 0 && (
              <ChangesGroup
                label="Unstaged"
                count={unstagedCount}
                actionLabel="Stage all"
                actionDisabled={busy !== null}
                onAction={stageAll}
              />
            )}
            {unstagedCount > 0 && (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {entries
                  .filter((e) => !e.staged)
                  .map((entry) => (
                    <ChangeRow
                      key={`u:${entry.path}`}
                      entry={entry}
                      onOpen={openDiff}
                      onToggle={toggleStage}
                      onRevert={discardFile}
                    />
                  ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div style={{ flex: "1 1 0", minHeight: 0 }}>
        <HistoryView worktree={worktree} branch={branch} behind={behind} />
      </div>
    </div>
  );
}

function ChangesGroup({
  label,
  count,
  actionLabel,
  actionDisabled,
  onAction,
}: {
  label: string;
  count: number;
  actionLabel: string;
  actionDisabled?: boolean;
  onAction: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 24,
        padding: "0 var(--space-3)",
        marginTop: "var(--space-1)",
        backgroundColor: "var(--surface-2)",
        borderTop: "var(--border-1)",
        borderBottom: "var(--border-1)",
      }}
    >
      <span
        style={{
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-semibold)",
          textTransform: "uppercase",
          letterSpacing: "var(--tracking-caps)",
          color: "var(--text-tertiary)",
        }}
      >
        {label}
      </span>
      <span
        className="tabular"
        style={{
          marginLeft: 6,
          fontSize: "var(--text-2xs)",
          color: "var(--text-disabled)",
        }}
      >
        {count}
      </span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        disabled={actionDisabled}
        onClick={onAction}
        style={{
          fontSize: "var(--text-2xs)",
          color: actionDisabled ? "var(--text-disabled)" : "var(--text-tertiary)",
          backgroundColor: "transparent",
          padding: "0 4px",
          cursor: actionDisabled ? "default" : "pointer",
        }}
      >
        {actionLabel}
      </button>
    </div>
  );
}

function ChangeRow({
  entry,
  onOpen,
  onToggle,
  onRevert,
}: {
  entry: StatusEntry;
  onOpen: (e: StatusEntry) => void;
  onToggle: (e: StatusEntry) => void;
  onRevert: (e: StatusEntry) => void;
}) {
  const tint = kindTint(entry.kind);
  return (
    <li>
      <div
        onClick={() => onOpen(entry)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          height: 28,
          padding: "0 var(--space-3)",
          color: "var(--text-secondary)",
          backgroundColor: "transparent",
          fontSize: "var(--text-xs)",
          cursor: "pointer",
          transition: "background-color var(--motion-instant) var(--ease-out-quart)",
        }}
        onMouseOver={(e) =>
          (e.currentTarget.style.backgroundColor = "var(--surface-2)")
        }
        onMouseOut={(e) =>
          (e.currentTarget.style.backgroundColor = "transparent")
        }
      >
        <span
          aria-label={kindLabel(entry.kind)}
          title={kindLabel(entry.kind)}
          className="tabular"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 16,
            height: 16,
            flexShrink: 0,
            borderRadius: "var(--radius-xs)",
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--weight-bold)",
            color: tint.fg,
            backgroundColor: tint.bg,
            border: `1px solid ${tint.border}`,
          }}
        >
          {kindGlyph(entry.kind)}
        </span>
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            textAlign: "left",
            color: "var(--text-primary)",
          }}
          title={entry.path}
        >
          {entry.path}
        </span>
        <button
          type="button"
          title="Discard changes"
          aria-label={`Discard changes in ${entry.path}`}
          onClick={(e) => {
            e.stopPropagation();
            onRevert(entry);
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-tertiary)",
            padding: "2px 5px",
            backgroundColor: "transparent",
            borderRadius: "var(--radius-xs)",
            opacity: 0.7,
            transition: "opacity var(--motion-instant) var(--ease-out-quart), color var(--motion-instant) var(--ease-out-quart), background-color var(--motion-instant) var(--ease-out-quart)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = "1";
            e.currentTarget.style.color = "var(--state-error)";
            e.currentTarget.style.backgroundColor = "var(--surface-3)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = "0.7";
            e.currentTarget.style.color = "var(--text-tertiary)";
            e.currentTarget.style.backgroundColor = "transparent";
          }}
        >
          <IconRevert size={13} />
        </button>
        <button
          type="button"
          title={entry.staged ? "Unstage" : "Stage"}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(entry);
          }}
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
            padding: "2px 6px",
            backgroundColor: "transparent",
            borderRadius: "var(--radius-xs)",
            opacity: 0.7,
            transition: "opacity var(--motion-instant) var(--ease-out-quart), background-color var(--motion-instant) var(--ease-out-quart)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = "1";
            e.currentTarget.style.backgroundColor = "var(--surface-3)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = "0.7";
            e.currentTarget.style.backgroundColor = "transparent";
          }}
        >
          {entry.staged ? "−" : "+"}
        </button>
      </div>
    </li>
  );
}

/**
 * Single-action commit / push composer. The textarea is the whole
 * surface; two icon-shaped buttons live in its corners:
 *
 *   ┌──────────────────────────── [✨] ┐ ← AI-draft (top-right)
 *   │ Describe the change…             │
 *   │                                  │
 *   │                       [Commit ↵] │ ← morphing action (bottom-right)
 *   └──────────────────────────────────┘
 *
 * The bottom-right button is one slot that morphs between Commit and
 * Push depending on the worktree's git state — never two buttons at
 * once. Commit when you have staged changes + a message; Push when
 * the branch is ahead. Disabled state when there's nothing to do.
 */
function CommitComposer({
  message,
  onChange,
  onDraft,
  onCommit,
  onPush,
  onCommitPush,
  busy,
  stagedCount,
  ahead,
}: {
  message: string;
  onChange: (s: string) => void;
  onDraft: () => void;
  onCommit: () => void;
  onPush: () => void;
  onCommitPush: () => void;
  busy: null | "stage" | "unstage" | "commit" | "push" | "draft";
  stagedCount: number;
  ahead: number;
}) {
  // Mode picker. Three live states + idle:
  //   - commit-push : staged changes AND branch is already ahead. The
  //                   single button now commits then pushes in one
  //                   click — matches the user's mental model that
  //                   staging "rolls the pending push forward" rather
  //                   than replacing the action with "Push".
  //   - commit      : staged changes, branch is up to date with origin
  //   - push        : nothing staged, branch is ahead of origin
  //   - idle        : nothing to do
  //
  // Whether the action is *enabled* depends on the message too: both
  // commit and commit-push need a non-empty message before they can
  // fire. Push doesn't (it ships already-committed work).
  const hasStaged = stagedCount > 0;
  const hasAhead = ahead > 0;
  const hasMessage = message.trim().length > 0;
  const mode: "commit-push" | "commit" | "push" | "idle" =
    hasStaged && hasAhead
      ? "commit-push"
      : hasStaged
        ? "commit"
        : hasAhead
          ? "push"
          : "idle";
  const disabled =
    busy !== null ||
    mode === "idle" ||
    ((mode === "commit" || mode === "commit-push") && !hasMessage);

  const onAction = () => {
    if (disabled) return;
    if (mode === "commit") onCommit();
    else if (mode === "push") onPush();
    else if (mode === "commit-push") onCommitPush();
  };

  return (
    <div
      style={{
        position: "relative",
        padding: "var(--space-3)",
        borderBottom: "var(--border-1)",
        backgroundColor: "var(--surface-2)",
      }}
    >
      <textarea
        value={message}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          hasStaged && hasAhead
            ? "Describe the change — commit & push together"
            : hasStaged
              ? "Describe the change…"
              : hasAhead
                ? "Push to share — message optional for next commit"
                : "Stage changes to commit"
        }
        rows={4}
        style={{
          width: "100%",
          minHeight: 96,
          maxHeight: 240,
          // No native resize handle — it sat behind the Commit button
          // as a visual artifact. The textarea grows via row height
          // when its content exceeds 4 lines.
          resize: "none",
          // Reserve room in the corners for the absolutely-positioned
          // AI button (top-right) and action button (bottom-right) so
          // text never slides under them — generous so the buttons
          // breathe instead of crowding the textarea wall.
          padding: "var(--space-3) 44px var(--space-8) var(--space-3)",
          backgroundColor: "var(--surface-1)",
          border: "var(--border-1)",
          borderRadius: "var(--radius-sm)",
          color: "var(--text-primary)",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-xs)",
          lineHeight: "var(--leading-xs)",
          outline: "none",
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            onAction();
          }
        }}
      />

      <AiDraftButton
        onClick={onDraft}
        disabled={busy !== null || stagedCount === 0}
        busy={busy === "draft"}
      />

      <ComposerActionButton
        mode={mode}
        busy={busy}
        disabled={disabled}
        onClick={onAction}
        ahead={ahead}
      />
    </div>
  );
}

function AiDraftButton({
  onClick,
  disabled,
  busy,
}: {
  onClick: () => void;
  disabled: boolean;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={busy ? "Drafting…" : "Draft commit message with your CLI agent"}
      aria-label="Draft commit message with AI"
      style={{
        position: "absolute",
        top: "calc(var(--space-3) + 6px)",
        right: "calc(var(--space-3) + 6px)",
        width: 26,
        height: 26,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "transparent",
        color: disabled
          ? "var(--text-disabled)"
          : busy
            ? "var(--accent-bright)"
            : "var(--text-tertiary)",
        border: "none",
        borderRadius: "var(--radius-sm)",
        cursor: disabled ? "default" : "pointer",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart), color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.backgroundColor = "var(--surface-3)";
        e.currentTarget.style.color = "var(--accent-bright)";
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.backgroundColor = "transparent";
        e.currentTarget.style.color = busy
          ? "var(--accent-bright)"
          : "var(--text-tertiary)";
      }}
    >
      <AnimatePresence mode="wait" initial={false}>
        {busy ? (
          <motion.span
            key="spinner"
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--accent-bright)",
            }}
          >
            <ArcSpinner size={14} />
          </motion.span>
        ) : (
          <motion.span
            key="wand"
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={{ duration: 0.14, ease: [0.25, 1, 0.5, 1] }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <IconSparkles size={14} />
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}

/**
 * Inline button loader. Delegates to the shared `<Loader>` primitive
 * so the spinner geometry, rotation cadence, and reduced-motion
 * handling stay in lockstep with the rest of the app — sidebar
 * worktree row, tab strip, hover-card status, and this button all
 * pull from the same source. `size` lets the caller tune for button
 * height; everything else is locked.
 */
function ArcSpinner({ size }: { size: number }) {
  return <Loader size={size} />;
}

function ComposerActionButton({
  mode,
  busy,
  disabled,
  onClick,
  ahead,
}: {
  mode: "commit-push" | "commit" | "push" | "idle";
  busy: null | "stage" | "unstage" | "commit" | "push" | "draft";
  disabled: boolean;
  onClick: () => void;
  ahead: number;
}) {
  // Working states ride the same crossfade as the four mode states —
  // they all keep distinct `labelKey`s so AnimatePresence treats each
  // as a separate motion span. Result: a single coordinated fade-up
  // when the action transitions through Commit → Committing → Pushing
  // → idle (Push count) on a "commit-push" click.
  const labelKey = busy === "commit"
    ? "working-commit"
    : busy === "push"
      ? "working-push"
      : mode;
  const label =
    busy === "commit"
      ? "Committing"
      : busy === "push"
        ? "Pushing"
        : mode === "commit-push"
          ? "Commit & push"
          : mode === "push"
            ? "Push"
            : "Commit";
  // Push glyph any time push is involved (commit-push, push, or the
  // push working state). Commit glyph otherwise. The crossfade hides
  // the swap inside the same span the label lives in.
  const Glyph =
    mode === "push" || mode === "commit-push" || busy === "push"
      ? IconPush
      : IconCheck;
  // Show the ahead-count next to the label only on pure push state.
  // In commit-push, the count would be misleading (it'll be `ahead+1`
  // after the commit lands), and in commit/idle there's nothing to
  // push yet. The count badge crossfades in/out with the label.
  const showCount = mode === "push" && ahead > 0 && busy === null;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={
        mode === "commit-push"
          ? "Commit & push (⌘↵)"
          : mode === "push"
            ? `Push ${ahead > 1 ? `${ahead} commits` : "1 commit"} (⌘↵)`
            : mode === "idle"
              ? "Stage changes and write a message to commit"
              : "Commit (⌘↵)"
      }
      aria-label={label}
      style={{
        position: "absolute",
        right: "calc(var(--space-3) + 10px)",
        bottom: "calc(var(--space-3) + 10px)",
        height: 26,
        minWidth: 92,
        padding: "0 12px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        backgroundColor: disabled
          ? "var(--surface-3)"
          : "var(--surface-accent-tinted)",
        color: disabled ? "var(--text-disabled)" : "var(--text-primary)",
        border: disabled
          ? "var(--border-1)"
          : "1px solid var(--accent-muted)",
        borderRadius: "var(--radius-sm)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--weight-semibold)",
        letterSpacing: "var(--tracking-tight)",
        cursor: disabled ? "default" : "pointer",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart), border-color var(--motion-instant) var(--ease-out-quart), color var(--motion-instant) var(--ease-out-quart)",
        overflow: "hidden",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.backgroundColor =
          "color-mix(in oklch, var(--surface-accent-tinted), var(--accent) 8%)";
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.backgroundColor =
          "var(--surface-accent-tinted)";
      }}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={labelKey}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Glyph size={12} />
          <span>{label}</span>
          {showCount && (
            <span
              className="tabular"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minWidth: 16,
                height: 14,
                padding: "0 4px",
                marginLeft: -1,
                borderRadius: "var(--radius-pill)",
                fontSize: "var(--text-2xs)",
                fontWeight: "var(--weight-semibold)",
                color: "var(--text-primary)",
                backgroundColor: "oklch(0% 0 0 / 0.32)",
                letterSpacing: 0,
              }}
            >
              {ahead}
            </span>
          )}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}

function kindGlyph(kind: string): string {
  if (kind === "modified") return "M";
  if (kind === "added") return "A";
  if (kind === "deleted") return "D";
  if (kind === "renamed") return "R";
  if (kind === "untracked") return "U";
  if (kind === "conflicted") return "C";
  return "·";
}

function kindLabel(kind: string): string {
  if (kind === "modified") return "Modified";
  if (kind === "added") return "Added";
  if (kind === "deleted") return "Deleted";
  if (kind === "renamed") return "Renamed";
  if (kind === "untracked") return "Untracked";
  if (kind === "conflicted") return "Conflicted";
  return kind;
}

interface KindTint {
  fg: string;
  bg: string;
  border: string;
}

function kindTint(kind: string): KindTint {
  if (kind === "added" || kind === "untracked") {
    return {
      fg: "var(--diff-add-fg)",
      bg: "color-mix(in oklch, transparent, var(--diff-add-fg) 18%)",
      border: "color-mix(in oklch, transparent, var(--diff-add-fg) 28%)",
    };
  }
  if (kind === "deleted") {
    return {
      fg: "var(--diff-remove-fg)",
      bg: "color-mix(in oklch, transparent, var(--diff-remove-fg) 18%)",
      border: "color-mix(in oklch, transparent, var(--diff-remove-fg) 28%)",
    };
  }
  if (kind === "modified") {
    return {
      fg: "var(--diff-change-fg)",
      bg: "color-mix(in oklch, transparent, var(--diff-change-fg) 16%)",
      border: "color-mix(in oklch, transparent, var(--diff-change-fg) 26%)",
    };
  }
  if (kind === "renamed") {
    return {
      fg: "var(--accent-bright)",
      bg: "color-mix(in oklch, transparent, var(--accent-bright) 16%)",
      border: "color-mix(in oklch, transparent, var(--accent-bright) 26%)",
    };
  }
  if (kind === "conflicted") {
    return {
      fg: "var(--state-error-bright)",
      bg: "color-mix(in oklch, transparent, var(--state-error-bright) 22%)",
      border: "color-mix(in oklch, transparent, var(--state-error-bright) 32%)",
    };
  }
  return {
    fg: "var(--text-tertiary)",
    bg: "var(--surface-3)",
    border: "var(--border-default)",
  };
}

/* ------------------------------------------------------------------
   Checks view (stub for v1)
   ------------------------------------------------------------------ */

function ChecksView() {
  return (
    <div
      style={{
        padding: "var(--space-4)",
        color: "var(--text-tertiary)",
        fontSize: "var(--text-xs)",
      }}
    >
      No checks configured.
    </div>
  );
}

/* ------------------------------------------------------------------
   Lower section: Setup / Run / Terminal subtabs
   ------------------------------------------------------------------ */

function SecondaryPanel({
  worktree,
  collapsed,
}: {
  worktree: Worktree;
  collapsed: boolean;
}) {
  const dispatch = useAppDispatch();
  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: "auto 1fr",
        minHeight: 0,
        borderTop: "var(--border-1)",
        // No root background: the secondary terminal renders on the native warpui
        // surface (BELOW the webview), so its content region must be a transparent
        // hole. The header paints its own --surface-1, and the content row paints
        // --surface-1 except when it's showing the native terminal. Mirrors
        // MainColumn's transparent-hole approach.
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 32,
          padding: "0 var(--space-2)",
          gap: 4,
          borderBottom: "var(--border-1)",
          backgroundColor: "var(--surface-1)",
        }}
      >
        <CollapseToggle
          collapsed={collapsed}
          onClick={() =>
            dispatch({
              type: "toggle-secondary-collapsed",
              worktreeId: worktree.id,
            })
          }
        />
        <SecondaryTabButton
          label="Setup"
          tab="setup"
          worktreeId={worktree.id}
          active={worktree.secondaryTab === "setup"}
        />
        <SecondaryTabButton
          label="Run"
          tab="run"
          worktreeId={worktree.id}
          active={worktree.secondaryTab === "run"}
        />
        {(worktree.secondaryTerminals ?? []).map((ptyId, i) => (
          <TerminalTabButton
            key={ptyId}
            label={i === 0 ? "Terminal" : `Terminal ${i + 1}`}
            ptyId={ptyId}
            worktreeId={worktree.id}
            active={
              worktree.secondaryTab === "terminal" &&
              worktree.secondaryActiveTerminalId === ptyId
            }
            closable={(worktree.secondaryTerminals ?? []).length > 1}
          />
        ))}
        <button
          type="button"
          title="New terminal (⌘T)"
          aria-label="New terminal"
          onClick={() =>
            dispatch({
              type: "add-secondary-terminal",
              worktreeId: worktree.id,
            })
          }
          style={hoverableIcon(false)}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "var(--surface-3)";
            e.currentTarget.style.color = "var(--text-primary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
            e.currentTarget.style.color = "var(--text-tertiary)";
          }}
        >
          <IconPlus size={14} />
        </button>
        <span style={{ flex: 1 }} />
        <PreviewUrlButton worktree={worktree} />
      </div>
      {/* Content row (grid 1fr). Stable position:relative wrapper so the side
          surface tracker stays MOUNTED across the collapse animation and the
          terminal<->script switch — the native side pane's show/hide is driven
          by the tracker's `visible` flag reporting a zero rect, NOT by unmount
          (an unmounted tracker would leave the surface stuck at its last rect).
          Transparent only while the native terminal is showing; otherwise paints
          --surface-1 so the script panel and the collapsed state stay opaque. */}
      <div
        style={{
          position: "relative",
          minHeight: 0,
          overflow: "hidden",
          backgroundColor:
            !collapsed && worktree.secondaryTab === "terminal"
              ? "transparent"
              : "var(--surface-1)",
        }}
      >
        <WarpSurfaceTracker
          paneKey="side"
          visible={!collapsed && worktree.secondaryTab === "terminal"}
        />
        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              key="secondary-content"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
              style={{
                position: "absolute",
                inset: 0,
                overflow: "hidden",
                minHeight: 0,
              }}
            >
              {worktree.secondaryTab === "terminal" ? (
                <SecondaryTerminals worktree={worktree} />
              ) : (
                <ScriptPanel worktree={worktree} kind={worktree.secondaryTab} />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function CollapseToggle({
  collapsed,
  onClick,
}: {
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? "Expand panel" : "Collapse panel"}
      aria-label={collapsed ? "Expand panel" : "Collapse panel"}
      aria-expanded={!collapsed}
      style={{
        ...hoverableIcon(false),
        marginRight: 2,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "var(--surface-3)";
        e.currentTarget.style.color = "var(--text-primary)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "transparent";
        e.currentTarget.style.color = "var(--text-tertiary)";
      }}
    >
      <motion.span
        aria-hidden
        animate={{ rotate: collapsed ? 180 : 0 }}
        transition={{ duration: 0.24, ease: [0.25, 1, 0.5, 1] }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          transformOrigin: "center",
        }}
      >
        <IconChevronDown size={14} />
      </motion.span>
    </button>
  );
}

function SecondaryTabButton({
  label,
  tab,
  active,
  worktreeId,
}: {
  label: string;
  tab: SecondaryTab;
  active: boolean;
  worktreeId: string;
}) {
  const dispatch = useAppDispatch();
  return (
    <button
      type="button"
      onClick={() =>
        dispatch({ type: "set-secondary-tab", worktreeId, tab })
      }
      style={{
        height: 24,
        padding: "0 var(--space-2)",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        fontSize: "var(--text-sm)",
        borderRadius: "var(--radius-xs)",
        backgroundColor: "transparent",
        borderBottom: active
          ? "1px solid var(--accent)"
          : "1px solid transparent",
      }}
    >
      {label}
    </button>
  );
}

function TerminalTabButton({
  label,
  ptyId,
  worktreeId,
  active,
  closable,
}: {
  label: string;
  ptyId: string;
  worktreeId: string;
  active: boolean;
  closable: boolean;
}) {
  const dispatch = useAppDispatch();
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 24,
        borderRadius: "var(--radius-xs)",
        borderBottom: active
          ? "1px solid var(--accent)"
          : "1px solid transparent",
        backgroundColor: hover && !active ? "var(--surface-3)" : "transparent",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)",
      }}
    >
      <button
        type="button"
        onClick={() =>
          dispatch({
            type: "select-secondary-terminal",
            worktreeId,
            ptyId,
          })
        }
        style={{
          height: 24,
          paddingLeft: "var(--space-2)",
          paddingRight: closable && hover ? 2 : "var(--space-2)",
          color: active ? "var(--text-primary)" : "var(--text-secondary)",
          fontSize: "var(--text-sm)",
          backgroundColor: "transparent",
          transition:
            "color var(--motion-instant) var(--ease-out-quart), padding var(--motion-instant) var(--ease-out-quart)",
        }}
      >
        {label}
      </button>
      {closable && hover && (
        <button
          type="button"
          title="Close terminal"
          aria-label="Close terminal"
          onClick={(e) => {
            e.stopPropagation();
            // Explicit close: forget the PTY's SQLite history so it
            // doesn't outlive the strip entry the user just dismissed.
            forgetPtys([ptyId]);
            dispatch({
              type: "close-secondary-terminal",
              worktreeId,
              ptyId,
            });
          }}
          style={{
            width: 16,
            height: 16,
            marginRight: 4,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-tertiary)",
            backgroundColor: "transparent",
            borderRadius: "var(--radius-xs)",
            fontSize: 12,
            lineHeight: 1,
            transition:
              "background-color var(--motion-instant) var(--ease-out-quart), color var(--motion-instant) var(--ease-out-quart)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "var(--surface-4)";
            e.currentTarget.style.color = "var(--text-primary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
            e.currentTarget.style.color = "var(--text-tertiary)";
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

/**
 * Mounts every secondary-panel terminal at once, layering them via
 * absolute positioning. Only the active one is visible and accepts
 * pointer events; the others stay alive in the background so their
 * scrollback survives tab switches without us having to replay it
 * through the PTY.
 */
function SecondaryTerminals({ worktree }: { worktree: Worktree }) {
  const list = worktree.secondaryTerminals ?? [worktree.secondaryPtyId];
  const active = worktree.secondaryActiveTerminalId ?? list[list.length - 1];
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
      }}
    >
      {list.map((ptyId) => {
        const isActive = ptyId === active;
        return (
          <div
            key={ptyId}
            style={{
              position: "absolute",
              inset: 0,
              visibility: isActive ? "visible" : "hidden",
              pointerEvents: isActive ? "auto" : "none",
              zIndex: isActive ? 1 : 0,
            }}
          >
            <BlockTerminal
              id={ptyId}
              command="zsh"
              cwd={worktree.path}
              projectId={worktree.projectId}
              sessionId={`${worktree.id}:${ptyId}`}
              // Render on the native warpui surface's SIDE pane (M6). The
              // right-panel content region is now a transparent hole (see the
              // content wrapper above + the side WarpSurfaceTracker), and the
              // native renderer offsets the side pane to its real (lower) region
              // within the combined surface. Only the ACTIVE secondary terminal
              // drives the single side pane — the hidden ones don't attach
              // (gated on isVisible) but stay `nativeSurface` so they render
              // transparent (no WebGPU/DOM grid) instead of painting over it.
              nativeSurface
              paneKey="side"
              // Forward visibility so only the active side terminal
              // owns its window-level Cmd+C / Ctrl+C / drag-drop
              // listeners. Without this gate, every hidden secondary
              // terminal in the layer also kept its global keydown
              // listeners armed — they'd all run on every keystroke,
              // gate-out via container.contains(anchor), and pile up
              // O(n) work per keystroke. Mirrors MainColumn's
              // TerminalKeepaliveLayer, which already passes
              // `isVisible={tab.id === activeTerminalTabId}`.
              isVisible={isActive}
              // Secondary terminals never auto-focus on mount. They
              // sit in the right panel; only the user explicitly
              // clicking into them should pull focus. Without this,
              // every worktree switch (which remounts the right
              // panel's secondary terminals) races the main column
              // for focus and wins, putting the cursor in the side
              // view instead of the main one. The user clicked into
              // a worktree — that means "I want to type in the main
              // terminal," full stop.
              autoFocus={false}
              // The right panel is narrow — closed blocks that
              // contain long lines (paths, command flags, log lines)
              // would otherwise clip against the pane edge. Allow
              // horizontal scrolling here so the user can pan with
              // a trackpad. The track itself is hidden via
              // `goonware-no-horizontal-scrollbar` so it doesn't sit
              // under the prompt input.
              allowHorizontalScroll
            />
          </div>
        );
      })}
    </div>
  );
}

function PreviewUrlButton({ worktree }: { worktree: Worktree }) {
  const state = useAppState();
  const project = state.projects[worktree.projectId];
  const cfg = projectSettings(project);
  const url = cfg.previewUrl.trim();
  if (!url) return null;
  // Accept both $GOONWARE_* (current) and $RLI_* (legacy) placeholder names
  // so existing previewUrl values keep working after the rename.
  const resolved = url
    .replace(/\$(?:Goonware|RLI)_WORKTREE_NAME/g, worktree.name)
    .replace(/\$(?:Goonware|RLI)_PROJECT_ID/g, worktree.projectId)
    .replace(/\$(?:Goonware|RLI)_PORT/g, "3000");
  return (
    <button
      type="button"
      onClick={() => {
        void invoke("system_open", { path: resolved }).catch(() => {});
      }}
      title={`Open ${resolved}`}
      style={{
        height: 22,
        padding: "0 8px",
        marginRight: 4,
        backgroundColor: "transparent",
        color: "var(--text-secondary)",
        border: "var(--border-1)",
        borderRadius: "var(--radius-sm)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--weight-medium)",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "var(--text-primary)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "var(--text-secondary)";
      }}
    >
      Open <ArrowSquareOut size={11} />
    </button>
  );
}

function ScriptPanel({
  worktree,
  kind,
}: {
  worktree: Worktree;
  kind: "setup" | "run";
}) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const project = state.projects[worktree.projectId];
  const cfg = projectSettings(project);
  const script = (kind === "run" ? cfg.runScript : cfg.setupScript).trim();

  const openSettings = () => {
    if (!project) return;
    dispatch({
      type: "set-settings-open",
      open: true,
      section: { kind: "repository", id: project.id },
    });
  };

  const playInTerminal = async () => {
    if (!script) return;
    const ptyId =
      worktree.secondaryActiveTerminalId ??
      worktree.secondaryTerminals?.[0] ??
      worktree.secondaryPtyId;
    if (!ptyId) return;
    dispatch({ type: "set-secondary-tab", worktreeId: worktree.id, tab: "terminal" });
    const bytes = Array.from(new TextEncoder().encode(script + "\n"));
    await invoke("term_input", { id: ptyId, data: bytes }).catch(() => {});
  };

  if (!script) {
    return (
      <div
        style={{
          height: "100%",
          display: "grid",
          placeItems: "center",
          padding: "var(--space-4)",
        }}
      >
        <div
          style={{
            width: 280,
            padding: "var(--space-4)",
            border: "1px dashed var(--border-default)",
            borderRadius: "var(--radius-md)",
            color: "var(--text-tertiary)",
            fontSize: "var(--text-xs)",
            textAlign: "center",
            display: "grid",
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={openSettings}
            style={{
              padding: "8px 12px",
              backgroundColor: "var(--surface-3)",
              color: "var(--text-primary)",
              borderRadius: "var(--radius-sm)",
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-medium)",
              border: "var(--border-1)",
              justifySelf: "center",
              cursor: "pointer",
            }}
          >
            Add {kind} script
          </button>
          <span>
            {kind === "run"
              ? "Run tests or a dev server to verify changes in this workspace"
              : "Bootstrap a fresh workspace (install deps, prep env, etc.)"}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateRows: "auto 1fr",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "var(--space-2) var(--space-3)",
          borderBottom: "var(--border-1)",
        }}
      >
        <button
          type="button"
          onClick={() => void playInTerminal()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            height: 24,
            padding: "0 10px",
            backgroundColor: "var(--accent-press)",
            color: "var(--text-primary)",
            borderRadius: "var(--radius-sm)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-xs)",
            fontWeight: "var(--weight-medium)",
            cursor: "pointer",
            border: "none",
          }}
          title={`Run ${kind} script in the active terminal`}
        >
          <CaretRight size={10} weight="fill" /> Run
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={openSettings}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-2xs)",
            cursor: "pointer",
          }}
        >
          edit
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: "var(--space-3)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm)",
          color: "var(--text-primary)",
          lineHeight: "var(--leading-md)",
          whiteSpace: "pre-wrap",
          overflow: "auto",
          backgroundColor: "var(--surface-1)",
        }}
      >
        {script}
      </pre>
    </div>
  );
}

void fs;
// ChecksView is currently unrouted — its panel slot now hosts the
// Browser tab. The component itself is retained because checks are
// likely to come back as a different surface (status bar pill or
// notifications drawer), so deleting and re-implementing would be
// wasted work. The `void` reference silences the unused-locals
// diagnostic without contributing runtime cost.
void ChecksView;
