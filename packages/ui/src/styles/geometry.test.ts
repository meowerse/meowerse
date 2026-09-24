import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "components.css"), "utf8");
const rule = (sel: string) => {
  const m = css.match(new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`missing rule ${sel}`);
  return m[2] ?? "";
};

// Every hand-written stylesheet. tokens.gen.css is where colours live; aliases.css is the legacy bridge.
const authored = readdirSync(__dirname)
  .filter((f) => f.endsWith(".css") && f !== "tokens.gen.css" && f !== "aliases.css")
  .map((f) => ({ f, src: readFileSync(join(__dirname, f), "utf8") }));

/** Hard-coded colour literals, ignoring the allow-listed --cat-color declaration. */
const colourLiterals = (src: string) =>
  src.replace(/--cat-color\s*:[^;]*;/g, "").match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi) ?? [];

/** Radius declarations (shorthand or longhand) with any value outside --r-s/m/l, 50%, 0. */
const RADIUS_OK = new Set(["var(--r-s)", "var(--r-m)", "var(--r-l)", "50%", "0"]);
const offScaleRadii = (src: string) =>
  [...src.matchAll(/border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius\s*:\s*([^;}]+)/g)]
    .filter((m) => (m[1] ?? "").trim().split(/[\s/]+/).some((v) => !RADIUS_OK.has(v)))
    .map((m) => m[0]);

/** A rule body reaches a 44px target in both axes. */
const is44 = (body: string) =>
  /(?:^|[;\s])(?:min-)?width:\s*(?:44px|var\(--control-height\))/.test(body) &&
  /(?:^|[;\s])(?:min-)?height:\s*(?:44px|var\(--control-height\))/.test(body);

/** A rule with :active and a transform that sits outside a prefers-reduced-motion: no-preference block. */
const NO_PREF = /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g;
const activeTransformOutsideNoPref = (src: string) =>
  /:active[^{]*\{[^}]*transform/.test(src.replace(NO_PREF, ""));

describe("B10 geometry: tty and app controls share one shape", () => {
  it.each([".mw-btn--md", ".mw-field input", ".mw-prompt textarea"])("%s is control-height tall", (sel) =>
    expect(rule(sel)).toMatch(/min-height:\s*var\(--control-height\)/));
  it.each([".mw-btn", ".mw-field input", ".mw-prompt textarea", ".mw-prompt__send"])("%s uses --r-m", (sel) =>
    expect(rule(sel)).toMatch(/border-radius:\s*var\(--r-m\)/));
  it.each([".mw-field input", ".mw-prompt textarea"])("%s has a 1px line-input border and 16px text", (sel) => {
    expect(rule(sel)).toMatch(/border:\s*1px solid var\(--c-line-input\)/);
    expect(rule(sel)).toMatch(/font-size:\s*var\(--fs-4\)/);
  });

  it("the guards themselves catch bad input and accept good input", () => {
    expect(colourLiterals("a { color: #fff; }")).toHaveLength(1);
    expect(colourLiterals("a { background: rgba(0,0,0,.5); }")).toHaveLength(1);
    expect(colourLiterals("a { color: hsl(0 0% 0%); }")).toHaveLength(1);
    expect(colourLiterals("a { --cat-color: #00ff82; color: var(--c-fg); }")).toHaveLength(0);
    expect(offScaleRadii("a { border-radius: 10px; }")).toHaveLength(1);
    expect(offScaleRadii("a { border-radius: 999px; }")).toHaveLength(1);
    expect(offScaleRadii("a { border-radius: 0 10px; }")).toHaveLength(1);
    expect(offScaleRadii("a { border-top-left-radius: 3px; }")).toHaveLength(1);
    for (const ok of ["var(--r-s)", "var(--r-m)", "var(--r-l)", "50%", "0", "var(--r-m) 0"])
      expect(offScaleRadii(`a { border-radius: ${ok}; }`)).toHaveLength(0);
    expect(is44("width: 40px; height: 40px;")).toBe(false);
    expect(is44("min-width: 44px; line-height: 44px;")).toBe(false);
    expect(is44("width: 44px; height: var(--control-height);")).toBe(true);
    expect(activeTransformOutsideNoPref(".mw-btn:active { transform: scale(.98); }")).toBe(true);
    expect(activeTransformOutsideNoPref(
      "@media (prefers-reduced-motion: no-preference) {\n  .mw-btn:active { transform: scale(.98); }\n}")).toBe(false);
  });

  it.each(authored.map((a) => [a.f, a.src]))("%s has no hard-coded colours", (_f, src) =>
    expect(colourLiterals(src)).toEqual([]));
  it.each(authored.map((a) => [a.f, a.src]))("%s has only on-scale radii", (_f, src) =>
    expect(offScaleRadii(src)).toEqual([]));
  it("components.css has no sub-pixel borders", () => expect(css).not.toMatch(/0\.5px/));

  it.each([".mw-code__copy", ".mw-alert__x", ".mw-header__burger", ".mw-themetoggle", ".mw-contacts__link",
    ".mw-field__reveal"])("%s is a 44px target", (sel) => expect(is44(rule(sel))).toBe(true));
  it(".mw-btn--sm reaches 44x44 through a -4px ::after on every side", () => {
    expect(rule(".mw-btn--sm")).toMatch(/min-height:\s*36px/);
    expect(rule(".mw-btn--sm")).toMatch(/min-width:\s*36px/);
    expect(rule(".mw-btn--sm::after")).toMatch(/inset:\s*-4px;/);
    expect(rule(".mw-btn")).toMatch(/position:\s*relative/);
  });

  it.each([".mw-btn:disabled", ".mw-check:has(input:disabled)", ".mw-field input:disabled",
    '.mw-prompt__send[aria-disabled="true"]'])("%s uses the shared disabled opacity", (sel) =>
    expect(rule(sel)).toMatch(/opacity:\s*var\(--disabled-opacity\)/));

  it("the :active press scale only runs without reduced motion", () => {
    expect(activeTransformOutsideNoPref(css)).toBe(false);
    expect(css.match(NO_PREF)?.join("")).toMatch(/\.mw-btn[^{]*:active\s*\{[^}]*transform:\s*scale/);
  });
});
