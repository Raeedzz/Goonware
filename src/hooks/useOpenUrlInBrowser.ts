import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Catches the `rli:open-url` custom event dispatched from terminal cells
 * and (someday) editor link tokens, and opens the URL in the user's
 * default system browser (Chrome / Safari / whatever they've set).
 *
 * Routing rule, against the project's two browsers:
 *  - **System browser** (this hook) — for unsolicited links the user
 *    encounters: agent output, editor markdown, log lines. Clicking
 *    one of those is "I want to look at this in my real browser."
 *  - **Built-in browser pane** — for deliberate visits the user
 *    composes into the in-app URL bar (paste + Enter). That stays
 *    inside the headless preview so the user can inspect their
 *    dev-server output without leaving the app.
 *
 * Implementation uses Tauri's `system_open` command (already wired up
 * for "open this file in Finder", reused here for URLs since the same
 * `Open` API on macOS handles both file paths and `http(s)://` URLs).
 * Falls back to `window.open` if the invoke fails — that path catches
 * Tauri-dev edge cases where the IPC isn't yet ready.
 */
export function useOpenUrlInBrowser() {
  useEffect(() => {
    const onOpen = (e: Event) => {
      const url = (e as CustomEvent<{ url: string }>).detail?.url;
      if (!url) return;
      void invoke("system_open", { path: url }).catch(() => {
        try {
          window.open(url, "_blank");
        } catch {
          /* genuinely no way to open — give up silently */
        }
      });
    };
    window.addEventListener("goonware:open-url", onOpen);
    return () => window.removeEventListener("goonware:open-url", onOpen);
  }, []);
}
