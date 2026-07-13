export interface TerminalSelectionState {
  collapsed: boolean;
  textLength: number;
  anchorInside: boolean;
  focusInside: boolean;
}

/**
 * Keep a drag selection only when it belongs to the terminal being clicked.
 * A selection left behind in another pane must not stop this terminal from
 * taking keyboard focus.
 */
export function shouldPreserveTerminalSelection({
  collapsed,
  textLength,
  anchorInside,
  focusInside,
}: TerminalSelectionState): boolean {
  return !collapsed && textLength > 0 && (anchorInside || focusInside);
}
