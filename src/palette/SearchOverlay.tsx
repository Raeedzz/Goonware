import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { backdropVariants, paletteVariants } from "@/design/motion";
import { search, type SearchHit } from "@/lib/search";
import { fs, claudeConfig, type McpEntry, type SkillEntry } from "@/lib/fs";
import { FileTypeIcon } from "@/files/FileTypeIcon";
import { IconSparkles } from "@/design/icons";
import { useToast } from "@/primitives/Toast";
import {
  useActiveProject,
  useActiveWorktree,
  useAppDispatch,
  useAppState,
} from "@/state/AppState";

type Mode = "files" | "text" | "regex" | "skills";

const MODE_LABELS: Record<Mode, string> = {
  files: "files",
  text: "literal",
  regex: "regex",
  skills: "skills",
};

// Tab cycles through these in order. Files is first because that's
// what opens by default and what most users will want; literal and
// regex are progressively-more-precise alternates for power users.
// Skills lives at the end of the rotation — same set the user can
// browse from the right-panel Skills tab, here exposed as a fuzzy
// pop-up search.
const MODE_ORDER: Mode[] = ["files", "text", "regex", "skills"];

/**
 * A row in the overlay's result list. Files / matches come from rg;
 * skill / mcp entries come from the local Claude Code config and live
 * entirely client-side. Discriminated on `kind` so the row renderer
 * and the open handler can branch on shape without duck-typing.
 */
type ResultItem =
  | { kind: "file"; path: string }
  | { kind: "match"; hit: SearchHit }
  | { kind: "skill"; skill: SkillEntry }
  | { kind: "mcp"; mcp: McpEntry };

/**
 * ⌘⇧F search overlay (Task #15).
 *
 * Three modes — files (rg --files + fuzzy), text (rg literal), regex
 * (rg regex). Tab cycles. Enter on a result opens the file as a tab
 * in the active worktree; content matches scroll the editor to the
 * matched line and flash it.
 *
 * Filtering is debounced 80ms for the file picker and 220ms for
 * content modes so we don't spawn a new rg per keystroke.
 */
export function SearchOverlay() {
  const { searchOpen } = useAppState();
  const dispatch = useAppDispatch();
  const close = () => dispatch({ type: "set-search", open: false });

  return (
    <AnimatePresence>
      {searchOpen && (
        <motion.div
          key="search-backdrop"
          variants={backdropVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          onClick={close}
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "var(--backdrop)",
            zIndex: "var(--z-modal-backdrop)",
            display: "grid",
            placeItems: "start center",
            paddingTop: "min(15vh, 160px)",
          }}
        >
          <motion.div
            key="search"
            variants={paletteVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(720px, 90vw)",
              // Fixed height: the modal occupies the same vertical
              // slot regardless of how many results are in the list.
              // Previously it collapsed to the input+footer when the
              // list was empty, which made switching between modes
              // feel jumpy. The list itself takes flex:1 inside, so
              // any empty space lands at the bottom of the list area.
              height: "min(70vh, 600px)",
              backgroundColor: "var(--surface-2)",
              borderRadius: "var(--radius-lg)",
              boxShadow: "var(--shadow-modal)",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              zIndex: "var(--z-modal)",
            }}
          >
            <SearchInner onClose={close} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function SearchInner({ onClose }: { onClose: () => void }) {
  const project = useActiveProject();
  const worktree = useActiveWorktree();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  // Default to file-picker mode so the overlay opens to a useful
  // list immediately — typing filters the list, Tab swaps into the
  // content-search modes for power users.
  const [mode, setMode] = useState<Mode>("files");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ResultItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  // Monotonic search counter — every time the (query, mode) pair
  // changes we increment it, and only the in-flight invocation that
  // matches the current counter is allowed to write back into
  // `results`. Without this, fast typing produces a parade of stale
  // Tauri promises landing out of order and the user sees old hits
  // overwrite new ones.
  const searchIdRef = useRef(0);
  // Skills / MCPs are loaded once when the palette opens and cached
  // for the life of this mount. The lists are small (dozens of items
  // total) and don't change while the user is searching, so filtering
  // happens client-side — no IPC per keystroke.
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [mcps, setMcps] = useState<McpEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    Promise.all([claudeConfig.listSkills(), claudeConfig.listMcps()])
      .then(([s, m]) => {
        if (cancelled) return;
        setSkills(s);
        setMcps(m);
      })
      .catch(() => {
        // Silent: the palette still works for the other modes if the
        // skills enumerator fails, and the empty list will surface a
        // helpful "no skills found" message.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Open the file behind a result row as a markdown tab in the active
   * worktree's main column. Both ripgrep and the file picker hand us
   * paths relative to the project root; we resolve to absolute here
   * so `fs.readTextFile` (which expects absolute paths) doesn't fail
   * silently and leave the user staring at a closed overlay with no
   * new tab. For content hits we also pass `openAt` so the editor
   * scrolls to the match line and briefly flashes it.
   */
  const openItem = async (item: ResultItem) => {
    if (!worktree || !project) {
      onClose();
      return;
    }

    // Skill rows open the SKILL.md directly without any project-root
    // resolution — the path is already absolute (under ~/.claude).
    // MCP rows are descriptive only; there's no markdown body to route
    // into a tab, so we surface the summary as a toast and keep the
    // palette open so the user can pick another result.
    if (item.kind === "skill") {
      const id = `t_skill_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      dispatch({
        type: "open-tab",
        tab: {
          id,
          worktreeId: worktree.id,
          kind: "markdown",
          filePath: item.skill.path,
          mode: "preview",
          content: null,
          savedContent: null,
          title: item.skill.name,
          summary: `skill · ${item.skill.source}`,
          summaryUpdatedAt: Date.now(),
        },
      });
      onClose();
      return;
    }
    if (item.kind === "mcp") {
      toast.show({
        message:
          `${item.mcp.name} (${item.mcp.kind})` +
          (item.mcp.summary ? ` — ${item.mcp.summary}` : ""),
      });
      return;
    }

    const rawPath = item.kind === "file" ? item.path : item.hit.path;
    // Strip the `./` rg sometimes emits, then join with project.path
    // if the path isn't already absolute. macOS absolute paths start
    // with `/`; nothing else in either rg or fs.readDir output does.
    const cleaned = rawPath.replace(/^\.\//, "");
    const absPath = cleaned.startsWith("/")
      ? cleaned
      : `${project.path}/${cleaned}`;
    try {
      const content = await fs.readTextFile(absPath);
      const id = `t_${Date.now().toString(36)}`;
      dispatch({
        type: "open-tab",
        tab: {
          id,
          worktreeId: worktree.id,
          kind: "markdown",
          filePath: absPath,
          mode: "edit",
          content,
          // Search-overlay opens land with content already read from
          // disk, so the tab starts in-sync (savedContent === content).
          savedContent: content,
          title: absPath.split("/").pop() ?? absPath,
          summary: absPath,
          summaryUpdatedAt: Date.now(),
          openAt:
            item.kind === "match"
              ? { line: item.hit.line, column: item.hit.column }
              : undefined,
        },
      });
      onClose();
    } catch (err) {
      // Surface the failure instead of silently dropping it — the
      // common case was the user thinking the search results were
      // broken when actually the path resolution had bugged out.
      // Keep the overlay open so the user can pick another row.
      toast.show({ message: `Couldn't open ${cleaned}: ${err}` });
    }
  };

  // Debounced search. Every mode shows the file list when the query
  // is empty so the modal opens with something useful no matter what
  // the user last left the mode as; once they type, the content
  // modes (literal / regex) switch to actual content search while
  // files mode just fuzzy-filters the same list. Skills mode is
  // client-side only — the data was loaded once when the palette
  // opened, so there's no debounce, no IPC, and no error path.
  useEffect(() => {
    if (mode === "skills") {
      const q = query.trim().toLowerCase();
      const filteredSkills = q
        ? skills.filter((s) => matchesSkill(s, q))
        : skills;
      const filteredMcps = q ? mcps.filter((m) => matchesMcp(m, q)) : mcps;
      const next: ResultItem[] = [
        ...filteredSkills.map<ResultItem>((skill) => ({
          kind: "skill",
          skill,
        })),
        ...filteredMcps.map<ResultItem>((mcp) => ({ kind: "mcp", mcp })),
      ];
      setError(null);
      setResults(next);
      setCursor(0);
      return;
    }

    if (!project) return;

    const isFileMode = mode === "files";
    const hasQuery = query.trim().length > 0;
    // Bump the counter *outside* the timeout so we capture the value
    // at debounce-schedule time. The timeout callback compares its
    // captured id against the ref's current value before committing
    // results — a newer keystroke will have bumped the ref past it,
    // and this callback's writes get dropped.
    const myId = ++searchIdRef.current;
    setError(null);
    const t = window.setTimeout(async () => {
      try {
        let next: ResultItem[];
        if (isFileMode || !hasQuery) {
          // Files-as-default: drives both `files` mode and the
          // empty-query state of every content mode. No query → list
          // every file (capped at 200); with a query in files mode →
          // fuzzy-filter the same path set server-side.
          const paths = await search.files(
            project.path,
            isFileMode ? query : "",
            200,
          );
          next = paths.map((path) => ({ kind: "file", path }));
        } else {
          const hits = await search.rg(project.path, query, mode === "regex");
          next = hits.map((hit) => ({ kind: "match", hit }));
        }
        // Drop the response if a newer search has been scheduled
        // while this one was in flight. Without this guard, a slow
        // regex finishing after a faster successor would overwrite
        // the user's current results.
        if (myId !== searchIdRef.current) return;
        setResults(next);
        setCursor(0);
      } catch (e) {
        if (myId !== searchIdRef.current) return;
        setError(String(e));
        setResults([]);
      }
    }, isFileMode || !hasQuery ? 80 : 220);
    return () => window.clearTimeout(t);
  }, [project, query, mode, skills, mcps]);

  const cycleMode = () => {
    setMode((m) => {
      const idx = MODE_ORDER.indexOf(m);
      return MODE_ORDER[(idx + 1) % MODE_ORDER.length];
    });
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = results[cursor];
      if (item) void openItem(item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      e.preventDefault();
      cycleMode();
    }
  };

  const placeholder = useMemo(() => {
    if (mode === "files") return "Search files…";
    if (mode === "text") return "Search literal text…";
    if (mode === "skills") return "Search skills & MCPs…";
    return "Search regex…";
  }, [mode]);

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "0 var(--space-4)",
          borderBottom: "var(--border-1)",
          height: 44,
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKey}
          placeholder={placeholder}
          className="allow-select"
          style={{
            flex: 1,
            backgroundColor: "transparent",
            border: "none",
            outline: "none",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-md)",
            color: "var(--text-primary)",
          }}
        />
        <ModePill mode={mode} onCycle={cycleMode} />
      </div>

      <div
        role="listbox"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "var(--space-1) 0",
        }}
      >
        {/* No `searching…` overlay — it floated on top of the previous
            result set and made every keystroke feel like a flicker.
            The cancellation-id guard above keeps stale searches from
            clobbering newer ones, so we can safely leave the prior
            results in place until the next batch arrives. */}
        {error && <Hint label={error} tone="error" />}
        {!error && results.length === 0 && (
          <Hint
            label={
              query.trim()
                ? mode === "files"
                  ? "no matching files"
                  : mode === "skills"
                    ? "no matching skills or MCPs"
                    : "no matches"
                : mode === "skills"
                  ? "no skills or MCPs installed"
                  : "no files in this project"
            }
          />
        )}
        {results.map((item, i) => (
          <ResultRow
            key={resultKey(item, i)}
            item={item}
            active={i === cursor}
            onClick={() => void openItem(item)}
            onMouseEnter={() => setCursor(i)}
          />
        ))}
      </div>

      <Footer
        mode={mode}
        count={results.length}
        // Noun follows what's actually in the list, not the mode pill —
        // an empty-query literal mode still shows files, and saying
        // "0 matches · literal" while a file list is on screen
        // would be lying about what's there.
        countNoun={countNounFor(results)}
      />
    </>
  );
}

function resultKey(item: ResultItem, i: number): string {
  switch (item.kind) {
    case "file":
      return `file:${item.path}:${i}`;
    case "match":
      return `match:${item.hit.path}:${item.hit.line}:${item.hit.column}:${i}`;
    case "skill":
      return `skill:${item.skill.id}`;
    case "mcp":
      return `mcp:${item.mcp.id}`;
  }
}

function countNounFor(results: ResultItem[]): "file" | "match" | "item" {
  if (results.length === 0) return "file";
  const first = results[0].kind;
  if (first === "match") return "match";
  if (first === "skill" || first === "mcp") return "item";
  return "file";
}

function matchesSkill(s: SkillEntry, q: string): boolean {
  return (
    s.name.toLowerCase().includes(q) ||
    s.description.toLowerCase().includes(q) ||
    s.source.toLowerCase().includes(q)
  );
}

function matchesMcp(m: McpEntry, q: string): boolean {
  return (
    m.name.toLowerCase().includes(q) ||
    m.summary.toLowerCase().includes(q) ||
    m.source.toLowerCase().includes(q) ||
    m.kind.toLowerCase().includes(q)
  );
}

function ModePill({ mode, onCycle }: { mode: Mode; onCycle: () => void }) {
  return (
    <button
      type="button"
      onClick={onCycle}
      title="cycle mode (Tab)"
      style={{
        height: 24,
        padding: "0 var(--space-2)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--weight-medium)",
        color: "var(--text-secondary)",
        backgroundColor: "var(--surface-3)",
        border: "var(--border-1)",
        borderRadius: "var(--radius-sm)",
        cursor: "default",
      }}
    >
      {MODE_LABELS[mode]}
    </button>
  );
}

function ResultRow({
  item,
  active,
  onClick,
  onMouseEnter,
}: {
  item: ResultItem;
  active: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}) {
  if (item.kind === "skill" || item.kind === "mcp") {
    return (
      <SkillResultRow
        item={item}
        active={active}
        onClick={onClick}
        onMouseEnter={onMouseEnter}
      />
    );
  }
  // The file-type icon uses the same library + sizing as the right-
  // panel file tree, so a `.ts` hit in the overlay reads as the same
  // glyph the user sees in the tree — no visual stutter when they
  // jump between the two surfaces.
  const path = item.kind === "file" ? item.path : item.hit.path;
  const filename = path.split("/").pop() ?? path;
  const dirname = path.includes("/")
    ? path.slice(0, path.lastIndexOf("/"))
    : "";
  return (
    <div
      role="option"
      aria-selected={active}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      style={{
        display: "flex",
        alignItems: item.kind === "file" ? "center" : "flex-start",
        gap: "var(--space-2)",
        padding:
          item.kind === "file"
            ? "var(--space-1) var(--space-4)"
            : "var(--space-1-5) var(--space-4)",
        backgroundColor: active ? "var(--surface-3)" : "transparent",
        cursor: "default",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 16,
          height: 16,
          flexShrink: 0,
          marginTop: item.kind === "file" ? 0 : 2,
        }}
      >
        <FileTypeIcon name={filename} isDir={false} size={14} />
      </span>
      {item.kind === "file" ? (
        // File-picker row: filename prominent, dirname trailing in
        // tertiary so the user can still see which copy of `index.ts`
        // they're picking from. One line per file — there's no
        // snippet to render.
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "baseline",
            gap: "var(--space-2)",
            overflow: "hidden",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-sm)",
              color: "var(--text-primary)",
              fontWeight: "var(--weight-medium)",
              flexShrink: 0,
            }}
          >
            {filename}
          </span>
          {dirname && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-2xs)",
                color: "var(--text-tertiary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
            >
              {dirname}
            </span>
          )}
        </div>
      ) : (
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: "var(--space-2)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-2xs)",
            }}
          >
            <span
              style={{
                color: "var(--text-secondary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: "60%",
              }}
            >
              {item.hit.path}
            </span>
            <span className="tabular" style={{ color: "var(--text-tertiary)" }}>
              {item.hit.line}:{item.hit.column}
            </span>
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-sm)",
              fontVariantLigatures: "none",
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.hit.text}
          </div>
        </div>
      )}
    </div>
  );
}

function SkillResultRow({
  item,
  active,
  onClick,
  onMouseEnter,
}: {
  item: { kind: "skill"; skill: SkillEntry } | { kind: "mcp"; mcp: McpEntry };
  active: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}) {
  const isSkill = item.kind === "skill";
  const name = isSkill ? item.skill.name : item.mcp.name;
  const detail = isSkill ? item.skill.description : item.mcp.summary;
  const source = isSkill ? item.skill.source : item.mcp.source;
  const sourceLabel = source === "user" ? "user" : source;
  return (
    <div
      role="option"
      aria-selected={active}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "var(--space-2)",
        padding: "var(--space-1-5) var(--space-4)",
        backgroundColor: active ? "var(--surface-3)" : "transparent",
        cursor: "default",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 16,
          height: 16,
          marginTop: 2,
          flexShrink: 0,
          color: "var(--text-tertiary)",
        }}
      >
        <IconSparkles size={14} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: "var(--space-2)",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-medium)",
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </span>
          <span
            className="tabular"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--text-tertiary)",
              padding: "0 5px",
              border: "var(--border-1)",
              borderRadius: "var(--radius-xs)",
              backgroundColor: "var(--surface-2)",
              flexShrink: 0,
            }}
          >
            {isSkill ? "skill" : `mcp · ${item.mcp.kind}`}
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-2xs)",
              color: "var(--text-disabled)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {sourceLabel}
          </span>
        </div>
        {detail && (
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-xs)",
              color: "var(--text-tertiary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              marginTop: 2,
            }}
          >
            {detail}
          </div>
        )}
      </div>
    </div>
  );
}

function Hint({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "error";
}) {
  return (
    <div
      style={{
        padding: "var(--space-6) var(--space-4)",
        textAlign: "center",
        color:
          tone === "error" ? "var(--state-error)" : "var(--text-tertiary)",
        fontSize: "var(--text-sm)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {label}
    </div>
  );
}

function Footer({
  mode,
  count,
  countNoun,
}: {
  mode: Mode;
  count: number;
  countNoun: "file" | "match" | "item";
}) {
  const noun =
    countNoun === "file"
      ? count === 1
        ? "file"
        : "files"
      : countNoun === "match"
        ? count === 1
          ? "match"
          : "matches"
        : count === 1
          ? "item"
          : "items";
  return (
    <div
      style={{
        height: 24,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 var(--space-4)",
        borderTop: "var(--border-1)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        color: "var(--text-tertiary)",
        backgroundColor: "var(--surface-1)",
        userSelect: "none",
      }}
    >
      <span>
        <Mono>↑↓</Mono> navigate · <Mono>Tab</Mono> cycle mode ·{" "}
        <Mono>Enter</Mono> open · <Mono>Esc</Mono> close
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}>
        <span className="tabular">
          {count} {noun} · {MODE_LABELS[mode]}
        </span>
        <span
          style={{
            color: "var(--text-disabled)",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <Mono>⌘K</Mono>
          <span>search</span>
        </span>
      </span>
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-2xs)",
        color: "var(--text-secondary)",
      }}
    >
      {children}
    </span>
  );
}
