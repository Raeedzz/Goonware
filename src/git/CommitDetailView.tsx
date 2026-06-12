import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { git, type CommitDetail } from "@/lib/git";
import { FileBlock, sliceByFile, type FileSection } from "./AllChangesView";
import { AuthorAvatar } from "./Avatar";
import { DiffAskOverlay, reconstructDiffContext } from "./DiffAsk";
import { useAppDispatch } from "@/state/AppState";
import { IconCopy } from "@/design/icons";
import { useToast } from "@/primitives/Toast";

/**
 * Main-column tab for one commit from the history graph: metadata
 * header (author, date, sha, parents, refs, full message) above the
 * complete diff the commit introduced, sliced per-file with the same
 * collapsible blocks the all-changes view uses. Read-only by design —
 * the right panel owns the verbs; this tab is for reading what landed.
 */
export function CommitDetailView({
  cwd,
  hash,
  worktreeId,
}: {
  cwd: string;
  hash: string;
  worktreeId: string;
}) {
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setRaw(null);
    setError(null);
    Promise.all([git.commitDetail(cwd, hash), git.commitDiff(cwd, hash)])
      .then(([d, diff]) => {
        if (cancelled) return;
        setDetail(d);
        setRaw(diff);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, hash]);

  const sections = useMemo<FileSection[]>(
    () => (raw ? sliceByFile(raw) : []),
    [raw],
  );

  const totals = useMemo(() => {
    let add = 0;
    let rem = 0;
    for (const s of sections) {
      add += s.added;
      rem += s.removed;
    }
    return { add, rem };
  }, [sections]);

  // Open a parent commit in this same tab's worktree — lets the user
  // walk up the chain without going back to the graph.
  const openParent = (parent: string) => {
    dispatch({
      type: "open-tab",
      tab: {
        id: `t_commit_${parent.slice(0, 7)}_${Date.now().toString(36)}`,
        worktreeId,
        kind: "commit",
        hash: parent,
        title: parent.slice(0, 7),
        summary: parent.slice(0, 7),
        summaryUpdatedAt: Date.now(),
      },
    });
  };

  const copySha = () => {
    void navigator.clipboard.writeText(hash);
    toast.show({ message: "SHA copied." });
  };

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
            backgroundColor: "var(--accent)",
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
          commit
        </span>
        <span
          className="tabular"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
          }}
        >
          {hash.slice(0, 10)}
        </span>
        <span style={{ flex: 1 }} />
        {raw !== null && sections.length > 0 && (
          <span
            className="tabular"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-2xs)",
              color: "var(--text-tertiary)",
            }}
          >
            {sections.length} file{sections.length === 1 ? "" : "s"} ·{" "}
            <span style={{ color: "var(--diff-add-fg)" }}>+{totals.add}</span>{" "}
            <span style={{ color: "var(--diff-remove-fg)" }}>
              −{totals.rem}
            </span>
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        style={{ flex: 1, minHeight: 0, overflow: "auto" }}
        className="allow-select"
      >
        {error && <Empty label={`error: ${error}`} />}
        {!error && detail === null && <Empty label="loading commit…" />}
        {!error && detail !== null && (
          <>
            <CommitHeader
              detail={detail}
              onCopySha={copySha}
              onOpenParent={openParent}
            />
            {raw === null && <Empty label="loading diff…" />}
            {raw !== null && sections.length === 0 && (
              <Empty label="no textual changes (empty or merge commit)" />
            )}
            {raw !== null && sections.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {sections.map((s) => (
                  <FileBlock key={s.path} section={s} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {raw !== null && sections.length > 0 && (
        <DiffAskOverlay
          containerRef={scrollRef}
          resolve={(range) => {
            // Same per-file resolution the all-changes view uses: find
            // which file block the selection landed in and hand that
            // file's reconstructed diff to the ask card as context.
            const node: Node | null = range.commonAncestorContainer;
            const el =
              node instanceof HTMLElement ? node : node?.parentElement ?? null;
            const fileEl = el?.closest<HTMLElement>("[data-diff-file]");
            const path = fileEl?.dataset.diffFile;
            const section = path
              ? sections.find((s) => s.path === path)
              : undefined;
            if (!section) return null;
            return {
              path: section.path,
              diff: reconstructDiffContext(section.lines),
            };
          }}
        />
      )}
    </motion.div>
  );
}

function CommitHeader({
  detail,
  onCopySha,
  onOpenParent,
}: {
  detail: CommitDetail;
  onCopySha: () => void;
  onOpenParent: (hash: string) => void;
}) {
  return (
    <div
      style={{
        padding: "var(--space-4)",
        borderBottom: "var(--border-1)",
        backgroundColor: "var(--surface-1)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
        }}
      >
        <AuthorAvatar name={detail.author} email={detail.email} size={32} />
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--text-primary)",
            }}
          >
            {detail.author}{" "}
            <span
              style={{
                fontWeight: "var(--weight-regular)",
                color: "var(--text-tertiary)",
                fontSize: "var(--text-xs)",
              }}
            >
              {detail.email}
            </span>
          </span>
          <span
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--text-tertiary)",
            }}
          >
            {detail.date} · {detail.relative_time}
          </span>
        </div>
        <span style={{ flex: 1 }} />
        {detail.refs.map((r) => (
          <span
            key={`${r.kind}:${r.name}`}
            title={r.name}
            style={{
              display: "inline-flex",
              alignItems: "center",
              maxWidth: 140,
              height: 18,
              padding: "0 6px",
              borderRadius: "var(--radius-xs)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-2xs)",
              color:
                r.kind === "head"
                  ? "var(--accent-bright)"
                  : r.kind === "branch"
                    ? "var(--tag-amber)"
                    : r.kind === "tag"
                      ? "var(--tag-moss)"
                      : "var(--text-tertiary)",
              border: "var(--border-2)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {r.name}
          </span>
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          columnGap: "var(--space-3)",
          rowGap: "var(--space-1)",
          alignItems: "center",
        }}
      >
        <MetaLabel>sha</MetaLabel>
        <span
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          <span
            className="tabular allow-select"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--text-secondary)",
              wordBreak: "break-all",
            }}
          >
            {detail.hash}
          </span>
          <button
            type="button"
            title="Copy full SHA"
            aria-label="Copy full SHA"
            onClick={onCopySha}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 20,
              height: 20,
              color: "var(--text-tertiary)",
              borderRadius: "var(--radius-xs)",
              cursor: "pointer",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "var(--surface-3)";
              e.currentTarget.style.color = "var(--text-primary)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
              e.currentTarget.style.color = "var(--text-tertiary)";
            }}
          >
            <IconCopy size={11} />
          </button>
        </span>
        {detail.parents.length > 0 && (
          <>
            <MetaLabel>
              parent{detail.parents.length === 1 ? "" : "s"}
            </MetaLabel>
            <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {detail.parents.map((p) => (
                <button
                  key={p}
                  type="button"
                  title={`Open ${p}`}
                  onClick={() => onOpenParent(p)}
                  className="tabular"
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs)",
                    color: "var(--accent)",
                    backgroundColor: "transparent",
                    cursor: "pointer",
                    textDecoration: "underline",
                    textUnderlineOffset: 2,
                    padding: 0,
                  }}
                >
                  {p.slice(0, 8)}
                </button>
              ))}
            </span>
          </>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span
          className="allow-select"
          style={{
            fontSize: "var(--text-md)",
            lineHeight: "var(--leading-md)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--text-primary)",
          }}
        >
          {detail.subject}
        </span>
        {detail.body && (
          <pre
            className="allow-select"
            style={{
              margin: 0,
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-xs)",
              lineHeight: "var(--leading-xs)",
              color: "var(--text-secondary)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {detail.body}
          </pre>
        )}
      </div>
    </div>
  );
}

function MetaLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--weight-semibold)",
        textTransform: "uppercase",
        letterSpacing: "var(--tracking-caps)",
        color: "var(--text-tertiary)",
      }}
    >
      {children}
    </span>
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
