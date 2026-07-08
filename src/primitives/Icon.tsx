import type { SVGProps, CSSProperties } from "react";
import {
  FolderIcon as PhFolder,
  MagnifyingGlassIcon as PhSearch,
  GraphIcon as PhGraph,
  GitBranchIcon as PhGitBranch,
  GearIcon as PhGear,
  TerminalWindowIcon as PhTerminal,
  FileCodeIcon as PhFileCode,
  BrainIcon as PhBrain,
  CaretRightIcon as PhCaretRight,
} from "@phosphor-icons/react";

/**
 * Legacy named icons retained for callers across the app. Underneath
 * they render via Phosphor Icons (`@phosphor-icons/react`, currentColor).
 *
 * All icons inherit color from the parent (`currentColor`), so theme
 * tokens flow naturally. Callers continue to pass `size` (px) and any
 * standard SVG props. Phosphor controls line weight via `weight` rather
 * than `strokeWidth`; the legacy `strokeWidth` prop is accepted for
 * call-site compatibility but no longer forwarded.
 */

type IconProps = Omit<SVGProps<SVGSVGElement>, "strokeWidth"> & {
  size?: number;
  strokeWidth?: number;
};

function commonProps(p: IconProps) {
  const { size = 16, strokeWidth: _strokeWidth, ...rest } = p;
  return {
    size,
    color: "currentColor",
    ...rest,
  };
}

export function FolderIcon(props: IconProps) {
  return <PhFolder {...commonProps(props)} />;
}

export function SearchIcon(props: IconProps) {
  return <PhSearch {...commonProps(props)} />;
}

export function ConnectionsIcon(props: IconProps) {
  return <PhGraph {...commonProps(props)} />;
}


export function GitIcon(props: IconProps) {
  return <PhGitBranch {...commonProps(props)} />;
}

export function SettingsIcon(props: IconProps) {
  return <PhGear {...commonProps(props)} />;
}

export function TerminalIcon(props: IconProps) {
  return <PhTerminal {...commonProps(props)} />;
}

export function FileIcon(props: IconProps) {
  return <PhFileCode {...commonProps(props)} />;
}

export function GraphIcon(props: IconProps) {
  return <PhBrain {...commonProps(props)} />;
}

export function ChevronIcon(props: IconProps & { open?: boolean }) {
  const { open, style, ...rest } = props;
  const merged: CSSProperties = {
    ...style,
    transform: open ? "rotate(90deg)" : "rotate(0deg)",
    transition: "transform var(--motion-instant) var(--ease-out-quart)",
  };
  return <PhCaretRight {...commonProps(rest)} style={merged} />;
}
