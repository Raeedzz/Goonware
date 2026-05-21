import { memo, type CSSProperties } from "react";
import type { Span } from "./types";
import { splitUrls } from "@/lib/urlMatch";

interface Props {
  spans: Span[];
  /**
   * When true, soft-wrap long rows at whitespace and force-break
   * unbreakable runs. Used by closed blocks and the in-progress
   * LiveBlock so historical command output stays readable when the
   * pane is narrower than the PTY's column count.
   *
   * MUST stay false for alt-screen TUI grids (FullGrid for vim /
   * htop / claude) — those assume one visual line per grid row, and
   * any wrapping makes the rendered row count drift away from the
   * PTY's row count, which kicks the ResizeObserver into a feedback
   * loop and produces a visible jitter.
   */
  wrap?: boolean;
}

/**
 * Renders a single row of the terminal grid as styled `<span>` elements
 * — one DOM node per same-style run, not per character. A 120-col line
 * with 5 colors is 5 DOM nodes, not 120.
 *
 * URLs in span text get split out into clickable `<a>` elements that
 * dispatch a `rli:open-url` event — the AppShell catches it and opens
 * the URL in the user's default system browser. The in-app browser
 * pane is reserved for URLs the user deliberately types or pastes
 * into its address bar (dev-server previews), not for ambient links
 * the agent happens to print.
 *
 * Memoized so React skips reconciling rows that didn't change between
 * frames (the wire-level diff already drops unchanged rows, but a fresh
 * render of all currently-dirty rows still benefits when only the
 * cursor row inside that set actually changed contents).
 */
export const CellRow = memo(function CellRow({ spans, wrap = false }: Props) {
  // In grid mode (wrap=false, used by preserveGrid agent inline and
  // alt-screen TUIs), every row must take exactly one cell of vertical
  // space — even blank ones — so the agent's grid layout survives DOM
  // rendering. We can't enforce that with `min-height: 1.35em` because
  // the line-box height the browser computes for actual text content
  // tends to round 1px lower than `em`-derived min-height, leaving a
  // 1px gap below text rows that reads as a horizontal hairline
  // between every line. Instead, when the row has no visible content,
  // render a non-breaking space so the line-box gives us its natural
  // height — that's pixel-identical to neighboring text rows.
  const isBlank =
    !wrap && spans.every((s) => s.text.length === 0 || s.text.trim() === "");
  return (
    <div
      style={{
        whiteSpace: wrap ? "pre-wrap" : "pre",
        overflowWrap: wrap ? "anywhere" : "normal",
        fontVariantLigatures: "none",
        lineHeight: "var(--cell-line-height, 1.35)",
      }}
    >
      {isBlank && <span>{" "}</span>}
      {!isBlank && spans.map((span, i) => {
        const baseStyle: CSSProperties = {
          color: span.inverse ? span.bg : span.fg,
          backgroundColor: span.inverse ? span.fg : "transparent",
          fontWeight: span.bold ? 600 : 400,
          fontStyle: span.italic ? "italic" : "normal",
          textDecorationLine:
            [
              span.underline && "underline",
              span.strikeout && "line-through",
            ]
              .filter(Boolean)
              .join(" ") || "none",
          opacity: span.dim ? 0.6 : 1,
        };
        const fragments = splitUrls(span.text);
        // Hot path: no URLs in this span — render as a single styled
        // <span>, same as before.
        if (fragments.length <= 1 && fragments[0]?.kind !== "url") {
          return (
            <span key={i} style={baseStyle}>
              {span.text}
            </span>
          );
        }
        return (
          <span key={i} style={baseStyle}>
            {fragments.map((f, j) =>
              f.kind === "text" ? (
                <span key={j}>{f.text}</span>
              ) : (
                <UrlSpan key={j} text={f.text} url={f.url} />
              ),
            )}
          </span>
        );
      })}
    </div>
  );
});

function UrlSpan({ text, url }: { text: string; url: string }) {
  return (
    <a
      href={url}
      onClick={(e) => {
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent("goonware:open-url", { detail: { url } }),
        );
      }}
      style={{
        color: "var(--accent-bright)",
        textDecorationLine: "underline",
        textUnderlineOffset: 2,
        cursor: "pointer",
      }}
      title={`Open ${url} in your default browser`}
    >
      {text}
    </a>
  );
}
