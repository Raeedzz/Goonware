import { AnimatePresence } from "motion/react";
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { git } from "@/lib/git";
import { BranchSwitcher } from "@/shell/BranchSwitcher";
import { useClaudeUsage } from "@/lib/claudeUsage";
import { useAppState } from "@/state/AppState";
import type { TerminalTab } from "@/state/types";

interface Props {
  /** Working directory the terminal was started in. */
  cwd: string;
  /** Shell or agent binary name (zsh / claude / codex / gemini). */
  command: string;
  /**
   * Read-only mode for the agent-running variant of this bar. Kills
   * the branch-switcher picker and the hover affordances so the bar
   * reads as pure context — the user shouldn't be switching branches
   * mid-agent-session anyway, and the agent's own UI owns clicks.
   */
  readonly?: boolean;
}

interface GitInfo {
  branch: string | null;
  ahead: number;
  behind: number;
  added: number;
  removed: number;
  modified: number;
}

const POLL_MS = 4000;

/**
 * Pill-badge breadcrumb at the BOTTOM of the terminal pane, Warp-style:
 *
 *   [✻ claude]  [~/Developer/RLI]  [⎇ main ↑2]  [📄 17 +3 −1]                [⌘K]
 *
 * Each context segment is its own rounded chip with a subtle border so
 * the user can scan folder / branch / change-count in one glance and
 * the chrome doesn't melt into the dark surface. Polls `git status` at
 * 4s cadence — glanceable info, not sub-second.
 */
export function TerminalStatusBar({ cwd, command, readonly = false }: Props) {
  const { info, refresh } = useGitInfo(cwd);
  const home = abbreviateHome(cwd);
  const totalChanges = info.added + info.removed + info.modified;
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);

  const openPicker = readonly
    ? undefined
    : (e: ReactMouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setPicker({ x: e.clientX, y: e.clientY });
      };

  return (
    <div
      role="status"
      aria-label="Terminal context"
      className="allow-select"
      style={{
        flexShrink: 0,
        minHeight: 36,
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "var(--space-2) var(--space-3)",
        // surface-1 (not -0): the input tray reads as a distinct chrome strip
        // over the terminal's pure-black native surface. At surface-0 (a 7%
        // step off black) the tray visually vanished — the "where's my input
        // box" report. The borderTop hairline separates it from the output.
        backgroundColor: "var(--surface-1)",
        borderTop: "var(--border-1)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        color: "var(--text-tertiary)",
        userSelect: "text",
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      <Pill>
        <span
          aria-hidden
          style={{
            color: shellGlyphColor(command),
            fontFamily: "var(--font-mono)",
            fontVariantLigatures: "none",
            fontSize: "var(--text-xs)",
            lineHeight: 1,
          }}
        >
          {shellGlyph(command)}
        </span>
        <span
          style={{
            color: "var(--text-secondary)",
            fontWeight: "var(--weight-medium)",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          {command}
        </span>
      </Pill>

      <Pill title={cwd}>
        <FolderGlyph />
        <span
          style={{
            color: "var(--text-primary)",
            fontFamily: "var(--font-mono)",
            fontVariantLigatures: "none",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
            maxWidth: 360,
          }}
        >
          {home}
        </span>
      </Pill>

      {info.branch && (
        <Branch
          branch={info.branch}
          ahead={info.ahead}
          behind={info.behind}
          onClick={openPicker}
        />
      )}

      {totalChanges > 0 && (
        <Diff
          added={info.added}
          modified={info.modified}
          removed={info.removed}
        />
      )}

      <ClaudeUsagePill command={command} />

      <span style={{ flex: 1 }} />

      {!readonly && (
        <AnimatePresence>
          {picker && (
            <BranchSwitcher
              cwd={cwd}
              anchor={picker}
              onClose={() => setPicker(null)}
              onSwitched={() => void refresh()}
            />
          )}
        </AnimatePresence>
      )}
    </div>
  );
}

/**
 * Reusable rounded chip used for every status-bar segment. Surface-1
 * fill + 1px border-1 reads as a tactile button on the surface-0 strip
 * — not enough contrast to grab the eye, just enough to feel like
 * separate chunks of context.
 */
function Pill({
  children,
  title,
  style,
}: {
  children: React.ReactNode;
  title?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-1-5)",
        height: 22,
        padding: "0 var(--space-2)",
        backgroundColor: "var(--surface-1)",
        border: "var(--border-1)",
        borderRadius: "var(--radius-pill)",
        flexShrink: 0,
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

function FolderGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2 5.5C2 4.7 2.7 4 3.5 4h2.4c.4 0 .7.1 1 .4l1.2 1.1H12.5c.8 0 1.5.7 1.5 1.5v4.5c0 .8-.7 1.5-1.5 1.5h-9C2.7 13 2 12.3 2 11.5V5.5Z"
        stroke="var(--text-tertiary)"
        strokeWidth="1.2"
        fill="none"
      />
    </svg>
  );
}

const EMPTY_GIT_INFO: GitInfo = {
  branch: null,
  ahead: 0,
  behind: 0,
  added: 0,
  removed: 0,
  modified: 0,
};

function useGitInfo(cwd: string): {
  info: GitInfo;
  refresh: () => Promise<void>;
} {
  // Track the cwd alongside the info so we can blank stale data the
  // moment the prop changes — otherwise the previous worktree's branch
  // (typically "main") flashes for up to a poll cycle when the user
  // clicks a different worktree in the sidebar.
  const [state, setState] = useState<{ cwd: string; info: GitInfo }>({
    cwd,
    info: EMPTY_GIT_INFO,
  });
  const [trigger, setTrigger] = useState(0);

  // Synchronous reset on cwd change. This runs during render, before
  // the post-commit useEffect, so the pill never shows the old branch.
  if (state.cwd !== cwd) {
    setState({ cwd, info: EMPTY_GIT_INFO });
  }

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    const pull = async () => {
      try {
        const status = await git.status(cwd);
        if (cancelled) return;
        let added = 0;
        let removed = 0;
        let modified = 0;
        for (const e of status.entries) {
          if (e.kind === "added" || e.kind === "untracked") added++;
          else if (e.kind === "deleted") removed++;
          else if (e.kind === "modified" || e.kind === "renamed") modified++;
        }
        setState({
          cwd,
          info: {
            branch: status.branch,
            ahead: status.ahead,
            behind: status.behind,
            added,
            removed,
            modified,
          },
        });
      } catch {
        if (!cancelled) {
          setState((prev) =>
            prev.cwd === cwd
              ? { cwd, info: { ...EMPTY_GIT_INFO } }
              : prev,
          );
        }
      }
    };
    void pull();
    const id = window.setInterval(pull, POLL_MS);
    // External nudges (commit+push, merge) so the pill state lands
    // immediately instead of lagging the next poll cycle.
    const onRefresh = (e: Event) => {
      const detail = (e as CustomEvent<{ cwd?: string }>).detail;
      if (!detail?.cwd || detail.cwd === cwd) void pull();
    };
    window.addEventListener("goonware-git-refresh", onRefresh);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("goonware-git-refresh", onRefresh);
    };
  }, [cwd, trigger]);

  const info = state.info;

  return {
    info,
    refresh: async () => {
      setTrigger((t) => t + 1);
    },
  };
}

function abbreviateHome(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~");
}

/**
 * Inline 5-hour-window usage pill. Sources its number from the real
 * Anthropic capture hook (Claude's status-line writes the live %
 * into ~/.claude every redraw, and `claude_usage_status` reads it
 * back) — when that value isn't fresh we render nothing rather than
 * fall back to the local estimator, since the user explicitly asked
 * for the *actual* % and not a guess.
 *
 * Only mounts when the active command is `claude`; for `codex` /
 * `gemini` / shell sessions there's no 5h-window concept to display.
 */
function ClaudeUsagePill({ command }: { command: string }) {
  // Two-layer component. The OUTER gate is cheap — just a check
  // against worktree/tab agentStatus — and returns null when no
  // agent is running. Critically, that means `useClaudeUsage` (which
  // spins up a 5s Tauri-invoke polling loop + walks transcript
  // files) NEVER mounts until an agent is actually running. Without
  // this split, every TerminalStatusBar mount — including the
  // remounts that happen on every tab switch — would kick off a
  // fresh poll loop and a synchronous IPC call, which was making
  // tab switches from agent tabs feel sluggish.
  void command;
  const state = useAppState();
  const anyAgentRunning =
    Object.values(state.worktrees).some((w) => w.agentStatus === "running") ||
    Object.values(state.tabs).some(
      (t): t is TerminalTab =>
        t.kind === "terminal" && t.agentStatus === "running",
    );
  if (!anyAgentRunning) return null;
  return <ClaudeUsagePillInner />;
}

function ClaudeUsagePillInner() {
  const { derived } = useClaudeUsage();
  // `realSource` gates so we never paint a guessed number — same
  // contract as ClaudePill. No fresh capture → no pill.
  if (!derived || !derived.realSource) return null;

  const fraction = derived.fractionUsed;
  // Match Claude.ai's own visual language for the session bar:
  // <50% calm, <80% warn, ≥80% danger.
  const tone =
    fraction >= 0.8
      ? "var(--state-error)"
      : fraction >= 0.5
        ? "var(--state-warning)"
        : "var(--state-success)";
  const title = `Claude 5h window: ${derived.percentUsedLabel} used · ${derived.remainingLabel} remaining`;

  return (
    <Pill title={title}>
      <span
        aria-hidden
        style={{
          color: "var(--state-warning)",
          fontFamily: "var(--font-mono)",
          fontVariantLigatures: "none",
          fontSize: "var(--text-xs)",
          lineHeight: 1,
        }}
      >
        ✻
      </span>
      <span
        className="tabular"
        style={{
          fontFamily: "var(--font-mono)",
          fontVariantLigatures: "none",
          color: tone,
          fontWeight: "var(--weight-medium)",
        }}
      >
        {derived.percentUsedLabel}
      </span>
      <span style={{ color: "var(--text-disabled)" }}>/</span>
      <span
        style={{
          color: "var(--text-tertiary)",
          fontFamily: "var(--font-mono)",
          fontVariantLigatures: "none",
        }}
      >
        5h
      </span>
    </Pill>
  );
}

function shellGlyph(command: string): string {
  const c = command.toLowerCase();
  if (c.includes("claude")) return "✻";
  if (c.includes("codex")) return "◇";
  if (c.includes("gemini")) return "✦";
  return ">_";
}

function shellGlyphColor(command: string): string {
  const c = command.toLowerCase();
  if (c.includes("claude")) return "var(--state-warning)";
  if (c.includes("codex")) return "var(--accent-bright)";
  if (c.includes("gemini")) return "var(--state-info)";
  return "var(--text-tertiary)";
}

function Branch({
  branch,
  ahead,
  behind,
  onClick,
}: {
  branch: string;
  ahead: number;
  behind: number;
  onClick?: (e: ReactMouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`switch branch · current: ${branch}${
        ahead || behind ? `  ↑${ahead} ↓${behind}` : ""
      }`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-1-5)",
        height: 22,
        padding: "0 var(--space-2)",
        backgroundColor: "var(--surface-1)",
        border: "var(--border-1)",
        borderRadius: "var(--radius-pill)",
        flexShrink: 1,
        minWidth: 0,
        maxWidth: 240,
        color: "var(--text-tertiary)",
        cursor: onClick ? "pointer" : "default",
        transition: "background-color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (onClick) e.currentTarget.style.backgroundColor = "var(--surface-2)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "var(--surface-1)";
      }}
    >
      <BranchGlyph />
      <span
        style={{
          color: "var(--state-success)",
          fontFamily: "var(--font-mono)",
          fontVariantLigatures: "none",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        {branch}
      </span>
      {ahead > 0 && (
        <span
          style={{
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            fontVariantLigatures: "none",
          }}
        >
          ↑{ahead}
        </span>
      )}
      {behind > 0 && (
        <span
          style={{
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            fontVariantLigatures: "none",
          }}
        >
          ↓{behind}
        </span>
      )}
    </button>
  );
}

function Diff({
  added,
  modified,
  removed,
}: {
  added: number;
  modified: number;
  removed: number;
}) {
  const total = added + modified + removed;
  return (
    <Pill title={`${total} files changed`}>
      <FileGlyph />
      <span
        style={{
          color: "var(--text-primary)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
        }}
      >
        {total}
      </span>
      {added > 0 && (
        <span
          style={{
            color: "var(--diff-add-fg)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--weight-semibold)",
          }}
        >
          +{added}
        </span>
      )}
      {modified > 0 && (
        <span
          style={{
            color: "var(--state-warning)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--weight-semibold)",
          }}
        >
          ~{modified}
        </span>
      )}
      {removed > 0 && (
        <span
          style={{
            color: "var(--diff-remove-fg)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--weight-semibold)",
          }}
        >
          −{removed}
        </span>
      )}
    </Pill>
  );
}

function FileGlyph() {
  return (
    <svg width="10" height="11" viewBox="0 0 12 14" fill="none" aria-hidden>
      <path
        d="M2 1.5h5l3 3v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z"
        stroke="var(--text-tertiary)"
        strokeWidth="1"
        fill="none"
      />
      <path
        d="M7 1.5v3h3"
        stroke="var(--text-tertiary)"
        strokeWidth="1"
        fill="none"
      />
    </svg>
  );
}

function BranchGlyph() {
  return (
    <svg width="9" height="11" viewBox="0 0 9 11" fill="none" aria-hidden>
      <circle
        cx="2"
        cy="2"
        r="1.4"
        stroke="currentColor"
        strokeWidth="1"
      />
      <circle
        cx="2"
        cy="9"
        r="1.4"
        stroke="currentColor"
        strokeWidth="1"
      />
      <circle
        cx="7"
        cy="5.5"
        r="1.4"
        stroke="currentColor"
        strokeWidth="1"
      />
      <path
        d="M2 3.4 V7.6 M3.2 5.5 H5.6"
        stroke="currentColor"
        strokeWidth="1"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
