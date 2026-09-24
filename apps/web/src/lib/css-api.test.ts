import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssApiFor, rootClasses, tokenValues } from "./css-api";
import { uiDirFrom } from "./ui-api";

const ui = uiDirFrom(process.cwd());
const read = (f: string) => readFileSync(join(ui, f), "utf8");
const css = ["components.css", "tokens.gen.css", "aliases.css"].map((f) => read(`src/styles/${f}`)) as [string, string, string];
const forFile = (f: string) => cssApiFor(read(f), ...css);

describe("css-api", () => {
  it("finds the root BEM blocks a component's source uses", () =>
    expect(rootClasses('cx("mw-btn", `mw-btn--${v}`, "mw-btn__x", "mw-brand-meow")')).toEqual(["mw-brand-meow", "mw-btn"]));
  it("reads the dark and light token values from the generated CSS", () => {
    const { dark, light } = tokenValues(css[1]);
    expect(dark.get("--c-fg")).toBe("#ededeb");
    expect(light.get("--c-fg")).toBe("#1a1a1c");
    expect(dark.get("--control-height")).toBe("44px");
  });
  it("lists the custom properties a component's rules use, with values per theme", () => {
    const btn = forFile("src/components/Button.tsx");
    expect(btn.classes).toEqual(["mw-btn"]);
    const names = btn.vars.map((v) => v.name);
    for (const n of ["--control-height", "--c-accent-fill", "--r-m", "--disabled-opacity"]) expect(names).toContain(n);
    expect(btn.vars.find((v) => v.name === "--c-accent-fill")).toMatchObject({ dark: "#00ff82" });
    expect(btn.vars.find((v) => v.name === "--control-height")!.light).toBeUndefined(); // same in both themes
    expect(forFile("src/components/StatusLine.tsx").vars.find((v) => v.name === "--c-ok")).toEqual({ name: "--c-ok", dark: "#3ddc84", light: "#11652f" });
  });
  it("shows legacy aliases for what the tokens don't define", () =>
    expect(forFile("src/components/Modal.tsx").vars.find((v) => v.name === "--shadow-lg")!.alias).toMatch(/^0 16px 40px/));
  it("ignores rules inside @media preludes and comments cleanly", () => {
    const api = cssApiFor('"mw-x"', "/* c */\n.mw-x { color: var(--c-fg); --own: 1; }\n@media (x) {\n  .mw-x:hover { color: var(--c-accent); }\n}\n.mw-xy { color: var(--nope); }", css[1], css[2]);
    expect(api.vars.map((v) => v.name)).toEqual(["--c-accent", "--c-fg"]);
    expect(api.declared).toEqual(["--own"]);
  });
  it("has no values when the generated CSS lacks the theme blocks", () => {
    const { dark, light } = tokenValues("");
    expect([dark.size, light.size]).toEqual([0, 0]);
  });
});
