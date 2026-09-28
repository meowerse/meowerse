import { describe, expect, it } from "vitest";
import tokens from "@meowerse/ui/tokens.json";
import type { ComponentDoc } from "./ui-api";
import {
  DEFAULT_OVERRIDES, elementProps, OVERRIDABLE, overrideCss, overrideVars, parseState, serializeState, specsFromDoc, themeClass,
  type PlayComponent,
} from "./playground-state";

const doc: ComponentDoc = {
  name: "Button", file: "src/components/Button.tsx", inherits: ["ButtonHTMLAttributes"],
  props: [
    { name: "variant", type: '"primary" | "secondary"', values: ["primary", "secondary"], required: false, default: '"secondary"' },
    { name: "loading", type: "boolean", required: false, default: "false" },
    { name: "maxRows", type: "number", required: false, default: "6" },
    { name: "onPick", type: "() => void", required: false },
    { name: "className", type: "string", required: false },
    { name: "type", type: "string", required: false, default: '"text"', inherited: true },
  ],
};
const comps: PlayComponent[] = [{ name: "Button", props: specsFromDoc(doc, { children: "save" }) }, { name: "Badge", props: specsFromDoc({ ...doc, name: "Badge" }, {}) }];

describe("playground state", () => {
  it("builds controls from the extracted props; functions, className and inherited props are left out; seeds add children", () =>
    expect(comps[0]!.props).toEqual([
      { name: "variant", kind: "enum", values: ["primary", "secondary"], default: "secondary", required: false },
      { name: "loading", kind: "boolean", values: undefined, default: false, required: false },
      { name: "maxRows", kind: "number", values: undefined, default: 6, required: false },
      { name: "children", kind: "text", default: "save", required: true },
    ]));
  it("reads a URL, ignoring anything invalid", () => {
    const s = parseState("?c=button&p.variant=primary&p.loading=1&p.maxRows=3&p.children=send&theme=light&accent=blue&radius=2&density=comfy", comps);
    expect(s).toEqual({ c: "Button", props: { variant: "primary", loading: true, maxRows: 3, children: "send" }, o: { theme: "light", accent: "blue", radius: 2, density: "comfy" } });
    const bad = parseState("?c=nope&p.variant=hack&p.loading=yes&p.maxRows=x&theme=pink&radius=9", comps);
    expect(bad).toEqual({ c: "Button", props: { variant: "secondary", loading: false, maxRows: 6, children: "save" }, o: DEFAULT_OVERRIDES });
  });
  it("writes only what differs from the defaults, and round-trips", () => {
    const s = parseState("?c=button&p.variant=primary&radius=0", comps);
    expect(serializeState(s, comps)).toBe("?c=button&p.variant=primary&radius=0");
    expect(parseState(serializeState(s, comps), comps)).toEqual(s);
    expect(serializeState(parseState("", comps), comps)).toBe("?c=button");
  });
  it("passes required props always and others only when set", () =>
    expect(elementProps(comps[0]!, parseState("?c=button&p.variant=primary", comps))).toEqual({ variant: "primary", children: "save" }));
  it("turns overrides into scoped custom properties from the tokens", () => {
    expect(overrideVars(DEFAULT_OVERRIDES)).toEqual({});
    const v = overrideVars({ theme: "dark", accent: "amber", radius: 2, density: "compact" });
    expect(v["--c-accent-fill"]).toBe(tokens.semantic.dark.warn);
    expect(v["--r-m"]).toBe(`${tokens.radius.m * 2}px`);
    expect(v["--sp-4"]).toBe(`${tokens.space[4]! * 0.75}px`);
    for (const k of Object.keys(v)) expect(OVERRIDABLE).toContain(k);
    expect(overrideCss(DEFAULT_OVERRIDES)).toBe("");
    expect(overrideCss({ ...DEFAULT_OVERRIDES, radius: 0 })).toBe(".my-scope {\n  --r-s: 0px;\n  --r-m: 0px;\n  --r-l: 0px;\n}");
    expect(themeClass("system")).toBeUndefined();
    expect(themeClass("light")).toBe("mw-theme--light");
  });
});
