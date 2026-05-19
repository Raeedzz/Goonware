/**
 * Terminal focus registry.
 *
 * Module-scoped lookup table mapping a terminal tab id → a focus
 * function. Each `BlockTerminal` instance registers its focus fn on
 * mount and unregisters on unmount. The `useFocusActiveTerminal` hook
 * looks up the active worktree's primary terminal tab id and calls
 * its focus fn whenever the active worktree changes — so switching
 * worktrees in the sidebar always lands keyboard input on the main
 * terminal, never on a leftover focus target (the right panel, a
 * secondary terminal, the URL bar, etc.).
 *
 * The registered function is responsible for choosing the correct
 * inner element to focus (PromptInput textarea when the foreground is
 * a shell, the PtyPassthrough invisible input when it's an interactive
 * agent). The registry doesn't know or care about that — it just calls
 * the function.
 *
 * The fn is registered ONCE per BlockTerminal mount (keyed by tab id)
 * even though the foreground-agent state flips frequently; BlockTerminal
 * keeps a ref to the current foreground state so the same registered
 * closure reads the latest value without re-registering on every flip.
 */

const registry = new Map<string, () => void>();

/**
 * Tab id of the BlockTerminal the user most recently interacted with
 * (mouseDown anywhere in its container). Used by the window-level
 * Ctrl+C fallback in BlockTerminal so multi-pane setups don't dispatch
 * 0x03 to every visible PTY at once when focus has drifted to
 * `document.body` (e.g. after a drag-selection in a closed block).
 */
let lastInteractedTabId: string | null = null;

export function registerTerminalFocus(tabId: string, fn: () => void): void {
  registry.set(tabId, fn);
}

export function unregisterTerminalFocus(tabId: string): void {
  registry.delete(tabId);
  if (lastInteractedTabId === tabId) lastInteractedTabId = null;
}

export function markTerminalInteracted(tabId: string): void {
  lastInteractedTabId = tabId;
}

export function getLastInteractedTerminal(): string | null {
  return lastInteractedTabId;
}

/**
 * Try to focus the registered terminal. Returns true if a focus
 * function was registered and ran without throwing. Returns false if
 * no entry exists for this tab id — caller can choose to retry on
 * a later tick (the BlockTerminal may still be mounting).
 */
export function focusTerminal(tabId: string): boolean {
  const fn = registry.get(tabId);
  if (!fn) return false;
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}
