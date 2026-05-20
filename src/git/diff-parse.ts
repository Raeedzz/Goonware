/**
 * Pure unified-diff parsing. Lives in its own file (no React imports)
 * so unit tests can exercise it without dragging in Tauri/IPC modules
 * via the component tree.
 */

export interface DiffLine {
  kind: "header" | "hunk" | "context" | "add" | "remove";
  text: string;
  /** Old (left) line number for context+remove lines. */
  oldLine?: number;
  /** New (right) line number for context+add lines. */
  newLine?: number;
}

/**
 * Minimal unified-diff parser. Tracks old/new line numbers across
 * hunks. Header lines (`diff --git`, `index`, `+++`, `---`) get
 * collapsed under a single "header" kind.
 */
export function parseUnifiedDiff(raw: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const text of raw.split("\n")) {
    if (
      text.startsWith("diff --git") ||
      text.startsWith("index ") ||
      text.startsWith("--- ") ||
      text.startsWith("+++ ") ||
      text.startsWith("new file mode") ||
      text.startsWith("deleted file mode") ||
      text.startsWith("similarity index") ||
      text.startsWith("rename from") ||
      text.startsWith("rename to") ||
      text.startsWith("Binary files")
    ) {
      out.push({ kind: "header", text });
      continue;
    }
    if (text.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text) ?? null;
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
      }
      out.push({ kind: "hunk", text });
      continue;
    }
    if (text.startsWith("+")) {
      out.push({ kind: "add", text: text.slice(1), newLine });
      newLine++;
    } else if (text.startsWith("-")) {
      out.push({ kind: "remove", text: text.slice(1), oldLine });
      oldLine++;
    } else if (text.startsWith(" ")) {
      out.push({ kind: "context", text: text.slice(1), oldLine, newLine });
      oldLine++;
      newLine++;
    } else if (text === "") {
      // Trailing newline at end of stream — skip silently.
    } else {
      // Anything else (e.g. "\ No newline at end of file"), keep as
      // context so the user can still see it.
      out.push({ kind: "context", text });
    }
  }
  return out;
}
