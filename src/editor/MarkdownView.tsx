import { useCallback, useEffect, useRef } from "react";
import { useEditor, EditorContent, type Editor as TiptapEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { invoke } from "@tauri-apps/api/core";
import { Editor } from "./Editor";
import { useAppState } from "@/state/AppState";

/** Pull the canonical markdown source out of TipTap's storage. The
 *  markdown extension augments `editor.storage` with a `markdown`
 *  helper; tiptap-markdown 0.9.x doesn't ship a typed module
 *  augmentation, so we narrow through unknown here rather than
 *  letting `any` leak into the rest of the file. */
function getMarkdown(editor: TiptapEditor): string {
  const md = (
    editor.storage as unknown as { markdown?: { getMarkdown: () => string } }
  ).markdown;
  return md ? md.getMarkdown() : "";
}

interface Props {
  /** Absolute path of the file — passed through to the source editor for AskCard. */
  path: string;
  /** File content (markdown source). */
  content: string;
  /** Persist edits back into state. Fires from BOTH rich and source. */
  onChange: (content: string) => void;
}

/**
 * Markdown viewer/editor with two modes — driven from app state via
 * the `markdownView` flag. The Rich/Source toggle that flips that flag
 * lives in the pane header (rendered by `WorkspaceLayout`), so this
 * component itself is just two stacked viewers.
 *
 * Rich:   TipTap WYSIWYG. Renders the markdown as headings / lists /
 *         code blocks / tables and lets the user edit visually. On
 *         every keystroke we round-trip through the markdown extension
 *         to get the canonical markdown source back, then propagate
 *         via `onChange` — same path the source editor uses, so
 *         autosave / Cmd+S / git status all keep working.
 * Source: the regular CodeMirror editor every other text file uses.
 */
export function MarkdownView({ path, content, onChange }: Props) {
  const { markdownView } = useAppState();
  return markdownView === "rich" ? (
    <RichView content={content} onChange={onChange} />
  ) : (
    <Editor path={path} content={content} onChange={onChange} />
  );
}

function RichView({
  content,
  onChange,
}: {
  content: string;
  onChange: (content: string) => void;
}) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Markdown.configure({ html: false, breaks: true, transformPastedText: true }),
    ],
    content,
    onUpdate: ({ editor }) => {
      // The markdown extension exposes a serializer on the editor's
      // storage bag. Pull canonical markdown out and propagate so the
      // file state stays in sync with the user's WYSIWYG edits.
      onChange(getMarkdown(editor));
    },
    editorProps: {
      attributes: {
        // The .goonware-markdown class slots in the same prose styling the
        // old preview used — headings, code blocks, tables, lists.
        // ProseMirror appends its own contenteditable + outline.
        class: "goonware-markdown goonware-rich-editor",
      },
    },
  });

  // External content swaps (e.g. switching between two .md files in
  // the same pane) need to push the new markdown into TipTap. We bail
  // when the values match to avoid clobbering the user's cursor on
  // their own typing.
  //
  // Also reset the scroll container to the top on content swap.
  // ProseMirror's setContent places its selection at the end of the
  // document and the parent overflow:auto container preserves whatever
  // scrollTop was from a previous markdown — so opening a fresh file
  // landed at the BOTTOM. Snapping to 0 here matches the "open file →
  // see the title" behaviour the user expects.
  useEffect(() => {
    if (!editor) return;
    const current = getMarkdown(editor);
    if (current !== content) {
      editor.commands.setContent(content, { emitUpdate: false });
      // Place the selection at the document start too, so any
      // subsequent ↑/↓ in the editor begins from the top.
      editor.commands.setTextSelection(0);
      const el = scrollContainerRef.current;
      if (el) el.scrollTop = 0;
      // The DOM commit lands in the next animation tick — re-snap
      // there too, otherwise ProseMirror's own scrollIntoView for the
      // (now top-of-doc) selection still wins on first render.
      requestAnimationFrame(() => {
        const el2 = scrollContainerRef.current;
        if (el2) el2.scrollTop = 0;
      });
    }
  }, [editor, content]);

  // Anchor-click delegation: any `<a href="http(s)://…">` inside the
  // rich view should route to the user's default system browser, not
  // navigate the Tauri webview itself (which would replace our app
  // shell with the page) or land in the built-in browser pane (that
  // pane is reserved for URLs the user deliberately pastes into its
  // address bar — markdown links are ambient, not deliberate). Using
  // delegation rather than wiring it on each rendered anchor because
  // TipTap re-renders the DOM frequently and we don't want to chase
  // listener attachment per node.
  const onContainerClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const anchor = target.closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href) return;
    if (!/^https?:\/\//i.test(href)) return;
    e.preventDefault();
    void invoke("system_open", { path: href }).catch(() => {
      try {
        window.open(href, "_blank");
      } catch {
        /* no-op */
      }
    });
  }, []);

  return (
    <div
      ref={scrollContainerRef}
      onClick={onContainerClick}
      style={{
        height: "100%",
        width: "100%",
        overflow: "auto",
        padding: "var(--space-6) var(--space-8)",
        backgroundColor: "var(--surface-0)",
      }}
    >
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
