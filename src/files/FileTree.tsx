import { useCallback, useEffect, useState } from "react";
import { fs, type DirEntry } from "@/lib/fs";
import {
  statusVisual,
  useGitStatus,
  type GitStatusMap,
} from "@/hooks/useGitStatus";
import { paneSlotScrollChildStyle } from "@/shell/paneSlotLayout";
import { FileTypeIcon } from "./FileTypeIcon";

interface Props {
  root: string;
  onOpenFile: (path: string) => void;
  onContextMenu?: (
    path: string,
    isDir: boolean,
    e: React.MouseEvent,
  ) => void;
  activeFile?: string | null;
}

interface Node {
  name: string;
  path: string;
  isDir: boolean;
  /** undefined = not loaded yet, [] = loaded but empty */
  children?: Node[];
  expanded: boolean;
}

const INDENT = 12;
// Icons match the 12px text so glyph + filename read at the same
// visual weight. The 24px row gives 6px of breathing room around
// the 12px icon — tight, but the file tree's signal-density (one
// glance, dozens of files) wants compactness over airiness.
// Chevron column and file-type-icon column share `width: ICON_SIZE`,
// so the icon column lines up vertically regardless of which row
// is a folder vs. a file.
const ROW_HEIGHT = 24;
const ICON_SIZE = 12;
// Matches the panel header's `padding: 0 var(--space-2)`. Both the
// "FILES" caption and the row content sit on the same vertical axis
// at 8px from the panel's left edge.
const ROW_PADDING_LEFT_BASE = 8;

/**
 * Lazy file tree. Reads entries via the Rust `fs_read_dir` command,
 * which already filters out node_modules / target / .git / dist /
 * .rli session worktrees. Click a file to open it in the editor;
 * click a folder to expand.
 *
 * Custom-rolled rather than react-arborist because our needs are
 * minimal (read-only, single-select) and we want full control over
 * the row chrome.
 */
export function FileTree({
  root,
  onOpenFile,
  onContextMenu,
  activeFile,
}: Props) {
  const [tree, setTree] = useState<Node | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gitStatus = useGitStatus(root);

  useEffect(() => {
    let cancelled = false;
    setTree(null);
    setError(null);
    fs.readDir(root)
      .then((entries) => {
        if (cancelled) return;
        setTree({
          name: basename(root),
          path: root,
          isDir: true,
          expanded: true,
          children: entries.map(toNode),
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  const toggle = useCallback(async (node: Node) => {
    if (!node.isDir) return;
    if (node.children === undefined) {
      try {
        const entries = await fs.readDir(node.path);
        node.children = entries.map(toNode);
      } catch {
        node.children = [];
      }
    }
    node.expanded = !node.expanded;
    // Force re-render by replacing the tree root reference.
    setTree((prev) => (prev ? { ...prev } : prev));
  }, []);

  // Outer element is ALWAYS the scroll container — error / loading /
  // empty / loaded states render inside it. This keeps the layout
  // invariant constant (FileTree's root satisfies
  // `paneSlotScrollChildStyle`) across every render, so a long error
  // message scrolls, and the right-panel test that asserts FilesView's
  // top-level DOM has `overflow-y: auto` holds in every state.
  return (
    <div style={paneSlotScrollChildStyle({ padding: "var(--space-1) 0" })}>
      {error ? (
        <div
          style={{
            padding: "var(--space-3)",
            color: "var(--state-error)",
            fontSize: "var(--text-xs)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {error}
        </div>
      ) : !tree ? (
        <div
          style={{
            padding: "var(--space-3)",
            color: "var(--text-tertiary)",
            fontSize: "var(--text-xs)",
          }}
        >
          loading…
        </div>
      ) : (
        tree.children?.map((child) => (
          <RowSubtree
            key={child.path}
            node={child}
            depth={0}
            onToggle={toggle}
            onOpenFile={onOpenFile}
            onContextMenu={onContextMenu}
            activeFile={activeFile ?? null}
            gitStatus={gitStatus}
          />
        ))
      )}
    </div>
  );
}

function RowSubtree({
  node,
  depth,
  onToggle,
  onOpenFile,
  onContextMenu,
  activeFile,
  gitStatus,
}: {
  node: Node;
  depth: number;
  onToggle: (n: Node) => void;
  onOpenFile: (path: string) => void;
  onContextMenu?: (
    path: string,
    isDir: boolean,
    e: React.MouseEvent,
  ) => void;
  activeFile: string | null;
  gitStatus: GitStatusMap;
}) {
  return (
    <>
      <Row
        node={node}
        depth={depth}
        active={!node.isDir && node.path === activeFile}
        gitStatus={gitStatus}
        onClick={() => {
          if (node.isDir) onToggle(node);
          else onOpenFile(node.path);
        }}
        onContextMenu={
          onContextMenu
            ? (e) => onContextMenu(node.path, node.isDir, e)
            : undefined
        }
      />
      {node.isDir &&
        node.expanded &&
        node.children?.map((child) => (
          <RowSubtree
            key={child.path}
            node={child}
            depth={depth + 1}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
            onContextMenu={onContextMenu}
            activeFile={activeFile}
            gitStatus={gitStatus}
          />
        ))}
    </>
  );
}

function Row({
  node,
  depth,
  active,
  gitStatus,
  onClick,
  onContextMenu,
}: {
  node: Node;
  depth: number;
  active: boolean;
  gitStatus: GitStatusMap;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const statusEntry = node.isDir ? undefined : gitStatus.get(node.path);
  const visual = statusVisual(statusEntry);
  // Filenames stay neutral — the file-type pigment lives in the icon
  // now. This keeps the list readable at a glance: one column of
  // colored icons, one column of plain text. Git status still
  // overrides when present (added/modified/deleted should pop).
  const nameColor = active
    ? "var(--text-primary)"
    : (visual?.color ?? "var(--text-secondary)");
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={(e) => {
        if (onContextMenu) {
          e.preventDefault();
          onContextMenu(e);
        }
      }}
      title={node.path}
      style={{
        width: "100%",
        height: ROW_HEIGHT,
        display: "flex",
        alignItems: "center",
        paddingLeft: depth * INDENT + ROW_PADDING_LEFT_BASE,
        paddingRight: 8,
        gap: 8,
        fontFamily: "var(--font-sans)",
        // Row font size locked to 12px and line-height to 1 so the
        // text's bounding box matches its glyph height. Without
        // lineHeight: 1, the inherited line-height (~1.4-1.5)
        // inflates the text's flex item while the icon sits at
        // exactly 14px — visually the text would float above the
        // icon's optical center even though alignItems: center
        // matches their bounding-box centers. Pinning lineHeight: 1
        // collapses the text box to its glyph dimensions so both
        // items center on the same axis.
        fontSize: 12,
        lineHeight: 1,
        color: active
          ? "var(--text-primary)"
          : node.isDir
            ? "var(--text-secondary)"
            : "var(--text-secondary)",
        backgroundColor: active ? "var(--surface-2)" : "transparent",
        textAlign: "left",
        cursor: "pointer",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        // --surface-3 sits one step brighter than the active row's
        // --surface-2 — hover reads as a transient, slightly louder
        // signal vs. the calmer "this is the currently-open file"
        // tint. The prior --surface-2 hover blended into the active
        // row's tint and felt invisible on rows that weren't active.
        if (!active)
          e.currentTarget.style.backgroundColor = "var(--surface-3)";
      }}
      onMouseLeave={(e) => {
        if (!active)
          e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      <span
        style={{
          // Match icon dimensions so the chevron occupies its own
          // 14x14 column instead of an off-axis 10x?? span. Both
          // folder and file rows reserve this column identically;
          // for files the content is empty (opacity 0) but the
          // box is the same width so icons line up across rows.
          width: ICON_SIZE,
          height: ICON_SIZE,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-tertiary)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          lineHeight: 1,
          opacity: node.isDir ? 0.7 : 0,
        }}
        aria-hidden
      >
        {node.isDir ? (node.expanded ? "▾" : "▸") : ""}
      </span>
      <FileTypeIcon
        name={node.name}
        isDir={node.isDir}
        open={node.expanded}
        size={ICON_SIZE}
      />
      <span
        style={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          lineHeight: 1,
          fontWeight: node.isDir
            ? "var(--weight-medium)"
            : "var(--weight-regular)",
          color: nameColor,
        }}
      >
        {node.name}
      </span>
      {visual && (
        <span
          aria-label={visual.label}
          title={visual.label}
          style={{
            flexShrink: 0,
            width: 12,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontWeight: "var(--weight-semibold)",
            color: visual.color,
            letterSpacing: "-0.04em",
          }}
        >
          {visual.badge}
        </span>
      )}
    </button>
  );
}

function toNode(e: DirEntry): Node {
  return {
    name: e.name,
    path: e.path,
    isDir: e.is_dir,
    expanded: false,
  };
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}
