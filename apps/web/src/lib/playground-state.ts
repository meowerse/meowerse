// Playground state (spec §5.2): component, props and token overrides, all in the URL, never on a server.
// The controls come from the extracted TypeScript props (ui-api.ts), so they can't drift either.
import tokens from "@meowerse/ui/tokens.json";
import type { ComponentDoc } from "./ui-api";

export type Scalar = string | boolean | number;
/** `default` is the control's starting value (a seed, else the component's own default); `componentDefault`
 *  is what the component itself does when the prop is left out, when it declares one — they differ for a
 *  seeded optional prop (Card's title starts as "profile", but Card has no title by default). */
export type PropSpec = {
  name: string; kind: "enum" | "boolean" | "text" | "number"; values?: string[]; default: Scalar; componentDefault?: Scalar;
  required: boolean; min?: number; max?: number;
};
export type PlayComponent = { name: string; props: PropSpec[] };
export type Theme = "system" | "dark" | "light";
export type Accent = "green" | "blue" | "amber";
export type Density = "compact" | "normal" | "comfy";
export type Overrides = { theme: Theme; accent: Accent; radius: 0 | 1 | 2; density: Density };
export type PlayState = { c: string; props: Record<string, Scalar>; o: Overrides };

export const DEFAULT_OVERRIDES: Overrides = { theme: "system", accent: "green", radius: 1, density: "normal" };
/** Fill presets from the tokens; on-accent text stays AA on each (the playground shows the ratio). */
export const ACCENTS: Record<Accent, string> = { green: tokens.semantic.dark.accentFill, blue: tokens.semantic.dark.info, amber: tokens.semantic.dark.warn };
const DENSITY: Record<Density, number> = { compact: 0.75, normal: 1, comfy: 1.25 };
const THEMES = ["system", "dark", "light"] as const;
const ACCENT_KEYS = ["green", "blue", "amber"] as const;
const DENSITIES = ["compact", "normal", "comfy"] as const;

export const OVERRIDABLE: readonly string[] = [
  "--c-accent-fill",
  ...Object.keys(tokens.radius).map((k) => `--r-${k}`),
  ...tokens.space.slice(1).map((_, i) => `--sp-${i + 1}`),
];

/** A URL-valued prop is never playable: a shared link must never be able to turn the site's own
 *  markup into a link to an attacker's page (e.g. `?c=wordmark&p.href=https://evil.example/`). This
 *  is checked by name alone, for every component, not just the one real case (Wordmark.href) — the
 *  next component with a navigable prop gets the same protection for free. */
const URL_PROPS = new Set(["href", "src", "action", "formAction"]);

/** Known safe ranges for a number control, keyed by prop name; anything else gets a generous but
 *  bounded default so a URL can't push a numeric prop (or a future one) to an absurd value. */
const NUMBER_RANGE: Record<string, { min: number; max: number }> = { maxRows: { min: 1, max: 20 } };
const DEFAULT_NUMBER_RANGE = { min: 0, max: 999 };

/** The longest text value a URL may carry; the island's text controls take no more either, so a
 *  reload restores exactly what was typed. */
export const TEXT_MAX = 200;

/** Rounds to an integer and clamps to the spec's range; NaN and ±Infinity fall back to the range's
 *  minimum rather than poisoning the result (`Math.max`/`min` both return NaN if either side is NaN).
 *  `coerce()` calls this for a URL value (already checked finite, but the fallback costs nothing);
 *  the island calls it too, so typing a number directly in the control can't exceed the same bounds
 *  or land on NaN mid-edit. */
export function clampNumber(spec: PropSpec, n: number): number {
  const min = spec.min ?? DEFAULT_NUMBER_RANGE.min;
  const max = spec.max ?? DEFAULT_NUMBER_RANGE.max;
  const safe = Number.isFinite(n) ? n : min;
  return Math.min(max, Math.max(min, Math.round(safe)));
}

function parseDefault(raw: string | undefined, kind: PropSpec["kind"]): Scalar | undefined {
  if (raw === undefined) return undefined;
  if (kind === "boolean") return raw === "true";
  if (kind === "number") return Number(raw);
  return raw.replace(/^["'`]|["'`]$/g, "");
}

/** string-literal union → select, boolean → checkbox, number → number, string/ReactNode → text. Seeds set
 * starting values, and a seed for a prop the component inherits (like children) adds a required text control. */
export function specsFromDoc(doc: ComponentDoc, seed: Record<string, Scalar>): PropSpec[] {
  const out: PropSpec[] = [];
  for (const p of doc.props) {
    if (p.inherited || p.name === "className" || URL_PROPS.has(p.name)) continue;
    const kind: PropSpec["kind"] | null = p.values ? "enum"
      : p.type === "boolean" ? "boolean"
        : p.type === "number" ? "number"
          : p.type === "string" || p.type === "ReactNode" ? "text" : null;
    if (!kind) continue;
    const fallback: Scalar = kind === "enum" ? p.values![0]! : kind === "boolean" ? false : kind === "number" ? 0 : "";
    const range = kind === "number" ? (NUMBER_RANGE[p.name] ?? DEFAULT_NUMBER_RANGE) : undefined;
    const own = parseDefault(p.default, kind);
    out.push({
      name: p.name, kind, values: p.values, default: seed[p.name] ?? own ?? fallback, required: p.required,
      ...(own !== undefined && { componentDefault: own }),
      ...(range && { min: range.min, max: range.max }),
    });
  }
  for (const [name, v] of Object.entries(seed))
    if (!URL_PROPS.has(name) && !out.some((s) => s.name === name)) out.push({ name, kind: "text", default: v, required: true });
  return out;
}

function coerce(spec: PropSpec, raw: string): Scalar | undefined {
  switch (spec.kind) {
    case "enum": return spec.values!.includes(raw) ? raw : undefined;
    case "boolean": return raw === "1" ? true : raw === "0" ? false : undefined;
    case "number": { const n = Number(raw); return raw !== "" && Number.isFinite(n) ? clampNumber(spec, n) : undefined; }
    case "text": return raw.slice(0, TEXT_MAX);
  }
}

export function parseState(search: string, comps: PlayComponent[]): PlayState {
  const q = new URLSearchParams(search);
  const comp = comps.find((c) => c.name.toLowerCase() === (q.get("c") ?? "").toLowerCase()) ?? comps[0]!;
  const props: Record<string, Scalar> = {};
  for (const spec of comp.props) {
    const raw = q.get(`p.${spec.name}`);
    props[spec.name] = (raw === null ? undefined : coerce(spec, raw)) ?? spec.default;
  }
  const pick = <T extends string>(key: string, ok: readonly T[], d: T): T => { const v = q.get(key); return v !== null && (ok as readonly string[]).includes(v) ? (v as T) : d; };
  const r = q.get("radius");
  return {
    c: comp.name, props,
    o: {
      theme: pick("theme", THEMES, DEFAULT_OVERRIDES.theme),
      accent: pick("accent", ACCENT_KEYS, DEFAULT_OVERRIDES.accent),
      radius: r === "0" ? 0 : r === "2" ? 2 : 1,
      density: pick("density", DENSITIES, DEFAULT_OVERRIDES.density),
    },
  };
}

export function serializeState(s: PlayState, comps: PlayComponent[]): string {
  const comp = comps.find((c) => c.name === s.c) ?? comps[0]!;
  const q = new URLSearchParams({ c: comp.name.toLowerCase() });
  for (const spec of comp.props) {
    const v = s.props[spec.name];
    if (v === undefined || v === spec.default) continue;
    q.set(`p.${spec.name}`, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  }
  for (const k of ["theme", "accent", "density"] as const) if (s.o[k] !== DEFAULT_OVERRIDES[k]) q.set(k, s.o[k]);
  if (s.o.radius !== DEFAULT_OVERRIDES.radius) q.set("radius", String(s.o.radius));
  return `?${q.toString()}`;
}

/** What the preview element receives — and so exactly what the snippet shows. A required prop always
 *  gets its current value, "" included: it's required, so leaving it out is never right (that handed
 *  Prompt `value={undefined}`, and its `value.trim()` took the whole playground down). An optional prop
 *  is left out when leaving it out changes nothing (it equals the component's own default, or it's an
 *  unset boolean), and an optional text prop cleared to "" means "unset": a text control can't tell
 *  "empty" from "not given", and the component's default is the useful reading of it (an empty
 *  sendLabel or Spinner label would only leave a control without a name). */
export function elementProps(comp: PlayComponent, s: PlayState): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const spec of comp.props) {
    const v = s.props[spec.name];
    if (v === undefined) continue;
    if (!spec.required) {
      if (v === spec.componentDefault || (spec.kind === "text" && v === "")) continue;
      if (spec.kind === "boolean" && spec.componentDefault === undefined && v === false) continue;
    }
    out[spec.name] = v;
  }
  return out;
}

export function overrideVars(o: Overrides): Record<string, string> {
  const out: Record<string, string> = {};
  if (o.accent !== "green") out["--c-accent-fill"] = ACCENTS[o.accent];
  if (o.radius !== 1) for (const [k, v] of Object.entries(tokens.radius)) out[`--r-${k}`] = `${v * o.radius}px`;
  if (o.density !== "normal") tokens.space.slice(1).forEach((v, i) => { out[`--sp-${i + 1}`] = `${v * DENSITY[o.density]}px`; });
  return out;
}

/** The overrides as a CSS rule to paste (scoped to a wrapper of your choice). */
export function overrideCss(o: Overrides): string {
  const lines = Object.entries(overrideVars(o)).map(([k, v]) => `  ${k}: ${v};`);
  return lines.length ? `.my-scope {\n${lines.join("\n")}\n}` : "";
}

export const themeClass = (t: Theme): string | undefined => (t === "system" ? undefined : `mw-theme--${t}`);
