export type ProjectId = string;
export type WorktreeId = string;
export type TabId = string;
export type PtyId = string;
export type ArchiveId = string;

/**
 * The chrome ships in three persistent column families:
 *   sidebar (projects + worktrees) | main column (tabs) | right panel
 */

export type AgentCli = "claude" | "codex" | "gemini";

export type AgentStatus = "idle" | "running";

/** Workshop-pigment palette — see tokens.css `--tag-*` */
export type TagId =
  | "default"
  | "rust"
  | "amber"
  | "moss"
  | "pine"
  | "slate"
  | "iris"
  | "rose";

export const TAG_IDS: readonly TagId[] = [
  "default",
  "rust",
  "amber",
  "moss",
  "pine",
  "slate",
  "iris",
  "rose",
];

export function tagVar(tag: TagId | undefined): string {
  return `var(--tag-${tag ?? "default"})`;
}

/* ------------------------------------------------------------------
   Project — a git repo on disk. One row in the sidebar's Projects
   section. Expanded reveals its worktrees.
   ------------------------------------------------------------------ */

export interface Project {
  id: ProjectId;
  path: string;
  name: string;
  /** 1–2 character glyph fallback used when no favicon resolved. */
  glyph: string;
  /** Resolved at scan time; data URI if found. Null if no icon source. */
  faviconDataUri: string | null;
  /**
   * User-picked icon key from the picker registry (e.g. `Folder01`,
   * `Brain`) — a stable name resolved to a Phosphor glyph via
   * `lookupPickerIcon`. Renders ahead of `faviconDataUri` and `glyph`
   * when set. Lives on Project; worktrees inherit this unless they
   * have their own override.
   */
  iconName?: string;
  pinned: boolean;
  /** Sidebar expand-collapse state. */
  expanded: boolean;
  /** User-assigned color tag. */
  color?: TagId;
  /**
   * Per-repo configuration surfaced via the Repository settings tab.
   * Optional so existing persisted projects rehydrate cleanly; the
   * settings tab and helper code use {@link projectSettings} to read
   * with defaults filled in.
   */
  settings?: ProjectSettings;
}

/* ------------------------------------------------------------------
   Per-repo settings — surfaced via the Repository settings tab.
   ------------------------------------------------------------------ */

/**
 * Custom-instruction strings appended to helper-agent prompts when
 * the corresponding chrome action fires. Empty string = no extras.
 *
 * - `general`     — prepended to *every* helper-agent call
 * - `createPR`    — appended to PR draft prompts
 * - `review`      — appended to code-review prompts (Review button)
 * - `fixErrors`   — appended to fix-errors prompts (Fix errors button)
 * - `resolveConflicts` — appended to merge-conflict resolution prompts
 * - `branchRename` — appended to branch-rename prompts
 */
export interface RepoPreferences {
  general: string;
  createPR: string;
  review: string;
  fixErrors: string;
  resolveConflicts: string;
  branchRename: string;
}

export interface ProjectSettings {
  /** Branch new worktrees off of, e.g. `origin/main`. */
  baseBranch: string;
  /** Remote name used for push/pull/PR (default `origin`). */
  remote: string;
  /**
   * Optional override for the secondary panel's "Open" button. Supports
   * `$RLI_WORKTREE_NAME`, `$RLI_PORT`, `$RLI_PROJECT_ID` placeholders;
   * empty string falls through to auto-detection from terminal output.
   */
  previewUrl: string;
  /**
   * Glob patterns (one per line) of files to copy from the repo root
   * into newly-created worktree checkouts. Used for `.env*`, secrets,
   * and other gitignored files the agent needs to run.
   */
  filesToCopy: string[];
  /** Shell snippet run after `git worktree add` completes. */
  setupScript: string;
  /** Shell snippet executed when the user clicks the play button. */
  runScript: string;
  /** Shell snippet run before `git worktree remove` archives the dir. */
  archiveScript: string;
  prefs: RepoPreferences;
}

export const DEFAULT_REPO_PREFERENCES: RepoPreferences = {
  general: "",
  createPR: "",
  review: "",
  fixErrors: "",
  resolveConflicts: "",
  branchRename: "",
};

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  baseBranch: "origin/main",
  remote: "origin",
  previewUrl: "",
  filesToCopy: [".env*"],
  setupScript: "",
  runScript: "",
  archiveScript: "",
  prefs: DEFAULT_REPO_PREFERENCES,
};

/**
 * Apply the user's branch-prefix setting to an auto-generated branch
 * name. Returns the bare name verbatim when the prefix can't be
 * resolved (no gh login resolved yet, or `custom` mode with an empty
 * prefix). Prefixes are slugified to be branch-name-legal — strips
 * leading `@`, collapses non-alnum into `-`, trims `-` from edges.
 */
export function applyBranchPrefix(
  base: string,
  mode: BranchPrefixMode,
  githubUsername: string,
  customPrefix: string,
): string {
  if (!base) return base;
  let raw = "";
  if (mode === "github") raw = githubUsername;
  else if (mode === "custom") raw = customPrefix;
  const prefix = sanitizeBranchPrefix(raw);
  if (!prefix) return base;
  return `${prefix}/${base}`;
}

function sanitizeBranchPrefix(raw: string): string {
  return raw
    .trim()
    .replace(/^@+/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Read a project's settings with defaults filled in. */
export function projectSettings(project: Project | null | undefined): ProjectSettings {
  return {
    ...DEFAULT_PROJECT_SETTINGS,
    ...(project?.settings ?? {}),
    prefs: {
      ...DEFAULT_REPO_PREFERENCES,
      ...(project?.settings?.prefs ?? {}),
    },
  };
}

/* ------------------------------------------------------------------
   Worktree — a git worktree of a project. Owns its own tabs, a chatbox
   target, and a secondary terminal in the right panel.
   ------------------------------------------------------------------ */

export type RightPanelTab = "files" | "changes" | "skills" | "browser";
export type SecondaryTab = "setup" | "run" | "terminal";

export interface Worktree {
  id: WorktreeId;
  projectId: ProjectId;
  /** Branch checked out in the worktree, e.g. `fix-enrich-phase-stuck`. */
  branch: string;
  /** User label, e.g. "Fix enrich phase stuck". */
  name: string;
  /** Absolute worktree checkout dir. */
  path: string;
  /** +N changes count from `git_status`. Polled. */
  changeCount: number;
  agentStatus: AgentStatus;
  agentCli: AgentCli | null;
  createdAt: number;

  /** Tabs (terminal / diff / markdown) in the main column for this worktree. */
  tabIds: TabId[];
  activeTabId: TabId | null;

  /** Right-panel selected tab and split position. */
  rightPanel: RightPanelTab;
  /** Vertical split between right-panel upper and the secondary terminal. */
  rightSplitPct: number;
  secondaryTab: SecondaryTab;
  /**
   * Each entry is a separate PTY rendered as its own tab in the secondary
   * panel. Created lazily — the first one is seeded from the legacy
   * `secondaryPtyId` so existing state migrates cleanly.
   */
  secondaryTerminals: PtyId[];
  /** Which secondaryTerminals[] entry is currently visible. */
  secondaryActiveTerminalId: PtyId | null;
  /** Legacy single-PTY id. Kept for migration; do not read directly. */
  secondaryPtyId: PtyId;
  /** When true, the secondary panel is minimized to just its tab header. */
  secondaryCollapsed?: boolean;

  /** User-assigned color tag (sidebar accent). */
  color?: TagId;
  /** User-picked HugeIcons component name (overrides project's choice). */
  iconName?: string;
  /**
   * True when the backing directory on disk has gone missing between
   * launches (e.g. the user deleted it manually). Transient — set by a
   * post-hydrate `fs_paths_exist` sweep; never persisted. Drives the
   * "missing" visual state in the sidebar and the recovery panel that
   * replaces the terminal in the main column, both of which prevent
   * downstream commands from cascading into `cwd does not exist`
   * errors the user can't act on.
   */
  missing?: boolean;
}

/* ------------------------------------------------------------------
   Tab — what shows in the main column. Three kinds for v1.
   ------------------------------------------------------------------ */

export type MarkdownMode = "diff" | "preview" | "edit";

interface TabBase {
  id: TabId;
  worktreeId: WorktreeId;
  /** Top line on the tab strip. Auto-generated for terminal tabs from
      the user's first prompt, or filename for diff/markdown tabs. */
  title: string;
  /** 11px tertiary line under the title — live activity for terminals,
      file path for diff/markdown. The differentiator. */
  summary: string;
  summaryUpdatedAt: number;
}

export interface TerminalTab extends TabBase {
  kind: "terminal";
  ptyId: PtyId;
  /** Detected CLI (set by helper-agent detection on each prompt block). */
  detectedCli: AgentCli | null;
  agentStatus: AgentStatus;
}

export interface DiffTab extends TabBase {
  kind: "diff";
  filePath: string;
  staged: boolean;
}

export interface MarkdownTab extends TabBase {
  kind: "markdown";
  filePath: string;
  mode: MarkdownMode;
  /** In-memory cache of file content. Updated on every keystroke. */
  content: string | null;
  /**
   * The content as it currently exists on disk (last successful
   * read or write). The tab is "dirty" — unsaved edits — exactly
   * when `content !== savedContent`. Null until the file has been
   * read from disk.
   */
  savedContent: string | null;
  /**
   * One-shot navigation target. When set (e.g. by the search overlay
   * opening a hit), the embedded editor scrolls to (line, column) on
   * mount, selects the line, and briefly flashes it so the user
   * can spot the match. Both axes are 1-based to match rg's output
   * format and what people read in error messages. Consumed exactly
   * once — the reducer's `clear-tab-open-at` action strips it after
   * the editor reports the navigation done, so subsequent re-mounts
   * (tab-switch then back) don't re-jump.
   */
  openAt?: { line: number; column: number };
}

/** Tab variant rendering the per-repo Repository Settings page. */
export interface ProjectSettingsTab extends TabBase {
  kind: "project-settings";
  projectId: ProjectId;
}

/**
 * Tab variant rendering every uncommitted file's diff as one
 * scrollable view. Opened from the chrome's `+N -M` diff trigger,
 * dismissed like any other tab. No per-tab state beyond what `TabBase`
 * carries — the view reads `git status` + per-file `git diff` live,
 * so a fresh edit just re-renders.
 */
export interface AllChangesTab extends TabBase {
  kind: "all-changes";
}

/**
 * Tab variant showing one commit from the history graph: metadata
 * (author, sha, parents, refs, message) plus the full diff the commit
 * introduced. Opened by clicking a row in the right panel's History
 * section. Only the hash is stored — the view loads everything live.
 */
export interface CommitTab extends TabBase {
  kind: "commit";
  hash: string;
}

export type Tab =
  | TerminalTab
  | DiffTab
  | MarkdownTab
  | ProjectSettingsTab
  | AllChangesTab
  | CommitTab;

/**
 * Which page the Settings overlay shows. `general` = global RLI
 * settings; `repository` = per-repo settings for the named project.
 * Lives on AppState so the Sidebar's "Repository settings" entry can
 * deep-link directly to a specific repo's page.
 */
export type SettingsSection =
  | { kind: "general" }
  | { kind: "git" }
  | { kind: "repository"; id: ProjectId };

/* ------------------------------------------------------------------
   Archive — a previously-active worktree, persisted on close.
   Restorable from the History section.
   ------------------------------------------------------------------ */

/* ------------------------------------------------------------------
   Settings — user preferences. Persisted across launches.
   ------------------------------------------------------------------ */

export type CompletionSound = "none" | "subtle" | "bell";
export type ArchiveBehavior = "stash" | "force" | "ask";
export type BranchPrefixMode = "github" | "custom" | "none";

export interface Settings {
  /** Show a macOS notification when an agent in a worktree goes idle. */
  notifyOnIdle: boolean;
  /** Play a sound when an agent in a worktree goes idle. */
  completionSound: CompletionSound;
  /**
   * Always render the breadcrumb's `n% / 5h` Anthropic-window pill,
   * even when no Claude transcript was found. Off by default — the
   * pill self-hides when there's no active session, matching the
   * "boring on purpose" .impeccable.md discipline.
   */
  alwaysShowContextUsage: boolean;
  /**
   * Prevent the system from sleeping while any worktree's agent is
   * running. Implemented via macOS `caffeinate -di` once the backend
   * command lands (TODO).
   */
  caffeinate: boolean;
  /**
   * Which CLI to spawn for helper operations (PR drafting, commit
   * messages, AskCard) when the active worktree hasn't detected one.
   * Acts as the fallback when a per-task override below isn't set
   * explicitly — kept for backwards compat with v2 saved state.
   */
  defaultHelperCli: AgentCli;
  /** CLI used to draft commit messages (right-panel "AI draft" button). */
  helperCliCommit: AgentCli;
  /**
   * Optional model name passed to the commit-message CLI via
   * `--model <name>`. Empty string = let the CLI pick its own default.
   * Strings are CLI-specific; switching `helperCliCommit` clears this.
   */
  helperModelCommit: string;
  /** CLI used to draft PR titles + bodies in the Create-PR dialog. */
  helperCliPr: AgentCli;
  /** Optional `--model <name>` for PR drafting. */
  helperModelPr: string;
  /** CLI used by the editor's ⌘L "Ask" overlay to explain selected code. */
  helperCliExplain: AgentCli;
  /** Optional `--model <name>` for the explain overlay. */
  helperModelExplain: string;
  /**
   * Drive the helper-agent–driven tab-summary polling. Off skips the
   * subprocess invocations — the tab subtitle then shows the launch
   * command (cheaper if you're running many parallel agents).
   */
  autoSummarize: boolean;
  /**
   * Default behavior when archiving a worktree from the sidebar.
   *   stash → `git stash push -u` then `git worktree remove`.
   *   force → `git worktree remove --force` (drops dirty changes).
   *   ask   → prompt each time.
   */
  archiveBehavior: ArchiveBehavior;
  /**
   * Prefix applied to auto-generated worktree branch names. Lets a
   * team share a fork without colliding on `eiffel`-style landmark
   * names — `raeedzz/eiffel` is unmistakably mine.
   *   github → `<gh-login>/<branch>` (auto-resolved via `gh api user`)
   *   custom → `<customBranchPrefix>/<branch>` (verbatim string)
   *   none   → no prefix (legacy behavior)
   */
  branchPrefixMode: BranchPrefixMode;
  /** Verbatim string used when `branchPrefixMode === "custom"`. */
  customBranchPrefix: string;
  /**
   * Cached GitHub login. Filled by a one-shot `gh api user` lookup so
   * the Git-settings page can show "GitHub username (xxx)" without
   * re-shelling on every render. Cleared if the lookup fails.
   */
  githubUsername: string;
  /**
   * Delete the local branch when archiving a worktree. Mirrors what
   * GitHub does after a merged PR if the repo is configured that way.
   * Remote-branch deletion stays on the server (configure in GitHub
   * repo settings), as the chrome label notes.
   */
  deleteBranchOnArchive: boolean;
  /**
   * Auto-archive a worktree once its PR transitions to MERGED. Polls
   * via the existing `pr_status` cadence, archives the first time it
   * sees MERGED for a given worktree.
   */
  archiveOnMerge: boolean;
}

/** Resize bounds for the side columns. Reducer clamps writes here. */
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 264;
export const RIGHT_MIN = 280;
export const RIGHT_MAX = 720;
export const RIGHT_DEFAULT = 516;

export function clampSidebar(w: number): number {
  if (Number.isNaN(w)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));
}

export function clampRight(w: number): number {
  if (Number.isNaN(w)) return RIGHT_DEFAULT;
  return Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, Math.round(w)));
}

export const DEFAULT_SETTINGS: Settings = {
  notifyOnIdle: true,
  completionSound: "subtle",
  alwaysShowContextUsage: false,
  caffeinate: true,
  defaultHelperCli: "claude",
  helperCliCommit: "claude",
  helperModelCommit: "",
  helperCliPr: "claude",
  helperModelPr: "",
  helperCliExplain: "claude",
  helperModelExplain: "",
  autoSummarize: true,
  archiveBehavior: "stash",
  branchPrefixMode: "github",
  customBranchPrefix: "",
  githubUsername: "",
  deleteBranchOnArchive: false,
  archiveOnMerge: false,
};

export interface ArchiveRecord {
  id: ArchiveId;
  projectId: ProjectId;
  branch: string;
  name: string;
  createdAt: number;
  archivedAt: number;
  lastSummary: string;
  changeCountAtArchive: number;
  /** Original worktree checkout path — the restore target. */
  originalPath: string;
  agentCli: AgentCli | null;
  /** Stash ref iff archive used `stash` option. */
  stashRef?: string;
}

/* ------------------------------------------------------------------
   App state
   ------------------------------------------------------------------ */

export interface AppState {
  /** Project records keyed by id. */
  projects: Record<ProjectId, Project>;
  /** Display order in the sidebar. */
  projectOrder: ProjectId[];

  /** Worktree records keyed by id. */
  worktrees: Record<WorktreeId, Worktree>;

  /** Tab records keyed by id. */
  tabs: Record<TabId, Tab>;

  activeProjectId: ProjectId | null;
  activeWorktreeByProject: Record<ProjectId, WorktreeId | null>;

  archivedWorktrees: ArchiveRecord[];

  sidebarCollapsed: boolean;
  rightPanelCollapsed: boolean;

  /** Resizable column widths in px. Persisted across launches; clamped
      to [SIDEBAR_MIN, SIDEBAR_MAX] / [RIGHT_MIN, RIGHT_MAX] at the
      reducer boundary so out-of-bounds blobs can't break the layout. */
  sidebarWidth: number;
  rightPanelWidth: number;

  paletteOpen: boolean;
  searchOpen: boolean;
  settingsOpen: boolean;
  /** Which page the Settings overlay shows when opened. Lifted out of
      the view so callers can deep-link into a specific repo's page
      (e.g. the Sidebar's "Repository settings" entry). */
  settingsSection: SettingsSection;
  prDialogOpen: {
    worktreeId: WorktreeId;
    /**
     * "manual" leaves the title/body empty so the user fills them in
     * themselves; "auto" calls pr_draft to pre-populate via the
     * worktree's helper-CLI agent.
     */
    mode: "manual" | "auto";
  } | null;

  settings: Settings;
  markdownView: "rich" | "source";
}

/* ------------------------------------------------------------------
   Reducer actions
   ------------------------------------------------------------------ */

export type AppAction =
  // Projects
  | { type: "set-active-project"; id: ProjectId }
  | { type: "add-project"; project: Project }
  | { type: "remove-project"; id: ProjectId }
  | { type: "reorder-projects"; ids: ProjectId[] }
  | { type: "set-project-expanded"; id: ProjectId; expanded: boolean }
  | { type: "set-project-color"; id: ProjectId; color: TagId | undefined }
  | { type: "set-project-icon"; id: ProjectId; iconName: string | undefined }
  | { type: "update-project"; id: ProjectId; patch: Partial<Project> }
  | {
      type: "update-project-settings";
      id: ProjectId;
      patch: Partial<ProjectSettings>;
    }
  | {
      type: "update-project-prefs";
      id: ProjectId;
      patch: Partial<RepoPreferences>;
    }
  | {
      type: "set-worktree-icon";
      worktreeId: WorktreeId;
      iconName: string | undefined;
    }

  // Worktrees
  | { type: "add-worktree"; worktree: Worktree }
  | { type: "update-worktree"; id: WorktreeId; patch: Partial<Worktree> }
  | { type: "set-active-worktree"; projectId: ProjectId; worktreeId: WorktreeId }
  /** Drag-reorder a worktree relative to a sibling row. Both must
      belong to the same project — cross-repo moves are rejected. */
  | {
      type: "reorder-worktree";
      id: WorktreeId;
      targetId: WorktreeId;
      edge: "above" | "below";
    }
  | { type: "archive-worktree"; id: WorktreeId; record: ArchiveRecord }
  | { type: "restore-worktree"; archiveId: ArchiveId; worktree: Worktree }
  | { type: "set-right-panel"; worktreeId: WorktreeId; panel: RightPanelTab }
  | { type: "set-secondary-tab"; worktreeId: WorktreeId; tab: SecondaryTab }
  | { type: "add-secondary-terminal"; worktreeId: WorktreeId }
  | { type: "select-secondary-terminal"; worktreeId: WorktreeId; ptyId: PtyId }
  | { type: "close-secondary-terminal"; worktreeId: WorktreeId; ptyId: PtyId }
  | { type: "toggle-secondary-collapsed"; worktreeId: WorktreeId }
  | { type: "set-right-split-pct"; worktreeId: WorktreeId; pct: number }
  | { type: "set-agent-status"; worktreeId: WorktreeId; status: AgentStatus; cli?: AgentCli | null }
  | { type: "set-change-count"; worktreeId: WorktreeId; count: number }

  // Tabs
  | { type: "open-tab"; tab: Tab; activate?: boolean }
  | { type: "close-tab"; id: TabId }
  | { type: "select-tab"; worktreeId: WorktreeId; id: TabId }
  | { type: "update-tab"; id: TabId; patch: Partial<Tab> }
  | { type: "set-tab-summary"; id: TabId; summary: string }

  // Chrome
  | { type: "toggle-sidebar" }
  | { type: "toggle-right-panel" }
  | { type: "set-sidebar-width"; width: number }
  | { type: "set-right-panel-width"; width: number }
  | { type: "toggle-palette" }
  | { type: "set-palette"; open: boolean }
  | { type: "toggle-search" }
  | { type: "set-search"; open: boolean }
  | {
      type: "set-pr-dialog";
      worktreeId: WorktreeId | null;
      mode?: "manual" | "auto";
    }
  | { type: "set-settings-open"; open: boolean; section?: SettingsSection }
  | { type: "set-settings-section"; section: SettingsSection }
  | { type: "toggle-settings" }
  | { type: "update-settings"; patch: Partial<Settings> }
  | { type: "set-markdown-view"; view: "rich" | "source" }

  // Persistence
  | { type: "hydrate"; state: Partial<AppState> };

/* ------------------------------------------------------------------
   Backwards-compat re-exports.
   The previous schema used `Session` and `OpenFile`. A handful of
   callers still import these names; we export aliases pointing at
   the closest replacement so legacy code keeps compiling during the
   incremental migration. New code should use Worktree/Tab directly.
   ------------------------------------------------------------------ */

/** @deprecated alias to Worktree for legacy callers. */
export type Session = Worktree;
/** @deprecated alias to WorktreeId for legacy callers. */
export type SessionId = WorktreeId;
/** @deprecated marker — used by some legacy code paths. */
export interface OpenFile {
  path: string;
  content: string;
}
/**
 * @deprecated kept as a thin status enum so legacy primitives (StatusDot)
 * still compile. New code uses {@link AgentStatus} directly.
 */
export type SessionStatus = "idle" | "streaming" | "error";
