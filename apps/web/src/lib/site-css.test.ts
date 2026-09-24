import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// site.css is inlined on every page: it must follow the same token rules as @meowerse/ui's own CSS.
const css = readFileSync(join(__dirname, "../styles/site.css"), "utf8");
const RADII = new Set(["var(--r-s)", "var(--r-m)", "var(--r-l)", "50%", "0"]);

describe("site.css uses tokens only", () => {
  it("has no colour literals", () => expect(css.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi) ?? []).toEqual([]));
  it("has only on-scale radii", () => {
    const bad = [...css.matchAll(/border(?:-[a-z]+)*-radius\s*:\s*([^;}]+)/g)]
      .filter((m) => (m[1] ?? "").trim().split(/[\s/]+/).some((v) => !RADII.has(v))).map((m) => m[0]);
    expect(bad).toEqual([]);
  });
  it("never transforms case (B14)", () => expect(css).not.toMatch(/text-transform\s*:\s*(lower|upper|capital)/));
  it("has no sub-pixel lines", () => expect(css).not.toMatch(/0\.5px/));
});
