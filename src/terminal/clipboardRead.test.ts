import { afterEach, describe, expect, test } from "bun:test";
import { readClipboardTextWithFallback } from "./clipboardRead";

/**
 * Regression guards for the clipboard-read helper.
 *
 * Two user-facing bugs these tests pin:
 *
 *   1. "Ctrl+V is broken — when I press it nothing happens / a popup
 *      appears asking permission." On macOS 15+ (Sequoia), the
 *      WKWebView's `navigator.clipboard.readText()` triggers a per-
 *      app TCC dialog that the user perceives as a "weird paste
 *      popup." Even a granted prompt can re-fire on a schedule, and
 *      a declined prompt silently returns `""` thereafter — making
 *      Ctrl+V no-op forever.
 *
 *   2. "I want it to just paste, like every other macOS app." The
 *      fix is to bypass the WebKit clipboard layer entirely and read
 *      through AppKit's NSPasteboard (via pbpaste). AppKit treats a
 *      pbpaste read as a first-party paste — same trust level as
 *      Cmd+V in TextEdit — so no TCC popup ever fires.
 *
 * The contract these tests pin:
 *   - The native (pbpaste) reader is the PRIMARY path.
 *   - The WebKit `navigator.clipboard.readText()` is the LAST-RESORT
 *     fallback, used only when the native bridge isn't reachable
 *     (running under `vite dev` outside of `tauri dev`, jsdom tests,
 *     etc.). A user running the real Goonware macOS DMG should never
 *     touch the WebKit clipboard API for reads.
 *
 * If a future refactor flips the order back ("web API is faster"),
 * every Cmd+V will surface the popup again — these tests catch that
 * regression before it ships.
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
 * API path?" — we EXPECT it not to be called on the happy native
 * path.
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

describe("readClipboardTextWithFallback — native (pbpaste) is the primary path", () => {
  test("returns the native value directly when non-empty", async () => {
    const counter = stubNavigatorClipboard(async () => {
      throw new Error("WebKit clipboard must NOT be touched on the happy native path");
    });
    const text = await readClipboardTextWithFallback(async () => "hello world");
    expect(text).toBe("hello world");
    // Critical: navigator.clipboard.readText() was never invoked, so
    // the macOS TCC popup never had a chance to surface.
    expect(counter.calls).toBe(0);
  });

  test("preserves multi-line clipboard contents from pbpaste", async () => {
    // Bracketed-paste downstream depends on the helper returning the
    // raw clipboard text including embedded newlines. If a future
    // refactor were to e.g. split on \n and return only the first
    // line, every multi-line Cmd+V would land as just the header.
    stubNavigatorClipboard(async () => {
      throw new Error("WebKit clipboard must NOT be touched");
    });
    const text = await readClipboardTextWithFallback(
      async () => "line one\nline two\nline three",
    );
    expect(text).toBe("line one\nline two\nline three");
  });

  test("returns null (no WebKit retry) when pbpaste returns empty", async () => {
    // pbpaste returning "" means the clipboard is genuinely empty
    // (or holds a non-text item). Asking the WebKit API would just
    // re-confirm with the TCC popup — useless. The helper must bail
    // with null here, NOT fall through to navigator.clipboard.
    const counter = stubNavigatorClipboard(async () => {
      throw new Error("WebKit retry on empty clipboard would re-introduce the popup");
    });
    const text = await readClipboardTextWithFallback(async () => "");
    expect(text).toBeNull();
    expect(counter.calls).toBe(0);
  });
});

describe("readClipboardTextWithFallback — WebKit fallback only when native is unreachable", () => {
  test("falls back to navigator.clipboard.readText when pbpaste throws", async () => {
    // The Tauri command isn't reachable — e.g. running the
    // frontend under plain `vite dev` (no `tauri dev`), or a test
    // harness without the invoke handler registered. ONLY in that
    // case do we try the browser clipboard API.
    const counter = stubNavigatorClipboard(async () => "rescued by webkit");
    const text = await readClipboardTextWithFallback(async () => {
      throw new Error("invoke handler missing");
    });
    expect(text).toBe("rescued by webkit");
    expect(counter.calls).toBe(1);
  });

  test("returns null when native throws and webkit also returns empty", async () => {
    stubNavigatorClipboard(async () => "");
    const text = await readClipboardTextWithFallback(async () => {
      throw new Error("no tauri here");
    });
    expect(text).toBeNull();
  });

  test("returns null when native throws and webkit also throws", async () => {
    stubNavigatorClipboard(async () => {
      throw new DOMException("NotAllowedError", "NotAllowedError");
    });
    const text = await readClipboardTextWithFallback(async () => {
      throw new Error("no tauri here");
    });
    expect(text).toBeNull();
  });

  test("returns null when navigator.clipboard is undefined and pbpaste throws", async () => {
    g.navigator = {};
    const text = await readClipboardTextWithFallback(async () => {
      throw new Error("no tauri, no navigator");
    });
    expect(text).toBeNull();
  });
});

describe("readClipboardTextWithFallback — ordering is native → webkit, never reversed", () => {
  // The cost matrix has flipped relative to a browser-only world:
  //   - pbpaste: forks a subprocess, ~5–20 ms, NO popup ever.
  //   - WebKit API: in-process, ~0 ms when granted, BUT fires a
  //     macOS TCC popup on first call and on schedule thereafter.
  //
  // The popup is the dominant user-experience cost, swamping the
  // subprocess latency. Going native-first eliminates it. This test
  // pins the ordering against a future "WebKit is faster, try it
  // first" refactor that would re-introduce the popup.
  test("does NOT call WebKit clipboard when pbpaste succeeds", async () => {
    const counter = stubNavigatorClipboard(async () => "should not be reached");
    await readClipboardTextWithFallback(async () => "native won");
    expect(counter.calls).toBe(0);
  });

  test("calls pbpaste before WebKit when both layers would be reachable", async () => {
    const order: string[] = [];
    stubNavigatorClipboard(async () => {
      order.push("webkit");
      return "from webkit";
    });
    await readClipboardTextWithFallback(async () => {
      order.push("pbpaste");
      throw new Error("force the webkit fallback to demonstrate ordering");
    });
    expect(order).toEqual(["pbpaste", "webkit"]);
  });
});
