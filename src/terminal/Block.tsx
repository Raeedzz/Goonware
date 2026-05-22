import { useCallback, useMemo, type CSSProperties } from "react";
import { CellRow } from "./CellRow";
import { computeClosedBlockLines, isAgentInput } from "./blockLogic";
import { formatCwd, formatDuration } from "./formatBlockMeta";
import {
  BLOCK_COMMAND_TOP_PX,
  BLOCK_FAILED_STRIPE_WIDTH_PX,
  BLOCK_FAILED_TINT_ALPHA,
  BLOCK_MIDDLE_GAP_PX,
  BLOCK_PADDING_BOTTOM_PX,
  BLOCK_PADDING_TOP_PX,
} from "./blockStyles";
import type { Block as BlockType } from "./types";

interface Props {
  block: BlockType;
  /**
   * Disable soft-wrap on shell output rows. Used by the narrow
   * right-panel secondary terminal so long lines pan via horizontal
   * scroll instead of wrapping. Agent blocks already render no-wrap.
   */
  noWrap?: boolean;
  /**
   * Phase 4 — block interaction parity. The parent (BlockList) wires
   * these so the user can lift past commands back into the prompt,
   * re-run, or share. Copy is handled in-component because it needs
   * no parent context. All optional so the component still renders
   * standalone in tests / Storybook.
   */
  onClickInput?: (command: string) => void;
  onRerun?: (command: string) => void;
  onShare?: (block: BlockType) => void;
}

/**
 * One closed command block, Warp-style.
 *
 *   Top:    cwd + duration, small dim (e.g. "~ (0.046s)")
 *   Middle: the typed command in primary text, bold
 *   Bottom: the command's output, ANSI-parsed so colors from
 *           `git diff`, `cargo`, `rg`, etc. carry through
 *
 * Failed commands (nonzero exit) get the Warp "flag pole" treatment —
 * a solid colored stripe down the left edge plus a 10% tint over the
 * whole body. See blockStyles.ts for the calibrated values.
 *
 * We skip the transcript's first line in the body because the
 * segmenter captures *everything* between OSC 133 A and D — including
 * zsh's echo of the user's typed command. That echo would show up as a
 * duplicate of the bold command line we render above. We skip line 0
 * only when block.input is populated (the typical sendLine flow);
 * blocks with empty input keep the full transcript so we don't drop
 * content.
 */
export function Block({
  block,
  noWrap = false,
  onClickInput,
  onRerun,
  onShare,
}: Props) {
  const isAgent = useMemo(() => isAgentInput(block.input), [block.input]);
  const lines = useMemo(
    () => computeClosedBlockLines(block.blockRows, block.transcript, isAgent),
    [block.blockRows, block.transcript, isAgent],
  );
  const bodyLines = useMemo(() => {
    // Skip the first line ONLY when rendering from the legacy
    // parseAnsi path — that path captures zsh's echo of the user's
    // typed command as the first transcript line, which would
    // duplicate the bold command we render in the header. The
    // alacritty-rendered `blockRows` path is layout-correct already;
    // the typed command echo lives in its own row (or gets
    // overwritten by the prompt redraw) and there's nothing to skip.
    const usingBlockRows = block.blockRows && block.blockRows.length > 0;
    if (!usingBlockRows && block.input.length > 0 && lines.length > 0) {
      return lines.slice(1);
    }
    return lines;
  }, [lines, block.blockRows, block.input]);

  // Plain-text join of the body, used by the "copy output" action.
  // bodyLines are already ANSI-stripped Spans, so joining `.text`
  // gives the user what they see — no escape sequences.
  const plainBody = useMemo(
    () =>
      bodyLines
        .map((spans) => spans.map((s) => s.text).join(""))
        .join("\n")
        .trimEnd(),
    [bodyLines],
  );

  const failed = block.exit_code !== null && block.exit_code !== 0;
  const exitBadge = useMemo(() => {
    if (block.exit_code === null) return null;
    if (block.exit_code === 0) return null; // success is the default — show nothing
    return {
      label: `exit ${block.exit_code}`,
      color: "var(--state-error-bright)",
    };
  }, [block.exit_code]);

  const hasBody = bodyLines.some(
    (line) => line.length > 0 && line.some((s) => s.text.length > 0),
  );

  const cwdLabel = formatCwd(block.cwd);
  const durLabel = formatDuration(block.durationMs);

  const handleCopyCommand = useCallback(() => {
    void navigator.clipboard.writeText(block.input).catch(() => {});
  }, [block.input]);

  const handleCopyOutput = useCallback(() => {
    void navigator.clipboard.writeText(plainBody).catch(() => {});
  }, [plainBody]);

  const handleInputClick = useCallback(() => {
    // Don't lift the command if the user is mid-text-selection. The
    // user-facing UX wart: selecting a snippet from the bold command
    // line ends with a mouseup that fires onClick, which would then
    // splice the entire command into the prompt and clobber what
    // they were trying to copy.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    onClickInput?.(block.input);
  }, [onClickInput, block.input]);

  const handleRerun = useCallback(() => {
    onRerun?.(block.input);
  }, [onRerun, block.input]);

  const handleShare = useCallback(() => {
    onShare?.(block);
  }, [onShare, block]);

  const containerStyle: CSSProperties = {
    position: "relative",
    paddingTop: BLOCK_PADDING_TOP_PX,
    paddingBottom: BLOCK_PADDING_BOTTOM_PX,
    paddingLeft: "var(--space-3)",
    paddingRight: "var(--space-3)",
    borderTop: "var(--border-1)",
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    fontVariantLigatures: "none",
    color: "var(--text-primary)",
    userSelect: "text",
  };

  return (
    <div className="goonware-block-card" style={containerStyle}>
      {/* Failed-state "flag pole" — solid colored stripe down the left
          edge of the block. Warp's block_list_element.rs:2410. */}
      {failed && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: BLOCK_FAILED_STRIPE_WIDTH_PX,
            backgroundColor: "var(--state-error-bright)",
            pointerEvents: "none",
          }}
        />
      )}
      {/* Failed-state body tint — 10% of the error color laid over the
          whole block. Layered behind the content so text stays
          readable. Warp's block_list_element.rs:2404. */}
      {failed && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: "var(--state-error)",
            opacity: BLOCK_FAILED_TINT_ALPHA,
            pointerEvents: "none",
          }}
        />
      )}
      <div style={{ position: "relative", zIndex: 1 }}>
        {(cwdLabel || durLabel || exitBadge || isAgent) && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              color: "var(--text-tertiary)",
              fontSize: "var(--text-2xs)",
              marginBottom: 2,
            }}
          >
            {cwdLabel && <span>{cwdLabel}</span>}
            {durLabel && <span>({durLabel})</span>}
            {/* "ENDED" pill: balances LiveBlock's "RUNNING" pill so the
                user can tell stacked blocks apart at a glance. Only on
                clean exits — non-zero exit codes already get their own
                colored badge in this slot. */}
            {!exitBadge && (
              <span
                aria-label="ended"
                style={{
                  marginLeft: "auto",
                  color: "var(--text-disabled)",
                  letterSpacing: "var(--tracking-caps)",
                  textTransform: "uppercase",
                  fontFamily: "var(--font-sans)",
                }}
              >
                ended
              </span>
            )}
            {exitBadge && (
              <span style={{ color: exitBadge.color, marginLeft: "auto" }}>
                {exitBadge.label}
              </span>
            )}
          </div>
        )}
        <div
          onClick={onClickInput ? handleInputClick : undefined}
          style={{
            fontWeight: 600,
            color: "var(--text-primary)",
            paddingTop: BLOCK_COMMAND_TOP_PX,
            paddingBottom: hasBody ? BLOCK_MIDDLE_GAP_PX : 0,
            marginBottom: hasBody ? "var(--space-1-5)" : 0,
            borderBottom: hasBody ? "var(--border-1)" : "none",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            cursor: onClickInput ? "text" : "default",
          }}
          title={onClickInput ? "Click to edit and re-run" : undefined}
        >
          {block.input}
        </div>
        {hasBody && (
          <div style={{ color: "var(--text-secondary)" }}>
            {bodyLines.map((spans, i) => (
              <CellRow key={i} spans={spans} wrap={!isAgent && !noWrap} />
            ))}
          </div>
        )}
      </div>
      {/* Hover-revealed action group. Mirrors Warp's right-edge buttons
          (block_list_element.rs:96-180): overflow menu, snackbar
          toggle, AI assistant, save-as-workflow. We expose the four
          actions that make sense in Goonware today: copy command,
          copy output, re-run, share. The two copy actions work
          standalone; re-run/share need parent wiring (Phase 4) so they
          render only when the parent has provided a handler. */}
      <div
        className="goonware-block-actions"
        style={{
          position: "absolute",
          top: BLOCK_PADDING_TOP_PX - 4,
          right: "var(--space-3)",
          display: "flex",
          alignItems: "center",
          gap: 4,
          zIndex: 2,
        }}
      >
        <BlockActionButton title="Copy command" onClick={handleCopyCommand}>
          <CopyCommandIcon />
        </BlockActionButton>
        {hasBody && (
          <BlockActionButton title="Copy output" onClick={handleCopyOutput}>
            <CopyOutputIcon />
          </BlockActionButton>
        )}
        {onRerun && (
          <BlockActionButton title="Re-run" onClick={handleRerun}>
            <RerunIcon />
          </BlockActionButton>
        )}
        {onShare && (
          <BlockActionButton title="Share" onClick={handleShare}>
            <ShareIcon />
          </BlockActionButton>
        )}
      </div>
    </div>
  );
}

function BlockActionButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(e) => {
        // Stop propagation so a click on an action button doesn't
        // bubble up to the block's click-to-edit handler. We want
        // these to be discrete actions, not "click the block".
        e.stopPropagation();
        onClick();
      }}
      className="goonware-block-action-button"
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------
   Hover-action icons — inline SVGs so we don't bloat the bundle with
   an icon set for four glyphs. Sized 14×14 inside the 26px button.
   Stroke-only style, currentColor so hover lifts from text-tertiary
   to text-primary via the button class.
   ------------------------------------------------------------------ */

function CopyCommandIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="4.5"
        y="4.5"
        width="8"
        height="8"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M3.5 10.5V4a1.5 1.5 0 0 1 1.5-1.5h5.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CopyOutputIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="3.5"
        y="3.5"
        width="9"
        height="9"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M6 6.5h4M6 8.5h4M6 10.5h2.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RerunIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 8a5 5 0 1 0 1.6-3.7"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M3 2.5v3h3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M7 4H4.5a1.5 1.5 0 0 0-1.5 1.5V11a1.5 1.5 0 0 0 1.5 1.5h6A1.5 1.5 0 0 0 12 11V8.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M9 3h4v4M13 3 8 8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
