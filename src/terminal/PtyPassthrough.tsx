import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { isGlobalChord, keyToBytes } from "./keyEncoding";

export interface PtyPassthroughHandle {
  focus: () => void;
}

interface Props {
  /** Forward raw keystrokes to the PTY. */
  onSendBytes: (bytes: Uint8Array) => void;
  /**
   * DECCKM (application cursor mode). When the running program has
   * issued `ESC[?1h` (claude, vim insert mode, readline TUIs all do
   * this), arrows must be sent as `ESC O A/B/C/D` instead of the
   * default `ESC [ A/B/C/D`. Without honoring this, the agent
   * never sees the user's arrow keys.
   */
  appCursor: boolean;
  /**
   * DECSET 2004 (bracketed paste). When the running program has
   * issued `ESC[?2004h`, paste events are wrapped in
   * `ESC[200~ ... ESC[201~` so the agent reads the whole paste
   * atomically. Without this, multi-line pastes trickle in line
   * by line — the agent processes each newline as a discrete
   * input event and redraws its prompt area between each, which
   * looks like the bottom of a big prompt "loading slowly."
   */
  bracketedPaste: boolean;
  /**
   * Whether to grab focus on mount. Defaults to true — the existing
   * "open an agent and start typing" case. Set to false for secondary
   * BlockTerminals so they don't steal focus from the main column
   * on worktree switch.
   */
  autoFocus?: boolean;
}

const encoder = new TextEncoder();
const PASTE_START = encoder.encode("\x1b[200~");
const PASTE_END = encoder.encode("\x1b[201~");

/**
 * Invisible focus-trap that forwards every keystroke straight to the
 * PTY. Mounted in place of `PromptInput` when the foreground process
 * is an interactive TUI agent (claude, codex, etc.) — the agent
 * renders its own input prompt inside the live frame, so RLI's
 * textarea would only duplicate it.
 *
 * Same wire encoding as `FullGrid`'s key handler: special keys map
 * to the standard xterm escape sequences, ⌃-letter maps to its
 * control byte, plain printable chars route through `onChange` so
 * OS IME composition still works. Off-screen via fixed positioning
 * so the textarea is invisible but focusable.
 */
export const PtyPassthrough = memo(forwardRef<PtyPassthroughHandle, Props>(
  function PtyPassthrough(
    { onSendBytes, appCursor, bracketedPaste, autoFocus = true },
    ref,
  ) {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    // Set on paste; cleared on the next onChange. Lets the input
    // handler wrap the value in OSC 200/201 markers without re-reading
    // clipboard data (which the browser only exposes on the paste
    // event itself).
    const pendingPasteRef = useRef<string | null>(null);

    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
    }));

    useEffect(() => {
      if (autoFocus === false) return;
      inputRef.current?.focus();
    }, [autoFocus]);

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (isGlobalChord(e)) return;
      // Cmd+C — copy. The hidden textarea is focused (we auto-focus on
      // mount so keystrokes reach the agent) but it's empty, so the
      // browser's default Cmd+C copies nothing. Intercept and write
      // the document selection ourselves. Skipped when no selection so
      // a stray Cmd+C in agent mode doesn't blow away the clipboard.
      if (
        e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "c"
      ) {
        const sel = window.getSelection();
        const text =
          sel && !sel.isCollapsed ? sel.toString() : "";
        if (text.length > 0) {
          e.preventDefault();
          void navigator.clipboard.writeText(text).catch(() => {});
        }
        return;
      }
      // Cmd+V — paste. The browser CAN trigger onPaste on a focused
      // hidden textarea, but the off-screen 1×1 + pointer-events:none
      // textarea is brittle: in Tauri/WKWebView the paste-then-onInput
      // chain has been observed to drop the value entirely when the
      // textarea has no visible bounding box. Read the clipboard
      // explicitly and forward — same wire encoding (bracketed paste
      // markers when DECSET 2004 is on) as the onInput path below.
      if (
        e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "v"
      ) {
        e.preventDefault();
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (text.length === 0) return;
            const payload = encoder.encode(text);
            if (bracketedPaste) {
              const out = new Uint8Array(
                PASTE_START.length + payload.length + PASTE_END.length,
              );
              out.set(PASTE_START, 0);
              out.set(payload, PASTE_START.length);
              out.set(PASTE_END, PASTE_START.length + payload.length);
              onSendBytes(out);
            } else {
              onSendBytes(payload);
            }
          })
          .catch(() => {
            // Clipboard read denied / no permission — silently no-op;
            // the user will retry and notice nothing landed.
          });
        return;
      }
      const seq = keyToBytes(e, appCursor);
      if (seq) {
        e.preventDefault();
        onSendBytes(seq);
      }
    };

    const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
      // Stash the clipboard text so the upcoming onChange knows this
      // value came from a paste. We can't dispatch the bytes here
      // directly because IME / browser autocorrect can still mutate
      // the value before the textarea commits it.
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text.length === 0) return;
      pendingPasteRef.current = text;
    };

    const onInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      if (value.length === 0) return;
      const pasted = pendingPasteRef.current;
      pendingPasteRef.current = null;
      // Only wrap when (a) the agent has bracketed-paste enabled, and
      // (b) this onChange was actually triggered by a paste event
      // (string identity match rules out ordinary typing that
      // happens to contain the same characters). Wrapping a plain
      // keystroke would inject literal "\x1b[200~" into the agent's
      // input buffer, which is far worse than the perf hit we're
      // avoiding.
      if (bracketedPaste && pasted !== null && value === pasted) {
        const payload = encoder.encode(value);
        const out = new Uint8Array(
          PASTE_START.length + payload.length + PASTE_END.length,
        );
        out.set(PASTE_START, 0);
        out.set(payload, PASTE_START.length);
        out.set(PASTE_END, PASTE_START.length + payload.length);
        onSendBytes(out);
      } else {
        onSendBytes(encoder.encode(value));
      }
      e.target.value = "";
    };

    return (
      <textarea
        ref={inputRef}
        onKeyDown={onKeyDown}
        onChange={onInput}
        onPaste={onPaste}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        aria-label="Terminal input passthrough"
        style={{
          position: "absolute",
          left: -10000,
          top: -10000,
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: "none",
        }}
      />
    );
  },
));

