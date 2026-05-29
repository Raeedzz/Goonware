import { useEffect, useRef, useState, type RefObject } from "react";
import { AskCard } from "@/editor/AskCard";
import type { DiffLine } from "./diff-parse";

/**
 * Highlight-and-ask for diffs — the same ⌘L flow the code editor has,
 * but tuned to explain *why* a change was made rather than what code
 * does. Select text inside a diff, press ⌘L (or click the "Ask" pill),
 * and the answer streams into a margin card.
 *
 * The selected text is the question's focus; the context we hand the
 * model is a compact reconstruction of the file's unified diff (with
 * +/− markers) so it can reason about the intent behind the edit.
 */

const DIFF_ASK_SYSTEM =
  "You explain a code change to a developer reviewing a diff. " +
  "Focus on WHY this change was made and what it accomplishes — the intent " +
  "and reasoning behind it, not a line-by-line restatement. " +
  "Be precise and brief — usually 2-4 sentences. " +
  "If it fixes a bug, alters behavior, or carries a subtle implication, name it. " +
  "No markdown headers, no bullet lists unless genuinely necessary. " +
  "If the diff alone doesn't reveal the reason, say so plainly.";

const DIFF_ASK_QUESTION =
  "Why was this change made, and what does it accomplish? Focus on the highlighted lines.";

const MAX_CONTEXT_CHARS = 8000;

/**
 * Re-emit parsed diff lines as a compact unified diff: added/removed
 * lines plus `pad` lines of surrounding context, with longer runs of
 * unchanged code collapsed to an ellipsis. Bounds the prompt size so a
 * full-file view doesn't ship the entire file to the model.
 */
export function reconstructDiffContext(lines: DiffLine[], pad = 3): string {
  const rows = lines.filter(
    (l) => l.kind === "add" || l.kind === "remove" || l.kind === "context",
  );
  const n = rows.length;
  const keep = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (rows[i].kind === "add" || rows[i].kind === "remove") {
      const lo = Math.max(0, i - pad);
      const hi = Math.min(n - 1, i + pad);
      for (let j = lo; j <= hi; j++) keep[j] = true;
    }
  }
  const out: string[] = [];
  let prevKept = -1;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    if (prevKept >= 0 && i > prevKept + 1) out.push("…");
    const r = rows[i];
    const prefix = r.kind === "add" ? "+" : r.kind === "remove" ? "-" : " ";
    out.push(prefix + r.text);
    prevKept = i;
  }
  const text = out.join("\n");
  return text.length > MAX_CONTEXT_CHARS
    ? text.slice(0, MAX_CONTEXT_CHARS) + "\n…[truncated]…"
    : text;
}

interface AskState {
  selection: string;
  context: string;
  pathHint?: string;
  anchorTop: number;
  anchorLeft: number;
}

interface HintState {
  top: number;
  left: number;
}

/**
 * Returns the file path + reconstructed diff to explain for the current
 * selection, or null if the selection isn't over something askable. The
 * single-file viewer ignores the range (one file); the all-changes view
 * uses it to find which file block the selection landed in.
 */
export type DiffAskResolver = (
  range: Range,
) => { path?: string; diff: string } | null;

/**
 * Selection-driven ⌘L overlay for a diff scroll region. Mount it as a
 * sibling of the scroll container and hand it that container's ref. The
 * pill and answer card position themselves in viewport coords, so the
 * overlay element itself needs no layout.
 */
export function DiffAskOverlay({
  containerRef,
  resolve,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  resolve: DiffAskResolver;
}) {
  const [hint, setHint] = useState<HintState | null>(null);
  const [ask, setAsk] = useState<AskState | null>(null);
  // Keep the latest resolver without resubscribing listeners each render.
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;

  // Read the active in-container selection, or null if there isn't one.
  const readSelection = (): { text: string; range: Range } | null => {
    const container = containerRef.current;
    if (!container) return null;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const text = sel.toString();
    if (!text.trim()) return null;
    if (!container.contains(sel.anchorNode) || !container.contains(sel.focusNode))
      return null;
    return { text, range: sel.getRangeAt(0) };
  };

  const openAsk = () => {
    const picked = readSelection();
    if (!picked) return;
    const resolved = resolveRef.current(picked.range);
    if (!resolved) return;
    const rect = picked.range.getBoundingClientRect();
    const container = containerRef.current;
    const containerRect = container?.getBoundingClientRect();
    setAsk({
      selection: picked.text,
      context: resolved.diff,
      pathHint: resolved.path,
      anchorTop: rect.top || (containerRect?.top ?? 0) + 60,
      anchorLeft: (containerRect?.right ?? rect.right) - 12,
    });
    setHint(null);
  };

  // Track selection → show/hide the floating pill.
  useEffect(() => {
    const update = () => {
      if (ask) return;
      const picked = readSelection();
      if (!picked) {
        setHint(null);
        return;
      }
      const rect = picked.range.getBoundingClientRect();
      setHint({ top: rect.bottom + 4, left: Math.max(rect.right - 90, rect.left) });
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("mouseup", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("mouseup", update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask]);

  // ⌘L — only acts when there's a selection inside our container.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "l" || e.key === "L")) {
        if (!readSelection()) return;
        e.preventDefault();
        openAsk();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {hint && !ask && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.preventDefault();
            openAsk();
          }}
          style={{
            position: "fixed",
            top: hint.top,
            left: hint.left,
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--space-1-5)",
            height: 24,
            padding: "0 var(--space-2)",
            backgroundColor: "var(--surface-2)",
            color: "var(--text-primary)",
            border: "1px solid var(--accent-bright)",
            borderRadius: "var(--radius-pill)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-xs)",
            fontWeight: "var(--weight-medium)",
            letterSpacing: "var(--tracking-tight)",
            boxShadow: "var(--shadow-popover)",
            cursor: "pointer",
            zIndex: "var(--z-tooltip)",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: "var(--radius-pill)",
              backgroundColor: "var(--accent-bright)",
            }}
          />
          Ask
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-2xs)",
              color: "var(--text-tertiary)",
              marginLeft: 2,
            }}
          >
            ⌘L
          </span>
        </button>
      )}
      {ask && (
        <AskCard
          selection={ask.selection}
          context={ask.context}
          pathHint={ask.pathHint}
          anchor={{ top: ask.anchorTop, left: ask.anchorLeft }}
          onClose={() => setAsk(null)}
          systemPrompt={DIFF_ASK_SYSTEM}
          question={DIFF_ASK_QUESTION}
          contextHeading="Full change (unified diff)"
          label="why this change"
        />
      )}
    </>
  );
}
