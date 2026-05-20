import { useCallback, useEffect, useRef, useState } from "react";
import { WindowChrome } from "./WindowChrome";
import { Sidebar } from "./Sidebar";
import { MainColumn } from "./MainColumn";
import { RightPanel } from "./RightPanel";
import { CreatePRDialog } from "./CreatePRDialog";
import { SettingsView } from "./SettingsView";
import { UpdaterToast } from "./UpdaterToast";
import { SearchOverlay } from "@/palette/SearchOverlay";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useSpatialNavigation } from "@/hooks/useSpatialNavigation";
import { useOpenUrlInBrowser } from "@/hooks/useOpenUrlInBrowser";
import { useFocusActiveTerminal } from "@/hooks/useFocusActiveTerminal";
import { useVisibleTerminalSet } from "@/hooks/useVisibleTerminalSet";
import { useTerminalRunningPoll } from "@/terminal/terminalActivityStore";
import { useAgentHookSubscription } from "@/state/agentActivityStore";
import { useAppDispatch, useAppState } from "@/state/AppState";
import {
  RIGHT_DEFAULT,
  RIGHT_MAX,
  RIGHT_MIN,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampRight,
  clampSidebar,
} from "@/state/types";

const COLLAPSED_SIDEBAR_W = 40;

/**
 * Three-column shell:
 *
 *   ┌──────┬─────────────────────────┬───────────────┐
 *   │      │                         │               │
 *   │ side │  main column            │  right panel  │
 *   │      │  (tabs + content)       │  (files /     │
 *   │      │                         │   changes /   │
 *   │      │                         │   checks /    │
 *   │      │                         │   memory)     │
 *   │      │                         │  ───────────  │
 *   │      │                         │  setup / run /│
 *   │      │                         │  terminal     │
 *   └──────┴─────────────────────────┴───────────────┘
 *
 * The two side columns are user-resizable via 1px drag handles between
 * the columns. Sidebar collapses to a 40px icon rail when toggled
 * (drag still respects this — once collapsed, drag is disabled until
 * re-expanded). The right panel collapses fully to 0 width.
 */
export function AppShell() {
  useKeyboardShortcuts();
  useSpatialNavigation();
  useOpenUrlInBrowser();
  useFocusActiveTerminal();
  useVisibleTerminalSet();
  useTerminalRunningPoll();
  useAgentHookSubscription();
  const {
    sidebarCollapsed,
    rightPanelCollapsed,
    sidebarWidth,
    rightPanelWidth,
  } = useAppState();

  // Guard against any pathway that lands `undefined`/`NaN` here — an
  // invalid CSS length in `grid-template-columns` collapses the whole
  // grid to a single column and stacks every panel vertically. Clamp
  // and fall through to defaults so layout is always sane.
  const sidebarPx = sidebarCollapsed
    ? COLLAPSED_SIDEBAR_W
    : clampSidebar(
        typeof sidebarWidth === "number" && Number.isFinite(sidebarWidth)
          ? sidebarWidth
          : SIDEBAR_DEFAULT,
      );
  const rightPx = rightPanelCollapsed
    ? 0
    : clampRight(
        typeof rightPanelWidth === "number" && Number.isFinite(rightPanelWidth)
          ? rightPanelWidth
          : RIGHT_DEFAULT,
      );

  return (
    <div
      style={{
        height: "100vh",
        width: "100vw",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--surface-0)",
        overflow: "hidden",
      }}
    >
      <WindowChrome />

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "row",
          width: "100%",
        }}
      >
        <aside
          style={{
            width: sidebarPx,
            flexShrink: 0,
            overflow: "hidden",
            backgroundColor: "var(--surface-1)",
            borderRight: "var(--border-1)",
            position: "relative",
          }}
        >
          <Sidebar />
          {!sidebarCollapsed && <ResizeHandle side="left" />}
        </aside>

        <main
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            position: "relative",
          }}
        >
          <MainColumn />
        </main>

        <aside
          style={{
            width: rightPx,
            flexShrink: 0,
            overflow: "hidden",
            backgroundColor: "var(--surface-1)",
            borderLeft: rightPx > 0 ? "var(--border-1)" : "none",
            position: "relative",
          }}
        >
          {!rightPanelCollapsed && <ResizeHandle side="right" />}
          <RightPanel />
        </aside>
      </div>

      <SearchOverlay />
      <CreatePRDialog />
      <SettingsView />
      <UpdaterToast />
    </div>
  );
}

/* ------------------------------------------------------------------
   Resize handle — 4px hit zone with a 1px center line. Drag updates
   the corresponding width via dispatch. Cursor stays col-resize on
   the document during drag.
   ------------------------------------------------------------------ */

function ResizeHandle({ side }: { side: "left" | "right" }) {
  const dispatch = useAppDispatch();
  const state = useAppState();
  const startXRef = useRef(0);
  const startWRef = useRef(0);
  const draggingRef = useRef(false);
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);

  const min = side === "left" ? SIDEBAR_MIN : RIGHT_MIN;
  const max = side === "left" ? SIDEBAR_MAX : RIGHT_MAX;
  const widthSelector = side === "left"
    ? state.sidebarWidth
    : state.rightPanelWidth;

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      startXRef.current = e.clientX;
      startWRef.current = widthSelector;
      setActive(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [widthSelector],
  );

  useEffect(() => {
    // rAF-coalesce drag dispatches. macOS trackpads + high-refresh
    // pointers fire mousemove well above 60 Hz (often 120 Hz). In
    // dev that's masked by the slower devtools-attached pipeline,
    // but in a notarized production build every event drives a full
    // state dispatch → React commit → AppShell flex re-layout →
    // CanvasGrid ResizeObserver → WebGPU backbuffer reallocation.
    // Two of those per frame is visible jitter. Aligning the
    // dispatch to rAF gives the layout one chance per frame to
    // settle and matches the cadence the GPU is rendering at
    // anyway.
    let rafId: number | null = null;
    let pendingWidth: number | null = null;
    const flush = () => {
      rafId = null;
      const next = pendingWidth;
      pendingWidth = null;
      if (next == null) return;
      dispatch({
        type: side === "left" ? "set-sidebar-width" : "set-right-panel-width",
        width: next,
      });
    };
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const dx = e.clientX - startXRef.current;
      // Sidebar grows to the right (positive dx → wider).
      // Right panel grows to the left (positive dx → narrower).
      pendingWidth =
        side === "left"
          ? Math.min(max, Math.max(min, startWRef.current + dx))
          : Math.min(max, Math.max(min, startWRef.current - dx));
      if (rafId === null) {
        rafId = window.requestAnimationFrame(flush);
      }
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setActive(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // Make sure the final width lands even if mouseup arrives
      // between the last rAF-scheduled flush and its fire.
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
        flush();
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, [side, min, max, dispatch]);

  const lit = hover || active;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        // 6px hit zone, centered over the column boundary.
        ...(side === "left"
          ? { right: -3, width: 6 }
          : { left: -3, width: 6 }),
        zIndex: 5,
        cursor: "col-resize",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: side === "left" ? 2 : 3,
          width: 1,
          backgroundColor: lit
            ? "var(--accent)"
            : "transparent",
          transition: "background-color var(--motion-fast) var(--ease-out-quart)",
        }}
      />
    </div>
  );
}
