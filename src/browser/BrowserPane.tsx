import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { connectionsViewVariants } from "@/design/motion";
import {
  browser,
  invalidateBrowserBaseCache,
  type BrowserHealth,
  type BrowserLogEntry,
  type BrowserStatus,
} from "@/lib/browser";

interface Props {
  onClose: () => void;
  /**
   * When true, renders inline (fills its container) instead of as the
   * absolute-positioned overlay. Used by the workspace pane tree.
   */
  embedded?: boolean;
  /**
   * Initial URL to navigate to on mount. If omitted, the URL bar opens
   * empty and waits for the user.
   */
  initialUrl?: string;
  /**
   * Whether this BrowserPane is currently visible to the user. The
   * RightPanel mounts the Browser pane behind `display: none` when
   * another tab is active — there's no point burning a Tauri IPC
   * round-trip every second to pull a screenshot the user can't see.
   * Defaults to true so the standalone overlay use case (full-screen
   * Browser drawer) keeps polling unconditionally.
   */
  isVisible?: boolean;
}

// One unified poll cadence. Previously the pane ran three independent
// intervals (health 2s, status+console 1.5s, screenshot 1s). With 20
// worktrees that's up to 60 IPC round-trips/sec just to keep one
// preview alive. Coalescing into a single 1Hz tick that walks
// health → status → console → screenshot in sequence drops the rate
// to one tick/sec per visible Browser pane — and gates the entire
// loop on document + pane visibility so backgrounded panes pay zero.
const POLL_INTERVAL_MS = 1000;
const COMMON_DEV_PORTS = [5173, 3000, 8080, 4321, 1420];

// Console-pane resize bounds. 80px keeps the header row + a single
// log line visible (the minimum useful state); 600px is a generous
// upper bound that still leaves room for the screenshot frame above
// even on small windows.
const CONSOLE_MIN_HEIGHT = 80;
const CONSOLE_MAX_HEIGHT = 600;
const CONSOLE_DEFAULT_HEIGHT = 220;
const CONSOLE_HEIGHT_STORAGE_KEY = "goonware.browser.consoleHeight";

function loadConsoleHeight(): number {
  if (typeof window === "undefined") return CONSOLE_DEFAULT_HEIGHT;
  try {
    const raw = window.localStorage.getItem(CONSOLE_HEIGHT_STORAGE_KEY);
    if (!raw) return CONSOLE_DEFAULT_HEIGHT;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return CONSOLE_DEFAULT_HEIGHT;
    return clampConsoleHeight(n);
  } catch {
    return CONSOLE_DEFAULT_HEIGHT;
  }
}

function clampConsoleHeight(h: number): number {
  return Math.min(CONSOLE_MAX_HEIGHT, Math.max(CONSOLE_MIN_HEIGHT, h));
}

/**
 * Address-bar heuristics — decides whether the user typed a URL or a
 * search query. Mirrors Chrome's URL bar:
 *
 *  - Already has a scheme        → use as-is
 *  - Bare port (digits only)     → http://localhost:<n>/
 *  - Looks like a hostname       → prefix https://
 *  - Anything else (has spaces,
 *    no dot, etc.)               → Google search
 *
 * Without this guard, "react hooks" became `https://react hooks` which
 * the daemon rejected, and nothing rendered — the user saw the empty
 * state and assumed the in-app browser was broken.
 */
function resolveTarget(input: string): string {
  if (/^https?:\/\//i.test(input)) return input;
  if (/^\d+$/.test(input)) return `http://localhost:${input}/`;
  // Hostname-shaped: only word chars / hyphens / dots / optional :port /
  // optional path, no spaces, and must contain at least one dot to
  // qualify (so "foo.com" yes, "foo" no).
  const hostLike = /^[\w.-]+(:\d+)?(\/[^\s]*)?$/;
  if (hostLike.test(input) && input.includes(".")) {
    return `https://${input}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

/**
 * In-house browser pane — drives the Rust-side browser daemon.
 *
 * URL bar at the top forwards /navigate. Clicks on the screenshot
 * forward /click in viewport coordinates. Keystrokes (when the viewport
 * is "focused") forward to /type or /key. The daemon's PNG screenshot
 * is polled at 1Hz; polling pauses while the tab is hidden so background
 * windows don't burn CPU.
 */
export function BrowserPane({
  onClose,
  embedded = false,
  initialUrl,
  isVisible = true,
}: Props) {
  const [health, setHealth] = useState<BrowserHealth | null>(null);
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [logs, setLogs] = useState<BrowserLogEntry[]>([]);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState(initialUrl ?? "");
  const [focused, setFocused] = useState(false);
  // Inline error surfaced under the URL bar when a navigation attempt
  // fails (daemon rejects, can't bind, etc.). Cleared on the next
  // successful navigate or status tick.
  const [navError, setNavError] = useState<string | null>(null);
  // True between the moment the user presses Enter and the moment the
  // daemon's status reports `ready` for the new URL. Lets the Frame
  // render a "loading…" hint instead of the stale "type a URL above"
  // empty state while the first navigation is in flight.
  const [navPending, setNavPending] = useState(false);
  // User-resizable console pane height. Persisted to localStorage so
  // a deliberately-tall console survives reloads and tab-switches.
  const [consoleHeight, setConsoleHeight] = useState<number>(loadConsoleHeight);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const focusTrap = useRef<HTMLTextAreaElement | null>(null);

  // FAILURE_THRESHOLD before the "daemon offline" UI takes over. Each
  // poll is gated by browser.health's own 10s timeout, so 10 ticks of
  // failure ≈ 10s wall-time of consecutive failures. Combined with the
  // `rli://browser-daemon-ready` event, a healthy daemon flips the
  // pane to ready instantly and the offline UI essentially never
  // appears on a working setup.
  const FAILURE_THRESHOLD = 10;
  const failuresRef = useRef(0);
  // Ref-mirror of the health.ok flag so the unified poll closure
  // doesn't need a re-mounted effect every time health flips.
  const healthOkRef = useRef(false);
  // Same for status.ready — the screenshot leg of the poll only
  // fires once a real page has loaded (avoids race against about:blank).
  const statusReadyRef = useRef(false);
  // Same for visibility — flipped by the parent + by
  // document.visibilityState handler. The poll closure reads this
  // every tick to no-op when the pane is backgrounded.
  const isVisibleRef = useRef(isVisible);
  useEffect(() => {
    isVisibleRef.current = isVisible;
  }, [isVisible]);

  const checkRef = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;

    const checkHealth = async (): Promise<boolean> => {
      const h = await browser.health();
      if (cancelled) return false;
      if (h.ok) {
        failuresRef.current = 0;
        healthOkRef.current = true;
        setHealth(h);
        return true;
      }
      failuresRef.current += 1;
      healthOkRef.current = false;
      if (failuresRef.current >= FAILURE_THRESHOLD) {
        setHealth(h);
      }
      // Below threshold we leave the previous `health` value alone so
      // the pane doesn't flash through the offline UI on a transient blip.
      return false;
    };

    const pollLive = async () => {
      const s = await browser.status();
      if (cancelled) return;
      setStatus(s);
      if (s) {
        // Any successful status read implies the daemon is up and
        // responsive, so a previously-shown nav error is stale. Clear
        // it so the user isn't staring at a "couldn't reach daemon"
        // banner over a working preview.
        setNavError(null);
        statusReadyRef.current = !!s.ready;
      }
      const c = await browser.console();
      if (cancelled) return;
      if (c) setLogs(c.entries.slice(-100));
      if (statusReadyRef.current) {
        // Screenshot URL refresh — the <img> reloads off this URL.
        const u = await browser.screenshotUrl();
        if (cancelled) return;
        setScreenshotUrl(u);
      }
    };

    /**
     * One unified tick. Replaces the three previous overlapping
     * setIntervals. Skips entirely when the pane isn't user-visible
     * (display:none parent or backgrounded webview), and walks
     * health → status → console → screenshot in sequence so the next
     * leg can short-circuit on what the previous leg learned. Net
     * effect at 20 idle worktrees: zero Tauri IPC traffic for Browser
     * panes that aren't currently looking at the browser tab.
     */
    const tick = async () => {
      if (cancelled) return;
      // Background / hidden / display:none → idle. The visible check
      // happens here per-tick (not at setup time) so the loop reacts
      // immediately when the user flips back without us having to
      // tear down and rebuild the interval.
      if (!isVisibleRef.current) return;
      if (document.visibilityState === "hidden") return;
      if (!healthOkRef.current) {
        await checkHealth();
        return;
      }
      await pollLive();
    };

    // checkRef exposes a fast-path bootstrap call for the daemon-ready
    // event and the manual retry button — runs the full tick once.
    checkRef.current = () => void tick();

    void tick();
    const t = window.setInterval(() => void tick(), POLL_INTERVAL_MS);

    // The daemon emits this event from its `start()` immediately after
    // it has bound a port and published it to BrowserState. Without
    // this, a slow boot could sit in the offline UI for a full
    // FAILURE_THRESHOLD window before the next poll cycle even tries.
    let unlistenReady: UnlistenFn | null = null;
    void listen<number>("goonware://browser-daemon-ready", () => {
      if (cancelled) return;
      invalidateBrowserBaseCache();
      failuresRef.current = 0;
      void tick();
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlistenReady = u;
      }
    });

    return () => {
      cancelled = true;
      window.clearInterval(t);
      if (unlistenReady) unlistenReady();
    };
    // Setup-once. The closure captures only refs (health.ok,
    // status.ready, isVisible) so it always reads the latest value
    // without needing a re-mount on each flip.
  }, []);

  // Manual retry — bypasses the URL cache, resets the failure
  // counter, and triggers an immediate poll so the user can recover
  // from the offline UI without waiting for the next interval tick.
  const retryHealth = useCallback(() => {
    invalidateBrowserBaseCache();
    failuresRef.current = 0;
    setHealth(null);
    checkRef.current();
  }, []);

  // Auto-navigate to the initial URL once health flips ok.
  useEffect(() => {
    if (health?.ok && initialUrl && !status?.url) {
      void browser.navigate(initialUrl);
    }
  }, [health?.ok, initialUrl, status?.url]);

  // Esc to close — overlay mode only. In embedded (in-pane) mode the
  // PaneFrame's × is the canonical way to close, and a global Esc would
  // collide with the user pressing Esc inside the pane for other reasons.
  useEffect(() => {
    if (embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !focused) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, embedded, focused]);

  const handleNavigate = useCallback(async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const target = resolveTarget(trimmed);
    setNavError(null);
    setNavPending(true);
    const result = await browser.navigate(target);
    if (!result.ok) {
      setNavPending(false);
      // Show the daemon's actual error string. Previously this was a
      // generic "Could not reach the browser daemon" regardless of
      // cause; now the user sees the real chromiumoxide / ensure_chrome
      // / fetch error, which is actionable.
      setNavError(result.error);
      return;
    }
    setUrlInput(target);
    // Kick a status fetch immediately so the Frame transitions out of
    // the empty state without waiting for the next 1.5s tick. The
    // regular interval still drives ongoing updates — this is just to
    // close the gap between "Enter pressed" and "first screenshot".
    const fresh = await browser.status();
    if (fresh) setStatus(fresh);
    setNavPending(false);
  }, []);

  const handleRestart = useCallback(async () => {
    setNavError(null);
    setStatus(null);
    setScreenshotUrl(null);
    setNavPending(true);
    await browser.restart();
    // The daemon will lazy-spawn a fresh Chrome on the next request.
    // Kick a status read so the frame's "loading…" state clears once
    // the new session is sitting at about:blank (or the user can
    // navigate again from the URL bar).
    setNavPending(false);
  }, []);

  const handleClick = useCallback(async (e: React.MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    const rect = img.getBoundingClientRect();
    const xRatio = img.naturalWidth / rect.width;
    const yRatio = img.naturalHeight / rect.height;
    const x = (e.clientX - rect.left) * xRatio;
    const y = (e.clientY - rect.top) * yRatio;
    setFocused(true);
    focusTrap.current?.focus();
    await browser.click(x, y);
  }, []);

  // Map browser keypresses inside the focus trap to /key (named keys)
  // or /type (printable text). The hidden textarea catches the events;
  // we preventDefault to keep its DOM contents empty.
  const handleKey = useCallback(async (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!focused) return;
    if (e.key === "Escape") {
      setFocused(false);
      focusTrap.current?.blur();
      e.preventDefault();
      return;
    }
    e.preventDefault();
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      await browser.type(e.key);
    } else {
      await browser.key(e.key);
    }
  }, [focused]);

  const overlayStyle = {
    position: "absolute" as const,
    top: 0,
    right: 0,
    bottom: 0,
    width: "min(640px, 55vw)",
    backgroundColor: "var(--surface-1)",
    borderLeft: "var(--border-1)",
    boxShadow: "var(--shadow-popover)",
    zIndex: "var(--z-modal)",
    display: "flex",
    flexDirection: "column" as const,
  };
  const embeddedStyle = {
    position: "relative" as const,
    height: "100%",
    width: "100%",
    backgroundColor: "var(--surface-0)",
    display: "flex",
    flexDirection: "column" as const,
  };

  return (
    <motion.aside
      variants={embedded ? undefined : connectionsViewVariants}
      initial={embedded ? false : "hidden"}
      animate="visible"
      exit="exit"
      style={embedded ? embeddedStyle : overlayStyle}
    >
      <UrlBar
        urlInput={urlInput}
        onUrlChange={setUrlInput}
        onNavigate={handleNavigate}
        onBack={() => void browser.back()}
        onForward={() => void browser.forward()}
        onReload={() => void browser.reload()}
        onOpen={() => void browser.openInBrowser()}
        onRestart={handleRestart}
        onClose={onClose}
        embedded={embedded}
        status={status}
        health={health}
      />

      {!health && <Empty label="starting browser daemon…" />}
      {health && !health.ok && (
        <DaemonOffline error={health.error} onRetry={retryHealth} />
      )}
      {health?.ok && (
        <>
          {navError && <NavErrorBanner message={navError} onDismiss={() => setNavError(null)} />}
          <Frame
            status={status}
            screenshotUrl={screenshotUrl}
            imgRef={imgRef}
            focused={focused}
            navPending={navPending}
            onClick={handleClick}
            onBlur={() => setFocused(false)}
          />
          <textarea
            ref={focusTrap}
            value=""
            onChange={() => {}}
            onKeyDown={handleKey}
            onBlur={() => setFocused(false)}
            tabIndex={-1}
            aria-hidden
            style={{
              position: "absolute",
              left: -9999,
              top: -9999,
              width: 1,
              height: 1,
              opacity: 0,
              pointerEvents: "none",
            }}
          />
          <ConsoleResizeHandle
            height={consoleHeight}
            onChange={(h) => {
              const clamped = clampConsoleHeight(h);
              setConsoleHeight(clamped);
              try {
                window.localStorage.setItem(
                  CONSOLE_HEIGHT_STORAGE_KEY,
                  String(clamped),
                );
              } catch {
                /* localStorage can fail under storage pressure; not fatal. */
              }
            }}
          />
          <ConsoleTail logs={logs} height={consoleHeight} />
        </>
      )}
    </motion.aside>
  );
}

/**
 * Thin draggable strip pinned just above the console. Drag up to grow
 * the console (shrinks the screenshot frame), drag down to shrink it.
 * The hit zone is 6px tall but the visible center line is 1px so the
 * chrome stays calm; we tint the line on hover/drag to indicate the
 * affordance is alive.
 */
function ConsoleResizeHandle({
  height,
  onChange,
}: {
  height: number;
  onChange: (next: number) => void;
}) {
  const startYRef = useRef(0);
  const startHRef = useRef(0);
  const draggingRef = useRef(false);
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      startYRef.current = e.clientY;
      startHRef.current = height;
      setActive(true);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [height],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      // Drag UP (negative dy) → console grows. The console sits at
      // the bottom of the pane, so its height increases as the
      // pointer moves up. Caller clamps to the min/max bounds.
      const dy = e.clientY - startYRef.current;
      onChange(startHRef.current - dy);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setActive(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onChange]);

  const lit = hover || active;
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize console"
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flexShrink: 0,
        // 6px hit zone, with a 1px hairline centered inside it.
        height: 6,
        marginTop: -3,
        marginBottom: -3,
        position: "relative",
        cursor: "row-resize",
        zIndex: 5,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 2,
          height: 1,
          backgroundColor: lit ? "var(--accent)" : "transparent",
          transition:
            "background-color var(--motion-fast) var(--ease-out-quart)",
        }}
      />
    </div>
  );
}

function UrlBar({
  urlInput,
  onUrlChange,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onOpen,
  onRestart,
  onClose,
  embedded,
  status,
  health,
}: {
  urlInput: string;
  onUrlChange: (v: string) => void;
  onNavigate: (v: string) => Promise<void>;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onOpen: () => void;
  onRestart: () => void;
  onClose: () => void;
  embedded?: boolean;
  status: BrowserStatus | null;
  health: BrowserHealth | null;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div
      style={{
        height: 32,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: "var(--space-1)",
        padding: "0 var(--space-2)",
        borderBottom: "var(--border-1)",
        backgroundColor: "var(--surface-1)",
      }}
    >
      <NavBtn label="◀" onClick={onBack} disabled={!health?.ok} title="back" />
      <NavBtn label="▶" onClick={onForward} disabled={!health?.ok} title="forward" />
      <NavBtn label="↻" onClick={onReload} disabled={!status?.ready} title="reload" />

      <Dot
        color={
          health?.ok
            ? status?.ready
              ? "var(--state-success)"
              : "var(--text-tertiary)"
            : "var(--state-error)"
        }
      />

      <input
        ref={inputRef}
        type="text"
        value={urlInput}
        onChange={(e) => onUrlChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void onNavigate(urlInput);
          }
        }}
        placeholder={
          status?.url ??
          `URL, ${COMMON_DEV_PORTS[0]}, or search query — press Enter`
        }
        spellCheck={false}
        style={{
          flex: 1,
          minWidth: 0,
          height: 22,
          padding: "0 var(--space-2)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
          color: "var(--text-primary)",
          backgroundColor: "var(--surface-0)",
          border: "var(--border-1)",
          borderRadius: "var(--radius-sm)",
          outline: "none",
        }}
      />

      <PortQuickList
        ports={COMMON_DEV_PORTS}
        onPick={(p) => {
          const url = `http://localhost:${p}/`;
          onUrlChange(url);
          void onNavigate(url);
        }}
      />

      {health?.ok && (
        <NavBtn
          label="⟳"
          onClick={onRestart}
          title="restart browser session (kills the headless Chrome process)"
        />
      )}
      {health?.ok && (
        <NavBtn label="↗" onClick={onOpen} title="open in real browser" />
      )}
      {!embedded && (
        <NavBtn label="×" onClick={onClose} title="close (esc)" />
      )}
    </div>
  );
}

function NavBtn({
  label,
  onClick,
  title,
  disabled,
}: {
  label: string;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        width: 22,
        height: 22,
        display: "grid",
        placeItems: "center",
        backgroundColor: "transparent",
        color: disabled ? "var(--text-tertiary)" : "var(--text-secondary)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        border: "none",
        borderRadius: "var(--radius-sm)",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

function PortQuickList({
  ports,
  onPick,
}: {
  ports: readonly number[];
  onPick: (p: number) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 2 }}>
      {ports.slice(0, 3).map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onPick(p)}
          title={`localhost:${p}`}
          style={{
            height: 22,
            padding: "0 var(--space-1)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
            backgroundColor: "transparent",
            border: "var(--border-1)",
            borderRadius: "var(--radius-sm)",
            cursor: "pointer",
          }}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

/**
 * Inline error banner that drops in between the URL bar and the Frame
 * when `browser.navigate` fails. Previously the failure was swallowed
 * and the user saw a stale empty state with no signal that anything
 * went wrong — easy to misread as "the in-app browser doesn't work,
 * I'll just open Chrome instead." Now they get a one-line "couldn't
 * reach daemon" with a dismiss button.
 */
function NavErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "6px var(--space-3)",
        backgroundColor: "var(--surface-error-soft)",
        borderBottom: "1px solid color-mix(in oklch, var(--state-error), transparent 70%)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        color: "var(--text-primary)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "var(--radius-pill)",
          backgroundColor: "var(--state-error-bright)",
          flexShrink: 0,
        }}
      />
      <span style={{ flex: 1, minWidth: 0 }}>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        title="Dismiss"
        aria-label="Dismiss"
        style={{
          height: 18,
          padding: "0 6px",
          backgroundColor: "transparent",
          color: "var(--text-tertiary)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
          borderRadius: "var(--radius-xs)",
          cursor: "pointer",
        }}
      >
        ×
      </button>
    </div>
  );
}

function Frame({
  status,
  screenshotUrl,
  imgRef,
  focused,
  navPending,
  onClick,
  onBlur,
}: {
  status: BrowserStatus | null;
  screenshotUrl: string | null;
  imgRef: React.MutableRefObject<HTMLImageElement | null>;
  focused: boolean;
  navPending: boolean;
  onClick: (e: React.MouseEvent<HTMLImageElement>) => void;
  onBlur: () => void;
}) {
  if (!status?.ready || !screenshotUrl) {
    return (
      <Empty
        label={
          navPending
            ? "loading…"
            : "ready · type a URL or search above"
        }
      />
    );
  }
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        backgroundColor: "var(--surface-0)",
        display: "grid",
        placeItems: "center",
        overflow: "hidden",
        position: "relative",
        outline: focused ? "2px solid var(--accent-1)" : "2px solid transparent",
        outlineOffset: -2,
      }}
      onClick={() => onBlur()}
    >
      <img
        ref={imgRef}
        src={screenshotUrl}
        alt={status.title ?? "browser preview"}
        draggable={false}
        onClick={(e) => {
          e.stopPropagation();
          void onClick(e);
        }}
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
          cursor: "crosshair",
          WebkitUserDrag: "none",
        } as React.CSSProperties}
      />
    </div>
  );
}

type LogLevel = BrowserLogEntry["level"];
type LogFilter = "all" | "errors" | "warnings";

// Per-level visual presentation. `tag` is what reads in the row's
// pill column (4 chars wide so the column aligns regardless of which
// level a line is); `tone` colors the pill and tint rail; `bg` is
// the row's faint background tint.
const LEVEL_PRESENTATION: Record<
  LogLevel,
  { tag: string; tone: string; bg: string }
> = {
  error: {
    tag: "ERR",
    tone: "var(--state-error-bright)",
    bg: "var(--surface-error-soft)",
  },
  warn: {
    tag: "WARN",
    tone: "var(--state-warning-bright)",
    bg: "var(--surface-warning-soft)",
  },
  info: {
    tag: "INFO",
    tone: "var(--state-info)",
    bg: "transparent",
  },
  log: {
    tag: "LOG",
    tone: "var(--text-secondary)",
    bg: "transparent",
  },
  debug: {
    tag: "DBG",
    tone: "var(--text-tertiary)",
    bg: "transparent",
  },
};

function ConsoleTail({
  logs,
  height,
}: {
  logs: BrowserLogEntry[];
  height: number;
}) {
  const [filter, setFilter] = useState<LogFilter>("all");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Stick-to-bottom: only auto-scroll when the user is already near
  // the bottom. If they've scrolled up to read something, leave them
  // there — otherwise rapid log activity would yank the viewport
  // around mid-read.
  const stickRef = useRef(true);

  const counts = useMemo(() => {
    let err = 0;
    let warn = 0;
    for (const e of logs) {
      if (e.level === "error") err++;
      else if (e.level === "warn") warn++;
    }
    return { err, warn, total: logs.length };
  }, [logs]);

  const filtered = useMemo(() => {
    if (filter === "all") return logs;
    if (filter === "errors") return logs.filter((e) => e.level === "error");
    return logs.filter((e) => e.level === "warn" || e.level === "error");
  }, [logs, filter]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [filtered]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const slop = 12;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < slop;
  };

  return (
    <div
      style={{
        height,
        flexShrink: 0,
        backgroundColor: "var(--surface-1)",
        borderTop: "var(--border-1)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <ConsoleHeader
        counts={counts}
        filter={filter}
        onFilter={setFilter}
      />
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          lineHeight: 1.5,
        }}
      >
        {filtered.length === 0 ? (
          <Empty
            label={
              logs.length === 0
                ? "No console output yet — interact with the page above."
                : `No ${filter === "errors" ? "errors" : "errors or warnings"} in the last ${logs.length} entries.`
            }
            small
          />
        ) : (
          filtered.map((entry, i) => (
            <LogRow key={`${entry.ts}-${i}`} entry={entry} />
          ))
        )}
      </div>
    </div>
  );
}

function ConsoleHeader({
  counts,
  filter,
  onFilter,
}: {
  counts: { err: number; warn: number; total: number };
  filter: LogFilter;
  onFilter: (f: LogFilter) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        height: 26,
        flexShrink: 0,
        padding: "0 var(--space-2) 0 var(--space-3)",
        borderBottom: "var(--border-1)",
        backgroundColor: "var(--surface-1)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-caps)",
          textTransform: "uppercase",
          color: "var(--text-tertiary)",
        }}
      >
        Console
      </span>
      <span
        className="tabular"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
          color: "var(--text-tertiary)",
        }}
      >
        {counts.total}
      </span>

      <span style={{ flex: 1 }} />

      <LevelCount
        tone="var(--state-error-bright)"
        count={counts.err}
        title={`${counts.err} error${counts.err === 1 ? "" : "s"}`}
      />
      <LevelCount
        tone="var(--state-warning-bright)"
        count={counts.warn}
        title={`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`}
      />

      <span
        aria-hidden
        style={{
          width: 1,
          height: 14,
          backgroundColor: "var(--border-default)",
          margin: "0 var(--space-1)",
        }}
      />

      <FilterPill
        active={filter === "all"}
        onClick={() => onFilter("all")}
        label="All"
      />
      <FilterPill
        active={filter === "errors"}
        onClick={() => onFilter("errors")}
        label="Errors"
      />
      <FilterPill
        active={filter === "warnings"}
        onClick={() => onFilter("warnings")}
        label="Warn+"
      />
    </div>
  );
}

function LevelCount({
  tone,
  count,
  title,
}: {
  tone: string;
  count: number;
  title: string;
}) {
  const dim = count === 0;
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        opacity: dim ? 0.4 : 1,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: "var(--radius-pill)",
          backgroundColor: tone,
          flexShrink: 0,
        }}
      />
      <span
        className="tabular"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
          color: dim ? "var(--text-tertiary)" : "var(--text-secondary)",
          minWidth: 12,
          textAlign: "right",
        }}
      >
        {count}
      </span>
    </span>
  );
}

function FilterPill({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 18,
        padding: "0 8px",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--weight-medium)",
        color: active ? "var(--text-primary)" : "var(--text-tertiary)",
        backgroundColor: active ? "var(--surface-3)" : "transparent",
        border: "none",
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)," +
          "color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.color = "var(--text-secondary)";
          e.currentTarget.style.backgroundColor = "var(--surface-2)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.color = "var(--text-tertiary)";
          e.currentTarget.style.backgroundColor = "transparent";
        }
      }}
    >
      {label}
    </button>
  );
}

function LogRow({ entry }: { entry: BrowserLogEntry }) {
  const pres = LEVEL_PRESENTATION[entry.level] ?? LEVEL_PRESENTATION.log;
  const time = formatLogTime(entry.ts);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "3px 38px 56px 1fr",
        gap: "var(--space-2)",
        padding: "4px var(--space-3) 4px 0",
        backgroundColor: pres.bg,
        borderTop: "1px solid color-mix(in oklch, var(--surface-1), transparent 90%)",
      }}
    >
      {/* Tint rail — colors the row's left edge with the level tone.
          Reads as gradient ribbon when stacked, error rows visually
          cluster together. */}
      <span
        aria-hidden
        style={{
          backgroundColor:
            entry.level === "error" || entry.level === "warn"
              ? pres.tone
              : "transparent",
        }}
      />
      {/* Level pill — fixed 38px column keeps the timestamp + text
          aligned across every row regardless of which level fired. */}
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-caps)",
          color: pres.tone,
          alignSelf: "start",
          paddingTop: 1,
        }}
      >
        {pres.tag}
      </span>
      <span
        className="tabular"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--text-tertiary)",
          alignSelf: "start",
          paddingTop: 1,
        }}
      >
        {time}
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color:
            entry.level === "error"
              ? "var(--text-primary)"
              : entry.level === "warn"
                ? "var(--text-primary)"
                : "var(--text-secondary)",
          fontVariantLigatures: "none",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          minWidth: 0,
        }}
      >
        {entry.text}
      </span>
    </div>
  );
}

function formatLogTime(ts: number): string {
  if (!ts || !Number.isFinite(ts)) return "--:--:--";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function Dot({ color }: { color: string }) {
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: "var(--radius-pill)",
        backgroundColor: color,
        flexShrink: 0,
      }}
    />
  );
}

function Empty({ label, small = false }: { label: string; small?: boolean }) {
  return (
    <div
      style={{
        flex: 1,
        display: "grid",
        placeItems: "center",
        padding: "var(--space-6) var(--space-4)",
        textAlign: "center",
        color: "var(--text-tertiary)",
        fontSize: small ? "var(--text-xs)" : "var(--text-sm)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {label}
    </div>
  );
}

function DaemonOffline({
  error,
  onRetry,
}: {
  error?: string;
  onRetry: () => void;
}) {
  return (
    <div
      style={{
        flex: 1,
        display: "grid",
        placeItems: "center",
        padding: "var(--space-8) var(--space-6)",
      }}
    >
      <div
        style={{
          maxWidth: 380,
          textAlign: "center",
          display: "grid",
          gap: "var(--space-3)",
          fontFamily: "var(--font-sans)",
        }}
      >
        <div
          style={{
            fontSize: "var(--text-md)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--text-primary)",
          }}
        >
          browser daemon unreachable
        </div>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--text-secondary)",
            lineHeight: "var(--leading-sm)",
          }}
        >
          The daemon hasn't responded to a health check after multiple
          attempts. It may still be starting up, or another process
          may be holding its preferred port range.
        </div>
        <button
          type="button"
          onClick={onRetry}
          style={{
            justifySelf: "center",
            padding: "6px 14px",
            backgroundColor: "var(--surface-3)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-sm)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-xs)",
            fontWeight: "var(--weight-medium)",
            cursor: "pointer",
          }}
        >
          Retry
        </button>
        {error && (
          <div
            style={{
              fontSize: "var(--text-2xs)",
              fontFamily: "var(--font-mono)",
              color: "var(--text-tertiary)",
              wordBreak: "break-all",
            }}
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
