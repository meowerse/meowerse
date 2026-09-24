import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "components.css"), "utf8");
const rule = (sel: string) => {
  const m = css.match(new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`missing rule ${sel}`);
  return m[2];
};

describe("B10 geometry: tty and app controls share one shape", () => {
  it.each([".mw-btn--md", ".mw-field input", ".mw-prompt textarea"])("%s is control-height tall", (sel) =>
    expect(rule(sel)).toMatch(/min-height:\s*var\(--control-height\)/));
  it.each([".mw-btn", ".mw-field input", ".mw-prompt textarea", ".mw-prompt__send"])("%s uses --r-m", (sel) =>
    expect(rule(sel)).toMatch(/border-radius:\s*var\(--r-m\)/));
  it.each([".mw-field input", ".mw-prompt textarea"])("%s has a 1px line-input border and 16px text", (sel) => {
    expect(rule(sel)).toMatch(/border:\s*1px solid var\(--c-line-input\)/);
    expect(rule(sel)).toMatch(/font-size:\s*var\(--fs-4\)/);
  });
  // (?!\s) stops \s* from backtracking over the space, which would let the lookahead see " var(" and flag every value.
  const offScaleRadius = /border-radius:\s*(?!\s)(?!var\(--r-[slm]\)|50%|0[;\s])[^;]+;/;
  it("the off-scale radius check flags bad values and accepts on-scale ones", () => {
    expect(offScaleRadius.test("a { border-radius: 10px; }")).toBe(true);
    expect(offScaleRadius.test("a { border-radius: 999px; }")).toBe(true);
    for (const ok of ["var(--r-s)", "var(--r-m)", "var(--r-l)", "50%", "0"])
      expect(offScaleRadius.test(`a { border-radius: ${ok}; }`)).toBe(false);
  });
  it("no hard-coded colours, sub-pixel borders, or off-scale radii", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/0\.5px/);
    expect(css).not.toMatch(offScaleRadius);
  });
  it("disabled looks the same everywhere", () => {
    expect(rule(".mw-btn:disabled")).toMatch(/opacity:\s*var\(--disabled-opacity\)/);
  });
});
