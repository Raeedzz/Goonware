import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { system } from "@/lib/fs";
import { shellQuotePath } from "@/lib/shellQuote";
import { writeClipboardTextWithFallback } from "./clipboardWrite";
import { readClipboardTextWithFallback } from "./clipboardRead";
import { isGlobalChord, keyToBytes } from "./keyEncoding";
import { decideCtrlCAction } from "./ctrlCEscalation";

export interface PtyPassthroughHandle {
  focus: () => void;
  /**
   * Drop the double-tap Ctrl+C escalation timestamp so the next press
   * is a fresh single-tap cycle. See PromptInputHandle.clearEscalation —
   * BlockTerminal's soft-reset calls all three paths' clearEscalation
   * so a stale timestamp in any one of them can't misfire SIGKILL on
   * the very next keystroke.
   */
  clearEscalation: () => void;
}

interface Props {
  /** Forward raw keystrokes to the PTY. */
  onSendBytes: (bytes: Uint8Array) => void;
  /**
   * Double-tap Ctrl+C escape hatch — see PromptInput's Props for the
   * full rationale. Required here because alt-screen agents (claude,
   * vim, htop) route every keystroke through this textarea, including
   * the user's "kill the stuck thing" mash.
   */
  onForceKill: () => void;
  /** True while a foreground command is running (OSC 133 C…D). */
  commandRunning: boolean;
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
 *
 * Crucially, this component does NOT render its own slash-command
 * picker. Warp's host-side picker is for Warp's own proprietary
 * agent; for third-party CLI agents (Claude Code, Codex, Gemini)
 * Warp passes `/` straight through and the agent renders its own
 * picker inside its TUI. We do the same — Claude's `/` menu is the
 * source of truth for slash commands, with its own keyboard nav and
 * fuzzy filter.
 */
export const PtyPassthrough = memo(forwardRef<PtyPassthroughHandle, Props>(
  function PtyPassthrough(
    {
      onSendBytes,
      onForceKill,
      commandRunning,
      appCursor,
      bracketedPaste,
      autoFocus = true,
    },
    ref,
  ) {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    // Mirror of PromptInput's escalation state. Agent-mode terminals
    // (claude, codex, vim, htop) all funnel through this textarea, so
    // a stuck agent gets the same double-tap-Ctrl+C escape as a shell.
    const lastCtrlCAtRef = useRef<number | null>(null);
    // Set on paste; cleared on the next onChange. Lets the input
    // handler wrap the value in OSC 200/201 markers without re-reading
    // clipboard data (which the browser only exposes on the paste
    // event itself).
    const pendingPasteRef = useRef<string | null>(null);
    // Count of spaces dispatched early in onKeyDown (see below).
    // onInput strips that many leading spaces from whatever the browser
    // inserted to avoid double-sending them, since WKWebView still fires
    // the input event even when we return early from onKeyDown.
    const spacePreSentRef = useRef(0);

    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
      clearEscalation: () => {
        lastCtrlCAtRef.current = null;
      },
    }));

    /**
     * Forward a string to the PTY using the same wire encoding the
     * Cmd+V branch and the onInput branch both want: bracketed-paste
     * markers when the running program has issued DECSET 2004, plain
     * bytes otherwise. Centralizing the encoding keeps the image-paste
     * and text-paste branches from drifting apart.
     */
    const sendPasteText = (text: string) => {
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
    };

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
          // Rust-side pbcopy first — see clipboardWrite.ts. WKWebView's
          // navigator.clipboard.writeText fails silently in bundled
          // .app builds, so the previous direct call left the
          // pasteboard unchanged.
          void writeClipboardTextWithFallback(text);
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
      //
      // Accept both ⌘V (macOS native) and ⌃V (Windows/Linux muscle
      // memory). Without the Ctrl branch, ⌃V falls through to
      // keyToBytes and gets encoded as 0x16, which is useless to
      // every agent TUI we ship.
      //
      // Image paste: we used to call `navigator.clipboard.read()` here
      // to grab raw image bytes for /tmp spooling. That call fires the
      // macOS "Apps want to read your clipboard" TCC popup — the
      // "weird paste popup that shouldn't show up" users complained
      // about. The Rust-side `system_clipboard_save_image_to_temp`
      // path now handles screenshot pastes via NSPasteboard's PNG
      // pasteboard type, which AppKit serves without a TCC prompt
      // (first-party paste). Same UX (screenshot in, /tmp path out)
      // with zero popup surface.
      if (
        ((e.metaKey && !e.ctrlKey) || (e.ctrlKey && !e.metaKey)) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "v"
      ) {
        e.preventDefault();
        void (async () => {
          // Image branch first: ask Rust to peek at the pasteboard
          // for an image item and spool it. If there's no image, the
          // command returns null and we drop to the text fallback —
          // all without a single WebKit clipboard-read call.
          try {
            const path = await system.saveClipboardImageToTemp();
            if (path) {
              sendPasteText(`${shellQuotePath(path)} `);
              return;
            }
          } catch {
            // IPC bridge unavailable — fall through to text.
          }
          // Text branch — pbpaste first, WebKit only as a last
          // resort on non-Tauri hosts. See clipboardRead.ts.
          const text = await readClipboardTextWithFallback();
          if (text === null || text.length === 0) return;
          sendPasteText(text);
        })();
        return;
      }
      // ⌃C escalation — agent TUIs (claude, codex, aider) sometimes
      // trap SIGINT to wind down a turn, and the same trapped-SIGINT
      // stall the shell-mode handler covers can pin an agent here
      // too. A second Ctrl+C within ESCALATION_WINDOW_MS asks the
      // backend to SIGKILL the foreground process group instead.
      if (
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "c"
      ) {
        const decision = decideCtrlCAction({
          now: Date.now(),
          lastCtrlCAt: lastCtrlCAtRef.current,
          // Read the prop directly — `onKeyDown` is recreated on every
          // render, so it closes over the freshest `commandRunning`.
          // Mirroring into a ref via useEffect lagged one tick behind
          // the prop, which let a Ctrl+C arriving between commit and
          // effect escalate to SIGKILL on a process group whose
          // foreground had already passed back to the shell. See
          // term_kill_foreground for the matching server-side guard.
          commandRunning,
        });
        lastCtrlCAtRef.current =
          decision.newLastCtrlCAt === 0 ? null : decision.newLastCtrlCAt;
        if (decision.action === "sigkill") {
          e.preventDefault();
          onForceKill();
          return;
        }
        // SIGINT path falls through to keyToBytes below so the byte
        // (0x03) lands on the PTY through the normal encoding.
      }
      // Space: dispatch at keydown time so the byte reaches the agent
      // before WKWebView's word-boundary text processing delays the
      // input event. Without this, space arrives a few ms late relative
      // to other printable chars — enough to miss the agent's current
      // render cycle — causing the cursor to appear frozen until the
      // next character triggers a redraw. We intentionally do NOT call
      // preventDefault: WKWebView fires input anyway (ignoring it for
      // space), and omitting it lets the browser insert the space
      // normally so onInput can strip it and avoid double-sending.
      // The isComposing guard preserves CJK IME where space confirms a
      // character selection rather than inserting 0x20.
      if (e.key === " " && !e.isComposing && !e.ctrlKey && !e.altKey && !e.metaKey) {
        spacePreSentRef.current += 1;
        onSendBytes(new Uint8Array([0x20]));
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
      let value = e.target.value;
      if (value.length === 0) return;
      // If space was pre-sent at keydown, strip the leading space from
      // whatever the browser inserted so we don't send 0x20 twice.
      // WKWebView inserts the space into the textarea even when we
      // return early from onKeyDown without calling preventDefault, so
      // value here is either " " (just the space, normal case) or " X"
      // (space + next char, when WKWebView batched the input events).
      // In both cases we peel off the leading space; any remainder is
      // sent normally below.
      if (spacePreSentRef.current > 0) {
        // Strip as many leading spaces as were pre-sent at keydown.
        // Handles three WKWebView cases: (1) input fires once per space
        // ("  " → 2 separate events each with " "), (2) events are batched
        // ("  " lands as one event), (3) a space is batched with the next
        // typed char (" a" in one event). In all cases we peel off only
        // the spaces we already sent and pass the remainder through the
        // normal send path below.
        while (spacePreSentRef.current > 0 && value.startsWith(" ")) {
          value = value.slice(1);
          spacePreSentRef.current -= 1;
        }
        if (value.length === 0) {
          e.target.value = "";
          return;
        }
      }
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
