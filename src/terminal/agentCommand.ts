/**
 * Split a shell command into word spans without changing the original text.
 * This is deliberately a small lexer rather than a shell parser: we only need
 * to find the first executable token while respecting quoted env values such
 * as `DEBUG_LABEL='one two' codex`.
 */
function shellWordSpans(input: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let start = -1;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (start === -1) {
      if (/\s/.test(char)) continue;
      start = i;
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      spans.push({ start, end: i });
      start = -1;
    }
  }

  if (start !== -1) spans.push({ start, end: input.length });
  return spans;
}

function unquoteShellWord(word: string): string {
  if (word.length >= 2) {
    const first = word[0];
    const last = word[word.length - 1];
    if ((first === "'" || first === '"') && first === last) {
      return word.slice(1, -1);
    }
  }
  return word;
}

/**
 * Make Codex use the terminal's normal buffer so its conversation participates
 * in Goonware's native transcript scrollback, just like Claude's output does.
 *
 * Codex defaults to the alternate screen. It does not enable mouse reporting,
 * so Goonware's safe alt-screen wheel bridge has nothing to forward and a wheel
 * gesture is a no-op. Codex's supported `--no-alt-screen` switch is the correct
 * integration point: output then enters alacritty scrollback and is handled by
 * the existing `term_native_scroll` path.
 */
export function makeCodexScrollable(input: string): string {
  const spans = shellWordSpans(input);
  let executable: { start: number; end: number } | undefined;

  for (const span of spans) {
    const word = input.slice(span.start, span.end);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    executable = span;
    break;
  }
  if (!executable) return input;

  const rawExecutable = unquoteShellWord(
    input.slice(executable.start, executable.end),
  );
  const basename = rawExecutable.split("/").pop() ?? rawExecutable;
  if (basename !== "codex" && basename !== "codex-cli") return input;

  const alreadyInline = spans.some(
    ({ start, end }) => input.slice(start, end) === "--no-alt-screen",
  );
  if (alreadyInline) return input;

  return `${input.slice(0, executable.end)} --no-alt-screen${input.slice(executable.end)}`;
}
