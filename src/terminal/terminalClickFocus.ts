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

export interface FocusableTerminalInput {
  focus: () => void;
}

/**
 * Focus the input layer that should own the terminal, with a mounted-layer
 * fallback for the exact render/effect boundary where mode flags and refs can
 * temporarily disagree. Returns the layer used so races are testable.
 */
export function focusTerminalInputLayer({
  passthroughPreferred,
  passthrough,
  prompt,
}: {
  passthroughPreferred: boolean;
  passthrough: FocusableTerminalInput | null;
  prompt: FocusableTerminalInput | null;
}): "passthrough" | "prompt" | null {
  if (passthroughPreferred && passthrough) {
    passthrough.focus();
    return "passthrough";
  }
  if (prompt) {
    prompt.focus();
    return "prompt";
  }
  if (passthrough) {
    passthrough.focus();
    return "passthrough";
  }
  return null;
}
