import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { joinShellPaths } from "@/lib/shellQuote";
import { BlockList } from "./BlockList";
import { CanvasGrid } from "./CanvasGrid";
import { LiveBlock } from "./LiveBlock";
import { PromptInput, type PromptInputHandle } from "./PromptInput";
import { PtyPassthrough, type PtyPassthroughHandle } from "./PtyPassthrough";
import { TerminalStatusBar } from "./TerminalStatusBar";
import { useTerminalSession } from "./useTerminalSession";
import { getHistory, setHistory as memSetHistory } from "./sessionMemory";
import {
  getLastInteractedTerminal,
  markTerminalInteracted,
  registerTerminalFocus,
  unregisterTerminalFocus,
} from "./terminalFocusRegistry";
import {
  setTerminalRunning,
  clearTerminalRunning,
} from "./terminalActivityStore";
import { detectClaude } from "@/lib/claudeUsage";
import { termKillForeground, termResetGrid } from "@/lib/tauri/term";
import { decideCtrlCAction } from "./ctrlCEscalation";
import {
  agentScrollContainerStyle,
  shouldRenderBlockList,
} from "./agentScrollLayout";

/** Command names that always run as an interactive TUI agent. */
function isAgentCommand(command: string): boolean {
  const c = command.toLowerCase();
  return (
    c === "claude" ||
    c.includes("codex") ||
    c.includes("aider") ||
    c === "gemini" ||
    c === "gemini-cli"
  );
}

export type DetectedAgentCli = "claude" | "codex" | "gemini" | null;

/**
 * Classify the CLI invoked by a command line — handles env-var prefixes
 * and absolute-path wrappers. Returns null for non-agent commands.
 */
function detectCliFromCommandLine(line: string): DetectedAgentCli {
  const tokens = line.trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (/^[a-z_][a-z0-9_]*=/i.test(t)) continue;
    const prog = (t.split("/").pop() ?? t).split(/[?#]/)[0];
    if (prog === "claude" || prog === "claude-code") return "claude";
    if (prog.startsWith("codex")) return "codex";
    if (prog === "gemini" || prog === "gemini-cli") return "gemini";
    if (prog.startsWith("aider")) return null; // aider isn't in the helper roster
    return null;
  }
  return null;
}

/**
 * True when a full command line invokes one of the known TUI agents.
 * Kept around for callers that just need a yes/no — internally derived
 * from {@link detectCliFromCommandLine}.
 */
function commandLineIsAgent(line: string): boolean {
  return detectCliFromCommandLine(line) !== null;
}

interface Props {
  /** Stable PTY session ID — must be unique per running PTY. */
  id: string;
  /** Command to spawn (e.g. "zsh", "claude", "codex"). */
  command: string;
  args?: string[];
  cwd?: string;
  /**
   * When false, skip the helper-agent–driven activity-summary polling.
   * Surfaced via `settings.autoSummarize` so users with many parallel
   * agents can opt out of the per-PTY 4s subprocess cadence.
   */
  autoSummarize?: boolean;
  /**
   * Active project id. Forwarded to term_start so the PTY's env has
   * `GOONWARE_PROJECT_ID` / `RLI_PROJECT_ID` set — agents inside the PTY
   * read this to identify which project they're running in.
   */
  projectId?: string;
  /** Active session id, mirrors `GOONWARE_SESSION_ID` / `RLI_SESSION_ID` in PTY env. */
  sessionId?: string;
  /**
   * Fires once when Claude is first detected in this pane's PTY
   * stream (or immediately on mount when `command` is itself an
   * agent). Wired by the parent into a `update-session` dispatch
   * so the global StatusBar can show the 5h-window pill.
   */
  onClaudeDetected?: (timestamp: number) => void;
  /**
   * Fires whenever foregroundIsAgent flips. Parent dispatches this
   * to session state so the StatusBar can hide the Claude pill the
   * moment the agent exits (instead of leaving it stuck on for the
   * remainder of the 5h window).
   *
   * `cli` is the detected agent CLI (claude / codex / gemini), or
   * null when no agent is running or the command line wasn't a known
   * agent. Used by the helper-agent layer to route summaries / commit
   * messages / PR drafts to the same CLI the user is actively driving.
   */
  onAgentRunningChange?: (running: boolean, cli: DetectedAgentCli) => void;
  /**
   * Fires whenever the live activity summary changes — i.e. what the
   * terminal is currently doing in one line. Empty string means idle.
   * Parent wires this into `session.subtitle` so the pane header (and
   * the status bar) reflect the running command in real time.
   */
  onActivitySummaryChange?: (summary: string) => void;
  /**
   * Whether the parent already knows the foregrounded process is an
   * interactive agent. Set when re-mounting a tab whose PTY has been
   * running claude/codex/etc. before the user switched away — without
   * this seed, foregroundIsAgent restarts at false on each remount and
   * RLI's PromptInput briefly renders alongside the agent's own UI.
   */
  initialAgentRunning?: boolean;
  /** Detected CLI to seed `activeCommand` from on mount. */
  initialAgentCli?: DetectedAgentCli;
  /**
   * Whether this terminal should pull keyboard focus on its own mount.
   * Defaults to true — preserves the "open a new tab, start typing"
   * behavior for main-column terminals. Passed false from the
   * right-panel secondary terminals so they never steal focus from
   * the main column on worktree switch (the user's symptom: "cursor
   * lands in the side view, not the main one"). The inner
   * PromptInput / PtyPassthrough / FullGrid all forward this flag.
   */
  autoFocus?: boolean;
  /**
   * Whether this terminal is currently the active/visible one in
   * its containing layout. The `TerminalKeepaliveLayer` in
   * MainColumn pre-mounts every terminal across every worktree and
   * toggles `display: none` for inactive ones; passing `isVisible`
   * down lets `useTerminalSession` skip React state updates while
   * hidden so the hidden BlockTerminals do zero work even when
   * their PTYs emit frame events. Defaults to true so standalone
   * (non-keepalive) uses keep working.
   */
  isVisible?: boolean;
  /**
   * Allow the outer scroll container to scroll horizontally when
   * its content overflows. Off by default — the PTY normally sizes
   * its grid to the container width and horizontal scroll would
   * just be a footgun. The right-panel secondary terminal opts in
   * so long lines pan via trackpad instead of clipping behind the
   * narrow pane edge.
   */
  allowHorizontalScroll?: boolean;
}

const DEFAULT_ROWS = 32;
const DEFAULT_COLS = 100;
const BELL_FLASH_MS = 480;

/**
 * Custom block-mode terminal backed by alacritty_terminal in Rust.
 *
 *   ┌────────────────────────────────┐
 *   │  ▓ live + closed blocks (BlockList scrolls bottom-up)  │
 *   ├────────────────────────────────┤
 *   │ [pills row]                     │  TerminalStatusBar
 *   │ Run commands▏                   │  PromptInput textarea
 *   │ ⌘↵ new /agent conversation      │  PromptInput hint
 *   └────────────────────────────────┘
 *
 * When the running shell pushes alt-screen (vim/htop/claude TUI), we
 * swap the BlockList + PromptInput stack for a FullGrid that mirrors
 * the entire grid and forwards every keystroke.
 */
export function BlockTerminal({
  id,
  command,
  args,
  cwd,
  autoSummarize = true,
  projectId,
  sessionId,
  onClaudeDetected,
  onAgentRunningChange,
  onActivitySummaryChange,
  initialAgentRunning = false,
  initialAgentCli = null,
  autoFocus = true,
  isVisible = true,
  allowHorizontalScroll = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  /**
   * Scroll container for the closed blocks + live block area. Manually
   * managed instead of relying on column-reverse auto-scroll, because
   * WKWebView's behaviour with very tall flex children is unreliable.
   * See the `useLayoutEffect` below that anchors scrollTop to the
   * bottom whenever the live frame changes.
   */
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<PromptInputHandle>(null);
  const passthroughRef = useRef<PtyPassthroughHandle>(null);
  // Generation counter — bumped when the user clicks "restart" on the
  // session-ended banner. Suffixed onto the session id so the underlying
  // useTerminalSession effect tears down the dead PTY and spawns a fresh
  // one. Incrementing alone wouldn't be enough — useTerminalSession
  // keys its lifecycle on `opts.id`, so the id has to actually change.
  // The separator MUST stay inside Tauri's allowed event-name alphabet
  // (alphanumeric, `-`, `/`, `:`, `_`) — the hook builds event names like
  // `term://${id}/frame`. `-r<n>` works and reads cleanly in logs.
  const [generation, setGeneration] = useState(0);
  const ptyId = generation === 0 ? id : `${id}-r${generation}`;
  // In-memory ring buffer of past commands (newest at index 0).
  // Hydrated from module-scoped memory so it survives session/project
  // switches; module memory is keyed by terminal id, not component
  // instance.
  const [history, setHistory] = useState<string[]>(() => getHistory(id));
  // For Claude 5h-window detection — sniff the live frame text for
  // the banner; once detected, fire the parent callback so the
  // global StatusBar's pill anchors to that timestamp. Local state
  // mirror so the inline detection logic doesn't fire twice.
  const [claudeDetectedLocal, setClaudeDetectedLocal] = useState(false);
  const sniffBufferRef = useRef("");
  const onClaudeDetectedRef = useRef(onClaudeDetected);
  useEffect(() => {
    onClaudeDetectedRef.current = onClaudeDetected;
  }, [onClaudeDetected]);
  const onAgentRunningChangeRef = useRef(onAgentRunningChange);
  useEffect(() => {
    onAgentRunningChangeRef.current = onAgentRunningChange;
  }, [onAgentRunningChange]);
  const onActivitySummaryChangeRef = useRef(onActivitySummaryChange);
  useEffect(() => {
    onActivitySummaryChangeRef.current = onActivitySummaryChange;
  }, [onActivitySummaryChange]);
  // For direct-launched claude sessions, fire the detected callback
  // on mount — there's no banner to sniff because we ARE the agent.
  useEffect(() => {
    if (command.toLowerCase() === "claude" && !claudeDetectedLocal) {
      setClaudeDetectedLocal(true);
      onClaudeDetectedRef.current?.(Date.now());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  // Whether the *currently foregrounded* process is an interactive
  // TUI agent (claude, codex, aider, …). When true the agent renders
  // its own input box inside the live frame, so we hide RLI's
  // PromptInput and route keystrokes through PtyPassthrough instead.
  const directAgent = useMemo(() => isAgentCommand(command), [command]);
  // Seed `foregroundIsAgent` from either:
  //   1. directAgent — we were *launched* as the agent (rare, used by
  //      direct-launch panes), or
  //   2. `initialAgentRunning` — the parent already knew this tab's
  //      PTY was inside an agent before we remounted (the common case
  //      when the user toggles away from a tab and back). Without (2)
  //      a remount briefly drops us into shell mode and PromptInput
  //      paints under the still-running agent's own UI.
  const [foregroundIsAgent, setForegroundIsAgent] = useState(
    directAgent || initialAgentRunning,
  );

  // What the user typed to start the currently-running command.
  // Populates the synthetic header on the in-progress LiveBlock; used
  // to trim zsh's command-echo line out of the live grid body so the
  // command doesn't appear twice (header + first body row). Cleared
  // when the OSC 133 D marker fires.
  const [activeCommand, setActiveCommand] = useState<string>(() => {
    if (directAgent) return command;
    // Re-mount path: parent told us a CLI was running. Seed activeCommand
    // with the CLI name so the LiveBlock header and helper-agent routing
    // both have a value to read until the user types again.
    if (initialAgentRunning && initialAgentCli) return initialAgentCli;
    return "";
  });

  // Tell the parent (which dispatches into session state) every time
  // the foreground-agent flag flips. Done in an effect rather than
  // inside setForegroundIsAgent calls so we don't have to remember
  // to forward at every callsite. Includes the detected CLI so the
  // helper-agent layer can route to the same binary the user is
  // actively using.
  const lastReportedAgentRef = useRef(false);
  useEffect(() => {
    if (foregroundIsAgent !== lastReportedAgentRef.current) {
      lastReportedAgentRef.current = foregroundIsAgent;
      const cli: DetectedAgentCli = foregroundIsAgent
        ? detectCliFromCommandLine(activeCommand || command)
        : null;
      onAgentRunningChangeRef.current?.(foregroundIsAgent, cli);
    }
  }, [foregroundIsAgent, activeCommand, command]);

  // Foreground-mode ref so the registered focus closure always reads
  // the latest value without forcing a re-registration on every flip.
  // The registry is keyed by the stable tab id; the closure picks
  // PromptInput vs PtyPassthrough at the moment focus is requested.
  const foregroundIsAgentRef = useRef(foregroundIsAgent);
  useEffect(() => {
    foregroundIsAgentRef.current = foregroundIsAgent;
  }, [foregroundIsAgent]);

  // Register a focus function for this terminal's tab id, so the
  // global `useFocusActiveTerminal` hook can send focus here whenever
  // the user switches to this terminal's worktree. Mirrors the
  // mouseUp-on-empty-area click-to-refocus logic below: in agent mode
  // we focus the PtyPassthrough invisible input (forwards every key
  // straight to the PTY); in shell mode we focus PromptInput's textarea.
  useEffect(() => {
    registerTerminalFocus(id, () => {
      if (foregroundIsAgentRef.current) {
        passthroughRef.current?.focus();
      } else {
        promptRef.current?.focus();
      }
    });
    return () => unregisterTerminalFocus(id);
  }, [id]);

  // While a Claude-Code session is foregrounded, the launch command
  // ("claude") tells you nothing about what's actually happening. Ask
  // the helper-agent layer to summarize the last 3 turns of the
  // transcript — that lands a phrase like "wiring up the OSC 133
  // segmenter" instead. The Rust side caches the result keyed by the
  // turn uuids, so polling here is cheap unless a new exchange landed.
  //
  // Codex / Gemini have their own transcript layouts; for now we only
  // run this against Claude transcripts (the only one the helper
  // currently knows how to parse). Other CLIs fall back to the launch
  // command via the activeCommand path below.
  const [claudeSummary, setClaudeSummary] = useState<string | null>(null);
  useEffect(() => {
    if (!autoSummarize) {
      setClaudeSummary(null);
      return;
    }
    if (!foregroundIsAgent) {
      setClaudeSummary(null);
      return;
    }
    if (!cwd) return;
    const isClaudeLine = commandLineIsAgent(activeCommand || command)
      && detectCliFromCommandLine(activeCommand || command) === "claude";
    if (!isClaudeLine) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const summary = await invoke<string | null>("claude_activity_summary", {
          projectCwd: cwd,
          cli: "claude",
        });
        if (!cancelled) setClaudeSummary(summary);
      } catch {
        // Transient failures keep the last value — better than blanking.
      }
    };
    void tick();
    const id = window.setInterval(tick, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [foregroundIsAgent, cwd, activeCommand, command]);

  // Forward the live activity summary up to the pane chrome, where
  // it surfaces as the subtitle next to the pane header. Trimmed and
  // collapsed-whitespace so multi-line composed commands read on one
  // line in a 28px header strip.
  //
  // Two non-obvious rules here:
  //  1. Empty/unset summaries don't dispatch — firing with "" on
  //     idle mount erases whatever default the session had ("ready")
  //     and leaves the chip blank.
  //  2. **Bare CLI launch names don't dispatch either.** When the
  //     tab remounts (e.g. on tab switch), `activeCommand` is
  //     seeded back to the agent's name ("claude" / "codex" /
  //     "gemini") before `claudeSummary` has had a chance to tick.
  //     Without this guard the stored summary would briefly flip
  //     to "claude" and then get rewritten with the real activity
  //     summary a moment later — a visible flicker the user
  //     specifically called out. Letting the prior real summary
  //     persist until a real new one arrives is the right default.
  useEffect(() => {
    const source = claudeSummary ?? activeCommand;
    const summary = source.replace(/\s+/g, " ").trim();
    if (!summary) return;
    const lower = summary.toLowerCase();
    if (lower === "claude" || lower === "codex" || lower === "gemini") {
      return;
    }
    onActivitySummaryChangeRef.current?.(summary);
  }, [activeCommand, claudeSummary]);

  const {
    blocks,
    liveFrame,
    altScreen,
    exited,
    cwd: liveCwd,
    bellTick,
    sendLine,
    sendBytes,
    resize,
  } = useTerminalSession({
    id: ptyId,
    command,
    args,
    cwd,
    rows: DEFAULT_ROWS,
    cols: DEFAULT_COLS,
    projectId,
    sessionId,
    isVisible,
  });

  // Scroll anchoring for the live-block area. The scroll container is
  // a normal-direction column flex (BlockList first, LiveBlock second),
  // so without intervention the default scrollTop would sit at the top
  // and the LiveBlock at the bottom would be off-screen. After every
  // commit that bumped the live frame seq or the closed-block count,
  // we anchor scrollTop to the bottom — unless the user has scrolled
  // up away from the bottom on purpose, in which case we leave them
  // alone so they can browse history without being yanked back.
  //
  // useLayoutEffect (not useEffect) so the scroll happens in the same
  // paint as the layout that introduced the new content. Otherwise the
  // user sees a single frame at the old scroll position before we
  // catch up — which manifests as a visible jump.
  // Scroll anchoring state. `stickToBottomRef` is the bit that
  // decides whether the next layout commit yanks scrollTop back to
  // scrollHeight. Defaults to true so a freshly-mounted terminal
  // anchors at the bottom the moment content arrives — the user's
  // first view should be the most recent output, not the top of
  // history.
  //
  // The flag flips OFF when the user actively scrolls away from the
  // bottom (tracked via `onScroll` below), and flips back ON when
  // they scroll back within range. While off, content commits don't
  // touch scrollTop — preserving the user's "I'm reading history"
  // position. While on, every content commit re-anchors.
  //
  // Critical: the flag is computed in `onScroll` (which fires
  // BEFORE the next commit's useLayoutEffect), so the decision is
  // based on the user's position PRE-commit. Computing it inside the
  // useLayoutEffect — as the previous implementation did — produced
  // false negatives at mount, where the post-commit distance jumps
  // from 0 to scrollHeight-clientHeight in a single tick and reads
  // as "far from bottom" even though the user never scrolled.
  const stickToBottomRef = useRef(true);

  // Anchor distance in CSS px. ~6 rows of the standard 13×1.35 cell
  // metric — wide enough to absorb wheel-scroll-to-bottom rounding
  // error without snapping while the user is actually browsing.
  const STICK_TOLERANCE = 100;

  const onScrollContainerScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < STICK_TOLERANCE;
  }, []);

  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (!stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [liveFrame?.seq, blocks.length, altScreen, foregroundIsAgent]);

  // Force-stick when the terminal transitions from hidden to visible.
  // The keepalive layer in MainColumn flips `display: none` ↔
  // `display: flex` for tab switches; WKWebView resets the inner
  // scrollTop on a reveal, and the user may also have scrolled up
  // in the OTHER tab they were viewing — neither should leave them
  // staring at the top of this one's history.
  //
  // Two-rAF snap because a single rAF can miss layout-settling
  // content: the post-reveal first frame can arrive in the next
  // animation tick, and the ResizeObserver re-fit dispatches a
  // term_resize that bumps `liveFrame.seq` after that. Snapping in
  // both ticks covers every observed ordering.
  const prevVisibleRef = useRef(isVisible);
  useLayoutEffect(() => {
    const wasVisible = prevVisibleRef.current;
    prevVisibleRef.current = isVisible;
    if (wasVisible || !isVisible) return;
    stickToBottomRef.current = true;
    const snap = () => {
      const el = scrollContainerRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    };
    snap();
    const raf1 = requestAnimationFrame(() => {
      snap();
      const raf2 = requestAnimationFrame(snap);
      // Stash the inner rAF id so cleanup cancels both.
      (snap as unknown as { _raf2?: number })._raf2 = raf2;
    });
    return () => {
      cancelAnimationFrame(raf1);
      const raf2 = (snap as unknown as { _raf2?: number })._raf2;
      if (typeof raf2 === "number") cancelAnimationFrame(raf2);
    };
  }, [isVisible]);

  // Also snap once when the BlockTerminal first mounts. The
  // useLayoutEffect above will run on dependency changes, but the
  // very first commit may have nothing in `liveFrame` yet — anchor
  // anyway so that as soon as the first frame paints, scrollTop is
  // already at the bottom and the user sees the live output, not
  // the top of an empty buffer that's about to be backfilled with
  // closed blocks.
  useLayoutEffect(() => {
    stickToBottomRef.current = true;
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // PTY died (process crashed, backend restarted on a Rust hot-reload,
  // user `exit`-ed the shell, etc.). Drop out of agent mode so the
  // user isn't staring at a blank pane that used to be claude. The
  // UI below renders an "[ session ended — press Enter to restart ]"
  // affordance so they can re-spawn the shell without nuking the pane.
  useEffect(() => {
    if (!exited) return;
    if (foregroundIsAgent) setForegroundIsAgent(false);
    sniffBufferRef.current = "";
  }, [exited, foregroundIsAgent]);

  // Push every OSC 133 command-running edge into the per-PTY activity
  // store so the sidebar spinner reflects "this worktree has a command
  // actively running right now". Mirrors Warp's per-block spinner
  // semantics: spin only between OSC 133 C (start) and D (done), not
  // while the user is sitting at the shell prompt or while a TUI agent
  // is idle inside its own input box. Clearing on unmount keeps the
  // store from holding stale entries for closed sessions.
  const commandRunning = liveFrame?.command_running ?? false;
  useEffect(() => {
    setTerminalRunning(id, commandRunning && !exited);
  }, [id, commandRunning, exited]);
  useEffect(() => {
    return () => clearTerminalRunning(id);
  }, [id]);

  // `altScreen` covers vim/htop; `foregroundIsAgent` covers
  // claude/codex/etc. that render in the normal screen. Both hide
  // PromptInput + status bar so the agent's own UI owns the surface.
  // After the PTY exits, downshift back to shell-mode chrome regardless
  // of what the last frame's flags were — those readings are stale.
  const agentMode = !exited && (altScreen || foregroundIsAgent);

  // Force re-anchoring when agent mode turns on — i.e. a new agent
  // is detected in this pane. The input bar hides, the PTY re-fits
  // to claim that ~80px, and `term_resize` bumps the next liveFrame.
  // Flip stickToBottomRef back on AND snap across a few rAFs so the
  // user lands at the agent's input box, not stranded mid-history.
  // Multiple rAFs because the buffer grows over several frames as the
  // agent's first paint streams in; a single snap can hit empty space.
  const prevAgentModeRef = useRef(agentMode);
  useLayoutEffect(() => {
    const wasAgent = prevAgentModeRef.current;
    prevAgentModeRef.current = agentMode;
    if (wasAgent || !agentMode) return;
    stickToBottomRef.current = true;
    const snap = () => {
      const el = scrollContainerRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    };
    snap();
    const rafs: number[] = [];
    const schedule = (depth: number) => {
      if (depth === 0) return;
      const id = requestAnimationFrame(() => {
        snap();
        schedule(depth - 1);
      });
      rafs.push(id);
    };
    schedule(4);
    return () => rafs.forEach(cancelAnimationFrame);
  }, [agentMode]);

  // Bell visualization — a brief, soft pulse on the input zone every
  // time the shell emits BEL. We just track "is currently flashing"
  // and let CSS handle the easing.
  const [bellFlash, setBellFlash] = useState(false);
  useEffect(() => {
    if (bellTick === 0) return;
    setBellFlash(true);
    const t = window.setTimeout(() => setBellFlash(false), BELL_FLASH_MS);
    return () => window.clearTimeout(t);
  }, [bellTick]);

  // Re-fit on container resize OR when we toggle agent mode (since
  // hiding the PromptInput frees ~80px of vertical real estate that
  // the alacritty grid can claim). Translate pixel size → cell grid
  // assuming a fixed monospace metric (13px font @ 1.35 line height).
  //
  // The PTY's row count is what claude / codex / shell commands paint
  // into. We size it to the *visible* scroll viewport (container
  // height minus input chrome) so the in-progress LiveBlock fits
  // without overflowing the pane when scrolled to the bottom. The
  // LiveBlock's own header (~50px for cwd row + command name +
  // border) is reserved on top of that — without it, claude's last
  // row gets clipped behind the input zone.
  //
  // Agent mode (claude / codex / aider) gets an oversized PTY: the
  // visible viewport plus AGENT_ROW_HEADROOM. Without the headroom,
  // a multi-line paste that exceeds the visible row count overflows
  // claude's own input box, claude scrolls within itself, and the
  // top of the prompt slides into alacritty's scrollback (which we
  // don't render). With it, claude's input has enough rows to paint
  // the full prompt; trimEchoAndBlanks strips the leading blank
  // rows so the LiveBlock body sizes naturally to actual content;
  // and the outer column-reverse scroll lets the user reach the top
  // of the prompt by scrolling up.
  // Track last (rows, cols) we sent to the PTY so the ResizeObserver
  // running on every layout tick doesn't repeatedly fire the same
  // resize, and so a tab-switch remount that lands at the same final
  // dimensions skips the round-trip entirely. Backed up server-side
  // by the idempotent guard in `term_resize`, but doing it here too
  // saves the bridge call.
  const lastResizeRef = useRef<{ rows: number; cols: number }>({
    rows: 0,
    cols: 0,
  });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const computeDims = (): { rows: number; cols: number } => {
      const rect = el.getBoundingClientRect();
      // Agent mode now also reserves room for the AgentStatusBar below
      // the terminal grid (38px + a 6px breathing strip = 44).
      const inputChrome = agentMode ? 44 : 80;
      const liveBlockChrome = 50;
      const reserved = inputChrome + liveBlockChrome;
      const usableHeight = Math.max(120, rect.height - reserved);
      const cellHeight = 13 * 1.35;
      // JetBrains Mono at 13px has a raw glyph advance of ~7.8px, but
      // the atlas rounds the physical-pixel advance UP and divides by
      // DPR, so the rendered cell width in CSS px is
      // `ceil(advance * dpr) / dpr` — usually 8.0, sometimes 8.5
      // depending on font hinting + DPR rounding. Picking 8.6 (= 13 *
      // ~0.66) for the cols estimate over-estimates the cell on the
      // common DPR=2 path by 0.6 CSS px, which costs ~1 cell of right-
      // edge gutter, but guarantees the PTY never asks for more cols
      // than the canvas can actually render. The prior 0.62 multiplier
      // undercounted on the 8.5-cell DPR path and was the direct cause
      // of the "fresh sta[te]" right-edge clipping in agent panes.
      const cellWidth = 13 * 0.66;
      const visibleRows = Math.max(8, Math.floor(usableHeight / cellHeight));
      const AGENT_ROW_HEADROOM = 80;
      const rows = foregroundIsAgent
        ? visibleRows + AGENT_ROW_HEADROOM
        : visibleRows;
      // Horizontal gutter:
      //   12 px LiveBlock left padding
      // + 12 px LiveBlock right padding
      // + ~12 px safety (sub-pixel atlas rounding, occasional macOS
      //   "always show" scrollbar setting, sidebar borderLeft, and a
      //   one-cell buffer so claude's TUI right border never lands
      //   under the right sidebar boundary).
      // The prior 24 px only covered the LiveBlock padding and the
      // user reported the symptom directly as "text spills behind
      // the right sidebar."
      const fitCols = Math.max(20, Math.floor((rect.width - 36) / cellWidth));
      // In `allowHorizontalScroll` mode (the narrow right-panel
      // secondary terminal) the visual pane width is much smaller than
      // a normal terminal. If we sized the PTY to that width the shell
      // would hard-wrap every long line server-side and the DOM
      // `whiteSpace: pre` would have nothing to overflow — there'd be
      // nothing to pan. Pin a generous floor so the PTY believes it
      // has a wide terminal; the outer scroll container then handles
      // horizontal panning over the wider rendered grid.
      const PAN_MIN_COLS = 120;
      const cols = allowHorizontalScroll
        ? Math.max(fitCols, PAN_MIN_COLS)
        : fitCols;
      return { rows, cols };
    };

    // Debounced SIGWINCH to the PTY.
    //
    // Every term_resize call sends SIGWINCH to the child, and TUI
    // agents (claude, codex, …) repaint their entire grid on every
    // SIGWINCH. The old rAF-coalesced compute fired up to 60 SIGWINCH
    // per second during a splitter drag, so the agent was redrawing
    // continuously into a moving target — visually that's "jitters in
    // and out" while the user resizes. Warp solves this by treating
    // the resize drag as a continuous gesture: the canvas stays sized
    // to the current container (fast, GPU-driven inside CanvasGrid's
    // own observer), but the PTY only learns its new dimensions when
    // the user pauses. Then a single redraw lands and settles.
    //
    // First fire is synchronous so the PTY has correct dimensions
    // before its first frame; subsequent fires go through the timer.
    //
    // Step vs drag: a sidebar-collapse / right-panel-collapse click
    // produces a single ResizeObserver event with a large width delta
    // (the whole pane jumps by SIDEBAR_DEFAULT / RIGHT_DEFAULT px in
    // one frame). Without special casing, the user would see 140 ms
    // of stale-grid overflow before the PTY repaints into the new
    // size — text spills past the new container boundary the entire
    // debounce window. Detection: a delta >= STEP_DELTA_PX in either
    // dimension is treated as a step and fires immediately;
    // anything smaller goes through the trailing-edge debounce.
    const RESIZE_DEBOUNCE_MS = 140;
    const STEP_DELTA_PX = 40;
    let timerId: number | null = null;
    let pendingDims: { rows: number; cols: number } | null = null;
    let lastObservedRect: { width: number; height: number } | null = null;

    const fireResize = () => {
      timerId = null;
      const dims = pendingDims;
      pendingDims = null;
      if (!dims) return;
      const prev = lastResizeRef.current;
      if (prev.rows === dims.rows && prev.cols === dims.cols) return;
      lastResizeRef.current = dims;
      void resize(dims.rows, dims.cols).catch(() => {});
    };

    const scheduleResize = (delayMs: number) => {
      pendingDims = computeDims();
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
      if (delayMs <= 0) {
        fireResize();
      } else {
        timerId = window.setTimeout(fireResize, delayMs);
      }
    };

    scheduleResize(0);
    lastObservedRect = (() => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    })();

    const observer = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect;
      const dx = lastObservedRect
        ? Math.abs(cr.width - lastObservedRect.width)
        : Infinity;
      const dy = lastObservedRect
        ? Math.abs(cr.height - lastObservedRect.height)
        : 0;
      lastObservedRect = { width: cr.width, height: cr.height };
      const isStep = dx >= STEP_DELTA_PX || dy >= STEP_DELTA_PX;
      scheduleResize(isStep ? 0 : RESIZE_DEBOUNCE_MS);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [resize, agentMode, foregroundIsAgent, allowHorizontalScroll]);

  // Sniff the live frame for the Claude banner so the 5h usage bar
  // attaches automatically AND we know to hide PromptInput in favor
  // of the agent's own input. Used only as a fallback — the
  // activeCommand-based foregrounding effect below covers the common
  // case (user typed "claude" / "codex" / "aider" at the shell).
  // Sniffing remains useful for direct-launch panes whose initial
  // frames pre-date this state being wired up.
  //
  // CRITICAL: only sniff while a command is actively running. After
  // Ctrl+C kills an agent the alacritty grid still holds the agent's
  // TUI bytes — without this gate, the very next frame after the
  // command_running=false transition would re-detect claude from
  // those leftover bytes and flip foregroundIsAgent back to true,
  // pinning PromptInput off-screen forever.
  //
  // AND: skip the sniff entirely once we know what command is running
  // and it isn't an agent. The live frame contains the full grid (per
  // useTerminalSession's allDirty re-emit), so claude's banner from
  // the previous run is still painted above the shell prompt when the
  // user types `ls`. Without this gate, that stale banner trips
  // detectClaude on the next `command_running=true` transition,
  // re-arms agent mode, and the prompt input vanishes mid-typing —
  // exactly the bug the user reported. activeCommand-classification
  // (line below) already covers the case where the new command IS an
  // agent, so suppressing the sniff here loses nothing.
  //
  // Scans the full grid (claude's banner paints near the top of the
  // initial draw, so a tail-only scan misses it). Bails on the first
  // marker hit — the inner loop appends span text and short-circuits
  // as soon as detectClaude succeeds.
  useEffect(() => {
    if (foregroundIsAgent) return;
    if (!liveFrame) return;
    if (!liveFrame.command_running) return;
    if (activeCommand.length > 0 && !commandLineIsAgent(activeCommand)) return;
    let text = "";
    for (const dr of liveFrame.dirty) {
      const spans = dr.spans;
      for (let j = 0; j < spans.length; j++) text += spans[j].text;
      text += "\n";
    }
    if (text.length === 0) return;
    sniffBufferRef.current =
      sniffBufferRef.current.length + text.length > 16_384
        ? (sniffBufferRef.current + text).slice(-16_384)
        : sniffBufferRef.current + text;
    if (detectClaude(sniffBufferRef.current)) {
      setForegroundIsAgent(true);
      if (!claudeDetectedLocal) {
        setClaudeDetectedLocal(true);
        onClaudeDetectedRef.current?.(Date.now());
      }
      sniffBufferRef.current = "";
    }
  }, [liveFrame, foregroundIsAgent, claudeDetectedLocal, activeCommand]);

  // Foreground the agent the moment the user runs one from the shell.
  // The Claude-only banner sniff above is a slow path that doesn't
  // know about codex/aider; this catches every known agent on its
  // command line as soon as command_running flips to true. Skipped
  // for direct-launch panes (already foregrounded at mount).
  useEffect(() => {
    if (directAgent) return;
    if (foregroundIsAgent) return;
    if (!liveFrame?.command_running) return;
    if (!commandLineIsAgent(activeCommand)) return;
    setForegroundIsAgent(true);
  }, [
    directAgent,
    foregroundIsAgent,
    liveFrame?.command_running,
    activeCommand,
  ]);


  // Memoized `onSendBytes` adapter — `sendBytes` returns a Promise but
  // the input components want a void-returning callback. Wrapping with
  // useCallback (with `sendBytes` as the only dep) keeps the reference
  // stable across renders, so the React.memo'd PromptInput +
  // PtyPassthrough don't re-render every time a PTY frame lands.
  const onSendBytesVoid = useCallback(
    (b: Uint8Array) => {
      void sendBytes(b);
    },
    [sendBytes],
  );

  // Double-tap Ctrl+C escape hatch — see {@link decideCtrlCAction}.
  // Called by PromptInput / PtyPassthrough when the user mashes
  // Ctrl+C and a single SIGINT didn't take. The Rust side reads the
  // foreground process group via tcgetpgrp(master_fd) and SIGKILLs
  // it, bypassing whatever signal trap the running process installed.
  const onForceKill = useCallback(() => {
    void termKillForeground(ptyId).catch(() => {
      // Backend may have torn the session down between the read and
      // the kill (rare race on tab close). Nothing useful to do; the
      // next Ctrl+C will start a fresh single-tap cycle anyway.
    });
  }, [ptyId]);

  // Window-level Ctrl+C path (fallback for focus-drifted-to-body) has
  // its own escalation state because the window listener never runs
  // PromptInput's keydown. Keep them independent so a mash that
  // ricochets through both paths still escalates cleanly.
  const fallbackLastCtrlCAtRef = useRef<number | null>(null);

  const onSubmit = useCallback(
    (text: string) => {
      setActiveCommand(text);
      // Defensive grid reset for agent transitions. When the user
      // Ctrl+C's an agent and immediately types another agent,
      // alacritty's grid still holds the dying TUI's last frame.
      // OSC 133 C will eventually clear it inside the reader loop,
      // but on a flaky integration (or just normal latency) the
      // shell echoes "claude\n" + claude's banner into the same
      // grid before that fires, and the user sees the new agent's
      // first paint ghosted on top of the old one. Firing the
      // clear from here makes the transition race-free.
      if (commandLineIsAgent(text)) {
        void termResetGrid(id).catch(() => {
          // Best-effort — if the backend is mid-flight we just fall
          // back to the OSC 133 C clear path. No need to surface.
        });
      }
      void sendLine(text);
      if (text.trim().length > 0) {
        setHistory((prev) => {
          const next = [text, ...prev];
          memSetHistory(id, next);
          return next;
        });
      }
    },
    [sendLine, id],
  );

  // Track previous command_running so we only react to the
  // running→idle TRANSITION for activeCommand. The naive "reset
  // when not running" version fired on the very first render after
  // onSubmit (because OSC 133 C hadn't arrived yet → command_running
  // was still false), wiping the activeCommand the user just typed.
  const prevRunningRef = useRef(false);
  useEffect(() => {
    if (directAgent) return;
    if (!liveFrame) return;
    const wasRunning = prevRunningRef.current;
    const isRunning = liveFrame.command_running;
    prevRunningRef.current = isRunning;
    if (wasRunning && !isRunning) {
      if (activeCommand.length > 0) setActiveCommand("");
      sniffBufferRef.current = "";
      setTimeout(() => promptRef.current?.focus(), 0);
    }
  }, [liveFrame?.command_running, activeCommand, directAgent]);

  // Once an agent foregrounds, we DO NOT release agent mode on a
  // single-frame `command_running=false` reading. OSC 133 D and C
  // markers can fire transiently during a TUI's lifetime (claude
  // redraws, scroll regions, etc.), and an immediate flip-back would
  // ping-pong against the banner-detect effect above — toggling the
  // PromptInput in/out, shifting the pane layout, and causing a
  // visible jitter that's hard to describe but very loud to look at.
  //
  // Instead: schedule the flip-back behind a debounce. If
  // `command_running` flips back to true before the timer fires (the
  // common case during a live agent session), we cancel and stay in
  // agent mode. Only a *sustained* idle period — long enough that the
  // agent has truly exited and dumped us back to the parent shell —
  // releases the takeover.
  const EXIT_DEBOUNCE_MS = 1500;
  const exitDebounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (directAgent) return;
    if (!liveFrame) return;
    if (!foregroundIsAgent) {
      if (exitDebounceRef.current !== null) {
        window.clearTimeout(exitDebounceRef.current);
        exitDebounceRef.current = null;
      }
      return;
    }
    if (liveFrame.command_running) {
      // Agent is alive — cancel any pending flip-back.
      if (exitDebounceRef.current !== null) {
        window.clearTimeout(exitDebounceRef.current);
        exitDebounceRef.current = null;
      }
      return;
    }
    // command_running is false AND we're in agent mode. Arm the timer
    // unless one is already counting down.
    if (exitDebounceRef.current === null) {
      exitDebounceRef.current = window.setTimeout(() => {
        exitDebounceRef.current = null;
        setForegroundIsAgent(false);
        sniffBufferRef.current = "";
        setTimeout(() => promptRef.current?.focus(), 0);
      }, EXIT_DEBOUNCE_MS);
    }
  }, [liveFrame?.command_running, foregroundIsAgent, directAgent]);

  // Tear down any pending exit-debounce when the component unmounts —
  // a fired timeout calling setState on a dead component would no-op
  // but it's still cleaner to cancel it.
  useEffect(() => {
    return () => {
      if (exitDebounceRef.current !== null) {
        window.clearTimeout(exitDebounceRef.current);
      }
    };
  }, []);

  // Authoritative agent-mode exit: a newly-CLOSED block while we're
  // foregrounding an agent means the shell observed OSC 133 D for
  // that agent command — i.e. the agent process exited (clean exit,
  // Ctrl+C, crash, whatever). The debounce above is the slow / soft
  // path that watches `command_running` edges; this is the hard
  // path that fires the moment the block boundary lands.
  //
  // Without this, an unlucky sequence of transient `command_running`
  // flips during the agent's last redraw could keep cancelling the
  // debounce and we'd be stuck in agent mode forever — exactly the
  // "I Ctrl+C'd claude and the input box never came back" symptom.
  // The shell-level block-close signal can't be reordered against
  // the agent process exit, so this is the safest "agent is really
  // gone" trigger we have.
  const lastBlockCountRef = useRef(blocks.length);
  useEffect(() => {
    if (!foregroundIsAgent) {
      lastBlockCountRef.current = blocks.length;
      return;
    }
    if (blocks.length > lastBlockCountRef.current) {
      lastBlockCountRef.current = blocks.length;
      // Cancel any in-flight debounce timer — we're firing the
      // transition now and don't want a delayed flip racing later.
      if (exitDebounceRef.current !== null) {
        window.clearTimeout(exitDebounceRef.current);
        exitDebounceRef.current = null;
      }
      setForegroundIsAgent(false);
      sniffBufferRef.current = "";
      // Same focus restoration the debounce path does, so the user
      // can immediately start typing into the recovered PromptInput.
      setTimeout(() => promptRef.current?.focus(), 0);
    }
  }, [blocks.length, foregroundIsAgent]);

  // Bracketed-paste passthrough. zsh + most modern shells set DECSET
  // 2004 by default (their line editor strips the markers and treats
  // pasted text literally — no auto-execute on embedded \n). We wrap
  // the pasted bytes in OSC 200/201 so multi-line pastes don't run
  // line-by-line as separate commands.
  const onPaste = useCallback(
    (text: string) => {
      const PS = "\x1b[200~";
      const PE = "\x1b[201~";
      const enc = new TextEncoder();
      void sendBytes(enc.encode(`${PS}${text}${PE}`));
    },
    [sendBytes],
  );

  // Tauri drag-and-drop. The webview intercepts native drops before any
  // DOM `ondrop` would fire and surfaces them through this global event
  // channel — so we subscribe once per terminal and gate by position
  // against the container's bounding box. With multiple terminals
  // mounted (right-panel side terminals, hidden-but-mounted worktree
  // keepalives) only the one whose box contains the drop point
  // accepts. Hidden terminals (display:none) have a zero-area rect, so
  // they never match.
  //
  // Shell mode → splice the quoted path(s) into the visible PromptInput
  // textarea so the user can edit / chain args / Enter to send. Agent
  // mode → route straight to the PTY via bracketed paste so claude,
  // codex, aider see "open this file" as one atomic input event.
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    if (!isVisible) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        // `leave` is positionless — the drag was cancelled or exited
        // the webview entirely. Clear the highlight and exit.
        if (event.payload.type === "leave") {
          setDragOver(false);
          return;
        }
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        // Tauri's drag-drop event reports `position` in PHYSICAL pixels
        // while `getBoundingClientRect()` returns CSS (logical) pixels.
        // On a Retina display the physical coords are ~2× larger, so
        // without this scale-down a drop on the lower-right pane of a
        // split layout would match the *upper-left* terminal's rect.
        const dpr = window.devicePixelRatio || 1;
        const x = event.payload.position.x / dpr;
        const y = event.payload.position.y / dpr;
        const inside =
          x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragOver(inside);
          return;
        }
        if (event.payload.type === "drop") {
          setDragOver(false);
          if (!inside) return;
          const paths = event.payload.paths;
          if (!paths || paths.length === 0) return;
          // Trailing space so the path is its own token regardless of
          // what the user types next ("describe this", "cat", etc.).
          const joined = `${joinShellPaths(paths)} `;
          if (foregroundIsAgentRef.current) {
            // Bracketed paste so the agent sees one atomic input event
            // even if the joined string has spaces / newlines.
            onPaste(joined);
            passthroughRef.current?.focus();
          } else {
            promptRef.current?.insertText(joined);
            promptRef.current?.focus();
          }
          markTerminalInteracted(id);
        }
      })
      .then((un) => {
        if (cancelled) {
          un();
          return;
        }
        unlisten = un;
      })
      .catch(() => {
        // Webview API unavailable (non-Tauri host, future plugin
        // permission tightening, etc.) — leave drag-drop off rather
        // than crash the terminal.
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [isVisible, id, onPaste]);

  const historyAt = useCallback(
    (offset: number) => history[offset] ?? null,
    [history],
  );

  // Don't steal focus from a text selection. Click on a block to copy
  // → the selection survives. Click into empty terminal space → focus
  // the active input (PromptInput in shell mode, PtyPassthrough in
  // agent mode) so typing "just works".
  const onContainerMouseUp = (e: MouseEvent<HTMLDivElement>) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().length > 0) {
      return;
    }
    // Only refocus on plain left-clicks; right-click opens context menus.
    if (e.button !== 0) return;
    if (foregroundIsAgent) {
      passthroughRef.current?.focus();
    } else {
      promptRef.current?.focus();
    }
  };

  // Mark this terminal as the most-recently-interacted one so the
  // window-level Ctrl+C fallback below knows which PTY to route to.
  // Fires on every mousedown inside the container — including drag-
  // selections in closed blocks, which is exactly the path where focus
  // drifts to document.body and the textarea handlers stop firing.
  const onContainerMouseDown = useCallback(() => {
    markTerminalInteracted(id);
  }, [id]);

  // Window-level Ctrl+C fallback — handles the "focus drifted to
  // document.body after a drag-selection" case. Encoding is pinned
  // by keyEncoding.test.ts; this pins the delivery path. Same
  // double-tap escalation as the textarea-focused path: second press
  // within ESCALATION_WINDOW_MS escalates SIGINT → SIGKILL on the
  // foreground process group.
  //
  // Gates:
  //   - No text currently selected (don't compete with copy paths).
  //   - Focus is on body or non-editable (not stealing from real inputs).
  //   - This terminal was most-recently interacted with (multi-pane).
  const liveCommandRunning = liveFrame?.command_running ?? false;
  const liveCommandRunningRef = useRef(liveCommandRunning);
  useEffect(() => {
    liveCommandRunningRef.current = liveCommandRunning;
  }, [liveCommandRunning]);
  useEffect(() => {
    if (!isVisible) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "c") return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().length > 0) return;
      const active = document.activeElement;
      if (active && active !== document.body) {
        const ae = active as HTMLElement;
        if (
          ae instanceof HTMLInputElement ||
          ae instanceof HTMLTextAreaElement ||
          ae.isContentEditable
        ) {
          return;
        }
      }
      if (getLastInteractedTerminal() !== id) return;
      e.preventDefault();
      const decision = decideCtrlCAction({
        now: Date.now(),
        lastCtrlCAt: fallbackLastCtrlCAtRef.current,
        commandRunning: liveCommandRunningRef.current,
      });
      fallbackLastCtrlCAtRef.current =
        decision.newLastCtrlCAt === 0 ? null : decision.newLastCtrlCAt;
      if (decision.action === "sigkill") {
        onForceKill();
      } else {
        void sendBytes(new Uint8Array([0x03]));
      }
      if (foregroundIsAgentRef.current) {
        passthroughRef.current?.focus();
      } else {
        promptRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, isVisible, sendBytes, onForceKill]);

  // Window-level Cmd+C copy. Closed blocks are plain divs with
  // userSelect: "text"; users can drag-select inside them. But our
  // input textareas (PromptInput / PtyPassthrough) auto-focus on
  // mount and the mouseUp refocus path keeps focus on the textarea
  // even when a selection lives elsewhere in the document. Browser-
  // native Cmd+C reads selection from the focused element — so it
  // sees the textarea's empty selection instead of the closed block
  // selection, and nothing lands on the clipboard.
  //
  // Fix: intercept Cmd+C at the window level. If the document
  // selection is non-empty AND originates from inside this terminal's
  // container (the closed block / live block area), copy it
  // explicitly via navigator.clipboard.writeText.
  //
  // Why scope to this terminal's container? Multi-pane: each
  // BlockTerminal registers this listener. Without the container
  // contains() gate every visible terminal would race to copy on
  // every Cmd+C — including ones whose container doesn't hold the
  // selection. Containment is exact and avoids any need for a
  // disambiguation registry on the copy path.
  useEffect(() => {
    if (!isVisible) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "c") return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = sel.toString();
      if (text.length === 0) return;
      // If the selection originates inside an editable element, let
      // the browser's native copy run — that's the right path for
      // copying text the user actually typed into a textarea or a
      // contenteditable surface (CodeMirror, TipTap, etc.).
      //
      // `isContentEditable` is the standardized getter that returns
      // true for any node inside a `contenteditable` ancestor —
      // regardless of whether the attribute is set to "true", "",
      // or "plaintext-only" — so it catches every form CodeMirror's
      // contenteditable or TipTap's ProseMirror surface might use.
      // The strict `[contenteditable='true']` selector used to miss
      // any of those non-canonical values.
      const anchor = sel.anchorNode;
      const anchorEl =
        anchor instanceof Element
          ? anchor
          : anchor?.parentElement ?? null;
      if (anchorEl) {
        if (anchorEl.closest("textarea, input")) return;
        if (
          anchorEl instanceof HTMLElement &&
          anchorEl.isContentEditable
        ) {
          return;
        }
      }
      const container = containerRef.current;
      if (!container || !anchor || !container.contains(anchor)) return;
      e.preventDefault();
      void navigator.clipboard.writeText(text).catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isVisible]);

  const effectiveCwd = liveCwd ?? cwd ?? "";

  return (
    <div
      ref={containerRef}
      onMouseUp={onContainerMouseUp}
      onMouseDown={onContainerMouseDown}
      data-bell-flash={bellFlash ? "1" : undefined}
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--surface-0)",
        position: "relative",
        // Soft warm pulse when the terminal rings the bell. CSS handles
        // the easing so the runtime cost is one class flip. When a file
        // drag is hovering this pane, swap the warning ring for the
        // accent ring so the user can see which terminal will receive
        // the dropped paths.
        boxShadow: dragOver
          ? "inset 0 0 0 2px var(--accent-bright)"
          : bellFlash
            ? "inset 0 0 0 1px var(--state-warning)"
            : undefined,
        transition: "box-shadow 480ms cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      {exited && (
        <div
          role="status"
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-2) var(--space-3)",
            backgroundColor: "var(--surface-error-soft)",
            color: "var(--state-error-bright)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            borderBottom: "var(--border-1)",
          }}
        >
          <span>session ended</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => setGeneration((g) => g + 1)}
            style={{
              height: 22,
              padding: "0 var(--space-3)",
              backgroundColor: "var(--surface-2)",
              color: "var(--text-primary)",
              border: "var(--border-1)",
              borderRadius: "var(--radius-sm)",
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-xs)",
              fontWeight: "var(--weight-medium)",
              cursor: "default",
            }}
          >
            restart
          </button>
        </div>
      )}

      {!exited && altScreen && (
        // Alt-screen TUI (vim, htop, claude-in-alt-screen) renders
        // exclusively through the WebGPU CanvasGrid. The previous
        // DOM-backed FullGrid is retired — CanvasGrid handles
        // selection, cursor, and the full feature set, and keeping
        // two paths invited drift bugs. The `autoFocus` prop isn't
        // forwarded because CanvasGrid manages its own focus through
        // the hidden textarea overlay.
        <div style={{ flex: 1, minHeight: 0 }}>
          <CanvasGrid frame={liveFrame} onSendBytes={sendBytes} />
        </div>
      )}

      {/* Unified Warp-style scroll: closed blocks + the live block
          (shell command output OR the agent's TUI) flow together in
          one scroll container. The agent is just another block in the
          stream — the whole pane scrolls as one continuous history.
          `preserveGrid` switches the LiveBlock body between DOM CellRow
          rendering (shell output, soft-wrap) and the WebGPU CanvasGrid
          (agent TUI, fixed grid). */}
      {!altScreen && (
        <div
          ref={scrollContainerRef}
          onScroll={onScrollContainerScroll}
          className={
            allowHorizontalScroll ? "goonware-no-horizontal-scrollbar" : undefined
          }
          style={agentScrollContainerStyle(allowHorizontalScroll)}
        >
          {/* Width-sizing wrapper. In `allowHorizontalScroll` mode,
              CellRows render with `whiteSpace: pre` and the LiveBlock
              body has `overflowX: visible`, so individual lines can
              extend past the scroll container's viewport. Without this
              wrapper, the LiveBlock outer (and each closed Block) is
              sized to the scroll container's CLIENT width — so when
              the user pans right, the block frames (border-top of
              LiveBlock, border-bottom of the command-line divider,
              the "RUNNING" header row) end short of the visible right
              edge while the inner text keeps going. The user-reported
              symptom is "white space on the side on the right." The
              wrapper takes `min-width: max-content` so it expands to
              the widest line across all blocks; combined with `100%`
              minimum so a narrow transcript still fills the pane. All
              block frames inside stretch to this wrapper's width, so
              every divider and pill spans the full panned content. */}
          <div
            style={
              allowHorizontalScroll
                ? {
                    display: "flex",
                    flexDirection: "column",
                    minWidth: "max-content",
                    width: "100%",
                  }
                : { display: "contents" }
            }
          >
            {/* BlockList must render in BOTH shell and agent modes so the
                user can always scroll back into closed-block history.
                The earlier "hide it during agent mode" workaround broke
                scrollback while a live agent was running (user-reported
                "i cant scroll in the terminal while an agent is
                running"). Squashing of the LiveBlock by a tall BlockList
                is now prevented by the fill-mode LiveBlock's hard
                min-height: 100cqh (see `liveBlockOuterStyle`), not by
                hiding history. `shouldRenderBlockList` always returns
                true and exists so the regression is pinned by a test. */}
            {shouldRenderBlockList(foregroundIsAgent) && (
              <BlockList blocks={blocks} noWrap={allowHorizontalScroll} />
            )}
            {liveFrame?.command_running && !exited && (
              <LiveBlock
                command={activeCommand}
                frame={liveFrame}
                cwd={effectiveCwd}
                preserveGrid={foregroundIsAgent}
                noWrap={allowHorizontalScroll}
                // Agent TUIs own the surface — let the LiveBlock fill
                // the pane instead of sizing to content. Without this,
                // a tall agent grid (claude with the slash-command
                // picker open) draws below an empty BlockList region,
                // the outer scroll anchors that combined column at the
                // bottom, and the user sees a fat band of blank canvas
                // above the picker. Filling the pane puts the picker's
                // first row at the visible top edge — what users mean
                // by "I want to see what I'm picking."
                fill={foregroundIsAgent}
              />
            )}
          </div>
        </div>
      )}

      {!agentMode && effectiveCwd && (
        <TerminalStatusBar cwd={effectiveCwd} command={command} />
      )}
      {agentMode && effectiveCwd && (
        // Agent-mode info strip: icon + diff + path + branch, no
        // controls. Same component as shell mode in `readonly` form —
        // share data + styling, drop the branch-switcher picker so it
        // can't fire mid-agent-session.
        <TerminalStatusBar
          cwd={effectiveCwd}
          command={activeCommand || command}
          readonly
        />
      )}
      {!agentMode && (
        <PromptInput
          ref={promptRef}
          onSubmit={onSubmit}
          onSendBytes={onSendBytesVoid}
          onForceKill={onForceKill}
          commandRunning={liveCommandRunning}
          onPaste={onPaste}
          historyLength={history.length}
          historyAt={historyAt}
          cwd={effectiveCwd}
          autoFocus={autoFocus}
        />
      )}
      {foregroundIsAgent && !altScreen && (
        <PtyPassthrough
          ref={passthroughRef}
          onSendBytes={onSendBytesVoid}
          onForceKill={onForceKill}
          commandRunning={liveCommandRunning}
          appCursor={liveFrame?.app_cursor ?? false}
          bracketedPaste={liveFrame?.bracketed_paste ?? false}
          autoFocus={autoFocus}
        />
      )}
    </div>
  );
}
