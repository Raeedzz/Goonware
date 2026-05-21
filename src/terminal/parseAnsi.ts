import type { Span } from "./types";

/**
 * Minimal SGR parser. Walks a byte stream (as a JS string) and emits
 * one row of styled `Span`s per visible newline. Strips OSC sequences
 * (titles, OSC 7 cwd reports), single-byte ESC sequences, and stray
 * BEL/DEL bytes. Cursor-positioning CSI commands are dropped — the
 * transcript is rendered linearly, top-to-bottom, so trying to honor
 * them inside a closed block doesn't make sense.
 *
 * Frontend equivalent of the alacritty-side `cell_to_span` path: we
 * pre-strip OSC 7/133 (already handled in Rust) but the Rust segmenter
 * only consumes the OSC bytes, never strips them from the transcript,
 * so we re-strip here. SGR is the only sequence type that produces
 * visible styling in the output.
 *
 * Palette mirrors `ANSI_16` in `term.rs` — workshop pigments tuned to
 * the Goonware dark theme. Truecolor (`38;2;R;G;B`) round-trips losslessly.
 */

const ANSI_16: readonly string[] = [
  "#1c1a17", "#d97757", "#86a16f", "#d8b572",
  "#7fa1c0", "#a78fc4", "#7ca0a3", "#b9b4ad",
  "#403c37", "#e8896d", "#9ec189", "#e8c98c",
  "#9ab9d4", "#bda9d6", "#92b8bb", "#dcd6cc",
];

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  dim?: boolean;
  strikeout?: boolean;
}

function indexed256(i: number): string {
  if (i < 16) return ANSI_16[i];
  if (i < 232) {
    const n = i - 16;
    const r = Math.floor(n / 36) % 6;
    const g = Math.floor(n / 6) % 6;
    const b = n % 6;
    const conv = (c: number) => (c === 0 ? 0 : 55 + c * 40);
    return `rgb(${conv(r)},${conv(g)},${conv(b)})`;
  }
  const level = 8 + (i - 232) * 10;
  return `rgb(${level},${level},${level})`;
}

function applySGR(style: Style, codes: number[]): void {
  let i = 0;
  while (i < codes.length) {
    const c = codes[i];
    if (c === 0) {
      delete style.fg;
      delete style.bg;
      style.bold = false;
      style.italic = false;
      style.underline = false;
      style.inverse = false;
      style.dim = false;
      style.strikeout = false;
    } else if (c === 1) style.bold = true;
    else if (c === 2) style.dim = true;
    else if (c === 3) style.italic = true;
    else if (c === 4) style.underline = true;
    else if (c === 7) style.inverse = true;
    else if (c === 9) style.strikeout = true;
    else if (c === 22) {
      style.bold = false;
      style.dim = false;
    } else if (c === 23) style.italic = false;
    else if (c === 24) style.underline = false;
    else if (c === 27) style.inverse = false;
    else if (c === 29) style.strikeout = false;
    else if (c >= 30 && c <= 37) style.fg = ANSI_16[c - 30];
    else if (c === 38) {
      if (codes[i + 1] === 5) {
        style.fg = indexed256(codes[i + 2] ?? 0);
        i += 2;
      } else if (codes[i + 1] === 2) {
        const r = codes[i + 2] ?? 0;
        const g = codes[i + 3] ?? 0;
        const b = codes[i + 4] ?? 0;
        style.fg = `rgb(${r},${g},${b})`;
        i += 4;
      }
    } else if (c === 39) delete style.fg;
    else if (c >= 40 && c <= 47) style.bg = ANSI_16[c - 40];
    else if (c === 48) {
      if (codes[i + 1] === 5) {
        style.bg = indexed256(codes[i + 2] ?? 0);
        i += 2;
      } else if (codes[i + 1] === 2) {
        const r = codes[i + 2] ?? 0;
        const g = codes[i + 3] ?? 0;
        const b = codes[i + 4] ?? 0;
        style.bg = `rgb(${r},${g},${b})`;
        i += 4;
      }
    } else if (c === 49) delete style.bg;
    else if (c >= 90 && c <= 97) style.fg = ANSI_16[c - 90 + 8];
    else if (c >= 100 && c <= 107) style.bg = ANSI_16[c - 100 + 8];
    i++;
  }
}

function styleToSpan(text: string, style: Style): Span {
  return {
    text,
    fg: style.fg ?? "currentColor",
    bg: style.bg ?? "transparent",
    bold: !!style.bold,
    italic: !!style.italic,
    underline: !!style.underline,
    inverse: !!style.inverse,
    dim: !!style.dim,
    strikeout: !!style.strikeout,
  };
}

/**
 * Parse an ANSI byte stream into rows of styled spans. One row per
 * newline; CR resets the buffer position (treated like a no-op for
 * append-only output). Empty input → empty array (block renders zero
 * lines, BlockList still shows the exit badge if present).
 */
export function parseAnsi(input: string): Span[][] {
  if (input.length === 0) return [];
  const lines: Span[][] = [];
  let row: Span[] = [];
  let buf = "";
  const style: Style = {};

  const flushBuf = () => {
    if (buf.length > 0) {
      row.push(styleToSpan(buf, style));
      buf = "";
    }
  };
  const flushRow = () => {
    flushBuf();
    lines.push(row);
    row = [];
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i];

    if (ch === "\x1b") {
      const next = input[i + 1];
      if (next === "[") {
        flushBuf();
        // CSI grammar (ECMA-48): ESC [ {params 0x30-0x3F} {intermediates 0x20-0x2F} {final 0x40-0x7E}
        // The previous regex-only loop missed intermediate bytes and
        // mistakenly consumed an ESC as the "final", which produced
        // garbled "u1u4;2m" output for sequences like `\e[1 q`
        // (set-cursor-style). Walk by code range for accuracy.
        let j = i + 2;
        let params = "";
        let aborted = false;
        while (j < input.length) {
          const code = input.charCodeAt(j);
          if (code === 0x1b) {
            // Sequence interrupted by another ESC — bail and let
            // the outer loop re-enter on this byte.
            aborted = true;
            break;
          }
          if (code >= 0x40 && code <= 0x7e) {
            // Final byte.
            break;
          }
          if (code >= 0x20 && code <= 0x3f) {
            params += input[j];
            j++;
            continue;
          }
          // Unexpected — bail without consuming.
          aborted = true;
          break;
        }
        if (aborted) {
          i = j;
          continue;
        }
        const final = input[j];
        if (final === "m") {
          // Strip any non-digit / non-`;` chars from params (defensive
          // — DEC private markers like `?` aren't valid in SGR).
          const codes = params
            .split(";")
            .filter((p) => /^\d*$/.test(p))
            .map((p) => parseInt(p, 10) || 0);
          if (codes.length === 0) codes.push(0);
          applySGR(style, codes);
        }
        // Drop other CSI commands silently.
        i = j + 1;
        continue;
      }
      if (next === "]") {
        // OSC — skip up to BEL or ST.
        flushBuf();
        let j = i + 2;
        while (j < input.length) {
          if (input[j] === "\x07") {
            j++;
            break;
          }
          if (input[j] === "\x1b" && input[j + 1] === "\\") {
            j += 2;
            break;
          }
          j++;
        }
        i = j;
        continue;
      }
      // Two-byte ESC sequences (charset switch, save/restore cursor,
      // etc.). Drop quietly. Guard against trailing lone ESC.
      i = next === undefined ? i + 1 : i + 2;
      continue;
    }
    if (ch === "\n") {
      i++;
      flushRow();
      continue;
    }
    if (ch === "\r") {
      // CR alone is a no-op for append-only rendering. zsh and most
      // shells follow CR with LF, which lands on the \n branch above.
      i++;
      continue;
    }
    if (ch === "\x07" || ch === "\x7f") {
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  // Final partial line (no trailing newline).
  if (buf.length > 0 || row.length > 0) {
    flushRow();
  }
  return lines;
}
