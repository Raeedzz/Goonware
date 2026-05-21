import { describe, expect, test } from "bun:test";
import type { KeyboardEvent } from "react";
import { isGlobalChord, keyToBytes } from "./keyEncoding";

/**
 * Synthetic React.KeyboardEvent. We only set the fields keyToBytes /
 * isGlobalChord actually read — TypeScript would object to the
 * synthetic shape, hence the `as unknown as` cast at the boundary.
 */
type KeyOpts = {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

function ke(opts: KeyOpts): KeyboardEvent<HTMLTextAreaElement> {
  return {
    key: opts.key,
    code: opts.code ?? "",
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    altKey: opts.altKey ?? false,
    shiftKey: opts.shiftKey ?? false,
  } as unknown as KeyboardEvent<HTMLTextAreaElement>;
}

describe("keyToBytes — Ctrl+letter → C0 control byte", () => {
  // The PTY-interrupt path. claude / codex / shell commands all rely
  // on Ctrl+C sending 0x03 (SIGINT). A regression here means Ctrl+C
  // silently does nothing — exactly the kind of "I can't kill the
  // agent" symptom users hit hardest.
  test("Ctrl+C → [0x03]", () => {
    const bytes = keyToBytes(ke({ key: "c", ctrlKey: true }), false);
    expect(bytes).not.toBeNull();
    expect(Array.from(bytes!)).toEqual([0x03]);
  });

  test("Ctrl+Shift+C (uppercase e.key) still → [0x03]", () => {
    // Some keyboard layouts / browsers report `e.key` as "C" when
    // shift is held. toLowerCase() inside keyToBytes is the load-
    // bearing detail — pin it here so a future "simplification" to
    // `e.key.charCodeAt(0)` (which would yield 0x43, not 0x03) is
    // caught immediately.
    const bytes = keyToBytes(
      ke({ key: "C", ctrlKey: true, shiftKey: true }),
      false,
    );
    expect(bytes).not.toBeNull();
    expect(Array.from(bytes!)).toEqual([0x03]);
  });

  test("Ctrl+D → [0x04] (EOF)", () => {
    const bytes = keyToBytes(ke({ key: "d", ctrlKey: true }), false);
    expect(Array.from(bytes!)).toEqual([0x04]);
  });

  test("Ctrl+Z → [0x1A] (SIGTSTP)", () => {
    const bytes = keyToBytes(ke({ key: "z", ctrlKey: true }), false);
    expect(Array.from(bytes!)).toEqual([0x1a]);
  });

  test("Ctrl+A → [0x01] (beginning of line)", () => {
    const bytes = keyToBytes(ke({ key: "a", ctrlKey: true }), false);
    expect(Array.from(bytes!)).toEqual([0x01]);
  });

  test("Ctrl+letter is suppressed when Alt is also held", () => {
    // Ctrl+Alt+letter is reserved for keyboard layout combinations
    // (AltGr) and shouldn't collapse to a C0 byte. Return null so
    // the textarea sees the keystroke and IME can route it.
    const bytes = keyToBytes(
      ke({ key: "c", ctrlKey: true, altKey: true }),
      false,
    );
    expect(bytes).toBeNull();
  });

  test("Ctrl+digit is NOT mapped (only Ctrl+letter)", () => {
    const bytes = keyToBytes(ke({ key: "1", ctrlKey: true }), false);
    expect(bytes).toBeNull();
  });
});

describe("keyToBytes — arrows + DECCKM", () => {
  // Verifies the appCursor branch — agents flip DECCKM (ESC[?1h) and
  // arrow encoding must swap CSI → SS3 or they never see the user's
  // arrow keys. Worth pinning so the cursor mode wiring stays correct.
  test("ArrowUp with appCursor=false → ESC[A (CSI)", () => {
    const bytes = keyToBytes(ke({ key: "ArrowUp" }), false);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe("\x1b[A");
  });

  test("ArrowUp with appCursor=true → ESC O A (SS3)", () => {
    const bytes = keyToBytes(ke({ key: "ArrowUp" }), true);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe("\x1bOA");
  });
});

describe("keyToBytes — Enter / Shift+Enter", () => {
  test("Plain Enter → CR", () => {
    const bytes = keyToBytes(ke({ key: "Enter" }), false);
    expect(new TextDecoder().decode(bytes!)).toBe("\r");
  });

  test("Shift+Enter → LF (multi-line in agent prompts)", () => {
    const bytes = keyToBytes(ke({ key: "Enter", shiftKey: true }), false);
    expect(new TextDecoder().decode(bytes!)).toBe("\n");
  });
});

describe("keyToBytes — printable characters return null", () => {
  // Plain printable chars route through the textarea's onChange
  // handler so IME composition still works. keyToBytes returning
  // null is the signal "let the textarea handle this."
  test("plain 'a' → null", () => {
    expect(keyToBytes(ke({ key: "a" }), false)).toBeNull();
  });

  test("plain digit → null", () => {
    expect(keyToBytes(ke({ key: "5" }), false)).toBeNull();
  });
});

describe("isGlobalChord — Ctrl+C is NOT a global chord", () => {
  // Critical: Ctrl+C must reach the PTY-input handler in
  // PtyPassthrough / PromptInput, not bubble up to the global
  // keybinding layer. If isGlobalChord ever starts returning true
  // for Ctrl+C, the user can't interrupt a running command.
  test("Ctrl+C is intercepted (returns false)", () => {
    expect(isGlobalChord(ke({ key: "c", ctrlKey: true }))).toBe(false);
  });

  test("Cmd+C (copy) is NOT marked global either — let the OS handle it", () => {
    // Cmd+C is the macOS copy shortcut; we don't list it in
    // isGlobalChord because we WANT the browser's default copy
    // behavior to run. Returning false here means the textarea sees
    // the keystroke; keyToBytes ignores Cmd+letter so the default
    // copy semantics survive.
    expect(isGlobalChord(ke({ key: "c", metaKey: true }))).toBe(false);
  });

  test("Cmd+K is a global chord (search overlay)", () => {
    expect(isGlobalChord(ke({ key: "k", metaKey: true }))).toBe(true);
  });

  test("Cmd+1 (worktree switch) is a global chord", () => {
    expect(isGlobalChord(ke({ key: "1", metaKey: true, code: "Digit1" }))).toBe(
      true,
    );
  });
});

describe("clipboard chords — Cmd+C / Cmd+V / Cmd+X / Cmd+A all pass through", () => {
  // The user-facing regression these tests guard against:
  //   "I cannot Cmd+C / Cmd+V from the right little terminal"
  //
  // Two layers cooperate to make those chords work in shell-mode
  // panes like the right-panel side terminal:
  //
  //   1. `Menu::default(app_handle)` in `src-tauri/src/lib.rs` —
  //      installs the macOS Edit menu (cut/copy/paste/select-all)
  //      so AppKit routes ⌘C/V/X/A through the responder chain into
  //      WKWebView. That's pinned by `macos_menu_pinning_tests` on
  //      the Rust side; here we pin the JS contract that the
  //      keyboard layer doesn't reach in front of the menu.
  //
  //   2. `isGlobalChord` returns false for Cmd+C/V/X/A AND
  //      `keyToBytes` returns null for them — so the textarea
  //      handlers in PromptInput / PtyPassthrough don't swallow the
  //      keystroke. The textarea then either copies/cuts/pastes
  //      directly (when focus is on it) or the window-level
  //      BlockTerminal Cmd+C handler picks up a closed-block
  //      selection.
  //
  // If either of these two layers regresses, ⌘C/V/X/A silently
  // no-op in non-PTY inputs and the user reports it as broken.
  for (const letter of ["c", "v", "x", "a"]) {
    test(`Cmd+${letter.toUpperCase()} is NOT a global chord (textarea sees it)`, () => {
      expect(isGlobalChord(ke({ key: letter, metaKey: true }))).toBe(false);
    });

    test(`Cmd+${letter.toUpperCase()} is NOT encoded to PTY bytes (textarea native handler wins)`, () => {
      // keyToBytes returning null is the "let the textarea native
      // handler run" signal. If a future change ever started
      // encoding Cmd+letter into a PTY byte sequence, the textarea
      // would never see the chord and AppKit's cut:/copy:/paste:/
      // selectAll: selectors would never fire.
      expect(keyToBytes(ke({ key: letter, metaKey: true }), false)).toBeNull();
    });
  }

  test("Cmd+Shift+C is also not encoded (don't reroute the dev-tools chord)", () => {
    // ⌘⇧C reaches a few different roles depending on the input
    // (browser dev-tools "copy as", textarea selection copy with
    // shift held). Either way: we should not encode it into PTY
    // bytes — let the OS / textarea handle it.
    expect(
      keyToBytes(ke({ key: "C", metaKey: true, shiftKey: true }), false),
    ).toBeNull();
  });

  // Additional edge-case coverage for the clipboard chord contract.
  // The regression in 0.0.22/0.0.23 was not about encoding — it was
  // about handler ordering and `preventDefault()` placement — but a
  // future "simplification" that flattens these guards could easily
  // recreate the symptom. Each test below pins one specific case
  // that, if it ever started returning non-null, would silently
  // break Cmd+C/V/X/A somewhere in the app.
  describe("uppercase + caps-lock variants pass through", () => {
    // Some keyboard layouts and OS configurations report Cmd+C as
    // `e.key === "C"` (uppercase) when caps-lock is engaged. The
    // textarea and OS handle that fine, but if our `toLowerCase()`
    // call ever moved up the call chain in a way that changed the
    // switch-on-key behavior, uppercase variants could silently fall
    // into a different branch. Pin the pass-through.
    for (const letter of ["C", "V", "X", "A"]) {
      test(`Cmd+${letter} (uppercase) is not encoded`, () => {
        expect(keyToBytes(ke({ key: letter, metaKey: true }), false)).toBeNull();
      });
    }
  });

  describe("Cmd+Z (undo) and Cmd+Shift+Z (redo) pass through", () => {
    // Both are part of the standard macOS Edit menu (undo + redo via
    // PredefinedMenuItem). Treat them with the same care as Cmd+C/V
    // because the same `Menu::default(app)` path wires them in. If
    // keyToBytes ever encoded Cmd+Z to a PTY byte, the textarea's
    // undo-stack would lock up.
    test("Cmd+Z is not encoded", () => {
      expect(keyToBytes(ke({ key: "z", metaKey: true }), false)).toBeNull();
    });
    test("Cmd+Shift+Z is not encoded", () => {
      expect(
        keyToBytes(ke({ key: "z", metaKey: true, shiftKey: true }), false),
      ).toBeNull();
    });
    test("Cmd+Z and Cmd+Shift+Z are not flagged as global chords", () => {
      // The textarea's native undo path needs the keystroke to reach
      // it — bubbling to useKeyboardShortcuts would steal it.
      expect(isGlobalChord(ke({ key: "z", metaKey: true }))).toBe(false);
      expect(
        isGlobalChord(ke({ key: "z", metaKey: true, shiftKey: true })),
      ).toBe(false);
    });
  });

  describe("Cmd-only modifier does NOT collide with Ctrl-letter encoding", () => {
    // The PTY-byte encoding for Ctrl+letter (line 86-91 in
    // keyEncoding.ts) gates on `ctrl && !alt`. It would be very easy
    // for a refactor to drop the `!meta` implicit guard (the meta
    // case is handled earlier and returns) and start encoding
    // Cmd+letter as if it were Ctrl+letter — that would send 0x03
    // to the PTY on Cmd+C, blowing away the clipboard chord. Pin
    // that Cmd-only (no Ctrl) on letter keys returns null.
    for (const letter of ["c", "v", "x", "a", "z"]) {
      test(`Cmd+${letter.toUpperCase()} with ctrlKey=false is not encoded`, () => {
        expect(
          keyToBytes(
            ke({ key: letter, metaKey: true, ctrlKey: false }),
            false,
          ),
        ).toBeNull();
      });
    }
  });

  describe("Ctrl+V on macOS still encodes to PTY (literal-next-char)", () => {
    // Ctrl+V in Unix terminals is "insert next char verbatim" — the
    // PTY needs to see 0x16 for vim, less, and shell line editors to
    // handle it correctly. macOS clipboard paste is Cmd+V, NOT
    // Ctrl+V. We must keep encoding Ctrl+V → 0x16 so the terminal
    // experience matches every other terminal app. If a future
    // change broadens "don't encode Ctrl+letter on macOS" — to fix
    // a non-existent paste issue, say — it would break literal-next
    // in every TUI we ship with.
    test("Ctrl+V → [0x16] (literal next char in terminals)", () => {
      const bytes = keyToBytes(ke({ key: "v", ctrlKey: true }), false);
      expect(bytes).not.toBeNull();
      expect(Array.from(bytes!)).toEqual([0x16]);
    });
  });
});
