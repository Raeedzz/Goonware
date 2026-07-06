import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { pr } from "@/lib/pr";
import { FileBlock, sliceByFile, type FileSection } from "./AllChangesView";

/**
 * Full diff of an open PR, one collapsible section per file — the
 * main-column body of a `pr-diff` tab. Fetches `gh pr diff <number>`
 * live (no checkout needed) and reuses the AllChangesView slicing +
 * FileBlock renderer so tinting, line numbers, and sticky file headers
 * match the working-tree diff views exactly. Listens to
 * `goonware-git-refresh` so a push to the PR branch (e.g. after
 * resolving conflicts in a checked-out session) re-pulls the diff.
 */
export function PrDiffView({
  projectPath,
  number,
  title,
}: {
  projectPath: string;
  number: number;
  title: string;
}) {
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const rerun = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // git-refresh fires for every git operation in the worktree, so:
    // keep showing the current diff while the refetch runs (no blank
    // flash), skip identical payloads (setRaw keeps the old identity
    // so sliceByFile doesn't re-parse), and coalesce events that land
    // mid-fetch into one trailing refetch instead of piling up gh
    // subprocesses.
    const refresh = () => {
      if (inFlight.current) {
        rerun.current = true;
        return;
      }
      inFlight.current = true;
      pr.diff(projectPath, number)
        .then((d) => {
          if (cancelled) return;
          setRaw((prev) => (prev === d ? prev : d));
          setError(null);
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        })
        .finally(() => {
          inFlight.current = false;
          if (rerun.current && !cancelled) {
            rerun.current = false;
            refresh();
          }
        });
    };
    refresh();
    const onRefresh = (e: Event) => {
      const detail = (e as CustomEvent<{ cwd?: string }>).detail;
      if (!detail?.cwd || detail.cwd === projectPath) refresh();
    };
    window.addEventListener("goonware-git-refresh", onRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener("goonware-git-refresh", onRefresh);
    };
  }, [projectPath, number]);

  const sections = useMemo<FileSection[]>(
    () => (raw ? sliceByFile(raw) : []),
    [raw],
  );

  const totals = useMemo(() => {
    let add = 0;
    let rem = 0;
    for (const s of sections) {
      for (const l of s.lines) {
        if (l.kind === "add") add++;
        else if (l.kind === "remove") rem++;
      }
    }
    return { add, rem, files: sections.length };
  }, [sections]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.14, ease: [0.25, 1, 0.5, 1] }}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--surface-0)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: 36,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          padding: "0 var(--space-3)",
          backgroundColor: "var(--surface-1)",
          borderBottom: "var(--border-1)",
          userSelect: "none",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--text-secondary)",
            flexShrink: 0,
          }}
        >
          #{number}
        </span>
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-xs)",
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
          title={title}
        >
          {title}
        </span>
        <span style={{ flex: 1 }} />
        <span
          className="tabular"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
            flexShrink: 0,
          }}
        >
          {totals.files} file{totals.files === 1 ? "" : "s"} ·{" "}
          <span style={{ color: "var(--diff-add-fg)" }}>+{totals.add}</span>{" "}
          <span style={{ color: "var(--diff-remove-fg)" }}>−{totals.rem}</span>
        </span>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          backgroundColor: "var(--surface-0)",
        }}
        className="allow-select"
      >
        {raw === null && !error && <Empty label="loading PR diff…" />}
        {raw === null && error && <Empty label={`error: ${error}`} />}
        {raw !== null && sections.length === 0 && (
          <Empty label="no changes in this PR" />
        )}
        {raw !== null && sections.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {sections.map((s) => (
              <FileBlock key={s.path} section={s} />
            ))}
          </div>
        )}
      </div>
    </motion.div>
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
