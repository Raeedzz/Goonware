import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  IconPlus,
  IconClose,
  IconSidebarRight,
} from "@/design/icons";
import { Tooltip, useTooltipAnchor } from "@/primitives/Tooltip";
import {
  useActiveProject,
  useActiveTab,
  useActiveWorktree,
  useAppDispatch,
  useAppState,
  useWorktreeTabs,
} from "@/state/AppState";
import type { Project, Tab, TerminalTab, Worktree } from "@/state/types";
import { projectSettings } from "@/state/types";
import { collectWorktreePtyIds, worktreeArchive } from "@/lib/worktrees";
import { forgetPtys } from "@/terminal/sessionMemory";
import { useToast } from "@/primitives/Toast";
import { FolderDashedIcon } from "@phosphor-icons/react";
import { ErrorBoundary } from "./ErrorBoundary";
import { BlockTerminal } from "@/terminal/BlockTerminal";
import { WarpSurfaceTracker } from "@/terminal/WarpSurfaceTracker";
import { DiffView } from "@/git/DiffView";
import { AllChangesView } from "@/git/AllChangesView";
import { CommitDetailView } from "@/git/CommitDetailView";
import { Editor } from "@/editor/Editor";
import { MarkdownView } from "@/editor/MarkdownView";
import { fs } from "@/lib/fs";
import { RepositorySettingsView } from "./RepositorySettingsView";

/**
 * Center column. Top row: breadcrumb + workspace selector. Then the
 * tab strip (terminal / diff / markdown). Then the active tab's content.
 * Bottom: chatbox.
 */
export function MainColumn() {
  const project = useActiveProject();
  const worktree = useActiveWorktree();
  const tabs = useWorktreeTabs(worktree?.id ?? null);
  const activeTab = useActiveTab();
  const dispatch = useAppDispatch();
  // Dirty-close confirmation: when the user clicks ✕ on a tab whose
  // file has unsaved edits, we hold the tab in this state and render
  // the modal. Clean tabs close immediately and never set this.
  const [pendingClose, setPendingClose] = useState<Tab | null>(null);

  if (!project || !worktree) {
    return (
      <div
        style={{
          height: "100%",
          display: "grid",
          placeItems: "center",
          color: "var(--text-tertiary)",
          fontSize: "var(--text-sm)",
        }}
      >
        Open a project to begin.
      </div>
    );
  }

  // Worktree's directory was deleted between launches. Render a
  // recovery panel instead of trying to start a PTY (which would fail
  // with `cwd does not exist: …` and leave the user staring at the
  // raw Rust error). The two actions mirror what the user can do:
  // archive it (force-forget on the backend — no git ops on the
  // missing path) or, if they re-created the directory manually,
  // close & reopen the app to retrigger the validation sweep.
  if (worktree.missing) {
    return (
      <MissingWorktreeView worktree={worktree} project={project} />
    );
  }

  const requestCloseTab = (tab: Tab) => {
    if (isTabDirty(tab)) {
      setPendingClose(tab);
      return;
    }
    // Explicit shell close: cascade-delete the PTY's SQLite history so
    // it doesn't outlive the session the user just dismissed.
    if (tab.kind === "terminal") forgetPtys([tab.ptyId]);
    dispatch({ type: "close-tab", id: tab.id });
  };

  return (
    <div
      style={{
        height: "100%",
        // `minmax(0, 1fr)` (not the implicit `1fr`) — the implicit
        // form resolves to `minmax(auto, 1fr)`, where `auto` is the
        // min-content of the grid item. Anything inside (a wide
        // terminal canvas, a long unbroken markdown line, a pre block
        // with code) reports a large min-content width and the grid
        // grows past the parent `<main>`. `<main>` has overflow:
        // hidden so the overshoot is invisible, but the markdown's
        // centered `maxWidth: 760, margin: 0 auto` then anchors to
        // the *wider* invisible grid — that's why the prose ends up
        // pushed off to the right edge instead of centered in the
        // visible column. Forcing the min to 0 lets the grid shrink
        // to whatever `<main>` actually gives us.
        minWidth: 0,
        display: "grid",
        gridTemplateRows: "auto 1fr",
        gridTemplateColumns: "minmax(0, 1fr)",
        // Transparent so the active terminal pane is a true hole down
        // to the native surface. The tab strip (surface-1), the
        // non-terminal tab content and the empty-state placeholder each
        // paint their own opaque surface-2, so the ONLY transparent
        // region in the centre column is the active terminal pane.
      }}
    >
      <TabStrip
        tabs={tabs}
        activeTabId={activeTab?.id ?? null}
        worktreeId={worktree.id}
        onCloseTab={requestCloseTab}
      />
      <TabContent
        worktree={worktree}
        tab={activeTab}
        cwd={worktree.path}
      />
      <CloseTabConfirmDialog
        tab={pendingClose}
        onCancel={() => setPendingClose(null)}
        onDiscard={() => {
          if (pendingClose) {
            if (pendingClose.kind === "terminal") {
              forgetPtys([pendingClose.ptyId]);
            }
            dispatch({ type: "close-tab", id: pendingClose.id });
          }
          setPendingClose(null);
        }}
        onSave={async () => {
          if (!pendingClose) return;
          if (pendingClose.kind !== "markdown") {
            // Defensive — only markdown tabs are dirty-trackable today.
            // For any future tab kind, "save" is a no-op and we just close.
            dispatch({ type: "close-tab", id: pendingClose.id });
            setPendingClose(null);
            return;
          }
          const tabRef = pendingClose;
          const content = tabRef.content ?? "";
          try {
            await fs.writeTextFile(tabRef.filePath, content);
            dispatch({
              type: "update-tab",
              id: tabRef.id,
              patch: { savedContent: content },
            });
            dispatch({ type: "close-tab", id: tabRef.id });
          } catch {
            // Leave the tab open if the write failed so the user can
            // see the dirty state and try again. The modal still
            // closes so they can retake action.
          }
          setPendingClose(null);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------
   Breadcrumb
   ------------------------------------------------------------------ */

/* ------------------------------------------------------------------
   Tab strip
   ------------------------------------------------------------------ */

function TabStrip({
  tabs,
  activeTabId,
  worktreeId,
  onCloseTab,
}: {
  tabs: Tab[];
  activeTabId: string | null;
  worktreeId: string;
  onCloseTab: (tab: Tab) => void;
}) {
  const dispatch = useAppDispatch();

  const onNewTerminalTab = () => {
    // Both ids carry a random suffix on top of Date.now(): two clicks
    // landing in the same millisecond previously produced colliding
    // ptyIds, which made the new tab attach to an already-running PTY
    // (e.g. interrupting a running `claude` session in the prior tab).
    const stamp = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    const id = `t_${stamp}_${rand}`;
    const ptyId = `pty_${stamp}_${rand}`;
    dispatch({
      type: "open-tab",
      tab: {
        id,
        worktreeId,
        kind: "terminal",
        ptyId,
        title: "Untitled",
        summary: "ready",
        summaryUpdatedAt: Date.now(),
        detectedCli: null,
        agentStatus: "idle",
      },
    });
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: "var(--tab-height)",
        backgroundColor: "var(--surface-1)",
        borderBottom: "var(--border-1)",
      }}
    >
      <div
        role="tablist"
        className="goonware-no-scrollbar"
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          padding: "0 var(--space-1)",
          gap: 2,
          overflowX: "auto",
        }}
      >
        {tabs.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            worktreeId={worktreeId}
            onCloseTab={onCloseTab}
          />
        ))}
        <button
          type="button"
          title="New terminal tab"
          onClick={onNewTerminalTab}
          style={{
            width: 28,
            height: 32,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-tertiary)",
            borderRadius: "var(--radius-sm)",
            flexShrink: 0,
            transition:
              "background-color var(--motion-instant) var(--ease-out-quart)," +
              "color var(--motion-instant) var(--ease-out-quart)",
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.backgroundColor = "var(--surface-3)";
            e.currentTarget.style.color = "var(--text-primary)";
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
            e.currentTarget.style.color = "var(--text-tertiary)";
          }}
        >
          <IconPlus size={14} />
        </button>
      </div>
      {/* Right-panel toggle — pinned to the far right of the tab strip,
          outside the scrollable tablist so it stays visible no matter
          how many tabs are open. Uses IconSidebarRight (the horizontal
          mirror of IconSidebar from Sidebar.tsx:176) so the bar sits
          on the right edge of the glyph — visually pointing toward
          the panel it toggles. */}
      <button
        type="button"
        title="Toggle right panel · ⌘\\"
        onClick={() => dispatch({ type: "toggle-right-panel" })}
        style={{
          width: 32,
          height: 32,
          marginRight: "var(--space-1)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-tertiary)",
          borderRadius: "var(--radius-sm)",
          flexShrink: 0,
          transition:
            "background-color var(--motion-instant) var(--ease-out-quart)," +
            "color var(--motion-instant) var(--ease-out-quart)",
        }}
        onMouseOver={(e) => {
          e.currentTarget.style.backgroundColor = "var(--surface-3)";
          e.currentTarget.style.color = "var(--text-primary)";
        }}
        onMouseOut={(e) => {
          e.currentTarget.style.backgroundColor = "transparent";
          e.currentTarget.style.color = "var(--text-tertiary)";
        }}
      >
        <IconSidebarRight size={16} />
      </button>
    </div>
  );
}

function TabButton({
  tab,
  active,
  worktreeId,
  onCloseTab,
}: {
  tab: Tab;
  active: boolean;
  worktreeId: string;
  onCloseTab: (tab: Tab) => void;
}) {
  const dispatch = useAppDispatch();
  // Hover tooltip exposes the tab's full live summary — the same
  // string that drives the 11px tertiary line below the tab title,
  // but unellipsed and wrapped so the user can read what each
  // parallel session is actually doing without switching to it.
  const { ref, anchor, beginShow, cancelShow } =
    useTooltipAnchor<HTMLDivElement>();
  const tooltipLabel = fullTabSummary(tab);

  return (
    <>
    <motion.div
      ref={ref}
      role="tab"
      aria-selected={active}
      // `layout="position"` (not `layout`) — we want neighbours to
      // slide when a tab is opened, closed, or reordered, but we
      // *don't* want motion to animate the tab's own width when its
      // label or summary text changes. Plain `layout` was the cause
      // of the wobble where the tab visibly shrank/grew as the live
      // activity summary updated mid-session.
      layout="position"
      initial={{ opacity: 0, x: 6 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, y: 3 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      onClick={() => {
        cancelShow();
        dispatch({ type: "select-tab", worktreeId, id: tab.id });
      }}
      onMouseEnter={beginShow}
      onMouseLeave={cancelShow}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        // Fixed at 32 — leaves 4px breathing inside the 36px strip,
        // and is tall enough to host the two-line label stack
        // (title 12px / summary 10px = ~23px content) without ever
        // growing further when the summary line appears. The tab no
        // longer "stretches" on agent start; the second line just
        // fills the space we already reserved.
        height: 32,
        minWidth: 120,
        maxWidth: 240,
        padding: "0 var(--space-2) 0 10px",
        cursor: "pointer",
        backgroundColor: active ? "var(--surface-2)" : "transparent",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        borderTopLeftRadius: 6,
        borderTopRightRadius: 6,
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 14,
          flexShrink: 0,
        }}
      >
        <TabBadgeDot tab={tab} />
      </span>
      <TabLabelStack tab={tab} />
      <span style={{ flex: 1, minWidth: 0 }} />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onCloseTab(tab);
        }}
        title="Close tab"
        style={{
          width: 18,
          height: 18,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-tertiary)",
          opacity: active ? 1 : 0.65,
          borderRadius: "var(--radius-xs)",
        }}
      >
        <IconClose size={12} />
      </button>
      {active && (
        <motion.span
          layoutId="goonware-active-tab-underline"
          style={{
            position: "absolute",
            left: 8,
            right: 8,
            bottom: 0,
            height: 1,
            backgroundColor: "var(--accent)",
          }}
          transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
        />
      )}
    </motion.div>
    {/* AnimatePresence is a SIBLING of the layout-animated motion.div,
        not a child. When nested, motion's layout-tracking would see
        the tooltip's mount/unmount as a layout-relevant change (even
        though the Tooltip portals to <body> and doesn't actually
        affect the parent's box) and the AnimatePresence exit could
        be eaten by the layout animation in the parent. Sibling
        placement keeps the two animation systems independent. */}
    <AnimatePresence>
      {anchor && tooltipLabel && (
        <Tooltip
          label={tooltipLabel}
          anchor={anchor}
          maxWidth={360}
          placement="below"
        />
      )}
    </AnimatePresence>
    </>
  );
}

/**
 * The text the hover tooltip should expose for a tab. Prefers the
 * full unellipsed live summary, falls back through several layers so
 * the tooltip always has something useful to say when the cursor
 * lands — a brand-new tab whose summary is still the "ready"
 * placeholder gets the tab title (or "Shell terminal" if even the
 * title is generic); a file tab gets the full absolute path (the
 * strip only shows the basename).
 *
 * Returns null only when we genuinely have nothing — defensive, not
 * common.
 */
function fullTabSummary(tab: Tab): string | null {
  const trim = (s: string | undefined | null): string => {
    if (!s) return "";
    return s.replace(/\s+/g, " ").trim();
  };
  const isPlaceholderTitle = (s: string): boolean =>
    !s || s === "shell" || s === "Untitled" || s === "main";

  if (tab.kind === "terminal") {
    const summary = trim(tab.summary);
    if (summary && summary !== "ready" && summary !== "Untitled") return summary;
    // Fall back through tab title / CLI badge / generic label so the
    // tooltip never pops blank on hover. This matters for new tabs
    // whose first activity summary hasn't landed yet.
    const title = trim(tab.title);
    if (!isPlaceholderTitle(title)) return title;
    if (tab.detectedCli) return `${tab.detectedCli} session`;
    return "Shell terminal";
  }
  if (tab.kind === "diff" || tab.kind === "markdown") {
    return trim(tab.filePath) || trim(tab.title) || null;
  }
  if (tab.kind === "project-settings") {
    return trim(tab.title) || "Repository settings";
  }
  if (tab.kind === "all-changes") {
    return trim(tab.title) || "All changes";
  }
  if (tab.kind === "commit") {
    return trim(tab.title) || trim(tab.hash) || "Commit";
  }
  return null;
}

/**
 * Two-line stack rendered inside a tab: the session title on top, a
 * live one-line summary underneath. The summary is what makes the
 * tab strip a glance-tool — at any moment the user can read what
 * each parallel session is doing without switching tabs.
 *
 * Keeps the row height fixed so the chrome doesn't reflow when a
 * summary arrives or clears.
 */
function TabLabelStack({ tab }: { tab: Tab }) {
  // Two-line stack: session title on top, live summary below. The
  // stack is rendered inside a fixed-height tab button (see
  // TabButton), so this column flex-centers its content vertically
  // and never pushes the tab itself taller — the summary line
  // appears/disappears within the same physical slot rather than
  // doubling the strip height the way it used to.
  const title = tabLabel(tab);
  const summary = tabSummary(tab);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 0,
        minWidth: 0,
        maxWidth: 200,
        lineHeight: 1.05,
      }}
    >
      <span
        style={{
          fontSize: 12,
          fontWeight: "var(--weight-medium)",
          letterSpacing: "var(--tracking-tight)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {title}
      </span>
      {summary && (
        <span
          style={{
            fontSize: 10,
            color: "var(--text-tertiary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {summary}
        </span>
      )}
    </div>
  );
}

/**
 * The live one-line summary that sits below the title inside the
 * tab. We trust `tab.summary` (set by BlockTerminal via the
 * helper-agent layer or the activeCommand fallback) for terminal
 * tabs, and fall back to the file path for file-backed tabs so the
 * line still carries information. CSS handles the visual ellipsis.
 */
function tabSummary(tab: Tab): string {
  // Hard cap at 80 chars defensively — the agent's activity-summary
  // helper occasionally emits a runaway sentence, and tab labels are
  // bounded by `maxWidth` anyway but we want predictable layout cost
  // (CSS `text-overflow: ellipsis` is O(n) on text length when
  // computing the truncation point).
  const trim = (s: string | undefined | null): string => {
    if (!s) return "";
    const cleaned = s.replace(/\s+/g, " ").trim();
    if (cleaned === "ready" || cleaned === "Untitled") return "";
    return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
  };
  if (tab.kind === "terminal") return trim(tab.summary);
  if (tab.kind === "diff" || tab.kind === "markdown") {
    return trim(tab.filePath);
  }
  if (tab.kind === "all-changes") return "";
  return trim(tab.summary);
}


/** Bare label for a tab — bare names only (no path, no subtitle).
 *  Terminal tabs only surface the CLI badge ("claude" / "codex" /
 *  "gemini") while the agent is actively running. Once it exits the
 *  tab reverts to its session title (or "shell" by default) so the
 *  strip doesn't keep showing a long-dead agent's name. detectedCli
 *  alone is unreliable for this: the exit-debounce in BlockTerminal
 *  can be cancelled if the user switches tabs mid-flight, leaving the
 *  CLI field stale until the user navigates back. Anding it with
 *  agentStatus closes the gap. */
function tabLabel(tab: Tab): string {
  if (tab.kind === "terminal") {
    if (tab.agentStatus === "running" && tab.detectedCli) {
      return tab.detectedCli;
    }
    // Once the agent is gone the tab reverts to "shell", period.
    // We deliberately don't fall back to tab.title here — the title
    // can hold residue from the just-exited agent (e.g. "claude"
    // becomes the derived title when activity summary was just the
    // launch command), and the user wants the tab to read as the
    // base shell state, not a stale agent name. The longer activity
    // summary still surfaces in the 11px tertiary line under the
    // tab title (rendered by TabLabelStack), so meaningful session
    // context isn't lost — only the badge resets.
    return "shell";
  }
  if (tab.kind === "project-settings") {
    return tab.title || "Settings";
  }
  if (tab.kind === "all-changes") {
    return tab.title || "Changes";
  }
  if (tab.kind === "commit") {
    // Subject line on top; the short sha rides the summary line below.
    return tab.title || tab.hash.slice(0, 7);
  }
  // diff / markdown — show the filename basename, unless the basename
  // is a generic per-directory file (SKILL.md, README.md) — in that
  // case the explicit title carries the meaningful name (e.g. the skill
  // name set by SkillsView when opening the tab), so prefer it.
  const basename = tab.filePath.split("/").pop() ?? tab.title;
  if (
    tab.kind === "markdown" &&
    /^(SKILL|README)\.md$/i.test(basename) &&
    tab.title &&
    tab.title !== basename
  ) {
    return tab.title;
  }
  return basename;
}

/**
 * Tab strip dot. One simple rule:
 *
 *   grey by default · red when the tab has unsaved edits
 *
 * Only markdown tabs carry a notion of "unsaved" right now — they
 * read from disk on open, track autosave-vs-current in
 * `tab.savedContent`, and flip the dot red when those diverge.
 * Terminal / diff / project-settings tabs don't correspond to an
 * editable file, so their dots stay grey.
 *
 * Agent activity on terminal tabs is conveyed elsewhere now: the
 * sidebar shows a running-spinner per worktree, and the tab title
 * displays the CLI name while it's foregrounded. Keeping the tab
 * dot reserved for one single signal — "this file has unsaved
 * changes" — makes that signal unambiguous.
 */
function TabBadgeDot({ tab }: { tab: Tab }) {
  const base: React.CSSProperties = {
    display: "inline-block",
    width: 6,
    height: 6,
    borderRadius: "var(--radius-pill)",
    flexShrink: 0,
  };
  const dirty = isTabDirty(tab);
  return (
    <span
      aria-hidden
      style={{
        ...base,
        backgroundColor: dirty ? "var(--state-error)" : "var(--text-tertiary)",
      }}
    />
  );
}

/**
 * True when a tab represents an editable file whose in-memory
 * content has diverged from what's saved on disk. Currently only
 * markdown tabs surface this concept; other tab kinds (terminal,
 * diff, project-settings) return false. Used by both the dot
 * renderer and the close-tab confirmation flow.
 */
function isTabDirty(tab: Tab): boolean {
  if (tab.kind !== "markdown") return false;
  // Treat both null and undefined as "not yet loaded". Persisted
  // tabs from before the savedContent field existed will have
  // `undefined` rather than `null`; without this check those tabs
  // would always read as dirty on app load.
  if (tab.savedContent == null) return false;
  if (tab.content == null) return false;
  return tab.content !== tab.savedContent;
}

/* ------------------------------------------------------------------
   Tab content router
   ------------------------------------------------------------------ */

function TabContent({
  worktree,
  tab,
  cwd,
}: {
  worktree: Worktree;
  tab: Tab | null;
  // `cwd` is the WORKTREE path, not the project root. Git commands
  // (`git_diff`, `git_diff_all`) must run inside the active worktree
  // — running them at the project root would silently report the
  // wrong directory's diff (which can be empty even when the
  // worktree has changes).
  cwd: string;
}) {
  // Terminal-kind tabs go through the always-mounted keepalive
  // layer; non-terminal kinds (diff, markdown, all-changes,
  // project-settings) mount on demand. The keepalive layer is
  // ALWAYS rendered, even when the active tab is non-terminal —
  // its children are display:none in that case, but they stay in
  // the React tree so the user's PTYs (and their accumulated
  // scrollback + agent state) survive a switch to a diff and back.
  //
  // This is the change that makes worktree switching seamless:
  // before, the previous `key={tab.id}` on `<TerminalTabContent>`
  // forced every worktree switch to unmount the old BlockTerminal
  // and mount a new one. With the keepalive layer, switching
  // worktrees just toggles `display: flex` / `display: none` on
  // already-mounted terminals — no re-listen, no re-term_start,
  // no React commit cascade for the BlockTerminal subtree.
  return (
    <div style={{ minHeight: 0, minWidth: 0, position: "relative", overflow: "hidden" }}>
      {/* Reports this pane's rect to the native warpui terminal surface so it
          composites over exactly the terminal region. */}
      <WarpSurfaceTracker visible={!!tab && tab.kind === "terminal"} />
      <ErrorBoundary>
        <TerminalKeepaliveLayer
          activeTerminalTabId={
            tab && tab.kind === "terminal" ? tab.id : null
          }
          activeWorktree={worktree}
        />
        {!tab && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              color: "var(--text-tertiary)",
              fontSize: "var(--text-xs)",
              backgroundColor: "var(--surface-2)",
            }}
          >
            No tab open. Press <Kbd>+</Kbd> to start a terminal.
          </div>
        )}
        {tab && tab.kind !== "terminal" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              backgroundColor: "var(--surface-2)",
              minHeight: 0,
            }}
          >
            {tab.kind === "diff" ? (
              <DiffTabContent
                key={tab.id}
                tabId={tab.id}
                cwd={cwd}
                filePath={tab.filePath}
                staged={tab.staged}
              />
            ) : tab.kind === "all-changes" ? (
              <AllChangesView key={tab.id} projectPath={cwd} />
            ) : tab.kind === "commit" ? (
              <CommitDetailView
                key={tab.id}
                cwd={cwd}
                hash={tab.hash}
                worktreeId={tab.worktreeId}
              />
            ) : tab.kind === "project-settings" ? (
              <RepositorySettingsView
                key={tab.id}
                projectId={tab.projectId}
              />
            ) : (
              <MarkdownTabContent key={tab.id} tab={tab} />
            )}
          </div>
        )}
      </ErrorBoundary>
    </div>
  );
}

/**
 * Pre-mounts every terminal-kind tab in the ACTIVE worktree. Each
 * one's BlockTerminal lives in an absolute-positioned slot inside
 * this layer; only the slot whose tab.id matches `activeTerminalTabId`
 * has `display: flex`, the rest have `display: none`. Tab switches
 * within a worktree are a single CSS flip — no unmount + remount.
 *
 * Cross-worktree mount: the layer keeps the last KEEPALIVE_WORKTREES
 * recently-active worktrees' terminals mounted (MRU), so flipping
 * between a couple of worktrees is a pure CSS visibility toggle —
 * no term_start round-trip, no BlockTerminal mount cascade. Mounting
 * EVERY worktree was the original design and caused freezes (every
 * state dispatch rendered every worktree's tabs); the MRU cap keeps
 * the instant-switch win while bounding the global tax, and the
 * reducer's no-op guards have since removed most of the dispatch
 * storms that made it expensive. The Rust PTY survives eviction
 * regardless (term_start is idempotent and re-emits the cached
 * grid), so falling off the MRU only costs a remount on return.
 */
const KEEPALIVE_WORKTREES = 3;

function TerminalKeepaliveLayer({
  activeTerminalTabId,
  activeWorktree,
}: {
  activeTerminalTabId: string | null;
  activeWorktree: Worktree;
}) {
  const state = useAppState();
  // MRU of recently-active worktree ids, most recent first. Mutated
  // in render (idempotent) so the slot list below can include the
  // previous worktrees in the same pass that switches the active one.
  const mruRef = useRef<string[]>([]);
  const mru = mruRef.current;
  const pos = mru.indexOf(activeWorktree.id);
  if (pos !== 0) {
    if (pos > 0) mru.splice(pos, 1);
    mru.unshift(activeWorktree.id);
    if (mru.length > KEEPALIVE_WORKTREES) mru.length = KEEPALIVE_WORKTREES;
  }
  const terminalSlots = useMemo<
    Array<{ tab: TerminalTab; worktree: Worktree }>
  >(() => {
    const out: Array<{ tab: TerminalTab; worktree: Worktree }> = [];
    for (const wid of mruRef.current) {
      // Archived worktrees drop out of state — skip, which also lets
      // their slots unmount on the next render.
      const w =
        wid === activeWorktree.id ? activeWorktree : state.worktrees[wid];
      if (!w || w.missing === true) continue;
      for (const tabId of w.tabIds) {
        const t = state.tabs[tabId];
        if (!t || t.kind !== "terminal") continue;
        out.push({ tab: t, worktree: w });
      }
    }
    return out;
  }, [activeWorktree, state.worktrees, state.tabs]);

  return (
    <>
      {terminalSlots.map(({ tab, worktree }) => {
        const visible = tab.id === activeTerminalTabId;
        return (
          <div
            key={tab.id}
            // CRITICAL: do not use `display: none` to hide inactive
            // terminal slots. WKWebView releases a canvas's WebGPU
            // swapchain under `display: none` without firing
            // `device.lost` — the surface dies silently and the next
            // paint after un-hiding lands on a dead context, which the
            // user sees as a fully-black agent pane.
            //
            // `visibility: hidden` keeps the element in the rendering
            // tree (layout AND paint), which keeps the WebGPU surface
            // alive across tab/worktree switches. Combined with
            // `pointer-events: none` so the invisible terminal can't
            // intercept mouse events, this is a structural fix that
            // doesn't depend on any "recover after the surface dies"
            // recovery layer holding up under WebKit's quirks.
            //
            // The frame-throttling that previously justified
            // display:none (skipping React commits while hidden) is
            // preserved separately via the `isVisible` prop into
            // useTerminalSession — which gates React state updates,
            // not GPU work.
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              visibility: visible ? "visible" : "hidden",
              pointerEvents: visible ? "auto" : "none",
              // Lift the active slot to its own compositor layer so
              // sibling hidden slots can't accidentally repaint over
              // it on a parent-driven reflow.
              zIndex: visible ? 1 : 0,
            }}
            aria-hidden={visible ? undefined : true}
          >
            <TerminalTabContent
              worktree={worktree}
              tab={tab}
              isVisible={visible}
            />
          </div>
        );
      })}
    </>
  );
}

function TerminalTabContent({
  worktree,
  tab,
  isVisible,
}: {
  worktree: Worktree;
  tab: TerminalTab;
  isVisible: boolean;
}) {
  const dispatch = useAppDispatch();
  const { settings } = useAppState();
  return (
    <BlockTerminal
      id={tab.ptyId}
      command="zsh"
      cwd={worktree.path}
      autoSummarize={settings.autoSummarize}
      projectId={worktree.projectId}
      sessionId={worktree.id}
      isVisible={isVisible}
      // Main-column terminals drive the native warpui surface; right-panel
      // agent terminals do not (single surface until multi-pane, M6).
      nativeSurface
      // Re-seed agent state on remount so an in-flight claude/codex
      // session doesn't briefly drop back to shell mode (which paints
      // PromptInput under the agent's own UI) when the user navigates
      // back to the tab.
      initialAgentRunning={tab.agentStatus === "running"}
      initialAgentCli={tab.detectedCli}
      onAgentRunningChange={(running, cli) => {
        dispatch({
          type: "update-tab",
          id: tab.id,
          patch: {
            agentStatus: running ? "running" : "idle",
            detectedCli: cli ?? null,
          },
        });
        dispatch({
          type: "set-agent-status",
          worktreeId: worktree.id,
          status: running ? "running" : "idle",
          cli: cli ?? worktree.agentCli,
        });
        // Settings-driven side effects on running→idle transition.
        if (!running && tab.agentStatus === "running") {
          if (settings.notifyOnIdle) {
            void notifyAgentFinished(worktree.name, tab.title);
          }
          if (settings.completionSound !== "none") {
            playCompletionSound(settings.completionSound);
          }
        }
      }}
      onActivitySummaryChange={(summary) => {
        if (!summary) return;
        dispatch({ type: "set-tab-summary", id: tab.id, summary });
        const isPlaceholder =
          tab.title === "Untitled" || tab.title === "main" || tab.title === "";
        if (isPlaceholder) {
          const derived = summary
            .replace(/\s+/g, " ")
            .trim()
            .split(" ")
            .slice(0, 5)
            .join(" ")
            .slice(0, 40);
          // Skip the bare-launch-command case: when the activity
          // source is just "claude" / "codex" / "gemini" (the user
          // typed the agent's name and the AI summarizer hasn't
          // produced a real activity line yet), promoting that into
          // tab.title pollutes the title with the agent's name. The
          // tab strip already shows the CLI badge via tabLabel while
          // the agent runs, so we don't need it duplicated in the
          // underlying title — and once the agent exits we'd be
          // stuck with "claude" as the persistent title forever.
          const looksLikeBareCli =
            /^(claude(-code)?|codex(-cli)?|gemini(-cli)?|aider)$/i.test(derived);
          if (derived && !looksLikeBareCli) {
            dispatch({
              type: "update-tab",
              id: tab.id,
              patch: { title: derived },
            });
          }
        }
      }}
    />
  );
}

/**
 * Fire a macOS notification via the standard Web API. Tauri's WKWebView
 * forwards `Notification` to NSUserNotification when the bundle is
 * properly entitled; otherwise this is a silent no-op.
 */
async function notifyAgentFinished(worktreeName: string, tabTitle: string) {
  if (typeof Notification === "undefined") return;
  try {
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm !== "granted") return;
    new Notification(`${worktreeName} · agent idle`, {
      body: tabTitle,
      tag: `goonware-agent-idle-${worktreeName}-${tabTitle}`,
    });
  } catch {
    // Best-effort; notifications are nice-to-have.
  }
}

let cachedAudio: HTMLAudioElement | null = null;
function playCompletionSound(kind: "subtle" | "bell") {
  // Generate an inline tone via WebAudio so we don't ship audio assets.
  // `subtle` = a single short blip; `bell` = a quick two-note chime.
  try {
    const ctx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const now = ctx.currentTime;
    const tones = kind === "subtle" ? [{ f: 880, t: 0, d: 0.12 }] : [
      { f: 880, t: 0, d: 0.12 },
      { f: 660, t: 0.14, d: 0.18 },
    ];
    for (const tone of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = tone.f;
      gain.gain.setValueAtTime(0.0001, now + tone.t);
      gain.gain.exponentialRampToValueAtTime(0.18, now + tone.t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.t + tone.d);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + tone.t);
      osc.stop(now + tone.t + tone.d + 0.01);
    }
  } catch {
    void cachedAudio;
  }
}

function DiffTabContent({
  tabId,
  cwd,
  filePath,
  staged,
}: {
  tabId: string;
  cwd: string;
  filePath: string;
  staged: boolean;
}) {
  const dispatch = useAppDispatch();
  // The header ✕ and Escape close the tab — previously this was a
  // no-op, leaving a close button that did nothing and a global
  // Escape handler that preventDefaulted for no benefit.
  return (
    <DiffView
      projectPath={cwd}
      filePath={filePath}
      staged={staged}
      onClose={() => dispatch({ type: "close-tab", id: tabId })}
    />
  );
}

function MarkdownTabContent({ tab }: { tab: Tab & { kind: "markdown" } }) {
  const dispatch = useAppDispatch();
  const lastReadRef = useRef<string | null>(null);
  // Capture the search-overlay's openAt exactly once, on first mount.
  // After capture we dispatch a patch to clear it from the tab state
  // so a later tab-switch-and-back doesn't re-jump the user away
  // from wherever they've scrolled to. The captured ref is what gets
  // forwarded to the editor.
  const initialOpenAtRef = useRef<{ line: number; column: number } | undefined>(
    tab.openAt,
  );
  useEffect(() => {
    if (tab.openAt) {
      dispatch({ type: "update-tab", id: tab.id, patch: { openAt: undefined } });
    }
    // Empty deps: this is a one-shot mount-time clear. The captured
    // value lives in initialOpenAtRef and is forwarded to the editor
    // below, so we don't need to react to subsequent openAt changes
    // here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Read from disk on first mount per filepath. On success, content
  // and savedContent both populate to the on-disk text so the tab
  // starts in-sync (no red dot just because the file finished
  // loading). `== null` covers both null and undefined — older
  // persisted tabs may have savedContent missing entirely.
  useEffect(() => {
    if (tab.content != null && tab.savedContent != null) return;
    if (lastReadRef.current === tab.filePath) return;
    lastReadRef.current = tab.filePath;
    void fs
      .readTextFile(tab.filePath)
      .then((content) => {
        dispatch({
          type: "update-tab",
          id: tab.id,
          patch: { content, savedContent: content },
        });
      })
      .catch(() => {
        dispatch({
          type: "update-tab",
          id: tab.id,
          patch: { content: "", savedContent: "" },
        });
      });
  }, [tab.id, tab.filePath, tab.content, tab.savedContent, dispatch]);

  // Save handler — fires on ⌘S while this tab is active. The previous
  // autosave-on-every-pause was suspected of causing crashes (lots of
  // disk IO churn on every keystroke pause, racing with the close
  // dialog's save path), so we switched to explicit save only. The
  // dirty dot still tracks `content !== savedContent` so the user has
  // immediate visual feedback that there's unsaved work.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (!cmd) return;
      if (e.key.toLowerCase() !== "s") return;
      if (e.shiftKey || e.altKey) return;
      if (tab.content == null) return;
      e.preventDefault();
      const content = tab.content;
      void fs
        .writeTextFile(tab.filePath, content)
        .then(() => {
          dispatch({
            type: "update-tab",
            id: tab.id,
            patch: { savedContent: content },
          });
        })
        .catch(() => {
          // Swallow — the user can see the dot stays red and retry.
        });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab.id, tab.filePath, tab.content, dispatch]);

  // The tab kind is "markdown" for any file opened from the file
  // tree, but only actual .md / .mdx files should get the rich
  // TipTap viewer + Rich/Source toggle. Everything else (.ts, .js,
  // .py, .rs, …) renders in the plain CodeMirror editor that all
  // code files have always used.
  const ext = tab.filePath.split(".").pop()?.toLowerCase() ?? "";
  const isMarkdownSource = ext === "md" || ext === "mdx";

  return isMarkdownSource ? (
    <MarkdownView
      path={tab.filePath}
      content={tab.content ?? ""}
      onChange={(content) => {
        dispatch({ type: "update-tab", id: tab.id, patch: { content } });
      }}
    />
  ) : (
    <Editor
      path={tab.filePath}
      content={tab.content ?? ""}
      onChange={(content) => {
        dispatch({ type: "update-tab", id: tab.id, patch: { content } });
      }}
      openAt={initialOpenAtRef.current}
    />
  );
}

/**
 * Confirmation modal for closing a tab with unsaved edits. Renders as
 * a centered card over a dimmed backdrop. Three actions:
 *
 *   Save & Close    — writes the current content to disk, then closes
 *   Discard & Close — closes immediately, in-memory edits are lost
 *   Cancel          — keeps the tab open, no state change
 *
 * Backdrop click and Escape both cancel. Save is the safe default —
 * it's the primary button and the one auto-focused on mount, so a
 * stray Enter press never loses work.
 */
function CloseTabConfirmDialog({
  tab,
  onCancel,
  onDiscard,
  onSave,
}: {
  tab: Tab | null;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void | Promise<void>;
}) {
  // Escape key cancels.
  useEffect(() => {
    if (!tab) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tab, onCancel]);

  if (!tab) return null;
  const fileName =
    tab.kind === "markdown" || tab.kind === "diff"
      ? tab.filePath.split("/").pop() ?? tab.filePath
      : tab.title || "this tab";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Unsaved changes"
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        display: "grid",
        placeItems: "center",
        backgroundColor: "oklch(0% 0 0 / 0.45)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(420px, calc(100vw - 32px))",
          padding: "20px 22px 18px",
          backgroundColor: "var(--surface-2)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-md)",
          boxShadow:
            "0 8px 24px oklch(0% 0 0 / 0.45), 0 1px 2px oklch(0% 0 0 / 0.45)",
          fontFamily: "var(--font-sans)",
          color: "var(--text-primary)",
        }}
      >
        <h2
          style={{
            margin: 0,
            marginBottom: 6,
            fontSize: "var(--text-md)",
            fontWeight: "var(--weight-semibold)",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          Unsaved changes
        </h2>
        <p
          style={{
            margin: 0,
            marginBottom: 18,
            fontSize: "var(--text-sm)",
            color: "var(--text-secondary)",
            lineHeight: 1.45,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--text-primary)",
            }}
          >
            {fileName}
          </span>{" "}
          has edits that haven't been saved. What do you want to do?
        </p>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <DialogButton variant="ghost" onClick={onCancel}>
            Cancel
          </DialogButton>
          <DialogButton variant="ghost" onClick={onDiscard}>
            Discard
          </DialogButton>
          <DialogButton
            variant="primary"
            autoFocus
            onClick={() => void onSave()}
          >
            Save & Close
          </DialogButton>
        </div>
      </div>
    </div>
  );
}

function DialogButton({
  children,
  onClick,
  variant,
  autoFocus,
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant: "primary" | "ghost";
  autoFocus?: boolean;
}) {
  const isPrimary = variant === "primary";
  return (
    <button
      type="button"
      autoFocus={autoFocus}
      onClick={onClick}
      style={{
        height: 30,
        padding: "0 14px",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
        fontWeight: "var(--weight-medium)",
        color: isPrimary ? "var(--surface-1)" : "var(--text-primary)",
        backgroundColor: isPrimary ? "var(--accent)" : "transparent",
        border: isPrimary
          ? "1px solid var(--accent)"
          : "1px solid var(--border-default)",
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)," +
          "border-color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (isPrimary) {
          e.currentTarget.style.backgroundColor = "var(--accent-hover)";
        } else {
          e.currentTarget.style.backgroundColor = "var(--surface-3)";
        }
      }}
      onMouseLeave={(e) => {
        if (isPrimary) {
          e.currentTarget.style.backgroundColor = "var(--accent)";
        } else {
          e.currentTarget.style.backgroundColor = "transparent";
        }
      }}
    >
      {children}
    </button>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 16,
        height: 16,
        padding: "0 4px",
        margin: "0 4px",
        backgroundColor: "var(--surface-3)",
        border: "var(--border-1)",
        borderRadius: "var(--radius-xs)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-2xs)",
        color: "var(--text-secondary)",
      }}
    >
      {children}
    </kbd>
  );
}

/**
 * Recovery panel shown in place of the terminal when the active
 * worktree's backing directory has been deleted on disk. Without this,
 * activating the row cascades into `cwd does not exist: …` errors from
 * every command that takes a cwd (term_start, git_status, helper-agent
 * spawn) and the user is stuck — they can't even archive the row to
 * get rid of it, because archive also tried to `git -C <missing-path>`.
 *
 * The "Remove from sidebar" action calls `worktreeArchive` with the
 * project_path argument the backend uses to fall back to a force-forget
 * path (no git ops on the missing dir, `git worktree prune` from the
 * project root to clean up stale metadata).
 */
function MissingWorktreeView({
  worktree,
  project,
}: {
  worktree: Worktree;
  project: Project;
}) {
  const dispatch = useAppDispatch();
  const state = useAppState();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const onForgetWorktree = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const cfg = projectSettings(project);
      const record = await worktreeArchive(worktree, project.path, {
        stash: false,
        force: false,
        deleteBranch: state.settings.deleteBranchOnArchive,
        archiveScript: cfg.archiveScript,
      });
      // Cascade-delete the worktree's persisted block history + kill
      // live PTYs. See the matching call in Sidebar.tsx for the
      // rationale (restore mints fresh ids, originals are orphaned).
      forgetPtys(collectWorktreePtyIds(worktree, state.tabs));
      dispatch({ type: "archive-worktree", id: worktree.id, record });
      toast.show({ message: `Removed missing worktree ${worktree.name}` });
    } catch (err) {
      toast.show({ message: `Couldn't remove: ${err}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        placeItems: "center",
        padding: "var(--space-4)",
        backgroundColor: "var(--surface-2)",
        color: "var(--text-secondary)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div
        style={{
          width: "min(440px, 100%)",
          padding: "20px 22px 18px",
          backgroundColor: "var(--surface-1)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-md)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            color: "var(--state-error)",
          }}
        >
          <FolderDashedIcon size={18} />
          <h2
            style={{
              margin: 0,
              fontSize: "var(--text-md)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--text-primary)",
            }}
          >
            Worktree directory is missing
          </h2>
        </div>
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-sm)",
            color: "var(--text-secondary)",
            lineHeight: 1.5,
          }}
        >
          Goonware can't find the folder backing{" "}
          <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>
            {worktree.name}
          </span>
          . It was deleted from disk or the volume isn't mounted.
        </p>
        <code
          style={{
            display: "block",
            padding: "8px 10px",
            backgroundColor: "var(--surface-3)",
            border: "var(--border-1)",
            borderRadius: "var(--radius-sm)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--text-tertiary)",
            wordBreak: "break-all",
          }}
        >
          {worktree.path}
        </code>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 4,
          }}
        >
          <DialogButton
            variant="primary"
            onClick={() => void onForgetWorktree()}
          >
            {busy ? "Removing…" : "Remove from sidebar"}
          </DialogButton>
        </div>
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-xs)",
            color: "var(--text-tertiary)",
          }}
        >
          If you recreated the folder, restart Goonware to retry the
          path check.
        </p>
      </div>
    </div>
  );
}

