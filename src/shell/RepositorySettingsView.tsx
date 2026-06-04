import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "motion/react";
import { useAppDispatch, useAppState } from "@/state/AppState";
import {
  DEFAULT_PROJECT_SETTINGS,
  projectSettings,
  type Project,
  type ProjectSettings,
  type RepoPreferences,
} from "@/state/types";
import { git } from "@/lib/git";
import { IconChevronDown, IconChevronRight } from "@/design/icons";
import { TrashIcon } from "@phosphor-icons/react";
import { lookupPickerIcon } from "@/design/picker-icons";

/**
 * Per-repository settings page rendered as a centered, narrow column
 * over `--surface-0`. Mirrors conductor.build's layout: header, then
 * each section divided by hairlines. Every input commits to state on
 * change — no save button, no dirty tracking. Long-running effects
 * (file copy on worktree create, scripts) use the persisted values
 * directly, so anything saved here takes effect on the next worktree.
 */

const PAGE_MAX = 720;

export function RepositorySettingsView({ projectId }: { projectId: string }) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const project = state.projects[projectId];
  if (!project) {
    return (
      <div
        style={{
          padding: "var(--space-8)",
          color: "var(--text-tertiary)",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-sm)",
        }}
      >
        Repository not found.
      </div>
    );
  }
  const settings = projectSettings(project);
  const update = (patch: Partial<ProjectSettings>) =>
    dispatch({ type: "update-project-settings", id: project.id, patch });
  const updatePrefs = (patch: Partial<RepoPreferences>) =>
    dispatch({ type: "update-project-prefs", id: project.id, patch });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "auto",
        backgroundColor: "var(--surface-0)",
      }}
    >
      <div
        style={{
          maxWidth: PAGE_MAX,
          margin: "0 auto",
          // Space-7/9/11 don't exist in our token scale — the old
          // declaration parsed as invalid and was dropped, which is
          // why the header used to sit flush against the top. The
          // real-token values below give the page proper breathing
          // room top and bottom.
          padding: "var(--space-12) var(--space-6) var(--space-16)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-6)",
        }}
      >
        <Header project={project} />

        <PathRow
          label="Root path"
          path={project.path}
          highlight={project.name}
          warning="Do not move or delete this directory. Instead, remove the repository in Goonware."
        />

        <PathsForWorktrees project={project} />

        <Hairline />

        <Section title="Branch new workspaces from" subtitle="Each workspace is an isolated copy of your codebase.">
          <BaseBranchPicker
            cwd={project.path}
            value={settings.baseBranch}
            onChange={(v) => update({ baseBranch: v })}
          />
        </Section>

        <Hairline />

        <Section
          title="Remote origin"
          subtitle="Where should we push, pull, and create PRs?"
        >
          <RemotePicker
            cwd={project.path}
            value={settings.remote}
            onChange={(v) => update({ remote: v })}
          />
        </Section>

        <Hairline />

        <Section
          title="Preview URL"
          subtitle="Overrides the terminal panel's Open button URL. Supports all Goonware environment variables ($GOONWARE_WORKTREE_NAME, $GOONWARE_PORT, $GOONWARE_PROJECT_ID). Leave blank to auto-detect from output logs."
        >
          <TextInput
            value={settings.previewUrl}
            placeholder="https://localhost:$GOONWARE_PORT"
            onChange={(v) => update({ previewUrl: v })}
            mono
          />
        </Section>

        <Hairline />

        <FilesToCopy
          rootPath={project.path}
          patterns={settings.filesToCopy}
          onChange={(filesToCopy) => update({ filesToCopy })}
        />

        <Hairline />

        <Scripts settings={settings} onChange={update} />

        <Hairline />

        <Preferences prefs={settings.prefs} onChange={updatePrefs} />

        <div style={{ paddingTop: "var(--space-6)" }}>
          <RemoveRepoButton project={project} />
        </div>
      </div>
    </div>
  );
}

/* ---------------- header ---------------- */

function Header({ project }: { project: Project }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        marginBottom: "var(--space-2)",
      }}
    >
      <HeaderGlyph project={project} />
      <h1
        style={{
          margin: 0,
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-xl)",
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-tight)",
          color: "var(--text-primary)",
        }}
      >
        {project.name}
      </h1>
    </div>
  );
}

/* ---------------- shared section primitives ---------------- */

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
      }}
    >
      <div>
        <SectionTitle>{title}</SectionTitle>
        {subtitle && <SectionSubtitle>{subtitle}</SectionSubtitle>}
      </div>
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-md)",
        fontWeight: "var(--weight-semibold)",
        letterSpacing: "var(--tracking-tight)",
        color: "var(--text-primary)",
      }}
    >
      {children}
    </div>
  );
}

function SectionSubtitle({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        marginTop: "var(--space-1)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-xs)",
        color: "var(--text-tertiary)",
        lineHeight: "var(--leading-sm)",
      }}
    >
      {children}
    </div>
  );
}

function Hairline() {
  return (
    <div
      style={{
        height: 1,
        backgroundColor: "var(--border-default)",
        margin: "var(--space-1) 0",
      }}
    />
  );
}

/* ---------------- paths ---------------- */

function PathRow({
  label,
  path,
  highlight,
  warning,
}: {
  label: string;
  path: string;
  highlight: string;
  warning: string;
}) {
  // Render the path with the highlight (e.g. project name) in primary
  // color and the rest in tertiary, matching the reference design.
  const idx = path.lastIndexOf("/" + highlight);
  const before = idx >= 0 ? path.slice(0, idx + 1) : path;
  const tail = idx >= 0 ? path.slice(idx + 1) : "";

  return (
    <Section title={label}>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm)",
          color: "var(--text-tertiary)",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
        }}
      >
        <span>{before}</span>
        {tail && <span style={{ color: "var(--text-primary)" }}>{tail}</span>}
        <IconChevronDown size={12} style={{ color: "var(--text-disabled)" }} />
      </div>
      <Hint>{warning}</Hint>
    </Section>
  );
}

function PathsForWorktrees({ project }: { project: Project }) {
  // Workspaces live at `~/goonware/workspaces/<project-basename>/`.
  // We resolve $HOME once on mount via Tauri's path API; the basename
  // comes straight from the project's repo path so the displayed path
  // matches what `worktree_create` actually writes to.
  const [home, setHome] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const h = await invoke<string>("system_home_dir").catch(() => "");
        if (!cancelled && h) setHome(h);
      } catch {
        // best-effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const basename =
    project.path.split("/").filter(Boolean).pop() ?? project.name;
  const fullPath = home
    ? `${home.replace(/\/$/, "")}/Goonware/workspaces/${basename}`
    : `~/Goonware/workspaces/${basename}`;
  return (
    <PathRow
      label="Workspaces path"
      path={fullPath}
      highlight={basename}
      warning="Do not move or delete the workspace subdirectories. Instead, archive workspaces in Goonware."
    />
  );
}

function HeaderGlyph({ project }: { project: Project }) {
  const wrap: React.CSSProperties = {
    width: 32,
    height: 32,
    display: "grid",
    placeItems: "center",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--surface-2)",
    border: "var(--border-1)",
    overflow: "hidden",
    flexShrink: 0,
  };
  const iconEntry = lookupPickerIcon(project.iconName);
  if (iconEntry) {
    const Glyph = iconEntry.Component;
    return (
      <span
        aria-hidden
        style={{
          ...wrap,
          color: project.color
            ? `var(--tag-${project.color})`
            : "var(--text-secondary)",
        }}
      >
        <Glyph size={18} />
      </span>
    );
  }
  if (project.faviconDataUri) {
    return (
      <span style={wrap} aria-hidden>
        <img
          src={project.faviconDataUri}
          alt=""
          width={20}
          height={20}
          style={{ borderRadius: 4 }}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      style={{
        ...wrap,
        fontFamily: "var(--font-mono)",
        fontSize: 13,
        fontWeight: 600,
        color: "var(--text-primary)",
      }}
    >
      {project.glyph}
    </span>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "var(--space-2)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-xs)",
        color: "var(--text-tertiary)",
        lineHeight: "var(--leading-sm)",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 14,
          height: 14,
          borderRadius: "50%",
          border: "1px solid var(--text-tertiary)",
          color: "var(--text-tertiary)",
          fontSize: 10,
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        !
      </span>
      <span>{children}</span>
    </div>
  );
}

/* ---------------- branch + remote pickers ---------------- */

function BaseBranchPicker({
  cwd,
  value,
  onChange,
}: {
  cwd: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [branches, setBranches] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await git.branchList(cwd);
        if (cancelled) return;
        // Conductor seeds "origin/<branch>" for each remote tracking
        // branch as well — we approximate by prefixing every local
        // branch with "origin/" and including the bare names too.
        const local = list.map((b) => b.name);
        const remote = local.map((n) => `origin/${n}`);
        const seen = new Set<string>();
        const out: string[] = [];
        for (const n of [...remote, ...local]) {
          if (!seen.has(n)) {
            seen.add(n);
            out.push(n);
          }
        }
        if (!seen.has(value) && value) out.unshift(value);
        setBranches(out);
      } catch {
        // ignore — picker stays with whatever is in `value`
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, value]);

  return (
    <Select value={value} onChange={onChange}>
      {branches.length === 0 && <option value={value}>{value}</option>}
      {branches.map((b) => (
        <option key={b} value={b}>
          {b}
        </option>
      ))}
    </Select>
  );
}

function RemotePicker({
  cwd,
  value,
  onChange,
}: {
  cwd: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [remotes, setRemotes] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await git.remotes(cwd);
        if (cancelled) return;
        const out = list.length > 0 ? list : ["origin"];
        if (!out.includes(value) && value) out.unshift(value);
        setRemotes(out);
      } catch {
        setRemotes([value || "origin"]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, value]);

  return (
    <Select value={value} onChange={onChange}>
      {remotes.map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </Select>
  );
}

function Select({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
}) {
  return (
    <div style={{ position: "relative", width: "fit-content" }}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          appearance: "none",
          padding: "0 28px 0 var(--space-3)",
          height: 28,
          backgroundColor: "var(--surface-1)",
          color: "var(--text-primary)",
          border: "var(--border-1)",
          borderRadius: "var(--radius-sm)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm)",
          cursor: "pointer",
          minWidth: 140,
        }}
      >
        {children}
      </select>
      <span
        aria-hidden
        style={{
          position: "absolute",
          right: 8,
          top: 0,
          bottom: 0,
          display: "flex",
          alignItems: "center",
          color: "var(--text-tertiary)",
          pointerEvents: "none",
          fontSize: 10,
        }}
      >
        ⇅
      </span>
    </div>
  );
}

/* ---------------- text inputs ---------------- */

function TextInput({
  value,
  onChange,
  placeholder,
  mono = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: "100%",
        height: 36,
        padding: "0 var(--space-3)",
        backgroundColor: "var(--surface-1)",
        color: "var(--text-primary)",
        border: "var(--border-1)",
        borderRadius: "var(--radius-md)",
        fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
        fontSize: "var(--text-sm)",
        outline: "none",
      }}
      onFocus={(e) => {
        e.currentTarget.style.borderColor = "var(--accent-muted)";
      }}
      onBlur={(e) => {
        e.currentTarget.style.borderColor = "";
      }}
    />
  );
}

function TextArea({
  value,
  onChange,
  placeholder,
  rows = 4,
  mono = true,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  mono?: boolean;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      spellCheck={false}
      style={{
        width: "100%",
        padding: "var(--space-3)",
        backgroundColor: "var(--surface-1)",
        color: "var(--text-primary)",
        border: "var(--border-1)",
        borderRadius: "var(--radius-md)",
        fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
        fontSize: "var(--text-sm)",
        outline: "none",
        resize: "vertical",
        lineHeight: "var(--leading-md)",
      }}
      onFocus={(e) => {
        e.currentTarget.style.borderColor = "var(--accent-muted)";
      }}
      onBlur={(e) => {
        e.currentTarget.style.borderColor = "";
      }}
    />
  );
}

/* ---------------- files to copy ---------------- */

function FilesToCopy({
  rootPath,
  patterns,
  onChange,
}: {
  rootPath: string;
  patterns: string[];
  onChange: (next: string[]) => void;
}) {
  const text = useMemo(() => patterns.join("\n"), [patterns]);
  const [matches, setMatches] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const found = await previewMatches(rootPath, patterns);
        if (!cancelled) setMatches(found);
      } catch {
        if (!cancelled) setMatches([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rootPath, patterns]);

  return (
    <Section
      title="Files to copy"
      subtitle={
        <>
          Goonware will automatically copy these file paths into each new
          workspace.
        </>
      }
    >
      <TextArea
        value={text}
        onChange={(v) =>
          onChange(
            v
              .split("\n")
              .map((s) => s.trimEnd())
              .filter((s, i, arr) => i === arr.length - 1 || s.length > 0),
          )
        }
        placeholder=".env*"
        rows={4}
      />
      <div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            background: "transparent",
            border: "none",
            padding: 0,
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-xs)",
            cursor: "pointer",
          }}
        >
          {expanded ? (
            <IconChevronDown size={12} />
          ) : (
            <IconChevronRight size={12} />
          )}
          {matches.length} {matches.length === 1 ? "file" : "files"} will be
          copied from <code style={{ fontFamily: "var(--font-mono)" }}>{rootPath}</code>
        </button>
        <AnimatePresence initial={false}>
          {expanded && matches.length > 0 && (
            <motion.ul
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
              style={{
                listStyle: "none",
                margin: "var(--space-2) 0 0",
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-1)",
                overflow: "hidden",
              }}
            >
              {matches.map((m) => (
                <li
                  key={m}
                  style={{
                    padding: "var(--space-2) var(--space-3)",
                    backgroundColor: "var(--surface-1)",
                    border: "var(--border-1)",
                    borderRadius: "var(--radius-sm)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-sm)",
                    color: "var(--text-primary)",
                  }}
                >
                  {m}
                </li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>
      </div>
    </Section>
  );
}

/**
 * Preview which files in `root` match the user's patterns. Done in JS
 * via fs_read_dir to avoid spinning up a new Tauri command — fine for
 * the small directories these patterns hit (repo root only).
 */
async function previewMatches(
  root: string,
  patterns: string[],
): Promise<string[]> {
  if (!root) return [];
  const list = await invoke<{ name: string; isDirectory: boolean }[]>(
    "fs_read_dir",
    { path: root },
  ).catch(() => []);
  const files = list.filter((e) => !e.isDirectory).map((e) => e.name);
  const out = new Set<string>();
  for (const raw of patterns) {
    const pat = raw.trim();
    if (!pat || pat.startsWith("#")) continue;
    if (pat.includes("/")) {
      // Subpath patterns aren't expanded in the preview to keep this
      // round trip cheap. The Rust side handles them at copy-time.
      out.add(pat);
      continue;
    }
    if (!pat.includes("*")) {
      if (files.includes(pat)) out.add(pat);
      continue;
    }
    const star = pat.indexOf("*");
    const prefix = pat.slice(0, star);
    const suffix = pat.slice(star + 1);
    for (const f of files) {
      if (
        f.startsWith(prefix) &&
        f.endsWith(suffix) &&
        f.length >= prefix.length + suffix.length
      ) {
        out.add(f);
      }
    }
  }
  return Array.from(out).sort();
}

/* ---------------- scripts ---------------- */

function Scripts({
  settings,
  onChange,
}: {
  settings: ProjectSettings;
  onChange: (patch: Partial<ProjectSettings>) => void;
}) {
  const [advanced, setAdvanced] = useState(
    Boolean(settings.archiveScript.length),
  );
  return (
    <Section
      title="Scripts"
      subtitle="Commands that run when workspaces are set up, run, or archived."
    >
      <Field
        label="Setup script"
        hint="Runs when a new workspace is created"
      >
        <TextArea
          value={settings.setupScript}
          onChange={(setupScript) => onChange({ setupScript })}
          placeholder="e.g., bun install"
          rows={3}
        />
      </Field>
      <Field label="Run script" hint="Runs when you click the play button">
        <TextArea
          value={settings.runScript}
          onChange={(runScript) => onChange({ runScript })}
          placeholder="e.g., bun run dev"
          rows={3}
        />
      </Field>
      <button
        type="button"
        onClick={() => setAdvanced((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          background: "transparent",
          border: "none",
          padding: 0,
          color: "var(--text-tertiary)",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-xs)",
          cursor: "pointer",
          width: "fit-content",
        }}
      >
        {advanced ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        Advanced
      </button>
      <AnimatePresence initial={false}>
        {advanced && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
            style={{ overflow: "hidden" }}
          >
            <Field label="Archive script" hint="Runs before a workspace is archived">
              <TextArea
                value={settings.archiveScript}
                onChange={(archiveScript) => onChange({ archiveScript })}
                placeholder="e.g., rm -rf node_modules"
                rows={3}
              />
            </Field>
          </motion.div>
        )}
      </AnimatePresence>
    </Section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-sm)",
          fontWeight: "var(--weight-medium)",
          color: "var(--text-primary)",
        }}
      >
        {label}
      </div>
      {hint && (
        <div
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-xs)",
            color: "var(--text-tertiary)",
            marginBottom: "var(--space-1)",
          }}
        >
          {hint}
        </div>
      )}
      {children}
    </div>
  );
}

/* ---------------- preferences ---------------- */

interface PrefDef {
  key: keyof RepoPreferences;
  label: string;
  hint: string;
}

const PREF_DEFS: PrefDef[] = [
  {
    key: "review",
    label: "Code review preferences",
    hint: "Add custom instructions sent to the agent when you click the Review button.",
  },
  {
    key: "createPR",
    label: "Create PR preferences",
    hint: "Add custom instructions sent to the agent when you click the Create PR button.",
  },
  {
    key: "fixErrors",
    label: "Fix errors preferences",
    hint: "Add custom instructions sent to the agent when you click the Fix errors button.",
  },
  {
    key: "resolveConflicts",
    label: "Resolve conflicts preferences",
    hint: "Add custom instructions sent to the agent when you click the Resolve conflicts button.",
  },
  {
    key: "branchRename",
    label: "Branch rename preferences",
    hint: "Add custom instructions for generating branch names from your messages.",
  },
  {
    key: "general",
    label: "General preferences",
    hint: "Add custom instructions sent to the agent at the start of every new chat.",
  },
];

function Preferences({
  prefs,
  onChange,
}: {
  prefs: RepoPreferences;
  onChange: (patch: Partial<RepoPreferences>) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 0,
      }}
    >
      <div style={{ marginBottom: "var(--space-3)" }}>
        <SectionTitle>Preferences</SectionTitle>
      </div>
      {PREF_DEFS.map((def, i) => (
        <PrefRow
          key={def.key}
          def={def}
          value={prefs[def.key]}
          onChange={(v) => onChange({ [def.key]: v } as Partial<RepoPreferences>)}
          isLast={i === PREF_DEFS.length - 1}
        />
      ))}
    </div>
  );
}

function PrefRow({
  def,
  value,
  onChange,
  isLast,
}: {
  def: PrefDef;
  value: string;
  onChange: (v: string) => void;
  isLast: boolean;
}) {
  const [open, setOpen] = useState(value.length > 0);
  return (
    <div
      style={{
        borderBottom: isLast ? "none" : "var(--border-1)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          padding: "var(--space-4) 0",
          background: "transparent",
          border: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-3)",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--text-primary)",
            }}
          >
            {def.label}
          </div>
          <div
            style={{
              marginTop: 2,
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-xs)",
              color: "var(--text-tertiary)",
              lineHeight: "var(--leading-sm)",
            }}
          >
            {def.hint}
          </div>
        </div>
        <motion.span
          aria-hidden
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.16, ease: [0.25, 1, 0.5, 1] }}
          style={{
            display: "inline-flex",
            color: "var(--text-tertiary)",
            flexShrink: 0,
          }}
        >
          <IconChevronDown size={14} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
            style={{ overflow: "hidden" }}
          >
            <div style={{ paddingBottom: "var(--space-4)" }}>
              <TextArea
                value={value}
                onChange={onChange}
                placeholder="Custom instructions, in plain English."
                rows={4}
                mono={false}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------------- remove ---------------- */

function RemoveRepoButton({ project }: { project: Project }) {
  const dispatch = useAppDispatch();
  const lockRef = useRef(false);
  return (
    <button
      type="button"
      onClick={() => {
        if (lockRef.current) return;
        if (
          window.confirm(
            `Remove ${project.name} from Goonware? Local files at ${project.path} are untouched.`,
          )
        ) {
          lockRef.current = true;
          dispatch({ type: "remove-project", id: project.id });
        }
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        height: 32,
        padding: "0 var(--space-3)",
        backgroundColor: "transparent",
        color: "var(--state-error-bright)",
        border: "1px solid var(--state-error-bright)",
        borderRadius: "var(--radius-md)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
        fontWeight: "var(--weight-medium)",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor =
          "color-mix(in oklch, var(--surface-1), var(--state-error) 18%)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      <TrashIcon size={14} />
      Remove repository
    </button>
  );
}

void DEFAULT_PROJECT_SETTINGS;
