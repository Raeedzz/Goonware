import type {
  AppAction,
  AppState,
  Tab,
  Worktree,
  WorktreeId,
} from "./types";
import {
  DEFAULT_SETTINGS,
  SIDEBAR_DEFAULT,
  RIGHT_DEFAULT,
  clampSidebar,
  clampRight,
  projectSettings,
} from "./types";

/* ------------------------------------------------------------------
   First-launch state — totally blank. The user opens their first
   project via ⌘O, and all subsequent state persists from there.
   ------------------------------------------------------------------ */

export const INITIAL_STATE: AppState = {
  projects: {},
  projectOrder: [],
  worktrees: {},
  tabs: {},
  activeProjectId: null,
  activeWorktreeByProject: {},
  archivedWorktrees: [],
  sidebarCollapsed: false,
  rightPanelCollapsed: false,
  sidebarWidth: SIDEBAR_DEFAULT,
  rightPanelWidth: RIGHT_DEFAULT,
  paletteOpen: false,
  searchOpen: false,
  settingsOpen: false,
  settingsSection: { kind: "general" },
  prDialogOpen: null,
  createWorktreeProjectId: null,
  settings: DEFAULT_SETTINGS,
  markdownView: "rich",
};

/* ------------------------------------------------------------------
   Reducer
   ------------------------------------------------------------------ */

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    /* Projects ---------------------------------------------------- */

    case "set-active-project":
      // No-op dispatches return the SAME state object so React skips
      // re-rendering every context subscriber — clicking the already
      // active row costs nothing. The polling actions further down
      // (change-count, agent-status, tab-summary) use the same guard
      // to keep their 4–10s ticks from re-rendering the app when
      // nothing actually changed.
      if (state.activeProjectId === action.id) return state;
      return { ...state, activeProjectId: action.id };

    case "add-project": {
      if (state.projects[action.project.id]) {
        return { ...state, activeProjectId: action.project.id };
      }
      return {
        ...state,
        projects: { ...state.projects, [action.project.id]: action.project },
        projectOrder: [...state.projectOrder, action.project.id],
        activeProjectId: action.project.id,
      };
    }

    case "remove-project": {
      const { [action.id]: _removed, ...projects } = state.projects;
      const projectOrder = state.projectOrder.filter((id) => id !== action.id);
      // Remove worktrees and their tabs belonging to the project
      const removedWorktreeIds = Object.values(state.worktrees)
        .filter((w) => w.projectId === action.id)
        .map((w) => w.id);
      const worktrees = { ...state.worktrees };
      const tabs = { ...state.tabs };
      for (const wid of removedWorktreeIds) {
        delete worktrees[wid];
        for (const tid of Object.keys(tabs)) {
          if (tabs[tid].worktreeId === wid) delete tabs[tid];
        }
      }
      const { [action.id]: _activeRemoved, ...activeWorktreeByProject } =
        state.activeWorktreeByProject;
      const activeProjectId =
        state.activeProjectId === action.id
          ? projectOrder[0] ?? null
          : state.activeProjectId;
      return {
        ...state,
        projects,
        projectOrder,
        worktrees,
        tabs,
        activeProjectId,
        activeWorktreeByProject,
      };
    }

    case "reorder-projects":
      return { ...state, projectOrder: action.ids };

    case "set-project-expanded":
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.id]: { ...state.projects[action.id], expanded: action.expanded },
        },
      };

    case "set-project-color":
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.id]: { ...state.projects[action.id], color: action.color },
        },
      };

    case "set-project-icon":
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.id]: { ...state.projects[action.id], iconName: action.iconName },
        },
      };

    case "update-project": {
      const cur = state.projects[action.id];
      if (!cur) return state;
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.id]: { ...cur, ...action.patch },
        },
      };
    }

    case "update-project-settings": {
      const cur = state.projects[action.id];
      if (!cur) return state;
      const merged = { ...projectSettings(cur), ...action.patch };
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.id]: { ...cur, settings: merged },
        },
      };
    }

    case "update-project-prefs": {
      const cur = state.projects[action.id];
      if (!cur) return state;
      const base = projectSettings(cur);
      const merged = { ...base, prefs: { ...base.prefs, ...action.patch } };
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.id]: { ...cur, settings: merged },
        },
      };
    }

    case "set-worktree-icon":
      return updateWorktree(state, action.worktreeId, () => ({
        iconName: action.iconName,
      }));

    case "set-create-worktree-open":
      if (state.createWorktreeProjectId === action.projectId) return state;
      return { ...state, createWorktreeProjectId: action.projectId };

    /* Worktrees --------------------------------------------------- */

    case "add-worktree": {
      const incoming = action.worktree;
      // Rust's worktree_create returns `secondaryPtyId` but no
      // `secondaryTerminals` array, so seed it here — otherwise the
      // SecondaryPanel renders zero tabs and the user has to click +
      // before the bottom-left terminal appears.
      const hasList =
        Array.isArray(incoming.secondaryTerminals) &&
        incoming.secondaryTerminals.length > 0;
      const w: Worktree = hasList
        ? incoming
        : {
            ...incoming,
            secondaryTerminals: [incoming.secondaryPtyId],
            secondaryActiveTerminalId: incoming.secondaryPtyId,
          };
      const tabs = { ...state.tabs };
      // Caller is expected to also dispatch open-tab for w.tabIds, but
      // for convenience let new worktrees come with their tabs included
      // — only used by initial seeding.
      return {
        ...state,
        worktrees: { ...state.worktrees, [w.id]: w },
        tabs,
        activeWorktreeByProject: {
          ...state.activeWorktreeByProject,
          [w.projectId]: w.id,
        },
      };
    }

    case "update-worktree": {
      const cur = state.worktrees[action.id];
      if (!cur) return state;
      return {
        ...state,
        worktrees: {
          ...state.worktrees,
          [action.id]: { ...cur, ...action.patch },
        },
      };
    }

    case "set-active-worktree":
      if (state.activeWorktreeByProject[action.projectId] === action.worktreeId)
        return state;
      return {
        ...state,
        activeWorktreeByProject: {
          ...state.activeWorktreeByProject,
          [action.projectId]: action.worktreeId,
        },
      };

    case "reorder-worktree": {
      const moved = state.worktrees[action.id];
      const target = state.worktrees[action.targetId];
      if (!moved || !target || action.id === action.targetId) return state;
      // Worktrees only reorder within their own repo group.
      if (moved.projectId !== target.projectId) return state;
      // Sidebar order IS the record's key order (Object.values + the
      // project filter), so re-inserting the key moves the row — and
      // persistence keeps key order, so the arrangement survives
      // restarts without a separate order field.
      const ids = Object.keys(state.worktrees).filter((k) => k !== action.id);
      const at =
        ids.indexOf(action.targetId) + (action.edge === "below" ? 1 : 0);
      ids.splice(at, 0, action.id);
      const worktrees: AppState["worktrees"] = {};
      for (const k of ids) worktrees[k] = state.worktrees[k];
      return { ...state, worktrees };
    }

    case "archive-worktree": {
      const w = state.worktrees[action.id];
      if (!w) return state;
      const { [action.id]: _removed, ...worktrees } = state.worktrees;
      const tabs = { ...state.tabs };
      for (const tid of w.tabIds) delete tabs[tid];
      const activeWorktreeByProject = { ...state.activeWorktreeByProject };
      if (activeWorktreeByProject[w.projectId] === action.id) {
        const sibling = Object.values(worktrees).find(
          (s) => s.projectId === w.projectId,
        );
        activeWorktreeByProject[w.projectId] = sibling?.id ?? null;
      }
      return {
        ...state,
        worktrees,
        tabs,
        activeWorktreeByProject,
        archivedWorktrees: [action.record, ...state.archivedWorktrees],
      };
    }

    case "restore-worktree": {
      const incoming = action.worktree;
      const hasList =
        Array.isArray(incoming.secondaryTerminals) &&
        incoming.secondaryTerminals.length > 0;
      const w: Worktree = hasList
        ? incoming
        : {
            ...incoming,
            secondaryTerminals: [incoming.secondaryPtyId],
            secondaryActiveTerminalId: incoming.secondaryPtyId,
          };
      const archivedWorktrees = state.archivedWorktrees.filter(
        (a) => a.id !== action.archiveId,
      );
      return {
        ...state,
        worktrees: { ...state.worktrees, [w.id]: w },
        archivedWorktrees,
        activeWorktreeByProject: {
          ...state.activeWorktreeByProject,
          [w.projectId]: w.id,
        },
      };
    }

    case "set-right-panel":
      return updateWorktree(state, action.worktreeId, () => ({
        rightPanel: action.panel,
      }));

    case "set-secondary-tab":
      return updateWorktree(state, action.worktreeId, () => ({
        secondaryTab: action.tab,
      }));

    case "add-secondary-terminal":
      return updateWorktree(state, action.worktreeId, (w) => {
        const fresh = `pty_sec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        return {
          secondaryTerminals: [...(w.secondaryTerminals ?? []), fresh],
          secondaryActiveTerminalId: fresh,
          secondaryTab: "terminal" as const,
          secondaryCollapsed: false,
        };
      });

    case "select-secondary-terminal":
      return updateWorktree(state, action.worktreeId, () => ({
        secondaryActiveTerminalId: action.ptyId,
        secondaryTab: "terminal" as const,
      }));

    case "close-secondary-terminal":
      return updateWorktree(state, action.worktreeId, (w) => {
        const list = (w.secondaryTerminals ?? []).filter(
          (id) => id !== action.ptyId,
        );
        // Never let the list go fully empty — re-seed with a fresh PTY
        // so the Terminal tab always renders something.
        const next =
          list.length > 0
            ? list
            : [
                `pty_sec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
              ];
        const stillActive =
          w.secondaryActiveTerminalId &&
          next.includes(w.secondaryActiveTerminalId)
            ? w.secondaryActiveTerminalId
            : next[next.length - 1];
        return {
          secondaryTerminals: next,
          secondaryActiveTerminalId: stillActive,
        };
      });

    case "toggle-secondary-collapsed":
      return updateWorktree(state, action.worktreeId, (w) => ({
        secondaryCollapsed: !w.secondaryCollapsed,
      }));

    case "set-right-split-pct":
      return updateWorktree(state, action.worktreeId, () => ({
        rightSplitPct: action.pct,
      }));

    case "set-agent-status": {
      const cur = state.worktrees[action.worktreeId];
      const nextCli = action.cli ?? cur?.agentCli ?? null;
      if (cur && cur.agentStatus === action.status && cur.agentCli === nextCli)
        return state;
      return updateWorktree(state, action.worktreeId, () => ({
        agentStatus: action.status,
        agentCli: nextCli,
      }));
    }

    case "set-change-count":
      // The 4s status poll dispatches this unconditionally; bailing on
      // an unchanged count also stops the debounced saveState from
      // rewriting the whole persisted blob every poll tick.
      if (state.worktrees[action.worktreeId]?.changeCount === action.count)
        return state;
      return updateWorktree(state, action.worktreeId, () => ({
        changeCount: action.count,
      }));

    /* Tabs -------------------------------------------------------- */

    case "open-tab": {
      const t = action.tab;
      const w = state.worktrees[t.worktreeId];
      if (!w) return state;

      // Re-opening something that's already in a tab focuses that tab
      // instead of stacking a duplicate. Callers mint fresh ids every
      // time, so equivalence is by target (file path, commit hash, …)
      // rather than id — see `sameTabTarget`.
      if (!w.tabIds.includes(t.id)) {
        const existing = w.tabIds
          .map((id) => state.tabs[id])
          .find((cur): cur is Tab => !!cur && sameTabTarget(cur, t));
        if (existing) {
          let reused: Tab = existing;
          if (existing.kind === "markdown" && t.kind === "markdown") {
            const patch: Partial<typeof existing> = {};
            // Carry a one-shot navigation target (search-hit jump) onto
            // the reused editor tab — but only when that tab is NOT the
            // one currently mounted. The editor consumes `openAt` at
            // mount; patching it onto the already-active tab would
            // never jump and the stale target would survive into
            // persistence, teleporting the user on a later remount.
            if (t.openAt && existing.id !== w.activeTabId) {
              patch.openAt = t.openAt;
            }
            // A clean tab (no unsaved edits) adopts freshly-read file
            // content shipped by the caller (search overlay reads from
            // disk); a dirty tab keeps the user's edits untouched.
            if (
              t.content != null &&
              existing.content === existing.savedContent
            ) {
              patch.content = t.content;
              patch.savedContent = t.savedContent ?? t.content;
            }
            if (Object.keys(patch).length > 0) {
              reused = { ...existing, ...patch };
            }
          }
          return {
            ...state,
            tabs:
              reused === existing
                ? state.tabs
                : { ...state.tabs, [existing.id]: reused },
            worktrees:
              action.activate !== false
                ? {
                    ...state.worktrees,
                    [w.id]: {
                      ...w,
                      activeTabId: existing.id,
                      // Focusing the tab that occupies the split pane
                      // swaps halves — same rule as `select-tab`.
                      splitTabId:
                        w.splitTabId === existing.id
                          ? w.activeTabId
                          : w.splitTabId ?? null,
                    },
                  }
                : state.worktrees,
          };
        }
      }

      const tabIds = w.tabIds.includes(t.id) ? w.tabIds : [...w.tabIds, t.id];
      const activeTabId = action.activate !== false ? t.id : w.activeTabId;
      return {
        ...state,
        tabs: { ...state.tabs, [t.id]: t },
        worktrees: {
          ...state.worktrees,
          [w.id]: { ...w, tabIds, activeTabId },
        },
      };
    }

    case "close-tab": {
      const t = state.tabs[action.id];
      if (!t) return state;
      const w = state.worktrees[t.worktreeId];
      if (!w) return state;
      const tabIds = w.tabIds.filter((id) => id !== action.id);
      let splitTabId = w.splitTabId === action.id ? null : w.splitTabId ?? null;
      let activeTabId = w.activeTabId;
      if (w.activeTabId === action.id) {
        // Closing the active (left) tab of a split promotes the split
        // tab to active rather than jumping to an arbitrary neighbour.
        if (splitTabId) {
          activeTabId = splitTabId;
          splitTabId = null;
        } else {
          activeTabId = tabIds[tabIds.length - 1] ?? null;
        }
      }
      if (splitTabId === activeTabId) splitTabId = null;
      const { [action.id]: _removed, ...tabs } = state.tabs;
      return {
        ...state,
        tabs,
        worktrees: {
          ...state.worktrees,
          [w.id]: { ...w, tabIds, activeTabId, splitTabId },
        },
      };
    }

    case "select-tab": {
      return updateWorktree(state, action.worktreeId, (w) => ({
        activeTabId: action.id,
        // Selecting the tab that lives in the split pane swaps the two
        // halves (both stay visible) instead of rendering one tab twice.
        splitTabId:
          w.splitTabId === action.id ? w.activeTabId : w.splitTabId ?? null,
      }));
    }

    case "split-tab": {
      const w = state.worktrees[action.worktreeId];
      if (!w) return state;
      const t = state.tabs[action.id];
      if (!t || t.worktreeId !== w.id || !w.tabIds.includes(action.id))
        return state;
      const oldActive = w.activeTabId;
      const oldSplit = w.splitTabId ?? null;
      if (action.side === "right") {
        // Dragged tab becomes the split pane. If it was the active tab
        // the left half needs a different occupant: the previous split
        // tab if there was one, otherwise the nearest other tab. A
        // single-tab worktree can't split with itself — no-op.
        let activeTabId = oldActive;
        if (action.id === oldActive) {
          const fallback =
            oldSplit ?? w.tabIds.filter((id) => id !== action.id).pop() ?? null;
          if (!fallback) return state;
          activeTabId = fallback;
        }
        return updateWorktree(state, w.id, () => ({
          activeTabId,
          splitTabId: action.id,
        }));
      }
      // side === "left": dragged tab becomes the active tab. Keep the
      // split (swap if the dragged tab WAS the split tab); when unsplit,
      // the previous active tab moves to the right half so the drop
      // always produces/keeps a split.
      if (action.id === oldActive && oldSplit) return state;
      const splitTabId =
        action.id === oldSplit ? oldActive : oldSplit ?? oldActive;
      if (!splitTabId || splitTabId === action.id) return state;
      return updateWorktree(state, w.id, () => ({
        activeTabId: action.id,
        splitTabId,
      }));
    }

    case "unsplit": {
      const w = state.worktrees[action.worktreeId];
      if (!w || !w.splitTabId) return state;
      return updateWorktree(state, w.id, () => ({
        activeTabId: action.keep === "right" ? w.splitTabId : w.activeTabId,
        splitTabId: null,
      }));
    }

    case "update-tab": {
      const cur = state.tabs[action.id];
      if (!cur) return state;
      return {
        ...state,
        tabs: { ...state.tabs, [action.id]: { ...cur, ...action.patch } as Tab },
      };
    }

    case "set-tab-summary": {
      const cur = state.tabs[action.id];
      if (!cur || cur.summary === action.summary) return state;
      return {
        ...state,
        tabs: {
          ...state.tabs,
          [action.id]: {
            ...cur,
            summary: action.summary,
            summaryUpdatedAt: Date.now(),
          } as Tab,
        },
      };
    }

    /* Chrome ------------------------------------------------------ */

    case "toggle-sidebar":
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };

    case "toggle-right-panel":
      return { ...state, rightPanelCollapsed: !state.rightPanelCollapsed };

    case "set-sidebar-width":
      return { ...state, sidebarWidth: clampSidebar(action.width) };

    case "set-right-panel-width":
      return { ...state, rightPanelWidth: clampRight(action.width) };

    case "toggle-palette":
      return { ...state, paletteOpen: !state.paletteOpen };

    case "set-palette":
      return { ...state, paletteOpen: action.open };

    case "toggle-search":
      return { ...state, searchOpen: !state.searchOpen };

    case "set-search":
      return { ...state, searchOpen: action.open };

    case "set-pr-dialog":
      return {
        ...state,
        prDialogOpen: action.worktreeId
          ? {
              worktreeId: action.worktreeId,
              mode: action.mode ?? "auto",
            }
          : null,
      };

    case "set-settings-open": {
      // When the caller deep-links into a specific repo's settings,
      // we also sweep any stale `project-settings` tabs out of the
      // workspace — those used to be how settings opened, and the
      // overlay is meant to replace them. Tabs surviving an upgrade
      // would still render as a "Settings" tab in the main column,
      // which is exactly what we're trying to escape from.
      const next: AppState = {
        ...state,
        settingsOpen: action.open,
        settingsSection: action.section ?? state.settingsSection,
      };
      if (!action.open) return next;
      const staleIds = Object.values(state.tabs)
        .filter((t) => t.kind === "project-settings")
        .map((t) => t.id);
      if (staleIds.length === 0) return next;
      const tabs = { ...next.tabs };
      for (const id of staleIds) delete tabs[id];
      const worktrees = { ...next.worktrees };
      for (const w of Object.values(worktrees)) {
        if (w.tabIds.some((id) => staleIds.includes(id))) {
          worktrees[w.id] = {
            ...w,
            tabIds: w.tabIds.filter((id) => !staleIds.includes(id)),
            activeTabId:
              w.activeTabId && staleIds.includes(w.activeTabId)
                ? (w.tabIds.find((id) => !staleIds.includes(id)) ?? null)
                : w.activeTabId,
          };
        }
      }
      return { ...next, tabs, worktrees };
    }

    case "set-settings-section":
      return { ...state, settingsSection: action.section };

    case "toggle-settings":
      return { ...state, settingsOpen: !state.settingsOpen };

    case "update-settings":
      return { ...state, settings: { ...state.settings, ...action.patch } };

    case "set-markdown-view":
      return { ...state, markdownView: action.view };

    /* Hydrate ----------------------------------------------------- */

    case "hydrate":
      return { ...state, ...action.state };
  }
}

/**
 * Whether two tab payloads address the same underlying thing — the
 * dedup test `open-tab` runs so re-opening a file/diff/commit focuses
 * the existing tab. Terminals never match: each one is its own
 * session even though the kind repeats.
 */
function sameTabTarget(a: Tab, b: Tab): boolean {
  if (a.kind !== b.kind) return false;
  switch (b.kind) {
    case "terminal":
      return false;
    case "diff":
      return (
        a.kind === "diff" && a.filePath === b.filePath && a.staged === b.staged
      );
    case "markdown":
      return a.kind === "markdown" && a.filePath === b.filePath;
    case "project-settings":
      return a.kind === "project-settings" && a.projectId === b.projectId;
    case "all-changes":
      return true;
    case "pr-diff":
      return a.kind === "pr-diff" && a.number === b.number;
    case "commit":
      return a.kind === "commit" && a.hash === b.hash;
  }
}

function updateWorktree(
  state: AppState,
  id: WorktreeId,
  patch: (w: Worktree) => Partial<Worktree>,
): AppState {
  const cur = state.worktrees[id];
  if (!cur) return state;
  return {
    ...state,
    worktrees: { ...state.worktrees, [id]: { ...cur, ...patch(cur) } },
  };
}

