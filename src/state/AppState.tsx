import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode,
} from "react";
import type {
  AppAction,
  AppState,
  Project,
  ProjectId,
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
import { loadState, saveState } from "../lib/persistence";

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

    /* Worktrees --------------------------------------------------- */

    case "add-worktree": {
      const w = action.worktree;
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
      return {
        ...state,
        activeWorktreeByProject: {
          ...state.activeWorktreeByProject,
          [action.projectId]: action.worktreeId,
        },
      };

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
      const w = action.worktree;
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

    case "set-agent-status":
      return updateWorktree(state, action.worktreeId, () => ({
        agentStatus: action.status,
        agentCli: action.cli ?? state.worktrees[action.worktreeId]?.agentCli ?? null,
      }));

    case "set-change-count":
      return updateWorktree(state, action.worktreeId, () => ({
        changeCount: action.count,
      }));

    /* Tabs -------------------------------------------------------- */

    case "open-tab": {
      const t = action.tab;
      const w = state.worktrees[t.worktreeId];
      if (!w) return state;
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
      const activeTabId =
        w.activeTabId === action.id
          ? tabIds[tabIds.length - 1] ?? null
          : w.activeTabId;
      const { [action.id]: _removed, ...tabs } = state.tabs;
      return {
        ...state,
        tabs,
        worktrees: {
          ...state.worktrees,
          [w.id]: { ...w, tabIds, activeTabId },
        },
      };
    }

    case "select-tab": {
      return updateWorktree(state, action.worktreeId, () => ({
        activeTabId: action.id,
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
      if (!cur) return state;
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

/* ------------------------------------------------------------------
   Context
   ------------------------------------------------------------------ */

const AppStateContext = createContext<AppState | null>(null);
const AppDispatchContext = createContext<Dispatch<AppAction> | null>(null);

const SAVE_DEBOUNCE_MS = 400;

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const hydratedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loadState()
      .then((persisted) => {
        if (cancelled || !persisted) {
          hydratedRef.current = true;
          return;
        }
        dispatch({ type: "hydrate", state: persisted });
        requestAnimationFrame(() => {
          hydratedRef.current = true;
        });
      })
      .catch((err: unknown) => {
        console.error("[GLI] persistence: loadState failed", err);
        hydratedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    const timer = window.setTimeout(() => {
      saveState(state).catch((err: unknown) => {
        console.error("[GLI] persistence: saveState failed", err);
      });
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    state.projects,
    state.projectOrder,
    state.worktrees,
    state.tabs,
    state.activeProjectId,
    state.activeWorktreeByProject,
    state.archivedWorktrees,
    state.markdownView,
    state.sidebarCollapsed,
    state.rightPanelCollapsed,
    state.sidebarWidth,
    state.rightPanelWidth,
  ]);

  return (
    <AppStateContext.Provider value={state}>
      <AppDispatchContext.Provider value={dispatch}>
        {children}
      </AppDispatchContext.Provider>
    </AppStateContext.Provider>
  );
}

export function useAppState(): AppState {
  const state = useContext(AppStateContext);
  if (!state) {
    throw new Error("useAppState must be used inside <AppStateProvider>");
  }
  return state;
}

export function useAppDispatch(): Dispatch<AppAction> {
  const dispatch = useContext(AppDispatchContext);
  if (!dispatch) {
    throw new Error("useAppDispatch must be used inside <AppStateProvider>");
  }
  return dispatch;
}

/* ------------------------------------------------------------------
   Selectors
   ------------------------------------------------------------------ */

export function useActiveProject(): Project | null {
  const state = useAppState();
  if (!state.activeProjectId) return null;
  return state.projects[state.activeProjectId] ?? null;
}

export function useActiveWorktree(): Worktree | null {
  const state = useAppState();
  if (!state.activeProjectId) return null;
  const wid = state.activeWorktreeByProject[state.activeProjectId];
  if (!wid) return null;
  return state.worktrees[wid] ?? null;
}

export function useProjectWorktrees(projectId: ProjectId | null): Worktree[] {
  const state = useAppState();
  if (!projectId) return [];
  return Object.values(state.worktrees).filter(
    (w) => w.projectId === projectId,
  );
}

export function useWorktreeTabs(worktreeId: WorktreeId | null): Tab[] {
  const state = useAppState();
  if (!worktreeId) return [];
  const w = state.worktrees[worktreeId];
  if (!w) return [];
  return w.tabIds.map((id) => state.tabs[id]).filter(Boolean) as Tab[];
}

export function useActiveTab(): Tab | null {
  const w = useActiveWorktree();
  const state = useAppState();
  if (!w?.activeTabId) return null;
  return state.tabs[w.activeTabId] ?? null;
}

/* ------------------------------------------------------------------
   Legacy aliases — temporary shims so callers from the old schema
   still typecheck. They funnel into Worktree/Tab semantics.
   ------------------------------------------------------------------ */

/** @deprecated use useActiveWorktree */
export const useActiveSession = useActiveWorktree;
