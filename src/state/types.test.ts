import { describe, expect, test } from "bun:test";
import { applyBranchPrefix } from "./types";

describe("applyBranchPrefix", () => {
  test("uses a sanitized GitHub username", () => {
    expect(applyBranchPrefix("feature", "github", "@raeed-z", "")).toBe(
      "raeed-z/feature",
    );
  });

  test("removes dot forms that Git rejects as ref components", () => {
    expect(applyBranchPrefix("feature", "custom", "", ".")).toBe("feature");
    expect(applyBranchPrefix("feature", "custom", "", "..lock")).toBe(
      "lock/feature",
    );
    expect(applyBranchPrefix("feature", "custom", "", ".hidden.team")).toBe(
      "hidden-team/feature",
    );
  });

  test("falls back to the bare branch when the prefix has no safe characters", () => {
    expect(applyBranchPrefix("feature", "custom", "", "@...///")).toBe(
      "feature",
    );
  });

  test("none mode leaves the branch untouched", () => {
    expect(applyBranchPrefix("feature", "none", "owner", "custom")).toBe(
      "feature",
    );
  });
});
