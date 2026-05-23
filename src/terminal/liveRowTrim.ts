import type { DirtyRow } from "./types";

/**
 * Row-trim helpers for {@link LiveBlock}'s agent rendering path.
 * Extracted from LiveBlock so the pure logic can be unit-tested
 * independently of React + canvas mount lifecycle.
 */

export function rowIsBlank(row: DirtyRow): boolean {
  for (const s of row.spans) {
    if (s.text.trim().length > 0) return false;
  }
  return true;
}

export function rowText(row: DirtyRow): string {
  return row.spans.map((s) => s.text).join("").trim();
}

/**
 * Strip leading blanks + zsh's echo of the typed command, plus
 * trailing blanks. Same shape as the closed-block transcript trim
 * (`Block.tsx` skips line 0 when input matches), kept consistent so
 * a running block and its eventual closed block look visually
 * continuous when the command finishes.
 *
 * `footerKeepThroughRow` (optional) — minimum original-grid row
 * index that must remain in the trimmed slice even when its tail is
 * blank. Used by agent TUIs (claude/codex/gemini) where the input
 * cursor sits above the meta + auto-mode hint and those rows are
 * momentarily blank mid-redraw. Pass `frame.cursor_row + 5` for
 * agents and `undefined` for shell commands.
 */
export function trimEchoAndBlanks(
  rows: DirtyRow[],
  command: string,
  footerKeepThroughRow?: number,
): DirtyRow[] {
  const target = command.trim();
  let i = 0;
  while (i < rows.length && rowIsBlank(rows[i])) i++;
  if (i < rows.length && target.length > 0 && rowText(rows[i]) === target) {
    i++;
  }
  let j = rows.length - 1;
  while (j >= i && rowIsBlank(rows[j])) j--;
  if (typeof footerKeepThroughRow === "number") {
    const minJ = Math.min(rows.length - 1, footerKeepThroughRow);
    if (minJ > j) j = minJ;
  }
  if (i > j) return [];
  return rows.slice(i, j + 1);
}

/**
 * Fallback when `trimEchoAndBlanks` returns an empty slice but the
 * grid actually has content. Happens when an agent emits clear-screen
 * + cursor-home and the next frame lands before the redraw catches up —
 * `cursor_row` is near 0, `footerKeep = cursor_row + 5` keeps only the
 * first few rows, but those are blank because the agent is mid-redraw.
 * Trim returns []; the canvas would paint nothing; the user sees a
 * blanked pane.
 *
 * Recovery: anchor to the LAST populated row in the grid and walk
 * upward through non-blank rows. This gives the renderer something
 * to paint even when the trim heuristic was misled.
 */
export function fallbackTail(rows: DirtyRow[], maxRows: number): DirtyRow[] {
  let end = rows.length - 1;
  while (end >= 0 && rowIsBlank(rows[end])) end--;
  if (end < 0) return [];
  const start = Math.max(0, end - maxRows + 1);
  return rows.slice(start, end + 1);
}
