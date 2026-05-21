import { useMemo } from "react";
import { CellRow } from "./CellRow";
import { computeClosedBlockLines, isAgentInput } from "./blockLogic";
import { formatCwd, formatDuration } from "./formatBlockMeta";
import type { Block as BlockType } from "./types";

interface Props {
  block: BlockType;
  /**
   * Disable soft-wrap on shell output rows. Used by the narrow
   * right-panel secondary terminal so long lines pan via horizontal
   * scroll instead of wrapping. Agent blocks already render no-wrap.
   */
  noWrap?: boolean;
}

/**
 * One closed command block, Warp-style.
 *
 *   Top:    cwd + duration, small dim (e.g. "~ (0.046s)")
 *   Middle: the typed command in primary text, bold
 *   Bottom: the command's output, ANSI-parsed so colors from
 *           `git diff`, `cargo`, `rg`, etc. carry through
 *
 * We skip the transcript's first line in the body because the
 * segmenter captures *everything* between OSC 133 A and D — including
 * zsh's echo of the user's typed command. That echo would show up as a
 * duplicate of the bold command line we render above. We skip line 0
 * only when block.input is populated (the typical sendLine flow);
 * blocks with empty input keep the full transcript so we don't drop
 * content.
 */
export function Block({ block, noWrap = false }: Props) {
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

  return (
    <div
      style={{
        padding: "var(--space-2) var(--space-3)",
        borderTop: "var(--border-1)",
        fontFamily: "var(--font-mono)",
        fontSize: 13,
        fontVariantLigatures: "none",
        color: "var(--text-primary)",
        userSelect: "text",
      }}
    >
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
        style={{
          fontWeight: 600,
          color: "var(--text-primary)",
          paddingBottom: hasBody ? "var(--space-1-5)" : 0,
          marginBottom: hasBody ? "var(--space-1-5)" : 0,
          borderBottom: hasBody ? "var(--border-1)" : "none",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
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
  );
}
