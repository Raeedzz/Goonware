import { motion } from "motion/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { git } from "@/lib/git";
import { useDiffLineRenderers } from "./diff-highlight";
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    git
      .diff(projectPath, filePath, staged)
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
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
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
    </motion.div>
  );
}

export function DiffBody({
  lines,
  filePath,
}: {
  lines: DiffLine[];
  filePath?: string;
}) {
  const rendered = useDiffLineRenderers(lines, filePath);
  return (
    <table
      style={{
        width: "100%",
        borderCollapse: "collapse",
        tableLayout: "fixed",
      }}
    >
      <colgroup>
        <col style={{ width: 48 }} />
        <col style={{ width: 48 }} />
        <col style={{ width: 14 }} />
        <col />
      </colgroup>
      <tbody>
        {lines.map((l, i) => (
          <DiffRow key={i} line={l} body={rendered[i]} />
        ))}
      </tbody>
    </table>
  );
}

function DiffRow({ line, body }: { line: DiffLine; body: ReactNode }) {
  const bg =
    line.kind === "add"
      ? "var(--diff-add-bg)"
      : line.kind === "remove"
        ? "var(--diff-remove-bg)"
        : line.kind === "hunk"
          ? "var(--surface-2)"
          : line.kind === "header"
            ? "var(--surface-1)"
            : "transparent";
  const sigil =
    line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " ";
  const sigilColor =
    line.kind === "add"
      ? "var(--diff-add-fg)"
      : line.kind === "remove"
        ? "var(--diff-remove-fg)"
        : "var(--text-disabled)";
  const textColor =
    line.kind === "header"
      ? "var(--text-tertiary)"
      : line.kind === "hunk"
        ? "var(--accent-bright)"
        : "var(--text-primary)";

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
        }}
        className="tabular"
      >
        {line.oldLine ?? ""}
      </td>
      <td
        style={{
          padding: "0 var(--space-2)",
          textAlign: "right",
          color: "var(--text-tertiary)",
          userSelect: "none",
          fontSize: "var(--text-2xs)",
          verticalAlign: "top",
        }}
        className="tabular"
      >
        {line.newLine ?? ""}
      </td>
      <td
        style={{
          padding: "0 4px",
          color: sigilColor,
          userSelect: "none",
          textAlign: "center",
          verticalAlign: "top",
        }}
      >
        {sigil}
      </td>
      <td
        style={{
          padding: "0 var(--space-2) 0 0",
          color: textColor,
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

