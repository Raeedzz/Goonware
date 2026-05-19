/**
 * Central icon re-export. All chrome icons go through here so swapping
 * libraries later is a one-file change.
 *
 * We use the `hugeicons-react` (free stroke-rounded set) under the hood.
 * The aliases below are RLI-named so call sites read like our domain,
 * not the icon library's catalog.
 */

export {
  // Layout & shell chrome
  SidebarLeftIcon as IconSidebar,
  SidebarRightIcon as IconSidebarRight,
  PanelRightIcon as IconRightPanel,
  Add01Icon as IconPlus,
  Cancel01Icon as IconClose,
  ArrowLeft01Icon as IconBack,
  ArrowRight01Icon as IconForward,
  ArrowDown01Icon as IconChevronDown,
  ArrowRight01Icon as IconChevronRight,
  ArrowUp01Icon as IconChevronUp,
  ArrowUp01Icon as IconArrowUp,
  MoreVerticalIcon as IconMore,
  FilterHorizontalIcon as IconFilter,

  // Navigation
  Clock01Icon as IconHistory,
  HelpCircleIcon as IconHelp,
  Settings01Icon as IconSettings,

  // Project / worktree
  Folder01Icon as IconFolder,
  FolderAddIcon as IconFolderAdd,
  GitBranchIcon as IconBranch,
  Loading03Icon as IconRunning,
  KanbanIcon as IconProject,

  // Files & content
  DocumentCodeIcon as IconFile,
  CodeIcon as IconCode,
  GitMergeIcon as IconDiff,
  GitPullRequestIcon as IconPullRequest,
  GitCommitIcon as IconCommit,
  GithubIcon as IconGithub,
  // Stacked `+` over `−` glyph used by the chrome's diff button.
  // Reads as additions-and-deletions at a glance, distinct from the
  // git-merge `IconDiff` used for branch-level operations.
  PlusMinus01Icon as IconPlusMinus,

  // Actions
  Search01Icon as IconSearch,
  RefreshIcon as IconRefresh,
  ReloadIcon as IconReload,
  PencilIcon as IconEdit,
  Tick01Icon as IconCheck,
  StopCircleIcon as IconStop,
  PlayCircleIcon as IconPlay,
  MagicWand01Icon as IconSparkles,
  CloudUploadIcon as IconPush,

  // Terminal & memory
  ComputerTerminal01Icon as IconTerminal,
  BrainIcon as IconMemory,

  // Connections / browser
  FlowIcon as IconConnections,
  ComputerIcon as IconBrowser,
} from "hugeicons-react";
