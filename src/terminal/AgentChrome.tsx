import { useAgentSessionForCwd } from "@/state/agentActivityStore";
import type { SessionRecord } from "@/state/agentActivityStore";

interface Props {
  /**
   * Pane's live cwd. AgentChrome resolves this to a SessionRecord via
   * the same prefix-match logic the worktree spinner uses, so an
   * agent that cd'd into a subdirectory still lights this chrome.
   */
  cwd?: string;
  /**
   * CLI detected from the pane's command line, shown while no hook
   * session exists yet (the window between launching the agent and
   * its first SessionStart event). Keeping the strip mounted during
   * that window keeps its 32px height invariant for the whole
   * agent-mode lifetime — the PTY-dimension reserve in BlockTerminal
   * never has to reflow when the first event lands. `null` renders a
   * generic "agent" badge (aider and friends have no hook system).
   */
  pendingCli?: SessionRecord["provider"] | null;
}

/**
 * Pinned strip height in CSS pixels. MUST stay in sync with the
 * `agentChromeHeight` constant in BlockTerminal.tsx — that file's
 * PTY-dimension calc reserves this exact number, and any drift between
 * the two reserves either an empty stripe under the canvas or sends
 * the canvas under the chrome.
 *
 * The strip is rendered as a fixed-height box (height + boxSizing:
 * border-box) so its rendered height is INVARIANT across status
 * transitions. Earlier versions sized to content — the "permission
 * requested" pill (12px SVG + semibold text) made the strip a few
 * pixels taller than the working/idle states, which fired
 * CanvasGrid's inner ResizeObserver, reconfigured the WebGPU
 * swapchain mid-frame, and produced the "agent pane goes blank when
 * Claude asks for permission" symptom. Pinning the height prevents
 * the layout shift at its source.
 */
export const AGENT_CHROME_HEIGHT_PX = 32;

/**
 * Warp-style status strip rendered above the agent's TUI / live block.
 * Reads the hook-driven SessionRecord for this pane's cwd and surfaces:
 *
 *   - Provider badge (claude / codex / gemini) — first-class identity.
 *   - Status indicator + label (spinner while working, ⏸ when idle,
 *     ⚠ when waiting on permission, ⏵ during compaction).
 *   - Active tool name when the agent is mid-turn — "Claude is using
 *     Read". We don't yet have the tool input payload, so we stop at
 *     the tool name; a Phase-3-polish hook envelope enrichment can
 *     promote this to "Claude is reading foo.ts" without changing the
 *     component contract.
 *
 * Renders nothing when there's no matching session — so a plain shell
 * pane (or an agent the user has just launched but hasn't fired its
 * first hook from) sees zero visual overhead.
 *
 * Visual reference: Warp's `use_agent_footer` panel
 * (/tmp/warp-check/app/src/terminal/view/use_agent_footer/mod.rs).
 */
export function AgentChrome({ cwd, pendingCli }: Props) {
  const session = useAgentSessionForCwd(cwd ?? "");
  if (!session || session.status === "ended") {
    // No hook session (yet). When the caller told us which agent is
    // launching, hold the strip's slot with a quiet "starting" state
    // instead of unmounting — see the pendingCli prop doc.
    return <PendingStrip cli={pendingCli ?? null} />;
  }

  return (
    <StripShell>
      <ProviderBadge provider={session.provider} />
      <StatusGlyph status={session.status} />
      <StatusLabel session={session} />
      {session.status === "waiting" && (
        <span
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            color: "var(--state-warning)",
            fontWeight: "var(--weight-semibold)",
          }}
        >
          <WarnIcon />
          permission requested
        </span>
      )}
    </StripShell>
  );
}

/**
 * Shared 32px strip shell. BOTH the live and pending states render
 * through this so the pinned-height contract lives in exactly one
 * place and can't drift between them.
 */
function StripShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        // Pinned height — see AGENT_CHROME_HEIGHT_PX above for why
        // this MUST NOT be content-sized. boxSizing:border-box so the
        // 1px borderBottom is counted inside the 32px box (otherwise
        // the box becomes 33px and BlockTerminal's reserve drifts).
        height: AGENT_CHROME_HEIGHT_PX,
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "0 var(--space-3)",
        borderBottom: "var(--border-1)",
        backgroundColor: "var(--surface-1)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        color: "var(--text-secondary)",
        letterSpacing: "var(--tracking-tight)",
        userSelect: "none",
        flexShrink: 0,
        // Hide any sub-pixel overshoot from a heavier child (e.g. the
        // semibold "permission requested" pill at certain font hinting
        // / DPR combos). Without this the inner row can push the
        // visible box past 32px even with a fixed height set on the
        // outer — the overflow itself doesn't change the box's height
        // but layout calc inside flex parents can still observe it.
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

/**
 * Pre-session state: the agent was just launched and hasn't fired its
 * first hook yet (or has no hook system at all — aider). Occupies the
 * same 32px slot so the PTY grid below never reflows when the real
 * session record arrives.
 */
function PendingStrip({ cli }: { cli: SessionRecord["provider"] | null }) {
  return (
    <StripShell>
      {cli ? (
        <ProviderBadge provider={cli} />
      ) : (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: "1px 6px",
            borderRadius: 4,
            backgroundColor: "var(--surface-2)",
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--weight-semibold)",
          }}
        >
          agent
        </span>
      )}
      <span style={{ color: "var(--text-tertiary)" }}>starting…</span>
    </StripShell>
  );
}

/** Single source of truth for provider display. Exhaustive switch so
    a future provider added to the union surfaces a TS error here
    instead of silently falling through to the wrong color. */
function providerDisplay(provider: SessionRecord["provider"]): {
  label: string;
  accent: string;
} {
  switch (provider) {
    case "claude":
      return { label: "Claude", accent: "var(--state-warning)" };
    case "codex":
      return { label: "Codex", accent: "var(--state-info)" };
    case "gemini":
      return { label: "Gemini", accent: "var(--accent-bright)" };
  }
}

function ProviderBadge({ provider }: { provider: SessionRecord["provider"] }) {
  const { label, accent } = providerDisplay(provider);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 6px",
        borderRadius: 4,
        backgroundColor: "var(--surface-2)",
        color: accent,
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--weight-semibold)",
      }}
    >
      {label}
    </span>
  );
}

function StatusGlyph({ status }: { status: SessionRecord["status"] }) {
  // Spinner during active work; static glyph otherwise. Driven by
  // pure CSS (motion.css owns the keyframes); no JS interval.
  switch (status) {
    case "working":
    case "compacting":
      return (
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            borderRadius: "50%",
            border: "1.5px solid currentColor",
            borderRightColor: "transparent",
            animation: "goonware-spin 600ms linear infinite",
            flexShrink: 0,
          }}
        />
      );
    case "waiting":
      return (
        <span aria-hidden style={{ color: "var(--state-warning)" }}>
          ⏸
        </span>
      );
    case "idle":
    case "ended":
      return (
        <span aria-hidden style={{ color: "var(--text-tertiary)" }}>
          ✓
        </span>
      );
  }
}

function StatusLabel({ session }: { session: SessionRecord }) {
  const { label: providerName } = providerDisplay(session.provider);
  switch (session.status) {
    case "compacting":
      return <span>{providerName} is compacting context</span>;
    case "working":
      if (session.last_tool && session.last_tool.length > 0) {
        return (
          <span>
            {providerName} is using{" "}
            <span
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--text-primary)",
              }}
            >
              {session.last_tool}
            </span>
          </span>
        );
      }
      return <span>{providerName} is working</span>;
    case "waiting":
      return <span>{providerName} is waiting</span>;
    case "idle":
    case "ended":
      return <span>{providerName} is idle</span>;
  }
}

function WarnIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 2.5 1.5 13.5h13L8 2.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M8 6.5v3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8" cy="12" r="0.7" fill="currentColor" />
    </svg>
  );
}
