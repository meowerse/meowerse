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
  it("no hard-coded colours, sub-pixel borders, or off-scale radii", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/0\.5px/);
    expect(css).not.toMatch(/border-radius:\s*(?!var\(--r-[slm]\)|50%|0)[^;]+;/);
  });
  it("disabled looks the same everywhere", () => {
    expect(rule(".mw-btn:disabled")).toMatch(/opacity:\s*var\(--disabled-opacity\)/);
  });
});
