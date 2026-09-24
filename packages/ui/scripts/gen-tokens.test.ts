import { describe, expect, it } from "vitest";
import tokens from "../design/tokens.json";
import { CONTRAST_PAIRS as PAIRS } from "../src/lib/contrast";
import { contrast, gen } from "./gen-tokens";

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
  it("offers scoped theme classes so one page can show both themes side by side", () => {
    const css = gen(tokens);
    expect(css).toMatch(/\.mw-theme--dark \{[^}]*--c-bg: #0a0a0b;[^}]*color-scheme: dark;/s);
    expect(css).toMatch(/\.mw-theme--light \{[^}]*--c-bg: #e9e8e4;[^}]*color-scheme: light;/s);
  });
  it("puts the metric-matched fallback face second in --font-mono (no layout shift on swap)", () =>
    expect(gen(tokens)).toContain('--font-mono: "JetBrains Mono", "JetBrains Mono Fallback", ui-monospace'));
});
