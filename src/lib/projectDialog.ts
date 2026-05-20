import { open } from "@tauri-apps/plugin-dialog";
import type { Dispatch } from "react";
import type { AppAction } from "@/state/types";
import { fs } from "@/lib/fs";

/**
 * Show the system "Open Folder" picker and dispatch an `add-project`
 * action with the chosen folder. Shared by ⌘O (keyboard), the project
 * pill's "open project…" menu item, and the command palette so all three
 * paths behave identically.
 *
 * Resolves to the new project's id (or null if the user cancelled), so
 * callers can chain follow-up actions (e.g. close the palette).
 */
export async function openProjectDialog(
  dispatch: Dispatch<AppAction>,
): Promise<string | null> {
  let selected: string | string[] | null;
  try {
    selected = await open({
      directory: true,
      multiple: false,
      title: "Open project",
    });
  } catch {
    // Dialog plugin unavailable — silent failure (e.g. running vite-only).
    return null;
  }
  if (typeof selected !== "string") return null;

  const path = selected;
  const name = path.split("/").filter(Boolean).pop() ?? path;
  const glyph = name.charAt(0).toUpperCase();
  const id = `p_${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}_${Date.now().toString(36)}`;
  dispatch({
    type: "add-project",
    project: {
      id,
      path,
      name,
      glyph,
      faviconDataUri: null,
      pinned: false,
      expanded: true,
    },
  });

  // Best-effort icon detection. Don't block the add — the project shows
  // up immediately with the letter fallback and swaps to the real icon
  // once the scan resolves. Failures are silent: the fallback glyph is
  // already a reasonable default.
  fs.scanProjectIcon(path)
    .then((faviconDataUri) => {
      if (!faviconDataUri) return;
      dispatch({
        type: "update-project",
        id,
        patch: { faviconDataUri },
      });
    })
    .catch(() => {});

  return id;
}
