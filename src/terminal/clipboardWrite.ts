/**
 * Write the OS clipboard as plain text.
 *
 * Mirror of `clipboardRead.ts` — same Rust-first ordering, same
 * dependency-injected native call so this module is exercisable under
 * `bun test` without pulling in `@tauri-apps/api`.
 *
 * Order of preference (intentionally Rust-first):
 *
 *   1. Native pbcopy via the Tauri command. AppKit's NSPasteboard
 *      write goes through the OS's first-party copy pathway — no
 *      TCC restriction, no silent failure. This is the path that
 *      makes Cmd+C "just work" in a bundled .app.
 *
 *   2. `navigator.clipboard.writeText()` as a last-resort fallback.
 *      Used only when the Tauri command isn't reachable (non-Tauri
 *      host: the renderer running under `vite dev` outside `tauri
 *      dev`, or a test harness).
 *
 * Critically we DO NOT call `navigator.clipboard.writeText()` first.
 * Under bundled .app builds, the WebKit clipboard-write API can fail
 * silently — Cmd+C looks like it worked but the pasteboard is
 * unchanged. Reversing the order isolates us from that quirk.
 *
 * `nativeWriter` is dependency-injected so the unit test in
 * `clipboardWrite.test.ts` can drive the fallback path without pulling
 * in `@tauri-apps/api` (which can't load under `bun test` without a
 * real node_modules tree). Production callers pass
 * `system.writeClipboardText` from `@/lib/fs`.
 *
 * Returns `true` when one of the two layers reported success;
 * `false` when both failed.
 */
export async function writeClipboardTextWithFallback(
  text: string,
  nativeWriter: (t: string) => Promise<void> = defaultNativeWriter,
): Promise<boolean> {
  try {
    await nativeWriter(text);
    return true;
  } catch {
    // Tauri bridge unavailable (running under `vite dev` without
    // `tauri dev`, jsdom test, etc.). Fall through to the browser API.
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function defaultNativeWriter(text: string): Promise<void> {
  const { system } = await import("../lib/fs");
  return system.writeClipboardText(text);
}
