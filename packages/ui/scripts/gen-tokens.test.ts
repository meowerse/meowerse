import { describe, expect, it } from "vitest";
import tokens from "../design/tokens.json";
import { contrast, gen } from "./gen-tokens";

type Pair = [fg: keyof typeof tokens.semantic.dark, bg: keyof typeof tokens.semantic.dark, min: number];
// Text pairs the components actually use; min is WCAG AA (4.5 text, 3 UI/borders).
const PAIRS: Pair[] = [
  ["fg", "bg", 4.5], ["fg", "bgElev", 4.5], ["fg", "surface", 4.5], ["fg", "surfaceRaised", 4.5],
  ["fgMuted", "bg", 4.5], ["fgMuted", "surface", 4.5], ["fgSubtle", "bg", 4.5], ["fgSubtle", "surface", 4.5],
  ["accent", "bg", 4.5], ["accent", "surface", 4.5], ["onAccent", "accentFill", 4.5],
  ["danger", "bg", 4.5], ["danger", "dangerTint", 4.5], ["onDanger", "danger", 4.5],
  ["ok", "bg", 4.5], ["ok", "surface", 4.5], ["info", "bg", 4.5], ["warn", "bg", 4.5],
  ["focus", "bg", 3], ["lineInput", "bg", 3], ["lineInput", "bgElev", 3],
];

describe("tokens", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const [fg, bg, min] of PAIRS) {
      it(`${theme}: ${fg} on ${bg} ≥ ${min}`, () => {
        const t = tokens.semantic[theme];
        expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(min);
      });
    }
  }
  it("dark is the default and light is opt-in or system-light", () => {
    const css = gen(tokens);
    expect(css).toMatch(/:root \{[^}]*--c-bg: #0a0a0b;[^}]*color-scheme: dark;/s);
    expect(css).toContain(':root[data-theme="light"]');
    expect(css).toContain('@media (prefers-color-scheme: light)');
  });
  it("emits the B17 control tokens", () => {
    const css = gen(tokens);
    for (const v of ["--control-height: 44px", "--disabled-opacity: 0.5", "--z-toast: 40", "--leading-normal: 1.5"])
      expect(css).toContain(v);
  });
});
