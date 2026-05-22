/**
 * Pure state machine for the CanvasGrid "open Claude → solid black,
 * never recovers" escalation. Extracted from CanvasGrid so the decision
 * logic can be exhaustively unit-tested without spinning up React +
 * timers + a real GPU device.
 *
 * Lives parallel to `gpu/visibilityRestore.ts` — that module handles
 * the hidden↔visible transition recovery; this one handles the
 * "freshly-mounted canvas is dead from the start" case the user sees
 * as "the entire agent block is black until I Ctrl+C."
 *
 * The user-visible bug this exists to defeat:
 *
 *   - User runs `claude` in a terminal pane.
 *   - `agentMode` flips on, `LiveBlock` switches `preserveGrid` → true,
 *     a fresh `CanvasGrid` mounts inside it.
 *   - WKWebView hands back a GPU surface that paints into the void.
 *     The renderer thinks it submitted a frame; no pixels reach the
 *     screen. No `device.lost`, no thrown error, nothing to hook.
 *   - The existing recovery (soft warmups at 50/200/500/1200 ms +
 *     ONE hard rebuild at 2500 ms) tries to fix it. If that single
 *     rebuild also lands on a dead surface, the user is stuck on
 *     black indefinitely. No further escalation. Killing the agent
 *     unmounts the canvas — that's the only way out.
 *
 * The contract this module encodes:
 *
 *   At each timer fire on the escalation ladder, decide whether to
 *   stop escalating (canvas is healthy), trigger another rebuild
 *   (still apparently dead), or give up entirely (we've spent our
 *   recovery budget and should fall back to DOM rendering).
 *
 * The signal: `GridRenderer.successfulDrawCount` — cumulative frames
 * the renderer has successfully submitted to the GPU. A canvas with
 * count > 0 has demonstrably painted; one stuck at 0 has not. After
 * a rebuild the new renderer's count starts at 0 again, so each
 * check independently asks "has THIS renderer instance ever painted
 * a frame?" without needing to carry baseline state.
 */

export type EscalationDecision = "stop" | "escalate" | "give-up";

export interface EscalationState {
  /**
   * 0-indexed count of rebuilds already attempted on this CanvasGrid
   * mount. The decision is being made for whether to start attempt
   * number `attempt` (so attempt=0 means we're considering the FIRST
   * rebuild). Caller increments after a decision of "escalate".
   */
  attempt: number;
  /**
   * `GridRenderer.successfulDrawCount` on the current renderer
   * instance. After a rebuild this resets to 0 implicitly (new
   * renderer, fresh counter). Reads any positive value as "the canvas
   * is painting" — that's the proof of life this ladder needs.
   */
  currentDrawCount: number;
  /**
   * Tab-level visibility from the keepalive layer. A hidden canvas
   * can't be expected to paint — the WKWebView surface is alive
   * (kept that way by `visibility: hidden`) but no compositor cycles
   * touch it. Escalating here would burn rebuilds against a
   * structurally-quiet pane.
   */
  isVisible: boolean;
  /**
   * Whether the CanvasGrid has a frame to render. If `frame` is null
   * (initial mount before the first PTY frame arrives), zero paints
   * is the correct steady state — escalating would rebuild against
   * a renderer that simply has no input yet.
   */
  hasFrame: boolean;
  /**
   * Hard cap on rebuild attempts. Once `attempt >= maxAttempts` and
   * the canvas still hasn't drawn, the answer is "give-up" — the
   * caller should flip to the DOM fallback so the user sees text.
   */
  maxAttempts: number;
}

/**
 * Decide what the escalation ladder should do at this tick.
 *
 *   - "stop"      — canvas is painting (or can't be expected to;
 *                   hidden, or no frame). Don't escalate further.
 *   - "escalate"  — bump rendererEpoch and try a fresh adapter +
 *                   device + context.
 *   - "give-up"   — recovery budget exhausted. Signal the parent to
 *                   swap this block to the DOM rendering fallback.
 *
 * Decision table (rows in evaluation order):
 *
 *   | painted? | hasFrame | isVisible | attempt<max | result      |
 *   |----------|----------|-----------|-------------|-------------|
 *   | yes      | any      | any       | any         | stop        |
 *   | no       | no       | any       | any         | stop        |
 *   | no       | yes      | no        | any         | stop        |
 *   | no       | yes      | yes       | yes         | escalate    |
 *   | no       | yes      | yes       | no          | give-up     |
 */
export function decideEscalation(state: EscalationState): EscalationDecision {
  if (state.currentDrawCount > 0) return "stop";
  if (!state.hasFrame) return "stop";
  if (!state.isVisible) return "stop";
  if (state.attempt >= state.maxAttempts) return "give-up";
  return "escalate";
}

/**
 * Delays (in ms, from CanvasGrid mount) at which each escalation
 * tick fires. Chosen so:
 *
 *   - 2500 ms — the first check is AFTER the existing soft warmups
 *     (50/200/500/1200) have had a chance to recover. Anything still
 *     dead at this point will not be saved by another reconfigure.
 *   - 5000, 10000, 20000 ms — back off so a slow-but-eventually-
 *     working GPU bootstrap (e.g. font load takes longer than usual)
 *     isn't dismantled before it gets a chance.
 *
 * Hitting all four means the canvas has been black for 20 seconds —
 * well past the user's patience threshold — and the DOM fallback
 * should engage at the next decision.
 */
export const ESCALATION_DELAYS_MS = [2500, 5000, 10000, 20000] as const;

/**
 * Hard cap on rebuild attempts before the give-up decision fires.
 * Matches `ESCALATION_DELAYS_MS.length` so each scheduled tick maps
 * to one rebuild attempt. After the 4th tick escalates,
 * `rebuildAttemptRef` reaches MAX and the subsequent give-up timer
 * fires the DOM fallback.
 */
export const MAX_REBUILD_ATTEMPTS = ESCALATION_DELAYS_MS.length;

/**
 * Absolute delay (from CanvasGrid mount) at which the give-up timer
 * fires. Past every escalation tick so by then either the canvas has
 * painted (timer is a no-op) or all 4 rebuild attempts have been
 * spent (timer fires the DOM fallback). 5 s past the last escalation
 * tick — long enough to let the final rebuild actually try to paint,
 * short enough that the user isn't staring at black for an
 * unreasonable extra interval.
 */
export const LADDER_GIVE_UP_MS = 25000;

/**
 * Retry delays (in ms) for `createGridRenderer` bootstrap failures.
 * Layered separately from the rebuild escalation because the failure
 * modes are different: bootstrap failures (adapter null, device
 * creation throws) need fast retries on the theory that the
 * underlying transient resolves quickly. Rebuilds are gated on a
 * surface that's silently-dead-but-API-healthy, where the slower
 * cadence avoids thrashing the GPU.
 *
 * Each timer fires sequentially — schedule retry N+1 only if retry
 * N also failed.
 */
export const BOOTSTRAP_RETRY_DELAYS_MS = [500, 1500, 4000] as const;
