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

type LaunchWrapper = "command" | "exec" | "time" | "noglob";

function isLaunchWrapper(word: string): word is LaunchWrapper {
  return (
    word === "command" ||
    word === "exec" ||
    word === "time" ||
    word === "noglob"
  );
}

function findExecutable(input: string): {
  spans: Array<{ start: number; end: number }>;
  executable?: { start: number; end: number };
} {
  const spans = shellWordSpans(input);
  let insideEnv = false;
  let skipEnvOptionValue = false;
  let wrapper: LaunchWrapper | null = null;
  let skipWrapperOptionValue = false;

  for (const span of spans) {
    const word = input.slice(span.start, span.end);
    const rawWord = unquoteShellWord(word);

    if (insideEnv) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
      if (skipEnvOptionValue) {
        skipEnvOptionValue = false;
        continue;
      }
      if (
        ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"].includes(
          rawWord,
        )
      ) {
        skipEnvOptionValue = true;
        continue;
      }
      if (rawWord === "--" || rawWord.startsWith("-")) continue;
      insideEnv = false;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      continue;
    }

    if (wrapper) {
      if (skipWrapperOptionValue) {
        skipWrapperOptionValue = false;
        continue;
      }
      if (wrapper === "command") {
        // `command -v/-V` inspects a name; it does not launch it.
        if (rawWord === "-v" || rawWord === "-V") return { spans };
        if (rawWord === "-p") continue;
      } else if (wrapper === "exec") {
        if (rawWord === "-a") {
          skipWrapperOptionValue = true;
          continue;
        }
        if (/^-[cl]+$/.test(rawWord)) continue;
      } else if (wrapper === "time") {
        if (["-o", "--output", "-f", "--format"].includes(rawWord)) {
          skipWrapperOptionValue = true;
          continue;
        }
        if (rawWord.startsWith("-")) continue;
      }
      if (rawWord === "--") {
        wrapper = null;
        continue;
      }
      if (rawWord.startsWith("-")) return { spans };
      wrapper = null;
    }

    // Common shell launch wrappers are transparent for command detection.
    if (isLaunchWrapper(rawWord)) {
      wrapper = rawWord;
      continue;
    }
    if (rawWord === "env") {
      insideEnv = true;
      continue;
    }
    return { spans, executable: span };
  }

  return { spans };
}

export type DetectedAgentCommand =
  | "claude"
  | "codex"
  | "gemini"
  | "aider"
  | "copilot";

/**
 * Codex already renders its own activity state inline, so duplicating it in
 * pane chrome wastes space and can steal the wheel hit area. Other agents keep
 * the existing status/permission strip; an unknown kind stays visible so the
 * generic pending state does not regress while detection catches up.
 */
/** Detect the foreground agent behind env assignments and common shell wrappers. */
export function detectAgentCommand(input: string): DetectedAgentCommand | null {
  const { executable } = findExecutable(input);
  if (!executable) return null;
  const raw = unquoteShellWord(input.slice(executable.start, executable.end));
  const basename = (raw.split("/").pop() ?? raw).split(/[?#]/)[0].toLowerCase();
  if (basename === "claude" || basename === "claude-code") return "claude";
  if (basename === "codex" || basename === "codex-cli") return "codex";
  if (basename === "gemini" || basename === "gemini-cli") return "gemini";
  if (basename === "aider" || basename.startsWith("aider-")) return "aider";
  if (basename === "copilot" || basename === "github-copilot") return "copilot";
  return null;
}

/**
 * Make Codex use the terminal's normal buffer so its conversation participates
 * in Goonware's native transcript scrollback.
 *
 * Codex defaults to the alternate screen. It does not enable mouse reporting,
 * so the safe alt-screen wheel bridge has nothing to forward and a wheel
 * gesture becomes a no-op. Codex's supported `--no-alt-screen` switch writes
 * output into normal PTY scrollback, which the native transcript already owns.
 */
export function makeCodexScrollable(input: string): string {
  const { spans, executable } = findExecutable(input);
  if (!executable) return input;

  const rawExecutable = unquoteShellWord(
    input.slice(executable.start, executable.end),
  );
  const basename = (
    rawExecutable.split("/").pop() ?? rawExecutable
  ).toLowerCase();
  if (basename !== "codex" && basename !== "codex-cli") return input;

  const alreadyInline = spans.some(
    ({ start, end }) =>
      unquoteShellWord(input.slice(start, end)) === "--no-alt-screen",
  );
  if (alreadyInline) return input;

  return `${input.slice(0, executable.end)} --no-alt-screen${input.slice(executable.end)}`;
}
