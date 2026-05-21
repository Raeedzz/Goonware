/**
 * Shared keyboard → PTY byte encoding. FullGrid (alt-screen),
 * PtyPassthrough (agent mode), and CanvasGrid (Phase 3 canvas
 * renderer) all use this so the wire encoding stays in lockstep.
 *
 *   - Standard xterm escape sequences for arrows / function keys.
 *   - DECCKM (`appCursor=true`) flips arrows + Home/End to SS3.
 *   - macOS Cmd+arrow / Cmd+⌫ map to readline conventions the
 *     agent's input loop understands.
 *   - Ctrl+letter encodes to its 0x01–0x1A control byte.
 *   - Plain printable chars return null so the textarea's onChange
 *     handler routes them — preserves IME composition.
 */

import type { KeyboardEvent } from "react";

const encoder = new TextEncoder();

export function keyToBytes(
  e: KeyboardEvent<HTMLTextAreaElement>,
  appCursor: boolean,
): Uint8Array | null {
  const ctrl = e.ctrlKey;
  const alt = e.altKey;
  const meta = e.metaKey;
  const csi = (c: string) => encoder.encode(`\x1b[${c}`);
  const ss3 = (c: string) => encoder.encode(`\x1bO${c}`);
  const arrow = (c: string) => (appCursor ? ss3(c) : csi(c));

  // macOS standard Cmd+navigation. Maps to readline conventions:
  //   Cmd+Left  → Ctrl+A  (beginning of line)
  //   Cmd+Right → Ctrl+E  (end of line)
  //   Cmd+Up    → Esc+<   (beginning of buffer)
  //   Cmd+Down  → Esc+>   (end of buffer)
  //   Cmd+⌫     → Ctrl+U  (kill from cursor to start of line)
  if (meta && !ctrl && !alt) {
    switch (e.key) {
      case "ArrowLeft":
        return new Uint8Array([0x01]);
      case "ArrowRight":
        return new Uint8Array([0x05]);
      case "ArrowUp":
        return encoder.encode("\x1b<");
      case "ArrowDown":
        return encoder.encode("\x1b>");
      case "Backspace":
        return new Uint8Array([0x15]);
    }
  }

  switch (e.key) {
    case "Enter":
      // Plain Enter → CR (submit). Shift+Enter → LF so claude / codex /
      // aider can distinguish "newline in prompt" from "submit". This
      // matches Warp's convention; without it, Shift+Enter is silently
      // collapsed into a submit and multi-line agent prompts are
      // impossible without typing `\` + Enter.
      return encoder.encode(e.shiftKey ? "\n" : "\r");
    case "Backspace":
      return new Uint8Array([0x7f]);
    case "Tab":
      // xterm backtab CSI (`CSI Z`) for Shift+Tab — Claude Code, fzf,
      // readline `menu-complete-backward`, vim `<S-Tab>`, and most
      // TUIs all read this. Falling through to the catch-all `return
      // null` would let the textarea swallow Shift+Tab entirely, so
      // users could never cycle modes backward in agents that use it.
      return encoder.encode(e.shiftKey ? "\x1b[Z" : "\t");
    case "Escape":
      return new Uint8Array([0x1b]);
    case "ArrowUp":
      return arrow("A");
    case "ArrowDown":
      return arrow("B");
    case "ArrowRight":
      return arrow("C");
    case "ArrowLeft":
      return arrow("D");
    case "Home":
      return arrow("H");
    case "End":
      return arrow("F");
    case "PageUp":
      return csi("5~");
    case "PageDown":
      return csi("6~");
    case "Delete":
      return csi("3~");
  }

  // Ctrl-letter (e.g. ⌃C → 0x03, ⌃D → 0x04, ⌃Z → 0x1A)
  if (ctrl && !alt && e.key.length === 1) {
    const c = e.key.toLowerCase().charCodeAt(0);
    if (c >= 97 && c <= 122) {
      return new Uint8Array([c - 96]);
    }
  }

  return null;
}

/**
 * Returns true if the keystroke is a global app chord that we must
 * NOT intercept — let it bubble to the window-level keybinding
 * handler in useKeyboardShortcuts.
 *
 * Mirrors the chord set declared there:
 *   ⌘K / ⌘F      — search overlay
 *   ⌘⇧F          — search overlay (alias)
 *   ⌘,           — settings
 *   ⌘B           — toggle sidebar
 *   ⌘\           — toggle right panel
 *   ⌘O           — open project
 *   ⌘T           — new terminal tab
 *   ⌘N           — new worktree
 *   ⌘W           — close active tab
 *   ⌘1..9        — switch to nth worktree (flat sidebar order)
 *   ⌘⇧1..9 / ⌘⌥1..9 — switch to nth project
 *
 * Digit support matters because keyToBytes doesn't encode ⌘+digit
 * today (it falls through and returns null, so the event bubbles by
 * accident). Listing digits here makes that bubble-through explicit —
 * a future PTY-side ⌘+digit binding wouldn't silently eat worktree
 * switching.
 *
 * ⌘⇧/⌘⌥ digits are also bubbled even though they fail the early
 * `!e.altKey` guard for plain meta-only chords. The `digit ||` branch
 * sees them through regardless of alt/shift state.
 */
export function isGlobalChord(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  // Digits: ⌘1..9 (and the ⌘⇧/⌘⌥ variants for project switch). Read
  // from e.code so modifier-induced char shifts (⌘⇧1 → "!") don't
  // mask the chord.
  if (/^Digit[1-9]$/.test(e.code)) return true;
  if (e.altKey) return false;
  const k = e.key.toLowerCase();
  return (
    k === "k" ||
    k === "f" ||
    k === "b" ||
    k === "n" ||
    k === "w" ||
    k === "o" ||
    k === "t" ||
    k === "," ||
    k === "\\"
  );
}
