/**
 * VS Code icons (codicons) for the sidebar chrome.
 *
 * These render the *exact* glyphs from Visual Studio Code by using
 * Microsoft's official `@vscode/codicons` icon font. Each alias below maps
 * an RLI-domain name to a codicon name so call sites read like our domain,
 * not the icon catalog — mirroring the `@/design/icons` convention.
 *
 * The font + base `.codicon` class are loaded once via the CSS imported in
 * `main.tsx`. A glyph inherits `currentColor` and scales with `font-size`,
 * so these accept the same `size` prop the hugeicons did.
 */
import type { CSSProperties, ComponentType } from "react";

type CodiconProps = {
  /** Pixel size of the glyph (maps to font-size). */
  size?: number;
  className?: string;
  style?: CSSProperties;
  color?: string;
};

/** Render a single codicon by name. */
export function Codicon({
  name,
  size = 16,
  className,
  style,
  color,
}: CodiconProps & { name: string }) {
  return (
    <i
      aria-hidden="true"
      className={`codicon codicon-${name}${className ? ` ${className}` : ""}`}
      style={{
        fontSize: size,
        // line-height:1 keeps the glyph box square so it centers in flex
        // buttons the same way the old 16px SVGs did.
        lineHeight: 1,
        color,
        ...style,
      }}
    />
  );
}

/** Build a fixed-name codicon alias component (same shape as the old icons). */
const make = (name: string): ComponentType<CodiconProps> => {
  const Glyph = (props: CodiconProps) => <Codicon name={name} {...props} />;
  Glyph.displayName = `Codicon(${name})`;
  return Glyph;
};

// Layout & shell chrome
export const IconSidebar = make("layout-sidebar-left");
export const IconBack = make("arrow-left");
export const IconForward = make("arrow-right");
export const IconPlus = make("add");
export const IconClose = make("close");

// Navigation
export const IconHistory = make("history");
export const IconSettings = make("settings-gear");

// Project / worktree
export const IconFolderAdd = make("new-folder");
export const IconFolderOff = make("warning");
export const IconBranch = make("git-branch");

// Actions
export const IconEdit = make("edit");
export const IconPullRequest = make("git-pull-request");
export const IconImage = make("file-media");
export const IconColor = make("symbol-color");
export const IconHide = make("eye-closed");
export const IconDelete = make("trash");
