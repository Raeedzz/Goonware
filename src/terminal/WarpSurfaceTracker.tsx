import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Bridges React layout → the embedded native warpui terminal surface.
 *
 * The native terminal is a Metal-backed child window composited over the
 * Goonware window (see `src-tauri/src/warp_term.rs`). React still owns the
 * overall layout (sidebar, tabs, right panel), so this component measures the
 * on-screen rect of the terminal pane and reports it to the Rust
 * `term_surface_set_rect` command, which repositions the native surface to
 * cover exactly that region — nothing else.
 *
 * Rendered as an absolutely-positioned, transparent, non-interactive child of
 * the (position:relative) terminal-pane container, so its `getBoundingClientRect`
 * is the pane's rect. When `visible` is false (a non-terminal tab is active) we
 * report a zero rect, which hides the surface.
 */
export function WarpSurfaceTracker({
  visible,
  paneKey = "main",
  reportWhenHidden = false,
}: {
  visible: boolean;
  /** Which native pane this tracker reports for: "main" (main column, or the
   *  left half of a main-column split), "main2" (the split's right half) or
   *  "side" (right panel). The surface covers the combined box of all placed
   *  panes. */
  paneKey?: "main" | "side" | "main2";
  /**
   * Keep reporting the real measured rect even while `visible` is false
   * (instead of the zero rect that hides the pane). Used by the MAIN pane in
   * split layouts: its box must stay accurate when a non-terminal tab is
   * showing, or the Rust side's retained rect goes stale (e.g. full-width
   * from before the split opened) and paints over the neighbouring pane.
   * The pty is still detached while hidden, so the pane renders black behind
   * the opaque non-terminal DOM.
   */
  reportWhenHidden?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // When no terminal tab is active, stop mirroring any pty (the surface is
  // also hidden by the zero rect below). Choosing WHICH pty to mirror is
  // driven by BlockTerminal, which owns the real, generation-adjusted pty id.
  useEffect(() => {
    if (!visible) {
      invoke("term_native_detach", { paneKey }).catch(() => {});
    }
  }, [visible, paneKey]);

  // Unmount cleanup: zero the rect + detach so a pane whose tracker leaves
  // the tree (the split's right half after an unsplit) doesn't keep a stale
  // rect that would leave a dead column composited over the re-widened main
  // pane. The main pane ignores zero-rect reports Rust-side (deliberate
  // retention), so this is a no-op for it.
  useEffect(() => {
    return () => {
      invoke("term_surface_set_rect", {
        paneKey,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      }).catch(() => {});
      invoke("term_native_detach", { paneKey }).catch(() => {});
    };
  }, [paneKey]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let raf = 0;
    // Last rect actually sent, so the poll below can re-check cheaply
    // without spamming IPC. Seeded to a sentinel so the first report
    // always sends.
    let sent = "";
    const report = (force = false) => {
      const r = visible || reportWhenHidden ? el.getBoundingClientRect() : null;
      // CSS px relative to the webview's top-left (== window content top-left);
      // Rust converts to a bottom-left screen frame for the child window.
      //
      // Clamp to the window box. The native surface composites BELOW the
      // webview, so any part of a measured rect outside the window is
      // meaningless — but reported as-is it walks the embedded child window
      // (which macOS does NOT clip to its parent) out past the app's edge.
      // The concrete case: collapsing the right panel to 0 width leaves the
      // panel's min-content-sized DOM overflowing off the window's right
      // edge (overflow:hidden clips paint, not layout), and this tracker
      // would report that off-window box as a real pane — the side terminal
      // then "shoots out" beyond the window. An off-window or fully-clipped
      // rect clamps to zero, which hides the pane.
      let rect = { x: 0, y: 0, width: 0, height: 0 };
      if (r) {
        const left = Math.max(r.left, 0);
        const top = Math.max(r.top, 0);
        const right = Math.min(r.right, window.innerWidth);
        const bottom = Math.min(r.bottom, window.innerHeight);
        if (right - left > 1 && bottom - top > 1) {
          rect = { x: left, y: top, width: right - left, height: bottom - top };
        }
      }
      const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
      if (!force && key === sent) return;
      sent = key;
      // No-op on non-macOS (command absent) — swallow.
      invoke("term_surface_set_rect", { paneKey, ...rect }).catch(() => {});
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => report());
    };

    report(true);
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    window.addEventListener("resize", schedule);
    // Self-healing backstop: the RO + single-rAF chain above can drop a
    // report (WKWebView pauses rAF while the window is occluded, and a
    // layout flip like split↔full racing a heavy commit has been seen
    // to leave the native rect stale — terminal stuck at half width,
    // the rest of the hole showing the black host window). Re-checking
    // on a slow interval costs one getBoundingClientRect (a forced
    // layout read, so keep it infrequent) and sends nothing while the
    // rect is unchanged, but guarantees the native surface converges
    // to the real DOM box within ~1s. RO + window-resize cover every
    // normal path instantly; this only catches the rare dropped
    // report. Not started at all while this pane reports the zero
    // rect (hidden, no reportWhenHidden) or the window is hidden —
    // there's nothing to converge to, and per-pane wakeups while
    // backgrounded are exactly what drains the battery with many
    // panes mounted. The visibilitychange hook re-checks immediately
    // on un-hide, which also covers rAF having been paused.
    let poll: number | null = null;
    const syncPoll = () => {
      const wantPoll = (visible || reportWhenHidden) && !document.hidden;
      if (wantPoll && poll === null) {
        poll = window.setInterval(() => report(), 1000);
      } else if (!wantPoll && poll !== null) {
        window.clearInterval(poll);
        poll = null;
      }
    };
    const onVisibilityChange = () => {
      if (!document.hidden) report();
      syncPoll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    syncPoll();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (poll !== null) window.clearInterval(poll);
    };
  }, [visible, paneKey, reportWhenHidden]);

  return (
    <div
      ref={ref}
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      aria-hidden
    />
  );
}
