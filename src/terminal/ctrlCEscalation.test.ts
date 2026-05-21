import { describe, expect, test } from "bun:test";
import {
  ESCALATION_WINDOW_MS,
  decideCtrlCAction,
} from "./ctrlCEscalation";

/**
 * Pins the double-tap-Ctrl+C escalation decision. The user-facing bug:
 * `bun run tauri:dev` traps SIGINT and ignores `^C^C^C^C^C` — the
 * terminal stays pinned to a stuck command and there's no keyboard
 * recovery. This module's contract:
 *
 *   1. First Ctrl+C always sends SIGINT — match a real terminal.
 *   2. Second Ctrl+C WITHIN {@link ESCALATION_WINDOW_MS} of the first
 *      AND while the foreground command is still running → SIGKILL
 *      on the foreground process group via the Rust IPC.
 *   3. The escalation resets the timer so a THIRD Ctrl+C starts a
 *      fresh single-tap cycle.
 *   4. Anything outside that exact window — slow taps, no command
 *      running, missing prior press — falls through to SIGINT.
 *
 * These tests fail loudly if any of those edges drift. Real-world
 * regressions here would manifest as "Ctrl+C still doesn't kill bun"
 * (escalation gate too tight) or "Ctrl+C nuked my vim session"
 * (escalation gate too loose) — neither is recoverable from the
 * user's seat.
 */

describe("decideCtrlCAction", () => {
  test("first press → sigint, seeds timer for the next call", () => {
    const r = decideCtrlCAction({
      now: 1_000,
      lastCtrlCAt: null,
      commandRunning: true,
    });
    expect(r.action).toBe("sigint");
    expect(r.newLastCtrlCAt).toBe(1_000);
  });

  test("second press within window AND running → sigkill, clears timer", () => {
    // The escape hatch the user actually feels. Pin the timer-clear
    // so the very next press doesn't re-escalate against a process
    // that's already been kill -9'd.
    const r = decideCtrlCAction({
      now: 1_500,
      lastCtrlCAt: 1_000,
      commandRunning: true,
    });
    expect(r.action).toBe("sigkill");
    expect(r.newLastCtrlCAt).toBe(0);
  });

  test("second press exactly at window boundary still escalates", () => {
    // 1000ms is in-window. The kernel can't distinguish "999ms" from
    // "1000ms" intent — both are clearly the same intent — so the
    // boundary is inclusive.
    const r = decideCtrlCAction({
      now: 1_000 + ESCALATION_WINDOW_MS,
      lastCtrlCAt: 1_000,
      commandRunning: true,
    });
    expect(r.action).toBe("sigkill");
  });

  test("second press one ms past window → sigint (not escalation)", () => {
    const r = decideCtrlCAction({
      now: 1_000 + ESCALATION_WINDOW_MS + 1,
      lastCtrlCAt: 1_000,
      commandRunning: true,
    });
    expect(r.action).toBe("sigint");
    expect(r.newLastCtrlCAt).toBe(1_000 + ESCALATION_WINDOW_MS + 1);
  });

  test("second press within window but NO command running → sigint", () => {
    // Critical safety: if the first Ctrl+C already worked and the
    // shell came back to a prompt, a quick second tap from a
    // frustrated user must NOT nuke whatever they happened to start
    // typing next.
    const r = decideCtrlCAction({
      now: 1_200,
      lastCtrlCAt: 1_000,
      commandRunning: false,
    });
    expect(r.action).toBe("sigint");
    expect(r.newLastCtrlCAt).toBe(1_200);
  });

  test("third press after escalation starts a fresh cycle (sigint, not sigkill)", () => {
    // Step 1 — first press.
    let s = decideCtrlCAction({
      now: 1_000,
      lastCtrlCAt: null,
      commandRunning: true,
    });
    expect(s.action).toBe("sigint");
    // Step 2 — second press inside the window, command still stuck.
    s = decideCtrlCAction({
      now: 1_500,
      lastCtrlCAt: s.newLastCtrlCAt === 0 ? null : s.newLastCtrlCAt,
      commandRunning: true,
    });
    expect(s.action).toBe("sigkill");
    // Step 3 — third press right after the SIGKILL fired. Even though
    // the wall-clock delta from press #2 is tiny, the timer was
    // cleared, so this read s `lastCtrlCAt === null` and starts over.
    s = decideCtrlCAction({
      now: 1_600,
      lastCtrlCAt: s.newLastCtrlCAt === 0 ? null : s.newLastCtrlCAt,
      commandRunning: true,
    });
    expect(s.action).toBe("sigint");
  });

  test("backwards clock jump (negative delta) → sigint (safe fallback)", () => {
    // Date.now() can move backwards on NTP correction. The safe
    // fallback is to treat it as a fresh first press — never escalate
    // on a clock anomaly, since the user can't have asked for it.
    const r = decideCtrlCAction({
      now: 500,
      lastCtrlCAt: 1_000,
      commandRunning: true,
    });
    expect(r.action).toBe("sigint");
    expect(r.newLastCtrlCAt).toBe(500);
  });
});
