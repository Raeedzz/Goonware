import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactNode } from "react";
import { parseUnifiedDiff } from "./diff-parse";
import { renderDiffLines, parseInlineStyle } from "./diff-highlight";

/**
 * Regression tests for the diff syntax highlighter. The production
 * bug was: after commit 922774e introduced highlighting, diff text
 * sometimes failed to render. These tests pin down the invariant
 * that EVERY line's text always reaches the DOM, regardless of:
 *   - whether the language has a parser
 *   - whether the parser succeeds
 *   - whether highlightTree emits any tokens
 *   - whether multiple tags concatenate into one class string
 *
 * If any of these paths drop text, the assertions below catch it
 * before it ships.
 */

function htmlText(nodes: ReactNode[]): string {
  // Render the array as a single fragment so we can string-match.
  return renderToStaticMarkup(
    createElement(
      "div",
      null,
      ...nodes.map((n, i) => createElement("p", { key: i }, n)),
    ),
  );
}

describe("renderDiffLines", () => {
  test("returns one ReactNode per input line", () => {
    const lines = parseUnifiedDiff(`@@ -1,1 +1,2 @@
 a
+b
`);
    const out = renderDiffLines(lines, "x.ts");
    expect(out.length).toBe(lines.length);
  });

  test("plain text path: every text-bearing line round-trips verbatim when no parser", () => {
    const lines = parseUnifiedDiff(`diff --git a/x.weird b/x.weird
@@ -1,1 +1,2 @@
 hello world
+goodbye world
`);
    const out = renderDiffLines(lines, "x.weird"); // unknown ext → no parser
    const html = htmlText(out);
    expect(html).toContain("hello world");
    expect(html).toContain("goodbye world");
    expect(html).toContain("@@ -1,1 +1,2 @@");
  });

  test("text is present even when filePath is undefined", () => {
    const lines = parseUnifiedDiff(`@@ -1,1 +1,2 @@
 alpha
+beta
`);
    const out = renderDiffLines(lines, undefined);
    const html = htmlText(out);
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
  });

  test("typescript diff: every line still emits the underlying text", () => {
    const lines = parseUnifiedDiff(`diff --git a/x.ts b/x.ts
@@ -1,2 +1,3 @@
 const aardvark = 1;
+const banana = 2;
 const cherry = 3;
`);
    const out = renderDiffLines(lines, "x.ts");
    const html = htmlText(out);
    // The identifiers are between tokens and stay as plain text.
    expect(html).toContain("aardvark");
    expect(html).toContain("banana");
    expect(html).toContain("cherry");
  });

  test("rust diff text survives", () => {
    const lines = parseUnifiedDiff(`diff --git a/x.rs b/x.rs
@@ -1,1 +1,2 @@
 fn first() {}
+fn second() {}
`);
    const out = renderDiffLines(lines, "x.rs");
    const html = htmlText(out);
    expect(html).toContain("first");
    expect(html).toContain("second");
  });

  test("python diff text survives", () => {
    const lines = parseUnifiedDiff(`diff --git a/x.py b/x.py
@@ -1,1 +1,2 @@
 def alpha(): pass
+def beta(): pass
`);
    const out = renderDiffLines(lines, "x.py");
    const html = htmlText(out);
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
  });

  test("empty context line keeps its slot (zero-length text)", () => {
    const lines = parseUnifiedDiff(
      "@@ -1,3 +1,3 @@\n a\n \n b\n",
    );
    const out = renderDiffLines(lines, "x.ts");
    expect(out.length).toBe(lines.length);
    const blankIdx = lines.findIndex(
      (l) => l.kind === "context" && l.text === "",
    );
    expect(blankIdx).toBeGreaterThan(-1);
    // Empty string here is the safe value — DiffRow renders a ZWS
    // in its place so the row still has measurable height.
    expect(out[blankIdx]).toBe("");
  });

  test("header and hunk lines pass through as their original text", () => {
    const lines = parseUnifiedDiff(`diff --git a/x.ts b/x.ts
@@ -1,1 +1,1 @@
 keep
`);
    const out = renderDiffLines(lines, "x.ts");
    expect(out[0]).toBe("diff --git a/x.ts b/x.ts");
    expect(out[1]).toBe("@@ -1,1 +1,1 @@");
  });

  test("falls back to plain text if the highlighter throws", () => {
    // Pathological source that historically tripped some Lezer
    // parsers — confirm the fallback path lets text survive.
    const lines = parseUnifiedDiff(`@@ -1,1 +1,2 @@
 const x = \`\${\`nested\`}\`;
+const y = \`\${\`also\`}\`;
`);
    const out = renderDiffLines(lines, "x.ts");
    expect(out.length).toBe(lines.length);
    // Even if highlight failed mid-stream, every text line is at
    // least the raw string.
    expect(out.every((n) => typeof n === "string" || Array.isArray(n))).toBe(
      true,
    );
  });

  test("real-world multi-line diff: large blocks preserve every identifier", () => {
    // Use space-prefixed lines for legitimate context blanks so the
    // parser keeps every row.
    const lines = parseUnifiedDiff(
      "diff --git a/big.ts b/big.ts\n" +
        "@@ -1,10 +1,12 @@\n" +
        ' import { foo } from "./foo";\n' +
        ' import { bar } from "./bar";\n' +
        '+import { baz } from "./baz";\n' +
        " \n" +
        " export function compute(a: number, b: number) {\n" +
        "-  return a + b;\n" +
        "+  return a + b + 1;\n" +
        " }\n" +
        "+\n" +
        "+export function next() {}\n" +
        " \n" +
        " export const X = 42;\n",
    );
    const out = renderDiffLines(lines, "big.ts");
    const html = htmlText(out);
    // Identifiers and literals sit BETWEEN syntax tokens, so they
    // survive as plain text even after span-fragmentation. Numbers
    // and keywords are inside spans — check separately.
    for (const ident of ["foo", "bar", "baz", "compute", "next"]) {
      expect(html).toContain(ident);
    }
    // Keywords wrapped in highlight spans.
    expect(html).toContain(">import<");
    expect(html).toContain(">return<");
    expect(html).toContain(">function<");
    // Numbers survive in their own warning-tinted span.
    expect(html).toContain(">42<");
    expect(html).toContain(">1<");
    // And one full input line round-trips at parse stage:
    expect(lines.find((l) => l.text === "  return a + b + 1;")).toBeDefined();
    expect(lines.find((l) => l.text === "  return a + b;")).toBeDefined();
  });
});

describe("parseInlineStyle", () => {
  test("single declaration list", () => {
    expect(parseInlineStyle("color:red;font-weight:600")).toEqual({
      color: "red",
      fontWeight: "600",
    });
  });

  test("handles var(...) values with embedded parens and commas", () => {
    const s = parseInlineStyle(
      "color:var(--state-info, oklch(70% 0.1 240));font-style:italic",
    );
    expect(s.color).toBe("var(--state-info, oklch(70% 0.1 240))");
    expect(s.fontStyle).toBe("italic");
  });

  test("space-separated multi-tag class string", () => {
    // This is what `highlightTree` passes when two tags both match
    // the same range. The naive split-on-`;` was the production
    // regression vector — it left the second tag's color attached
    // to fontWeight as garbage, so the highlight silently dropped.
    const s = parseInlineStyle(
      "color:var(--state-info);font-weight:500 color:var(--state-success)",
    );
    expect(s.color).toBe("var(--state-success)");
    expect(s.fontWeight).toBe("500");
  });

  test("ignores empty / malformed declarations", () => {
    const s = parseInlineStyle(";;color:red;:value;prop:;");
    expect(s).toEqual({ color: "red" });
  });
});
