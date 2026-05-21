/**
 * Double-tap-Ctrl+C escalation decision.
 *
 * Real terminals just write 0x03 to the PTY and let the kernel deliver
 * SIGINT to the foreground process group. That works for ~95% of
 * commands. The other 5% — `bun run`, some node/python dev servers,
 * certain build watchers — install a SIGINT handler that traps the
 * signal and then waits for child cleanup that never completes. The
 * user pressing Ctrl+C five times in a row just produces `^C^C^C^C^C`
 * in the output and the job stays stuck. The terminal is the user's
 * primary interface — it has to be killable.
 *
 * The escape hatch: a SECOND Ctrl+C within {@link ESCALATION_WINDOW_MS}
 * of the first, while the foreground command is still running,
 * escalates to `term_kill_foreground` — a Rust IPC that reads the
 * foreground process group via `tcgetpgrp(master_fd)` and sends
 * SIGKILL directly via `kill(-pgrp, SIGKILL)`. SIGKILL cannot be
 * caught, blocked, or ignored, so trapped-SIGINT processes die
 * immediately.
 *
 * Single-press behaviour stays identical to a real terminal: just
 * send 0x03. Programs that legitimately handle SIGINT for cleanup
 * (vim's "save changes?", agents committing partial state, etc.) get
 * the polite shutdown they'd get anywhere else. Only the user
 * deliberately pressing Ctrl+C twice in rapid succession asks for
 * the nuclear path.
 *
 * The window has to be long enough that a frustrated user's natural
 * double-press lands inside it (people don't time keystrokes to the
 * millisecond), but short enough that a casual one-key-per-second
 * tapping rhythm doesn't escalate by accident. 1000 ms threads that
 * needle and matches Warp's published value.
 */

export const ESCALATION_WINDOW_MS = 1000;

export type CtrlCAction = "sigint" | "sigkill";

export interface CtrlCDecision {
  /** What the caller should do RIGHT NOW for this keystroke. */
  action: CtrlCAction;
  /** Timestamp to seed the next call's `lastCtrlCAt`. */
  newLastCtrlCAt: number;
}

/**
 * Decide whether this Ctrl+C should send a normal SIGINT (write 0x03
 * to the PTY) or escalate to SIGKILL on the foreground process group.
 *
 * Inputs are timestamp-only so the function stays pure — every dep
 * is explicit, no React/clock side effects. Caller is responsible for
 * threading `newLastCtrlCAt` into ref state for the next call.
 *
 * Escalation gate (all three must hold):
 *   1. There was a previous Ctrl+C (`lastCtrlCAt !== null`).
 *   2. It landed within {@link ESCALATION_WINDOW_MS} of `now`.
 *   3. The terminal still reports a foreground command running
 *      (`commandRunning === true`). If the first Ctrl+C already
 *      worked and the prompt returned, we don't want to nuke
 *      whatever the user just started.
 *
 * Returning `"sigint"` is the default safe path — any unexpected
 * condition (clock jumped backwards, command_running flipped just
 * before the second press, etc.) falls through to SIGINT.
 */
export function decideCtrlCAction(opts: {
  now: number;
  lastCtrlCAt: number | null;
  commandRunning: boolean;
}): CtrlCDecision {
  const { now, lastCtrlCAt, commandRunning } = opts;
  if (lastCtrlCAt === null || !commandRunning) {
    return { action: "sigint", newLastCtrlCAt: now };
  }
  const delta = now - lastCtrlCAt;
  if (delta >= 0 && delta <= ESCALATION_WINDOW_MS) {
    // Reset the timer to null so a THIRD Ctrl+C right after the kill
    // doesn't re-escalate — the kill already fired, the process is
    // either dead or about to be, and the next press should start a
    // fresh single-tap SIGINT cycle for whatever's running next.
    return { action: "sigkill", newLastCtrlCAt: 0 };
  }
  return { action: "sigint", newLastCtrlCAt: now };
}
