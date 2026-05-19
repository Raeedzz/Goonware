import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { git } from "@/lib/git";
import { DiffBody, parseUnifiedDiff, type DiffLine } from "./DiffView";

/**
 * Single scrollable view of every uncommitted change in the worktree
 * — staged + unstaged combined into one HEAD-relative diff. Opened
 * from the chrome's `+N -M` button; the user scrolls top-to-bottom
 * through each file's hunks without flipping between tabs or right-
 * panel rows.
 *
 * One `git diff HEAD` call drives the whole view. The raw output is
 * sliced by `diff --git` boundaries into per-file sections; each
 * section reuses the parser and renderer that the single-file
 * `DiffView` already uses, so add/remove tinting, line numbers, and
 * sigil columns all match. Listens to `rli-git-refresh` so commits/
 * stashes/checkouts elsewhere in the app fold back into this view
 * within the same tick.
 */
export function AllChangesView({ projectPath }: { projectPath: string }) {
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      setLoading(true);
      setError(null);
      git
        .diffAll(projectPath)
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
    };
    refresh();
    const onRefresh = (e: Event) => {
      const detail = (e as CustomEvent<{ cwd?: string }>).detail;
      if (!detail?.cwd || detail.cwd === projectPath) refresh();
    };
    window.addEventListener("gli-git-refresh", onRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener("gli-git-refresh", onRefresh);
    };
  }, [projectPath]);

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
          }}
        >
          changes
        </span>
        <span style={{ color: "var(--text-disabled)" }}>·</span>
        <span
          className="tabular"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
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
        {loading && <Empty label="loading diff…" />}
        {!loading && error && <Empty label={`error: ${error}`} />}
        {!loading && !error && sections.length === 0 && (
          <Empty label="no changes" />
        )}
        {!loading && !error && sections.length > 0 && (
          <FileSections sections={sections} />
        )}
      </div>
    </motion.div>
  );
}

interface FileSection {
  path: string;
  lines: DiffLine[];
  added: number;
  removed: number;
}

function FileSections({ sections }: { sections: FileSection[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {sections.map((s) => (
        <FileBlock key={s.path} section={s} />
      ))}
    </div>
  );
}

function FileBlock({ section }: { section: FileSection }) {
  const [collapsed, setCollapsed] = useState(false);
  const filename = section.path.split("/").pop() ?? section.path;
  const dirname = section.path.includes("/")
    ? section.path.slice(0, section.path.lastIndexOf("/"))
    : "";
  return (
    <section
      style={{
        borderBottom: "var(--border-1)",
      }}
    >
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        style={{
          width: "100%",
          // Sticky inside the scroll container so the file path stays
          // visible while you read down through a long hunk.
          position: "sticky",
          top: 0,
          zIndex: 1,
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          height: 30,
          padding: "0 var(--space-3)",
          backgroundColor: "var(--surface-1)",
          color: "var(--text-secondary)",
          borderBottom: "var(--border-1)",
          textAlign: "left",
          cursor: "default",
        }}
        title={section.path}
      >
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 8,
            color: "var(--text-tertiary)",
            fontSize: "var(--text-2xs)",
            transition: "transform var(--motion-fast) var(--ease-out-quart)",
            transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
          }}
        >
          ▾
        </span>
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
          <span style={{ color: "var(--diff-add-fg)" }}>+{section.added}</span>{" "}
          <span style={{ color: "var(--diff-remove-fg)" }}>
            −{section.removed}
          </span>
        </span>
      </button>
      {!collapsed && (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            fontVariantLigatures: "none",
            backgroundColor: "var(--surface-0)",
          }}
        >
          <DiffBody lines={section.lines} filePath={section.path} />
        </div>
      )}
    </section>
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

/**
 * Slice a multi-file unified diff into one section per file. `diff
 * --git a/<x> b/<x>` is the canonical file boundary; the `b/` path is
 * authoritative for renames (a/ is the old name).
 */
function sliceByFile(raw: string): FileSection[] {
  const out: FileSection[] = [];
  const lines = raw.split("\n");
  let bufStart = -1;
  let path = "";

  const flush = (end: number) => {
    if (bufStart < 0) return;
    const slice = lines.slice(bufStart, end).join("\n");
    const parsed = parseUnifiedDiff(slice);
    let added = 0;
    let removed = 0;
    for (const l of parsed) {
      if (l.kind === "add") added++;
      else if (l.kind === "remove") removed++;
    }
    out.push({ path, lines: parsed, added, removed });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      flush(i);
      bufStart = i;
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      path = m ? m[2] : "unknown";
    }
  }
  flush(lines.length);
  return out;
}
