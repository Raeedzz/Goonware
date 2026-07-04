import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "motion/react";
import { MagicWand, Minus, NotePencil, Plus, X } from "@phosphor-icons/react";
import { useAppDispatch, useAppState } from "@/state/AppState";
import { useToast } from "@/primitives/Toast";
import type { AppState, TerminalTab, Worktree } from "@/state/types";

/**
 * "Fix this hunk" — a review-and-delegate layer over the working diff.
 *
 * Each edited block in a working-tree diff (a contiguous run of `+`/`-`
 * lines) grows a `+` button in the left gutter; clicking it opens an
 * inline box under that block where the user types what they want
 * changed about that part of the code. Comments accumulate across blocks
 * and files, and a floating "Fix" bar composes them into one prompt —
 * each request paired with the exact diff snippet it refers to — and
 * pastes it straight into the worktree's agent terminal, which then goes
 * and implements them.
 *
 * The plumbing is a React context: `DiffFixProvider` owns the comment
 * state and the target worktree's cwd; `DiffBody` reads the context to
 * decide whether to render `+` buttons at all (so historical commit
 * diffs, which mount without a provider, stay read-only); `DiffFixBar`
 * reads it to build and send the prompt.
 */

/** A single hunk the user can attach a change request to. */
export interface HunkRef {
  /** Stable within one diff render: `${file}#${ordinal}`. */
  id: string;
  file: string;
  /** Enclosing scope git tacked onto the `@@` header, if any. */
  label: string;
  /** The hunk rebuilt as a unified-diff snippet, handed to the agent. */
  snippet: string;
}

interface DiffFixApi {
  isOpen: (id: string) => boolean;
  hasText: (id: string) => boolean;
  /** Open a box for this hunk (idempotent — keeps existing text). */
  openBox: (ref: HunkRef) => void;
  /** Close a box and drop its text. */
  closeBox: (id: string) => void;
  getText: (id: string) => string;
  setText: (id: string, text: string) => void;
  /** Open boxes with non-empty text, in file+hunk order. */
  entries: () => Array<{ ref: HunkRef; text: string }>;
  /** Count of non-empty comments — drives the Fix bar. */
  count: number;
  clear: () => void;
  /** Worktree checkout dir this diff belongs to. */
  cwd: string;
}

const DiffFixContext = createContext<DiffFixApi | null>(null);

/** Diff-fix API for the enclosing view, or null when there is no
 *  provider (e.g. a historical commit diff — read-only, no `+`). */
export function useDiffFix(): DiffFixApi | null {
  return useContext(DiffFixContext);
}

export function DiffFixProvider({
  cwd,
  children,
}: {
  cwd: string;
  children: ReactNode;
}) {
  // `open` maps hunk id → its ref (so we can rebuild the prompt without
  // re-deriving snippets); `text` maps hunk id → the user's request.
  const [open, setOpen] = useState<Record<string, HunkRef>>({});
  const [text, setText] = useState<Record<string, string>>({});

  const api = useMemo<DiffFixApi>(() => {
    const orderKey = (ref: HunkRef) => {
      const hash = ref.id.lastIndexOf("#");
      const ord = hash >= 0 ? Number(ref.id.slice(hash + 1)) : 0;
      return [ref.file, Number.isFinite(ord) ? ord : 0] as const;
    };
    const activeRefs = Object.values(open).filter(
      (ref) => (text[ref.id]?.trim().length ?? 0) > 0,
    );
    return {
      isOpen: (id) => id in open,
      hasText: (id) => id in open && (text[id]?.trim().length ?? 0) > 0,
      openBox: (ref) =>
        setOpen((o) => (o[ref.id] ? o : { ...o, [ref.id]: ref })),
      closeBox: (id) => {
        setOpen((o) => {
          if (!(id in o)) return o;
          const { [id]: _drop, ...rest } = o;
          return rest;
        });
        setText((t) => {
          if (!(id in t)) return t;
          const { [id]: _drop, ...rest } = t;
          return rest;
        });
      },
      getText: (id) => text[id] ?? "",
      setText: (id, value) => setText((s) => ({ ...s, [id]: value })),
      entries: () =>
        activeRefs
          .slice()
          .sort((a, b) => {
            const [fa, oa] = orderKey(a);
            const [fb, ob] = orderKey(b);
            return fa === fb ? oa - ob : fa < fb ? -1 : 1;
          })
          .map((ref) => ({ ref, text: text[ref.id] ?? "" })),
      count: activeRefs.length,
      clear: () => {
        setOpen({});
        setText({});
      },
      cwd,
    };
  }, [open, text, cwd]);

  return (
    <DiffFixContext.Provider value={api}>{children}</DiffFixContext.Provider>
  );
}

/* ------------------------------------------------------------------
   `+` button — sits in the left gutter beside each change block.
   ------------------------------------------------------------------ */

export function HunkAddButton({
  hunkRef,
  fix,
}: {
  hunkRef: HunkRef;
  fix: DiffFixApi;
}) {
  const active = fix.isOpen(hunkRef.id);
  const commented = fix.hasText(hunkRef.id);
  const lit = active || commented;
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={active ? "Discard this suggestion" : "Suggest a change to this block"}
      aria-label={
        active ? "Discard this suggestion" : "Suggest a change to this block"
      }
      onClick={(e) => {
        e.stopPropagation();
        // Toggle: `+` opens the suggestion box, `−` dismisses it.
        if (active) fix.closeBox(hunkRef.id);
        else fix.openBox(hunkRef);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 17,
        height: 17,
        flexShrink: 0,
        borderRadius: "var(--radius-sm)",
        border: `1px solid ${
          lit || hover ? "var(--accent-bright)" : "var(--border-strong)"
        }`,
        backgroundColor:
          lit || hover
            ? "var(--surface-accent-tinted)"
            : "var(--surface-2)",
        color: lit || hover ? "var(--accent-bright)" : "var(--text-secondary)",
        cursor: "pointer",
        boxShadow: "var(--shadow-xs, 0 1px 1px rgba(0,0,0,0.15))",
        transition:
          "background-color var(--motion-fast) var(--ease-out-quart), " +
          "color var(--motion-fast) var(--ease-out-quart), " +
          "border-color var(--motion-fast) var(--ease-out-quart)",
      }}
    >
      {active ? <Minus size={13} weight="bold" /> : <Plus size={13} weight="bold" />}
    </button>
  );
}

/* ------------------------------------------------------------------
   Inline comment box — rendered in its own row under the hunk.
   ------------------------------------------------------------------ */

export function HunkCommentBox({
  hunkRef,
  fix,
}: {
  hunkRef: HunkRef;
  fix: DiffFixApi;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const value = fix.getText(hunkRef.id);

  // Focus on mount; auto-grow to fit content.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.14, ease: [0.25, 1, 0.5, 1] }}
      style={{
        position: "relative",
        width: "min(100%, 300px)",
        minHeight: 96,
        borderRadius: "var(--radius-md)",
        border:
          "1px solid color-mix(in oklch, var(--border-strong), var(--accent) 20%)",
        backgroundColor: "var(--surface-accent-soft)",
        padding: "var(--space-2)",
      }}
    >
      <NotePencil
        aria-hidden
        size={14}
        weight="bold"
        style={{
          position: "absolute",
          top: "calc(var(--space-2) + 2px)",
          left: "var(--space-2)",
          color: "color-mix(in oklch, var(--text-tertiary), var(--accent) 45%)",
          pointerEvents: "none",
        }}
      />
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => fix.setText(hunkRef.id, e.target.value)}
        onKeyDown={(e) => {
          // Esc discards the box without letting the diff's global Esc
          // (which closes the whole view) fire.
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            fix.closeBox(hunkRef.id);
          }
          e.stopPropagation();
        }}
        placeholder="Suggest a change"
        rows={1}
        spellCheck={false}
        style={{
          width: "100%",
          minHeight: 76,
          resize: "none",
          border: "none",
          outline: "none",
          background: "transparent",
          color: "var(--text-primary)",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-xs)",
          lineHeight: 1.5,
          padding: 0,
          paddingLeft: 22,
          paddingRight: 18,
        }}
      />
      <button
        type="button"
        title="Discard this request"
        aria-label="Discard this request"
        onClick={(e) => {
          e.stopPropagation();
          fix.closeBox(hunkRef.id);
        }}
        style={{
          position: "absolute",
          top: "var(--space-1)",
          right: "var(--space-1)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 18,
          height: 18,
          flexShrink: 0,
          borderRadius: "var(--radius-sm)",
          border: "none",
          background: "transparent",
          color: "var(--text-tertiary)",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--text-primary)";
          e.currentTarget.style.backgroundColor = "var(--surface-2)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "var(--text-tertiary)";
          e.currentTarget.style.backgroundColor = "transparent";
        }}
      >
        <X size={13} weight="bold" />
      </button>
    </motion.div>
  );
}

/* ------------------------------------------------------------------
   Floating "Fix" bar + prompt composition + PTY handoff.
   ------------------------------------------------------------------ */

interface AgentTarget {
  worktree: Worktree;
  ptyId: string;
  /** Present when the target is a main-column terminal tab we can focus. */
  tabId?: string;
  /**
   * True when we detected an agent CLI (Claude Code, Codex, …) in the
   * chosen terminal. False means the terminal is just a bare shell — the
   * prompt would land at a `$` prompt and do nothing, so the Fix bar
   * refuses and tells the user to start their agent.
   */
  hasAgent: boolean;
}

/**
 * Resolve the terminal PTY to hand the prompt to for the worktree whose
 * checkout is `cwd`. Prefers a terminal with an agent actually running
 * in it (active tab first, then any tab); failing that it still returns
 * a bare-shell terminal so the caller can surface a "no agent" error
 * rather than silently dropping the prompt into a shell. Last resort is
 * the secondary panel terminal, judged by the worktree's detected CLI.
 */
function resolveAgentTarget(state: AppState, cwd: string): AgentTarget | null {
  const worktree = Object.values(state.worktrees).find((w) => w.path === cwd);
  if (!worktree) return null;

  const termTabs = worktree.tabIds
    .map((id) => state.tabs[id])
    .filter((t): t is TerminalTab => !!t && t.kind === "terminal");

  // An agent is "running" in a terminal when a CLI was detected in it.
  const activeId = worktree.activeTabId;
  const agentTab =
    termTabs.find((t) => t.id === activeId && t.detectedCli != null) ??
    termTabs.find((t) => t.detectedCli != null);
  if (agentTab)
    return {
      worktree,
      ptyId: agentTab.ptyId,
      tabId: agentTab.id,
      hasAgent: true,
    };

  // A terminal is open but it's a plain shell — return it flagged so the
  // caller can tell the user no agent is running.
  const active = activeId ? state.tabs[activeId] : null;
  const shellTab =
    (active && active.kind === "terminal" ? active : null) ??
    termTabs[0] ??
    null;
  if (shellTab)
    return {
      worktree,
      ptyId: shellTab.ptyId,
      tabId: shellTab.id,
      hasAgent: false,
    };

  // Secondary panel: no per-tab CLI detection, so lean on the worktree's
  // detected agent CLI as the best available signal.
  const secondary =
    worktree.secondaryActiveTerminalId ?? worktree.secondaryPtyId;
  return secondary
    ? { worktree, ptyId: secondary, hasAgent: worktree.agentCli != null }
    : null;
}

/** Turn the collected comments into one prompt for the agent. */
export function composeFixPrompt(
  entries: Array<{ ref: HunkRef; text: string }>,
): string {
  const header =
    "I'm reviewing the current diff and want you to make the changes below. " +
    "Each item points at a specific block of the diff (shown as a unified-diff snippet) and says " +
    "what I want changed there. Implement all of them directly in the code, keeping " +
    "each edit scoped to what's described. Don't ask for confirmation between items — " +
    "just make the changes.";
  const blocks = entries.map((e, i) => {
    const loc = e.ref.label ? `${e.ref.file} (in ${e.ref.label})` : e.ref.file;
    return (
      `### Change ${i + 1} — ${loc}\n` +
      "```diff\n" +
      e.ref.snippet +
      "\n```\n" +
      `Requested: ${e.text.trim()}`
    );
  });
  return [header, ...blocks, "Make these edits now."].join("\n\n");
}

const encoder = new TextEncoder();
const PASTE_START = encoder.encode("\x1b[200~");
const PASTE_END = encoder.encode("\x1b[201~");

/**
 * Deliver a multi-line prompt to a TUI agent (Claude Code, Codex, …)
 * the way a real paste arrives: wrapped in bracketed-paste markers so
 * embedded newlines land as literal newlines in the agent's input
 * buffer rather than submitting each line. A trailing carriage return,
 * sent as its own event, submits.
 */
async function sendToAgent(ptyId: string, prompt: string): Promise<void> {
  const payload = encoder.encode(prompt);
  const framed = new Uint8Array(
    PASTE_START.length + payload.length + PASTE_END.length,
  );
  framed.set(PASTE_START, 0);
  framed.set(payload, PASTE_START.length);
  framed.set(PASTE_END, PASTE_START.length + payload.length);
  await invoke("term_input", { id: ptyId, data: Array.from(framed) });
  await invoke("term_input", { id: ptyId, data: [0x0d] });
}

export function DiffFixBar() {
  const fix = useDiffFix();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const [hover, setHover] = useState(false);

  if (!fix) return null;
  const count = fix.count;

  const send = async () => {
    const entries = fix.entries();
    if (entries.length === 0 || sending) return;
    const target = resolveAgentTarget(state, fix.cwd);
    if (!target) {
      toast.show({
        message:
          "No terminal open for this worktree — open your agent and press Fix again.",
      });
      return;
    }
    if (!target.hasAgent) {
      toast.show({
        message:
          "No agent is running in this worktree — start Claude Code or Codex in the terminal, then press Fix again.",
      });
      return;
    }
    setSending(true);
    try {
      await sendToAgent(target.ptyId, composeFixPrompt(entries));
      // Bring the agent terminal to the front so the user watches it work.
      if (target.tabId)
        dispatch({
          type: "select-tab",
          worktreeId: target.worktree.id,
          id: target.tabId,
        });
      toast.show({
        message: `Sent ${entries.length} change${
          entries.length === 1 ? "" : "s"
        } to the agent.`,
      });
      fix.clear();
    } catch (e) {
      toast.show({ message: `Couldn't reach the agent: ${e}` });
    } finally {
      setSending(false);
    }
  };

  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={{ duration: 0.16, ease: [0.25, 1, 0.5, 1] }}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            display: "flex",
            justifyContent: "center",
            padding: "var(--space-3)",
            pointerEvents: "none",
            zIndex: 6,
          }}
        >
          <button
            type="button"
            onClick={() => void send()}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            disabled={sending}
            style={{
              pointerEvents: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-2)",
              height: 34,
              padding: "0 var(--space-4)",
              borderRadius: "var(--radius-pill)",
              border:
                "1px solid color-mix(in oklch, var(--surface-3), var(--accent) 55%)",
              backgroundColor: hover
                ? "color-mix(in oklch, var(--surface-2), var(--accent) 20%)"
                : "color-mix(in oklch, var(--surface-2), var(--accent) 12%)",
              color: "color-mix(in oklch, var(--text-primary), var(--accent) 35%)",
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-xs)",
              fontWeight: "var(--weight-semibold)",
              letterSpacing: "var(--tracking-tight)",
              boxShadow: "var(--shadow-popover)",
              cursor: sending ? "default" : "pointer",
              opacity: sending ? 0.7 : 1,
              transition:
                "background-color var(--motion-fast) var(--ease-out-quart)",
            }}
          >
            <MagicWand size={14} weight="fill" />
            {sending
              ? "Sending…"
              : `Fix ${count} change${count === 1 ? "" : "s"}`}
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
