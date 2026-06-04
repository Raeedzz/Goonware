import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Update } from "@tauri-apps/plugin-updater";
import {
  DownloadSimpleIcon,
  XIcon,
  CircleNotchIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import {
  checkForUpdate,
  downloadAndInstall,
  relaunchApp,
  type UpdaterPhase,
} from "@/lib/updater";

/**
 * Bottom-left single-line update strip.
 *
 *   1. Boot → silent check; hidden if up-to-date.
 *   2. New version → "Update to v0.4.2 · Install".
 *   3. Click Install → version + percent in the row, 2px progress fill on the bottom edge.
 *   4. Download done → ~800ms "Restarting…" beat, then relaunch automatically.
 *   5. × dismisses for this session; the periodic re-check resurfaces it later.
 *
 * Release notes don't fit on one line and live on the GitHub release page —
 * the user can read them there if they care, or just trust the patch.
 */

const RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 5 * 1000;
const AUTO_RESTART_DELAY_MS = 800;
const TOAST_WIDTH = 340;

export function UpdaterToast() {
  const [phase, setPhase] = useState<UpdaterPhase>({ kind: "idle" });
  const [dismissed, setDismissed] = useState(false);
  const updateRef = useRef<Update | null>(null);

  const runCheck = useCallback(async () => {
    if (phase.kind !== "idle") return;
    setPhase({ kind: "checking" });
    try {
      const update = await checkForUpdate();
      if (!update) {
        setPhase({ kind: "idle" });
        return;
      }
      updateRef.current = update;
      setPhase({
        kind: "available",
        version: update.version,
        notes: update.body ?? undefined,
      });
      setDismissed(false);
    } catch (err) {
      setPhase({ kind: "idle" });
      // eslint-disable-next-line no-console
      console.warn("[updater] check failed", err);
    }
  }, [phase.kind]);

  useEffect(() => {
    const t = window.setTimeout(() => void runCheck(), STARTUP_DELAY_MS);
    const i = window.setInterval(() => void runCheck(), RECHECK_INTERVAL_MS);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(i);
    };
  }, [runCheck]);

  const onInstall = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    setPhase({
      kind: "downloading",
      version: update.version,
      downloaded: 0,
      total: null,
    });
    try {
      await downloadAndInstall(update, (downloaded, total) => {
        setPhase({
          kind: "downloading",
          version: update.version,
          downloaded,
          total,
        });
      });
      setPhase({ kind: "ready", version: update.version });
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  // Auto-restart once the download finishes. Brief beat so the user
  // reads "Restarting…" before the process is yanked out from under them.
  useEffect(() => {
    if (phase.kind !== "ready") return;
    const t = window.setTimeout(async () => {
      setPhase({ kind: "applying" });
      try {
        await relaunchApp();
      } catch (err) {
        setPhase({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }, AUTO_RESTART_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [phase.kind]);

  const visible =
    !dismissed &&
    (phase.kind === "available" ||
      phase.kind === "downloading" ||
      phase.kind === "ready" ||
      phase.kind === "applying" ||
      phase.kind === "error");

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="updater-toast"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4, transition: { duration: 0.14 } }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            left: 16,
            bottom: 16,
            width: TOAST_WIDTH,
            height: 32,
            zIndex: "var(--z-toast)" as unknown as number,
            backgroundColor: "var(--surface-2)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-md)",
            boxShadow:
              "0 8px 24px oklch(0% 0 0 / 0.40), 0 1px 2px oklch(0% 0 0 / 0.35)",
            paddingLeft: 10,
            paddingRight: 4,
            fontFamily: "var(--font-sans)",
            color: "var(--text-primary)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            overflow: "hidden",
          }}
        >
          <PhaseIcon phase={phase} />
          <Label phase={phase} />
          <Actions
            phase={phase}
            onInstall={onInstall}
            onDismiss={() => setDismissed(true)}
          />
          <ProgressStrip phase={phase} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function PhaseIcon({ phase }: { phase: UpdaterPhase }) {
  if (phase.kind === "error") {
    return (
      <WarningCircleIcon
        size={13}
        style={{ color: "var(--state-error)", flexShrink: 0 }}
      />
    );
  }
  if (phase.kind === "applying") {
    return (
      <motion.span
        aria-hidden
        style={{
          display: "inline-flex",
          color: "var(--accent)",
          flexShrink: 0,
        }}
        animate={{ rotate: 360 }}
        transition={{ duration: 1.1, ease: "linear", repeat: Infinity }}
      >
        <CircleNotchIcon size={13} />
      </motion.span>
    );
  }
  return (
    <DownloadSimpleIcon
      size={13}
      style={{ color: "var(--accent)", flexShrink: 0 }}
    />
  );
}

function Label({ phase }: { phase: UpdaterPhase }) {
  const text = (() => {
    switch (phase.kind) {
      case "available":
        return (
          <>
            Update to <Mono>v{phase.version}</Mono>
          </>
        );
      case "downloading": {
        const pct =
          phase.total && phase.total > 0
            ? Math.min(100, Math.round((phase.downloaded / phase.total) * 100))
            : null;
        return (
          <>
            Updating <Mono>v{phase.version}</Mono>
            {pct != null && (
              <>
                <Sep />
                <Mono>{pct}%</Mono>
              </>
            )}
          </>
        );
      }
      case "ready":
      case "applying":
        return <>Restarting…</>;
      case "error":
        return <span style={{ color: "var(--text-secondary)" }}>{phase.message}</span>;
      default:
        return null;
    }
  })();
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        fontSize: "var(--text-xs)",
        letterSpacing: "var(--tracking-tight)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {text}
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        color: "var(--text-secondary)",
      }}
    >
      {children}
    </span>
  );
}

function Sep() {
  return (
    <span
      aria-hidden
      style={{ color: "var(--text-tertiary)", margin: "0 6px" }}
    >
      ·
    </span>
  );
}

function Actions({
  phase,
  onInstall,
  onDismiss,
}: {
  phase: UpdaterPhase;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  const showInstall = phase.kind === "available";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        flexShrink: 0,
      }}
    >
      {showInstall && <PrimaryButton onClick={onInstall}>Install</PrimaryButton>}
      {phase.kind !== "applying" && (
        <DismissButton onClick={onDismiss} />
      )}
    </div>
  );
}

function PrimaryButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 22,
        padding: "0 10px",
        marginRight: 2,
        borderRadius: "var(--radius-sm)",
        backgroundColor: "var(--accent)",
        color: "var(--text-inverse)",
        border: "none",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-xs)",
        fontWeight: "var(--weight-semibold)",
        letterSpacing: "var(--tracking-tight)",
        cursor: "pointer",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "var(--accent-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "var(--accent)";
      }}
    >
      {children}
    </button>
  );
}

function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      title="Dismiss"
      onClick={onClick}
      style={{
        width: 22,
        height: 22,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "var(--radius-sm)",
        backgroundColor: "transparent",
        color: "var(--text-tertiary)",
        border: "none",
        cursor: "pointer",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)," +
          "color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "var(--surface-3)";
        e.currentTarget.style.color = "var(--text-primary)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "transparent";
        e.currentTarget.style.color = "var(--text-tertiary)";
      }}
    >
      <XIcon size={11} />
    </button>
  );
}

function ProgressStrip({ phase }: { phase: UpdaterPhase }) {
  // Sits along the bottom edge of the toast. Determinate fill when the
  // server told us the content length; otherwise a sliding indeterminate
  // bar so the user knows something is happening.
  const visible = phase.kind === "downloading" || phase.kind === "applying";
  if (!visible) return null;

  const pct =
    phase.kind === "downloading" && phase.total && phase.total > 0
      ? Math.min(100, (phase.downloaded / phase.total) * 100)
      : null;

  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: 2,
        backgroundColor: "var(--surface-3)",
        overflow: "hidden",
      }}
    >
      {pct != null ? (
        <motion.div
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            backgroundColor: "var(--accent)",
          }}
        />
      ) : (
        <motion.div
          initial={{ left: "-40%" }}
          animate={{ left: "100%" }}
          transition={{ duration: 1.2, ease: "linear", repeat: Infinity }}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            width: "40%",
            backgroundColor: "var(--accent)",
          }}
        />
      )}
    </div>
  );
}
