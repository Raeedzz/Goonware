/**
 * Central icon re-export. All chrome icons go through here so swapping
 * libraries later is a one-file change.
 *
 * We use Phosphor Icons (`@phosphor-icons/react`) under the hood. The
 * aliases below are RLI-named so call sites read like our domain, not
 * the icon library's catalog. Icons inherit color from the parent
 * (`currentColor`) and take a `size` prop (px); line weight follows
 * Phosphor's `weight` (default `regular`).
 */

import { forwardRef } from "react";
import {
  SidebarIcon,
  SidebarSimpleIcon,
  type IconProps,
} from "@phosphor-icons/react";

export {
  // Layout & shell chrome
  SidebarIcon as IconSidebar,
  PlusIcon as IconPlus,
  XIcon as IconClose,
  ArrowLeftIcon as IconBack,
  ArrowRightIcon as IconForward,
  CaretDownIcon as IconChevronDown,
  CaretRightIcon as IconChevronRight,
  CaretUpIcon as IconChevronUp,
  ArrowUpIcon as IconArrowUp,
  DotsThreeVerticalIcon as IconMore,
  FunnelIcon as IconFilter,

  // Navigation
  ClockCounterClockwiseIcon as IconHistory,
  QuestionIcon as IconHelp,
  GearIcon as IconSettings,

  // Project / worktree
  FolderIcon as IconFolder,
  FolderPlusIcon as IconFolderAdd,
  GitBranchIcon as IconBranch,
  CircleNotchIcon as IconRunning,
  KanbanIcon as IconProject,

  // Files & content
  FileCodeIcon as IconFile,
  CodeIcon as IconCode,
  GitMergeIcon as IconDiff,
  GitPullRequestIcon as IconPullRequest,
  GitCommitIcon as IconCommit,
  GithubLogoIcon as IconGithub,
  // Stacked `+` over `−` glyph used by the chrome's diff button.
  // Reads as additions-and-deletions at a glance, distinct from the
  // git-merge `IconDiff` used for branch-level operations.
  PlusMinusIcon as IconPlusMinus,

  // Actions
  MagnifyingGlassIcon as IconSearch,
  ArrowsClockwiseIcon as IconRefresh,
  ArrowClockwiseIcon as IconReload,
  PencilSimpleIcon as IconEdit,
  CheckIcon as IconCheck,
  StopCircleIcon as IconStop,
  PlayCircleIcon as IconPlay,
  SparkleIcon as IconSparkles,
  CloudArrowUpIcon as IconPush,

  // Terminal & memory
  TerminalWindowIcon as IconTerminal,
  BrainIcon as IconMemory,

  // Connections / browser
  GraphIcon as IconConnections,
  BrowserIcon as IconBrowser,
} from "@phosphor-icons/react";

/**
 * Right-side variants. Phosphor only ships left-anchored sidebar
 * glyphs, so we mirror them: the divider lands on the right edge,
 * visually pointing toward the panel each button toggles.
 */
export const IconSidebarRight = forwardRef<SVGSVGElement, IconProps>(
  (props, ref) => <SidebarIcon ref={ref} mirrored {...props} />,
);
IconSidebarRight.displayName = "IconSidebarRight";

export const IconRightPanel = forwardRef<SVGSVGElement, IconProps>(
  (props, ref) => <SidebarSimpleIcon ref={ref} mirrored {...props} />,
);
IconRightPanel.displayName = "IconRightPanel";
