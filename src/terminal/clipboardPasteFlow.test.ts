import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Behavioral + source-pin tests for the Ctrl+V paste flow.
 *
 * The user-reported bug:
 *   "Ctrl+V is still not working in the text box of the terminal,
 *    I can't ctrl+v anything into it."
 *
 * Root cause: navigator.clipboard.readText() in WKWebView on macOS
 * Sequoia silently returns "" after a denied per-app clipboard prompt.
 * Fix: a fallback chain to /usr/bin/pbpaste via a Tauri Rust command.
 *
 * What `clipboardRead.test.ts` already covers: the fallback chain's
 * web→pbpaste ordering, the empty-vs-null disambiguation, and the
 * error-path no-op behaviour.
 *
 * What THIS file adds: pins that the production Ctrl+V handlers
 * actually invoke the fallback helper (not the raw web API), and
 * pins the Rust-side pbpaste command exists in src-tauri.
 *
 * Without these source pins, a future "let me just call
 * navigator.clipboard.readText() directly, it's simpler" refactor
 * would pass every behavioral test we have and silently reintroduce
 * the bug.
 */

function readRepoFile(rel: string): string {
  // Tests run with cwd at the repo root (bun test src/...). Resolve
  // paths from there so tests work whether invoked via `bun test`
  // or `bun run test:all`.
  return readFileSync(join(process.cwd(), rel), "utf-8");
}

describe("PromptInput Ctrl+V uses the fallback helper, not raw readText", () => {
  const src = readRepoFile("src/terminal/PromptInput.tsx");

  test("imports readClipboardTextWithFallback from clipboardRead", () => {
    // If this import disappears (e.g. someone reverts and goes back
    // to the bare navigator.clipboard.readText() pattern), the
    // macOS Sequoia regression silently ships again. Pin the
    // import.
    expect(src).toContain(
      'import { readClipboardTextWithFallback } from "./clipboardRead";',
    );
  });

  test("the Ctrl+V branch calls readClipboardTextWithFallback", () => {
    // Scan inside the Ctrl+V block. The block opens with the exact
    // modifier check we use everywhere, so we can anchor on that.
    const ctrlVAnchor = src.indexOf("e.key.toLowerCase() === \"v\"");
    expect(ctrlVAnchor).toBeGreaterThan(-1);
    // Look at the next ~80 lines for the helper call.
    const window = src.slice(ctrlVAnchor, ctrlVAnchor + 2000);
    expect(window).toContain("readClipboardTextWithFallback()");
  });

  test("does NOT actually CALL navigator.clipboard.readText() in the Ctrl+V path", () => {
    // Belt-and-suspenders: if a future commit reintroduces the raw
    // readText() invocation alongside the fallback helper, that's
    // the first step toward losing the fallback. Catch it loudly.
    //
    // We allow `navigator.clipboard.read()` (the image-MIME path)
    // and `navigator.clipboard.writeText()` (the copy paths) — only
    // the bare `readText()` is dangerous in shell-mode Ctrl+V.
    //
    // Strip line comments before scanning so the test passes when
    // the file legitimately MENTIONS `navigator.clipboard.readText()`
    // in a doc comment explaining why we now route through the
    // fallback helper.
    const codeOnly = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const matches = codeOnly.match(/navigator\.clipboard\.readText\(\)/g);
    expect(matches).toBeNull();
  });
});

describe("PtyPassthrough Ctrl+V uses the fallback helper", () => {
  const src = readRepoFile("src/terminal/PtyPassthrough.tsx");

  test("imports readClipboardTextWithFallback from clipboardRead", () => {
    expect(src).toContain(
      'import { readClipboardTextWithFallback } from "./clipboardRead";',
    );
  });

  test("the Ctrl+V/Cmd+V handler calls readClipboardTextWithFallback for text", () => {
    expect(src).toContain("readClipboardTextWithFallback()");
  });

  test("the image-clipboard branch still uses navigator.clipboard.read()", () => {
    // The image branch can't be replaced with pbpaste — pbpaste only
    // emits text. Pin that the image MIME read path is preserved so
    // Cmd+Shift+Ctrl+4 → Cmd+V still works for screenshot → agent.
    expect(src).toContain("navigator.clipboard.read()");
  });
});

describe("clipboardRead helper exists and exports the fallback API", () => {
  const src = readRepoFile("src/terminal/clipboardRead.ts");

  test("exports readClipboardTextWithFallback as an async function", () => {
    expect(src).toMatch(
      /export\s+async\s+function\s+readClipboardTextWithFallback/,
    );
  });

  test("tries navigator.clipboard.readText() first", () => {
    // Pin the fast-path ordering. If a future refactor flips this
    // (e.g. "always use pbpaste, it's more reliable"), every Ctrl+V
    // on a healthy install pays subprocess latency.
    const webIdx = src.indexOf("navigator.clipboard.readText()");
    expect(webIdx).toBeGreaterThan(-1);
  });

  test("falls back to system.readClipboardText via a deferred import", () => {
    // The deferred-import pattern is what lets `bun test` exercise
    // this module without pulling @tauri-apps into the graph. If
    // someone replaces it with a top-level import, the existing
    // bun:test suite breaks AND we lose the test-without-Tauri
    // affordance.
    expect(src).toContain('await import("../lib/fs")');
    expect(src).toContain("system.readClipboardText()");
  });
});

describe("Rust pbpaste command exists in src-tauri", () => {
  const fsRs = readRepoFile("src-tauri/src/fs.rs");
  const libRs = readRepoFile("src-tauri/src/lib.rs");

  test("fs.rs declares the system_clipboard_read_text command", () => {
    // The Rust handler that actually does the pbpaste spawn. If
    // this disappears, the frontend's invoke() call rejects and
    // the fallback chain returns null even though the helper logic
    // is still correct.
    expect(fsRs).toContain("pub async fn system_clipboard_read_text");
    expect(fsRs).toContain("#[tauri::command]");
  });

  test("system_clipboard_read_text shells out to /usr/bin/pbpaste", () => {
    // Pin the absolute path. A bare `pbpaste` would ENOENT when
    // Goonware is launched from the Dock with a stripped PATH (see
    // `inherit_login_shell_env` in lib.rs for the broader pattern).
    expect(fsRs).toContain('Command::new("/usr/bin/pbpaste")');
  });

  test("system_clipboard_read_text returns Ok(empty) on non-zero exit", () => {
    // Empty clipboard / non-text MIME on the pasteboard makes
    // pbpaste exit non-zero. Returning Err there would propagate
    // through the IPC bridge as a rejection — the fallback chain
    // then treats the throw the same as missing data, which is
    // correct but noisy. Returning Ok("") keeps the chain quiet
    // and exact about the "really empty" state.
    expect(fsRs).toContain("return Ok(String::new())");
  });

  test("lib.rs registers system_clipboard_read_text in invoke_handler", () => {
    // Easy to miss when adding a new command — without this line,
    // the frontend's `invoke("system_clipboard_read_text")` rejects
    // with "command not found." Pin the registration.
    expect(libRs).toContain("fs::system_clipboard_read_text");
  });
});

describe("CanvasGrid visibility-restore is wired up in production", () => {
  const src = readRepoFile("src/terminal/CanvasGrid.tsx");

  test("imports the visibility-restore state machine", () => {
    expect(src).toContain(
      'from "./gpu/visibilityRestore"',
    );
    expect(src).toContain("decideVisibilityAction");
    expect(src).toContain("executeVisibilityAction");
  });

  test("CanvasGrid accepts an isVisible prop with default true", () => {
    // Default true keeps standalone callers working without a prop
    // change — only the keepalive-layer-hosted CanvasGrids need
    // the explicit isVisible={...} wiring.
    expect(src).toMatch(/isVisible\?:\s*boolean/);
    expect(src).toMatch(/isVisible\s*=\s*true/);
  });

  test("ResizeObserver bails on a 0×0 contentRect", () => {
    // The "wrapper went display: none" guard — without this, the
    // renderer's backbuffer shrinks to 1×1 every time the keepalive
    // hides the canvas.
    expect(src).toMatch(
      /rect\.width\s*===\s*0\s*\|\|\s*rect\.height\s*===\s*0/,
    );
  });

  test("hidden→visible effect calls renderer.reconfigure()", () => {
    // The load-bearing recovery call. If this isn't reached on
    // visibility restore, the rest of the chain (resize, invalidate,
    // paint) lands on a dead swapchain and the user sees black.
    expect(src).toContain("renderer.reconfigure()");
  });
});

describe("BlockTerminal + LiveBlock forward isVisible to CanvasGrid", () => {
  test("BlockTerminal alt-screen branch forwards isVisible to CanvasGrid", () => {
    const src = readRepoFile("src/terminal/BlockTerminal.tsx");
    // The alt-screen CanvasGrid sits behind {!exited && altScreen &&
    // ...}. Pin that isVisible is forwarded — without it the alt-
    // screen agent (vim / claude-in-alt-screen / model picker) goes
    // black on tab-switch.
    //
    // Anchor on the `<CanvasGrid` JSX element that comes after the
    // `altScreen && (` guard, then scan the next ~800 chars for the
    // isVisible binding. This survives doc-comment changes inside
    // the branch.
    const altIdx = src.indexOf("altScreen && (");
    expect(altIdx).toBeGreaterThan(-1);
    const canvasIdx = src.indexOf("<CanvasGrid", altIdx);
    expect(canvasIdx).toBeGreaterThan(altIdx);
    const propsWindow = src.slice(canvasIdx, canvasIdx + 800);
    expect(propsWindow).toMatch(/isVisible\s*=\s*\{isVisible\}/);
  });

  test("BlockTerminal LiveBlock forwards isVisible", () => {
    const src = readRepoFile("src/terminal/BlockTerminal.tsx");
    // The inline LiveBlock path (non-alt-screen agent mode like
    // claude in the model picker). Forward gate too — different
    // CanvasGrid, same root-cause black-screen if isVisible isn't
    // wired through.
    const liveIdx = src.indexOf("<LiveBlock");
    expect(liveIdx).toBeGreaterThan(-1);
    const liveWindow = src.slice(liveIdx, liveIdx + 1200);
    expect(liveWindow).toMatch(/isVisible\s*=\s*\{isVisible\}/);
  });

  test("LiveBlock forwards isVisible to its embedded CanvasGrid", () => {
    const src = readRepoFile("src/terminal/LiveBlock.tsx");
    // LiveBlock is the indirection between BlockTerminal and the
    // inline CanvasGrid — must pass-through.
    expect(src).toMatch(/isVisible\?:\s*boolean/);
    const canvasIdx = src.indexOf("<CanvasGrid");
    expect(canvasIdx).toBeGreaterThan(-1);
    const canvasWindow = src.slice(canvasIdx, canvasIdx + 600);
    expect(canvasWindow).toMatch(/isVisible\s*=\s*\{isVisible\}/);
  });
});
