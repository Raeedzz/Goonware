import { type CSSProperties, type ReactNode, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { invoke } from "@tauri-apps/api/core";
import {
  IconBack,
  IconSettings,
  IconHelp,
  IconBranch,
  IconFolder,
} from "@/design/icons";
import {
  useAppDispatch,
  useAppState,
} from "@/state/AppState";
import type {
  AgentCli,
  ArchiveBehavior,
  CompletionSound,
  ProjectId,
  Settings,
  SettingsSection,
} from "@/state/types";
import { RepositorySettingsView } from "./RepositorySettingsView";

/**
 * Full-window settings overlay. Replaces the 3-column shell while open.
 * Two sections — General (RLI-relevant toggles) and Repositories
 * (snapshot of the projects list). Esc / Back-to-app dismisses.
 *
 * Which section is shown lives on AppState (`settingsSection`) so the
 * Sidebar's "Repository settings" entry can deep-link into a specific
 * project's page without remounting the overlay.
 */
export function SettingsView() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const open = state.settingsOpen;
  const section = state.settingsSection;
  const setSection = (s: SettingsSection) =>
    dispatch({ type: "set-settings-section", section: s });

  const close = () => dispatch({ type: "set-settings-open", open: false });
  const projects = state.projectOrder
    .map((id) => state.projects[id])
    .filter(Boolean)
    .map((p) => ({ id: p!.id, name: p!.name }));

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="settings-root"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: "var(--z-modal)",
            backgroundColor: "var(--surface-0)",
            display: "grid",
            gridTemplateColumns: "260px 1fr",
            color: "var(--text-secondary)",
          }}
        >
          <SettingsSidebar
            current={section}
            onPick={setSection}
            onClose={close}
            projects={projects}
          />
          <SettingsMain section={section} settings={state.settings} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------
   Sidebar
   ------------------------------------------------------------------ */

function SettingsSidebar({
  current,
  onPick,
  onClose,
  projects,
}: {
  current: SettingsSection;
  onPick: (s: SettingsSection) => void;
  onClose: () => void;
  projects: { id: ProjectId; name: string }[];
}) {
  return (
    <aside
      style={{
        height: "100%",
        backgroundColor: "var(--surface-1)",
        borderRight: "var(--border-1)",
        display: "grid",
        gridTemplateRows: "auto auto 1fr auto",
        // Top padding clears macOS traffic lights (~y=20). Without
        // this, "Back to app" rides the same horizontal band as the
        // close/min/zoom controls.
        padding: "44px 0 var(--space-3)",
      }}
    >
      <button
        type="button"
        onClick={onClose}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 28,
          padding: "0 var(--space-3)",
          marginBottom: "var(--space-2)",
          color: "var(--text-secondary)",
          fontSize: "var(--text-sm)",
          backgroundColor: "transparent",
          textAlign: "left",
        }}
        onMouseOver={(e) => {
          e.currentTarget.style.color = "var(--text-primary)";
        }}
        onMouseOut={(e) => {
          e.currentTarget.style.color = "var(--text-secondary)";
        }}
      >
        <IconBack size={14} />
        Back to app
      </button>

      <nav
        style={{
          display: "flex",
          flexDirection: "column",
          padding: "0 var(--space-2)",
          gap: 1,
        }}
      >
        <NavItem
          active={current.kind === "general"}
          icon={<IconSettings size={14} />}
          label="General"
          onClick={() => onPick({ kind: "general" })}
        />
        <NavItem
          active={current.kind === "git"}
          icon={<IconBranch size={14} />}
          label="Git"
          onClick={() => onPick({ kind: "git" })}
        />
      </nav>

      <div
        style={{
          padding: "var(--space-4) var(--space-2) var(--space-2)",
          overflow: "auto",
          minHeight: 0,
        }}
      >
        <span
          style={{
            display: "block",
            fontSize: "var(--text-2xs)",
            letterSpacing: "var(--tracking-wide)",
            textTransform: "uppercase",
            color: "var(--text-tertiary)",
            marginBottom: "var(--space-1)",
            padding: "0 var(--space-1)",
          }}
        >
          Repositories
        </span>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {projects.map((p) => {
            const active = current.kind === "repository" && current.id === p.id;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onPick({ kind: "repository", id: p.id })}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    height: 30,
                    padding: "0 var(--space-2)",
                    borderRadius: "var(--radius-sm)",
                    backgroundColor: active ? "var(--surface-3)" : "transparent",
                    color: active ? "var(--text-primary)" : "var(--text-secondary)",
                    fontSize: "var(--text-sm)",
                    textAlign: "left",
                    cursor: "pointer",
                    border: "none",
                    transition:
                      "background-color var(--motion-instant) var(--ease-out-quart)",
                  }}
                  onMouseOver={(e) => {
                    if (!active)
                      e.currentTarget.style.backgroundColor = "var(--surface-2)";
                  }}
                  onMouseOut={(e) => {
                    if (!active)
                      e.currentTarget.style.backgroundColor = "transparent";
                  }}
                >
                  <IconFolder
                    size={12}
                    style={{ color: "var(--text-tertiary)" }}
                  />
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {p.name}
                  </span>
                </button>
              </li>
            );
          })}
          {projects.length === 0 && (
            <li
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--text-tertiary)",
                padding: "var(--space-1) var(--space-2)",
              }}
            >
              No projects yet
            </li>
          )}
        </ul>
      </div>

      <div
        style={{
          padding: "var(--space-2) var(--space-3)",
          borderTop: "var(--border-1)",
          display: "flex",
          justifyContent: "flex-end",
          gap: 4,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
          }}
        >
          <IconHelp size={12} />
          ⌘,
        </span>
      </div>
    </aside>
  );
}

function NavItem({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 30,
        padding: "0 var(--space-2)",
        borderRadius: "var(--radius-sm)",
        backgroundColor: active ? "var(--surface-3)" : "transparent",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        fontSize: "var(--text-sm)",
        textAlign: "left",
        transition: "background-color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseOver={(e) => {
        if (!active) e.currentTarget.style.backgroundColor = "var(--surface-2)";
      }}
      onMouseOut={(e) => {
        if (!active) e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      <span style={{ color: "var(--text-tertiary)" }}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

/* ------------------------------------------------------------------
   Main panel
   ------------------------------------------------------------------ */

function SettingsMain({
  section,
  settings,
}: {
  section: SettingsSection;
  settings: Settings;
}) {
  if (section.kind === "repository") {
    return (
      <main
        style={{
          height: "100%",
          position: "relative",
          backgroundColor: "var(--surface-0)",
          // Same top inset as the sidebar so the repo header lines up
          // with "Back to app" instead of disappearing under the
          // traffic lights.
          paddingTop: 32,
        }}
      >
        <RepositorySettingsView projectId={section.id} />
      </main>
    );
  }
  return (
    <main
      style={{
        height: "100%",
        overflow: "auto",
        backgroundColor: "var(--surface-0)",
        // Match the repository page's breathing room — generous top
        // (clears traffic lights + adds visual rest), generous bottom
        // (last row never butts against the window edge).
        padding:
          "calc(var(--space-12) + 32px) max(var(--space-12), 8vw) var(--space-16)",
      }}
    >
      <h1
        style={{
          margin: 0,
          marginBottom: "var(--space-6)",
          fontFamily: "var(--font-sans)",
          fontSize: 28,
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-tight)",
          color: "var(--text-primary)",
        }}
      >
        {section.kind === "git" ? "Git" : "General"}
      </h1>
      {section.kind === "git" ? (
        <GitSection settings={settings} />
      ) : (
        <GeneralSection settings={settings} />
      )}
    </main>
  );
}

function GeneralSection({ settings }: { settings: Settings }) {
  const dispatch = useAppDispatch();
  const update = (patch: Partial<Settings>) =>
    dispatch({ type: "update-settings", patch });

  return (
    <div style={{ display: "flex", flexDirection: "column", maxWidth: 760 }}>
      <SettingRow
        title="Notify when an agent finishes"
        description="Show a macOS notification when a worktree's agent goes idle."
        control={
          <Toggle
            checked={settings.notifyOnIdle}
            onChange={(v) => update({ notifyOnIdle: v })}
          />
        }
      />

      <SettingRow
        title="Completion sound"
        description="Play a short sound when a worktree's agent goes idle."
        control={
          <SelectChips<CompletionSound>
            value={settings.completionSound}
            onChange={(v) => update({ completionSound: v })}
            options={[
              { value: "none", label: "No sound" },
              { value: "subtle", label: "Subtle" },
              { value: "bell", label: "Bell" },
            ]}
          />
        }
      />

      <SettingRow
        title="Always show context usage"
        description="Always render the breadcrumb's `% / 5h` indicator. By default it self-hides when no Anthropic session is active."
        control={
          <Toggle
            checked={settings.alwaysShowContextUsage}
            onChange={(v) => update({ alwaysShowContextUsage: v })}
          />
        }
      />

      <SettingRow
        title="Caffeinate while agents are running"
        description="Prevent your Mac from sleeping while any worktree's agent is active. Shuts off below 10% battery."
        control={
          <Toggle
            checked={settings.caffeinate}
            onChange={(v) => update({ caffeinate: v })}
          />
        }
      />

      <SectionDivider label="Helpers" />

      <SettingRow
        title="Commit message"
        description="Which CLI drafts commit messages when you press the AI-draft button in the Changes panel. Run on your machine via the agent's CLI — no API keys."
        control={
          <HelperTaskControl
            cli={settings.helperCliCommit}
            model={settings.helperModelCommit}
            onCliChange={(v) =>
              update({ helperCliCommit: v, helperModelCommit: "" })
            }
            onModelChange={(m) => update({ helperModelCommit: m })}
          />
        }
      />

      <SettingRow
        title="Pull request"
        description="Which CLI drafts the PR title + body when you open the Create-PR dialog."
        control={
          <HelperTaskControl
            cli={settings.helperCliPr}
            model={settings.helperModelPr}
            onCliChange={(v) =>
              update({ helperCliPr: v, helperModelPr: "" })
            }
            onModelChange={(m) => update({ helperModelPr: m })}
          />
        }
      />

      <SettingRow
        title="Explain (⌘L)"
        description="Which CLI answers the Ask overlay when you select code in the editor and press ⌘L."
        control={
          <HelperTaskControl
            cli={settings.helperCliExplain}
            model={settings.helperModelExplain}
            onCliChange={(v) =>
              update({ helperCliExplain: v, helperModelExplain: "" })
            }
            onModelChange={(m) => update({ helperModelExplain: m })}
          />
        }
      />

      <SettingRow
        title="Auto-summarize tab activity"
        description="Drive the tab subtitle (the 11px line under each tab name) from the active CLI on idle. Off skips subprocess invocations — the subtitle then shows the launch command instead."
        control={
          <Toggle
            checked={settings.autoSummarize}
            onChange={(v) => update({ autoSummarize: v })}
          />
        }
      />

      <SectionDivider label="Worktrees" />

      <SettingRow
        title="Archive behavior on close"
        description="What happens when you click ✕ on a worktree row. `Stash` keeps your dirty changes safe (default), `Force` discards them, `Ask` prompts each time."
        control={
          <SelectChips<ArchiveBehavior>
            value={settings.archiveBehavior}
            onChange={(v) => update({ archiveBehavior: v })}
            options={[
              { value: "stash", label: "Stash & archive" },
              { value: "force", label: "Force archive" },
              { value: "ask", label: "Ask each time" },
            ]}
          />
        }
      />

      <SettingRow
        title="Worktrees directory"
        description="Where worktree checkouts live on disk. Each project gets its own subdirectory."
        control={
          <code
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--text-tertiary)",
            }}
          >
            ~/Library/Application Support/RLI/worktrees
          </code>
        }
      />
    </div>
  );
}

function GitSection({ settings }: { settings: Settings }) {
  const dispatch = useAppDispatch();
  const update = (patch: Partial<Settings>) =>
    dispatch({ type: "update-settings", patch });

  // One-shot probe for the user's GitHub login so the radio option can
  // render "GitHub username (raeedzz)" instead of an empty parenthetical.
  // Cached in settings.githubUsername; we only re-probe when empty so a
  // repeat visit to the settings page doesn't shell out to `gh` again.
  useEffect(() => {
    if (settings.githubUsername) return;
    let cancelled = false;
    invoke<string>("gh_username")
      .then((name) => {
        if (cancelled) return;
        const trimmed = name.trim();
        if (trimmed) update({ githubUsername: trimmed });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.githubUsername]);

  const githubLabel = settings.githubUsername
    ? `GitHub username (${settings.githubUsername})`
    : "GitHub username";
  const githubDisabled = !settings.githubUsername;

  return (
    <div style={{ display: "flex", flexDirection: "column", maxWidth: 760 }}>
      <div style={{ padding: "var(--space-4) 0", borderBottom: "var(--border-1)" }}>
        <div
          style={{
            fontSize: "var(--text-md)",
            fontWeight: "var(--weight-medium)",
            color: "var(--text-primary)",
          }}
        >
          Branch name prefix
        </div>
        <div
          style={{
            marginTop: 4,
            fontSize: "var(--text-xs)",
            lineHeight: "var(--leading-base)",
            color: "var(--text-tertiary)",
            maxWidth: 520,
          }}
        >
          Prefix for new workspace branch names.
        </div>
        <div
          role="radiogroup"
          style={{
            marginTop: "var(--space-3)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
          }}
        >
          <RadioOption
            checked={settings.branchPrefixMode === "github"}
            disabled={githubDisabled}
            label={githubLabel}
            hint={
              githubDisabled
                ? "Sign in with `gh auth login` to enable this option."
                : undefined
            }
            onSelect={() => update({ branchPrefixMode: "github" })}
          />
          <RadioOption
            checked={settings.branchPrefixMode === "custom"}
            label="Custom"
            onSelect={() => update({ branchPrefixMode: "custom" })}
            trailing={
              settings.branchPrefixMode === "custom" ? (
                <input
                  type="text"
                  value={settings.customBranchPrefix}
                  onChange={(e) =>
                    update({ customBranchPrefix: e.target.value })
                  }
                  placeholder="e.g. team-name"
                  style={{
                    marginLeft: "var(--space-2)",
                    height: 26,
                    padding: "0 8px",
                    borderRadius: "var(--radius-sm)",
                    border: "var(--border-1)",
                    backgroundColor: "var(--surface-2)",
                    color: "var(--text-primary)",
                    fontSize: "var(--text-xs)",
                    fontFamily: "var(--font-mono)",
                    width: 200,
                  }}
                />
              ) : null
            }
          />
          <RadioOption
            checked={settings.branchPrefixMode === "none"}
            label="None"
            onSelect={() => update({ branchPrefixMode: "none" })}
          />
        </div>
      </div>

      <SettingRow
        title="Delete branch on archive"
        description={
          <>
            Delete the local branch when archiving a workspace.
            <br />
            To delete the remote branch,{" "}
            <a
              href="https://github.com/settings/repositories"
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--text-secondary)", textDecoration: "underline" }}
            >
              configure it on GitHub
            </a>
            .
          </>
        }
        control={
          <Toggle
            checked={settings.deleteBranchOnArchive}
            onChange={(v) => update({ deleteBranchOnArchive: v })}
          />
        }
      />

      <SettingRow
        title="Archive on merge"
        description="Automatically archive a workspace after merging its PR in RLI."
        control={
          <Toggle
            checked={settings.archiveOnMerge}
            onChange={(v) => update({ archiveOnMerge: v })}
          />
        }
      />
    </div>
  );
}

function RadioOption({
  checked,
  disabled,
  label,
  hint,
  onSelect,
  trailing,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  hint?: string;
  onSelect: () => void;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: 0,
        background: "transparent",
        border: "none",
        cursor: disabled ? "default" : "pointer",
        color: disabled ? "var(--text-tertiary)" : "var(--text-primary)",
        fontSize: "var(--text-sm)",
        textAlign: "left",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          width: 16,
          height: 16,
          borderRadius: "var(--radius-pill)",
          border: checked
            ? "1.5px solid var(--text-primary)"
            : "1.5px solid var(--surface-4)",
          backgroundColor: "transparent",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "border-color var(--motion-fast) var(--ease-out-quart)",
        }}
      >
        {checked && (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "var(--radius-pill)",
              backgroundColor: "var(--text-primary)",
            }}
          />
        )}
      </span>
      <span style={{ display: "inline-flex", flexDirection: "column" }}>
        <span>{label}</span>
        {hint && (
          <span
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--text-tertiary)",
              marginTop: 2,
            }}
          >
            {hint}
          </span>
        )}
      </span>
      {trailing}
    </button>
  );
}

/* ------------------------------------------------------------------
   Primitives
   ------------------------------------------------------------------ */

const HELPER_CLI_OPTIONS: { value: AgentCli; label: string }[] = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "gemini", label: "Gemini" },
];

/**
 * Curated model options per CLI. The empty-string value means "let the
 * CLI pick its default" — we omit `--model` entirely on the backend.
 * Users running newer CLI versions with models we don't list here can
 * stay on Default and get whatever ships as the binary's current
 * default; we'll add chips as the lineup stabilizes.
 */
const HELPER_MODEL_OPTIONS: Record<
  AgentCli,
  Array<{ value: string; label: string }>
> = {
  claude: [
    { value: "", label: "Default" },
    { value: "opus", label: "Opus" },
    { value: "sonnet", label: "Sonnet" },
    { value: "haiku", label: "Haiku" },
  ],
  codex: [
    { value: "", label: "Default" },
    { value: "gpt-5-codex", label: "GPT-5 Codex" },
    { value: "gpt-5", label: "GPT-5" },
    { value: "o4-mini", label: "o4-mini" },
  ],
  gemini: [
    { value: "", label: "Default" },
    { value: "gemini-2.5-pro", label: "2.5 Pro" },
    { value: "gemini-2.5-flash", label: "2.5 Flash" },
    { value: "gemini-2.5-flash-lite", label: "Flash Lite" },
  ],
};

function HelperTaskControl({
  cli,
  model,
  onCliChange,
  onModelChange,
}: {
  cli: AgentCli;
  model: string;
  onCliChange: (v: AgentCli) => void;
  onModelChange: (v: string) => void;
}) {
  const modelOptions = HELPER_MODEL_OPTIONS[cli];
  // If the persisted model isn't in the curated list for the current
  // CLI (CLI changed, or list shifted between versions), fall back to
  // empty so the UI shows a valid selection.
  const safeModel = modelOptions.some((o) => o.value === model) ? model : "";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-1-5)",
        alignItems: "flex-end",
      }}
    >
      <SelectChips<AgentCli>
        value={cli}
        onChange={onCliChange}
        options={HELPER_CLI_OPTIONS}
      />
      <SelectChips<string>
        value={safeModel}
        onChange={onModelChange}
        options={modelOptions}
      />
    </div>
  );
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div
      style={{
        marginTop: "var(--space-6)",
        marginBottom: "var(--space-2)",
        paddingTop: "var(--space-4)",
        borderTop: "var(--border-1)",
        fontSize: "var(--text-2xs)",
        letterSpacing: "var(--tracking-wide)",
        textTransform: "uppercase",
        color: "var(--text-tertiary)",
      }}
    >
      {label}
    </div>
  );
}

function SettingRow({
  title,
  description,
  control,
}: {
  title: string;
  description?: ReactNode;
  control: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-6)",
        padding: "var(--space-4) 0",
        borderBottom: "var(--border-1)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "var(--text-md)",
            fontWeight: "var(--weight-medium)",
            color: "var(--text-primary)",
          }}
        >
          {title}
        </div>
        {description && (
          <div
            style={{
              marginTop: 4,
              fontSize: "var(--text-xs)",
              lineHeight: "var(--leading-base)",
              color: "var(--text-tertiary)",
              maxWidth: 520,
            }}
          >
            {description}
          </div>
        )}
      </div>
      <div style={{ flexShrink: 0 }}>{control}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const onStyle: CSSProperties = {
    position: "relative",
    width: 36,
    height: 20,
    borderRadius: "var(--radius-pill)",
    backgroundColor: checked ? "var(--accent)" : "var(--surface-3)",
    transition: "background-color var(--motion-fast) var(--ease-out-quart)",
    cursor: "default",
    flexShrink: 0,
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={onStyle}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: 2,
          left: 2,
          width: 16,
          height: 16,
          borderRadius: "var(--radius-pill)",
          backgroundColor: checked ? "var(--text-inverse)" : "var(--text-secondary)",
          transform: checked ? "translateX(16px)" : "translateX(0)",
          transition: "transform var(--motion-fast) var(--ease-out-quart)",
          boxShadow: "0 1px 2px oklch(0% 0 0 / 0.4)",
        }}
      />
    </button>
  );
}

function SelectChips<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div
      role="radiogroup"
      style={{
        display: "inline-flex",
        padding: 2,
        borderRadius: "var(--radius-md)",
        backgroundColor: "var(--surface-2)",
        border: "var(--border-1)",
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            style={{
              height: 26,
              padding: "0 10px",
              borderRadius: "var(--radius-sm)",
              backgroundColor: active ? "var(--surface-4)" : "transparent",
              color: active ? "var(--text-primary)" : "var(--text-secondary)",
              fontSize: "var(--text-xs)",
              fontWeight: "var(--weight-medium)",
              transition:
                "background-color var(--motion-instant) var(--ease-out-quart)," +
                "color var(--motion-instant) var(--ease-out-quart)",
            }}
            onMouseOver={(e) => {
              if (!active) e.currentTarget.style.color = "var(--text-primary)";
            }}
            onMouseOut={(e) => {
              if (!active) e.currentTarget.style.color = "var(--text-secondary)";
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
