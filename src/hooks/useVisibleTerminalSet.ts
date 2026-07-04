import { useEffect, useMemo, useRef } from "react";
import { useAppState } from "@/state/AppState";
import { termSetVisibleSet } from "@/lib/tauri/term";

/**
 * Reports the set of currently-visible terminal PTYs to the backend
 * so the per-session frame throttle can drop hidden terminals from
 * 60 Hz down to 4 Hz. Mounted at the AppShell level — fires whenever
 * the active worktree, active tab, or secondary terminal selection
 * changes.
 *
 * "Visible" here means: actually showing a `BlockTerminal` in the
 * current UI. Concretely that's:
 *
 *   1. The active worktree's currently-active main-column tab,
 *      if it's a terminal-kind tab. (Other tabs are non-terminal —
 *      markdown, diff, etc. — so they don't contribute a PTY.)
 *   2. The active worktree's active secondary terminal, IF the
 *      secondary panel is expanded AND on the Terminal subtab.
 *
 * Every PTY NOT in this set runs at the hidden throttle. With 20
 * worktrees open and one active terminal visible, that's 19 PTYs
 * emitting at 4 Hz instead of 60 Hz — a ~15× reduction in the
 * event flux that React doesn't need anyway, freeing the main
 * thread for the visible terminal's input + rendering.
 *
 * Idempotency: the hook caches the last-sent sorted set as a single
 * pipe-delimited string and skips the `invoke()` when nothing
 * changed. State updates that don't touch the active-tab axis (poll
 * results, badge changes, …) therefore generate zero IPC traffic.
 */
export function useVisibleTerminalSet() {
  const state = useAppState();
  const activeProjectId = state.activeProjectId;
  const activeWorktreeId = activeProjectId
    ? (state.activeWorktreeByProject[activeProjectId] ?? null)
    : null;
  const worktree = activeWorktreeId
    ? (state.worktrees[activeWorktreeId] ?? null)
    : null;

  const visibleIds = useMemo<string[]>(() => {
    if (!worktree) return [];
    const ids: string[] = [];
    if (worktree.activeTabId) {
      const tab = state.tabs[worktree.activeTabId];
      if (tab && tab.kind === "terminal") {
        ids.push(tab.ptyId);
      }
    }
    // The split pane's tab renders alongside the active tab, so its
    // PTY is just as on-screen as the active one.
    if (worktree.splitTabId) {
      const tab = state.tabs[worktree.splitTabId];
      if (tab && tab.kind === "terminal") {
        ids.push(tab.ptyId);
      }
    }
    // Secondary terminal counts only when the right panel itself is
    // shown AND the secondary section is expanded AND showing the
    // Terminal subtab. Other states (panel collapsed to 0 width,
    // Setup, Run, section collapsed) don't actually render a
    // BlockTerminal, so the PTY would be wasting full-cadence
    // emits on a non-visible surface.
    if (
      !state.rightPanelCollapsed &&
      !worktree.secondaryCollapsed &&
      worktree.secondaryTab === "terminal" &&
      worktree.secondaryActiveTerminalId
    ) {
      ids.push(worktree.secondaryActiveTerminalId);
    }
    return ids;
  }, [worktree, state.tabs, state.rightPanelCollapsed]);

  const lastSentRef = useRef<string>("");

  useEffect(() => {
    const sorted = [...visibleIds].sort();
    const key = sorted.join("|");
    if (key === lastSentRef.current) return;
    lastSentRef.current = key;
    void termSetVisibleSet(sorted).catch(() => {
      // Soft-fail: backend not ready (very early boot), wrong
      // platform, etc. The default `visible = true` in the Session
      // struct means terminals run at full cadence until we can
      // report — the next state change will retry.
    });
  }, [visibleIds]);
}
