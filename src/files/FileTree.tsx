import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { fs, system, type DirEntry } from "@/lib/fs";
import { toLogicalDragPoint } from "@/lib/dragPoint";
import {
  statusVisual,
  useGitStatus,
  type GitStatusMap,
} from "@/hooks/useGitStatus";
import { paneSlotScrollChildStyle } from "@/shell/paneSlotLayout";
import { ContextMenu, type ContextMenuItem } from "@/shell/ContextMenu";
import { IconCopy, IconEdit, IconFolder, IconTrash } from "@/design/icons";
import { CaretRight } from "@phosphor-icons/react";
import { FileTypeIcon } from "./FileTypeIcon";

interface Props {
  root: string;
  onOpenFile: (path: string) => void;
  /**
   * Fired after a successful in-tree rename so the host can rewrite any
   * open editor/diff tabs that point at the moved path (or anything
   * under a renamed folder). `from`/`to` are absolute paths.
   */
  onRenamed?: (from: string, to: string) => void;
  /**
   * Fired after a successful delete so the host can close any open
   * editor/diff tabs for the removed path (or anything under a removed
   * folder). `path` is the absolute path that was deleted.
   */
  onDeleted?: (path: string) => void;
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

interface MenuState {
  path: string;
  isDir: boolean;
  anchor: { x: number; y: number };
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
 * Beyond read/navigate it also handles two light write operations,
 * both scoped to paths the user points at directly:
 *   - Drag files in from Finder → copied into the folder under the
 *     cursor (or the project root). Uses Tauri's webview-global
 *     `onDragDropEvent`, hit-testing the drop point against this
 *     tree's box the same way BlockTerminal does for its own drops.
 *   - Right-click → Rename → inline edit, committed via `fs_rename`.
 *
 * Custom-rolled rather than react-arborist because our needs are
 * minimal and we want full control over the row chrome.
 */
export function FileTree({
  root,
  onOpenFile,
  onRenamed,
  onDeleted,
  activeFile,
}: Props) {
  const [tree, setTree] = useState<Node | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: "error" | "ok";
    text: string;
  } | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const gitStatus = useGitStatus(root);

  const containerRef = useRef<HTMLDivElement>(null);
  // Refs mirror the latest values so the once-registered drag-drop
  // listener and async write handlers never read a stale `root`,
  // `tree`, or `onRenamed`.
  const treeRef = useRef<Node | null>(tree);
  treeRef.current = tree;
  const rootRef = useRef(root);
  rootRef.current = root;
  const onRenamedRef = useRef(onRenamed);
  onRenamedRef.current = onRenamed;
  const onDeletedRef = useRef(onDeleted);
  onDeletedRef.current = onDeleted;

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

  // Inline notice banner auto-dismisses — an "imported N files"
  // confirmation or a rename collision is a transient nudge, not
  // persistent chrome.
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [notice]);

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

  // Re-read a directory's children and MERGE into the existing nodes:
  // entries that are still present keep their node identity (so an
  // expanded subfolder stays expanded), new entries get fresh nodes,
  // vanished ones drop out. Used after a Finder import so the dropped
  // files appear without collapsing the rest of the tree.
  const refreshDir = useCallback(async (dirPath: string, expand: boolean) => {
    let entries: DirEntry[];
    try {
      entries = await fs.readDir(dirPath);
    } catch {
      return;
    }
    const node = treeRef.current ? findNode(treeRef.current, dirPath) : null;
    if (!node) return;
    const byPath = new Map((node.children ?? []).map((c) => [c.path, c]));
    node.children = entries.map((e) => {
      const existing = byPath.get(e.path);
      return existing && existing.isDir === e.is_dir ? existing : toNode(e);
    });
    if (expand) node.expanded = true;
    setTree((prev) => (prev ? { ...prev } : prev));
  }, []);

  // Copy Finder-dropped paths into `destDir`. Kept in a ref so the
  // drag-drop listener (registered once) always calls the current
  // closure.
  const importInto = useCallback(
    async (destDir: string, paths: string[]) => {
      try {
        setNotice(null);
        const created = await fs.importPaths(paths, destDir);
        if (created.length > 0) {
          await refreshDir(destDir, true);
          window.dispatchEvent(
            new CustomEvent("goonware-git-refresh", {
              detail: { cwd: rootRef.current },
            }),
          );
          const where = destDir === rootRef.current ? "" : ` → ${basename(destDir)}`;
          setNotice({
            tone: "ok",
            text: `Imported ${created.length} item${created.length === 1 ? "" : "s"}${where}`,
          });
        }
      } catch (e) {
        setNotice({ tone: "error", text: String(e) });
      }
    },
    [refreshDir],
  );
  const importRef = useRef(importInto);
  importRef.current = importInto;

  // Returns true when the rename landed (or was a no-op), false when it
  // failed — RenameInput uses this to keep the input open for a retry.
  const commitRename = useCallback(
    async (node: Node, raw: string): Promise<boolean> => {
      const newName = raw.trim();
      if (newName === "" || newName === node.name) {
        setRenamingPath(null);
        return true;
      }
      if (newName.includes("/")) {
        setNotice({ tone: "error", text: "A name can’t contain “/”." });
        return false;
      }
      const parent = dirOf(node.path);
      const newPath = parent === "/" ? `/${newName}` : `${parent}/${newName}`;
      const oldPath = node.path;
      try {
        setNotice(null);
        await fs.rename(oldPath, newPath);
        if (treeRef.current) {
          const target = findNode(treeRef.current, oldPath);
          if (target) rewritePath(target, oldPath, newPath);
        }
        setRenamingPath(null);
        setTree((prev) => (prev ? { ...prev } : prev));
        onRenamedRef.current?.(oldPath, newPath);
        window.dispatchEvent(
          new CustomEvent("goonware-git-refresh", {
            detail: { cwd: rootRef.current },
          }),
        );
        return true;
      } catch (e) {
        setNotice({ tone: "error", text: String(e) });
        return false;
      }
    },
    [],
  );

  // Permanently delete a path (gated by a confirm). Drops the node from
  // its parent's children in place — preserving sibling expansion — and
  // notifies the host so any open tab for the path can close.
  const deleteEntry = useCallback(
    async (path: string, isDir: boolean) => {
      const name = basename(path);
      const ok = window.confirm(
        `Delete ${isDir ? "folder" : "file"} “${name}”?\n\nThis permanently removes it from disk and cannot be undone.`,
      );
      if (!ok) return;
      try {
        setNotice(null);
        await fs.delete(path);
        const parent = treeRef.current
          ? findNode(treeRef.current, dirOf(path))
          : null;
        if (parent?.children) {
          parent.children = parent.children.filter((c) => c.path !== path);
          setTree((prev) => (prev ? { ...prev } : prev));
        }
        if (renamingPath === path) setRenamingPath(null);
        onDeletedRef.current?.(path);
        window.dispatchEvent(
          new CustomEvent("goonware-git-refresh", {
            detail: { cwd: rootRef.current },
          }),
        );
        setNotice({ tone: "ok", text: `Deleted “${name}”` });
      } catch (e) {
        setNotice({ tone: "error", text: String(e) });
      }
    },
    [renamingPath],
  );

  // Webview-global file-drop listener. Mirrors BlockTerminal's pattern:
  // each consumer hit-tests the drop point against its own box and only
  // the one containing the point reacts. Coordinates run through the
  // shared `toLogicalDragPoint` so this tree and the terminal share one
  // space and stay mutually exclusive — over the terminal only the
  // terminal lights up, over the tree only the tree. Registered once;
  // dynamic state is read through refs.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    // Resolve the destination directory for a viewport point: the
    // folder row under the cursor, the parent dir of a file row, or
    // the project root when the point is over empty tree space.
    const destDirAt = (x: number, y: number): string => {
      const el = document.elementFromPoint(x, y);
      const row = el?.closest("[data-node-path]") as HTMLElement | null;
      if (!row) return rootRef.current;
      const p = row.getAttribute("data-node-path");
      if (!p) return rootRef.current;
      return row.getAttribute("data-node-isdir") === "1" ? p : dirOf(p);
    };
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "leave") {
          setDropActive(false);
          setDropTargetPath(null);
          return;
        }
        const container = containerRef.current;
        if (!container) return;
        const { x, y } = toLogicalDragPoint(
          event.payload.position.x,
          event.payload.position.y,
        );
        const rect = container.getBoundingClientRect();
        // Containment is the precise test (handles overlap/scroll);
        // rect math is the fallback for the rare frame where
        // elementFromPoint returns null mid-drag.
        const el = document.elementFromPoint(x, y);
        const inRect =
          rect.width > 0 &&
          rect.height > 0 &&
          x >= rect.left &&
          x <= rect.right &&
          y >= rect.top &&
          y <= rect.bottom;
        const inside = (!!el && container.contains(el)) || inRect;

        if (event.payload.type === "enter" || event.payload.type === "over") {
          if (!inside) {
            setDropActive(false);
            setDropTargetPath(null);
            return;
          }
          setDropActive(true);
          setDropTargetPath(destDirAt(x, y));
          return;
        }
        if (event.payload.type === "drop") {
          setDropActive(false);
          setDropTargetPath(null);
          if (!inside) return;
          const paths = event.payload.paths;
          if (!paths || paths.length === 0) return;
          void importRef.current(destDirAt(x, y), paths);
        }
      })
      .then((un) => {
        if (cancelled) {
          un();
          return;
        }
        unlisten = un;
      })
      .catch(() => {
        // Webview API unavailable (non-Tauri host) — degrade to a
        // read-only tree rather than crash.
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const openMenu = useCallback(
    (path: string, isDir: boolean, e: React.MouseEvent) => {
      e.preventDefault();
      setMenu({ path, isDir, anchor: { x: e.clientX, y: e.clientY } });
    },
    [],
  );

  const menuItems: ContextMenuItem[] = menu
    ? [
        {
          id: "rename",
          label: "Rename",
          Glyph: IconEdit,
          onSelect: () => setRenamingPath(menu.path),
        },
        {
          id: "reveal",
          label: "Reveal in Finder",
          Glyph: IconFolder,
          onSelect: () => void system.open(menu.path, true),
        },
        {
          id: "copy-path",
          label: "Copy path",
          Glyph: IconCopy,
          onSelect: () => void system.writeClipboardText(menu.path),
        },
        {
          id: "delete",
          label: `Delete ${menu.isDir ? "folder" : "file"}`,
          Glyph: IconTrash,
          destructive: true,
          onSelect: () => void deleteEntry(menu.path, menu.isDir),
        },
      ]
    : [];

  // Outer element is ALWAYS the scroll container — error / loading /
  // empty / loaded states render inside it. This keeps the layout
  // invariant constant (FileTree's root satisfies
  // `paneSlotScrollChildStyle`) across every render, so a long error
  // message scrolls, and the right-panel test that asserts FilesView's
  // top-level DOM has `overflow-y: auto` holds in every state.
  return (
    <>
      <div
        ref={containerRef}
        style={{
          ...paneSlotScrollChildStyle({ padding: "var(--space-1) 0" }),
          // While dragging Finder files over the tree, ring the whole
          // box so it reads as one drop surface; the targeted folder
          // row gets its own tint below.
          ...(dropActive
            ? {
                outline: "1.5px solid var(--accent)",
                outlineOffset: -2,
                backgroundColor:
                  "color-mix(in oklch, transparent, var(--accent) 6%)",
              }
            : {}),
        }}
      >
        {notice && (
          <button
            type="button"
            onClick={() => setNotice(null)}
            title="Dismiss"
            style={{
              display: "block",
              position: "sticky",
              top: 0,
              zIndex: 1,
              width: "calc(100% - 16px)",
              margin: "0 8px var(--space-1)",
              padding: "6px 8px",
              textAlign: "left",
              wordBreak: "break-word",
              backgroundColor:
                notice.tone === "error"
                  ? "color-mix(in oklch, var(--surface-2), var(--state-error) 14%)"
                  : "color-mix(in oklch, var(--surface-2), var(--accent) 14%)",
              color:
                notice.tone === "error"
                  ? "var(--state-error-bright)"
                  : "var(--accent-bright)",
              border:
                notice.tone === "error"
                  ? "1px solid color-mix(in oklch, transparent, var(--state-error) 32%)"
                  : "1px solid color-mix(in oklch, transparent, var(--accent) 32%)",
              borderRadius: "var(--radius-sm)",
              fontSize: "var(--text-2xs)",
              fontFamily: "var(--font-mono)",
              lineHeight: 1.35,
              cursor: "pointer",
            }}
          >
            {notice.text}
          </button>
        )}
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
              onRequestMenu={openMenu}
              renamingPath={renamingPath}
              onCommitRename={commitRename}
              onCancelRename={() => setRenamingPath(null)}
              dropTargetPath={dropTargetPath}
              activeFile={activeFile ?? null}
              gitStatus={gitStatus}
            />
          ))
        )}
      </div>
      <ContextMenu
        open={menu !== null}
        anchor={menu?.anchor ?? null}
        items={menuItems}
        onClose={() => setMenu(null)}
      />
    </>
  );
}

function RowSubtree({
  node,
  depth,
  onToggle,
  onOpenFile,
  onRequestMenu,
  renamingPath,
  onCommitRename,
  onCancelRename,
  dropTargetPath,
  activeFile,
  gitStatus,
}: {
  node: Node;
  depth: number;
  onToggle: (n: Node) => void;
  onOpenFile: (path: string) => void;
  onRequestMenu: (path: string, isDir: boolean, e: React.MouseEvent) => void;
  renamingPath: string | null;
  onCommitRename: (node: Node, name: string) => Promise<boolean>;
  onCancelRename: () => void;
  dropTargetPath: string | null;
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
        renaming={node.path === renamingPath}
        isDropTarget={node.isDir && node.path === dropTargetPath}
        onClick={() => {
          if (node.isDir) onToggle(node);
          else onOpenFile(node.path);
        }}
        onContextMenu={(e) => onRequestMenu(node.path, node.isDir, e)}
        onCommitRename={(name) => onCommitRename(node, name)}
        onCancelRename={onCancelRename}
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
            onRequestMenu={onRequestMenu}
            renamingPath={renamingPath}
            onCommitRename={onCommitRename}
            onCancelRename={onCancelRename}
            dropTargetPath={dropTargetPath}
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
  renaming,
  isDropTarget,
  onClick,
  onContextMenu,
  onCommitRename,
  onCancelRename,
}: {
  node: Node;
  depth: number;
  active: boolean;
  gitStatus: GitStatusMap;
  renaming: boolean;
  isDropTarget: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onCommitRename: (name: string) => Promise<boolean>;
  onCancelRename: () => void;
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

  const rowStyle: React.CSSProperties = {
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
    color: active ? "var(--text-primary)" : "var(--text-secondary)",
    backgroundColor: isDropTarget
      ? "color-mix(in oklch, var(--surface-2), var(--accent) 18%)"
      : active
        ? "var(--surface-2)"
        : "transparent",
    boxShadow: isDropTarget ? "inset 0 0 0 1px var(--accent)" : undefined,
    textAlign: "left",
    cursor: "pointer",
    transition: "background-color var(--motion-instant) var(--ease-out-quart)",
  };

  // Shared leading chrome (chevron + file-type icon) — identical for
  // the navigate (button) and rename (div + input) variants.
  const chrome = (
    <>
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
          opacity: node.isDir ? 0.7 : 0,
          transition: "transform var(--motion-instant) var(--ease-out-quart)",
          transform: node.expanded ? "rotate(90deg)" : "rotate(0deg)",
        }}
        aria-hidden
      >
        <CaretRight size={10} weight="bold" />
      </span>
      <FileTypeIcon
        name={node.name}
        isDir={node.isDir}
        open={node.expanded}
        size={ICON_SIZE}
      />
    </>
  );

  // Rename mode: render as a non-button row (an <input> inside a
  // <button> is invalid interactive nesting) carrying the same
  // layout, with an inline text field in place of the name.
  if (renaming) {
    return (
      <div style={{ ...rowStyle, cursor: "default" }}>
        {chrome}
        <RenameInput
          initial={node.name}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={node.path}
      style={rowStyle}
      data-node-path={node.path}
      data-node-isdir={node.isDir ? "1" : "0"}
      onMouseEnter={(e) => {
        // --surface-3 sits one step brighter than the active row's
        // --surface-2 — hover reads as a transient, slightly louder
        // signal vs. the calmer "this is the currently-open file"
        // tint. The prior --surface-2 hover blended into the active
        // row's tint and felt invisible on rows that weren't active.
        if (!active && !isDropTarget)
          e.currentTarget.style.backgroundColor = "var(--surface-3)";
      }}
      onMouseLeave={(e) => {
        if (!active && !isDropTarget)
          e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      {chrome}
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

/**
 * Inline rename field. Mounts focused with the basename (stem)
 * pre-selected — extension excluded — matching VS Code / Finder.
 * Enter (or blur) commits; Escape cancels. A `done` latch guards the
 * commit-then-unmount-then-blur double fire; the latch is released
 * when a commit comes back unsuccessful so the user can fix a
 * collision and try again without the field locking up.
 */
function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = el.value.lastIndexOf(".");
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, []);

  const commit = async (value: string) => {
    if (done.current) return;
    done.current = true;
    const ok = await onCommit(value);
    if (!ok) done.current = false;
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  return (
    <input
      ref={ref}
      defaultValue={initial}
      spellCheck={false}
      autoComplete="off"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          void commit(e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
      onBlur={(e) => void commit(e.currentTarget.value)}
      style={{
        flex: 1,
        minWidth: 0,
        height: 18,
        padding: "0 4px",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        lineHeight: 1,
        color: "var(--text-primary)",
        backgroundColor: "var(--surface-1)",
        border: "1px solid var(--accent)",
        borderRadius: "var(--radius-xs)",
        outline: "none",
      }}
    />
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

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/** Depth-first search for the node whose absolute path matches. */
function findNode(node: Node, path: string): Node | null {
  if (node.path === path) return node;
  if (node.children) {
    for (const child of node.children) {
      const found = findNode(child, path);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Rewrite a renamed subtree in place: the node's own path becomes
 * `newPrefix`; every descendant swaps its `oldPrefix` head for
 * `newPrefix`. Names are recomputed from the new path. In-place so the
 * subtree keeps its loaded children + expansion state across a rename.
 */
function rewritePath(node: Node, oldPrefix: string, newPrefix: string): void {
  node.path = newPrefix + node.path.slice(oldPrefix.length);
  node.name = basename(node.path);
  if (node.children) {
    for (const child of node.children) rewritePath(child, oldPrefix, newPrefix);
  }
}
