import { describe, expect, test } from "bun:test";
import {
  ESCALATION_WINDOW_MS,
  RESET_WINDOW_MS,
  decideSoftResetAction,
} from "./softReset";

/**
 * Pins the three-tier soft-reset escalation for the window-level
 * Ctrl+C fallback. The two-tier ladder (sigint → sigkill) is
 * delegated to `ctrlCEscalation.ts` and its own tests; this file
 * pins:
 *
 *   - third tap inside {@link RESET_WINDOW_MS} → "reset", regardless
 *     of `commandRunning` (by the third tap the user has decided the
 *     pane is wedged)
 *   - second tap inside {@link ESCALATION_WINDOW_MS} AND running →
 *     "sigkill" exactly as before, but the history is preserved so
 *     a third tap can fire reset
 *   - anything outside windows or with a backwards clock → "sigint"
 *   - after reset, both timestamp refs go to null so the very next
 *     keystroke is a fresh single-tap cycle (no double-fire reset)
 *
 * Regressions here would manifest as "Ctrl+C resets my working
 * terminal" (window too loose) or "Ctrl+C never brings the prompt
 * back" (window too tight, gating too strict).
 */

describe("decideSoftResetAction", () => {
  test("first press → sigint, seeds last timer only", () => {
    const r = decideSoftResetAction({
      now: 1_000,
      lastCtrlCAt: null,
      secondLastCtrlCAt: null,
      commandRunning: true,
    });
    expect(r.action).toBe("sigint");
    expect(r.newLastCtrlCAt).toBe(1_000);
    expect(r.newSecondLastCtrlCAt).toBe(null);
  });

  test("second press within escalation window AND running → sigkill, keeps history", () => {
    // Matches decideCtrlCAction's behaviour but does NOT zero the
    // timer: a third tap inside the soft-reset window must still
    // detect the 3-in-window pattern.
    const r = decideSoftResetAction({
      now: 1_500,
      lastCtrlCAt: 1_000,
      secondLastCtrlCAt: null,
      commandRunning: true,
    });
    expect(r.action).toBe("sigkill");
    expect(r.newLastCtrlCAt).toBe(1_500);
    expect(r.newSecondLastCtrlCAt).toBe(1_000);
  });

  test("second press at escalation boundary still escalates to sigkill", () => {
    const r = decideSoftResetAction({
      now: 1_000 + ESCALATION_WINDOW_MS,
      lastCtrlCAt: 1_000,
      secondLastCtrlCAt: null,
      commandRunning: true,
    });
    expect(r.action).toBe("sigkill");
  });

  test("second press one ms past escalation window → sigint", () => {
    const r = decideSoftResetAction({
      now: 1_000 + ESCALATION_WINDOW_MS + 1,
      lastCtrlCAt: 1_000,
      secondLastCtrlCAt: null,
      commandRunning: true,
    });
    expect(r.action).toBe("sigint");
  });

  test("second press without commandRunning → sigint (don't nuke a fresh prompt)", () => {
    const r = decideSoftResetAction({
      now: 1_200,
      lastCtrlCAt: 1_000,
      secondLastCtrlCAt: null,
      commandRunning: false,
    });
    expect(r.action).toBe("sigint");
  });

  test("third press with both priors inside reset window → reset, clears refs", () => {
    // 0ms, 600ms, 1200ms — all three within 2s of each other; the
    // mash that asks for the input box back.
    const r = decideSoftResetAction({
      now: 1_200,
      lastCtrlCAt: 600,
      secondLastCtrlCAt: 0,
      commandRunning: true,
    });
    expect(r.action).toBe("reset");
    expect(r.newLastCtrlCAt).toBe(null);
    expect(r.newSecondLastCtrlCAt).toBe(null);
  });

  test("third press fires reset even when commandRunning is false", () => {
    // By the third tap the user has decided the UI is wedged. If
    // commandRunning already flipped (e.g. agent died but UI is
    // stuck in agent mode), reset is still the right call.
    const r = decideSoftResetAction({
      now: 1_500,
      lastCtrlCAt: 800,
      secondLastCtrlCAt: 0,
      commandRunning: false,
    });
    expect(r.action).toBe("reset");
  });

  test("third press at reset window boundary still resets", () => {
    // Both priors exactly at the boundary — inclusive.
    const r = decideSoftResetAction({
      now: RESET_WINDOW_MS,
      lastCtrlCAt: RESET_WINDOW_MS - 1,
      secondLastCtrlCAt: 0,
      commandRunning: true,
    });
    expect(r.action).toBe("reset");
  });

  test("third press with second-prior outside reset window → no reset", () => {
    // secondLast is older than RESET_WINDOW_MS, so it's dropped:
    // effectively this looks like a 2-tap sequence inside the
    // escalation window with running → sigkill.
    const r = decideSoftResetAction({
      now: 2_500,
      lastCtrlCAt: 2_000,
      secondLastCtrlCAt: 0,
      commandRunning: true,
    });
    expect(r.action).toBe("sigkill");
    expect(r.newSecondLastCtrlCAt).toBe(2_000);
  });

  test("very next press after reset starts a fresh single-tap cycle", () => {
    // Step 1 — third tap fired reset; both refs nulled.
    let s = decideSoftResetAction({
      now: 1_200,
      lastCtrlCAt: 600,
      secondLastCtrlCAt: 0,
      commandRunning: true,
    });
    expect(s.action).toBe("reset");
    // Step 2 — next press right after. With both refs cleared, it
    // can't double-fire reset; it just sends SIGINT.
    s = decideSoftResetAction({
      now: 1_300,
      lastCtrlCAt: s.newLastCtrlCAt,
      secondLastCtrlCAt: s.newSecondLastCtrlCAt,
      commandRunning: true,
    });
    expect(s.action).toBe("sigint");
    expect(s.newLastCtrlCAt).toBe(1_300);
    expect(s.newSecondLastCtrlCAt).toBe(null);
  });

  test("slow taps (3s apart) never escalate past sigint", () => {
    let s = decideSoftResetAction({
      now: 0,
      lastCtrlCAt: null,
      secondLastCtrlCAt: null,
      commandRunning: true,
    });
    expect(s.action).toBe("sigint");
    s = decideSoftResetAction({
      now: 3_000,
      lastCtrlCAt: s.newLastCtrlCAt,
      secondLastCtrlCAt: s.newSecondLastCtrlCAt,
      commandRunning: true,
    });
    expect(s.action).toBe("sigint");
    s = decideSoftResetAction({
      now: 6_000,
      lastCtrlCAt: s.newLastCtrlCAt,
      secondLastCtrlCAt: s.newSecondLastCtrlCAt,
      commandRunning: true,
    });
    expect(s.action).toBe("sigint");
  });

  test("backwards clock jump → sigint, drops future timestamps", () => {
    // NTP correction can move Date.now() backwards. A timestamp
    // "in the future" relative to `now` must not count as a recent
    // tap — otherwise a casual press post-jump would falsely
    // escalate.
    const r = decideSoftResetAction({
      now: 500,
      lastCtrlCAt: 1_000,
      secondLastCtrlCAt: 800,
      commandRunning: true,
    });
    expect(r.action).toBe("sigint");
    expect(r.newLastCtrlCAt).toBe(500);
    expect(r.newSecondLastCtrlCAt).toBe(null);
  });

  test("full 1→2→3 mash sequence: sigint → sigkill → reset", () => {
    let s = decideSoftResetAction({
      now: 0,
      lastCtrlCAt: null,
      secondLastCtrlCAt: null,
      commandRunning: true,
    });
    expect(s.action).toBe("sigint");
    s = decideSoftResetAction({
      now: 600,
      lastCtrlCAt: s.newLastCtrlCAt,
      secondLastCtrlCAt: s.newSecondLastCtrlCAt,
      commandRunning: true,
    });
    expect(s.action).toBe("sigkill");
    s = decideSoftResetAction({
      now: 1_200,
      lastCtrlCAt: s.newLastCtrlCAt,
      secondLastCtrlCAt: s.newSecondLastCtrlCAt,
      commandRunning: true,
    });
    expect(s.action).toBe("reset");
  });
});
