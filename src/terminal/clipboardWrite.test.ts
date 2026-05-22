import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeClipboardTextWithFallback } from "./clipboardWrite";

/**
 * Behavioral + source-pin tests for the Cmd+C / Ctrl+C copy flow.
 *
 * The user-reported bug this guards against:
 *
 *   "Cmd+C doesn't copy from terminal output. I select text in a
 *    closed shell block, press Cmd+C, paste in another app, and
 *    the previous clipboard contents come back."
 *
 * Root cause: `navigator.clipboard.writeText()` fails silently in
 * WKWebView under bundled .app builds — the JS clipboard API is
 * TCC-restricted independently of the Edit-menu copy: selector.
 * Cmd+C looks like it worked (no error, the keydown fired), but
 * NSPasteboard is unchanged.
 *
 * Fix: shell out to `/usr/bin/pbcopy` via a Tauri command (mirrors
 * the pbpaste path on the read side). pbcopy goes through AppKit's
 * NSPasteboard which macOS treats as a first-party copy — no TCC
 * involvement, no silent failure.
 *
 * What this file pins:
 *   - `writeClipboardTextWithFallback` tries the native (pbcopy)
 *     writer FIRST, then falls back to navigator.clipboard.writeText.
 *   - BlockTerminal's window-level Cmd+C handler routes through the
 *     helper, NOT the raw navigator API.
 *   - PtyPassthrough's Cmd+C handler routes through the helper.
 *   - The Rust `system_clipboard_write_text` command exists and is
 *     registered in the invoke_handler.
 *
 * Without these source pins, a future "simpler" refactor that calls
 * `navigator.clipboard.writeText` directly would pass every
 * behavioral test and silently reintroduce the bug in bundled builds.
 */

function readRepoFile(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf-8");
}

describe("writeClipboardTextWithFallback", () => {
  test("calls the injected native writer first", async () => {
    const nativeCalls: string[] = [];
    const result = await writeClipboardTextWithFallback("hello", async (t) => {
      nativeCalls.push(t);
    });
    expect(nativeCalls).toEqual(["hello"]);
    expect(result).toBe(true);
  });

  test("falls back to navigator.clipboard.writeText when native throws", async () => {
    const webCalls: string[] = [];
    const originalNav = (globalThis as { navigator?: unknown }).navigator;
    (globalThis as { navigator: unknown }).navigator = {
      clipboard: {
        writeText: async (t: string) => {
          webCalls.push(t);
        },
      },
    };
    try {
      const result = await writeClipboardTextWithFallback(
        "world",
        async () => {
          throw new Error("no tauri bridge");
        },
      );
      expect(webCalls).toEqual(["world"]);
      expect(result).toBe(true);
    } finally {
      (globalThis as { navigator?: unknown }).navigator = originalNav;
    }
  });

  test("returns false when both layers fail", async () => {
    const originalNav = (globalThis as { navigator?: unknown }).navigator;
    (globalThis as { navigator: unknown }).navigator = {
      clipboard: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    };
    try {
      const result = await writeClipboardTextWithFallback(
        "nothing",
        async () => {
          throw new Error("no bridge");
        },
      );
      expect(result).toBe(false);
    } finally {
      (globalThis as { navigator?: unknown }).navigator = originalNav;
    }
  });
});

describe("clipboardWrite helper is native-first", () => {
  const src = readRepoFile("src/terminal/clipboardWrite.ts");

  test("exports writeClipboardTextWithFallback as an async function", () => {
    expect(src).toMatch(
      /export\s+async\s+function\s+writeClipboardTextWithFallback/,
    );
  });

  test("calls the native (pbcopy) writer BEFORE navigator.clipboard.writeText", () => {
    // The single most important contract in this file. Reversing
    // the order re-introduces the silent WKWebView writeText failure.
    //
    // Strip line + jsdoc comments so the documentation mentioning
    // the API doesn't confuse the ordering grep.
    const codeOnly = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("*"))
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const nativeIdx = codeOnly.indexOf("nativeWriter(text)");
    const webIdx = codeOnly.indexOf("navigator.clipboard.writeText(text)");
    expect(nativeIdx).toBeGreaterThan(-1);
    expect(webIdx).toBeGreaterThan(-1);
    expect(nativeIdx).toBeLessThan(webIdx);
  });

  test("loads system.writeClipboardText via a deferred import", () => {
    // Deferred-import pattern lets `bun test` exercise this module
    // without pulling @tauri-apps into the graph.
    expect(src).toContain('await import("../lib/fs")');
    expect(src).toContain("system.writeClipboardText(text)");
  });
});

describe("BlockTerminal Cmd+C uses the native-first helper, not raw writeText", () => {
  const src = readRepoFile("src/terminal/BlockTerminal.tsx");

  test("imports writeClipboardTextWithFallback from clipboardWrite", () => {
    expect(src).toContain(
      'import { writeClipboardTextWithFallback } from "./clipboardWrite";',
    );
  });

  test("the window-level Cmd+C handler calls writeClipboardTextWithFallback", () => {
    // The handler at the bottom of BlockTerminal that catches Cmd+C
    // when the focused element isn't a textarea (i.e. selection is
    // in a closed shell block). This is the primary user-facing
    // copy path for terminal output.
    expect(src).toContain("writeClipboardTextWithFallback(text)");
  });

  test("does NOT call navigator.clipboard.writeText directly", () => {
    // Strip line comments so doc references don't false-positive.
    const codeOnly = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .filter((line) => !line.trim().startsWith("*"))
      .join("\n");
    const writeText = codeOnly.match(/navigator\.clipboard\.writeText/g);
    expect(writeText).toBeNull();
  });
});

describe("PtyPassthrough Cmd+C uses the native-first helper", () => {
  const src = readRepoFile("src/terminal/PtyPassthrough.tsx");

  test("imports writeClipboardTextWithFallback from clipboardWrite", () => {
    expect(src).toContain(
      'import { writeClipboardTextWithFallback } from "./clipboardWrite";',
    );
  });

  test("the Cmd+C branch calls writeClipboardTextWithFallback", () => {
    expect(src).toContain("writeClipboardTextWithFallback(text)");
  });

  test("does NOT call navigator.clipboard.writeText directly", () => {
    const codeOnly = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .filter((line) => !line.trim().startsWith("*"))
      .join("\n");
    const writeText = codeOnly.match(/navigator\.clipboard\.writeText/g);
    expect(writeText).toBeNull();
  });
});

describe("Rust clipboard write command exists in src-tauri", () => {
  const fsRs = readRepoFile("src-tauri/src/fs.rs");
  const libRs = readRepoFile("src-tauri/src/lib.rs");

  test("fs.rs declares system_clipboard_write_text (text via pbcopy)", () => {
    expect(fsRs).toContain("pub async fn system_clipboard_write_text");
    expect(fsRs).toContain('Command::new("/usr/bin/pbcopy")');
  });

  test("lib.rs registers the write command in invoke_handler", () => {
    expect(libRs).toContain("fs::system_clipboard_write_text");
  });
});

describe("PromptInput Cmd+V intercepts BOTH ⌘V and ⌃V", () => {
  // Warp's input editor handles ⌘V (macOS native) and ⌃V (Linux/Win
  // muscle memory) via the same paste action. Our previous
  // implementation only intercepted ⌃V; ⌘V relied on the textarea's
  // native paste event, which fails silently in WKWebView when the
  // user has declined the clipboard-read prompt. Mirror Warp by
  // intercepting both keystrokes in onKeyDown and reading via
  // pbpaste — same shape as PtyPassthrough's Cmd+V handler.
  const src = readRepoFile("src/terminal/PromptInput.tsx");

  test("the V chord branch accepts metaKey OR ctrlKey", () => {
    // Anchor at the v-key check, then look for the OR'd modifier
    // guard immediately above it.
    const vIdx = src.indexOf("e.key.toLowerCase() === \"v\"");
    expect(vIdx).toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, vIdx - 600), vIdx);
    // The condition shape that mirrors PtyPassthrough.
    expect(before).toMatch(
      /\(\s*\(?e\.metaKey[^)]*&&\s*!e\.ctrlKey\)?\s*\|\|\s*\(?e\.ctrlKey[^)]*&&\s*!e\.metaKey\)/,
    );
  });

  test("paste flow routes into the input via setValue, not onPaste", () => {
    // Warp puts paste content into the input editor unconditionally
    // when the input is visible. The previous "multi-line goes to
    // PTY via bracketed paste" shortcut was the root cause of "Cmd+V
    // doesn't paste into input" — the user never saw what they
    // pasted.
    const vIdx = src.indexOf("e.key.toLowerCase() === \"v\"");
    const window = src.slice(vIdx, vIdx + 4000);
    expect(window).toContain("setValue(next)");
    // The legacy onPaste(text) PTY-routing call must NOT survive.
    expect(window).not.toContain("onPaste(text)");
  });
});
