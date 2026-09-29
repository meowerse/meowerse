import { describe, expect, it } from "vitest";
import tokens from "@meowerse/ui/tokens.json";
import { extractUiApi, uiDirFrom, type ComponentDoc } from "./ui-api";
import { SEEDS } from "../ui-docs/playground/seeds";
import {
  clampNumber, DEFAULT_OVERRIDES, elementProps, OVERRIDABLE, overrideCss, overrideVars, parseState, serializeState, specsFromDoc, TEXT_MAX, themeClass,
  type PlayComponent, type PropSpec,
} from "./playground-state";

// Built once at collection time (like ui-api.test.ts and registry.test.ts): a full TypeScript
// program over packages/ui is seconds of CPU, which the 5 s per-test timeout can't absorb when the
// whole monorepo runs its suites in parallel.
const realApi = extractUiApi(uiDirFrom(process.cwd()));

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
      { name: "variant", kind: "enum", values: ["primary", "secondary"], default: "secondary", componentDefault: "secondary", required: false },
      { name: "loading", kind: "boolean", values: undefined, default: false, componentDefault: false, required: false },
      { name: "maxRows", kind: "number", values: undefined, default: 6, componentDefault: 6, required: false, min: 1, max: 20 },
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
    for (const [name, seed] of Object.entries(SEEDS)) {
      const realDoc = realApi.components.find((c) => c.name === name)!;
      const names = specsFromDoc(realDoc, seed).map((s) => s.name);
      for (const denied of ["href", "src", "action", "formAction"]) expect(names, `${name}.${denied}`).not.toContain(denied);
    }
  });

  describe("an empty string is a real value (regression: clearing Prompt's value blanked the whole playground)", () => {
    // The real Prompt and Avatar, from the extracted TypeScript props and their seeds.
    const real = (name: string): PlayComponent => ({ name, props: specsFromDoc(realApi.components.find((c) => c.name === name)!, SEEDS[name]!) });
    const prompt = real("Prompt"), avatar = real("Avatar"), card = real("Card"), spinner = real("Spinner"), badge = real("Badge");
    const all = [prompt, avatar, card, spinner, badge];

    it("a required text prop cleared to \"\" is still passed, as \"\" (never left out, never undefined)", () => {
      const s = parseState("?c=prompt", all);
      expect(elementProps(prompt, { ...s, props: { ...s.props, value: "" } })).toEqual({ label: "message", value: "" });
      const a = parseState("?c=avatar", all);
      expect(elementProps(avatar, { ...a, props: { ...a.props, name: "" } })).toEqual({ name: "" });
      expect(elementProps(avatar, { ...a, props: { ...a.props, name: "   " } })).toEqual({ name: "   " });
    });
    it("an optional text prop cleared to \"\" means unset: it's left out, so the component's own default applies", () => {
      const s = parseState("?c=prompt&p.sendLabel=&p.placeholder=", all);
      expect(s.props.sendLabel).toBe("");
      expect(elementProps(prompt, s)).toEqual({ label: "message", value: "see you at 7" });
      expect(elementProps(spinner, parseState("?c=spinner&p.label=", all))).toEqual({});
      expect(elementProps(badge, parseState("?c=badge&p.icon=", all))).toEqual({ children: "verified" });
      // ...but whitespace is a value like any other, and is passed through as typed.
      expect(elementProps(prompt, parseState("?c=prompt&p.sendLabel=%20", all))).toMatchObject({ sendLabel: " " });
    });
    it("a seeded optional prop is passed while it holds the seed (Card's title isn't Card's default), and left out once cleared", () => {
      expect(elementProps(card, parseState("?c=card", all))).toEqual({ title: "profile", children: "signed in as alxnko." });
      expect(elementProps(card, parseState("?c=card&p.title=", all))).toEqual({ children: "signed in as alxnko." });
    });
    it("an optional prop equal to the component's own default is left out; anything else is passed", () => {
      expect(elementProps(prompt, parseState("?c=prompt&p.maxRows=6&p.busy=0&p.enterSends=auto", all))).toEqual({ label: "message", value: "see you at 7" });
      expect(elementProps(prompt, parseState("?c=prompt&p.maxRows=1&p.busy=1&p.enterSends=never", all)))
        .toEqual({ label: "message", value: "see you at 7", maxRows: 1, busy: true, enterSends: "never" });
      // An optional boolean with no declared default: false is the same as leaving it out.
      const bare: PlayComponent = { name: "X", props: [{ name: "on", kind: "boolean", default: false, required: false }] };
      expect(elementProps(bare, { c: "X", props: { on: false }, o: DEFAULT_OVERRIDES })).toEqual({});
      expect(elementProps(bare, { c: "X", props: { on: true }, o: DEFAULT_OVERRIDES })).toEqual({ on: true });
    });
    it("the URL round-trips \"\": p.value= reloads as \"\", not as the seed", () => {
      const s = parseState("?c=prompt", all);
      const cleared = { ...s, props: { ...s.props, value: "", sendLabel: "" } };
      const q = serializeState(cleared, all);
      expect(q).toBe("?c=prompt&p.value=&p.sendLabel=");
      expect(parseState(q, all)).toEqual(cleared);
      expect(parseState("?c=avatar&p.name=", all).props.name).toBe("");
      expect(parseState("?c=avatar&p.name=%20%20", all).props.name).toBe("  ");
    });
    it("long text is capped at TEXT_MAX both ways, so what reloads is what was typed (the island's control has the same maxLength)", () => {
      const long = "x".repeat(TEXT_MAX + 50);
      expect(parseState(`?c=avatar&p.name=${long}`, all).props.name).toBe("x".repeat(TEXT_MAX));
      const s = parseState(`?c=avatar&p.name=${"y".repeat(TEXT_MAX)}`, all);
      expect(parseState(serializeState(s, all), all)).toEqual(s);
    });
  });
});
