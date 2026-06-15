import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { IconBranch, IconClose, IconGithub, IconRefresh } from "@/design/icons";
import { ArrowLineDown } from "@phosphor-icons/react";
import { git, type CommitRef, type GraphCommit } from "@/lib/git";
import { computeGraphLayout, type GraphRow } from "./history-graph";
import { BranchSwitcher } from "@/shell/BranchSwitcher";
import { useAppDispatch } from "@/state/AppState";
import type { Worktree } from "@/state/types";
import { useToast } from "@/primitives/Toast";
import { Loader } from "@/primitives/Loader";
import { addProjectAtPath } from "@/lib/projectDialog";

/**
 * History section of the right panel's Changes tab — the git tree.
 *
 * A Fork-style commit graph across ALL refs (local branches, remotes,
 * tags) so pushes to main from teammates are visible right next to
 * local work. The header row carries the repo-level verbs that don't
 * fit the commit composer: switch/create branch, fetch, pull, clone.
 * Clicking a commit opens a commit-detail tab in the main column with
 * the full message, metadata, and per-file diffs.
 *
 * Refresh model mirrors the status poll: a slow ambient interval picks
 * up outside-the-app commits, and `goonware-git-refresh` events (fired
 * by commit/push/merge paths) fold in app-driven changes immediately.
 */

const ROW_H = 26;
const LANE_W = 10;
/** Graph gutter stops widening past this many lanes — deeper lanes
    clamp to the last column so a pathological octopus history can't
    push the subject text off the panel. */
const MAX_LANES = 8;

const LANE_COLORS = [
  "var(--accent)",
  "var(--tag-amber)",
  "var(--tag-moss)",
  "var(--tag-rose)",
  "var(--tag-iris)",
  "var(--tag-pine)",
  "var(--tag-rust)",
  "var(--tag-slate)",
];

const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];

/** Last graph per worktree path — a switch paints the previous tree
    instantly while the fresh `git log` runs in the background. */
const historyCache = new Map<string, GraphCommit[]>();

/** Equality for poll results: a commit is immutable per hash, but its
    decorations (refs) change on push/branch ops — compare both so an
    unchanged tick keeps the old array identity and skips the render. */
function sameGraphCommits(a: GraphCommit[], b: GraphCommit[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].hash !== b[i].hash) return false;
    const ra = a[i].refs;
    const rb = b[i].refs;
    if (ra.length !== rb.length) return false;
    for (let j = 0; j < ra.length; j++) {
      if (ra[j].name !== rb[j].name || ra[j].kind !== rb[j].kind) return false;
    }
  }
  return true;
}

export function HistoryView({
  worktree,
  branch,
  behind,
}: {
  worktree: Worktree;
  branch: string | null;
  behind: number;
}) {
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [commits, setCommits] = useState<GraphCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "fetch" | "pull">(null);
  const [branchAnchor, setBranchAnchor] = useState<{ x: number; y: number } | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);

  const pathRef = useRef(worktree.path);
  useEffect(() => {
    pathRef.current = worktree.path;
  }, [worktree.path]);

  const refresh = useCallback(async () => {
    const path = pathRef.current;
    try {
      const list = await git.logGraph(path, 200);
      if (path !== pathRef.current) return;
      historyCache.set(path, list);
      // Unchanged tick → keep the old array identity so the 200-row
      // list (and its SVG cells) skips the re-render entirely.
      setCommits((prev) =>
        prev && sameGraphCommits(prev, list) ? prev : list,
      );
      setError(null);
    } catch (e) {
      if (path !== pathRef.current) return;
      setError(String(e));
    }
  }, []);

  // The pane sits in a display:none slot whenever another right-panel
  // tab is selected — don't burn a `git log --all -n 200` every 10s
  // for a tree nobody can see. Becoming visible re-runs the effect and
  // refreshes immediately.
  const visible = worktree.rightPanel === "changes";

  useEffect(() => {
    if (worktree.missing === true || !visible) return;
    // Seed from the last result for this path so a worktree switch
    // paints the previous tree instantly instead of "loading history…";
    // the refresh below folds in anything new.
    setCommits(historyCache.get(worktree.path) ?? null);
    setError(null);
    void refresh();
    // 10s ambient tick — slower than the 4s status poll since `git log
    // --all -n 200` is a heavier read and history changes less often
    // than the working tree.
    const t = window.setInterval(() => void refresh(), 10000);
    const onRefresh = (e: Event) => {
      const detail = (e as CustomEvent<{ cwd?: string }>).detail;
      if (!detail?.cwd || detail.cwd === worktree.path) void refresh();
    };
    window.addEventListener("goonware-git-refresh", onRefresh);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("goonware-git-refresh", onRefresh);
    };
  }, [worktree.path, worktree.missing, visible, refresh]);

  const layout = useMemo(
    () => computeGraphLayout(commits ?? []),
    [commits],
  );
  const gutterW = Math.min(layout.laneCount, MAX_LANES) * LANE_W + 6;

  const announceRefresh = () => {
    window.dispatchEvent(
      new CustomEvent("goonware-git-refresh", {
        detail: { cwd: worktree.path },
      }),
    );
  };

  const doFetch = async () => {
    setBusy("fetch");
    try {
      await git.fetch(worktree.path);
      toast.show({ message: "Fetched all remotes." });
      announceRefresh();
    } catch (e) {
      toast.show({ message: `Fetch failed: ${e}` });
    } finally {
      setBusy(null);
    }
  };

  const doPull = async () => {
    setBusy("pull");
    try {
      await git.pull(worktree.path);
      toast.show({ message: "Pulled." });
      announceRefresh();
    } catch (e) {
      toast.show({ message: `Pull failed: ${e}` });
    } finally {
      setBusy(null);
    }
  };

  const openCommit = (commit: GraphCommit) => {
    dispatch({
      type: "open-tab",
      tab: {
        id: `t_commit_${commit.short}_${Date.now().toString(36)}`,
        worktreeId: worktree.id,
        kind: "commit",
        hash: commit.hash,
        title: commit.subject,
        summary: commit.short,
        summaryUpdatedAt: Date.now(),
      },
    });
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: "auto 1fr",
        minHeight: 0,
        height: "100%",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          height: 28,
          padding: "0 var(--space-2) 0 var(--space-3)",
          backgroundColor: "var(--surface-2)",
          borderTop: "var(--border-1)",
          borderBottom: "var(--border-1)",
        }}
      >
        <span
          style={{
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--weight-semibold)",
            textTransform: "uppercase",
            letterSpacing: "var(--tracking-caps)",
            color: "var(--text-tertiary)",
            flexShrink: 0,
          }}
        >
          History
        </span>
        <span style={{ flex: 1 }} />
        <ToolbarButton
          title="Switch or create branch"
          label={branch ?? "branch"}
          icon={<IconBranch size={12} />}
          disabled={busy !== null}
          onClick={(e) =>
            setBranchAnchor({ x: e.clientX - 240, y: e.clientY + 10 })
          }
        />
        <ToolbarButton
          title="Fetch all remotes"
          label="Fetch"
          icon={
            busy === "fetch" ? <Loader size={11} /> : <IconRefresh size={12} />
          }
          disabled={busy !== null}
          onClick={() => void doFetch()}
        />
        <ToolbarButton
          title={
            behind > 0
              ? `Pull ${behind} commit${behind === 1 ? "" : "s"} from upstream`
              : "Pull from upstream"
          }
          label="Pull"
          badge={behind > 0 ? behind : undefined}
          icon={
            busy === "pull" ? (
              <Loader size={11} />
            ) : (
              <PullGlyph />
            )
          }
          disabled={busy !== null}
          onClick={() => void doPull()}
        />
        <ToolbarButton
          title="Clone a repository"
          label="Clone"
          icon={<IconGithub size={12} />}
          disabled={busy !== null}
          onClick={() => setCloneOpen(true)}
        />
      </div>

      <div style={{ minHeight: 0, overflow: "auto" }}>
        {commits === null && !error && (
          <HistoryEmpty label="loading history…" />
        )}
        {error && <HistoryEmpty label={error} tone="error" />}
        {commits !== null && !error && commits.length === 0 && (
          <HistoryEmpty label="no commits yet" />
        )}
        {commits !== null && !error && commits.length > 0 && (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {commits.map((commit, i) => (
              <CommitRow
                key={commit.hash}
                commit={commit}
                row={layout.rows[i]}
                gutterW={gutterW}
                onOpen={() => openCommit(commit)}
              />
            ))}
          </ul>
        )}
      </div>

      <AnimatePresence>
        {branchAnchor && (
          <BranchSwitcher
            cwd={worktree.path}
            anchor={branchAnchor}
            onClose={() => setBranchAnchor(null)}
            onSwitched={() => announceRefresh()}
          />
        )}
      </AnimatePresence>

      {cloneOpen && (
        <CloneDialog
          onClose={() => setCloneOpen(false)}
          onCloned={(path) => {
            setCloneOpen(false);
            const name = path.split("/").pop() ?? path;
            addProjectAtPath(dispatch, path);
            toast.show({ message: `Cloned ${name} — added to projects.` });
          }}
        />
      )}
    </div>
  );
}

function PullGlyph() {
  return <ArrowLineDown size={12} />;
}

function ToolbarButton({
  title,
  label,
  icon,
  badge,
  disabled,
  onClick,
}: {
  title: string;
  label: string;
  icon: React.ReactNode;
  badge?: number;
  disabled?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        height: 20,
        padding: "0 6px",
        maxWidth: 110,
        borderRadius: "var(--radius-xs)",
        color: disabled ? "var(--text-disabled)" : "var(--text-tertiary)",
        backgroundColor: "transparent",
        fontSize: "var(--text-2xs)",
        cursor: disabled ? "default" : "pointer",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart), color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.backgroundColor = "var(--surface-3)";
        e.currentTarget.style.color = "var(--text-primary)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "transparent";
        e.currentTarget.style.color = disabled
          ? "var(--text-disabled)"
          : "var(--text-tertiary)";
      }}
    >
      <span style={{ display: "inline-flex", flexShrink: 0 }}>{icon}</span>
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {badge !== undefined && (
        <span
          className="tabular"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            minWidth: 14,
            height: 13,
            padding: "0 3px",
            borderRadius: "var(--radius-pill)",
            fontSize: 9,
            fontWeight: "var(--weight-semibold)",
            color: "var(--text-primary)",
            backgroundColor: "var(--surface-4)",
            flexShrink: 0,
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------
   Commit rows
   ------------------------------------------------------------------ */

function CommitRow({
  commit,
  row,
  gutterW,
  onOpen,
}: {
  commit: GraphCommit;
  row: GraphRow | undefined;
  gutterW: number;
  onOpen: () => void;
}) {
  const isHead = commit.refs.some((r) => r.kind === "head");
  const shown = commit.refs.slice(0, 2);
  const extra = commit.refs.length - shown.length;
  return (
    <li>
      <div
        onClick={onOpen}
        title={`${commit.subject}\n${commit.author} <${commit.email}>\n${commit.short}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: ROW_H,
          padding: "0 var(--space-3) 0 var(--space-2)",
          cursor: "pointer",
          backgroundColor: "transparent",
          transition:
            "background-color var(--motion-instant) var(--ease-out-quart)",
        }}
        onMouseOver={(e) =>
          (e.currentTarget.style.backgroundColor = "var(--surface-2)")
        }
        onMouseOut={(e) =>
          (e.currentTarget.style.backgroundColor = "transparent")
        }
      >
        {row && <GraphCell row={row} width={gutterW} head={isHead} />}
        {shown.map((r) => (
          <RefChip key={`${r.kind}:${r.name}`} r={r} />
        ))}
        {extra > 0 && (
          <span
            style={{
              fontSize: 9,
              color: "var(--text-tertiary)",
              flexShrink: 0,
            }}
          >
            +{extra}
          </span>
        )}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: "var(--text-xs)",
            color: isHead ? "var(--text-primary)" : "var(--text-secondary)",
            fontWeight: isHead
              ? "var(--weight-medium)"
              : "var(--weight-regular)",
          }}
        >
          {commit.subject}
        </span>
        <AuthorDot name={commit.author} />
        <span
          className="tabular"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            color: "var(--text-disabled)",
            flexShrink: 0,
          }}
        >
          {commit.short.slice(0, 7)}
        </span>
        <span
          style={{
            fontSize: 9,
            color: "var(--text-tertiary)",
            flexShrink: 0,
            minWidth: 44,
            textAlign: "right",
          }}
        >
          {formatCommitTime(commit.timestamp)}
        </span>
      </div>
    </li>
  );
}

/** One row's slice of the railway graph. Lanes past MAX_LANES clamp
    to the last visible column rather than widening the gutter. */
function GraphCell({
  row,
  width,
  head,
}: {
  row: GraphRow;
  width: number;
  head: boolean;
}) {
  const x = (lane: number) => Math.min(lane, MAX_LANES - 1) * LANE_W + 5;
  const mid = ROW_H / 2;
  const nodeX = x(row.lane);
  const paths: React.ReactNode[] = [];

  for (const p of row.passes) {
    paths.push(
      <path
        key={`p${p.lane}`}
        d={`M ${x(p.lane)} 0 V ${ROW_H}`}
        stroke={laneColor(p.color)}
        strokeWidth={1.5}
        fill="none"
      />,
    );
  }
  for (const s of row.ins) {
    const sx = x(s.lane);
    paths.push(
      <path
        key={`i${s.lane}`}
        d={
          sx === nodeX
            ? `M ${sx} 0 V ${mid}`
            : `M ${sx} 0 C ${sx} ${mid - 4}, ${nodeX} ${mid - 8}, ${nodeX} ${mid}`
        }
        stroke={laneColor(s.color)}
        strokeWidth={1.5}
        fill="none"
      />,
    );
  }
  for (const s of row.outs) {
    const sx = x(s.lane);
    paths.push(
      <path
        key={`o${s.lane}`}
        d={
          sx === nodeX
            ? `M ${sx} ${mid} V ${ROW_H}`
            : `M ${nodeX} ${mid} C ${nodeX} ${mid + 8}, ${sx} ${mid + 4}, ${sx} ${ROW_H}`
        }
        stroke={laneColor(s.color)}
        strokeWidth={1.5}
        fill="none"
      />,
    );
  }

  return (
    <svg
      width={width}
      height={ROW_H}
      style={{ flexShrink: 0, display: "block" }}
      aria-hidden
    >
      {paths}
      {head && (
        <circle
          cx={nodeX}
          cy={mid}
          r={5}
          fill="none"
          stroke={laneColor(row.color)}
          strokeWidth={1}
          opacity={0.5}
        />
      )}
      <circle cx={nodeX} cy={mid} r={3} fill={laneColor(row.color)} />
    </svg>
  );
}

function refChipStyle(kind: CommitRef["kind"]): CSSProperties {
  const tint =
    kind === "head"
      ? "var(--accent-bright)"
      : kind === "branch"
        ? "var(--tag-amber)"
        : kind === "tag"
          ? "var(--tag-moss)"
          : "var(--text-tertiary)";
  return {
    display: "inline-flex",
    alignItems: "center",
    maxWidth: 96,
    height: 15,
    padding: "0 5px",
    borderRadius: "var(--radius-xs)",
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    color: tint,
    backgroundColor: `color-mix(in oklch, transparent, ${tint} 12%)`,
    border: `1px solid color-mix(in oklch, transparent, ${tint} 30%)`,
    flexShrink: 0,
  };
}

function RefChip({ r }: { r: CommitRef }) {
  return (
    <span style={refChipStyle(r.kind)} title={r.name}>
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {r.name}
      </span>
    </span>
  );
}

/** Deterministic initial-letter avatar — offline-friendly stand-in
    for the author photos a hosted GUI would show. */
export function AuthorDot({ name, size = 14 }: { name: string; size?: number }) {
  const color = LANE_COLORS[authorHue(name)];
  return (
    <span
      title={name}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "var(--radius-pill)",
        backgroundColor: `color-mix(in oklch, transparent, ${color} 28%)`,
        color,
        fontSize: size <= 14 ? 8 : 11,
        fontWeight: "var(--weight-semibold)",
        flexShrink: 0,
        textTransform: "uppercase",
      }}
    >
      {name.trim().charAt(0) || "?"}
    </span>
  );
}

function authorHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return h % LANE_COLORS.length;
}

/** Compact absolute times tuned for a narrow column: today → clock
    time, yesterday → "Yesterday", this year → "Jun 1", else "6/1/25". */
export function formatCommitTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const now = new Date();
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDelta = Math.round(
    (startOfDay(now) - startOfDay(d)) / 86_400_000,
  );
  if (dayDelta === 0) {
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  if (dayDelta === 1) return "Yesterday";
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }
  return d.toLocaleDateString(undefined, {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  });
}

function HistoryEmpty({
  label,
  tone,
}: {
  label: string;
  tone?: "error";
}) {
  return (
    <div
      style={{
        padding: "var(--space-4) var(--space-3)",
        color: tone === "error" ? "var(--state-error)" : "var(--text-tertiary)",
        fontSize: "var(--text-xs)",
        wordBreak: "break-word",
      }}
    >
      {label}
    </div>
  );
}

/* ------------------------------------------------------------------
   Clone dialog — URL + destination folder, clones into
   <destination>/<repo-name> and registers the result as a project.
   ------------------------------------------------------------------ */

function CloneDialog({
  onClose,
  onCloned,
}: {
  onClose: () => void;
  onCloned: (path: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [dest, setDest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const pickDest = async () => {
    try {
      const selected = await openFolderDialog({
        directory: true,
        multiple: false,
        title: "Clone into folder",
      });
      if (typeof selected === "string") setDest(selected);
    } catch {
      // Dialog plugin unavailable (vite-only run) — leave dest unset.
    }
  };

  const canClone = url.trim().length > 0 && dest !== null && !busy;

  const doClone = async () => {
    if (!canClone || dest === null) return;
    setBusy(true);
    setError(null);
    try {
      const path = await git.clone(url.trim(), dest);
      onCloned(path);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const field: CSSProperties = {
    width: "100%",
    height: 26,
    padding: "0 var(--space-2)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    color: "var(--text-primary)",
    backgroundColor: "var(--surface-0)",
    border: "var(--border-1)",
    borderRadius: "var(--radius-sm)",
    outline: "none",
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: "var(--z-modal-backdrop)",
        backgroundColor: "var(--backdrop)",
        display: "grid",
        placeItems: "center",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        role="dialog"
        aria-label="Clone repository"
        style={{
          width: 380,
          backgroundColor: "var(--surface-2)",
          border: "var(--border-2)",
          borderRadius: "var(--radius-md)",
          boxShadow: "var(--shadow-modal)",
          zIndex: "var(--z-modal)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: 34,
            padding: "0 var(--space-2) 0 var(--space-3)",
            borderBottom: "var(--border-1)",
          }}
        >
          <span
            style={{
              fontSize: "var(--text-xs)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--text-primary)",
            }}
          >
            Clone repository
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            aria-label="Close"
            onClick={() => !busy && onClose()}
            style={{
              width: 24,
              height: 24,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-tertiary)",
              borderRadius: "var(--radius-xs)",
              cursor: "pointer",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = "var(--surface-3)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = "transparent")
            }
          >
            <IconClose size={12} />
          </button>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
            padding: "var(--space-3)",
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={url}
            disabled={busy}
            placeholder="git@github.com:org/repo.git or https://…"
            spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doClone();
            }}
            style={field}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void pickDest()}
            title="Choose the parent folder to clone into"
            style={{
              ...field,
              display: "flex",
              alignItems: "center",
              textAlign: "left",
              cursor: busy ? "default" : "pointer",
              color: dest ? "var(--text-primary)" : "var(--text-tertiary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {dest ?? "Choose destination folder…"}
          </button>

          {error && (
            <div
              style={{
                padding: "var(--space-1) var(--space-2)",
                backgroundColor: "var(--state-error-bg)",
                borderRadius: "var(--radius-sm)",
                color: "var(--state-error-bright)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-2xs)",
                wordBreak: "break-word",
                maxHeight: 120,
                overflow: "auto",
              }}
            >
              {error}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              disabled={!canClone}
              onClick={() => void doClone()}
              style={{
                height: 26,
                minWidth: 84,
                padding: "0 12px",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                backgroundColor: canClone
                  ? "var(--surface-accent-tinted)"
                  : "var(--surface-3)",
                color: canClone ? "var(--text-primary)" : "var(--text-disabled)",
                border: canClone
                  ? "1px solid var(--accent-muted)"
                  : "var(--border-1)",
                borderRadius: "var(--radius-sm)",
                fontSize: "var(--text-2xs)",
                fontWeight: "var(--weight-semibold)",
                cursor: canClone ? "pointer" : "default",
              }}
            >
              {busy ? (
                <>
                  <Loader size={11} /> Cloning…
                </>
              ) : (
                "Clone"
              )}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
