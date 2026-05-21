import { invoke } from "@tauri-apps/api/core";
import type { AppState } from "../state/types";
import {
  DEFAULT_SETTINGS,
  RIGHT_DEFAULT,
  SIDEBAR_DEFAULT,
  clampRight,
  clampSidebar,
} from "../state/types";

/**
 * Persistence wrapper around the Rust state commands.
 *
 * v2 ships the Project → Worktree → Tabs schema. v1 blobs (the previous
 * Session-based shape) are discarded on load — the user's projects and
 * worktrees are cheap to rebuild and we don't carry migrations.
 */

export const PERSISTENCE_VERSION = 2;

export interface PersistedState {
  version: number;
  /** Subset of AppState that survives a relaunch. Transient flags (palette,
      dialogs, agent-running, chat input) are stripped. */
  projects: AppState["projects"];
  projectOrder: AppState["projectOrder"];
  worktrees: AppState["worktrees"];
  tabs: AppState["tabs"];
  activeProjectId: AppState["activeProjectId"];
  activeWorktreeByProject: AppState["activeWorktreeByProject"];
  archivedWorktrees: AppState["archivedWorktrees"];
  sidebarCollapsed: AppState["sidebarCollapsed"];
  rightPanelCollapsed: AppState["rightPanelCollapsed"];
  sidebarWidth: AppState["sidebarWidth"];
  rightPanelWidth: AppState["rightPanelWidth"];
  settings: AppState["settings"];
  markdownView: AppState["markdownView"];
}

export function pickPersistent(state: AppState): PersistedState {
  // Strip transient runtime state — agent-running, chat input, markdown
  // tab content (re-read from disk on open). Tabs themselves persist so
  // a relaunch lands the user back in the same configuration.
  const tabs = { ...state.tabs };
  for (const id of Object.keys(tabs)) {
    const t = tabs[id];
    if (t.kind === "terminal") {
      tabs[id] = { ...t, agentStatus: "idle", detectedCli: null };
    } else if (t.kind === "markdown") {
      // Drop both fields: the file is re-read from disk on next open,
      // and savedContent gets repopulated from that fresh read. Keeping
      // a stale savedContent across launches would cause the dirty
      // dot to show red after a relaunch if the file changed
      // externally in the meantime.
      tabs[id] = { ...t, content: null, savedContent: null };
    }
  }
  const worktrees = { ...state.worktrees };
  for (const id of Object.keys(worktrees)) {
    const w = worktrees[id];
    // Strip `missing` — it's a transient flag set by the post-load
    // path-existence sweep. Persisting it would keep stale "missing"
    // dimming across restarts even after the user re-created the dir.
    const { missing: _missing, ...rest } = w;
    worktrees[id] = {
      ...rest,
      agentStatus: "idle",
      agentCli: null,
      changeCount: 0,
    };
  }
  return {
    version: PERSISTENCE_VERSION,
    projects: state.projects,
    projectOrder: state.projectOrder,
    worktrees,
    tabs,
    activeProjectId: state.activeProjectId,
    activeWorktreeByProject: state.activeWorktreeByProject,
    archivedWorktrees: state.archivedWorktrees,
    sidebarCollapsed: state.sidebarCollapsed,
    rightPanelCollapsed: state.rightPanelCollapsed,
    sidebarWidth: state.sidebarWidth,
    rightPanelWidth: state.rightPanelWidth,
    settings: state.settings,
    markdownView: state.markdownView,
  };
}

export async function saveState(state: AppState): Promise<void> {
  const persisted = pickPersistent(state);
  const json = JSON.stringify(persisted);
  await invoke("state_save", { content: json });
}

export async function loadState(): Promise<Partial<AppState> | null> {
  const raw = await invoke<string | null>("state_load");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed.version !== PERSISTENCE_VERSION) {
      // Older schemas dropped on the floor — INITIAL_STATE wins.
      return null;
    }
    const {
      projects,
      projectOrder,
      worktrees,
      tabs,
      activeProjectId,
      activeWorktreeByProject,
      archivedWorktrees,
      sidebarCollapsed,
      rightPanelCollapsed,
      sidebarWidth,
      rightPanelWidth,
      settings,
      markdownView,
    } = parsed;
    // Strip any persisted `project-settings` tabs — those used to be
    // how settings opened, but the overlay route owns that flow now.
    // Surviving tabs would still render as a stale "Settings" entry
    // in the main column on cold start.
    const cleanTabs: AppState["tabs"] = {};
    const staleTabIds = new Set<string>();
    for (const id of Object.keys(tabs)) {
      const t = tabs[id];
      if (t.kind === "project-settings") {
        staleTabIds.add(id);
      } else {
        cleanTabs[id] = t;
      }
    }

    // Migrate older v2 worktrees that predate `secondaryTerminals` —
    // seed it from the legacy single-pty id so existing saved state
    // gets a one-tab terminal strip rather than an empty one. Also
    // remap deprecated rightPanel values: "checks" → "browser" (the
    // Checks slot was replaced by the Browser tab) and "memory" →
    // "files" (the Memory tab + claude-mem graph have been removed
    // from the app entirely). Also filter out any tabIds pointing at
    // the project-settings tabs we just stripped.
    const migratedWorktrees: AppState["worktrees"] = {};
    for (const id of Object.keys(worktrees)) {
      let w = worktrees[id];
      const legacyPanel = (w as { rightPanel?: unknown }).rightPanel;
      if (legacyPanel === "checks") {
        w = { ...w, rightPanel: "browser" };
      } else if (legacyPanel === "memory") {
        w = { ...w, rightPanel: "files" };
      }
      // Drop any tabIds pointing at the project-settings tabs we
      // stripped above so the worktree's strip doesn't reference a
      // missing tab on next paint.
      if (staleTabIds.size > 0) {
        const filtered = w.tabIds.filter((tid) => !staleTabIds.has(tid));
        if (filtered.length !== w.tabIds.length) {
          w = {
            ...w,
            tabIds: filtered,
            activeTabId:
              w.activeTabId && staleTabIds.has(w.activeTabId)
                ? (filtered[0] ?? null)
                : w.activeTabId,
          };
        }
      }
      if (
        !Array.isArray((w as { secondaryTerminals?: unknown }).secondaryTerminals) ||
        (w as { secondaryTerminals?: unknown[] }).secondaryTerminals!.length === 0
      ) {
        migratedWorktrees[id] = {
          ...w,
          secondaryTerminals: [w.secondaryPtyId],
          secondaryActiveTerminalId: w.secondaryPtyId,
        };
      } else if (
        !(w as { secondaryActiveTerminalId?: unknown }).secondaryActiveTerminalId
      ) {
        const list = (w as { secondaryTerminals: string[] }).secondaryTerminals;
        migratedWorktrees[id] = {
          ...w,
          secondaryActiveTerminalId: list[list.length - 1],
        };
      } else {
        migratedWorktrees[id] = w;
      }
    }
    return {
      projects,
      projectOrder,
      worktrees: migratedWorktrees,
      tabs: cleanTabs,
      activeProjectId,
      activeWorktreeByProject,
      archivedWorktrees,
      sidebarCollapsed,
      rightPanelCollapsed,
      // Older v2 blobs may predate the resize fields; default + clamp.
      sidebarWidth: clampSidebar(sidebarWidth ?? SIDEBAR_DEFAULT),
      rightPanelWidth: clampRight(rightPanelWidth ?? RIGHT_DEFAULT),
      settings: { ...DEFAULT_SETTINGS, ...(settings ?? {}) },
      markdownView,
    };
  } catch {
    return null;
  }
}

export async function clearState(): Promise<void> {
  await invoke("state_clear");
}
