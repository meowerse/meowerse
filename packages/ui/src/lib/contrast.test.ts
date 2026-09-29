import { describe, expect, it } from "vitest";
import tokens from "../../design/tokens.json";
import { CONTRAST_PAIRS, contrast } from "./contrast";

describe("contrast", () => {
  it("is 21 for black on white and 1 for a colour on itself", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#00ff82", "#00ff82")).toBe(1);
  });
  it("doesn't depend on argument order", () =>
    expect(contrast("#0a6e3c", "#e9e8e4")).toBeCloseTo(contrast("#e9e8e4", "#0a6e3c"), 10));
  it("pairs name only real semantic tokens, with an AA minimum", () => {
    expect(CONTRAST_PAIRS.length).toBe(23);
    for (const [fg, bg, min] of CONTRAST_PAIRS) {
      expect(tokens.semantic.dark).toHaveProperty(fg);
      expect(tokens.semantic.dark).toHaveProperty(bg);
      expect([3, 4.5]).toContain(min);
    }
  });
});
