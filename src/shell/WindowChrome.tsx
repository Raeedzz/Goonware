import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { invoke } from "@tauri-apps/api/core";
import { SearchIcon } from "@/primitives/Icon";
import {
  IconEdit,
  IconPlusMinus,
  IconPullRequest,
  IconSparkles,
} from "@/design/icons";
import { useIsFullscreen } from "@/hooks/useIsFullscreen";
import {
  useActiveWorktree,
  useAppDispatch,
  useAppState,
} from "@/state/AppState";
import { useToast } from "@/primitives/Toast";
import { projectSettings, type Tab, type Worktree } from "@/state/types";
import { collectWorktreePtyIds, worktreeArchive } from "@/lib/worktrees";
import { forgetPtys } from "@/terminal/sessionMemory";

const TRAFFIC_LIGHT_GUTTER = 78;
// 36px matches the right panel's tab bar exactly, so the two
// strips read as one continuous chrome plane when laid out
// side-by-side. A 28px button sits centered with 4px of breathing
// room above/below — tight but consistent across both surfaces.
const HEIGHT = 36;
const PR_POLL_MS = 12_000;
// Diff-stat polls the worktree HEAD for additions/deletions every
// 8s — same cadence ballpark as the changes panel, so the chrome
// counter and the right-panel badge stay in lockstep without doubling
// up on git work.
const DIFF_STAT_POLL_MS = 8_000;

interface PrStatus {
  exists: boolean;
  number: number | null;
  url: string | null;
  state: string | null;
  mergeable: string | null;
}

interface ConflictResult {
  conflicts: boolean;
  files: string[];
  alreadyUpToDate: boolean;
}

/**
 * Thin window-chrome strip pinned to the very top of the app. Houses
 * the search summoner (centered) and the per-branch action button on
 * the right — Create PR / Merge / Resolve conflicts depending on the
 * worktree's PR state. The button polls `gh pr view` every 12s.
 */
export function WindowChrome() {
  const dispatch = useAppDispatch();
  const isFullscreen = useIsFullscreen();
  const worktree = useActiveWorktree();

  return (
    <div
      data-tauri-drag-region
      style={{
        position: "relative",
        height: HEIGHT,
        flexShrink: 0,
        backgroundColor: "var(--surface-2)",
        borderBottom: "var(--border-1)",
        paddingLeft: isFullscreen ? "var(--space-2)" : TRAFFIC_LIGHT_GUTTER,
        paddingRight: "var(--space-2)",
        userSelect: "none",
        transition:
          "padding-left var(--motion-fast) var(--ease-out-quart)",
      }}
    >
      <div
        data-tauri-drag-region
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          display: "flex",
          alignItems: "center",
          lineHeight: 0,
        }}
      >
        <SearchTrigger
          onOpen={() => dispatch({ type: "set-search", open: true })}
        />
      </div>

      <div
        data-tauri-drag-region
        style={{
          position: "absolute",
          top: "50%",
          // var(--space-3) (12px) instead of space-2 — pulls the
          // button cluster off the right edge so it has visible
          // padding against the window border, not flush.
          right: "var(--space-3)",
          transform: "translateY(-50%)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <DiffTrigger worktree={worktree} />
        <BranchActionButton worktree={worktree} />
      </div>
    </div>
  );
}

function BranchActionButton({ worktree }: { worktree: Worktree | null }) {
  const dispatch = useAppDispatch();
  const toast = useToast();
  const state = useAppState();
  const branch = worktree?.branch ?? "";
  const path = worktree?.path ?? "";
  const archiveOnMerge = state.settings.archiveOnMerge;
  const deleteBranchOnArchive = state.settings.deleteBranchOnArchive;
  const project = worktree ? state.projects[worktree.projectId] : null;

  const [pr, setPr] = useState<PrStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // Latch so the polling-driven archive-on-merge handler fires exactly
  // once per worktree, even though `pr.state` keeps reporting MERGED
  // on subsequent polls until the worktree disappears from state.
  const archivedRef = useRef<Record<string, boolean>>({});

  const archiveAfterMerge = useCallback(async () => {
    if (!worktree) return;
    if (archivedRef.current[worktree.id]) return;
    archivedRef.current[worktree.id] = true;
    try {
      const cfg = projectSettings(project);
      const record = await worktreeArchive(worktree, project?.path ?? null, {
        stash: true,
        force: false,
        deleteBranch: deleteBranchOnArchive,
        archiveScript: cfg.archiveScript,
      });
      // Cascade-delete the worktree's persisted block history + kill
      // live PTYs. See the matching call in Sidebar.tsx for the
      // rationale (restore mints fresh ids, originals are orphaned).
      forgetPtys(collectWorktreePtyIds(worktree, state.tabs));
      dispatch({ type: "archive-worktree", id: worktree.id, record });
      toast.show({ message: `Archived ${worktree.name} after merge` });
    } catch (e) {
      archivedRef.current[worktree.id] = false;
      toast.show({ message: `Auto-archive failed: ${e}` });
    }
  }, [worktree, project, deleteBranchOnArchive, dispatch, toast]);

  // The button is always shown and clickable when a worktree is
  // active. PR-status polling only runs once we have a branch to look
  // up — querying gh pr view with no branch is pointless.
  const canQuery = !!worktree && branch.length > 0;
  const refresh = useCallback(async () => {
    if (!canQuery) {
      setPr(null);
      return;
    }
    try {
      const status = await invoke<PrStatus>("pr_status", {
        cwd: path,
        branch,
      });
      setPr(status);
    } catch {
      setPr(null);
    }
  }, [canQuery, path, branch]);

  useEffect(() => {
    void refresh();
    if (!canQuery) return;
    const t = window.setInterval(() => void refresh(), PR_POLL_MS);
    const onGitRefresh = (e: Event) => {
      const detail = (e as CustomEvent<{ cwd?: string }>).detail;
      if (!detail?.cwd || detail.cwd === path) void refresh();
    };
    window.addEventListener("goonware-git-refresh", onGitRefresh);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("goonware-git-refresh", onGitRefresh);
    };
  }, [canQuery, refresh, path]);

  // Polling-driven archive-on-merge. Fires when a poll reveals the PR
  // has flipped to MERGED — covers the case where the user merged on
  // GitHub web instead of via the in-app button. The `archivedRef`
  // latch keeps it from re-firing on subsequent polls.
  useEffect(() => {
    if (!archiveOnMerge) return;
    if (!worktree) return;
    if (pr?.state !== "MERGED") return;
    void archiveAfterMerge();
  }, [archiveOnMerge, worktree, pr?.state, archiveAfterMerge]);

  // Find a terminal-tab PTY to inject a prompt into when delegating
  // conflict resolution to the agent. Falls back to the secondary
  // panel's active terminal if no main-column terminal is open.
  const targetPtyId = useMemo(() => {
    if (!worktree) return null;
    const activeTab = worktree.activeTabId
      ? state.tabs[worktree.activeTabId]
      : null;
    if (activeTab && isTerminal(activeTab)) return activeTab.ptyId;
    for (const id of worktree.tabIds) {
      const t = state.tabs[id];
      if (t && isTerminal(t)) return t.ptyId;
    }
    return (
      worktree.secondaryActiveTerminalId ??
      worktree.secondaryPtyId ??
      null
    );
  }, [worktree, state.tabs]);

  const merge = useCallback(async () => {
    if (!worktree || !pr?.number) return;
    setBusy(true);
    try {
      await invoke("pr_merge", {
        cwd: path,
        number: pr.number,
        method: "merge",
      });
      // Notify the Changes panel (and anyone else watching) that the
      // worktree's git state may have shifted after the server-side
      // merge, so they can drop stale "uncommitted changes" rows.
      window.dispatchEvent(
        new CustomEvent("goonware-git-refresh", { detail: { cwd: path } }),
      );
      toast.show({ message: `Merged PR #${pr.number} into ${branch === "master" ? "master" : "main"}.` });
      await refresh();
      if (archiveOnMerge) {
        void archiveAfterMerge();
      }
    } catch (e) {
      toast.show({ message: `Merge failed: ${e}` });
    } finally {
      setBusy(false);
    }
  }, [worktree, pr, path, branch, refresh, toast]);

  const resolveConflicts = useCallback(async () => {
    if (!worktree) return;
    setBusy(true);
    try {
      const result = await invoke<ConflictResult>(
        "merge_base_into_branch",
        { cwd: path, base: "main" },
      );
      if (!result.conflicts) {
        window.dispatchEvent(
          new CustomEvent("goonware-git-refresh", { detail: { cwd: path } }),
        );
        toast.show({
          message: result.alreadyUpToDate
            ? "Branch is already up to date with main."
            : "Merged main into branch — no conflicts. Push to retry the PR merge.",
        });
        await refresh();
        return;
      }
      // Conflicts present in working tree. Hand off to the worktree's
      // agent via PTY injection — user sees the agent work in real
      // time, which beats a one-shot helperRun for a multi-file edit.
      const fileList = result.files.slice(0, 24).join(", ");
      const project = state.projects[worktree.projectId];
      const cfg = projectSettings(project);
      const extras = [cfg.prefs.general, cfg.prefs.resolveConflicts]
        .map((s) => s.trim())
        .filter(Boolean)
        .join("\n\n");
      const prompt =
        `Merge conflicts after pulling main into this branch. ` +
        `Files: ${fileList}. ` +
        `Read each conflicted file, resolve the <<<<<<<, =======, >>>>>>> markers ` +
        `keeping the correct intent, then run \`git add <files>\`, \`git commit --no-edit\`, ` +
        `and \`git push\`. Don't ask for confirmation between files — just resolve them all.` +
        (extras ? `\n\n${extras}` : "");
      if (targetPtyId) {
        const bytes = stringToUtf8Bytes(prompt + "\n");
        await invoke("term_input", { id: targetPtyId, data: bytes }).catch(
          () => undefined,
        );
        toast.show({
          message: `Conflicts in ${result.files.length} file${result.files.length === 1 ? "" : "s"} — sent to agent.`,
        });
      } else {
        toast.show({
          message: `Conflicts in ${result.files.length} file${result.files.length === 1 ? "" : "s"}. Open your agent terminal and ask it to resolve.`,
        });
      }
      await refresh();
    } catch (e) {
      toast.show({ message: `Resolve failed: ${e}` });
    } finally {
      setBusy(false);
    }
  }, [worktree, path, targetPtyId, refresh, toast]);

  const openCreatePR = (m: "manual" | "auto") => {
    if (!worktree) return;
    dispatch({ type: "set-pr-dialog", worktreeId: worktree.id, mode: m });
  };

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(
    null,
  );
  const menuAnchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const toggleMenu = () => {
    setMenuOpen((prev) => {
      const next = !prev;
      if (next && menuAnchorRef.current) {
        const rect = menuAnchorRef.current.getBoundingClientRect();
        setMenuPos({
          top: rect.bottom + 6,
          right: window.innerWidth - rect.right,
        });
      }
      return next;
    });
  };

  // Close on outside click / escape so the popover never gets stuck.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      const inAnchor =
        menuAnchorRef.current && menuAnchorRef.current.contains(target);
      const inMenu = menuRef.current && menuRef.current.contains(target);
      if (!inAnchor && !inMenu) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // ----- render -----

  if (!worktree) {
    return <ActionButton kind="create-pr" disabled onClick={() => {}} />;
  }
  if (busy) {
    return <ActionButton kind="working" disabled onClick={() => {}} />;
  }
  if (!pr || !pr.exists || pr.state === "MERGED" || pr.state === "CLOSED") {
    return (
      <>
        <div
          ref={menuAnchorRef}
          data-tauri-drag-region={false}
          style={{ position: "relative", display: "inline-flex" }}
        >
          <ActionButton
            kind="create-pr"
            aria-expanded={menuOpen}
            onClick={toggleMenu}
          />
        </div>
        {menuPos &&
          createPortal(
            <AnimatePresence>
              {menuOpen && (
                <CreatePRMenu
                  ref={menuRef}
                  top={menuPos.top}
                  right={menuPos.right}
                  onPick={(m) => {
                    setMenuOpen(false);
                    openCreatePR(m);
                  }}
                />
              )}
            </AnimatePresence>,
            document.body,
          )}
      </>
    );
  }
  if (pr.mergeable === "CONFLICTING") {
    return <ActionButton kind="resolve" onClick={resolveConflicts} />;
  }
  // MERGEABLE or UNKNOWN — UNKNOWN is GitHub still computing; let the
  // user try, gh will surface the failure if it isn't actually clean.
  return <ActionButton kind="merge" onClick={merge} />;
}

function CreatePRMenu({
  ref,
  top,
  right,
  onPick,
}: {
  ref: Ref<HTMLDivElement>;
  top: number;
  right: number;
  onPick: (mode: "manual" | "auto") => void;
}) {
  return (
    <motion.div
      ref={ref}
      role="menu"
      aria-label="Create PR options"
      data-tauri-drag-region={false}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      style={{
        position: "fixed",
        top,
        right,
        minWidth: 220,
        backgroundColor: "var(--surface-2)",
        border: "var(--border-1)",
        borderRadius: "var(--radius-md)",
        boxShadow:
          "0 10px 30px -8px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.35)",
        padding: 4,
        zIndex: 9999,
        userSelect: "none",
      }}
    >
      <CreatePRMenuItem
        Glyph={IconSparkles}
        label="Create draft PR"
        sublabel="Auto-write title + body"
        onClick={() => onPick("auto")}
      />
      <CreatePRMenuItem
        Glyph={IconEdit}
        label="Draft manually"
        sublabel="Write title + body yourself"
        onClick={() => onPick("manual")}
      />
    </motion.div>
  );
}

function CreatePRMenuItem({
  Glyph,
  label,
  sublabel,
  onClick,
}: {
  Glyph: ComponentType<{ size?: number }>;
  label: string;
  sublabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "8px 10px",
        backgroundColor: "transparent",
        color: "var(--text-primary)",
        borderRadius: "var(--radius-sm)",
        textAlign: "left",
        cursor: "pointer",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "var(--surface-3)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 24,
          height: 24,
          flexShrink: 0,
          color: "var(--accent-bright)",
        }}
      >
        <Glyph size={14} />
      </span>
      <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span
          style={{
            fontSize: "var(--text-xs)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--text-primary)",
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
          }}
        >
          {sublabel}
        </span>
      </span>
    </button>
  );
}

type ButtonKind = "create-pr" | "merge" | "resolve" | "working";

function ActionButton({
  kind,
  onClick,
  disabled,
  "aria-expanded": ariaExpanded,
}: {
  kind: ButtonKind;
  onClick: () => void;
  disabled?: boolean;
  "aria-expanded"?: boolean;
}) {
  const label =
    kind === "create-pr"
      ? "Create PR"
      : kind === "merge"
        ? "Merge"
        : kind === "resolve"
          ? "Resolve conflicts"
          : "Working…";
  const title =
    kind === "create-pr"
      ? "Create pull request"
      : kind === "merge"
        ? "Merge this PR into main"
        : kind === "resolve"
          ? "Pull main, send conflicts to your agent"
          : "Working…";
  // One slot, three intents driven by branch state. Outlines do the
  // talking — blue for "open", green for "ready to ship", red for
  // "blocked". Backgrounds stay near-flat so the chrome doesn't shout.
  const intent: ButtonIntent =
    kind === "resolve" ? "danger" : kind === "merge" ? "success" : "accent";

  return (
    <button
      type="button"
      onClick={onClick}
      data-tauri-drag-region={false}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-haspopup={ariaExpanded !== undefined ? "menu" : undefined}
      aria-expanded={ariaExpanded}
      style={{
        height: 28,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "0 12px",
        backgroundColor: disabled ? "var(--surface-1)" : intentBg(intent),
        color: disabled ? "var(--text-disabled)" : intentText(intent),
        border: `1px solid ${
          disabled ? "var(--border-default)" : intentBorder(intent)
        }`,
        borderRadius: "var(--radius-sm)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-xs)",
        fontWeight: "var(--weight-semibold)",
        letterSpacing: "var(--tracking-tight)",
        cursor: disabled ? "default" : "pointer",
        flexShrink: 0,
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart), border-color var(--motion-instant) var(--ease-out-quart), color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.backgroundColor = intentHoverBg(intent);
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.backgroundColor = intentBg(intent);
      }}
    >
      <IconPullRequest size={13} />
      <span>{label}</span>
    </button>
  );
}

type ButtonIntent = "accent" | "success" | "danger";

function intentBg(intent: ButtonIntent): string {
  if (intent === "success")
    return "color-mix(in oklch, var(--surface-2), var(--state-success) 6%)";
  if (intent === "danger")
    return "color-mix(in oklch, var(--surface-2), var(--state-error) 8%)";
  return "color-mix(in oklch, var(--surface-2), var(--accent) 6%)";
}
function intentHoverBg(intent: ButtonIntent): string {
  if (intent === "success")
    return "color-mix(in oklch, var(--surface-2), var(--state-success) 14%)";
  if (intent === "danger")
    return "color-mix(in oklch, var(--surface-2), var(--state-error) 16%)";
  return "color-mix(in oklch, var(--surface-2), var(--accent) 14%)";
}
// Mute the borders by mixing the intent color into the surface so the
// outline reads as restrained instrument-glass, not an LED. Pulling
// the chroma down is the "less bright" the user asked for.
function intentBorder(intent: ButtonIntent): string {
  if (intent === "success")
    return "color-mix(in oklch, var(--surface-3), var(--state-success) 55%)";
  if (intent === "danger")
    return "color-mix(in oklch, var(--surface-3), var(--state-error) 55%)";
  return "color-mix(in oklch, var(--surface-3), var(--accent) 55%)";
}
function intentText(intent: ButtonIntent): string {
  if (intent === "success")
    return "color-mix(in oklch, var(--text-primary), var(--state-success) 35%)";
  if (intent === "danger")
    return "color-mix(in oklch, var(--text-primary), var(--state-error) 35%)";
  return "color-mix(in oklch, var(--text-primary), var(--accent) 35%)";
}

function isTerminal(t: Tab): t is Extract<Tab, { kind: "terminal" }> {
  return t.kind === "terminal";
}

function stringToUtf8Bytes(s: string): number[] {
  const enc = new TextEncoder();
  return Array.from(enc.encode(s));
}

/**
 * Centered search summoner. Pill-shaped tall input styled after the
 * search modal — prominent leading magnifier, dark surface that pops
 * against `--surface-2` chrome, generous internal padding. Click or
 * ⌘K opens the real palette overlay; the chrome version is the
 * read-only handoff that signals "search lives here, always."
 */
function SearchTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-tauri-drag-region={false}
      title="Search  ⌘K"
      aria-label="Search"
      style={{
        // Wider than the previous 360 to match the new bar's heft;
        // 50vw cap keeps it from running into the right-side buttons
        // on narrow windows.
        width: 460,
        maxWidth: "50vw",
        // 28px matches the side buttons so the chrome reads as a
        // single horizontal rail of equal-height controls — search
        // sitting at a different height from the action buttons
        // breaks that.
        height: 28,
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "0 14px",
        // Dark surface (one step darker than the bar) with a soft
        // 1px hairline. Reads as an inset well at rest, lifts on
        // hover. Matches the search-modal look.
        backgroundColor: "var(--surface-0)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-md)",
        cursor: "text",
        textAlign: "left",
        transition:
          "background-color var(--motion-fast) var(--ease-out-quart), border-color var(--motion-fast) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "var(--surface-1)";
        e.currentTarget.style.borderColor = "var(--border-default)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "var(--surface-0)";
        e.currentTarget.style.borderColor = "var(--border-subtle)";
      }}
    >
      <span
        style={{
          color: "var(--text-tertiary)",
          display: "inline-flex",
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        <SearchIcon size={15} />
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-sm)",
          color: "var(--text-tertiary)",
          letterSpacing: "var(--tracking-tight)",
        }}
      >
        Search files, sessions, agents…
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
          color: "var(--text-disabled)",
          flexShrink: 0,
        }}
      >
        ⌘K
      </span>
    </button>
  );
}

/**
 * `+N -M` button to the left of the PR action. Polls `git diff
 * --shortstat HEAD` so the counts include every uncommitted change
 * (staged + unstaged) in one number, matching what the
 * `AllChangesView` will show when clicked. Always visible when a
 * worktree is active — even at `0 0`, so the header has a stable
 * shape and the user can still click through to review history.
 */
function DiffTrigger({ worktree }: { worktree: Worktree | null }) {
  const dispatch = useAppDispatch();
  const state = useAppState();
  const [stat, setStat] = useState<{
    files: number;
    insertions: number;
    deletions: number;
  } | null>(null);
  const path = worktree?.path ?? "";

  useEffect(() => {
    if (!worktree) {
      setStat(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await invoke<{
          files: number;
          insertions: number;
          deletions: number;
        }>("git_diff_stat", { cwd: path });
        if (!cancelled) setStat(s);
      } catch {
        if (!cancelled) setStat(null);
      }
    };
    void poll();
    const t = window.setInterval(poll, DIFF_STAT_POLL_MS);
    const onRefresh = (e: Event) => {
      const detail = (e as CustomEvent<{ cwd?: string }>).detail;
      if (!detail?.cwd || detail.cwd === path) void poll();
    };
    window.addEventListener("goonware-git-refresh", onRefresh);
    return () => {
      cancelled = true;
      window.clearInterval(t);
      window.removeEventListener("goonware-git-refresh", onRefresh);
    };
  }, [worktree, path]);

  if (!worktree) return null;
  const insertions = stat?.insertions ?? 0;
  const deletions = stat?.deletions ?? 0;
  const files = stat?.files ?? 0;

  const openChanges = () => {
    // Reuse an open "all-changes" tab for this worktree if there is
    // one — opening the diff trigger repeatedly should select the
    // existing tab, not stack new ones.
    const existing = worktree.tabIds.find((id) => {
      const t = state.tabs[id];
      return t && t.kind === "all-changes";
    });
    if (existing) {
      dispatch({ type: "select-tab", worktreeId: worktree.id, id: existing });
      return;
    }
    const id = `t_changes_${Date.now().toString(36)}`;
    dispatch({
      type: "open-tab",
      tab: {
        id,
        worktreeId: worktree.id,
        kind: "all-changes",
        title: "Changes",
        summary: "",
        summaryUpdatedAt: Date.now(),
      },
    });
  };

  return (
    <button
      type="button"
      onClick={openChanges}
      data-tauri-drag-region={false}
      title={
        files === 0
          ? "No changes — open changes view"
          : `Review ${files} file${files === 1 ? "" : "s"} · +${insertions} −${deletions}`
      }
      aria-label="Review all changes"
      style={{
        // Mirror ActionButton exactly so the diff and PR controls read
        // as a single matched pair of chips in the chrome — same
        // height, same padding, same font size, same icon size,
        // same gap. Anything off-axis between them breaks the rail.
        height: 28,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "0 12px",
        backgroundColor: "var(--surface-1)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
        flexShrink: 0,
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        fontWeight: "var(--weight-semibold)",
        // Drop line-height to 1 at the button level so any vertical
        // padding from the inherited body line-height can't push the
        // numbers off the visual midline.
        lineHeight: 1,
        letterSpacing: 0,
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart), border-color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "var(--surface-2)";
        e.currentTarget.style.borderColor = "var(--border-strong)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "var(--surface-1)";
        e.currentTarget.style.borderColor = "var(--border-default)";
      }}
    >
      {/*
        Every child of the button is wrapped in a flex box of the
        exact same fixed height (13 — matching the icon's size) so
        the button's `alignItems: center` has identical geometry on
        every slot. Nothing can ride high or low because of font
        ascent/descent quirks: each slot is its own 13px line-box
        with the glyph centered inside.
      */}
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-tertiary)",
          height: 13,
          flexShrink: 0,
        }}
      >
        <IconPlusMinus size={13} />
      </span>
      <DiffCount color="var(--diff-add-fg)" sign="+" value={insertions} />
      <DiffCount color="var(--diff-remove-fg)" sign="−" value={deletions} />
    </button>
  );
}

/**
 * One half of the diff-button count strip. The sign and digit are
 * rendered in the same 13px-tall flex box as the icon next to it, so
 * all three slots — icon, `+N`, `−M` — share an identical vertical
 * extent. The `−` glyph gets a half-pixel downward nudge because
 * U+2212 in JetBrains Mono sits a hair above the math axis vs. `+`;
 * the nudge applies to the sign only, never the digit, so the `5`
 * in `+5` and the `5` in `−5` stay on the exact same baseline.
 */
function DiffCount({
  color,
  sign,
  value,
}: {
  color: string;
  sign: "+" | "−";
  value: number;
}) {
  return (
    <span
      className="tabular"
      style={{
        color,
        display: "inline-flex",
        alignItems: "center",
        height: 13,
        lineHeight: 1,
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          height: 13,
          // Optical compensation for the U+2212 minus, which renders
          // ~0.5px above the math axis in JetBrains Mono while `+` is
          // centered on it. Plus stays at 0.
          transform: sign === "−" ? "translateY(0.5px)" : "none",
          // 1px of room either side of the sign so it doesn't crowd
          // the digit (no `+5` mashed-together feel) without breaking
          // the tight-pairing intent.
          marginRight: 1,
        }}
      >
        {sign}
      </span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          height: 13,
        }}
      >
        {value}
      </span>
    </span>
  );
}
