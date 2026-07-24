import { describe, expect, test } from "bun:test";
import { splitUrls } from "./urlMatch";

describe("splitUrls", () => {
  test("preserves balanced parentheses that belong to the URL", () => {
    const url = "https://en.wikipedia.org/wiki/Function_(mathematics)";
    expect(splitUrls(`Read ${url}`)).toEqual([
      { kind: "text", text: "Read " },
      { kind: "url", text: url, url },
    ]);
  });

  test("peels off only the excess closing parenthesis from prose", () => {
    const url = "https://example.com/a_(b)";
    expect(splitUrls(`See (${url}).`)).toEqual([
      { kind: "text", text: "See (" },
      { kind: "url", text: url, url },
      { kind: "text", text: ")." },
    ]);
  });

  test("strips sentence punctuation and normalizes localhost links", () => {
    expect(splitUrls("Open localhost:1420, then continue.")).toEqual([
      { kind: "text", text: "Open " },
      {
        kind: "url",
        text: "localhost:1420",
        url: "http://localhost:1420",
      },
      { kind: "text", text: "," },
      { kind: "text", text: " then continue." },
    ]);
  });
});
