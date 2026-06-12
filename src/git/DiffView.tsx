import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { git } from "@/lib/git";
import { useDiffLineRenderers } from "./diff-highlight";
import { DiffAskOverlay, reconstructDiffContext } from "./DiffAsk";
import { parseUnifiedDiff, type DiffLine } from "./diff-parse";

export { parseUnifiedDiff, type DiffLine };

interface Props {
  projectPath: string;
  filePath: string;
  /** True for staged-vs-HEAD; false for working-vs-index. */
  staged: boolean;
  onClose: () => void;
}

/**
 * Unified diff viewer. Mounted as a tab in the main column when the
 * user clicks a file row in the right panel's Changes tab. ‐/+ lines
 * are tinted with `--diff-add-bg` and `--diff-remove-bg`; line numbers
 * track old/new sides for hunk navigation. Esc or × dismisses.
 *
 * Renders as `position:absolute; inset:0` — the parent is responsible
 * for being a positioning context.
 */
export function DiffView({ projectPath, filePath, staged, onClose }: Props) {
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    git
      .diff(projectPath, filePath, staged, true)
      .then((d) => {
        if (cancelled) return;
        setRaw(d);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, filePath, staged]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Escape aimed at a dialog, menu, or text field belongs to that
      // surface — only a "bare" Escape closes the diff.
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.isContentEditable ||
          t.closest("input, textarea, [role=dialog], [role=menu]"))
      )
        return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const lines = useMemo<DiffLine[]>(
    () => (raw ? parseUnifiedDiff(raw) : []),
    [raw],
  );

  const stats = useMemo(() => {
    let add = 0;
    let rem = 0;
    for (const l of lines) {
      if (l.kind === "add") add++;
      else if (l.kind === "remove") rem++;
    }
    return { add, rem };
  }, [lines]);

  // Overview-ruler marks: each changed line bucketed into a slot by its
  // proportional position in the rendered body, so the strip beside the
  // scrollbar shows green where code was added and red where removed —
  // mapped onto the same rows the body renders (post header-filter).
  const marks = useMemo(() => {
    const rows = visibleDiffLines(lines);
    const n = rows.length;
    if (!n) return [];
    const slots: Array<"add" | "remove" | "both" | undefined> = new Array(
      RULER_SLOTS,
    );
    rows.forEach((l, i) => {
      if (l.kind !== "add" && l.kind !== "remove") return;
      const s = Math.min(RULER_SLOTS - 1, Math.floor((i / n) * RULER_SLOTS));
      const cur = slots[s];
      if (!cur) slots[s] = l.kind;
      else if (cur !== l.kind) slots[s] = "both";
    });
    const out: Array<{ slot: number; kind: "add" | "remove" | "both" }> = [];
    slots.forEach((v, idx) => {
      if (v) out.push({ slot: idx, kind: v });
    });
    return out;
  }, [lines]);

  // Compact unified diff handed to the "ask" card as context. The whole
  // file is one ask target here, so the selection's range is irrelevant.
  const diffContext = useMemo(() => reconstructDiffContext(lines), [lines]);

  const filename = filePath.split("/").pop() || filePath;
  const dirname = filePath.includes("/")
    ? filePath.slice(0, filePath.lastIndexOf("/"))
    : "";

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.14, ease: [0.25, 1, 0.5, 1] }}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 5,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--surface-0)",
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: 36,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "0 var(--space-2) 0 var(--space-3)",
          backgroundColor: "var(--surface-1)",
          borderBottom: "var(--border-1)",
          userSelect: "none",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "var(--radius-pill)",
            backgroundColor: "var(--state-warning)",
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--text-secondary)",
            textTransform: "uppercase",
            letterSpacing: "var(--tracking-caps)",
            flexShrink: 0,
          }}
        >
          diff
        </span>
        <span style={{ color: "var(--text-disabled)" }}>·</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flexShrink: 1,
            minWidth: 0,
          }}
          title={filePath}
        >
          {filename}
          {dirname && (
            <span
              style={{
                color: "var(--text-tertiary)",
                marginLeft: 8,
                fontSize: "var(--text-2xs)",
              }}
            >
              {dirname}
            </span>
          )}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
            flexShrink: 0,
          }}
          className="tabular"
        >
          {staged ? "staged" : "working"} ·{" "}
          <span style={{ color: "var(--diff-add-fg)" }}>+{stats.add}</span>
          {" "}
          <span style={{ color: "var(--diff-remove-fg)" }}>−{stats.rem}</span>
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onClose}
          title="close (esc)"
          style={{
            width: 24,
            height: 24,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "transparent",
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-md)",
            borderRadius: "var(--radius-sm)",
            cursor: "pointer",
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "var(--surface-2)";
            e.currentTarget.style.color = "var(--text-primary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
            e.currentTarget.style.color = "var(--text-tertiary)";
          }}
        >
          ×
        </button>
      </div>

      <div
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          display: "flex",
        }}
      >
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            fontVariantLigatures: "none",
            backgroundColor: "var(--surface-0)",
          }}
          className="allow-select"
        >
          {loading && <Empty label="loading diff…" />}
          {!loading && error && <Empty label={`error: ${error}`} />}
          {!loading && !error && lines.length === 0 && (
            <Empty label="no changes" />
          )}
          {!loading && !error && lines.length > 0 && (
            <DiffBody lines={lines} filePath={filePath} />
          )}
        </div>
        {!loading && !error && marks.length > 0 && <ChangeRuler marks={marks} />}
        {!loading && !error && lines.length > 0 && (
          <DiffAskOverlay
            containerRef={scrollRef}
            resolve={() => ({ path: filePath, diff: diffContext })}
          />
        )}
      </div>
    </motion.div>
  );
}

/** Number of vertical buckets in the overview ruler. Caps the DOM-node
 *  count regardless of file size; adjacent changed lines that fall in
 *  the same bucket merge into one mark. */
const RULER_SLOTS = 160;

/**
 * Editor-style overview ruler pinned to the right edge of the scroll
 * viewport (over the scroll track, click-through so it never blocks the
 * scrollbar). Green marks = added lines, red = removed, split = both in
 * one bucket — a glance shows where in the file the changes cluster.
 */
function ChangeRuler({
  marks,
}: {
  marks: Array<{ slot: number; kind: "add" | "remove" | "both" }>;
}) {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 10,
        pointerEvents: "none",
        zIndex: 2,
      }}
    >
      {marks.map((m) => {
        const top = (m.slot / RULER_SLOTS) * 100;
        const height = 100 / RULER_SLOTS;
        const background =
          m.kind === "add"
            ? "var(--diff-add-fg)"
            : m.kind === "remove"
              ? "var(--diff-remove-fg)"
              : "linear-gradient(var(--diff-remove-fg) 50%, var(--diff-add-fg) 50%)";
        return (
          <div
            key={m.slot}
            style={{
              position: "absolute",
              top: `${top}%`,
              right: 3,
              width: 4,
              height: `max(3px, ${height}%)`,
              borderRadius: "var(--radius-pill)",
              background,
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * Header lines that just restate plumbing we already show elsewhere
 * (the file path lives in the tab title / sticky file header). Dropping
 * them keeps the body to actual code so it's clear what is what.
 */
function isNoiseHeader(text: string): boolean {
  return (
    text.startsWith("diff --git") ||
    text.startsWith("index ") ||
    text.startsWith("--- ") ||
    text.startsWith("+++ ")
  );
}

/** The lines we actually render — redundant plumbing headers dropped.
 *  Shared so the overview ruler maps onto the same rows as the body. */
export function visibleDiffLines(lines: DiffLine[]): DiffLine[] {
  return lines.filter((l) => !(l.kind === "header" && isNoiseHeader(l.text)));
}

/** Trailing context git tacks after the second `@@` (usually the
 *  enclosing function), shown as the only label on a hunk separator. */
function hunkLabel(text: string): string {
  const m = /@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(.*)$/.exec(text);
  return m ? m[1].trim() : "";
}

export function DiffBody({
  lines,
  filePath,
}: {
  lines: DiffLine[];
  filePath?: string;
}) {
  // Drop redundant plumbing headers before highlighting so the renderer
  // indices line up with what we actually render.
  const visible = useMemo(() => visibleDiffLines(lines), [lines]);
  const rendered = useDiffLineRenderers(visible, filePath);
  return (
    <table
      style={{
        width: "100%",
        borderCollapse: "collapse",
        tableLayout: "fixed",
      }}
    >
      <colgroup>
        {/* One line-number gutter, one sigil, then the code. */}
        <col style={{ width: 52 }} />
        <col style={{ width: 22 }} />
        <col />
      </colgroup>
      <tbody>
        {visible.map((l, i) => (
          <DiffRow key={i} line={l} body={rendered[i]} />
        ))}
      </tbody>
    </table>
  );
}

function DiffRow({ line, body }: { line: DiffLine; body: ReactNode }) {
  // Hunk markers become a single full-width separator rule — the visual
  // "the diff skips here" cue, with the enclosing-scope label if git gave
  // one. No raw `@@ -a,b +c,d @@` noise, no per-side numbers to decode.
  if (line.kind === "hunk") {
    const label = hunkLabel(line.text);
    return (
      <tr>
        <td
          colSpan={3}
          style={{
            padding: "var(--space-1) var(--space-3)",
            borderTop: "var(--border-1)",
            borderBottom: "var(--border-1)",
            backgroundColor: "var(--surface-1)",
            color: "var(--text-tertiary)",
            fontSize: "var(--text-2xs)",
            fontFamily: "var(--font-sans)",
            userSelect: "none",
            whiteSpace: "pre",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {label || "⋯"}
        </td>
      </tr>
    );
  }

  // Informative headers that survived the noise filter (rename / mode /
  // binary notes) render as a quiet italic note spanning the row.
  if (line.kind === "header") {
    return (
      <tr>
        <td
          colSpan={3}
          style={{
            padding: "var(--space-1) var(--space-3)",
            backgroundColor: "var(--surface-1)",
            color: "var(--text-tertiary)",
            fontSize: "var(--text-2xs)",
            fontStyle: "italic",
            fontFamily: "var(--font-sans)",
            userSelect: "none",
          }}
        >
          {line.text}
        </td>
      </tr>
    );
  }

  const isAdd = line.kind === "add";
  const isRemove = line.kind === "remove";
  const bg = isAdd
    ? "var(--diff-add-bg)"
    : isRemove
      ? "var(--diff-remove-bg)"
      : "transparent";
  const sigil = isAdd ? "+" : isRemove ? "−" : "";
  const sigilColor = isAdd
    ? "var(--diff-add-fg)"
    : isRemove
      ? "var(--diff-remove-fg)"
      : "var(--text-disabled)";
  // Single gutter: the line's position in the file it belongs to —
  // removed lines carry their old number, everything else the new one.
  const lineNo = isRemove ? line.oldLine : line.newLine;
  // A colored left edge reinforces add/remove without a second column.
  const edge = isAdd
    ? "2px solid var(--diff-add-fg)"
    : isRemove
      ? "2px solid var(--diff-remove-fg)"
      : "2px solid transparent";

  return (
    <tr style={{ backgroundColor: bg }}>
      <td
        style={{
          padding: "0 var(--space-2)",
          textAlign: "right",
          color: "var(--text-tertiary)",
          userSelect: "none",
          fontSize: "var(--text-2xs)",
          verticalAlign: "top",
          borderLeft: edge,
        }}
        className="tabular"
      >
        {lineNo ?? ""}
      </td>
      <td
        style={{
          padding: "0 var(--space-1)",
          color: sigilColor,
          userSelect: "none",
          textAlign: "center",
          verticalAlign: "top",
          fontWeight: "var(--weight-semibold)",
        }}
      >
        {sigil}
      </td>
      <td
        style={{
          padding: "0 var(--space-2) 0 var(--space-1)",
          color: "var(--text-primary)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {line.text ? body : "​"}
      </td>
    </tr>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: "var(--space-6) var(--space-4)",
        textAlign: "center",
        color: "var(--text-tertiary)",
        fontSize: "var(--text-xs)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {label}
    </div>
  );
}

