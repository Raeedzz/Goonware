/**
 * Splits a string into a sequence of plain-text and URL fragments so the
 * terminal renderer can wrap each URL in a clickable span. We accept
 * `http(s)://` and `localhost:<port>` (the latter is what `vite` and
 * `next dev` print, often without a scheme).
 *
 * Trailing punctuation that's almost certainly NOT part of the URL is
 * peeled off — VS Code and iTerm do the same — so a sentence ending in
 * "…try http://example.com." doesn't drag the period into the link.
 */

export type UrlFragment =
  | { kind: "text"; text: string }
  | { kind: "url"; text: string; url: string };

const URL_RE = /\b((?:https?:\/\/|localhost:\d+)[^\s<>`"']+)/g;

const TRIM_TAIL = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", "'", '"']);

/** Strip a single trailing punct char unless brackets balance. */
function trimTrailingPunct(raw: string): { url: string; tail: string } {
  let url = raw;
  let tail = "";
  while (url.length > 1) {
    const last = url[url.length - 1];
    if (!TRIM_TAIL.has(last)) break;
    // Don't strip a closing paren if the URL itself contains an opening one
    // (Wikipedia-style links).
    if (
      last === ")" &&
      (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)
    ) {
      break;
    }
    url = url.slice(0, -1);
    tail = last + tail;
  }
  return { url, tail };
}

/** Normalize bare `localhost:PORT` to a full http URL. */
function normalize(raw: string): string {
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  return `http://${raw}`;
}

export function splitUrls(input: string): UrlFragment[] {
  if (!input) return [];
  const out: UrlFragment[] = [];
  let cursor = 0;
  for (const match of input.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      out.push({ kind: "text", text: input.slice(cursor, start) });
    }
    const { url, tail } = trimTrailingPunct(match[1]);
    out.push({ kind: "url", text: url, url: normalize(url) });
    if (tail) out.push({ kind: "text", text: tail });
    cursor = start + match[1].length;
  }
  if (cursor < input.length) {
    out.push({ kind: "text", text: input.slice(cursor) });
  }
  return out;
}
