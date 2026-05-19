import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Tooltip, useTooltipAnchor } from "@/primitives/Tooltip";
import { Loader } from "@/primitives/Loader";
import { IconPickerDialog } from "@/shell/IconPickerDialog";
import { ContextMenu, type ContextMenuItem } from "@/shell/ContextMenu";
import { lookupPickerIcon } from "@/design/picker-icons";
import {
  IconSidebar,
  IconBack,
  IconForward,
  IconHistory,
  IconFolderAdd,
  IconPlus,
  IconBranch,
  IconClose,
  IconSettings,
  IconEdit,
  IconPullRequest,
} from "@/design/icons";
import { Image01Icon, Link01Icon, ViewOffIcon, Delete01Icon } from "hugeicons-react";
import {
  useActiveWorktree,
  useAppDispatch,
  useAppState,
} from "@/state/AppState";
import {
  applyBranchPrefix,
  projectSettings,
  type ArchiveRecord,
  type Project,
  type Tab,
  type Worktree,
} from "@/state/types";
import { openProjectDialog } from "@/lib/projectDialog";
import {
  nextAutoBranch,
  worktreeArchive,
  primaryTerminalTab,
  worktreeCreate,
  worktreeRestore,
} from "@/lib/worktrees";
import { useToast } from "@/primitives/Toast";
import { useTrackAgentActivity } from "@/state/agentActivityStore";

/**
 * Left rail. Flat agent-card list — one card per worktree, regardless
 * of which project owns it. The project root is shown on the card
 * itself (`~/...`) instead of as a section header.
 *
 *   ┌─────────────────────────────┐
 *   │  ◯ todo.md          ╴       │  card chrome:
 *   │     ~/Developer             │   row 1: avatar + name (+ badge)
 *   │     ⌥ main                  │   row 2: project path
 *   │     wiring up the OSC…      │   row 3: branch
 *   └─────────────────────────────┘   row 4: live activity summary
 *
 * Active card: surface-3 fill + 2px accent left strip. Running agent:
 * pulsing accent dot on the avatar. Hover ✕ archives the worktree.
 */
export function Sidebar() {
  const state = useAppState();
  const activeWorktree = useActiveWorktree();

  if (state.sidebarCollapsed) {
    return <CollapsedRail />;
  }

  const projectIds = state.projectOrder.length
    ? state.projectOrder
    : Object.keys(state.projects);

  return (
    <div
      style={{
        height: "100%",
        minWidth: 0,
        display: "grid",
        gridTemplateRows: "auto auto 1fr auto",
        color: "var(--text-secondary)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
      }}
    >
      <SidebarHeader />
      <HistorySection records={state.archivedWorktrees} />

      <div
        style={{
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
        <ProjectsHeader />
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: "0 var(--space-1) var(--space-2)",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {projectIds.map((id) => {
            const project = state.projects[id];
            if (!project) return null;
            const projectWorktrees = Object.values(state.worktrees).filter(
              (w) => w.projectId === id,
            );
            return (
              <ProjectGroup
                key={id}
                project={project}
                worktrees={projectWorktrees}
                activeWorktreeId={activeWorktree?.id ?? null}
              />
            );
          })}
          {projectIds.length === 0 && (
            <li
              style={{
                padding: "var(--space-3)",
                color: "var(--text-tertiary)",
                fontSize: "var(--text-xs)",
              }}
            >
              No projects yet — press ⌘O to open a folder.
            </li>
          )}
        </ul>
      </div>

      <SidebarFooter />
    </div>
  );
}

/* ------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------ */


/* ------------------------------------------------------------------
   Header rows
   ------------------------------------------------------------------ */

function SidebarHeader() {
  const dispatch = useAppDispatch();
  return (
    <div
      style={{
        height: 32,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "0 var(--space-2)",
        borderBottom: "var(--border-1)",
        color: "var(--text-tertiary)",
      }}
    >
      <IconButton
        title="Collapse sidebar · ⌘B"
        onClick={() => dispatch({ type: "toggle-sidebar" })}
      >
        <IconSidebar size={16} />
      </IconButton>
      <div style={{ flex: 1 }} />
      <IconButton title="Back" disabled>
        <IconBack size={14} />
      </IconButton>
      <IconButton title="Forward" disabled>
        <IconForward size={14} />
      </IconButton>
    </div>
  );
}

function ProjectsHeader() {
  const dispatch = useAppDispatch();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 26,
        padding: "0 var(--space-2) 0 var(--space-3)",
        color: "var(--text-tertiary)",
        fontSize: "var(--text-xs)",
        letterSpacing: "var(--tracking-wide)",
      }}
    >
      <span>Projects</span>
      <span style={{ flex: 1 }} />
      <SmallIconButton
        title="Open file"
        onClick={() => void openProjectDialog(dispatch)}
      >
        <IconFolderAdd size={14} />
      </SmallIconButton>
    </div>
  );
}

/* ------------------------------------------------------------------
   Project group: header (glyph + name + add) + worktree rows
   ------------------------------------------------------------------ */

function ProjectGroup({
  project,
  worktrees,
  activeWorktreeId,
}: {
  project: Project;
  worktrees: Worktree[];
  activeWorktreeId: string | null;
}) {
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [hovering, setHovering] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(
    null,
  );

  const state = useAppState();
  const onCreate = async () => {
    const base = nextAutoBranch(project.id, state);
    const branch = applyBranchPrefix(
      base,
      state.settings.branchPrefixMode,
      state.settings.githubUsername,
      state.settings.customBranchPrefix,
    );
    const cfg = projectSettings(project);
    try {
      const w = await worktreeCreate(
        project.id,
        project.path,
        branch,
        base,
        {
          baseRef: cfg.baseBranch,
          filesToCopy: cfg.filesToCopy,
          setupScript: cfg.setupScript,
        },
      );
      dispatch({ type: "add-worktree", worktree: w });
      dispatch({ type: "open-tab", tab: primaryTerminalTab(w) });
    } catch (err) {
      toast.show({ message: `Worktree creation failed: ${err}` });
    }
  };

  const onOpenSettings = () => {
    // Open the full-window Settings overlay deep-linked into this
    // project's Repository page. Lives outside the 3-column shell so
    // settings never steals the center column.
    dispatch({
      type: "set-settings-open",
      open: true,
      section: { kind: "repository", id: project.id },
    });
  };

  const projectMenuItems: ContextMenuItem[] = [
    {
      id: "new-worktree",
      label: "New workspace",
      Glyph: IconPlus,
      shortcut: "⌘N",
      onSelect: () => void onCreate(),
    },
    {
      id: "create-from",
      label: "Create from…",
      Glyph: Link01Icon,
      shortcut: "⌘⇧N",
      onSelect: () => {
        // TODO: open a "create from branch" dialog. For now, behave
        // like New workspace but explicitly mark it as the same flow.
        void onCreate();
      },
    },
    {
      id: "settings",
      label: "Repository settings",
      Glyph: IconSettings,
      shortcut: "⌘,",
      onSelect: onOpenSettings,
    },
    {
      id: "change-icon",
      label: "Change icon",
      Glyph: Image01Icon,
      onSelect: () => setPickerOpen(true),
    },
    {
      id: "hide",
      label: "Hide repository",
      Glyph: ViewOffIcon,
      onSelect: () =>
        dispatch({
          type: "set-project-expanded",
          id: project.id,
          expanded: false,
        }),
    },
    {
      id: "remove",
      label: "Remove repository",
      Glyph: Delete01Icon,
      destructive: true,
      onSelect: () => {
        if (
          window.confirm(
            `Remove ${project.name} from the sidebar? Local files are untouched.`,
          )
        ) {
          dispatch({ type: "remove-project", id: project.id });
        }
      },
    },
  ];

  return (
    <li>
      <div
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenuAnchor({ x: e.clientX, y: e.clientY });
        }}
        onDoubleClick={(e) => {
          // Ignore double-clicks landing on the action buttons.
          const t = e.target as HTMLElement;
          if (t.closest("button")) return;
          e.preventDefault();
          setPickerOpen(true);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          // Sidebar rows share a single 36px height so the project
          // header, History button, and worktree rows line up vertically
          // as a uniform rail.
          height: 36,
          padding: "0 var(--space-2)",
          margin: "0 4px",
          borderRadius: "var(--radius-sm)",
          color: "var(--text-primary)",
          fontSize: "var(--text-sm)",
          fontWeight: "var(--weight-semibold)",
          cursor: "default",
          userSelect: "none",
          backgroundColor: hovering ? "var(--surface-3)" : "transparent",
          transition:
            "background-color var(--motion-instant) var(--ease-out-quart)",
        }}
      >
        <ProjectGlyph project={project} />
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {project.name}
        </span>
        {hovering && (
          <>
            <SmallIconButton
              title="Repository settings"
              onClick={() => void onOpenSettings()}
            >
              <IconSettings size={14} />
            </SmallIconButton>
            <SmallIconButton title="New worktree" onClick={onCreate}>
              <IconPlus size={14} />
            </SmallIconButton>
          </>
        )}
      </div>

      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {worktrees.map((w) => (
          // `isRunning` is derived INSIDE WorktreeRow via the
          // singleton `agentActivityStore` (Claude transcript-mtime
          // poll). The row subscribes per-instance via
          // `useSyncExternalStore`, so only the affected row
          // rerenders when its worktree's activity flips — and
          // because the store is decoupled from the AppState
          // context, unrelated state mutations (polling-driven count
          // updates, badge changes in other worktrees, etc.) skip
          // the row's render entirely. The React.memo wrapper still
          // skips parent-triggered rerenders when the props below
          // are reference-stable.
          <WorktreeRow
            key={w.id}
            worktree={w}
            project={project}
            isActive={activeWorktreeId === w.id}
            archiveBehavior={state.settings.archiveBehavior}
            deleteBranchOnArchive={state.settings.deleteBranchOnArchive}
          />
        ))}
      </ul>

      <IconPickerDialog
        open={pickerOpen}
        targetName={project.name}
        currentIcon={project.iconName}
        currentColor={project.color}
        onSelectIcon={(name) =>
          dispatch({
            type: "set-project-icon",
            id: project.id,
            iconName: name,
          })
        }
        onSelectColor={(c) =>
          dispatch({
            type: "set-project-color",
            id: project.id,
            color: c,
          })
        }
        onRename={(newName) =>
          dispatch({
            type: "update-project",
            id: project.id,
            patch: { name: newName },
          })
        }
        onClose={() => setPickerOpen(false)}
      />

      <ContextMenu
        open={!!menuAnchor}
        anchor={menuAnchor}
        items={projectMenuItems}
        onClose={() => setMenuAnchor(null)}
      />
    </li>
  );
}

function ProjectGlyph({ project }: { project: Project }) {
  // Precedence: user-picked HugeIcon → favicon scanned at project add
  // → first-letter glyph fallback. The HugeIcon path is the user's
  // explicit override; the favicon path is best-effort auto-detection
  // (populated by the backend at scan time, may be null).
  const iconEntry = lookupPickerIcon(project.iconName);
  if (iconEntry) {
    const Glyph = iconEntry.Component;
    return (
      <span
        aria-hidden
        style={{
          width: 18,
          height: 18,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: project.color
            ? `var(--tag-${project.color})`
            : "var(--text-secondary)",
          flexShrink: 0,
        }}
      >
        <Glyph size={16} />
      </span>
    );
  }
  if (project.faviconDataUri) {
    return (
      <img
        src={project.faviconDataUri}
        alt=""
        width={18}
        height={18}
        style={{ borderRadius: 4, flexShrink: 0 }}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{
        width: 18,
        height: 18,
        borderRadius: 4,
        backgroundColor: project.color
          ? `color-mix(in oklch, var(--surface-3), var(--tag-${project.color}) 35%)`
          : "var(--surface-3)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontWeight: 600,
        color: "var(--text-primary)",
        flexShrink: 0,
      }}
    >
      {project.glyph}
    </span>
  );
}

/* ------------------------------------------------------------------
   History
   ------------------------------------------------------------------ */

function HistorySection({ records }: { records: ArchiveRecord[] }) {
  const dispatch = useAppDispatch();
  const projects = useAppState().projects;
  const toast = useToast();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: "var(--border-1)" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          height: 36,
          // History anchors the top-left "tab" of the sidebar — its hover
          // surface fills the row edge-to-edge instead of inset like the
          // worktree rows below. Padding compensates so the icon sits at
          // the same x as the inset rows' content.
          width: "100%",
          margin: 0,
          padding: "0 var(--space-3) 0 calc(var(--space-3) + 4px)",
          color: "var(--text-secondary)",
          backgroundColor: "transparent",
          borderRadius: 0,
          border: "none",
          textAlign: "left",
          cursor: "default",
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
        <IconHistory size={15} />
        <span style={{ fontSize: "var(--text-sm)" }}>History</span>
        <span style={{ flex: 1 }} />
        {records.length > 0 && (
          <span
            className="tabular"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--text-tertiary)",
            }}
          >
            {records.length}
          </span>
        )}
      </button>
      <div
        style={{
          display: "grid",
          gridTemplateRows: open && records.length > 0 ? "1fr" : "0fr",
          transition:
            "grid-template-rows var(--motion-base) var(--ease-out-quart)",
        }}
      >
        <div style={{ overflow: "hidden", minHeight: 0 }}>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {records.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={async () => {
                    const project = projects[r.projectId];
                    if (!project) {
                      toast.show({
                        message:
                          "Restore failed: the project this worktree belonged to is no longer open.",
                      });
                      return;
                    }
                    try {
                      const w = await worktreeRestore(
                        r.id,
                        r.projectId,
                        project.path,
                      );
                      dispatch({
                        type: "restore-worktree",
                        archiveId: r.id,
                        worktree: w,
                      });
                      // The restored worktree comes back with a fresh
                      // primary tab id in w.tabIds[0] but no Tab record
                      // anywhere — Tab carries runtime fields (PTY id,
                      // summary) that only the frontend can mint. Open
                      // the primary terminal tab and focus the worktree
                      // so the user lands on a live shell instead of
                      // an empty pane.
                      dispatch({
                        type: "open-tab",
                        tab: primaryTerminalTab(w),
                      });
                      dispatch({ type: "set-active-project", id: r.projectId });
                      dispatch({
                        type: "set-active-worktree",
                        projectId: r.projectId,
                        worktreeId: w.id,
                      });
                      toast.show({ message: `Restored ${r.name}` });
                    } catch (err) {
                      toast.show({ message: `Restore failed: ${err}` });
                    }
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    height: 24,
                    width: "100%",
                    padding: "0 var(--space-3) 0 30px",
                    color: "var(--text-tertiary)",
                    fontSize: "var(--text-xs)",
                    backgroundColor: "transparent",
                  }}
                  onMouseOver={(e) =>
                    (e.currentTarget.style.backgroundColor = "var(--surface-2)")
                  }
                  onMouseOut={(e) =>
                    (e.currentTarget.style.backgroundColor = "transparent")
                  }
                >
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      textAlign: "left",
                    }}
                  >
                    {r.name}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--text-disabled)",
                    }}
                  >
                    {r.branch}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------
   Worktree row — compact, indented under its project header.
   ------------------------------------------------------------------ */

const WorktreeRow = memo(function WorktreeRowImpl({
  worktree,
  project,
  isActive,
  archiveBehavior,
  deleteBranchOnArchive,
}: {
  worktree: Worktree;
  project: Project;
  isActive: boolean;
  /**
   * `state.settings.archiveBehavior` extracted at the parent. Same
   * memoization reason as `isRunning`: passing only the single
   * string we need lets shallow prop-equality work, instead of
   * the row reading `useAppState().settings` and being subscribed
   * to every settings touch (including unrelated ones).
   */
  archiveBehavior: "ask" | "stash" | "force";
  /** Per-Git-settings tab. Drilled in for the same memo reasons. */
  deleteBranchOnArchive: boolean;
}) {
  // Live "is Claude doing something in this worktree" flag, sourced
  // from the singleton agentActivityStore which polls Claude's
  // transcript-file mtime. Subscribing here (per-row) instead of
  // deriving from props at the parent keeps the spinner state
  // OUTSIDE the AppState context — unrelated dispatches don't touch
  // it, and only rows whose own worktree's activity flipped
  // rerender (the others stay memoized).
  const isRunning = useTrackAgentActivity(worktree.id, worktree.path);
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [hovering, setHovering] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(
    null,
  );
  // Hover-card anchor. Null = card hidden. Holds a DOMRect snapshot of
  // the row so the card can portal to <body> and still align with the
  // sidebar entry it describes — even across scroll/resize, where we
  // re-snapshot on intent rather than tracking continuously.
  const [cardAnchor, setCardAnchor] = useState<DOMRect | null>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  // Cancel any pending show/hide timers when the row unmounts. Without
  // this a fast scroll-then-mount could fire a setState into a dead
  // component (harmless in dev, noisy in prod).
  useEffect(() => {
    return () => {
      if (showTimerRef.current) window.clearTimeout(showTimerRef.current);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, []);

  // 500ms intent delay: long enough that a casual mouse-over scrolling
  // past the rail doesn't pop cards everywhere; short enough that a
  // deliberate hover feels responsive. The cross-fade onto a sibling
  // row (mouse moves to the next worktree before this card mounts)
  // simply cancels the timer — never blinks a card the user didn't
  // ask for.
  const HOVER_INTENT_MS = 500;
  // 120ms grace on close so the cursor can travel from row → card
  // without the card unmounting mid-flight.
  const HOVER_GRACE_MS = 120;

  const cancelTimers = () => {
    if (showTimerRef.current) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (hideTimerRef.current) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  const openCard = () => {
    if (cardAnchor || showTimerRef.current) return;
    showTimerRef.current = window.setTimeout(() => {
      showTimerRef.current = null;
      if (rowRef.current) {
        setCardAnchor(rowRef.current.getBoundingClientRect());
      }
    }, HOVER_INTENT_MS);
  };

  const scheduleClose = () => {
    if (showTimerRef.current) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (hideTimerRef.current) return;
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setCardAnchor(null);
    }, HOVER_GRACE_MS);
  };

  const onSelect = () => {
    dispatch({ type: "set-active-project", id: project.id });
    dispatch({
      type: "set-active-worktree",
      projectId: project.id,
      worktreeId: worktree.id,
    });
  };

  const onDoubleClick = (e: MouseEvent) => {
    // Ignore double-clicks landing on inner buttons (archive ✕, etc.)
    const t = e.target as HTMLElement;
    if (t.closest("button") && t.closest("button") !== e.currentTarget) return;
    e.preventDefault();
    setPickerOpen(true);
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuAnchor({ x: e.clientX, y: e.clientY });
  };

  const onArchive = async (e: MouseEvent) => {
    e.stopPropagation();
    let stash = archiveBehavior !== "force";
    let force = archiveBehavior === "force";
    if (archiveBehavior === "ask") {
      const choice = window.confirm(
        `Archive ${worktree.name}?\n\nOK = stash dirty changes (recoverable from History)\nCancel = abort`,
      );
      if (!choice) return;
      stash = true;
      force = false;
    }
    try {
      const cfg = projectSettings(project);
      const record = await worktreeArchive(worktree, {
        stash,
        force,
        deleteBranch: deleteBranchOnArchive,
        archiveScript: cfg.archiveScript,
      });
      dispatch({ type: "archive-worktree", id: worktree.id, record });
      toast.show({
        message: `Archived ${worktree.name}`,
        action: {
          label: "Restore",
          onClick: async () => {
            try {
              const restored = await worktreeRestore(
                record.id,
                project.id,
                project.path,
              );
              dispatch({
                type: "restore-worktree",
                archiveId: record.id,
                worktree: restored,
              });
              dispatch({
                type: "open-tab",
                tab: primaryTerminalTab(restored),
              });
              dispatch({ type: "set-active-project", id: project.id });
              dispatch({
                type: "set-active-worktree",
                projectId: project.id,
                worktreeId: restored.id,
              });
            } catch (err) {
              toast.show({ message: `Restore failed: ${err}` });
            }
          },
        },
      });
    } catch (err) {
      toast.show({ message: `Archive failed: ${err}` });
    }
  };

  // Idle: transparent. Hover: surface-3 (matches the project header
  // hover so the sidebar reads as one consistent rail). Active:
  // surface-4 fill plus a colored tag tint when set. When colored,
  // blend the tag in subtly so the row reads tinted but doesn't fight
  // the rest of the chrome.
  const colored = !!worktree.color;
  const restingBg = colored
    ? `color-mix(in oklch, transparent, var(--tag-${worktree.color}) 25%)`
    : "transparent";
  const hoverBg = colored
    ? `color-mix(in oklch, var(--surface-3), var(--tag-${worktree.color}) 35%)`
    : "var(--surface-3)";
  const activeBg = colored
    ? `color-mix(in oklch, var(--surface-4), var(--tag-${worktree.color}) 35%)`
    : "var(--surface-4)";
  const startBg = isActive ? activeBg : restingBg;
  const textColor = isActive ? "var(--text-primary)" : "var(--text-secondary)";

  // Match the project header: 4px outer inset on both sides creates a
  // rounded "box" hover that lines up vertically with the header above
  // it. width: calc(100% - 8px) keeps the box from butting against the
  // sidebar's right edge.
  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    width: "calc(100% - 8px)",
    margin: "0 4px",
    height: 36,
    padding: "0 var(--space-2) 0 32px",
    borderRadius: "var(--radius-sm)",
    backgroundColor: startBg,
    color: textColor,
    fontSize: "var(--text-sm)",
    textAlign: "left",
    border: "none",
    cursor: "default",
    transition:
      "background-color var(--motion-instant) var(--ease-out-quart)," +
      "color var(--motion-instant) var(--ease-out-quart)",
  };

  // Glyph precedence: user-picked HugeIcon → running spinner → branch.
  const iconEntry = lookupPickerIcon(worktree.iconName);

  return (
    <li
      ref={rowRef}
      onMouseEnter={() => {
        setHovering(true);
        openCard();
      }}
      onMouseLeave={() => {
        setHovering(false);
        scheduleClose();
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        style={rowStyle}
        // Active rows lock to `activeBg` — hover does NOT override.
        // Without this guard the row visibly flickers when the user
        // mouses over the selected worktree.
        onMouseEnter={(e) => {
          if (isActive) return;
          e.currentTarget.style.backgroundColor = hoverBg;
        }}
        onMouseLeave={(e) => {
          if (isActive) return;
          e.currentTarget.style.backgroundColor = restingBg;
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 16,
            height: 16,
            color: isRunning
              ? "var(--accent)"
              : iconEntry
                ? worktree.color
                  ? `var(--tag-${worktree.color})`
                  : "var(--text-secondary)"
                : "var(--text-tertiary)",
            transition: "color var(--motion-fast) var(--ease-out-quart)",
            flexShrink: 0,
          }}
        >
          {isRunning ? (
            <Loader key="running" size={16} />
          ) : iconEntry ? (
            <iconEntry.Component size={16} />
          ) : (
            <IconBranch key="idle" size={16} />
          )}
        </span>

        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {worktree.name}
        </span>

        {hovering ? (
          <SmallIconButton title="Archive worktree" onClick={onArchive}>
            <IconClose size={12} />
          </SmallIconButton>
        ) : worktree.changeCount > 0 ? (
          <span
            className="tabular"
            style={{
              fontSize: "var(--text-2xs)",
              fontFamily: "var(--font-mono)",
              color: "var(--state-success)",
            }}
          >
            +{worktree.changeCount}
          </span>
        ) : null}
      </button>

      <IconPickerDialog
        open={pickerOpen}
        targetName={worktree.name}
        currentIcon={worktree.iconName}
        currentColor={worktree.color}
        onSelectIcon={(name) =>
          dispatch({
            type: "set-worktree-icon",
            worktreeId: worktree.id,
            iconName: name,
          })
        }
        onSelectColor={(c) =>
          dispatch({
            type: "update-worktree",
            id: worktree.id,
            patch: { color: c },
          })
        }
        onRename={(newName) =>
          dispatch({
            type: "update-worktree",
            id: worktree.id,
            patch: { name: newName },
          })
        }
        onClose={() => setPickerOpen(false)}
      />

      <ContextMenu
        open={!!menuAnchor}
        anchor={menuAnchor}
        items={[
          {
            id: "rename",
            label: "Rename worktree",
            Glyph: IconEdit,
            onSelect: () => setPickerOpen(true),
          },
          {
            id: "icon",
            label: "Change icon",
            Glyph: Image01Icon,
            onSelect: () => setPickerOpen(true),
          },
          {
            id: "color",
            label: "Change color",
            Glyph: Link01Icon,
            onSelect: () => setPickerOpen(true),
          },
          {
            id: "archive",
            label: "Archive worktree",
            Glyph: Delete01Icon,
            destructive: true,
            onSelect: () => {
              const e = {
                stopPropagation: () => undefined,
              } as unknown as MouseEvent;
              void onArchive(e);
            },
          },
        ]}
        onClose={() => setMenuAnchor(null)}
      />

      <AnimatePresence>
        {cardAnchor && (
          <WorktreeHoverCard
            key={worktree.id}
            worktree={worktree}
            project={project}
            anchor={cardAnchor}
            onMouseEnter={cancelTimers}
            onMouseLeave={scheduleClose}
            onCreatePR={() => {
              cancelTimers();
              setCardAnchor(null);
              dispatch({ type: "set-active-project", id: project.id });
              dispatch({
                type: "set-active-worktree",
                projectId: project.id,
                worktreeId: worktree.id,
              });
              dispatch({
                type: "set-pr-dialog",
                worktreeId: worktree.id,
                mode: "auto",
              });
            }}
          />
        )}
      </AnimatePresence>
    </li>
  );
});

/* ------------------------------------------------------------------
   Worktree hover card
   ------------------------------------------------------------------ */

/**
 * Floating card that appears to the right of a worktree row after the
 * user dwells on it for ~500ms. Mirrors conductor.build's worktree
 * peek: branch + change count + status, the worktree name, the most
 * recent activity line, a Create-PR shortcut, and a relative
 * "last-touched" timestamp.
 *
 * Portaled to <body> so it escapes the sidebar's scroll/clip context
 * and can overlap the main column. Anchored to a one-shot DOMRect
 * snapshot — re-snapping on every scroll/resize would be wasted work
 * for a transient surface; if the row moves the user is already moving
 * the cursor too, which closes the card.
 */
function WorktreeHoverCard({
  worktree,
  project,
  anchor,
  onMouseEnter,
  onMouseLeave,
  onCreatePR,
}: {
  worktree: Worktree;
  project: Project;
  anchor: DOMRect;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onCreatePR: () => void;
}) {
  // Read tabs from app state HERE rather than via a prop on the
  // WorktreeRow that owns this card. The hover card only mounts on
  // user-intent hover (a relatively rare event), so its subscription
  // to the full state is fine — but pushing the prop through
  // WorktreeRow would have re-rendered every row in the sidebar on
  // every tab-state change, defeating the memoization that wraps
  // WorktreeRow.
  const tabs = useAppState().tabs;
  // Pick the most recently active tab — its derived title is the
  // 3-5 word distillation the user wants in the bold slot, its full
  // summary is the longer line beneath.
  const bestTab: Tab | null = (() => {
    let best: Tab | null = null;
    for (const id of worktree.tabIds) {
      const t = tabs[id];
      if (!t) continue;
      if (!best || t.summaryUpdatedAt > best.summaryUpdatedAt) best = t;
    }
    return best;
  })();

  // Strip placeholders so we don't surface "ready", "shell", or the
  // worktree's own branch/name as if they were real activity. Returns
  // null when the string carries no information beyond the chrome.
  const clean = (s: string | null | undefined): string | null => {
    if (!s) return null;
    const c = s.replace(/\s+/g, " ").trim();
    if (!c) return null;
    const lc = c.toLowerCase();
    if (lc === "ready" || lc === "untitled" || lc === "shell" || lc === "main")
      return null;
    if (lc === worktree.branch.toLowerCase()) return null;
    if (lc === worktree.name.toLowerCase()) return null;
    return c;
  };
  // Fallback: if for some reason tab.title is still the original full
  // summary (e.g. the placeholder path in MainColumn didn't fire), do
  // our own first-5-words truncation. Keeps the bold slot bounded.
  const toShort = (s: string): string => {
    const words = s.split(" ").filter(Boolean);
    return words.length <= 5 ? s : words.slice(0, 5).join(" ");
  };

  const tabTitle = clean(bestTab?.title);
  const tabSummary = clean(bestTab?.summary);
  // The bold "what's happening" slot. Prefer tab.title since
  // MainColumn already shortened it to first 5 words on the
  // placeholder→derived transition. Fall back to a truncated summary
  // when the title slot is empty. Finally fall back to the worktree's
  // own name so the card always has a non-empty headline.
  const headline =
    tabTitle ?? (tabSummary ? toShort(tabSummary) : null) ?? worktree.name;
  // The longer activity line under the headline. Suppress it when it
  // would just repeat the headline verbatim — once is plenty.
  const activityLine =
    tabSummary && tabSummary !== headline ? tabSummary : null;

  // Use the latest tab summary's timestamp when present — that's the
  // "last touched" moment a user actually cares about. Fall back to the
  // worktree's createdAt for never-touched worktrees.
  const lastTouched = bestTab
    ? Math.max(worktree.createdAt, bestTab.summaryUpdatedAt)
    : worktree.createdAt;

  const CARD_WIDTH = 320;
  // Position to the right of the sidebar row with an 8px gap. If the
  // card would clip the viewport's right edge, flip it to the LEFT of
  // the row — but the sidebar lives at x=0, so realistically we only
  // need the right-side placement. Vertical: align the card's top with
  // the row's top so the eye doesn't have to track up/down on appear.
  const left = anchor.right + 8;
  const top = Math.max(8, anchor.top);

  // The spinner mirrors the sidebar row's behavior: spin only while
  // Claude's transcript file for this worktree is being appended to —
  // i.e., the agent is genuinely processing a turn. Otherwise the
  // hover card would spin perma- whenever claude/codex is open, which
  // defeats the whole point of the signal. Sourced from the same
  // store as the sidebar row, so the two indicators can't disagree.
  const isRunning = useTrackAgentActivity(worktree.id, worktree.path);
  void tabs;

  return createPortal(
    <motion.div
      role="dialog"
      aria-label={`${worktree.name} details`}
      initial={{ opacity: 0, x: -6, scale: 0.985 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: -4, scale: 0.99, transition: { duration: 0.14 } }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: "fixed",
        left,
        top,
        width: CARD_WIDTH,
        // Card chrome: surface-2 (one step above sidebar surface-1)
        // with a strong-enough border to read against the main column
        // without resorting to a glow. Shadow is soft and short — Linear
        // / Superhuman elevation, not glassmorphism.
        backgroundColor: "var(--surface-2)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-md)",
        boxShadow:
          "0 4px 12px oklch(0% 0 0 / 0.30), 0 1px 2px oklch(0% 0 0 / 0.4)",
        padding: "14px 16px 12px",
        zIndex: 1000,
        // Prevent the card itself from being a click-through target on
        // the row underneath when the cursor crosses into it.
        pointerEvents: "auto",
        // The Verlet-grade easing on the inner stagger needs `transform`
        // hints; keep the GPU layer for the whole card so children's
        // motion stays jitter-free at 60fps.
        willChange: "transform, opacity",
      }}
    >
      {/* Top row: branch · +N · status dot */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--text-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            maxWidth: 160,
          }}
          title={worktree.branch}
        >
          {worktree.branch}
        </span>
        {worktree.changeCount > 0 && (
          <span
            className="tabular"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--state-success)",
            }}
          >
            +{worktree.changeCount}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <HoverCardStatusDot running={isRunning} />
      </div>

      {/* Headline — 3-5 word distillation of what the tab is doing.
          Sourced from the most-recently-touched tab's `title`, which
          MainColumn shapes from the first ~5 words of the live agent
          summary on the placeholder→derived transition. */}
      <div
        style={{
          fontSize: "var(--text-lg)",
          fontWeight: "var(--weight-semibold)",
          color: "var(--text-primary)",
          letterSpacing: "var(--tracking-tight)",
          lineHeight: 1.2,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={headline}
      >
        {headline}
      </div>

      {/* Activity line — full summary under the headline. Hidden when
          it would simply repeat the headline. */}
      {activityLine && (
        <motion.div
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            duration: 0.24,
            ease: [0.22, 1, 0.36, 1],
            delay: 0.06,
          }}
          style={{
            marginTop: 4,
            fontSize: "var(--text-sm)",
            color: "var(--text-tertiary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={activityLine}
        >
          {activityLine}
        </motion.div>
      )}

      {/* Bottom row: Create PR · relative time */}
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: 0.24,
          ease: [0.22, 1, 0.36, 1],
          delay: 0.1,
        }}
        style={{
          marginTop: 14,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <CreatePRButton onClick={onCreatePR} disabled={!project} />
        <span style={{ flex: 1 }} />
        <span
          className="tabular"
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-mono)",
          }}
          title={new Date(lastTouched).toLocaleString()}
        >
          {formatRelativeTime(lastTouched)}
        </span>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

/**
 * Status dot for the hover card. While running, paints a pulsing
 * accent ring (one-cell `border-radius:50%` so the spinning arc reads
 * as motion, not noise). Idle, a dashed ring — present so the slot
 * doesn't reflow when the agent kicks off, but quiet enough that it
 * disappears against `--surface-2`.
 */
function HoverCardStatusDot({ running }: { running: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 14,
        height: 14,
        flexShrink: 0,
      }}
    >
      {running ? (
        <Loader size={14} />
      ) : (
        <span
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            border: "1px dashed var(--text-tertiary)",
            borderRadius: "50%",
            opacity: 0.6,
          }}
        />
      )}
    </span>
  );
}

/**
 * The card's Create-PR shortcut. Pressed scale punctuates the click,
 * the hover background lift signals interactivity, the icon nudges
 * 1px on hover — micro-motion that costs nothing at 60fps but makes
 * the affordance feel alive.
 */
function CreatePRButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      whileHover={{ backgroundColor: "var(--surface-4)" }}
      whileTap={{ scale: 0.97 }}
      transition={{ duration: 0.12, ease: [0.25, 1, 0.5, 1] }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 28,
        padding: "0 12px",
        backgroundColor: "var(--surface-3)",
        color: "var(--text-primary)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-sm)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-xs)",
        fontWeight: "var(--weight-medium)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <IconPullRequest size={13} />
      <span>Create PR</span>
    </motion.button>
  );
}

/**
 * Compact "Xd ago" formatter. The card is a glance surface, so we
 * trade resolution for terseness: anything under a minute is "now",
 * minutes/hours/days/weeks otherwise. Reaches for years only when the
 * worktree is genuinely ancient — a rare-enough case that scaling the
 * label by 2 chars isn't worth a special case.
 */
function formatRelativeTime(ts: number): string {
  if (!ts || !Number.isFinite(ts)) return "—";
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

/* ------------------------------------------------------------------
   Footer
   ------------------------------------------------------------------ */

function SidebarFooter() {
  const dispatch = useAppDispatch();
  return (
    <div
      style={{
        height: 32,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 4,
        padding: "0 var(--space-2)",
        borderTop: "var(--border-1)",
      }}
    >
      <IconButton
        title="Settings · ⌘,"
        onClick={() => dispatch({ type: "set-settings-open", open: true })}
      >
        <IconSettings size={16} />
      </IconButton>
    </div>
  );
}

/* ------------------------------------------------------------------
   Primitives
   ------------------------------------------------------------------ */

function IconButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick?: (e: MouseEvent) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const { ref, anchor, beginShow, cancelShow } =
    useTooltipAnchor<HTMLButtonElement>();
  return (
    <>
      <button
        ref={ref}
        type="button"
        title={title}
        onClick={(e) => {
          cancelShow();
          onClick?.(e);
        }}
        disabled={disabled}
        onMouseEnter={(e) => {
          if (disabled) return;
          e.currentTarget.style.backgroundColor = "var(--surface-3)";
          e.currentTarget.style.color = "var(--text-primary)";
          beginShow();
        }}
        onMouseLeave={(e) => {
          if (disabled) return;
          e.currentTarget.style.backgroundColor = "transparent";
          e.currentTarget.style.color = "var(--text-tertiary)";
          cancelShow();
        }}
        style={{
          width: 24,
          height: 24,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "var(--radius-sm)",
          color: disabled ? "var(--text-disabled)" : "var(--text-tertiary)",
          backgroundColor: "transparent",
          cursor: disabled ? "default" : "default",
          transition:
            "background-color var(--motion-instant) var(--ease-out-quart)," +
            "color var(--motion-instant) var(--ease-out-quart)",
        }}
      >
        {children}
      </button>
      <AnimatePresence>
        {!disabled && anchor && <Tooltip label={title} anchor={anchor} />}
      </AnimatePresence>
    </>
  );
}

function SmallIconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick?: (e: MouseEvent) => void;
  children: ReactNode;
}) {
  const { ref, anchor, beginShow, cancelShow } =
    useTooltipAnchor<HTMLButtonElement>();
  return (
    <>
      <button
        ref={ref}
        type="button"
        // Keep the native title as an accessibility fallback. Browsers
        // suppress the native tooltip while our custom one is mounted,
        // so there's no double-tip.
        title={title}
        onClick={(e) => {
          cancelShow();
          onClick?.(e);
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = "var(--surface-3)";
          e.currentTarget.style.color = "var(--text-primary)";
          beginShow();
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = "transparent";
          e.currentTarget.style.color = "var(--text-tertiary)";
          cancelShow();
        }}
        style={{
          width: 18,
          height: 18,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "var(--radius-xs)",
          color: "var(--text-tertiary)",
          backgroundColor: "transparent",
          cursor: "default",
          transition:
            "background-color var(--motion-instant) var(--ease-out-quart)," +
            "color var(--motion-instant) var(--ease-out-quart)",
        }}
      >
        {children}
      </button>
      <AnimatePresence>
        {anchor && <Tooltip label={title} anchor={anchor} />}
      </AnimatePresence>
    </>
  );
}

/* ------------------------------------------------------------------
   Collapsed icon rail — replaces the full sidebar when collapsed.
   ------------------------------------------------------------------ */

function CollapsedRail() {
  const dispatch = useAppDispatch();
  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateRows: "auto 1fr auto",
        padding: "var(--space-2) 0",
        gap: 4,
        justifyItems: "center",
      }}
    >
      <IconButton
        title="Expand sidebar  ⌘B"
        onClick={() => dispatch({ type: "toggle-sidebar" })}
      >
        <IconSidebar size={16} />
      </IconButton>
      <span />
      <IconButton
        title="Settings · ⌘,"
        onClick={() => dispatch({ type: "set-settings-open", open: true })}
      >
        <IconSettings size={16} />
      </IconButton>
    </div>
  );
}
