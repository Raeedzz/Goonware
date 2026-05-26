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
export function WarpSurfaceTracker({ visible }: { visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  // When no terminal tab is active, stop mirroring any pty (the surface is
  // also hidden by the zero rect below). Choosing WHICH pty to mirror is
  // driven by BlockTerminal, which owns the real, generation-adjusted pty id.
  useEffect(() => {
    if (!visible) {
      invoke("term_native_detach").catch(() => {});
    }
  }, [visible]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let raf = 0;
    const report = () => {
      const r = visible ? el.getBoundingClientRect() : null;
      // CSS px relative to the webview's top-left (== window content top-left);
      // Rust converts to a bottom-left screen frame for the child window.
      const rect = r
        ? { x: r.left, y: r.top, width: r.width, height: r.height }
        : { x: 0, y: 0, width: 0, height: 0 };
      // No-op on non-macOS (command absent) — swallow.
      invoke("term_surface_set_rect", rect).catch(() => {});
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(report);
    };

    schedule();
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    window.addEventListener("resize", schedule);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [visible]);

  return (
    <div
      ref={ref}
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      aria-hidden
    />
  );
}
