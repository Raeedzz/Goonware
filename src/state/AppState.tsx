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
import { INITIAL_STATE, reducer } from "./reducer";
import { loadState, saveState } from "../lib/persistence";
import { fs } from "../lib/fs";

// Re-exported so existing imports (and tests) keep working — the
// reducer itself lives in ./reducer, a pure module with no React.
export { INITIAL_STATE, reducer } from "./reducer";

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
      .then(async (persisted) => {
        if (cancelled || !persisted) {
          hydratedRef.current = true;
          return;
        }
        dispatch({ type: "hydrate", state: persisted });
        requestAnimationFrame(() => {
          hydratedRef.current = true;
        });

        // Validate worktree paths after hydrating so the sidebar can
        // flag worktrees whose backing directory was deleted between
        // launches. Doing this here (vs at the call sites of every
        // Tauri command that takes a cwd) gives one cheap fs::exists
        // sweep on startup instead of cascading "cwd does not exist"
        // errors when the user clicks a phantom worktree row.
        const worktrees = Object.values(persisted.worktrees ?? {});
        if (worktrees.length === 0) return;
        try {
          const paths = worktrees.map((w) => w.path);
          const results = await fs.pathsExist(paths);
          if (cancelled) return;
          for (let i = 0; i < worktrees.length; i++) {
            const w = worktrees[i];
            const exists = results[i];
            if (!exists) {
              dispatch({
                type: "update-worktree",
                id: w.id,
                patch: { missing: true },
              });
            }
          }
        } catch (err) {
          console.warn(
            "[Goonware] persistence: worktree path validation failed",
            err,
          );
        }
      })
      .catch((err: unknown) => {
        console.error("[Goonware] persistence: loadState failed", err);
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
        console.error("[Goonware] persistence: saveState failed", err);
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
