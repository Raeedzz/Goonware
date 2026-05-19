import { useMemo, type ReactNode } from "react";
import { tagHighlighter, tags as t, highlightTree } from "@lezer/highlight";
import type { Parser } from "@lezer/common";
import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { php } from "@codemirror/lang-php";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { go } from "@codemirror/lang-go";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { kotlin, scala, dart } from "@codemirror/legacy-modes/mode/clike";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { r } from "@codemirror/legacy-modes/mode/r";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import type { DiffLine } from "./DiffView";

/**
 * Standalone diff highlighter. Mirrors the palette in cm6-theme.ts so
 * the diff view and the editor feel like the same surface — keywords
 * info-blue, strings sage-green, types accent, numbers amber, comments
 * tertiary + italic. The "class" strings are actually inline CSS that
 * we apply via `style=` on spans, so we don't need to mount a
 * StyleModule outside of CodeMirror.
 */
const HL = tagHighlighter([
  { tag: t.comment, class: "color:var(--text-tertiary);font-style:italic" },
  { tag: t.lineComment, class: "color:var(--text-tertiary);font-style:italic" },
  { tag: t.blockComment, class: "color:var(--text-tertiary);font-style:italic" },
  { tag: t.docComment, class: "color:var(--text-tertiary);font-style:italic" },

  { tag: t.keyword, class: "color:var(--state-info);font-weight:500" },
  { tag: t.modifier, class: "color:var(--state-info)" },
  { tag: t.controlKeyword, class: "color:var(--state-info);font-weight:500" },
  { tag: t.operatorKeyword, class: "color:var(--state-info)" },
  { tag: t.definitionKeyword, class: "color:var(--state-info);font-weight:500" },
  { tag: t.moduleKeyword, class: "color:var(--state-info);font-weight:500" },

  { tag: t.string, class: "color:var(--state-success)" },
  { tag: t.special(t.string), class: "color:var(--state-success)" },
  { tag: t.regexp, class: "color:var(--state-warning)" },
  { tag: t.escape, class: "color:var(--state-warning)" },

  { tag: t.number, class: "color:var(--state-warning)" },
  { tag: t.bool, class: "color:var(--state-warning)" },
  { tag: t.atom, class: "color:var(--state-warning)" },
  { tag: t.constant(t.variableName), class: "color:var(--state-warning)" },

  { tag: t.typeName, class: "color:var(--accent)" },
  { tag: t.className, class: "color:var(--accent)" },
  { tag: t.namespace, class: "color:var(--accent)" },

  { tag: t.function(t.variableName), class: "font-weight:500" },
  { tag: t.function(t.propertyName), class: "font-weight:500" },
  { tag: t.macroName, class: "font-weight:500" },

  { tag: t.attributeName, class: "color:var(--state-info)" },
  { tag: t.propertyName, class: "color:var(--text-primary)" },

  { tag: t.tagName, class: "color:var(--state-error)" },
  { tag: t.angleBracket, class: "color:var(--text-tertiary)" },

  { tag: t.punctuation, class: "color:var(--text-tertiary)" },
  { tag: t.bracket, class: "color:var(--text-secondary)" },
  { tag: t.brace, class: "color:var(--text-secondary)" },
  { tag: t.paren, class: "color:var(--text-secondary)" },
  { tag: t.separator, class: "color:var(--text-tertiary)" },

  { tag: t.operator, class: "color:var(--text-secondary)" },
  { tag: t.compareOperator, class: "color:var(--state-info)" },
  { tag: t.logicOperator, class: "color:var(--state-info)" },
  { tag: t.arithmeticOperator, class: "color:var(--text-secondary)" },

  { tag: t.heading, class: "color:var(--text-primary);font-weight:600" },
  { tag: t.link, class: "color:var(--accent);text-decoration:underline" },
  { tag: t.emphasis, class: "font-style:italic" },
  { tag: t.strong, class: "font-weight:600" },
]);

const parserCache = new Map<string, Parser | null>();

function buildParser(key: string): Parser | null {
  switch (key) {
    case "js":
    case "mjs":
    case "cjs":
      return javascript().language.parser;
    case "jsx":
      return javascript({ jsx: true }).language.parser;
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true }).language.parser;
    case "tsx":
      return javascript({ typescript: true, jsx: true }).language.parser;
    case "rs":
      return rust().language.parser;
    case "json":
    case "jsonc":
    case "json5":
      return json().language.parser;
    case "md":
    case "mdx":
    case "markdown":
      return markdown().language.parser;
    case "html":
    case "htm":
    case "xhtml":
    case "vue":
    case "svelte":
      return html().language.parser;
    case "css":
    case "scss":
    case "sass":
    case "less":
    case "pcss":
      return css().language.parser;
    case "py":
    case "pyi":
    case "pyw":
      return python().language.parser;
    case "yaml":
    case "yml":
      return yaml().language.parser;
    case "c":
    case "h":
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
    case "hxx":
    case "m":
    case "mm":
      return cpp().language.parser;
    case "java":
      return java().language.parser;
    case "php":
    case "phtml":
      return php().language.parser;
    case "sql":
    case "psql":
    case "mysql":
      return sql().language.parser;
    case "xml":
    case "xsd":
    case "xslt":
    case "svg":
    case "plist":
      return xml().language.parser;
    case "go":
      return go().language.parser;
    case "toml":
      return StreamLanguage.define(toml).parser;
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "ksh":
      return StreamLanguage.define(shell).parser;
    case "rb":
    case "rake":
    case "gemspec":
      return StreamLanguage.define(ruby).parser;
    case "swift":
      return StreamLanguage.define(swift).parser;
    case "kt":
    case "kts":
      return StreamLanguage.define(kotlin).parser;
    case "scala":
    case "sc":
      return StreamLanguage.define(scala).parser;
    case "dart":
      return StreamLanguage.define(dart).parser;
    case "lua":
      return StreamLanguage.define(lua).parser;
    case "pl":
    case "pm":
      return StreamLanguage.define(perl).parser;
    case "r":
    case "rmd":
      return StreamLanguage.define(r).parser;
    case "hs":
    case "lhs":
      return StreamLanguage.define(haskell).parser;
    case "clj":
    case "cljs":
    case "cljc":
    case "edn":
      return StreamLanguage.define(clojure).parser;
    case "dockerfile":
      return StreamLanguage.define(dockerFile).parser;
    case "ini":
    case "cfg":
    case "properties":
    case "env":
    case "editorconfig":
      return StreamLanguage.define(properties).parser;
    default:
      return null;
  }
}

function parserForPath(path: string): Parser | null {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  let key: string;
  if (/^dockerfile(\.|$)/i.test(name)) {
    key = "dockerfile";
  } else {
    key = name.split(".").pop() ?? "";
  }
  if (parserCache.has(key)) return parserCache.get(key) ?? null;
  let parser: Parser | null = null;
  try {
    parser = buildParser(key);
  } catch {
    parser = null;
  }
  parserCache.set(key, parser);
  return parser;
}

function parseInlineStyle(css: string): React.CSSProperties {
  const out: Record<string, string> = {};
  for (const decl of css.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    const val = decl.slice(i + 1).trim();
    if (!prop || !val) continue;
    const camel = prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    out[camel] = val;
  }
  return out as React.CSSProperties;
}

/**
 * Highlights each text-bearing diff line (`add`/`remove`/`context`) by
 * concatenating their text into a single virtual document, parsing it
 * once with the file's language, then slicing the tokenized output
 * back per line. Header/hunk lines stay as plain strings.
 *
 * The single-parse trick keeps multi-line constructs (template
 * literals, block comments) coherent even when add and remove lines
 * appear adjacent — strictly per-line parsing would mis-color those.
 */
export function useDiffLineRenderers(
  lines: DiffLine[],
  filePath?: string,
): ReactNode[] {
  return useMemo(() => {
    const out = new Array<ReactNode>(lines.length);
    const parser = filePath ? parserForPath(filePath) : null;

    if (!parser) {
      for (let i = 0; i < lines.length; i++) out[i] = lines[i].text;
      return out;
    }

    type Range = { start: number; end: number; idx: number };
    const ranges: Range[] = [];
    let cursor = 0;
    const pieces: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.kind === "header" || l.kind === "hunk") continue;
      ranges.push({ start: cursor, end: cursor + l.text.length, idx: i });
      pieces.push(l.text);
      cursor += l.text.length + 1; // +1 for the join \n
    }
    const source = pieces.join("\n");

    let tree;
    try {
      tree = parser.parse(source);
    } catch {
      for (let i = 0; i < lines.length; i++) out[i] = lines[i].text;
      return out;
    }

    type Token = { from: number; to: number; style: string };
    const tokens: Token[] = [];
    try {
      highlightTree(tree, HL, (from, to, classes) => {
        if (from < to) tokens.push({ from, to, style: classes });
      });
    } catch {
      for (let i = 0; i < lines.length; i++) out[i] = lines[i].text;
      return out;
    }

    // tokens are emitted in document order; walk them per line.
    let tokIdx = 0;
    for (let i = 0; i < lines.length; i++) out[i] = lines[i].text;
    for (const r of ranges) {
      const text = lines[r.idx].text;
      const parts: ReactNode[] = [];
      let pos = r.start;
      while (tokIdx < tokens.length && tokens[tokIdx].to <= r.start) tokIdx++;
      let j = tokIdx;
      while (j < tokens.length && tokens[j].from < r.end) {
        const tok = tokens[j];
        if (tok.to <= r.start) {
          j++;
          continue;
        }
        const from = Math.max(tok.from, r.start);
        const to = Math.min(tok.to, r.end);
        if (from > pos) {
          parts.push(text.slice(pos - r.start, from - r.start));
        }
        parts.push(
          <span key={from} style={parseInlineStyle(tok.style)}>
            {text.slice(from - r.start, to - r.start)}
          </span>,
        );
        pos = to;
        j++;
      }
      if (pos < r.end) parts.push(text.slice(pos - r.start));
      out[r.idx] = parts.length > 0 ? parts : text;
    }
    return out;
  }, [lines, filePath]);
}
