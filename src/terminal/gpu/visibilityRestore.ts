/**
 * Pure state machine for "restore a WebGPU canvas after the keepalive
 * layer hid it." Extracted from CanvasGrid so the recovery logic can
 * be exhaustively unit-tested without spinning up React + a real GPU
 * device.
 *
 * The user-visible bug this guards against (multi-symptom):
 *
 *   - Switch to a different main-column tab (editor / diff / markdown)
 *     and come back → the agent's CanvasGrid stays black.
 *   - Switch worktrees → the terminal in the previously-active worktree
 *     paints black until the next backend frame seq lands.
 *   - Pick a model in `/model` inside Claude → the entire agent screen
 *     goes black and does not come back even on Ctrl+C.
 *   - The terminal blanks "randomly as prompts are firing" (the
 *     wrapper's autoHeightPx oscillates against zero between frames).
 *
 * Root cause (per memory observation 650): `GPUCanvasContext.configure`
 * is called once at bootstrap. When WKWebView hides the canvas via
 * `display: none`, the underlying GPU surface can be released without
 * firing `device.lost`. The next `context.getCurrentTexture()` returns
 * a texture that draws nowhere — and the canvas reads as the
 * surface-0 clear value (effectively black).
 *
 * The recovery contract this module encodes:
 *
 *   1. Hidden → visible: reconfigure the context (force WKWebView to
 *      re-acquire a live GPU surface), then resize from the wrapper's
 *      current bounding rect, then bypass seq dedupe and paint.
 *
 *   2. ResizeObserver with a 0×0 contentRect (the keepalive's
 *      display:none firing the observer) is treated as a no-op rather
 *      than pushed through `renderer.resize`. Otherwise the canvas
 *      backbuffer collapses to 1×1 physical pixels and the next show
 *      can't recover (CSS `style.width/height` were also set to ~0.5
 *      CSS px by the bad resize).
 *
 *   3. A `getCurrentTexture()` failure mid-draw is recoverable: mark
 *      the next draw as needing a reconfigure, retry. Don't surface
 *      to the user — the next paint will work.
 *
 * The module exports two pieces:
 *
 *   - `decideVisibilityAction`: pure function. Given the previous and
 *      current isVisible flags + the wrapper's current rect, decides
 *      whether to do nothing, fully reconfigure, or just paint. Tests
 *      drive this directly.
 *
 *   - `RestoreCallbacks`: an interface the React component implements
 *      to perform the actions decided above. Tests pass in a mock
 *      implementation that records what was called.
 */

export type VisibilityAction =
  /** No-op. Mount with isVisible=true, transition while already
   * hidden, or visible→hidden flip (nothing to restore yet). */
  | "noop"
  /** Full restore: reconfigure GPU surface, resize from rect, force
   * paint. Used for the hidden→visible transition. */
  | "restore"
  /** Wrapper still 0×0 even though isVisible says we're showing —
   * defer (likely landing inside the same layout tick as the
   * display: none → flex flip; the next ResizeObserver tick will
   * pick up the real rect). Caller should not call resize() on a
   * 0×0 rect. */
  | "defer";

export interface VisibilityState {
  /** `isVisible` on the previous render. */
  wasVisible: boolean;
  /** `isVisible` on the current render. */
  isVisible: boolean;
  /** Current wrapper rect dimensions in CSS pixels. */
  rectWidth: number;
  rectHeight: number;
}

/**
 * Decide what to do on a visibility-state transition. Pure function —
 * no side effects, no I/O, no DOM access. Easy to unit-test
 * exhaustively.
 *
 * Decision table:
 *
 *   | wasVisible | isVisible | rect != 0  | action  |
 *   |------------|-----------|------------|---------|
 *   | false      | false     | any        | noop    |
 *   | true       | true      | any        | noop    |
 *   | true       | false     | any        | noop    |  (we're going away — nothing to do)
 *   | false      | true      | yes        | restore |
 *   | false      | true      | no         | defer   |
 */
export function decideVisibilityAction(state: VisibilityState): VisibilityAction {
  const { wasVisible, isVisible, rectWidth, rectHeight } = state;
  // Currently hidden → no restore work; the wrapper isn't on-screen.
  if (!isVisible) return "noop";
  // Was already visible → no transition, no restore work.
  if (wasVisible) return "noop";
  // Hidden → visible transition. We need a live rect to size the GPU
  // surface against; without one, defer the restore until the next
  // ResizeObserver tick fires with real dimensions.
  if (rectWidth <= 0 || rectHeight <= 0) return "defer";
  return "restore";
}

export interface RestoreCallbacks {
  /**
   * Re-call `context.configure({device, format, alphaMode})` so
   * WKWebView re-acquires the canvas's GPU swapchain. This is what
   * unblocks `getCurrentTexture()` after a surface release.
   */
  reconfigure(): void;
  /**
   * Push the current wrapper rect into the renderer's resize path.
   * Implementations should clamp tiny values (max(1, ...)) but MUST
   * not be called with 0×0 — the `defer` action above is what guards
   * that.
   */
  resizeFromRect(width: number, height: number, dpr: number): void;
  /**
   * Force the next render to bypass seq dedupe. Without this, a
   * visibility-restore that finds the same `frame.seq` as before the
   * hide would skip the render and the user sees the (cleared-black)
   * post-restore buffer.
   */
  invalidate(): void;
  /**
   * Synchronously request a paint of the current frame. Implementations
   * typically call `r.render({...frame, ...})` against `frameRef`.
   */
  paint(): void;
}

/**
 * Execute the action decided by `decideVisibilityAction` against a
 * set of callbacks. The callback split makes the test exhaustive —
 * we can assert which callbacks fired in which order for each
 * transition.
 *
 * Ordering rationale (load-bearing):
 *   1. `reconfigure` FIRST — without a live surface, even a resize
 *      may write into a dead swapchain.
 *   2. `resizeFromRect` SECOND — sizes the new surface to the
 *      wrapper's current rect.
 *   3. `invalidate` THIRD — `resize()` typically resets `lastSeq`
 *      internally but pinning the invalidate here documents intent
 *      and survives a future resize refactor.
 *   4. `paint` LAST — fires the actual draw call.
 *
 * Reversing 1 and 2 (resize before reconfigure) is the trap: WebKit
 * will run the resize against the dead surface and either silently
 * succeed (still black) or throw (caller sees a crash).
 */
export function executeVisibilityAction(
  action: VisibilityAction,
  callbacks: RestoreCallbacks,
  rectWidth: number,
  rectHeight: number,
  dpr: number,
): void {
  if (action !== "restore") return;
  callbacks.reconfigure();
  callbacks.resizeFromRect(rectWidth, rectHeight, dpr);
  callbacks.invalidate();
  callbacks.paint();
}
