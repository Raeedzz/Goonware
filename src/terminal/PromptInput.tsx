import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { fs, system, type DirEntry } from "@/lib/fs";
import { shellQuotePath } from "@/lib/shellQuote";
import { readClipboardTextWithFallback } from "./clipboardRead";
import { decideCtrlCAction } from "./ctrlCEscalation";

export interface PromptInputHandle {
  focus: () => void;
  /**
   * Splice plain text into the textarea at the current caret/selection.
   * Used by the drag-drop path so dropped file paths land in the prompt
   * the same way Cmd+V'd image paths do — the user can edit / chain
   * additional args / Enter to submit.
   */
  insertText: (text: string) => void;
  /**
   * Drop the double-tap Ctrl+C escalation timestamp so the next press
   * is treated as a fresh single-tap cycle. Called by BlockTerminal's
   * soft-reset orchestrator so all three Ctrl+C paths stay in sync
   * after a 3-tap pane reset — otherwise a stale timestamp here could
   * misfire SIGKILL on the very next keystroke.
   */
  clearEscalation: () => void;
}

interface Props {
  /** Send the line to the PTY (with trailing \n). */
  onSubmit: (text: string) => void;
  /** Send raw bytes (e.g. ⌃C → 0x03) without committing a block. */
  onSendBytes: (bytes: Uint8Array) => void;
  /**
   * Double-tap Ctrl+C escape hatch. Called instead of `onSendBytes`
   * when the user presses Ctrl+C twice in rapid succession while a
   * command is still running — see {@link decideCtrlCAction}. The
   * parent's wiring routes this to `term_kill_foreground` which
   * SIGKILLs the foreground process group via tcgetpgrp+kill.
   * Required so trapped-SIGINT processes (bun, dev watchers) can
   * still be killed from the keyboard.
   */
  onForceKill: () => void;
  /** True while a foreground command is running (OSC 133 C…D). */
  commandRunning: boolean;
  /** Number of available history entries; used to gate ↑/↓. */
  historyLength: number;
  /** Look up the history entry at offset `n` from the most recent. */
  historyAt: (offset: number) => string | null;
  /** Optional: handle ⌘↵ (e.g. start a new agent conversation). */
  onAgentNewLine?: () => void;
  /**
   * Live terminal cwd — used to resolve relative paths in `cd`
   * autocomplete. Falls back to no completion when not provided.
   */
  cwd?: string;
  /**
   * Whether this input should focus itself on mount. Defaults to true
   * for the standard "open a tab and start typing" case. Set to false
   * for instances rendered in the right-panel secondary terminals so
   * they don't compete with the main column for focus on worktree
   * switch. (The secondary terminals all mount alongside the main
   * one — without this gate the last one to mount wins and the user
   * ends up typing into the side view.)
   */
  autoFocus?: boolean;
}

const COMPLETION_LIMIT = 8;

/**
 * Maximum pixel height the auto-growing prompt textarea can reach
 * before it starts scrolling internally instead of pushing the rest
 * of the layout down. Mirrors Warp's
 * `CLI_AGENT_RICH_INPUT_EDITOR_MAX_HEIGHT` (236 px, see warpdotdev/warp
 * → `app/src/terminal/input.rs`) so a many-line draft never eats the
 * agent's visible canvas.
 */
const MAX_INPUT_HEIGHT_PX = 236;

/* ------------------------------------------------------------------
   Shell tokenizer for the input overlay.
   ------------------------------------------------------------------
   Splits a line of input into typed tokens so we can color each one in
   the layered <pre> behind the textarea. Whitespace is preserved as a
   token so the overlay's character positions match the textarea
   exactly. Operator handling covers the common shell punctuation
   (pipes, redirects, &&/||) so that `cd foo && ls -la | grep .ts`
   reads as four commands joined by accent-colored connectives.
   ------------------------------------------------------------------ */

type TokenKind =
  | "ws"
  | "command"
  | "agent"
  | "builtin"
  | "flag"
  | "string"
  | "operator"
  | "subst"
  | "arg";

interface Token {
  kind: TokenKind;
  text: string;
}

/** Shell builtins + common Unix commands — colored as `builtin`. */
const BUILTIN_NAMES = new Set([
  "cd",
  "ls",
  "pwd",
  "echo",
  "cat",
  "grep",
  "find",
  "rm",
  "mv",
  "cp",
  "mkdir",
  "rmdir",
  "touch",
  "ln",
  "chmod",
  "chown",
  "ps",
  "kill",
  "top",
  "head",
  "tail",
  "less",
  "more",
  "sed",
  "awk",
  "cut",
  "sort",
  "uniq",
  "wc",
  "tr",
  "tee",
  "xargs",
  "which",
  "type",
  "alias",
  "export",
  "unset",
  "source",
  "exit",
  "history",
  "env",
  "open",
  "git",
  "gh",
  "npm",
  "bun",
  "yarn",
  "pnpm",
  "node",
  "python",
  "python3",
  "pip",
  "cargo",
  "rustc",
  "go",
  "make",
  "docker",
  "kubectl",
  "ssh",
  "scp",
  "curl",
  "wget",
  "tar",
  "zip",
  "unzip",
  "vim",
  "nvim",
  "nano",
  "code",
]);

/** AI agent binaries — picked out with a warm accent. */
const AGENT_NAMES = new Set(["claude", "codex", "gemini", "aider", "copilot"]);

function classifyCommand(name: string): TokenKind {
  if (AGENT_NAMES.has(name)) return "agent";
  if (BUILTIN_NAMES.has(name)) return "builtin";
  return "command";
}

const OPERATOR_CHARS = "|<>&;";

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  // After an operator (|, &&, ;, etc.) the next non-ws word is a fresh
  // command. Also true at the start of input.
  let commandPending = true;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      let j = i;
      while (j < input.length && /\s/.test(input[j])) j++;
      out.push({ kind: "ws", text: input.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < input.length && input[j] !== quote) {
        if (input[j] === "\\" && j + 1 < input.length) j += 2;
        else j++;
      }
      // Include closing quote if present; otherwise stretch to end so
      // the user sees their unfinished string colored as one chunk.
      const end = j < input.length ? j + 1 : input.length;
      out.push({ kind: "string", text: input.slice(i, end) });
      i = end;
      // A quoted argument doesn't reset commandPending, but `commandPending`
      // was already false because we needed a command before this token
      // anyway. If commandPending was true, the quoted string is acting
      // as the command (rare but valid: `"./my script"`); keep it as
      // string but flip to argument-mode for what follows.
      commandPending = false;
      continue;
    }
    if (c === "$" && i + 1 < input.length) {
      // `$VAR` or `$(…)` — colored as substitution.
      let j = i + 1;
      if (input[j] === "{") {
        while (j < input.length && input[j] !== "}") j++;
        if (j < input.length) j++;
      } else if (input[j] === "(") {
        let depth = 1;
        j++;
        while (j < input.length && depth > 0) {
          if (input[j] === "(") depth++;
          else if (input[j] === ")") depth--;
          j++;
        }
      } else {
        while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j++;
      }
      out.push({ kind: "subst", text: input.slice(i, j) });
      i = j;
      commandPending = false;
      continue;
    }
    if (OPERATOR_CHARS.includes(c)) {
      let j = i + 1;
      // Cluster doubled operators (&&, ||, >>, etc.) into one token so
      // they read as a single connective.
      while (j < input.length && OPERATOR_CHARS.includes(input[j])) j++;
      out.push({ kind: "operator", text: input.slice(i, j) });
      i = j;
      commandPending = true;
      continue;
    }
    // Bare word — flag, command, or argument.
    let j = i;
    while (
      j < input.length &&
      !/\s/.test(input[j]) &&
      !OPERATOR_CHARS.includes(input[j]) &&
      input[j] !== '"' &&
      input[j] !== "'" &&
      input[j] !== "$"
    ) {
      j++;
    }
    const text = input.slice(i, j);
    if (text.startsWith("-") && text.length > 1) {
      out.push({ kind: "flag", text });
    } else if (commandPending) {
      out.push({ kind: classifyCommand(text), text });
      commandPending = false;
    } else {
      out.push({ kind: "arg", text });
    }
    i = j;
  }
  return out;
}

function tokenColor(kind: TokenKind): string {
  switch (kind) {
    case "ws":
      return "transparent";
    case "command":
      return "var(--text-primary)";
    case "agent":
      return "var(--state-warning)";
    case "builtin":
      return "var(--accent-bright)";
    case "flag":
      return "var(--state-info)";
    case "string":
      return "var(--diff-add-fg)";
    case "operator":
      return "var(--state-warning)";
    case "subst":
      return "var(--diff-add-fg)";
    case "arg":
      return "var(--text-primary)";
  }
}

/** Match "cd " + arg. Returns arg or null if not a cd. */
function parseCdInput(input: string): string | null {
  const m = input.match(/^\s*cd(?:\s+(.*))?$/);
  if (!m) return null;
  return m[1] ?? "";
}

/** Split a path arg into the directory portion and the prefix-match part. */
function splitPath(arg: string): { parent: string; prefix: string } {
  if (arg.endsWith("/")) return { parent: arg, prefix: "" };
  const idx = arg.lastIndexOf("/");
  if (idx === -1) return { parent: "", prefix: arg };
  return { parent: arg.slice(0, idx + 1), prefix: arg.slice(idx + 1) };
}

/** Resolve a relative `parent` segment against `cwd`. */
function resolveDir(parent: string, cwd: string): string {
  if (parent.startsWith("/")) return parent;
  if (parent === "") return cwd;
  return `${cwd}/${parent}`.replace(/\/+/g, "/");
}

/**
 * The input row + helper hint, exactly per the user's reference
 * screenshot:
 *
 *   Run commands▏
 *   ⌘↵ new /agent conversation
 *
 * No box, no border, no background fill on the textarea. The "input
 * zone" is implied by the pill bar above (TerminalStatusBar) and the
 * dim hint below. The cursor is the only saturated color.
 */
/**
 * Memoized to keep the input box independent of the parent BlockTerminal's
 * frame-driven re-renders. As long as the caller stabilizes the callback
 * refs (useCallback for onSubmit / onSendBytes in
 * BlockTerminal), PromptInput won't re-render when a new PTY frame
 * arrives — which is the dominant source of typing-lag during streaming
 * agent output.
 */
export const PromptInput = memo(forwardRef<PromptInputHandle, Props>(
  function PromptInput(
    {
      onSubmit,
      onSendBytes,
      onForceKill,
      commandRunning,
      historyLength,
      historyAt,
      onAgentNewLine,
      cwd,
      autoFocus = true,
    },
    ref,
  ) {
    // Timestamp of the last Ctrl+C we handled — used by
    // {@link decideCtrlCAction} to spot the double-tap that
    // escalates a stuck SIGINT into a SIGKILL on the foreground
    // process group. Refs (not state) because the value is only
    // ever read inside the keydown handler; a re-render would just
    // waste work and re-create the textarea's closure.
    const lastCtrlCAtRef = useRef<number | null>(null);
    // `commandRunning` is the prop directly. We used to mirror it
    // into a ref via `useEffect`, but effects run after commit — a
    // keydown firing between commit and effect would read the stale
    // previous value. The escalation path then escalates SIGINT →
    // SIGKILL on a process group whose foreground has already
    // passed back to the shell, killing zsh and freezing the pane.
    // `onKeyDown` is an inline function rebuilt every render, so
    // closing over the prop is fresh-by-construction.
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    // Mirror of the textarea's scrollTop, attached to the syntax-
    // highlight overlay so the colored tokens stay glued to the
    // user's caret once the textarea reaches MAX_INPUT_HEIGHT_PX and
    // starts scrolling internally. Without this the overlay would
    // float in place while the textarea content scrolled underneath.
    const highlightRef = useRef<HTMLPreElement>(null);
    const [value, setValue] = useState("");
    // Track the newline count of the last value so the height-resize
    // path only runs when the line count actually changes. Reading
    // `scrollHeight` after writing `height = "auto"` forces a
    // synchronous layout flush — doing it on every keystroke (the
    // previous behaviour) stalled fast typing by tens of ms per char,
    // which the user perceives as the terminal "stopping for a sec
    // and then catching up all at once." Single-line typing now skips
    // the reflow entirely.
    const lastNewlineCountRef = useRef(0);
    // Index into history. -1 = composing a new line; 0 = most recent
    // committed entry; N-1 = oldest.
    const [historyCursor, setHistoryCursor] = useState(-1);
    // History DROPDOWN: opened by pressing ↑ on empty input. Mirrors
    // the cd-completion dropdown's keyboard model — ↑/↓ navigate, Enter
    // inserts (lets the user edit before submitting), Esc dismisses.
    const [historyOpen, setHistoryOpen] = useState(false);
    const [historyIndex, setHistoryIndex] = useState(0);
    // Snapshot the history list when the dropdown opens so it doesn't
    // shift mid-navigation if a new command lands during a long peek.
    const historyEntries = (() => {
      if (!historyOpen) return [] as string[];
      const out: string[] = [];
      for (let i = 0; i < historyLength; i++) {
        const e = historyAt(i);
        if (e !== null) out.push(e);
      }
      return out;
    })();
    // `cd` directory completion — populated whenever `value` matches
    // `cd <something>` and we can read the resolved directory.
    const [completions, setCompletions] = useState<DirEntry[]>([]);
    const [completionIndex, setCompletionIndex] = useState(0);
    const completionsOpen = completions.length > 0;

    useImperativeHandle(ref, () => ({
      focus: () => textareaRef.current?.focus(),
      insertText: (text: string) => {
        const ta = textareaRef.current;
        const start = ta?.selectionStart ?? value.length;
        const end = ta?.selectionEnd ?? value.length;
        const before = value.slice(0, start);
        const after = value.slice(end);
        const next = before + text + after;
        setValue(next);
        requestAnimationFrame(() => {
          const t = textareaRef.current;
          if (!t) return;
          t.focus();
          const cursor = before.length + text.length;
          t.setSelectionRange(cursor, cursor);
        });
      },
      clearEscalation: () => {
        lastCtrlCAtRef.current = null;
      },
    }));

    // Auto-focus on mount so the first keystroke after a pane opens
    // lands in the input. Without this, Enter (and every other key)
    // is silently dropped until the user thinks to click first.
    //
    // CRITICAL: `autoFocus` defaults to true so existing main-column
    // BlockTerminals keep their "open a new tab and start typing"
    // behavior. The secondary right-panel BlockTerminals pass
    // `autoFocus={false}` so they never compete for focus with the
    // main column on worktree switch. Without that gate, the
    // secondary panel's PromptInput would mount AFTER the main
    // column's (it's rendered later in the AppShell tree) and steal
    // focus every time the user switched worktrees — the user-facing
    // complaint: "cursor lands in the side view, not the main one".
    useEffect(() => {
      if (autoFocus === false) return;
      textareaRef.current?.focus();
    }, [autoFocus]);

    const submit = () => {
      const text = value;
      setValue("");
      setCompletions([]);
      setHistoryCursor(-1);
      onSubmit(text);
      // Reset the textarea height after multi-line input gets cleared.
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      lastNewlineCountRef.current = 0;
    };

    /**
     * Spool a clipboard image blob to disk, then splice the resolved
     * temp-file path into the textarea at the current selection.
     * Keeps surrounding whitespace clean so the inserted path is its
     * own shell token whether the caret was mid-word or in empty space.
     */
    const insertImagePathAtSelection = async (
      file: File,
      selStart: number,
      selEnd: number,
    ) => {
      const buf = new Uint8Array(await file.arrayBuffer());
      const ext = imageExtensionFor(file);
      try {
        const path = await system.saveImageToTemp(buf, ext);
        const quoted = shellQuotePath(path);
        const before = value.slice(0, selStart);
        const after = value.slice(selEnd);
        const needLeading = before.length > 0 && !/\s$/.test(before);
        const needTrailing = after.length > 0 && !/^\s/.test(after);
        const insert = `${needLeading ? " " : ""}${quoted}${needTrailing ? " " : ""}`;
        const next = before + insert + after;
        setValue(next);
        // Move the caret to right after the inserted path so the user
        // can immediately keep typing (or Enter to submit).
        requestAnimationFrame(() => {
          const ta = textareaRef.current;
          if (!ta) return;
          ta.focus();
          const cursor = before.length + insert.length;
          ta.setSelectionRange(cursor, cursor);
        });
      } catch (err) {
        // Silent — the user will notice nothing landed and can retry
        // by Cmd+V'ing again. A toast system would be overkill here.
        console.error("[prompt] image paste failed", err);
      }
    };

    const applyCompletion = (entry: DirEntry) => {
      const arg = parseCdInput(value);
      if (arg === null) return;
      const { parent } = splitPath(arg);
      const next = `cd ${parent}${entry.name}/`;
      setValue(next);
      setCompletionIndex(0);
      // Keep focus + position the cursor at the end so the user can
      // either Tab again to descend or Enter to run.
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(next.length, next.length);
      });
    };

    // Recompute completions when the user types or cwd changes.
    // Debounced so a fast typist doesn't queue a readDir per keystroke.
    // 150 ms feels instant for completion UI and is comfortably above
    // the inter-keystroke latency of normal typing.
    useEffect(() => {
      if (!cwd) {
        setCompletions([]);
        return;
      }
      const arg = parseCdInput(value);
      if (arg === null) {
        if (completions.length > 0) setCompletions([]);
        return;
      }
      const { parent, prefix } = splitPath(arg);
      const targetDir = resolveDir(parent, cwd);
      let cancelled = false;
      const timer = setTimeout(() => {
        if (cancelled) return;
        fs.readDir(targetDir)
          .then((entries) => {
            if (cancelled) return;
            const dirs = entries
              .filter((e) => e.is_dir)
              .filter((e) =>
                prefix.length === 0
                  ? !e.name.startsWith(".")
                  : e.name.toLowerCase().startsWith(prefix.toLowerCase()),
              )
              .sort((a, b) => a.name.localeCompare(b.name))
              .slice(0, COMPLETION_LIMIT);
            setCompletions(dirs);
            setCompletionIndex(0);
          })
          .catch(() => {
            if (!cancelled) setCompletions([]);
          });
      }, 150);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value, cwd]);

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const meta = e.metaKey || e.ctrlKey;
      // ⌘↵ → "new agent conversation" hook. Must come BEFORE the
      // plain-Enter submit branch so Cmd+Enter doesn't double up
      // as a submit.
      if (meta && e.key === "Enter") {
        e.preventDefault();
        onAgentNewLine?.();
        return;
      }
      // ⌃C — escalating interrupt. First press sends 0x03 (normal
      // SIGINT via the tty driver, matches every other terminal).
      // A second press within ESCALATION_WINDOW_MS while a command
      // is still running escalates to SIGKILL on the foreground
      // process group via `onForceKill` — the only way to clear a
      // stuck `bun run` / dev watcher that traps SIGINT and refuses
      // to die. Goes before the meta bubble-out because we want to
      // handle it here, not let it bubble to "copy" elsewhere.
      if (e.ctrlKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        const decision = decideCtrlCAction({
          now: Date.now(),
          lastCtrlCAt: lastCtrlCAtRef.current,
          commandRunning,
        });
        lastCtrlCAtRef.current =
          decision.newLastCtrlCAt === 0 ? null : decision.newLastCtrlCAt;
        if (decision.action === "sigkill") {
          onForceKill();
        } else {
          onSendBytes(new Uint8Array([0x03]));
        }
        setValue("");
        setCompletions([]);
        return;
      }
      // ⌘V / ⌃V — paste into the input box. Intercept BOTH chords
      // (mac-native ⌘V and Windows/Linux ⌃V muscle memory) so the
      // paste flow is uniform across platforms and bypass-WKWebView'd
      // on macOS. Warp's `fn paste(...)` (app/src/terminal/view.rs)
      // reads from NSPasteboard directly via its Cocoa wrapper and
      // inserts the entire content into the input editor via
      // `input.system_insert(&copied, ctx)`. We mirror that: read via
      // `/usr/bin/pbpaste` and splice at the caret. The previous
      // implementation only intercepted ⌃V and routed multi-line
      // pastes to the PTY via bracketed paste — which sent the text
      // to a hidden shell line buffer that the user never saw,
      // matching the "Cmd+V doesn't paste into input" report.
      //
      // Multi-layer clipboard read (see clipboardRead.ts): the web
      // `navigator.clipboard.readText()` path silently returns ""
      // on macOS Sequoia after the user declines the per-app
      // clipboard-read prompt — the original "Ctrl+V does nothing"
      // symptom. pbpaste goes through AppKit's NSPasteboard, which
      // macOS treats as first-party so the read always succeeds.
      //
      // Image branch: when the pasteboard holds an image (screenshot,
      // copied web image, Preview "Copy"), spool it to /tmp via the
      // Rust-side `system_clipboard_save_image_to_temp` and splice
      // the file path into the textarea — same UX as the existing
      // image-drag-drop path.
      if (
        ((e.metaKey && !e.ctrlKey) || (e.ctrlKey && !e.metaKey)) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "v"
      ) {
        e.preventDefault();
        // Snapshot caret + value BEFORE the async clipboard read so
        // the splice point doesn't drift if the user kept typing
        // (rare, but spawning pbpaste is ~5–20 ms — long enough for
        // a stray keystroke to land between preventDefault and the
        // paste landing).
        const ta = textareaRef.current;
        const snapshotStart = ta?.selectionStart ?? value.length;
        const snapshotEnd = ta?.selectionEnd ?? value.length;
        const snapshotValue = value;
        void (async () => {
          // Image branch first: ask Rust to peek at the pasteboard
          // for an image item and spool it. If there's no image, the
          // command returns null and we drop to the text fallback —
          // all without a single WebKit clipboard-read call (which
          // would fire the TCC popup).
          try {
            const path = await system.saveClipboardImageToTemp();
            if (path) {
              const quoted = shellQuotePath(path);
              const before = snapshotValue.slice(0, snapshotStart);
              const after = snapshotValue.slice(snapshotEnd);
              const needLeading = before.length > 0 && !/\s$/.test(before);
              const needTrailing = after.length > 0 && !/^\s/.test(after);
              const insert = `${needLeading ? " " : ""}${quoted}${needTrailing ? " " : ""}`;
              const next = before + insert + after;
              setValue(next);
              requestAnimationFrame(() => {
                const el = textareaRef.current;
                if (!el) return;
                el.focus();
                const cursor = before.length + insert.length;
                el.setSelectionRange(cursor, cursor);
              });
              return;
            }
          } catch {
            // IPC bridge unavailable — fall through to text.
          }
          // Text branch — pbpaste first via readClipboardTextWithFallback.
          // Multi-line text is spliced into the input box (NOT routed
          // to the PTY via bracketed paste); the user sees the entire
          // paste in their input and can edit / Enter to submit. This
          // matches Warp's `should_paste_in_input` branch.
          const text = await readClipboardTextWithFallback();
          if (text === null || text.length === 0) return;
          const next =
            snapshotValue.slice(0, snapshotStart) +
            text +
            snapshotValue.slice(snapshotEnd);
          setValue(next);
          requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (!el) return;
            el.selectionStart = el.selectionEnd = snapshotStart + text.length;
          });
        })();
        return;
      }
      // Don't intercept other global chords — let ⌘1..9, ⌘⇧1..9,
      // ⌘K, ⌘N, etc. bubble up to the global keybinding handler.
      if (meta && e.key.length === 1) {
        return;
      }
      // ── History dropdown takes over arrows/enter/esc when open ──
      if (historyOpen) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHistoryIndex((idx) =>
            Math.min(historyEntries.length - 1, idx + 1),
          );
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHistoryIndex((idx) => {
            const next = idx - 1;
            if (next < 0) {
              // Walked past the most-recent entry → close the dropdown.
              setHistoryOpen(false);
              return 0;
            }
            return next;
          });
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          // Enter = drop the selected command into the textarea and
          // close the dropdown so the user can edit before running.
          // (Same shape as zsh / fzf reverse-i-search behavior.)
          e.preventDefault();
          const picked = historyEntries[historyIndex];
          if (picked != null) {
            setValue(picked);
            setHistoryCursor(historyIndex);
            requestAnimationFrame(() => {
              const ta = textareaRef.current;
              if (!ta) return;
              ta.focus();
              ta.setSelectionRange(picked.length, picked.length);
            });
          }
          setHistoryOpen(false);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setHistoryOpen(false);
          return;
        }
        // Any printable / control key while the dropdown is open
        // closes it and lets the keystroke fall through to normal
        // editing (so typing while peeking history doesn't feel
        // stuck).
        if (e.key.length === 1 || e.key === "Backspace" || e.key === "Tab") {
          setHistoryOpen(false);
          // fall through to default handling below
        }
      }
      // ── Completion dropdown takes over a few keys when open ──
      // Skip when Cmd is held — Cmd+Arrow is macOS-standard "snap to
      // start/end of textarea," which the native textarea handles
      // for free as long as we don't preventDefault here.
      if (completionsOpen) {
        if (e.key === "ArrowUp" && !meta) {
          e.preventDefault();
          setCompletionIndex((idx) => Math.max(0, idx - 1));
          return;
        }
        if (e.key === "ArrowDown" && !meta) {
          e.preventDefault();
          setCompletionIndex((idx) =>
            Math.min(completions.length - 1, idx + 1),
          );
          return;
        }
        if (e.key === "Tab") {
          // Tab = complete and keep dropdown open for further descent.
          e.preventDefault();
          applyCompletion(completions[completionIndex]);
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          // Enter = complete and submit. Runs the cd, the shell's
          // chpwd hook fires OSC 7, and the cwd pill picks up the
          // new directory automatically.
          e.preventDefault();
          const entry = completions[completionIndex];
          const arg = parseCdInput(value);
          if (arg !== null) {
            const { parent } = splitPath(arg);
            const completed = `cd ${parent}${entry.name}/`;
            setValue("");
            setCompletions([]);
            setHistoryCursor(-1);
            onSubmit(completed);
            if (textareaRef.current) {
              textareaRef.current.style.height = "auto";
            }
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setCompletions([]);
          return;
        }
      }
      // Enter (no shift, no meta) → submit. Shift+Enter inserts a newline.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
        return;
      }
      // ↑ on empty input → open the history dropdown. Inline-fill is
      // gone; the dropdown is the single source of history-recall UI
      // (matches the cd-completion dropdown's interaction pattern).
      // Skip when meta is held — Cmd+ArrowUp is the macOS-standard
      // "jump to start of textarea" shortcut, and intercepting it here
      // would silently break navigation in a multi-line prompt.
      if (e.key === "ArrowUp" && !meta && value === "" && historyLength > 0) {
        e.preventDefault();
        setHistoryOpen(true);
        setHistoryIndex(0);
        return;
      }
      // ↓ when not in dropdown / not in completions: clear any inline
      // history-cursor state. Kept as a no-op safety net for legacy
      // state — the dropdown-driven flow above never sets historyCursor
      // > 0 anymore. Same meta guard as the ArrowUp branch so
      // Cmd+ArrowDown reaches the textarea's native end-of-buffer.
      if (e.key === "ArrowDown" && !meta && historyCursor >= 0) {
        e.preventDefault();
        const next = historyCursor - 1;
        if (next < 0) {
          setHistoryCursor(-1);
          setValue("");
        } else {
          const entry = historyAt(next);
          if (entry !== null) {
            setHistoryCursor(next);
            setValue(entry);
          }
        }
        return;
      }
    };

    return (
      <div
        style={{
          flexShrink: 0,
          // surface-1 matches the TerminalStatusBar above so the cwd strip +
          // command input read as one cohesive tray, distinct from the black
          // native terminal surface behind it (see TerminalStatusBar note).
          backgroundColor: "var(--surface-1)",
          padding: "var(--space-2) var(--space-3) var(--space-2)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-1)",
          position: "relative",
        }}
      >
        {historyOpen && historyEntries.length > 0 && (
          <div
            role="listbox"
            aria-label="command history"
            style={{
              position: "absolute",
              left: "var(--space-3)",
              right: "var(--space-3)",
              bottom: "calc(100% - var(--space-1))",
              maxHeight: 240,
              overflowY: "auto",
              backgroundColor: "var(--surface-2)",
              border: "var(--border-1)",
              borderRadius: "var(--radius-sm)",
              boxShadow:
                "0 8px 24px -8px rgba(0,0,0,0.6), 0 2px 4px rgba(0,0,0,0.3)",
              zIndex: 10,
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              fontVariantLigatures: "none",
            }}
          >
            {historyEntries.map((entry, i) => {
              const active = i === historyIndex;
              return (
                <div
                  key={`${i}::${entry}`}
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setHistoryIndex(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setValue(entry);
                    setHistoryOpen(false);
                    requestAnimationFrame(() => {
                      const ta = textareaRef.current;
                      if (!ta) return;
                      ta.focus();
                      ta.setSelectionRange(entry.length, entry.length);
                    });
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-2)",
                    padding: "var(--space-1) var(--space-2)",
                    backgroundColor: active
                      ? "var(--surface-3)"
                      : "transparent",
                    color: "var(--text-primary)",
                    cursor: "pointer",
                    userSelect: "none",
                    minWidth: 0,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      color: active
                        ? "var(--accent-bright)"
                        : "var(--text-disabled)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-2xs)",
                      width: 14,
                      textAlign: "right",
                      flexShrink: 0,
                    }}
                  >
                    {i + 1}
                  </span>
                  <span
                    style={{
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {entry}
                  </span>
                </div>
              );
            })}
            <div
              style={{
                padding: "var(--space-1) var(--space-2)",
                borderTop: "var(--border-1)",
                color: "var(--text-disabled)",
                fontFamily: "var(--font-sans)",
                fontSize: "var(--text-2xs)",
                letterSpacing: "var(--tracking-tight)",
                display: "flex",
                gap: "var(--space-3)",
              }}
            >
              <span>↑↓ navigate</span>
              <span>↵ insert</span>
              <span>esc dismiss</span>
            </div>
          </div>
        )}
        {completionsOpen && (
          <div
            role="listbox"
            aria-label="cd directory completions"
            style={{
              position: "absolute",
              left: "var(--space-3)",
              right: "var(--space-3)",
              bottom: "calc(100% - var(--space-1))",
              maxHeight: 240,
              overflowY: "auto",
              backgroundColor: "var(--surface-2)",
              border: "var(--border-1)",
              borderRadius: "var(--radius-sm)",
              boxShadow:
                "0 8px 24px -8px rgba(0,0,0,0.6), 0 2px 4px rgba(0,0,0,0.3)",
              zIndex: 10,
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              fontVariantLigatures: "none",
            }}
          >
            {completions.map((entry, i) => {
              const active = i === completionIndex;
              return (
                <div
                  key={entry.path}
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setCompletionIndex(i)}
                  onMouseDown={(e) => {
                    // mousedown so click doesn't blur the textarea first.
                    e.preventDefault();
                    applyCompletion(entry);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-2)",
                    padding: "var(--space-1) var(--space-2)",
                    backgroundColor: active
                      ? "var(--surface-3)"
                      : "transparent",
                    color: "var(--text-primary)",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  <FolderArrow active={active} />
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {entry.name}
                    <span style={{ color: "var(--text-tertiary)" }}>/</span>
                  </span>
                </div>
              );
            })}
            <div
              style={{
                padding: "var(--space-1) var(--space-2)",
                borderTop: "var(--border-1)",
                color: "var(--text-disabled)",
                fontFamily: "var(--font-sans)",
                fontSize: "var(--text-2xs)",
                letterSpacing: "var(--tracking-tight)",
                display: "flex",
                gap: "var(--space-3)",
              }}
            >
              <span>↑↓ navigate</span>
              <span>⇥ complete</span>
              <span>esc dismiss</span>
            </div>
          </div>
        )}
        <PromptHighlight value={value} preRef={highlightRef}>
          <textarea
            ref={textareaRef}
            value={value}
            onScroll={(e) => {
              const pre = highlightRef.current;
              if (pre) pre.scrollTop = e.currentTarget.scrollTop;
            }}
            onChange={(e) => {
              const next = e.target.value;
              setValue(next);
              if (historyCursor >= 0) setHistoryCursor(-1);
              // Auto-grow height for multi-line commands. Only run the
              // forced-reflow path when the newline count actually
              // changes — typing on a single line never triggers a
              // layout flush, which keeps fast typists fluid. Counts
              // are cheap; reflow is not.
              let newlineCount = 0;
              for (let i = 0; i < next.length; i++) {
                if (next.charCodeAt(i) === 10) newlineCount++;
              }
              if (newlineCount !== lastNewlineCountRef.current) {
                lastNewlineCountRef.current = newlineCount;
                const ta = e.currentTarget;
                ta.style.height = "auto";
                ta.style.height = `${Math.min(
                  ta.scrollHeight,
                  MAX_INPUT_HEIGHT_PX,
                )}px`;
              }
            }}
            onPaste={(e: ClipboardEvent<HTMLTextAreaElement>) => {
              // Image paste: macOS Cmd+Shift+Ctrl+4, web-page image copy,
              // Preview "Copy" — all land here as a DataTransferItem of
              // kind "file" with an `image/*` MIME. PTYs can't carry
              // image bytes, so spool them to /tmp and splice the
              // resolved path into the textarea at the caret. The user
              // sees `'/tmp/goonware-paste/paste-…png' ` appear inline and
              // can Enter to send it to claude / cat / file / etc.
              //
              // Text paste: let the browser's native textarea paste run.
              // The keydown handler above intercepts ⌘V / ⌃V to read via
              // pbpaste (avoiding WKWebView's silent clipboard-read
              // failure), so this fallback path is exercised only for
              // right-click context-menu paste — where AppKit synthesizes
              // the paste event directly. The previous "route multi-line
              // pastes to the PTY via bracketed paste" shortcut was the
              // root cause of "Cmd+V doesn't paste into input" — the
              // text went to a hidden shell line buffer instead of the
              // visible input box. Matches Warp's `should_paste_in_input`
              // behaviour: input visible → input gets the paste, period.
              const items = Array.from(e.clipboardData?.items ?? []);
              const imageItem = items.find(
                (it) => it.kind === "file" && it.type.startsWith("image/"),
              );
              if (imageItem) {
                const file = imageItem.getAsFile();
                if (file) {
                  e.preventDefault();
                  const ta = e.currentTarget;
                  const selStart = ta.selectionStart;
                  const selEnd = ta.selectionEnd;
                  void insertImagePathAtSelection(file, selStart, selEnd);
                }
              }
            }}
            onKeyDown={onKeyDown}
            placeholder="Run commands"
            rows={1}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            style={{
              // Anti-AI-slop visual: no border, no box, no fill. The
              // input zone is implied by its position between the pill
              // bar above and the hint row below. Text is transparent —
              // the <PromptHighlight> overlay paints the colored tokens
              // so commands, flags, and operators each get their own
              // hue. Caret stays accent-cyan via `caret-color` so the
              // user can still see where they are.
              position: "relative",
              zIndex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              resize: "none",
              width: "100%",
              padding: 0,
              margin: 0,
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              lineHeight: 1.5,
              color: "transparent",
              caretColor: "var(--accent-bright)",
              maxHeight: MAX_INPUT_HEIGHT_PX,
              overflowY: "auto",
            }}
            className="goonware-prompt-input"
          />
        </PromptHighlight>
        <div
          aria-hidden
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            paddingTop: 2,
            color: "var(--text-disabled)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-2xs)",
            letterSpacing: "var(--tracking-tight)",
            userSelect: "none",
          }}
        >
          <span
            className="tabular"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-2xs)",
              color: "var(--text-tertiary)",
            }}
          >
            ⌘N
          </span>
          <span>new worktree</span>
        </div>
      </div>
    );
  },
));

/**
 * Layered syntax-highlight overlay. Renders a `<pre>` underneath the
 * textarea with the same content tokenized into colored spans. The
 * textarea above has transparent text so the user sees the colored
 * tokens but interacts with the textarea normally — selection, IME,
 * caret, undo, paste all keep working without us re-implementing
 * any of it.
 *
 * Both layers must use identical font metrics (family, size, line
 * height, ligature setting) and zero padding/margin so character
 * positions align exactly. A trailing zero-width-space space gets
 * appended to the highlight so a final newline gets a row to render
 * into (otherwise `pre`'s last line collapses to height 0).
 */
function PromptHighlight({
  value,
  children,
  preRef,
}: {
  value: string;
  children: React.ReactNode;
  preRef?: React.RefObject<HTMLPreElement | null>;
}) {
  const tokens = tokenize(value);
  return (
    <div style={{ position: "relative", width: "100%" }}>
      <pre
        ref={preRef}
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          margin: 0,
          padding: 0,
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          lineHeight: 1.5,
          fontVariantLigatures: "none",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          pointerEvents: "none",
          userSelect: "none",
          overflow: "hidden",
        }}
      >
        {tokens.map((t, i) => (
          <span key={i} style={{ color: tokenColor(t.kind) }}>
            {t.text}
          </span>
        ))}
        {/* Trailing space so a value ending in \n gets a rendered row,
            keeping the textarea and overlay heights in lockstep. */}
        {"​"}
      </pre>
      {children}
    </div>
  );
}

/**
 * Pick a sane file extension for a pasted image blob. Prefers the
 * extension already in the file name (some browsers attach
 * `clipboard.png`), then derives from MIME, finally falls back to
 * PNG — the macOS screenshot tool's default + the most lossless
 * choice for a paste of unknown provenance.
 */
function imageExtensionFor(file: File): string {
  const fromName = file.name.includes(".")
    ? file.name.split(".").pop()?.toLowerCase()
    : "";
  if (fromName && /^[a-z0-9]{2,5}$/.test(fromName)) return fromName;
  const mime = file.type.toLowerCase();
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  if (mime === "image/bmp") return "bmp";
  if (mime === "image/tiff") return "tiff";
  if (mime === "image/heic") return "heic";
  if (mime === "image/svg+xml") return "svg";
  return "png";
}

function FolderArrow({ active }: { active: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      <path
        d="M2 5.5C2 4.7 2.7 4 3.5 4h2.4c.4 0 .7.1 1 .4l1.2 1.1H12.5c.8 0 1.5.7 1.5 1.5v4.5c0 .8-.7 1.5-1.5 1.5h-9C2.7 13 2 12.3 2 11.5V5.5Z"
        stroke={active ? "var(--accent-bright)" : "var(--text-tertiary)"}
        strokeWidth="1.2"
        fill="none"
      />
    </svg>
  );
}
