import { describe, expect, it } from "vitest";
import { cx } from "./cx";

describe("cx", () => {
  it("joins truthy strings, drops falsy", () => {
    expect(cx("a", false, "b", undefined, null, "c")).toBe("a b c");
  });
  it("returns empty string when all falsy", () => {
    expect(cx(false, undefined)).toBe("");
  });
});
