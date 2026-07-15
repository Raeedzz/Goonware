/**
 * Pure decision logic for "which input layer owns the keyboard": the
 * block-mode line editor (`PromptInput`) or the raw-forwarding textarea
 * (`PtyPassthrough`). Pulled out of `BlockTerminal` so the subtle rules
 * below stay pinned by the tests next to this file.
 *
 * The three regimes:
 *   - shell        — PromptInput; user edits a whole command line that
 *                    RLI submits on Enter. Arrow keys drive history /
 *                    cd-completion dropdowns.
 *   - inline raw   — a foreground child has put the tty into raw mode
 *                    (ICANON cleared) while running and renders inline
 *                    (no alt-screen): inquirer / `prompts` / clack
 *                    menus, fzf, password readers, etc. Every key —
 *                    arrows above all — must reach the child verbatim,
 *                    so PromptInput (which would eat arrows for its
 *                    dropdowns) is swapped for PtyPassthrough.
 *   - inline agent — claude / codex / aider rendering their own UI in
 *                    the normal screen. Same passthrough treatment.
 *   - alt-screen   — vim / htop / less. Native panes forward via
 *                    PtyPassthrough; non-native panes use CanvasGrid's
 *                    own key handler (so passthrough is NOT mounted).
 *
 * The crux — and the regression these tests guard — is that
 * `inlineRaw` is gated on `commandRunning`. The interactive shell's OWN
 * line editor (zsh ZLE, bash readline) also runs the tty raw at an idle
 * prompt, so `rawInput` is true there too. Acting on raw mode alone
 * would yank every idle shell prompt into passthrough and break normal
 * shell editing. Raw mode *while a command is running* is the signal
 * that a child — not the shell's own editor — has taken the keyboard.
 */

export interface InputModeInput {
  /** PTY has exited — all live flags are stale; force shell chrome. */
  exited: boolean;
  /** DECSET 1049 alt-screen (vim/htop/less). */
  altScreen: boolean;
  /** A foreground command is producing output (OSC 133 C↔D). */
  commandRunning: boolean;
  /** Frame's `raw_input`: tty left canonical mode or disabled local echo. */
  rawInput: boolean;
  /** A known interactive agent (claude/codex/…) is foregrounded. */
  foregroundIsAgent: boolean;
  /** This pane is backed by the in-process native surface. */
  nativeSurface: boolean;
}

export interface InputModeDecision {
  /** A child needs direct input while running, rendered inline. */
  inlineRawPrompt: boolean;
  /**
   * Hide PromptInput + the editable status bar; the running program's
   * own UI (or the live grid) owns the surface.
   */
  agentMode: boolean;
  /**
   * PtyPassthrough is the mounted input layer. Kept as one flag so the
   * JSX mount condition and the autofocus effect can't drift apart.
   */
  passthroughActive: boolean;
}

export type PromptSubmissionKind = "shell-command" | "foreground-stdin";

/**
 * Decide what Enter in the visible PromptInput means.
 *
 * While the shell is idle, the line is a new command and belongs in command
 * history / the pending block-label queue. While a foreground child is still
 * running, the exact same UI is serving a canonical interactive prompt (for
 * example `gh auth login` asking for `Y` + Enter). In that case the line is
 * stdin for the existing process and must not be mistaken for another shell
 * command. Raw/no-echo prompts never reach this path because PtyPassthrough is
 * mounted for them instead.
 */
export function classifyPromptSubmission(
  commandRunning: boolean,
): PromptSubmissionKind {
  return commandRunning ? "foreground-stdin" : "shell-command";
}

/**
 * State transition for the raw-mode latch. Prompt libraries restore
 * canonical mode briefly between questions (multi-step wizards) and some
 * toggle it per keypress; if `inlineRawPrompt` followed the raw bit
 * literally it would flicker the input layer + chrome back to shell on
 * those gaps, jittering the pane as the user navigates/selects. So once
 * a RUNNING command has gone raw even once, latch it until the command
 * ends (passthrough handles canonical input fine, so flipping back
 * mid-command buys nothing). Reset the moment the command ends, the pane
 * exits, or an alt-screen TUI takes over.
 *
 * Pure so the anti-jitter rule is pinned by a test rather than living
 * only inside a React effect.
 */
export function nextRawLatch(
  prev: boolean,
  s: Pick<
    InputModeInput,
    "exited" | "altScreen" | "commandRunning" | "rawInput"
  >,
): boolean {
  if (s.exited || s.altScreen || !s.commandRunning) return false;
  return prev || s.rawInput;
}

export function deriveInputMode(s: InputModeInput): InputModeDecision {
  const inlineRawPrompt =
    !s.exited && !s.altScreen && s.commandRunning && s.rawInput;

  const agentMode =
    !s.exited && (s.altScreen || s.foregroundIsAgent || inlineRawPrompt);

  const passthroughActive =
    (s.foregroundIsAgent && !s.altScreen) ||
    inlineRawPrompt ||
    (s.altScreen && s.nativeSurface);

  return { inlineRawPrompt, agentMode, passthroughActive };
}
