import { motion } from "motion/react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { marginCardVariants } from "@/design/motion";
import { helperRun } from "@/lib/helper-agent";
import { useActiveWorktree, useAppState } from "@/state/AppState";
import { projectSettings } from "@/state/types";

interface Props {
  selection: string;
  context: string;
  pathHint?: string;
  anchor: { top: number; left: number };
  onClose: () => void;
  /** System prompt override (defaults to the code-explainer prompt). */
  systemPrompt?: string;
  /** Trailing "Question: …" line. */
  question?: string;
  /** Heading shown above the context block in the prompt. */
  contextHeading?: string;
  /** Small uppercase label on the card (defaults to "explain"). */
  label?: string;
}

const ASK_SYSTEM =
  "You explain selected code to a developer who is looking at it right now. " +
  "Be precise and brief — usually 2-4 sentences. " +
  "If the code uses a non-obvious idiom or has a subtle gotcha, name it. " +
  "Skip the preamble and the recap. No markdown headers, no bullet lists unless genuinely necessary. " +
  "If you don't know, say so plainly.";

const DEFAULT_QUESTION =
  "explain what the selected code does, why it's there, and any subtle behavior worth knowing.";

const CARD_WIDTH = 320;

/**
 * Inline highlight-and-ask answer card.
 *
 * Anchored to the right margin of the editor at the selection's vertical
 * line. Streams the question to Gemini Flash-Lite, shows a loading dot
 * indicator, then renders the answer.
 *
 * Esc / click-outside dismisses.
 */
export function AskCard({
  selection,
  context,
  pathHint,
  anchor,
  onClose,
  systemPrompt,
  question,
  contextHeading,
  label = "explain",
}: Props) {
  const [answer, setAnswer] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const worktree = useActiveWorktree();
  const state = useAppState();
  const { settings } = state;

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const project = worktree
          ? state.projects[worktree.projectId]
          : null;
        const prefs = projectSettings(project).prefs;
        const extras = prefs.general.trim();
        const preface = extras
          ? `Custom instructions from this repo:\n${extras}\n\n`
          : "";
        const prompt = `${systemPrompt ?? ASK_SYSTEM}\n\n${preface}${buildPrompt(
          selection,
          context,
          pathHint,
          { question, contextHeading },
        )}`;
        const cwd = worktree?.path ?? "";
        const cli = worktree?.agentCli ?? settings.helperCliExplain;
        const model =
          cli === settings.helperCliExplain ? settings.helperModelExplain : "";
        const out = await helperRun(cwd, cli, "explain", prompt, model);
        if (cancelled) return;
        setAnswer(out.trim());
      } catch (e) {
        if (cancelled) return;
        setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [
    selection,
    context,
    pathHint,
    systemPrompt,
    question,
    contextHeading,
    worktree?.path,
    worktree?.agentCli,
    settings.helperCliExplain,
    settings.helperModelExplain,
  ]);

  // Esc + click-outside dismiss
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    const t = window.setTimeout(
      () => window.addEventListener("mousedown", onClick),
      0,
    );
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onClick);
    };
  }, [onClose]);

  // Edge-flip vertically — keep card inside viewport
  const top = Math.max(
    8,
    Math.min(anchor.top, window.innerHeight - 200),
  );
  const left = Math.max(
    8,
    Math.min(anchor.left, window.innerWidth - CARD_WIDTH - 8),
  );

  // Portal to <body> so the fixed card escapes the diff view's stacking
  // context. Without this it's trapped inside the center column and the
  // right panel's tab strip (a later sibling) paints on top of it, even
  // though the card carries the max z-index token (--z-tooltip).
  return createPortal(
    <motion.div
      ref={ref}
      variants={marginCardVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      role="dialog"
      aria-label="Ask about this code"
      style={{
        position: "fixed",
        top,
        left,
        width: CARD_WIDTH,
        maxHeight: 320,
        overflowY: "auto",
        backgroundColor: "var(--surface-2)",
        border: "var(--border-2)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-popover)",
        zIndex: "var(--z-tooltip)",
        padding: "var(--space-3)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
        lineHeight: "var(--leading-sm)",
        color: "var(--text-primary)",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-2xs)",
          textTransform: "uppercase",
          letterSpacing: "var(--tracking-caps)",
          fontWeight: "var(--weight-semibold)",
          color: "var(--text-tertiary)",
          marginBottom: "var(--space-2)",
        }}
      >
        {label}
      </div>

      {loading && <LoadingDots />}

      {error && (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          <div
            style={{
              color: "var(--state-error)",
              fontSize: "var(--text-xs)",
              fontFamily: "var(--font-mono)",
              lineHeight: "var(--leading-xs)",
            }}
          >
            {error}
          </div>
        </div>
      )}

      {!loading && !error && (
        <div
          style={{
            whiteSpace: "pre-wrap",
            color: "var(--text-primary)",
          }}
        >
          {answer}
        </div>
      )}
    </motion.div>,
    document.body,
  );
}

function LoadingDots() {
  return (
    <div className="goonware-loading-dots">
      <span>·</span>
      <span>·</span>
      <span>·</span>
    </div>
  );
}

function buildPrompt(
  selection: string,
  context: string,
  pathHint?: string,
  opts?: { question?: string; contextHeading?: string },
): string {
  const header = pathHint ? `File: ${pathHint}\n\n` : "";
  const heading = opts?.contextHeading ?? "Surrounding context";
  const question = opts?.question ?? DEFAULT_QUESTION;
  return `${header}Selected code (the user is asking about this):\n\`\`\`\n${selection}\n\`\`\`\n\n${heading}:\n\`\`\`\n${context}\n\`\`\`\n\nQuestion: ${question}`;
}
