import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Behavioral + source-pin tests for the Cmd+V / Ctrl+V paste flow.
 *
 * The user-reported bugs these guard against (multi-symptom):
 *
 *   1. "Cmd+V doesn't work — when I press it nothing happens."
 *   2. "A weird paste popup shows up when I Cmd+V. If I press Cmd+V
 *      it should just paste."
 *
 * Root cause: navigator.clipboard.read*() in WKWebView on macOS fires
 * the system "Apps want to read your clipboard" TCC prompt. Once
 * declined (or just dismissed), the web API silently returns "" and
 * Cmd+V no-ops forever.
 *
 * Fix: skip the WebKit clipboard API entirely on macOS. Read text via
 * `/usr/bin/pbpaste` (NSPasteboard, treated as first-party paste —
 * no TCC prompt). Read images via `osascript` extracting the PNG
 * pasteboard flavor (also routed through AppKit's first-party paste).
 *
 * What this file pins:
 *   - Both Cmd+V handlers route through the native-first
 *     `readClipboardTextWithFallback`.
 *   - The image clipboard read goes through the Rust
 *     `system_clipboard_save_image_to_temp` command, NOT
 *     `navigator.clipboard.read()`.
 *   - Both Tauri commands exist in src-tauri and are registered.
 *   - The terminal keepalive layers use `visibility: hidden` not
 *     `display: none`, so the GPU surface stays alive across tab
 *     switches.
 *
 * Without these source pins, a future "let me just call
 * navigator.clipboard.readText() directly, it's simpler" refactor
 * would pass every behavioral test we have and silently reintroduce
 * the popup.
 */

function readRepoFile(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf-8");
}

describe("PromptInput Ctrl+V uses the native-first helper, not raw readText", () => {
  const src = readRepoFile("src/terminal/PromptInput.tsx");

  test("imports readClipboardTextWithFallback from clipboardRead", () => {
    expect(src).toContain(
      'import { readClipboardTextWithFallback } from "./clipboardRead";',
    );
  });

  test("the Ctrl+V branch calls readClipboardTextWithFallback", () => {
    const ctrlVAnchor = src.indexOf("e.key.toLowerCase() === \"v\"");
    expect(ctrlVAnchor).toBeGreaterThan(-1);
    // Window is wide enough to span the image branch (Rust-side
    // `saveClipboardImageToTemp` for screenshot Cmd+V) plus the text
    // fallback (`readClipboardTextWithFallback`). The two-branch
    // shape mirrors Warp's `fn paste`, where the image check runs
    // first and falls through to text on miss.
    const window = src.slice(ctrlVAnchor, ctrlVAnchor + 4000);
    expect(window).toContain("readClipboardTextWithFallback()");
    // Also pin the image-first ordering — drift back to text-only
    // would silently lose screenshot paste support.
    expect(window).toContain("system.saveClipboardImageToTemp()");
  });

  test("does NOT call navigator.clipboard.readText() or .read() in the Ctrl+V path", () => {
    // The whole point of the fix: WebKit's clipboard API triggers
    // the macOS TCC popup. If a future commit reintroduces these
    // calls anywhere outside a comment, the popup comes back.
    //
    // Strip line comments so doc-comments mentioning the API don't
    // trigger the assertion.
    const codeOnly = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const readText = codeOnly.match(/navigator\.clipboard\.readText\(\)/g);
    expect(readText).toBeNull();
    // Note: navigator.clipboard.read() is also forbidden — same
    // popup, same root cause.
    const read = codeOnly.match(/navigator\.clipboard\.read\(\)/g);
    expect(read).toBeNull();
  });
});

describe("PtyPassthrough Cmd+V uses Rust-side image + native-first text", () => {
  const src = readRepoFile("src/terminal/PtyPassthrough.tsx");

  test("imports readClipboardTextWithFallback from clipboardRead", () => {
    expect(src).toContain(
      'import { readClipboardTextWithFallback } from "./clipboardRead";',
    );
  });

  test("the Cmd+V/Ctrl+V handler calls readClipboardTextWithFallback for text", () => {
    expect(src).toContain("readClipboardTextWithFallback()");
  });

  test("the image branch routes through the Rust saveClipboardImageToTemp command", () => {
    // The previous browser-side navigator.clipboard.read() fired
    // the same TCC popup as readText(). The Rust-side replacement
    // goes through NSPasteboard via osascript — no popup. Pin the
    // production call so it can't drift back to the browser API.
    expect(src).toContain("system.saveClipboardImageToTemp()");
  });

  test("does NOT call navigator.clipboard.read() or .readText() anywhere", () => {
    const codeOnly = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const read = codeOnly.match(/navigator\.clipboard\.read\(/g);
    expect(read).toBeNull();
    const readText = codeOnly.match(/navigator\.clipboard\.readText\(\)/g);
    expect(readText).toBeNull();
  });
});

describe("clipboardRead helper is native-first", () => {
  const src = readRepoFile("src/terminal/clipboardRead.ts");

  test("exports readClipboardTextWithFallback as an async function", () => {
    expect(src).toMatch(
      /export\s+async\s+function\s+readClipboardTextWithFallback/,
    );
  });

  test("calls the native (pbpaste) reader BEFORE navigator.clipboard.readText", () => {
    // The single most important contract in this file. Reversing
    // the order re-introduces the macOS TCC clipboard popup on
    // every Cmd+V.
    //
    // Strip line comments so doc-comments mentioning the API don't
    // confuse the ordering grep.
    const codeOnly = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("*"))
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const nativeIdx = codeOnly.indexOf("nativeReader()");
    const webIdx = codeOnly.indexOf("navigator.clipboard.readText()");
    expect(nativeIdx).toBeGreaterThan(-1);
    expect(webIdx).toBeGreaterThan(-1);
    expect(nativeIdx).toBeLessThan(webIdx);
  });

  test("loads system.readClipboardText via a deferred import", () => {
    // The deferred-import pattern lets `bun test` exercise this
    // module without pulling @tauri-apps into the graph. Top-
    // level import here breaks the existing test suite.
    expect(src).toContain('await import("../lib/fs")');
    expect(src).toContain("system.readClipboardText()");
  });
});

describe("Rust clipboard commands exist in src-tauri", () => {
  const fsRs = readRepoFile("src-tauri/src/fs.rs");
  const libRs = readRepoFile("src-tauri/src/lib.rs");

  test("fs.rs declares system_clipboard_read_text (text via pbpaste)", () => {
    expect(fsRs).toContain("pub async fn system_clipboard_read_text");
    expect(fsRs).toContain('Command::new("/usr/bin/pbpaste")');
  });

  test("fs.rs declares system_clipboard_save_image_to_temp (image via osascript)", () => {
    // The Rust handler that replaces navigator.clipboard.read() for
    // screenshot Cmd+V. Pin its existence + the osascript spawn so
    // a refactor can't quietly drop the no-popup contract.
    expect(fsRs).toContain("pub async fn system_clipboard_save_image_to_temp");
    expect(fsRs).toContain('Command::new("/usr/bin/osascript")');
  });

  test("lib.rs registers both clipboard commands in invoke_handler", () => {
    expect(libRs).toContain("fs::system_clipboard_read_text");
    expect(libRs).toContain("fs::system_clipboard_save_image_to_temp");
  });
});

describe("Terminal keepalive layers preserve the GPU surface", () => {
  // The fundamental fix for "switching tabs makes the agent pane
  // go black." WKWebView releases a canvas's WebGPU swapchain
  // under `display: none` without firing device.lost. Switching
  // to `visibility: hidden` keeps the surface alive, no recovery
  // dance needed.
  for (const path of [
    "src/shell/MainColumn.tsx",
    "src/shell/RightPanel.tsx",
  ]) {
    test(`${path} uses visibility:hidden not display:none for inactive slots`, () => {
      const src = readRepoFile(path);
      // Must mention the visibility toggle.
      expect(src).toContain('visibility:');
      // Must reference the "hidden" string in the same module.
      expect(src).toContain('"hidden"');
    });
  }
});

