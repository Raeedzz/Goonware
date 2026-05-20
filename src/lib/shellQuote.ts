/**
 * Quote a filesystem path so it survives being pasted into a shell
 * or an agent prompt as a single token. The terminal's clipboard-image
 * and drag-drop paths both pump file paths through the PTY as plain
 * text, where unquoted spaces would split `My Cool Screenshot.png`
 * across three argv positions and produce a "file not found" inside
 * claude / codex / the shell.
 *
 * macOS file paths are bytes-with-no-NUL — single-quoting handles
 * every character except `'` itself, which we escape as `'\''`. We
 * skip quoting entirely for paths made of safe characters so common
 * cases (`/tmp/gli-paste/paste-1234.png`) stay readable.
 */
export function shellQuotePath(path: string): string {
  if (path.length === 0) return "''";
  if (/^[A-Za-z0-9_./@\-+:,=%]+$/.test(path)) return path;
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * Join several paths with single spaces, each individually quoted so
 * "open one finder window with three files dragged in" delivers three
 * usable argv tokens.
 */
export function joinShellPaths(paths: string[]): string {
  return paths.map(shellQuotePath).join(" ");
}
