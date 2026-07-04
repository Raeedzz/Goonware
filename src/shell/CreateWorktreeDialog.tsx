import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { motion, AnimatePresence } from "motion/react";
import { useAppDispatch, useAppState } from "@/state/AppState";
import {
  applyBranchPrefix,
  projectSettings,
  TAG_IDS,
  type Project,
  type TagId,
} from "@/state/types";
import {
  nextAutoBranch,
  primaryTerminalTab,
  worktreeCreate,
} from "@/lib/worktrees";
import { PICKER_ICONS } from "@/design/picker-icons";
import { ColorSwatch, IconCell, SearchGlyph } from "@/shell/IconPickerDialog";
import { useToast } from "@/primitives/Toast";

/**
 * "New worktree" dialog — opened by ⌘N and the sidebar + button via
 * `state.createWorktreeProjectId`. Lets the user name the worktree
 * (instead of the auto-assigned landmark name) and pick its sidebar
 * color + icon before it's created. Enter creates, ESC cancels, and
 * leaving the name untouched keeps the suggested landmark name.
 */
export function CreateWorktreeDialog() {
  const state = useAppState();
  const projectId = state.createWorktreeProjectId;
  const project = projectId ? state.projects[projectId] : null;

  return (
    <AnimatePresence>
      {project && (
        // Keyed by project so reopening always mounts a fresh panel
        // with a new name suggestion and cleared color/icon drafts.
        <DialogPanel key={project.id} project={project} />
      )}
    </AnimatePresence>
  );
}

/** Reduce free-typed input to a git-legal branch component. */
function sanitizeBranchBase(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

function DialogPanel({ project }: { project: Project }) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();

  // Suggested landmark name, fixed for the lifetime of this open.
  const [suggestion] = useState(() => nextAutoBranch(project.id, state));
  const [draftName, setDraftName] = useState(suggestion);
  const [color, setColor] = useState<TagId | undefined>(undefined);
  const [iconName, setIconName] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);
  const backdropMouseDownRef = useRef(false);
  const busyRef = useRef(false);

  const close = () => {
    if (busyRef.current) return;
    dispatch({ type: "set-create-worktree-open", projectId: null });
  };
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });

  useEffect(() => {
    // Pre-select the suggestion so typing immediately replaces it —
    // accepting the auto-name costs nothing, renaming costs no clicks.
    const t = window.setTimeout(() => {
      nameRef.current?.focus();
      nameRef.current?.select();
    }, 80);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const base = sanitizeBranchBase(draftName) || suggestion;
  const branch = applyBranchPrefix(
    base,
    state.settings.branchPrefixMode,
    state.settings.githubUsername,
    state.settings.customBranchPrefix,
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PICKER_ICONS;
    return PICKER_ICONS.filter(
      (p) =>
        p.name.toLowerCase().includes(q) || p.label.toLowerCase().includes(q),
    );
  }, [query]);

  const create = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const label = draftName.trim() || suggestion;
    const cfg = projectSettings(project);
    try {
      const w = await worktreeCreate(project.id, project.path, branch, label, {
        baseRef: cfg.baseBranch,
        filesToCopy: cfg.filesToCopy,
        setupScript: cfg.setupScript,
      });
      dispatch({ type: "add-worktree", worktree: w });
      if (color || iconName) {
        dispatch({
          type: "update-worktree",
          id: w.id,
          patch: { color, iconName },
        });
      }
      dispatch({ type: "open-tab", tab: primaryTerminalTab(w) });
      busyRef.current = false;
      dispatch({ type: "set-create-worktree-open", projectId: null });
    } catch (err) {
      busyRef.current = false;
      setBusy(false);
      toast.show({ message: `Worktree creation failed: ${err}` });
    }
  };

  const sectionLabel: CSSProperties = {
    fontSize: "var(--text-xs)",
    textTransform: "uppercase",
    letterSpacing: "var(--tracking-caps)",
    color: "var(--text-tertiary)",
    fontWeight: "var(--weight-semibold)",
  };

  return (
    <motion.div
      key="create-worktree-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) backdropMouseDownRef.current = true;
      }}
      onMouseUp={(e) => {
        if (backdropMouseDownRef.current && e.target === e.currentTarget) {
          close();
        }
        backdropMouseDownRef.current = false;
      }}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "var(--backdrop)",
        zIndex: 10_000,
        display: "grid",
        placeItems: "start center",
        paddingTop: "min(15vh, 140px)",
      }}
    >
      <motion.div
        key="create-worktree-panel"
        initial={{ opacity: 0, scale: 0.985, y: 4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        onMouseDown={(e) => e.stopPropagation()}
        onMouseUp={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, 92vw)",
          maxHeight: "78vh",
          display: "grid",
          gridTemplateRows: "auto auto auto 1fr auto",
          backgroundColor: "var(--surface-2)",
          border: "var(--border-1)",
          borderRadius: "var(--radius-lg)",
          boxShadow:
            "0 24px 60px -16px rgba(0,0,0,0.65), 0 4px 10px rgba(0,0,0,0.4)",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            padding: "var(--space-3) var(--space-4) var(--space-3)",
            display: "grid",
            gap: 6,
          }}
        >
          <span style={sectionLabel}>
            New worktree · {project.name}
          </span>
          <input
            ref={nameRef}
            type="text"
            value={draftName}
            spellCheck={false}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void create();
              }
            }}
            placeholder={suggestion}
            style={{
              width: "100%",
              height: 40,
              padding: "0 12px",
              backgroundColor: "var(--surface-1)",
              border: "var(--border-1)",
              borderRadius: "var(--radius-sm)",
              color: "var(--text-primary)",
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-lg)",
              fontWeight: "var(--weight-semibold)",
              outline: "none",
            }}
          />
          <span
            style={{
              fontSize: "var(--text-xs)",
              fontFamily: "var(--font-mono)",
              color: "var(--text-tertiary)",
            }}
          >
            branch: {branch}
          </span>
        </header>

        <section
          style={{
            padding: "var(--space-3) var(--space-4)",
            borderTop: "var(--border-1)",
            display: "grid",
            gap: 6,
          }}
        >
          <span style={sectionLabel}>Color</span>
          <div
            role="radiogroup"
            aria-label="Tag color"
            style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
          >
            {TAG_IDS.map((id) => (
              <ColorSwatch
                key={id}
                id={id}
                active={id === (color ?? "default")}
                onClick={() => setColor(id === "default" ? undefined : id)}
              />
            ))}
          </div>
        </section>

        <section
          style={{
            padding: "var(--space-3) var(--space-4) var(--space-2)",
            borderTop: "var(--border-1)",
            display: "grid",
            gap: 8,
          }}
        >
          <span style={sectionLabel}>Icon</span>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              height: 36,
              padding: "0 12px",
              backgroundColor: "var(--surface-1)",
              border: "var(--border-1)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            <SearchGlyph />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search icons"
              style={{
                flex: 1,
                minWidth: 0,
                background: "transparent",
                border: "none",
                outline: "none",
                color: "var(--text-primary)",
                fontFamily: "var(--font-sans)",
                fontSize: "var(--text-md)",
              }}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                title="Clear search"
                style={{
                  width: 20,
                  height: 20,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: "transparent",
                  color: "var(--text-tertiary)",
                  borderRadius: "var(--radius-xs)",
                  cursor: "pointer",
                }}
              >
                ×
              </button>
            )}
          </div>
        </section>

        <div
          style={{
            overflow: "auto",
            padding: "0 var(--space-4) var(--space-3)",
            minHeight: 0,
            // Cap the grid so the footer stays visible without the
            // panel growing to the viewport max on every open.
            maxHeight: 220,
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(56px, 1fr))",
              gap: 6,
            }}
          >
            {filtered.map((icon) => (
              <IconCell
                key={icon.name}
                icon={icon}
                active={icon.name === iconName}
                onClick={() =>
                  setIconName(icon.name === iconName ? undefined : icon.name)
                }
              />
            ))}
            {filtered.length === 0 && (
              <span
                style={{
                  gridColumn: "1 / -1",
                  padding: "var(--space-4)",
                  textAlign: "center",
                  color: "var(--text-tertiary)",
                  fontSize: "var(--text-xs)",
                }}
              >
                No icons match "{query}"
              </span>
            )}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "var(--space-3)",
            borderTop: "var(--border-1)",
          }}
        >
          <button
            type="button"
            onClick={close}
            disabled={busy}
            style={{
              height: 28,
              padding: "0 var(--space-3)",
              borderRadius: "var(--radius-sm)",
              color: "var(--text-secondary)",
              backgroundColor: "var(--surface-3)",
              fontSize: "var(--text-sm)",
              opacity: busy ? 0.5 : 1,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void create()}
            disabled={busy || !base}
            style={{
              height: 28,
              padding: "0 var(--space-3)",
              borderRadius: "var(--radius-sm)",
              color: "var(--text-primary)",
              backgroundColor: "var(--accent-press)",
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-medium)",
              opacity: busy || !base ? 0.5 : 1,
            }}
          >
            {busy ? "Creating…" : "Create worktree"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
