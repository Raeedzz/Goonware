import { describe, expect, test } from "bun:test";
import { parseUnifiedDiff } from "./diff-parse";

/**
 * Regression tests for the unified-diff parser. The Changes panel,
 * DiffView, and AllChangesView all depend on this — if it stops
 * emitting `add`/`remove`/`context` lines or loses text, diffs go
 * invisible across the whole app.
 */
describe("parseUnifiedDiff", () => {
  test("emits header + hunk + context + add for a basic insert", () => {
    const raw = `diff --git a/x.ts b/x.ts
index abc..def 100644
--- a/x.ts
+++ b/x.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 const z = 3;
`;
    const lines = parseUnifiedDiff(raw);
    const kinds = lines.map((l) => l.kind);
    expect(kinds).toEqual([
      "header", // diff --git
      "header", // index
      "header", // ---
      "header", // +++
      "hunk", // @@
      "context", // const x
      "add", // const y
      "context", // const z
    ]);
    const add = lines.find((l) => l.kind === "add");
    expect(add?.text).toBe("const y = 2;");
    expect(add?.newLine).toBe(2);
  });

  test("removal carries old line number; add carries new", () => {
    const raw = `@@ -10,2 +10,2 @@
 keeper
-gone
+arrived
`;
    const lines = parseUnifiedDiff(raw);
    const rem = lines.find((l) => l.kind === "remove");
    const add = lines.find((l) => l.kind === "add");
    expect(rem?.text).toBe("gone");
    expect(rem?.oldLine).toBe(11);
    expect(add?.text).toBe("arrived");
    expect(add?.newLine).toBe(11);
  });

  test("preserves empty-line content as empty-string context", () => {
    // A blank line in the file shows as ` \n` in the diff (single
    // space prefix). Confirm we keep the row, not drop it.
    const raw = "@@ -1,3 +1,3 @@\n a\n \n b\n";
    const lines = parseUnifiedDiff(raw);
    const ctx = lines.filter((l) => l.kind === "context");
    expect(ctx.map((l) => l.text)).toEqual(["a", "", "b"]);
  });

  test("recognizes new-file and rename headers", () => {
    const raw = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000..1234
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,1 @@
+hello
`;
    const lines = parseUnifiedDiff(raw);
    // 5 headers: diff --git, new file mode, index, --- /dev/null, +++ b/new.txt
    expect(lines.filter((l) => l.kind === "header").length).toBe(5);
    expect(lines.find((l) => l.kind === "add")?.text).toBe("hello");
  });

  test("renamed file header recognized", () => {
    const raw = `diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
`;
    const lines = parseUnifiedDiff(raw);
    expect(lines.every((l) => l.kind === "header")).toBe(true);
    expect(lines.length).toBe(4);
  });

  test("binary marker becomes a single header line", () => {
    const raw = `diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;
    const lines = parseUnifiedDiff(raw);
    expect(lines.map((l) => l.kind)).toEqual(["header", "header"]);
  });

  test("multiple hunks update line counters independently", () => {
    const raw = `@@ -1,1 +1,2 @@
 a
+b
@@ -10,1 +11,1 @@
-old
+new
`;
    const lines = parseUnifiedDiff(raw);
    const adds = lines.filter((l) => l.kind === "add");
    expect(adds[0].newLine).toBe(2); // first hunk
    expect(adds[1].newLine).toBe(11); // second hunk
    const rem = lines.find((l) => l.kind === "remove");
    expect(rem?.oldLine).toBe(10);
  });

  test("empty diff returns empty array", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  test("\\ No newline at end of file becomes context", () => {
    const raw = `@@ -1,1 +1,1 @@
-x
\\ No newline at end of file
+y
`;
    const lines = parseUnifiedDiff(raw);
    // The "\ No newline" marker must not vanish — keep it visible.
    expect(lines.some((l) => l.text.startsWith("\\ No newline"))).toBe(true);
  });
});
