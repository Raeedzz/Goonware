import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export const fs = {
  readDir: (path: string) => invoke<DirEntry[]>("fs_read_dir", { path }),
  readTextFile: (path: string) =>
    invoke<string>("fs_read_text_file", { path }),
  writeTextFile: (path: string, content: string) =>
    invoke<void>("fs_write_text_file", { path, content }),
  /**
   * Best-effort scan for a project's own app icon — favicon, Tauri app
   * icon, Next.js icon, etc. — returned as a `data:` URI ready to drop
   * into `<img src>`. Resolves to `null` when nothing matched. The
   * sidebar renders this in place of the first-letter glyph so e.g.
   * Goonware itself shows the Goonware app icon instead of "G".
   */
  scanProjectIcon: (path: string) =>
    invoke<string | null>("fs_scan_project_icon", { path }),
  cwd: () => invoke<string>("fs_cwd"),
  pathsExist: (paths: string[]) =>
    invoke<boolean[]>("fs_paths_exist", { paths }),
};

/* ------------------------------------------------------------------
   Claude Code: enumerate the user's installed skills and MCP servers
   ------------------------------------------------------------------ */

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  source: string;
  path: string;
}

export interface McpEntry {
  id: string;
  name: string;
  kind: string;
  source: string;
  summary: string;
}

export const claudeConfig = {
  listSkills: () => invoke<SkillEntry[]>("skills_list"),
  listMcps: () => invoke<McpEntry[]>("mcps_list"),
};

/* ------------------------------------------------------------------
   System actions — right-click "Open in Finder/VS Code/browser"
   ------------------------------------------------------------------ */

export const system = {
  /** Open the path in macOS's default handler. `reveal` selects in Finder. */
  open: (path: string, reveal = false) =>
    invoke<void>("system_open", { path, reveal }),
  /** Open the path with a specific app (e.g. "Visual Studio Code"). */
  openWith: (path: string, app: string) =>
    invoke<void>("system_open_with", { path, app }),
  /**
   * Persist clipboard / dropped image bytes to `/tmp/goonware-paste/...` and
   * return the absolute path. The terminal pastes that path into the
   * focused input so agents (claude, codex, gemini) can read the
   * image inline.
   *
   * Bytes are base64-encoded across the IPC boundary — Tauri v2's
   * argument serializer is JSON, so a `Uint8Array` would inflate ~10×
   * as a number-array. Base64 keeps a 1080p PNG comfortably under the
   * IPC payload ceiling.
   */
  saveImageToTemp: (bytes: Uint8Array, extension: string) =>
    invoke<string>("system_save_image_to_temp", {
      base64Bytes: bytesToBase64(bytes),
      extension,
    }),
  /**
   * Read the system clipboard as plain text via the native macOS
   * `pbpaste`. Used as a fallback by Ctrl+V handlers when
   * `navigator.clipboard.readText()` returns empty — see the doc on
   * `system_clipboard_read_text` in src-tauri/src/fs.rs for the
   * macOS 15+ permission gate that motivates this path.
   *
   * Returns "" rather than rejecting when the clipboard is empty or
   * pbpaste exits non-zero, so callers can chain a simple
   * `if (text.length === 0) return;` bail. The promise only rejects
   * if the IPC bridge itself failed (Tauri host gone).
   */
  readClipboardText: () => invoke<string>("system_clipboard_read_text"),
};

function bytesToBase64(bytes: Uint8Array): string {
  // btoa wants a binary string; chunk to avoid blowing the JS arg
  // limit when an image is several megabytes (apply() flattens each
  // chunk into a single function call, which V8 caps around 65k args).
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}
