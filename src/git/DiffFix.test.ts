import { describe, expect, it } from "bun:test";
import { composeFixPrompt, type HunkRef } from "./DiffFix";

const hunk = (over: Partial<HunkRef>): HunkRef => ({
  id: "src/foo.ts#0",
  file: "src/foo.ts",
  label: "",
  snippet: "@@ -1,2 +1,2 @@\n-old\n+new",
  ...over,
});

describe("composeFixPrompt", () => {
  it("pairs each request with its diff snippet inside a fenced block", () => {
    const prompt = composeFixPrompt([
      { ref: hunk({ label: "fn handleClick" }), text: "rename to onSelect" },
    ]);
    expect(prompt).toContain("### Change 1 — src/foo.ts (in fn handleClick)");
    expect(prompt).toContain("```diff\n@@ -1,2 +1,2 @@\n-old\n+new\n```");
    expect(prompt).toContain("Requested: rename to onSelect");
    expect(prompt).toContain("Make these edits now.");
  });

  it("omits the scope suffix when the hunk has no label", () => {
    const prompt = composeFixPrompt([{ ref: hunk({}), text: "handle null" }]);
    expect(prompt).toContain("### Change 1 — src/foo.ts\n");
    expect(prompt).not.toContain("(in ");
  });

  it("numbers multiple changes in order", () => {
    const prompt = composeFixPrompt([
      { ref: hunk({ id: "a#0", file: "a.ts" }), text: "first" },
      { ref: hunk({ id: "b#0", file: "b.ts" }), text: "second" },
    ]);
    expect(prompt).toContain("### Change 1 — a.ts");
    expect(prompt).toContain("### Change 2 — b.ts");
    expect(prompt.indexOf("Change 1")).toBeLessThan(prompt.indexOf("Change 2"));
  });

  it("trims surrounding whitespace from the user's request", () => {
    const prompt = composeFixPrompt([
      { ref: hunk({}), text: "  spaced out  \n" },
    ]);
    expect(prompt).toContain("Requested: spaced out");
  });
});
