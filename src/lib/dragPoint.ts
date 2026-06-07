/**
 * Normalize a Tauri drag-drop `position` to CSS (logical) pixels —
 * the space `getBoundingClientRect()` and `elementFromPoint()` use.
 *
 * Tauri types the drag-drop position as `PhysicalPosition`, but on
 * macOS (wry) the values are actually LOGICAL points: AppKit's
 * `NSEvent` drag locations are in points, not backing-store pixels.
 * Blindly dividing by `devicePixelRatio` — correct for true physical
 * pixels — therefore HALVES the coordinates on a Retina display, so a
 * drop on the right-hand file tree lands ~2× to the left, inside the
 * center terminal. That single bug made every file-tree drop fall
 * through to the terminal and made both panes highlight at once.
 *
 * We only scale down when the values clearly overshoot the logical
 * viewport — i.e. a genuine physical-pixel report — so this stays
 * correct on the off chance Tauri reports physical pixels somewhere.
 * Drag-drop hit-testing in BOTH the file tree and the terminal routes
 * through here so the two panes share one coordinate space and stay
 * mutually exclusive.
 */
export function toLogicalDragPoint(
  x: number,
  y: number,
): { x: number; y: number } {
  const dpr = window.devicePixelRatio || 1;
  if (dpr !== 1 && (x > window.innerWidth + 1 || y > window.innerHeight + 1)) {
    return { x: x / dpr, y: y / dpr };
  }
  return { x, y };
}
