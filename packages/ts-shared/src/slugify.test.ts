import { describe, expect, test } from "bun:test";
import { slugify } from "./slugify";

describe("slugify", () => {
  test("converts spaced words to a slug", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  test("collapses punctuation and whitespace", () => {
    expect(slugify("  Meow!! __Verse  ")).toBe("meow-verse");
  });

  test("returns empty string for empty input", () => {
    expect(slugify("")).toBe("");
  });
});
