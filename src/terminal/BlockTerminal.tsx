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
import { writeClipboardTextWithFallback } from "./clipboardWrite";
import { decideSoftResetAction } from "./softReset";
import { forceEvictForCwd, forceIdleForCwd } from "@/state/agentActivityStore";
import {
  agentScrollContainerStyle,
  shouldRenderBlockList,
} from "./agentScrollLayout";
import { deriveInputMode, nextRawLatch } from "./inputModeDecision";

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
  /**
   * When true (main column only), this terminal drives the native warpui
   * surface while it's the active tab. Right-panel agent terminals leave this
   * unset so they don't hijack the single native surface (multi-pane is M6).
   */
  nativeSurface?: boolean;
  /** Which native pane this terminal drives: "main" (main column) or "side"
   *  (right-panel). Threaded into every native command so the two panes' grids
   *  / scroll / selection stay independent on the one embedded surface. */
  paneKey?: "main" | "side";
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
  nativeSurface = false,
  paneKey = "main",
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
  // Native warpui terminal surface (macOS): when THIS terminal is the active
  // tab, tell the backend to mirror this pty. Key on the real `ptyId`
  // (generation-adjusted) the PTY actually runs under — not the tab's base id,
  // which would miss the `-r<n>` suffix after a restart and mirror nothing.
  // No detach on cleanup: the next visible terminal's attach overwrites the
  // target, and WarpSurfaceTracker clears it when no terminal tab is active —
  // avoiding a tab-switch race where an outgoing slot's cleanup clobbers the
  // incoming slot's attach.
  useEffect(() => {
    if (!nativeSurface || !isVisible) return;
    invoke("term_native_attach", { paneKey, id: ptyId }).catch(() => {});
  }, [nativeSurface, isVisible, ptyId, paneKey]);
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
  // Latched by an explicit force-kill (double-tap Ctrl+C / soft reset) to
  // SUPPRESS agent auto-detection until the next user submission. After the
  // user SIGKILLs an agent, `command_running` can stay stuck true — the shell
  // never emits the OSC 133 "done" marker for the killed child — so both the
  // banner sniff and the command-line classifier would otherwise re-detect the
  // dead agent from its leftover grid bytes (or the still-"claude" activeCommand)
  // and flip `foregroundIsAgent` back on, pinning the PromptInput off-screen
  // forever ("I killed claude and the input never came back"). Cleared in
  // `onSubmit` so re-running an agent immediately works.
  const forceKilledRef = useRef(false);
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
  // Same latest-value-without-re-registration trick for "is PtyPassthrough
  // the mounted input layer." Covers inline agents AND inline raw prompts
  // (inquirer/fzf/…) — the latter never flips `foregroundIsAgent`, so the
  // closure below would otherwise try to focus a PromptInput that isn't
  // mounted while a raw prompt owns the surface. Synced in an effect after
  // `passthroughActive` is computed.
  const passthroughActiveRef = useRef(false);

  // Register a focus function for this terminal's tab id, so the
  // global `useFocusActiveTerminal` hook can send focus here whenever
  // the user switches to this terminal's worktree. Mirrors the
  // mouseUp-on-empty-area click-to-refocus logic below: in agent mode
  // we focus the PtyPassthrough invisible input (forwards every key
  // straight to the PTY); in shell mode we focus PromptInput's textarea.
  useEffect(() => {
    registerTerminalFocus(id, () => {
      if (foregroundIsAgentRef.current || passthroughActiveRef.current) {
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
    forceResync,
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

  // Sustained anchor while stick-to-bottom is true: ANY growth of the
  // scroll container's content (BlockList row added, LiveBlock body
  // tall canvas mid-bootstrap, AgentChrome rendering for the first
  // time, etc.) re-snaps scrollTop to the new scrollHeight. Without
  // this, the user-reported "open a new claude and it glitches
  // halfway up the pane" bug fires whenever the LiveBlock fill mode
  // settles AFTER the layout-effect snap above has already run — the
  // first snap commits when the inner body is still empty / short,
  // then the canvas grows downward via `flex-end` justification and
  // the scroll position is left somewhere in the middle of the
  // scrollHeight. The intermittent nature ("doesn't happen every
  // time") matches the race: only when the LiveBlock layout settles
  // across more rAFs than the post-flip rAF-snap chain covers.
  //
  // Observe the scroll container itself (its scrollHeight grows as
  // children grow). Snap synchronously inside the observer so the
  // viewport never paints with a stale scrollTop.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      // Read in the same tick we write — the observer fires between
      // layout and paint, so scrollHeight is current.
      el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    // Also observe direct children so a growth INSIDE the container
    // (LiveBlock body inflating to 100cqh, CanvasGrid auto height
    // settling to rows × cellHeight) fires the snap even when the
    // container's own outer height is stable. Children mount /
    // unmount with React's reconciliation, so re-observe whenever
    // the child list changes — use a MutationObserver for that.
    const childObserver = new MutationObserver(() => {
      for (const child of Array.from(el.children)) {
        if (child instanceof HTMLElement) observer.observe(child);
      }
    });
    childObserver.observe(el, { childList: true });
    // Prime: observe the current children once at mount.
    for (const child of Array.from(el.children)) {
      if (child instanceof HTMLElement) observer.observe(child);
    }
    return () => {
      observer.disconnect();
      childObserver.disconnect();
    };
  }, []);

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

  // Warp-style drag-to-scroll. Pointer-down anywhere on the scroll
  // container starts tracking; once the pointer moves past a small
  // threshold we engage drag mode (cancel any nascent selection, take
  // pointer capture, and slide scrollTop with the cursor). Below the
  // threshold the event flows through normally, so taps still focus
  // and short drags can still start a text selection.
  //
  // We skip drag on canvas / input / button targets so the agent's
  // CanvasGrid keeps its own click semantics and the PromptInput
  // textarea isn't hijacked when the user reaches for it.
  useEffect(() => {
    const el = scrollContainerRef.current;
    // Native surface: left-drag is TEXT SELECTION (Warp behavior), driven by the
    // selection mouse bridge below; scrolling is the wheel/trackpad. The grab-to-
    // scroll handler must NOT run here — its non-passive `pointermove`
    // `preventDefault()` suppresses the compatibility `mousemove` events that the
    // selection bridge relies on, so the selection would start on mousedown and
    // never extend (the "can't highlight with click-drag" bug). Keep grab-to-
    // scroll only for the legacy non-native (CanvasGrid) path.
    if (!el || nativeSurface) return;
    const DRAG_THRESHOLD_PX = 6;
    let activePointerId = -1;
    let startY = 0;
    let startScroll = 0;
    let engaged = false;
    let restoreUserSelect: string | null = null;

    const isInteractiveTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      return Boolean(
        target.closest(
          "canvas, input, textarea, button, select, [contenteditable=true], [role='button']",
        ),
      );
    };

    const teardown = () => {
      if (activePointerId !== -1) {
        try {
          el.releasePointerCapture?.(activePointerId);
        } catch {
          // Pointer capture wasn't granted — ignore.
        }
      }
      activePointerId = -1;
      engaged = false;
      if (restoreUserSelect !== null) {
        document.body.style.userSelect = restoreUserSelect;
        restoreUserSelect = null;
      }
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerId !== activePointerId) return;
      const dy = e.clientY - startY;
      if (!engaged) {
        if (Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        engaged = true;
        // Drop any selection that the down-event started; once we're
        // committing to a scroll-drag the highlighted text would just
        // streak across the page as the cursor moves.
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) sel.removeAllRanges();
        restoreUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
        try {
          el.setPointerCapture?.(activePointerId);
        } catch {
          // Some targets refuse capture (e.g. detached nodes); the
          // window-level listeners still drive the drag, so this is
          // a soft failure.
        }
      }
      // Natural-drag direction: pull the content up to reveal what's
      // below (scrollTop increases as the cursor moves up). This
      // matches the touch convention every user already knows.
      el.scrollTop = startScroll - dy;
      e.preventDefault();
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerId !== activePointerId) return;
      teardown();
    };

    const onPointerDown = (e: PointerEvent) => {
      // Left button (0) or middle button (1). Right-click should keep
      // its native context menu.
      if (e.button !== 0 && e.button !== 1) return;
      if (isInteractiveTarget(e.target)) return;
      activePointerId = e.pointerId;
      startY = e.clientY;
      startScroll = el.scrollTop;
      engaged = false;
      window.addEventListener("pointermove", onPointerMove, { passive: false });
      window.addEventListener("pointerup", onPointerUp, { passive: true });
      window.addEventListener("pointercancel", onPointerUp, { passive: true });
    };

    el.addEventListener("pointerdown", onPointerDown, { passive: true });
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      teardown();
    };
  }, [nativeSurface]);

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

  // Latch raw-prompt mode for the LIFETIME of the running command. Prompt
  // libraries restore canonical mode briefly between questions (`npm
  // init` and other multi-step wizards) and some toggle it per keypress;
  // reading `raw_input` raw would make the mode flicker false on those
  // gaps and flip the input layer + chrome back to shell for a frame —
  // visible as the whole pane jittering as the user navigates and selects.
  // Once a running command has gone raw even once, stay raw until it ends
  // (passthrough forwards canonical input fine too, so there's no reason
  // to flip back mid-command). Reset the instant the command ends / the
  // pane exits / an alt-screen TUI takes over.
  const rawSeen = liveFrame?.raw_input ?? false;
  const [rawLatched, setRawLatched] = useState(false);
  useEffect(() => {
    const next = nextRawLatch(rawLatched, {
      exited,
      altScreen,
      commandRunning,
      rawInput: rawSeen,
    });
    if (next !== rawLatched) setRawLatched(next);
  }, [exited, altScreen, commandRunning, rawSeen, rawLatched]);

  // Which input layer owns the keyboard. `deriveInputMode` (pure, tested
  // in inputModeDecision.test.ts) folds the live frame flags into three
  // decisions:
  //   - inlineRawPrompt: a child put the tty into raw mode (ICANON
  //     cleared → frame `raw_input`) WHILE a command runs, rendered
  //     inline — inquirer / `prompts` / clack menus, fzf, password
  //     readers. PromptInput would otherwise swallow the arrow keys these
  //     need for menu nav (see its history / completion onKeyDown
  //     handlers), so we forward every key raw via PtyPassthrough. Gated
  //     on commandRunning because the shell's OWN ZLE runs the tty raw at
  //     an idle prompt too (see types.ts:raw_input). Fed the LATCHED raw
  //     bit (rawSeen || rawLatched) so it doesn't flicker mid-command.
  //   - agentMode: hide PromptInput + status bar so the running program
  //     owns the surface (alt-screen TUIs, inline agents, inline raw).
  //   - passthroughActive: PtyPassthrough is the mounted input layer.
  //     One flag so the JSX mount and the autofocus effect can't drift.
  const { inlineRawPrompt, agentMode, passthroughActive } = deriveInputMode({
    exited,
    altScreen,
    commandRunning,
    rawInput: rawSeen || rawLatched,
    foregroundIsAgent,
    nativeSurface,
  });
  useEffect(() => {
    passthroughActiveRef.current = passthroughActive;
  }, [passthroughActive]);

  // Tell the native surface when this pane is in agent mode. In agent mode the
  // PromptInput is hidden and keystrokes go raw to the PTY (PtyPassthrough), so
  // the native live grid — not the React input box — is what the user sees and
  // types into. Crucially this stays latched across the ~1.5s agent-exit
  // debounce, so a just-killed agent keeps showing its shell prompt instead of
  // a dark surface ("Ctrl+C doesn't come back"). `ptyId` is a dep so the push
  // re-fires after a tab-switch attach reset.
  useEffect(() => {
    if (!nativeSurface || !isVisible) return;
    invoke("term_native_set_agent_mode", { paneKey, active: agentMode }).catch(() => {});
  }, [nativeSurface, isVisible, agentMode, ptyId, paneKey]);

  // The native surface drives ALL modes on a native pane: shell, inline agents
  // (claude/codex), AND alt-screen TUIs (vim/htop). Alt-screen used to fall back
  // to the React WebGPU CanvasGrid; it now renders through the native alt-grid
  // path too (the native surface was already painting it behind the opaque
  // canvas — we just stop covering it), so the WebGPU stack is only used by
  // non-native (right-panel) terminals. Input is captured by React and forwarded
  // to the PTY — PromptInput (shell), PtyPassthrough (inline agent OR native
  // alt-screen) — and the native grid shows the echo. Non-native panes
  // (nativeSurface=false) keep CanvasGrid for both display and input.
  const nativeActive = nativeSurface;

  // Autofocus the invisible PtyPassthrough whenever an inline agent engages on
  // the visible pane. With the native surface rendering the agent through a
  // transparent hole there's no visible element to click, so nothing would
  // otherwise focus the passthrough — leaving the user unable to type or Ctrl+C
  // into the agent. (Shell mode doesn't need this: its PromptInput box is
  // visible and grabs focus on click.) Click-to-refocus + the window-level
  // Ctrl+C fallback cover focus drift after that.
  useEffect(() => {
    // PtyPassthrough is the input layer for inline agents, inline raw
    // prompts, AND native alt-screen (vim/htop on a native pane). Focus it
    // whenever it's the one mounted so the user can type / Ctrl+C without a
    // visible element to click.
    if (!isVisible || !passthroughActive) return;
    const t = setTimeout(() => passthroughRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [isVisible, passthroughActive]);

  // Scroll-back wheel bridge. The native surface renders the shell transcript
  // through a transparent hole; the embedded child window has
  // `ignoresMouseEvents: YES`, so wheel events land on this (invisible) React
  // scroll container instead. Forward the delta to the native
  // `ClippedScrollable` via `term_native_scroll` and swallow it so the empty
  // container doesn't also scroll. Only while the native surface owns the
  // SHELL transcript: agent / alt-screen panes keep their own React scrolling
  // (and the native render ignores the offset there anyway). A NON-passive
  // listener is required — React's synthetic `onWheel` is passive, so
  // `preventDefault` would no-op. `deltaY > 0` (scroll down) advances toward
  // newer output; the Rust side drops stick-to-bottom and re-arms it when the
  // user scrolls back down or the content fits.
  useEffect(() => {
    const el = scrollContainerRef.current;
    // Active for the native transcript: the shell history AND inline agents
    // (claude/codex in the NORMAL screen). An inline agent's conversation
    // scrolls off into PTY scroll-back, which the native renderer mirrors into
    // the transcript flow — so the wheel drives `term_native_scroll` to move
    // through it, exactly like scrolling up in a real terminal. Only ALT-SCREEN
    // apps (vim/htop, or an agent that took the alt screen) own their own
    // scroll; those are handled by the agent-wheel bridge below, so bail here.
    if (!el || !nativeActive || altScreen) return;
    // Coalesce to ONE batched scroll per animation frame. Each invoke pokes a
    // full native re-render of the transcript; one per wheel event (60–120/sec
    // on a trackpad) floods the main thread and the scroll-back stutters.
    // Accumulate the pixel delta and flush once per rAF (display refresh) so the
    // transcript re-renders at most ~60fps with the summed delta — smooth.
    let accumPx = 0;
    let accumPxX = 0;
    let raf = 0;
    const flush = () => {
      raf = 0;
      // Vertical pan (always meaningful) and horizontal pan (only when the grid
      // is wider than the pane — the native renderer builds the horizontal
      // ClippedScrollable then; a no-op otherwise). Each axis is sent only when
      // it actually moved, so a pure vertical scroll never fires an hscroll.
      if (accumPx !== 0) {
        const px = accumPx;
        accumPx = 0;
        invoke("term_native_scroll", { paneKey, deltaPx: px }).catch(() => {});
      }
      if (accumPxX !== 0) {
        const px = accumPxX;
        accumPxX = 0;
        invoke("term_native_hscroll", { paneKey, deltaPx: px }).catch(() => {});
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Most devices report pixels (deltaMode 0); convert line/page deltas.
      accumPx +=
        e.deltaMode === 1
          ? e.deltaY * 16
          : e.deltaMode === 2
            ? e.deltaY * (el.clientHeight || 400)
            : e.deltaY;
      accumPxX +=
        e.deltaMode === 1
          ? e.deltaX * 16
          : e.deltaMode === 2
            ? e.deltaX * (el.clientWidth || 400)
            : e.deltaX;
      if (!raf) raf = requestAnimationFrame(flush);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [nativeActive, altScreen, paneKey]);

  // Alt-screen wheel → forward to the PTY so a full-screen app (vim/htop, or an
  // agent that took the ALT screen) scrolls ITS OWN view — exactly like a real
  // terminal. ONLY alt-screen: an INLINE agent (claude/codex in the normal
  // screen) has no internal scroll-back — its conversation scrolls into the PTY
  // history, which the native renderer now mirrors into the transcript flow, so
  // the shell-transcript bridge above drives `term_native_scroll` for it. Routing
  // the inline-agent wheel to the PTY was the "can't scroll while claude runs"
  // bug: the agent ignores it and nothing moves. term_native_wheel encodes
  // SGR/X10 mouse-wheel bytes for mouse-aware apps and no-ops for the rest;
  // pixel→notch conversion + the cell coords under the cursor (SF Mono 0.6em ×
  // 1.3 line) are sent so apps scroll the right region.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !nativeActive || !altScreen) return;
    const CELL_W = 13 * 0.6;
    const CELL_H = 13 * 1.3;
    const LINE_PX = 16; // px of wheel travel per scroll line/notch
    // Coalesce wheel input to ONE batched scroll per animation frame. A trackpad
    // fires 60–120 wheel events/sec; sending an invoke + a full PTY redraw for
    // each floods the round-trip and Claude scrolls in lurches ("low
    // framerate"). Accumulating the delta and flushing once per rAF caps it to
    // the display refresh, keeps sub-line precision (the remainder carries), and
    // collapses a burst into a single proportional scroll — smooth + cheap.
    const MAX_LINES_PER_FRAME = 6; // cap per frame so a fast flick stays smooth
    let accumPx = 0;
    let raf = 0;
    let col = 1;
    let row = 1;
    const flush = () => {
      raf = 0;
      const want = Math.trunc(accumPx / LINE_PX);
      if (want === 0) return;
      const lines = Math.max(
        -MAX_LINES_PER_FRAME,
        Math.min(MAX_LINES_PER_FRAME, want),
      );
      accumPx -= lines * LINE_PX;
      invoke("term_native_wheel", { id: ptyId, deltaLines: lines, col, row }).catch(
        () => {},
      );
      // Drain a fast flick across subsequent frames (momentum) rather than one
      // big jump — smooth deceleration.
      if (Math.abs(accumPx) >= LINE_PX) raf = requestAnimationFrame(flush);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      accumPx +=
        e.deltaMode === 1
          ? e.deltaY * 16
          : e.deltaMode === 2
            ? e.deltaY * (el.clientHeight || 400)
            : e.deltaY;
      const rect = el.getBoundingClientRect();
      col = Math.max(1, Math.floor((e.clientX - rect.left) / CELL_W) + 1);
      row = Math.max(1, Math.floor((e.clientY - rect.top) / CELL_H) + 1);
      if (!raf) raf = requestAnimationFrame(flush);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [nativeActive, altScreen, ptyId]);

  // Selection mouse bridge. Same situation as the wheel bridge: the native
  // surface renders through a transparent hole and ignores mouse events, so
  // drags land on this (invisible) container. Forward down/drag/up to
  // `term_native_mouse` → warpui's own hit-testing + selection. Runs for BOTH
  // shell AND agent mode (Warp-style: Goonware owns left-drag selection over the
  // agent; the agent is keyboard-driven and no longer receives mouse drags).
  // The attach target differs: shell mode uses the transcript scroll container
  // (so mousedowns on the input bar / status strip don't start a selection);
  // agent mode uses the whole pane container — in alt-screen the scroll
  // container isn't even mounted. `(x, y)` are window-content coords
  // (clientX/clientY) regardless, so the attach target doesn't affect
  // hit-testing — Rust subtracts the surface origin. Move/up listen on the
  // window so a drag tracks past the container edge. `preventDefault` on
  // mousedown stops the hidden DOM block list from starting its own text
  // selection. Left button only. A native cmd+left-click also routes here: the
  // warpui Text link handler consumes it (opens the URL) — see styled_run.
  useEffect(() => {
    const el = agentMode ? containerRef.current : scrollContainerRef.current;
    if (!el || !nativeActive) return;

    // Agent alt-screen (the claude/codex TUI): a left-drag SCROLLS the agent's
    // pager instead of selecting. The surface is keyboard-driven and warpui
    // selection just clamps to the visible grid there, so grab-to-scroll is the
    // gesture that actually pays off — press and pull DOWN to drag older output
    // into view, like a touch surface. Drag travel is translated into the same
    // mouse-wheel encoding the wheel bridge emits (term_native_wheel), so claude
    // scrolls identically whether you flick the trackpad or grab and pull. A
    // press with no travel falls through as a click so cmd+click links still
    // open. Shell mode (and the inline, non-alt-screen agent) keep left-drag =
    // text selection, handled by the original path below.
    const dragScrolls = altScreen;
    const DRAG_THRESHOLD = 6; // px before a press commits to a scroll-drag
    const DRAG_LINE_PX = 16; // px of drag travel per scrolled line (matches wheel)
    const CELL_W = 13 * 0.6;
    const CELL_H = 13 * 1.3;
    let scrollMode = false;
    let startX = 0;
    let startY = 0;
    let lastDragY = 0;
    let dragAccumPx = 0;

    let dragging = false;
    // The latest pointer position during a drag, kept so the autoscroll loop
    // can re-dispatch a drag (extending the selection) when the pointer is held
    // STILL past an edge and no `mousemove` fires.
    let lastX = 0;
    let lastY = 0;
    let lastMods = { shift: false, cmd: false, alt: false, ctrl: false };
    let autoRaf = 0;
    const sendAt = (kind: string, x: number, y: number) => {
      // Window-content coords (clientX/Y); Rust subtracts the combined surface
      // origin so the event lands in this pane's region (warpui hit-tests by
      // position across both panes' SelectableAreas).
      invoke("term_native_mouse", {
        kind,
        x,
        y,
        clickCount: 1,
        ...lastMods,
      }).catch(() => {});
    };
    const send = (kind: string, e: globalThis.MouseEvent) => {
      invoke("term_native_mouse", {
        kind,
        x: e.clientX,
        y: e.clientY,
        clickCount: e.detail || 1,
        shift: e.shiftKey,
        cmd: e.metaKey,
        alt: e.altKey,
        ctrl: e.ctrlKey,
      }).catch(() => {});
    };
    // Warp-style edge autoscroll: while the drag pointer sits beyond the top or
    // bottom of the transcript viewport, scroll the native transcript and keep
    // re-dispatching a drag pinned to the edge so warpui extends the selection
    // into the freshly revealed lines. Runs on its own rAF so it continues even
    // when the pointer is motionless (no `mousemove`). Speed scales with how far
    // past the edge the pointer is. `deltaPx > 0` advances toward newer output
    // (down); `< 0` toward older (up) — same convention as the wheel bridge.
    // Autoscroll engages within EDGE px of the top/bottom (and of course past
    // it) — you don't have to drag exactly off the surface, just toward the edge,
    // like Warp / a native text view. Speed ramps with how deep into the zone the
    // pointer is.
    const EDGE = 40;
    const tick = () => {
      autoRaf = 0;
      if (!dragging) return;
      const r = el.getBoundingClientRect();
      let delta = 0;
      let edgeY = lastY;
      if (lastY < r.top + EDGE) {
        const dist = r.top + EDGE - lastY; // grows as you near / pass the top
        delta = -Math.min(64, 4 + dist * 0.6);
        edgeY = r.top + 1;
      } else if (lastY > r.bottom - EDGE) {
        const dist = lastY - (r.bottom - EDGE);
        delta = Math.min(64, 4 + dist * 0.6);
        edgeY = r.bottom - 1;
      }
      if (delta === 0) return; // back inside the safe zone — stop the loop
      invoke("term_native_scroll", { paneKey, deltaPx: delta }).catch(() => {});
      // Re-extend the selection to the edge after the scroll lands.
      sendAt("drag", lastX, edgeY);
      autoRaf = requestAnimationFrame(tick);
    };
    const maybeAutoscroll = () => {
      if (autoRaf) return; // already looping
      // Edge autoscroll drives the native transcript (term_native_scroll), which
      // now carries the inline agent's scroll-back too — so a drag-select can
      // reveal older conversation while dragging past the top, same as the shell.
      // Only alt-screen apps own their own scroll with no transcript to reveal,
      // so skip there — the selection just clamps to the visible grid.
      if (altScreen) return;
      const r = el.getBoundingClientRect();
      if (lastY < r.top + EDGE || lastY > r.bottom - EDGE)
        autoRaf = requestAnimationFrame(tick);
    };
    const onMove = (e: globalThis.MouseEvent) => {
      if (!dragging) return;
      if (dragScrolls) {
        if (!scrollMode) {
          // Stay a (potential) click until the pointer clears the threshold,
          // so a tap/cmd-click isn't swallowed by an over-eager scroll.
          if (
            Math.abs(e.clientY - startY) < DRAG_THRESHOLD &&
            Math.abs(e.clientX - startX) < DRAG_THRESHOLD
          )
            return;
          scrollMode = true;
          lastDragY = startY;
        }
        e.preventDefault();
        dragAccumPx += e.clientY - lastDragY;
        lastDragY = e.clientY;
        const want = Math.trunc(dragAccumPx / DRAG_LINE_PX);
        if (want !== 0) {
          dragAccumPx -= want * DRAG_LINE_PX;
          const rect = el.getBoundingClientRect();
          const col = Math.max(1, Math.floor((e.clientX - rect.left) / CELL_W) + 1);
          const row = Math.max(1, Math.floor((e.clientY - rect.top) / CELL_H) + 1);
          // Natural drag: pulling DOWN (want > 0) should reveal OLDER output —
          // that's a wheel-UP — so negate to match the wheel bridge's sign.
          invoke("term_native_wheel", {
            id: ptyId,
            deltaLines: -want,
            col,
            row,
          }).catch(() => {});
        }
        return;
      }
      lastX = e.clientX;
      lastY = e.clientY;
      lastMods = { shift: e.shiftKey, cmd: e.metaKey, alt: e.altKey, ctrl: e.ctrlKey };
      send("drag", e);
      maybeAutoscroll();
    };
    const onUp = (e: globalThis.MouseEvent) => {
      if (!dragging) return;
      dragging = false;
      if (autoRaf) cancelAnimationFrame(autoRaf);
      autoRaf = 0;
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      if (dragScrolls) {
        // No travel → it was a click, not a scroll. Replay down+up at the
        // release point so plain clicks and cmd+click link-opens still reach
        // warpui. A committed scroll-drag emits nothing (so it never selects).
        if (!scrollMode) {
          send("down", e);
          send("up", e);
        }
        return;
      }
      send("up", e);
    };
    const onDown = (e: globalThis.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      lastMods = { shift: e.shiftKey, cmd: e.metaKey, alt: e.altKey, ctrl: e.ctrlKey };
      if (dragScrolls) {
        // Defer the decision: a press might be a click (cmd+click link) or the
        // start of a scroll-drag. Don't open a selection on the down edge.
        scrollMode = false;
        dragAccumPx = 0;
        lastDragY = e.clientY;
      } else {
        lastX = e.clientX;
        lastY = e.clientY;
        send("down", e);
      }
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    };
    el.addEventListener("mousedown", onDown, true);
    return () => {
      el.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      if (autoRaf) cancelAnimationFrame(autoRaf);
    };
  }, [nativeActive, agentMode, altScreen, paneKey, ptyId]);

  // Cmd+C copies the native selection (kept by warpui's SelectableArea, exposed
  // via term_native_selection_text) through the existing pbcopy path. Capture-
  // phase + window-level so it wins over the focused PromptInput / PtyPassthrough
  // — UNLESS that textarea has its own selection, in which case we defer to the
  // browser's normal copy. Runs for shell AND agent mode now that the agent grid
  // is selectable too (Cmd+C is copy, not interrupt — Ctrl+C is the agent's
  // interrupt and routes through PtyPassthrough untouched).
  useEffect(() => {
    if (!nativeActive || !isVisible) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== "c") return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT")) {
        const inp = ae as HTMLInputElement | HTMLTextAreaElement;
        if (inp.selectionStart != null && inp.selectionStart !== inp.selectionEnd) return;
      }
      e.preventDefault();
      invoke<string | null>("term_native_selection_text", { paneKey })
        .then((t) => {
          if (t) void writeClipboardTextWithFallback(t);
        })
        .catch(() => {});
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [nativeActive, agentMode, isVisible, paneKey]);

  // Cmd-hover link cursor. The native surface renders detected URLs underlined
  // and makes them Cmd-clickable (see warp_term.rs styled_run), but the embedded
  // child window has `ignoresMouseEvents: YES`, so the macOS cursor over the pane
  // is owned by the DOM — warpui can't flip it to a pointing hand. So while Cmd
  // is held we query the native link hit-test for the point under the cursor and
  // set the pane cursor ourselves. rAF-throttled; cleared the instant Cmd lifts
  // or the pointer leaves. Agent mode + native pane only — that's where links are
  // tracked (term_native_link_at returns false elsewhere).
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !nativeActive || !agentMode || !isVisible) return;
    let lastX = 0;
    let lastY = 0;
    let metaHeld = false;
    let raf = 0;
    let shown = false;
    const setCursor = (on: boolean) => {
      if (on === shown) return;
      shown = on;
      el.style.cursor = on ? "pointer" : "";
    };
    const query = () => {
      raf = 0;
      if (!metaHeld) {
        setCursor(false);
        return;
      }
      invoke<boolean>("term_native_link_at", { paneKey, x: lastX, y: lastY })
        .then((hit) => setCursor(metaHeld && hit === true))
        .catch(() => {});
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(query);
    };
    const onMove = (e: globalThis.MouseEvent) => {
      lastX = e.clientX;
      lastY = e.clientY;
      metaHeld = e.metaKey;
      if (metaHeld) schedule();
      else setCursor(false);
    };
    // Cmd pressed/released without the pointer moving still toggles the cursor —
    // re-query at the last known point.
    const onKeyToggle = (e: KeyboardEvent) => {
      metaHeld = e.metaKey;
      if (metaHeld) schedule();
      else setCursor(false);
    };
    const onLeave = () => setCursor(false);
    el.addEventListener("mousemove", onMove);
    el.addEventListener("mouseleave", onLeave);
    window.addEventListener("keydown", onKeyToggle);
    window.addEventListener("keyup", onKeyToggle);
    return () => {
      el.removeEventListener("mousemove", onMove);
      el.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("keydown", onKeyToggle);
      window.removeEventListener("keyup", onKeyToggle);
      if (raf) cancelAnimationFrame(raf);
      setCursor(false);
    };
  }, [nativeActive, agentMode, isVisible, paneKey]);

  // Report this scroll container's region (top offset within the pane + height)
  // to the native surface, so native content pins to exactly it: the shell
  // transcript sits just above the input bar, and an agent grid sits just below
  // the AgentChrome strip — never behind either. The native surface still spans
  // the whole pane; this only bounds the content. Covers shell AND agent (the top
  // offset differs); re-reports on resize and when agent mode toggles the strip.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || !nativeActive) return;
    const report = () => {
      const sr = el.getBoundingClientRect();
      const cr = containerRef.current?.getBoundingClientRect();
      const top = cr ? sr.top - cr.top : 0;
      if (sr.height > 0)
        invoke("term_native_set_viewport", { paneKey, top, height: sr.height }).catch(() => {});
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [nativeActive, agentMode, paneKey]);

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
      // The agent status strip that used to sit above the canvas was
      // removed, so there's no chrome height to reserve here anymore —
      // the agent's PTY reclaims that space and fills the pane.
      const agentChromeHeight = 0;
      // On a NATIVE agent pane the only real chrome is the AgentChrome strip:
      // the input bar is hidden and the live block is opacity:0, so reserving
      // their heights (inputChrome + liveBlockChrome) would shrink Claude's PTY
      // below the pane the native surface actually fills — leaving black space
      // above the agent. Reserve only the strip there so Claude fills the pane.
      const reserved =
        agentMode && nativeSurface
          ? agentChromeHeight
          : inputChrome + liveBlockChrome + agentChromeHeight;
      const usableHeight = Math.max(120, rect.height - reserved);
      // Match the native renderer's row pitch (LINE_HEIGHT_RATIO 1.3 in
      // warp_term.rs) on native panes so PTY rows × pitch == the painted grid
      // height and Claude lands flush against the bottom with no residual gap;
      // the WebGPU/DOM path keeps its 1.35 metric.
      const cellHeight = 13 * (nativeSurface ? 1.3 : 1.35);
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
      // Native panes use SF Mono / Menlo / Monaco, whose advance is 0.6 em
      // (7.8 px at 13 px) — measured exactly from the surface: a 90-col grid
      // left ~113 px dead in an 815 px pane (90 × 7.8 = 702). The WebGPU/DOM
      // path keeps 0.66 (its atlas-rounded JetBrains Mono cell). Using 0.66 on
      // a native pane under-counts columns and is the "dead space on the right
      // / doesn't fill the pane" report; 0.6 makes the grid fill and reflow to
      // the pane width on every sidebar / right-panel resize, like Warp.
      const cellWidth = 13 * (nativeSurface ? 0.6 : 0.66);
      const visibleRows = Math.max(8, Math.floor(usableHeight / cellHeight));
      // Warp gives a foregrounded agent the FULL terminal height on a
      // NATIVE pane — the agent's own TUI (scrollable conversation + input
      // box pinned to the bottom) fills the pane. The native surface
      // bottom-anchors the agent grid to the whole pane, so capping the PTY
      // left the agent as a short block floating at the bottom with black
      // space above it — the "claude renders half the pane / spawns broken"
      // report. So on native panes the agent gets the full viewport, exactly
      // like Warp.
      //
      // Non-native (right-panel CanvasGrid) agents keep the bounded block:
      // their canvas lives inside a scroll container tuned around the cap.
      // 17 rows leaves room for ~9 slash-command picker items above Claude's
      // ~8 rows of chrome (input box, status footer, hint, picker
      // header/footer); arrow keys scroll within the picker for the rest
      // (cap raised from 12 → 17 on main, #44).
      const AGENT_PTY_MAX_ROWS = 17;
      const rows =
        foregroundIsAgent && !nativeSurface
          ? Math.min(visibleRows, AGENT_PTY_MAX_ROWS)
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
      //
      // Native panes have NO LiveBlock padding and NO scrollbar — the grid
      // paints edge-to-edge on the Metal surface — so the 36 px canvas gutter
      // would leave ~4 columns of dead space. Use a 1-cell safety margin there
      // so the grid fills the pane (floor() already guarantees cols × advance
      // never exceeds the pane width, so the last column can't clip).
      const colGutter = nativeSurface ? 4 : 36;
      const fitCols = Math.max(20, Math.floor((rect.width - colGutter) / cellWidth));
      // In `allowHorizontalScroll` mode (the narrow right-panel
      // secondary terminal) the visual pane width is much smaller than
      // a normal terminal. If we sized the PTY to that width the shell
      // would hard-wrap every long line server-side and the DOM
      // `whiteSpace: pre` would have nothing to overflow — there'd be
      // nothing to pan. Pin a generous floor so the PTY believes it
      // has a wide terminal; the outer scroll container then handles
      // horizontal panning over the wider rendered grid.
      const PAN_MIN_COLS = 120;
      // `allowHorizontalScroll` (the narrow right-panel secondary terminal) pins
      // a wide PTY so the shell lays out as if it had a wide terminal — `ls`
      // prints columns side-by-side instead of one entry per line — and the user
      // pans to the off-screen columns. On the DOM/WebGPU path an outer scroll
      // container does the panning; on a native Metal pane the warpui renderer
      // does it (a horizontal ClippedScrollable, gated on grid-wider-than-pane,
      // fed by `term_native_hscroll` — see warp_term.rs). Either way the PTY must
      // believe it's wide, so size it the same on both paths.
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
  }, [resize, agentMode, foregroundIsAgent, allowHorizontalScroll, nativeSurface]);

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
    // Suppressed after an explicit force-kill until the next submit — see
    // forceKilledRef. Stops the dead agent's leftover banner from re-arming.
    if (forceKilledRef.current) return;
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
    // Suppressed after an explicit force-kill until the next submit — see
    // forceKilledRef. Stops the still-"claude" activeCommand from re-arming.
    if (forceKilledRef.current) return;
    if (!liveFrame?.command_running) return;
    if (!commandLineIsAgent(activeCommand)) return;
    setForegroundIsAgent(true);
  }, [
    directAgent,
    foregroundIsAgent,
    liveFrame?.command_running,
    activeCommand,
  ]);


  // Cwd ref so the Ctrl+C interrupt path can read the live worktree
  // path without forcing the byte-send callback to rebind on every cwd
  // change. Mirrors the foregroundIsAgentRef pattern.
  const cwdRef = useRef(cwd);
  useEffect(() => {
    cwdRef.current = cwd;
  }, [cwd]);

  // Memoized `onSendBytes` adapter — `sendBytes` returns a Promise but
  // the input components want a void-returning callback. Wrapping with
  // useCallback (with `sendBytes` as the only dep) keeps the reference
  // stable across renders, so the React.memo'd PromptInput +
  // PtyPassthrough don't re-render every time a PTY frame lands.
  //
  // SIDE EFFECT: when the user sends a raw ⌃C (byte 0x03) and an agent
  // is foregrounded in this pane, force-flip its hook-driven status
  // to Idle locally. Claude/Codex don't fire their Stop hook on a
  // mid-turn SIGINT — Stop is the end-of-turn signal, not the abort
  // signal. Without this, the worktree spinner keeps spinning after
  // the user interrupted the agent, because the hook event for the
  // status flip-back never arrives. Force-idle locally; the next
  // real hook event (e.g. UserPromptSubmit on the next prompt) will
  // re-set Working through the normal applyRecord path.
  const onSendBytesVoid = useCallback(
    (b: Uint8Array) => {
      if (b.length === 1 && b[0] === 0x03) {
        const path = cwdRef.current;
        if (path && foregroundIsAgentRef.current) forceIdleForCwd(path);
      }
      void sendBytes(b);
    },
    [sendBytes],
  );

  // Double-tap Ctrl+C escape hatch — see {@link decideCtrlCAction}.
  // Called by PromptInput / PtyPassthrough when the user mashes
  // Ctrl+C and a single SIGINT didn't take. The Rust side reads the
  // foreground process group via tcgetpgrp(master_fd) and SIGKILLs
  // it, bypassing whatever signal trap the running process installed.
  //
  // Always force-EVICT here (not just force-idle). A double-tap
  // escalation means the user really wants the agent dead — even if
  // it traps SIGINT, the foreground process group is about to receive
  // SIGKILL. The SessionEnd hook will never fire (the agent process
  // is killed before it can run its at-exit handler), so the only way
  // to keep the session map from accumulating a stuck "working"
  // record is to drop it locally right here. Without this, the next
  // time the user runs `claude` in this pane the stale record is
  // still there: the sidebar spinner stays on (any working session
  // counts) and the per-pane chrome can briefly show the killed
  // agent's last status before the new SessionStart record arrives.
  const onForceKill = useCallback(() => {
    const path = cwdRef.current;
    if (path) forceEvictForCwd(path);
    void termKillForeground(ptyId).catch(() => {
      // Backend may have torn the session down between the read and
      // the kill (rare race on tab close). Nothing useful to do; the
      // next Ctrl+C will start a fresh single-tap cycle anyway.
    });
    // We just killed the foreground process group — there is no
    // longer a running agent to wait for. Eagerly drop out of
    // agent mode instead of waiting for the OSC 133 D path to fire.
    // The D marker can be slow (debounced flush) or never come at
    // all (e.g. the shell's preexec/precmd hook didn't fire on a
    // SIGKILLed child), and without this the pane would sit in
    // agent mode showing the dying TUI with no PromptInput. If the
    // kill missed for any reason and the agent is still alive, the
    // banner-detect / activeCommand effects below will flip
    // agent-mode back on within a frame.
    if (exitDebounceRef.current !== null) {
      window.clearTimeout(exitDebounceRef.current);
      exitDebounceRef.current = null;
    }
    // Latch suppression + clear the state the re-detect effects feed on: the
    // dead agent's command line and the sniff accumulator. Without this, a
    // stuck-true `command_running` after the SIGKILL lets the banner sniff /
    // command-line classifier immediately re-arm agent mode from the leftover
    // grid, and the PromptInput never returns.
    forceKilledRef.current = true;
    setActiveCommand("");
    sniffBufferRef.current = "";
    setForegroundIsAgent(false);
    setTimeout(() => promptRef.current?.focus(), 0);
  }, [ptyId]);

  // Window-level Ctrl+C path (fallback for focus-drifted-to-body) has
  // its own escalation state because the window listener never runs
  // PromptInput's keydown. Keep them independent so a mash that
  // ricochets through both paths still escalates cleanly. Two
  // timestamps here (vs. one in PromptInput/PtyPassthrough) because
  // this path runs `decideSoftResetAction`, which adds a third tier
  // — three taps within RESET_WINDOW_MS → soft pane reset.
  const fallbackLastCtrlCAtRef = useRef<number | null>(null);
  const secondLastFallbackCtrlCAtRef = useRef<number | null>(null);

  const onSubmit = useCallback(
    (text: string) => {
      // A new submission re-enables agent auto-detection that a prior
      // force-kill suppressed — so re-running `claude` foregrounds again.
      forceKilledRef.current = false;
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
        // Engage agent mode OPTIMISTICALLY — we just launched a known agent,
        // so don't wait for the banner sniff / `command_running=true` edge to
        // confirm it. That edge is the source of an intermittent "claude opens
        // but the PromptInput stays / input doesn't route to the agent" failure:
        // if the OSC 133 C marker is transient or arrives in a frame the
        // classifier effect doesn't observe, agent mode never engages. Setting
        // it here makes the takeover deterministic. If the launch actually fails
        // (typo, not installed), the 1500ms exit-debounce below releases it and
        // the PromptInput returns — same self-heal as a real exit. The grid was
        // just reset, so there's no stale content to flash under the agent.
        sniffBufferRef.current = "";
        setForegroundIsAgent(true);
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

  // Click a past block's command line → lift it into the PromptInput
  // for editing. Same behavior as Warp's click-to-edit on closed
  // blocks. PromptInput's imperative `insertText` splices at the
  // current caret/selection so the user can chain or modify without
  // first clearing.
  const handleBlockClickInput = useCallback((command: string) => {
    if (!command) return;
    const handle = promptRef.current;
    if (!handle) return;
    handle.focus();
    handle.insertText(command);
  }, []);

  // Re-run a past command verbatim. Routes through onSubmit so the
  // history pruning + grid-reset paths fire the same as a typed
  // submission — re-runs end up in history and trigger the agent
  // grid reset when the command is `claude`/`codex`/`gemini`.
  const handleBlockRerun = useCallback(
    (command: string) => {
      if (!command) return;
      onSubmit(command);
    },
    [onSubmit],
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
  // by keyEncoding.test.ts; this pins the delivery path.
  //
  // Three-tier escalation, decided by `decideSoftResetAction`:
  //   1. SIGINT (write 0x03) — matches a real terminal.
  //   2. SIGKILL on the foreground process group (Rust IPC) — second
  //      press within ESCALATION_WINDOW_MS while a command is still
  //      running, for trapped-SIGINT processes (bun, dev watchers).
  //   3. Soft pane reset — third press within RESET_WINDOW_MS. Fires
  //      when the pane is wedged in a way the SIGINT/SIGKILL bytes
  //      can't fix (stale `command_running` after sleep, agent-mode
  //      stuck in the EXIT_DEBOUNCE_MS window, half-drawn frame). See
  //      {@link resetPane} for what gets cleared.
  //
  // Gates:
  //   - No text currently selected (don't compete with copy paths).
  //   - Focus is on body or non-editable (not stealing from real inputs).
  //   - This terminal was most-recently interacted with (multi-pane).
  //     Without this gate, a Ctrl+C mash in pane A would also reset
  //     pane B since both panes' listeners fire on every keydown.
  const liveCommandRunning = liveFrame?.command_running ?? false;
  const liveCommandRunningRef = useRef(liveCommandRunning);
  // Synchronous with commit (vs `useEffect`, which lags one tick).
  // The window-level Ctrl+C listener below reads through this ref —
  // if it ran on a stale `true` while the live frame had already
  // flipped to `false`, the second tap would escalate to SIGKILL on
  // a foreground pgrp that has already passed back to the shell.
  // `term_kill_foreground` has a matching server-side guard, but
  // closing the window on the client side keeps the policy honest.
  useLayoutEffect(() => {
    liveCommandRunningRef.current = liveCommandRunning;
  }, [liveCommandRunning]);

  // Soft pane reset — unstick a pane that the SIGINT/SIGKILL bytes
  // can't reach. Scoped to THIS pane only: peer panes' state, peer
  // PTYs, and the persistent scrollback (sessionMemory keyed by id)
  // are untouched. Order matters:
  //   1. SIGKILL the foreground pgrp. By the third tap the user
  //      wants the process gone; earlier taps may have been gated.
  //   2. Cancel the agent-mode exit-debounce BEFORE flipping
  //      foregroundIsAgent, so the timer can't fire stale-true back
  //      on top of our flip-to-false.
  //   3. Flip out of agent mode and clear the claude-detect sniff
  //      buffer so the next frame doesn't immediately flip back.
  //   4. Snap-to-bottom so the new prompt is visible.
  //   5. Clear all three Ctrl+C escalation refs (PromptInput,
  //      PtyPassthrough, window-fallback) so the very next keystroke
  //      is a fresh single-tap cycle, not a phantom mid-escalation.
  //   6. Force the per-cwd spinner idle so chrome reflects reality.
  //   7. Focus the prompt input — always shell mode after a reset,
  //      regardless of the prior state.
  //   8. Poke the alt-screen canvas in case its surface is alive but
  //      not painting (typical post-sleep symptom). Inline agent
  //      canvas unmounts as soon as foregroundIsAgent flips, so no
  //      ref is needed there.
  const resetPane = useCallback(() => {
    onForceKill();
    if (exitDebounceRef.current !== null) {
      window.clearTimeout(exitDebounceRef.current);
      exitDebounceRef.current = null;
    }
    setForegroundIsAgent(false);
    sniffBufferRef.current = "";
    stickToBottomRef.current = true;
    fallbackLastCtrlCAtRef.current = null;
    secondLastFallbackCtrlCAtRef.current = null;
    promptRef.current?.clearEscalation();
    passthroughRef.current?.clearEscalation();
    const path = cwdRef.current;
    if (path) forceIdleForCwd(path);
    setTimeout(() => promptRef.current?.focus(), 0);
    // Force the React-side frame pipeline to flush any pending ref
    // state into committed liveFrame, so the native surface repaints
    // from the latest cached frame rather than whatever React last
    // committed before the pipeline got stuck.
    forceResync();
  }, [onForceKill, forceResync]);

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
      const decision = decideSoftResetAction({
        now: Date.now(),
        lastCtrlCAt: fallbackLastCtrlCAtRef.current,
        secondLastCtrlCAt: secondLastFallbackCtrlCAtRef.current,
        commandRunning: liveCommandRunningRef.current,
      });
      fallbackLastCtrlCAtRef.current = decision.newLastCtrlCAt;
      secondLastFallbackCtrlCAtRef.current = decision.newSecondLastCtrlCAt;
      if (decision.action === "reset") {
        // resetPane handles its own focus restore — don't run the
        // foregroundIsAgent-based refocus below, the state it reads
        // is exactly what the reset just cleared.
        resetPane();
        return;
      }
      if (decision.action === "sigkill") {
        onForceKill();
      } else {
        // Route through onSendBytesVoid (not raw sendBytes) so the
        // shared 0x03 → forceIdleForCwd side effect fires here too.
        // The user pressed Ctrl+C via the window-level fallback —
        // exactly the same intent ("stop the running agent") as a
        // textarea-focused Ctrl+C. Without this, the spinner stays
        // on after a window-fallback interrupt.
        onSendBytesVoid(new Uint8Array([0x03]));
      }
      if (foregroundIsAgentRef.current) {
        passthroughRef.current?.focus();
      } else {
        promptRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, isVisible, onSendBytesVoid, onForceKill, resetPane]);

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
      // Rust-side pbcopy first — see clipboardWrite.ts.
      // `navigator.clipboard.writeText` fails silently in WKWebView
      // under bundled .app builds (TCC restricts the JS clipboard API
      // even though the Edit-menu copy: selector is wired up), so a
      // Cmd+C against a closed-block selection used to leave the
      // pasteboard untouched. pbcopy goes through AppKit's
      // NSPasteboard which macOS treats as a first-party copy — no
      // popup, no silent failure. Matches Warp's
      // `ctx.clipboard().write()` pattern.
      void writeClipboardTextWithFallback(text);
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
        // When this pane drives the native warpui surface, the root is
        // transparent so the Metal surface (a child window ordered
        // below the webview) shows through. Right-panel agent terminals
        // (nativeSurface=false) keep their opaque surface-0 background
        // and render entirely in the webview as before.
        backgroundColor: nativeActive ? "transparent" : "var(--surface-0)",
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
              cursor: "pointer",
            }}
          >
            restart
          </button>
        </div>
      )}

      {/* The Warp-style agent status strip ("claude is idle ✓") was
          removed — it restated what the agent's own TUI already shows
          and just ate vertical space above the pane. */}

      {/* Alt-screen TUIs (vim, htop, claude-in-alt-screen) render on the
          native Metal surface. The previous React WebGPU CanvasGrid
          alt-screen path has been retired now that the native surface
          drives all modes. */}

      {/* Unified Warp-style scroll: closed blocks + the live block
          (shell command output OR the agent's TUI) flow together in
          one scroll container. The agent is just another block in the
          stream — the whole pane scrolls as one continuous history.
          The LiveBlock body renders DOM CellRow rows; `preserveGrid`
          only switches wrapping (shell output soft-wraps, agent TUI
          stays fixed-grid). The agent surface itself is drawn natively
          (Rust/Metal). */}
      {!altScreen && (
        <div
          ref={scrollContainerRef}
          onScroll={onScrollContainerScroll}
          className={
            allowHorizontalScroll ? "goonware-no-horizontal-scrollbar" : undefined
          }
          style={{
            ...agentScrollContainerStyle(allowHorizontalScroll),
            // Shell mode with the native surface active: hide the React block
            // list / live block so the native rendering shows through the hole.
            // In agent mode (nativeActive false) this stays visible so the
            // agent's LiveBlock/CanvasGrid renders and takes input as before.
            opacity: nativeActive ? 0 : undefined,
          }}
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
              <BlockList
                blocks={blocks}
                noWrap={allowHorizontalScroll}
                onClickInput={handleBlockClickInput}
                onRerun={handleBlockRerun}
              />
            )}
            {liveFrame?.command_running && !exited && (
              <LiveBlock
                command={activeCommand}
                frame={liveFrame}
                cwd={effectiveCwd}
                // Render inline raw prompts (inquirer / fzf / wizards) on
                // the SAME fixed-grid, pane-filling surface as inline
                // agents — not the content-sized shell-output surface.
                // Two reasons: (1) these prompts position their UI by grid
                // coordinates, so grid-accurate no-wrap rendering matches
                // what they drew; (2) a content-sized block re-measures its
                // height every redraw, so as the prompt moves its cursor
                // through a menu the block grows/shrinks and the whole pane
                // jitters per keystroke. The hard 100cqh fill height pins it
                // stable — the cursor moves inside a fixed surface instead.
                preserveGrid={foregroundIsAgent || inlineRawPrompt}
                noWrap={allowHorizontalScroll}
                fill={foregroundIsAgent || inlineRawPrompt}
              />
            )}
          </div>
        </div>
      )}

      {!agentMode && effectiveCwd && (
        <TerminalStatusBar cwd={effectiveCwd} command={command} />
      )}
      {agentMode && effectiveCwd && !nativeActive && (
        // Agent-mode info strip: icon + diff + path + branch, no
        // controls. Same component as shell mode in `readonly` form —
        // share data + styling, drop the branch-switcher picker so it
        // can't fire mid-agent-session.
        //
        // Hidden when the NATIVE surface is rendering the agent (nativeActive):
        // the agent's grid bottom-anchors to the pane, and this opaque bar would
        // sit over its input row. Freeing the bottom keeps the input on-screen.
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
          historyLength={history.length}
          historyAt={historyAt}
          cwd={effectiveCwd}
          autoFocus={autoFocus}
        />
      )}
      {passthroughActive && (
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
