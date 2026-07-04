import { useCallback, useEffect, useRef, useState } from "react";
import { WindowChrome } from "./WindowChrome";
import { Sidebar } from "./Sidebar";
import { MainColumn } from "./MainColumn";
import { RightPanel } from "./RightPanel";
import { CreatePRDialog } from "./CreatePRDialog";
import { CreateWorktreeDialog } from "./CreateWorktreeDialog";
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
import { fs } from "@/lib/fs";
import { coalesceFrame } from "@/lib/coalesceFrame";
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

/** Floor for the main column. Anything below this and the terminal /
 *  diff content is unusable, so when the window narrows past
 *  `sidebar + right + MIN_MAIN_WIDTH` we eat into the side panels
 *  instead of letting them overflow + clip. */
const MIN_MAIN_WIDTH = 320;

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
    projects,
  } = useAppState();
  const dispatch = useAppDispatch();

  // Backfill auto-detected favicons / app icons for projects that were
  // added before the scan existed (faviconDataUri is null and the user
  // hasn't picked a HugeIcon override). Runs once per session per
  // project; the result persists so subsequent launches are cheap.
  useEffect(() => {
    let cancelled = false;
    for (const project of Object.values(projects)) {
      if (project.faviconDataUri || project.iconName) continue;
      fs.scanProjectIcon(project.path)
        .then((faviconDataUri) => {
          if (cancelled || !faviconDataUri) return;
          dispatch({
            type: "update-project",
            id: project.id,
            patch: { faviconDataUri },
          });
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [projects, dispatch]);

  // Guard against any pathway that lands `undefined`/`NaN` here — an
  // invalid CSS length in `grid-template-columns` collapses the whole
  // grid to a single column and stacks every panel vertically. Clamp
  // and fall through to defaults so layout is always sane.
  const storedSidebarPx = sidebarCollapsed
    ? COLLAPSED_SIDEBAR_W
    : clampSidebar(
        typeof sidebarWidth === "number" && Number.isFinite(sidebarWidth)
          ? sidebarWidth
          : SIDEBAR_DEFAULT,
      );
  const storedRightPx = rightPanelCollapsed
    ? 0
    : clampRight(
        typeof rightPanelWidth === "number" && Number.isFinite(rightPanelWidth)
          ? rightPanelWidth
          : RIGHT_DEFAULT,
      );

  // Track viewport width so we can clamp the side panels when the
  // window shrinks. Both sides use `flexShrink: 0` to hold their drag
  // widths, but that overflows the parent (which has overflow: hidden)
  // when the window narrows past the sum of the stored widths — the
  // right panel ends up clipped off-screen and the layout looks
  // broken. We only clamp at display time; the stored widths in state
  // are left alone so the user's preference is restored when the
  // window grows back.
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? Infinity : window.innerWidth,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Coalesce the window-resize signal to one React commit per frame.
    // macOS fires `resize` continuously during a live window-drag (often
    // >120 Hz on high-refresh displays) and each event would otherwise
    // cascade into a flex relayout → CanvasGrid ResizeObserver → WebGPU
    // backbuffer realloc.
    const coalescer = coalesceFrame<number>(setViewportWidth);
    const onResize = () => coalescer.push(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      coalescer.cancel();
    };
  }, []);

  let sidebarPx = storedSidebarPx;
  let rightPx = storedRightPx;
  const sideBudget = Math.max(0, viewportWidth - MIN_MAIN_WIDTH);
  const sidesTotal = sidebarPx + rightPx;
  if (sidesTotal > sideBudget && sidesTotal > 0) {
    // Shrink both side panels proportionally so neither goes to 0
    // while the other holds its full size. Floor + adjust so we
    // don't end up off by a pixel that retriggers overflow.
    const ratio = sideBudget / sidesTotal;
    sidebarPx = Math.floor(sidebarPx * ratio);
    rightPx = Math.max(0, sideBudget - sidebarPx);
  }

  return (
    <div
      style={{
        height: "100vh",
        width: "100vw",
        display: "flex",
        flexDirection: "column",
        // Transparent: the native terminal surface sits behind the
        // webview and shows through the terminal-pane hole. Window
        // chrome, sidebars and the right panel each paint their own
        // opaque bg, so only the terminal pane is see-through.
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
          {!sidebarCollapsed && (
            <ResizeHandle
              side="left"
              effectiveWidth={sidebarPx}
              otherSideWidth={rightPx}
            />
          )}
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
            // No background here: the right panel hosts the native warpui SIDE
            // pane, whose terminal region must be a transparent hole down to the
            // Metal surface below the webview. An opaque --surface-1 here covered
            // it (the "side panel renders nothing" bug). The panel's own chrome
            // (UpperPanel, the SecondaryPanel header, and its content area when
            // NOT showing the terminal) each paint --surface-1, so the only
            // transparent region is the terminal itself — mirrors the main
            // column's <main>, which likewise has no background.
            borderLeft: rightPx > 0 ? "var(--border-1)" : "none",
            position: "relative",
          }}
        >
          {!rightPanelCollapsed && (
            <ResizeHandle
              side="right"
              effectiveWidth={rightPx}
              otherSideWidth={sidebarPx}
            />
          )}
          <RightPanel />
        </aside>
      </div>

      <SearchOverlay />
      <CreatePRDialog />
      <CreateWorktreeDialog />
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

function ResizeHandle({
  side,
  effectiveWidth,
  otherSideWidth,
}: {
  side: "left" | "right";
  /** The currently-rendered width of this panel (post viewport
   *  clamp). Used as the drag baseline so the handle moves 1:1 with
   *  the cursor instead of starting from a possibly-larger stored
   *  width. */
  effectiveWidth: number;
  /** Currently-rendered width of the opposite side panel. Drives the
   *  dynamic max so the drag never writes a width that would force
   *  the main column below MIN_MAIN_WIDTH. */
  otherSideWidth: number;
}) {
  const dispatch = useAppDispatch();
  const startXRef = useRef(0);
  const startWRef = useRef(0);
  const draggingRef = useRef(false);
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);

  const min = side === "left" ? SIDEBAR_MIN : RIGHT_MIN;
  const baseMax = side === "left" ? SIDEBAR_MAX : RIGHT_MAX;

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      startXRef.current = e.clientX;
      startWRef.current = effectiveWidth;
      setActive(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [effectiveWidth],
  );

  useEffect(() => {
    // Coalesce drag dispatches to one React commit per frame. macOS
    // trackpads + high-refresh pointers fire mousemove well above 60 Hz
    // (often 120 Hz). In dev that's masked by the slower devtools-
    // attached pipeline, but in a notarized production build every
    // event drives a full state dispatch → React commit → AppShell flex
    // re-layout → CanvasGrid ResizeObserver → WebGPU backbuffer
    // reallocation.
    const coalescer = coalesceFrame<number>((width) => {
      dispatch({
        type: side === "left" ? "set-sidebar-width" : "set-right-panel-width",
        width,
      });
    });
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const dx = e.clientX - startXRef.current;
      // Dynamic max: leave at least MIN_MAIN_WIDTH for the center
      // column, accounting for the opposite side panel's current
      // rendered width. Without this, dragging past the viewport's
      // capacity grows the stored value while the rendered width
      // clamps — which feels like the panel "got stuck" because the
      // cursor keeps moving but the boundary doesn't.
      const viewport =
        typeof window === "undefined" ? Infinity : window.innerWidth;
      const dynamicMax = Math.max(
        min,
        Math.min(baseMax, viewport - MIN_MAIN_WIDTH - otherSideWidth),
      );
      // Sidebar grows to the right (positive dx → wider).
      // Right panel grows to the left (positive dx → narrower).
      const next =
        side === "left"
          ? Math.min(dynamicMax, Math.max(min, startWRef.current + dx))
          : Math.min(dynamicMax, Math.max(min, startWRef.current - dx));
      coalescer.push(next);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setActive(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // Make sure the final width lands even if mouseup arrives
      // between the last rAF-scheduled flush and its fire.
      coalescer.flush();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      coalescer.cancel();
    };
  }, [side, min, baseMax, otherSideWidth, dispatch]);

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
