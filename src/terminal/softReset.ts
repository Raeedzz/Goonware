/**
 * Soft-reset escalation: the window-level Ctrl+C ladder with a third
 * tier on top of {@link decideCtrlCAction}.
 *
 * The textarea-focused paths still use the two-tier ladder in
 * `ctrlCEscalation.ts` — when focus is on the prompt or the agent
 * passthrough, things are working and SIGINT/SIGKILL are enough. The
 * window-level fallback is the only path that fires when the pane is
 * already stuck (focus on document.body, partial render, stale state
 * from sleep/wake), and that's where users mash Ctrl+C asking for
 * "just give me the prompt back." Third tap inside
 * {@link RESET_WINDOW_MS} → "reset" — caller drops agent mode, clears
 * escalation refs across the pane, refocuses the prompt, and pokes
 * the renderer. Other panes and the PTY child process are untouched.
 *
 * The window is wider than {@link ESCALATION_WINDOW_MS} (1000 ms) so
 * a 1→2→3 mash that hits SIGINT at t=0, SIGKILL at t≈600, and reset
 * at t≈1200 lands all three. Too short and a frustrated mash can't
 * keep up; too long and a casual ^C-pause-^C-pause-^C accidentally
 * resets a working pane.
 */

import { ESCALATION_WINDOW_MS } from "./ctrlCEscalation";

export { ESCALATION_WINDOW_MS };

export const RESET_WINDOW_MS = 2000;

export type SoftResetAction = "sigint" | "sigkill" | "reset";

export interface SoftResetDecision {
  /** What the caller should do RIGHT NOW for this keystroke. */
  action: SoftResetAction;
  /** Most-recent Ctrl+C timestamp for the next call's `lastCtrlCAt`. */
  newLastCtrlCAt: number | null;
  /** Second-most-recent Ctrl+C timestamp for the next call's `secondLastCtrlCAt`. */
  newSecondLastCtrlCAt: number | null;
}

/**
 * Decide whether this Ctrl+C should send SIGINT, escalate to SIGKILL
 * on the foreground process group, or trigger a soft pane reset.
 *
 * Inputs are timestamp-only so the function stays pure — every dep is
 * explicit, no React/clock side effects. Caller threads
 * `newLastCtrlCAt` and `newSecondLastCtrlCAt` into ref state for the
 * next call.
 *
 * Tier gates:
 *   1. `"reset"` — both prior taps land inside {@link RESET_WINDOW_MS}
 *      of `now` (so all three pressed within ~2 s). Fires regardless
 *      of `commandRunning`: by the third tap the user has decided the
 *      pane is wedged and they want the UI back; the prior taps
 *      already sent SIGINT/SIGKILL.
 *   2. `"sigkill"` — exactly one prior tap inside
 *      {@link ESCALATION_WINDOW_MS} AND `commandRunning === true`.
 *      Matches {@link decideCtrlCAction}'s two-tier behaviour.
 *   3. `"sigint"` — every other case, including backwards clock
 *      jumps (timestamps in the future are dropped, never escalate
 *      against them).
 */
export function decideSoftResetAction(opts: {
  now: number;
  lastCtrlCAt: number | null;
  secondLastCtrlCAt: number | null;
  commandRunning: boolean;
}): SoftResetDecision {
  const { now, lastCtrlCAt, secondLastCtrlCAt, commandRunning } = opts;

  // Recency check: drop timestamps that are in the future (backwards
  // clock jump) or outside the soft-reset window.
  const recent = (t: number | null): number | null => {
    if (t === null) return null;
    if (t > now) return null;
    if (now - t > RESET_WINDOW_MS) return null;
    return t;
  };

  const lastRecent = recent(lastCtrlCAt);
  const secondLastRecent = recent(secondLastCtrlCAt);

  // Third tap inside the soft-reset window → reset. Clear both
  // timestamps so the next press is a fresh single-tap cycle.
  if (lastRecent !== null && secondLastRecent !== null) {
    return {
      action: "reset",
      newLastCtrlCAt: null,
      newSecondLastCtrlCAt: null,
    };
  }

  // Second tap inside the (tighter) escalation window AND the
  // foreground command is still running → SIGKILL the pgrp. Keep the
  // history so a third tap inside the soft-reset window can still
  // escalate to reset.
  if (
    lastRecent !== null &&
    now - lastRecent <= ESCALATION_WINDOW_MS &&
    commandRunning
  ) {
    return {
      action: "sigkill",
      newLastCtrlCAt: now,
      newSecondLastCtrlCAt: lastRecent,
    };
  }

  // Default: SIGINT. Slide the window forward — drop the oldest
  // timestamp, promote `last` to `secondLast`, record `now` as
  // `last`. `lastRecent` (not raw `lastCtrlCAt`) is intentional: if
  // the previous tap is already older than the soft-reset window,
  // we'd never reach 3-in-window anyway, so don't carry it.
  return {
    action: "sigint",
    newLastCtrlCAt: now,
    newSecondLastCtrlCAt: lastRecent,
  };
}
