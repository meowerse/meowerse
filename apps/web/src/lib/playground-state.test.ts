import { describe, expect, it } from "vitest";
import tokens from "@meowerse/ui/tokens.json";
import { extractUiApi, uiDirFrom, type ComponentDoc } from "./ui-api";
import { SEEDS } from "../ui-docs/playground/seeds";
import {
  clampNumber, DEFAULT_OVERRIDES, elementProps, OVERRIDABLE, overrideCss, overrideVars, parseState, serializeState, specsFromDoc, themeClass,
  type PlayComponent, type PropSpec,
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
      { name: "maxRows", kind: "number", values: undefined, default: 6, required: false, min: 1, max: 20 },
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
  it("clamps a number prop to its range, rounds it to an integer, and drops NaN/Infinity to the default", () => {
    expect(parseState("?c=button&p.maxRows=3.6", comps).props.maxRows).toBe(4);
    expect(parseState("?c=button&p.maxRows=999", comps).props.maxRows).toBe(20);
    expect(parseState("?c=button&p.maxRows=-5", comps).props.maxRows).toBe(1);
    expect(parseState("?c=button&p.maxRows=0", comps).props.maxRows).toBe(1);
    expect(parseState("?c=button&p.maxRows=abc", comps).props.maxRows).toBe(6);
    expect(parseState("?c=button&p.maxRows=Infinity", comps).props.maxRows).toBe(6);
    expect(parseState("?c=button&p.maxRows=-Infinity", comps).props.maxRows).toBe(6);
    expect(parseState("?c=button&p.maxRows=NaN", comps).props.maxRows).toBe(6);
  });
  it("clampNumber falls back to the range's minimum for a non-finite input (NaN or either infinity), for a prop with no known range", () => {
    const spec: PropSpec = { name: "n", kind: "number", default: 0, required: false };
    expect(clampNumber(spec, NaN)).toBe(0);
    expect(clampNumber(spec, Infinity)).toBe(0);
    expect(clampNumber(spec, -Infinity)).toBe(0);
    expect(clampNumber(spec, 2.4)).toBe(2);
    expect(clampNumber(spec, 2.5)).toBe(3);
    expect(clampNumber({ ...spec, min: 5, max: 10 }, NaN)).toBe(5);
  });
  it("never turns a URL-valued prop (href, src, action, formAction) into a control, seeded or not", () => {
    const urlDoc: ComponentDoc = {
      name: "Link", file: "x.tsx", inherits: [],
      props: [
        { name: "href", type: "string", required: false, default: '"/"' },
        { name: "src", type: "string", required: false },
        { name: "action", type: "string", required: false },
        { name: "formAction", type: "string", required: false },
        { name: "label", type: "string", required: false, default: '"go"' },
      ],
    };
    expect(specsFromDoc(urlDoc, {}).map((s) => s.name)).toEqual(["label"]);
    // A seed can't smuggle one back in either (specsFromDoc's second pass adds seed-only names).
    expect(specsFromDoc(urlDoc, { href: "https://evil.example/", label: "hi" }).map((s) => s.name)).toEqual(["label"]);
    // A hostile value can't reach the URL either way: it's simply never a key parseState reads.
    const denyComps: PlayComponent[] = [{ name: "Link", props: specsFromDoc(urlDoc, {}) }];
    expect(parseState("?c=link&p.href=https://evil.example/&p.label=hi", denyComps).props).toEqual({ label: "hi" });
  });
  it("drops href/src/action/formAction for every real, seeded playground component (the Wordmark.href case)", () => {
    const api = extractUiApi(uiDirFrom(process.cwd()));
    for (const [name, seed] of Object.entries(SEEDS)) {
      const realDoc = api.components.find((c) => c.name === name)!;
      const names = specsFromDoc(realDoc, seed).map((s) => s.name);
      for (const denied of ["href", "src", "action", "formAction"]) expect(names, `${name}.${denied}`).not.toContain(denied);
    }
  });
});
