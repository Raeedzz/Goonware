/**
 * Read the OS clipboard as plain text.
 *
 * Order of preference (intentionally Rust-first):
 *
 *   1. Native pbpaste via the Tauri command. AppKit's NSPasteboard
 *      read does NOT trigger macOS's "Apps want to read your
 *      clipboard" TCC dialog — it's a first-party paste, treated by
 *      the OS the same as `Cmd+V` in TextEdit. This is the path that
 *      makes Goonware feel like a real macOS app: the user pastes and
 *      text appears, no popup, no permission dance.
 *
 *   2. `navigator.clipboard.readText()` as a last-resort fallback.
 *      Used only when the Tauri command isn't reachable (non-Tauri
 *      host: the renderer running under `vite dev` outside `tauri
 *      dev`, or a test harness). On that path the user may see the
 *      WebKit prompt — but that case isn't macOS-app users.
 *
 * Critically we DO NOT call `navigator.clipboard.readText()` first.
 * Doing so would fire the macOS clipboard-permission popup on every
 * Cmd+V/Ctrl+V — the exact "weird paste popup that shouldn't show
 * up" symptom users report. Even when permission has been granted,
 * the OS may re-prompt on schedule, and a denied prompt makes the
 * web API silently return `""` (indistinguishable from an empty
 * clipboard). Reversing the order isolates us from both quirks.
 *
 * Returns `null` when both layers came up empty (genuinely empty
 * clipboard, or pbpaste binary missing AND no browser API). Returns
 * the text otherwise.
 *
 * `nativeReader` is dependency-injected so the unit test in
 * `clipboardRead.test.ts` can drive the fallback path without
 * pulling in `@tauri-apps/api` (which can't load under `bun test`
 * without a real node_modules tree). Production callers pass
 * `system.readClipboardText` from `@/lib/fs`.
 */
export async function readClipboardTextWithFallback(
  nativeReader: () => Promise<string> = defaultNativeReader,
): Promise<string | null> {
  // Layer 1 (preferred): Rust-side pbpaste. Goes through AppKit's
  // NSPasteboard, which is treated by macOS as a first-party paste —
  // no TCC popup. This is the right default for a Tauri/WKWebView
  // app: WebKit's clipboard-read API was designed for browser pages
  // that haven't established user trust, and the per-app prompt is
  // appropriate for them — not for a native app where the user
  // explicitly pressed Cmd+V.
  try {
    const nativeText = await nativeReader();
    if (nativeText.length > 0) return nativeText;
    // Native reader returned "" — clipboard is genuinely empty (or
    // holds a non-text item). No point asking WebKit, which would
    // just re-confirm with the popup. Bail with null.
    return null;
  } catch {
    // Tauri command isn't reachable (running under `vite dev` without
    // `tauri dev`, jsdom test, etc.). Fall through to the browser API.
  }

  // Layer 2 (fallback): only used when the native bridge is gone.
  try {
    const webText = await navigator.clipboard.readText();
    if (webText.length > 0) return webText;
  } catch {
    // Permission denied / API unavailable. Nothing else to try.
  }
  return null;
}

/**
 * Default native-reader binding. Done as a deferred dynamic import so
 * environments without `@tauri-apps/api` (bun:test) can still load this
 * module and exercise the public `readClipboardTextWithFallback` entry
 * point through dependency injection.
 */
async function defaultNativeReader(): Promise<string> {
  const { system } = await import("../lib/fs");
  return system.readClipboardText();
}
