import { useEffect } from "react";
import {
  useActiveProject,
  useActiveWorktree,
  useAppDispatch,
  useAppState,
} from "@/state/AppState";
import { openProjectDialog } from "@/lib/projectDialog";
import {
  nextAutoBranch,
  primaryTerminalTab,
  worktreeCreate,
} from "@/lib/worktrees";
import { applyBranchPrefix, projectSettings } from "@/state/types";

/**
 * Match a digit press regardless of modifier-induced char shifting.
 * ⌘1 produces e.key === "1", but ⌘⇧1 produces "!" on US keyboards —
 * so we read the physical Digit code instead.
 */
function digitKey(e: KeyboardEvent): number | null {
  const m = /^Digit([1-9])$/.exec(e.code);
  return m ? Number(m[1]) : null;
}

/**
 * Global keyboard shortcuts. Worktree-centric since the v2 rewrite —
 * pane-tree chords (⌘B/⌘E/⌘T arrow) are gone with the recursive panes.
 *
 * The chord set:
 *   ⌘K / ⌘F      — search overlay
 *   ⌘O           — open project
 *   ⌘N           — new worktree (prompt for branch via sidebar UI)
 *   ⌘W           — close active tab
 *   ⌘1..9        — switch to nth worktree in sidebar order (flat across projects)
 *   ⌘⇧1..9       — switch to nth project
 *   ⌘⌥1..9       — switch to nth main-column tab (shell/editor/diff/markdown)
 *   ⌘B           — toggle sidebar
 *   ⌘\           — toggle right panel
 *   ⌘⇧F          — search overlay (alias)
 *   ⌘⌥F          — open Files in the right panel
 *   ⌘⌥G          — open Changes (git) in the right panel
 *   ⌘⌥B          — open Browser in the right panel
 *   ⌘⌥P          — auto-draft a PR for the active worktree
 *   Esc          — close overlays
 *
 * When ⌥ (Option) is held on macOS the produced `e.key` is a glyph
 * (⌘⌥F → "ƒ", ⌘⌥G → "©", ⌘⌥B → "∫", ⌘⌥P → "π"), so the ⌘⌥ branch
 * reads physical key codes (e.code) instead.
 */
export function useKeyboardShortcuts() {
  const dispatch = useAppDispatch();
  const project = useActiveProject();
  const worktree = useActiveWorktree();
  const state = useAppState();
  const { projectOrder, worktrees } = state;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;

      if (cmd && !shift && !e.altKey && (e.key.toLowerCase() === "k" || e.key.toLowerCase() === "f")) {
        e.preventDefault();
        dispatch({ type: "set-search", open: true });
        return;
      }

      // ⌘⌥F / ⌘⌥G / ⌘⌥B — flip the right panel to a specific tab and
      // make sure it's visible. Using e.code dodges Option's glyph
      // substitution (⌘⌥F arrives as e.key === "ƒ" on US layouts).
      if (cmd && e.altKey && !shift && worktree) {
        const code = e.code;
        const panel =
          code === "KeyF"
            ? "files"
            : code === "KeyG"
              ? "changes"
              : code === "KeyB"
                ? "browser"
                : null;
        if (panel) {
          e.preventDefault();
          dispatch({
            type: "set-right-panel",
            worktreeId: worktree.id,
            panel,
          });
          if (state.rightPanelCollapsed) {
            dispatch({ type: "toggle-right-panel" });
          }
          return;
        }
        // ⌘⌥P — open the Create PR dialog and let it auto-draft via
        // the worktree's helper-CLI agent. Skips the manual form.
        if (code === "KeyP") {
          e.preventDefault();
          dispatch({
            type: "set-pr-dialog",
            worktreeId: worktree.id,
            mode: "auto",
          });
          return;
        }
      }

      // ⌘, opens settings (macOS-standard).
      if (cmd && !shift && e.key === ",") {
        e.preventDefault();
        dispatch({ type: "toggle-settings" });
        return;
      }

      if (cmd && shift && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        dispatch({ type: "toggle-search" });
        return;
      }

      if (cmd && !shift && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        dispatch({ type: "toggle-sidebar" });
        return;
      }

      if (cmd && !shift && !e.altKey && e.key === "\\") {
        e.preventDefault();
        dispatch({ type: "toggle-right-panel" });
        return;
      }

      if (cmd && !shift && !e.altKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openProjectDialog(dispatch);
        return;
      }

      // ⌘T — open a new terminal tab in the main column of the active
      // worktree. Each tab gets a fresh PTY id, named "shell" until the
      // first prompt sets a real title. The random suffix matters: two
      // ⌘T presses in the same millisecond would otherwise mint the
      // same tab id and the second one would overwrite the first in
      // the reducer's tabs map.
      if (cmd && !shift && !e.altKey && e.key.toLowerCase() === "t" && worktree) {
        e.preventDefault();
        const stamp = Date.now().toString(36);
        const rand = Math.random().toString(36).slice(2, 8);
        const id = `t_${stamp}_${rand}`;
        const ptyId = `pty_${stamp}_${rand}`;
        dispatch({
          type: "open-tab",
          tab: {
            id,
            worktreeId: worktree.id,
            kind: "terminal",
            ptyId,
            detectedCli: null,
            agentStatus: "idle",
            title: "shell",
            summary: "ready",
            summaryUpdatedAt: Date.now(),
          },
        });
        return;
      }

      // ⌘N — auto-create a new worktree in the active project. No
      // prompt: the branch is named via the random landmark pool.
      if (cmd && !shift && !e.altKey && e.key.toLowerCase() === "n" && project) {
        e.preventDefault();
        const base = nextAutoBranch(project.id, state);
        const branch = applyBranchPrefix(
          base,
          state.settings.branchPrefixMode,
          state.settings.githubUsername,
          state.settings.customBranchPrefix,
        );
        const proj = project;
        const cfg = projectSettings(proj);
        void (async () => {
          try {
            const w = await worktreeCreate(
              proj.id,
              proj.path,
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
            window.alert(`Worktree creation failed: ${err}`);
          }
        })();
        return;
      }

      if (cmd && !shift && !e.altKey && e.key.toLowerCase() === "w" && worktree?.activeTabId) {
        e.preventDefault();
        dispatch({ type: "close-tab", id: worktree.activeTabId });
        return;
      }

      // ⌘⌥1..9 — switch to the Nth main-column tab (shell / editor /
      // diff / markdown) in the active worktree. Worktree tab order
      // is the same as the visible strip — w.tabIds is append-on-open
      // and the reducer never reorders it.
      if (cmd && e.altKey && !shift && worktree) {
        const n = digitKey(e);
        if (n !== null) {
          e.preventDefault();
          const targetTabId = worktree.tabIds[n - 1];
          if (targetTabId) {
            dispatch({
              type: "select-tab",
              worktreeId: worktree.id,
              id: targetTabId,
            });
          }
          return;
        }
      }

      // Project switch: ⌘⇧1..9 (⌘⌥1..9 is now tab-switching above)
      if (cmd && shift && !e.altKey) {
        const n = digitKey(e);
        if (n !== null) {
          e.preventDefault();
          const targetId = projectOrder[n - 1];
          if (targetId) {
            dispatch({ type: "set-active-project", id: targetId });
          }
          return;
        }
      }

      // Worktree switch: ⌘1..9 across the flat sidebar order.
      //
      // Previously this only addressed worktrees within the currently-active
      // project, which meant the chord did nothing when no project was active
      // and silently disagreed with what the user sees in the rail once they
      // had >1 project. Now we walk projectOrder × that project's worktrees
      // in the exact order the Sidebar renders them, so ⌘N always lands on
      // the Nth worktree as counted from the top of the rail — crossing
      // project boundaries when needed and activating the owning project as
      // a side effect.
      if (cmd && !shift && !e.altKey) {
        const n = digitKey(e);
        if (n !== null) {
          e.preventDefault();
          const flat: { projectId: string; worktreeId: string }[] = [];
          for (const pid of projectOrder) {
            for (const w of Object.values(worktrees)) {
              if (w.projectId === pid) {
                flat.push({ projectId: pid, worktreeId: w.id });
              }
            }
          }
          const target = flat[n - 1];
          if (target) {
            // Switch project first so the main column re-reads the right
            // worktree map before render. Both dispatches collapse into a
            // single React commit anyway, but the order keeps reducer
            // intent obvious.
            dispatch({ type: "set-active-project", id: target.projectId });
            dispatch({
              type: "set-active-worktree",
              projectId: target.projectId,
              worktreeId: target.worktreeId,
            });
          }
          return;
        }
      }

      if (e.key === "Escape") {
        dispatch({ type: "set-palette", open: false });
        dispatch({ type: "set-search", open: false });
        dispatch({ type: "set-settings-open", open: false });
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch, project, worktree, worktrees, projectOrder, state]);
}
