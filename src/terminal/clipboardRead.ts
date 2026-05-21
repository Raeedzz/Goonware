/**
 * Read the OS clipboard as plain text, with a fallback chain that
 * survives the macOS-Sequoia "Apps want to read your clipboard"
 * permission gate.
 *
 * The chain:
 *
 *   1. `navigator.clipboard.readText()` — fast, in-process, the path
 *      everyone wants first. When WebKit's permission policy and
 *      macOS's per-app clipboard prompt both allow it, this returns
 *      the clipboard contents synchronously enough for the user to
 *      feel a paste land in one frame.
 *
 *   2. A Tauri command that spawns `/usr/bin/pbpaste` Rust-side.
 *      Reached when (1) returned `""` OR threw. macOS routes the
 *      pbpaste read through AppKit's first-party clipboard channel,
 *      so it works even when the user previously declined the
 *      WebKit-level prompt (or the WKWebView's bundle id wasn't
 *      granted clipboard-read at all). This is the load-bearing
 *      fallback that fixes "Ctrl+V silently does nothing."
 *
 * Two non-obvious rules:
 *
 *   - Empty-string from `navigator.clipboard.readText()` is treated
 *     as a denial, NOT as "the clipboard is empty." On macOS
 *     Sequoia the privacy-gated path returns `""` without throwing
 *     when permission is declined — exactly the same shape an empty
 *     clipboard produces. The fallback can disambiguate: if pbpaste
 *     also returns `""`, the clipboard really IS empty; if pbpaste
 *     returns a value, the web API was the broken layer.
 *
 *   - The fallback is async-only — pbpaste spawns a subprocess, so
 *     callers must `await` this function (or chain `.then`). The
 *     handler should call `e.preventDefault()` synchronously before
 *     awaiting so the textarea's default behavior never races us.
 *
 * Returns `null` when both layers came up empty (genuinely empty
 * clipboard, or pbpaste binary missing). Returns the text otherwise.
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
  // Layer 1: browser clipboard API.
  let webText = "";
  try {
    webText = await navigator.clipboard.readText();
  } catch {
    // Permission denied / API unavailable. Drop straight to the
    // native fallback below.
    webText = "";
  }
  if (webText.length > 0) return webText;

  // Layer 2: Rust-side pbpaste. This is what makes Ctrl+V actually
  // paste on macOS installs where the WebKit clipboard-read prompt
  // was declined or never surfaced.
  try {
    const nativeText = await nativeReader();
    if (nativeText.length > 0) return nativeText;
  } catch {
    // IPC bridge unavailable (non-Tauri host, command not registered
    // in some test harness, etc.). Fall through to null.
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
