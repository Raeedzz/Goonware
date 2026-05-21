import { afterEach, describe, expect, test } from "bun:test";
import { readClipboardTextWithFallback } from "./clipboardRead";

/**
 * Regression guards for the layered clipboard-read fallback chain.
 *
 * The user-facing bug these tests pin:
 *   "Ctrl+V is still not working in the text box of the terminal,
 *    I can't ctrl+v anything into it."
 *
 * Root cause: on macOS 15+ (Sequoia), Tauri's WKWebView shows a
 * per-app "Apps want to read your clipboard" prompt the first time
 * `navigator.clipboard.readText()` fires. If the user dismissed or
 * denied it (intentionally or because the prompt appeared behind
 * another window), the web API thereafter returns `""` without
 * throwing — and the Ctrl+V handler in PromptInput / PtyPassthrough
 * silently no-ops.
 *
 * `readClipboardTextWithFallback()` is the load-bearing helper that
 * fixes this: when the web API returns empty (or throws), it falls
 * through to a Tauri command that shells out to `/usr/bin/pbpaste`,
 * which goes through AppKit's first-party clipboard channel and
 * survives the WebKit-level denial.
 *
 * If either layer regresses — the helper stops trying pbpaste when
 * the web API came up empty, or it stops returning a non-empty
 * fallback result — Ctrl+V silently breaks again. These tests catch
 * that before it ships.
 *
 * The pbpaste reader is dependency-injected; we drive it through the
 * `nativeReader` parameter so the test can simulate the Tauri command
 * without pulling `@tauri-apps/api` into bun's module graph. The
 * production binding is the default arg defined in clipboardRead.ts.
 */

interface Globals {
  navigator?: {
    clipboard?: {
      readText: () => Promise<string>;
    };
  };
}

const g = globalThis as unknown as Globals;
const originalNavigator = g.navigator;

afterEach(() => {
  g.navigator = originalNavigator;
});

/**
 * Install a stubbed `navigator.clipboard.readText()` for one test.
 * Returns a counter so assertions can check "did we even try the web
 * API path before falling back?"
 */
function stubNavigatorClipboard(impl: () => Promise<string>): { calls: number } {
  const counter = { calls: 0 };
  g.navigator = {
    clipboard: {
      readText: async () => {
        counter.calls++;
        return impl();
      },
    },
  };
  return counter;
}

describe("readClipboardTextWithFallback — web API is the fast path when allowed", () => {
  test("returns the web API value directly when non-empty", async () => {
    stubNavigatorClipboard(async () => "hello world");
    let nativeCalled = false;
    const text = await readClipboardTextWithFallback(async () => {
      nativeCalled = true;
      throw new Error("pbpaste should NOT be reached on a happy web path");
    });
    expect(text).toBe("hello world");
    expect(nativeCalled).toBe(false);
  });

  test("preserves multi-line clipboard contents from the web API", async () => {
    // Bracketed-paste downstream depends on the helper returning the
    // raw clipboard text including embedded newlines. If a future
    // refactor were to e.g. split on \n and return only the first
    // line, every multi-line Ctrl+V would land as just the header.
    stubNavigatorClipboard(async () => "line one\nline two\nline three");
    const text = await readClipboardTextWithFallback(async () => "");
    expect(text).toBe("line one\nline two\nline three");
  });
});

describe("readClipboardTextWithFallback — pbpaste fallback on the broken-permission path", () => {
  test("falls back to pbpaste when the web API returns empty string", async () => {
    // This is the EXACT macOS Sequoia symptom: readText() resolves
    // with "" instead of throwing. The fallback must engage.
    stubNavigatorClipboard(async () => "");
    let nativeCalled = false;
    const text = await readClipboardTextWithFallback(async () => {
      nativeCalled = true;
      return "fallback succeeded";
    });
    expect(text).toBe("fallback succeeded");
    expect(nativeCalled).toBe(true);
  });

  test("falls back to pbpaste when the web API throws", async () => {
    // The other failure mode: readText() rejects because the WebKit
    // permission policy outright denied the call (no Permissions API
    // grant, no user gesture chain established, etc.). Same outcome
    // expected from the user's perspective.
    stubNavigatorClipboard(async () => {
      throw new DOMException("NotAllowedError", "NotAllowedError");
    });
    let nativeCalled = false;
    const text = await readClipboardTextWithFallback(async () => {
      nativeCalled = true;
      return "rust path picked up";
    });
    expect(text).toBe("rust path picked up");
    expect(nativeCalled).toBe(true);
  });

  test("returns null when BOTH layers come up empty (clipboard is truly empty)", async () => {
    // If the user really has nothing on the clipboard, both paths
    // resolve with "". The helper signals this with `null` so the
    // caller can early-return without splicing an empty string into
    // the textarea or sending an empty paste to the PTY.
    stubNavigatorClipboard(async () => "");
    const text = await readClipboardTextWithFallback(async () => "");
    expect(text).toBeNull();
  });

  test("returns null when web API is empty and pbpaste IPC bridge fails", async () => {
    // Non-Tauri host, test harness without invoke handler, command
    // not registered, etc. Helper must not bubble the error — the
    // Ctrl+V handler should silently fall through, not crash the
    // app.
    stubNavigatorClipboard(async () => "");
    const text = await readClipboardTextWithFallback(async () => {
      throw new Error("invoke handler missing");
    });
    expect(text).toBeNull();
  });

  test("returns null when navigator.clipboard is undefined and pbpaste fails", async () => {
    // Stripped global (some test harnesses don't install a
    // navigator). Helper should still bail gracefully.
    g.navigator = {};
    const text = await readClipboardTextWithFallback(async () => {
      throw new Error("no Tauri here either");
    });
    expect(text).toBeNull();
  });
});

describe("readClipboardTextWithFallback — fallback ordering is web → pbpaste, never reversed", () => {
  // The cost matrix:
  //   - Web API: in-process, ~0 ms when granted, can show a
  //     permission prompt on first use.
  //   - pbpaste: forks a subprocess, ~5–20 ms.
  //
  // The web path MUST be tried first or every Ctrl+V on a healthy
  // install pays subprocess latency for no reason. This test pins
  // the ordering against a future "always use pbpaste, it's more
  // reliable" refactor.
  test("does NOT call pbpaste when the web API succeeds", async () => {
    stubNavigatorClipboard(async () => "web won");
    let pbpasteCalled = false;
    await readClipboardTextWithFallback(async () => {
      pbpasteCalled = true;
      return "should not be reached";
    });
    expect(pbpasteCalled).toBe(false);
  });

  test("calls the web API before pbpaste when both layers would yield text", async () => {
    const order: string[] = [];
    stubNavigatorClipboard(async () => {
      order.push("web");
      return "";
    });
    await readClipboardTextWithFallback(async () => {
      order.push("pbpaste");
      return "from pbpaste";
    });
    expect(order).toEqual(["web", "pbpaste"]);
  });
});
