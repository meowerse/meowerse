// The playground island (client:only — it reads location.search on mount, which never exists during
// Astro's server prerender). Props and token overrides live in the URL (replaceState), the overrides
// are set on the preview element through the CSSOM (never a style attribute, CSP), and nothing is
// ever sent anywhere.
import { createElement, useEffect, useRef, useState } from "react";
import { Button, Checkbox, Field, RadioGroup, contrast } from "@meowerse/ui";
import tokens from "@meowerse/ui/tokens.json";
import { toJsx } from "../../lib/jsx";
import {
  ACCENTS, clampNumber, DEFAULT_OVERRIDES, elementProps, OVERRIDABLE, overrideCss, overrideVars, parseState, serializeState, themeClass,
  type Accent, type Density, type Overrides, type PlayComponent, type PlayState, type Scalar, type Theme,
} from "../../lib/playground-state";
import { PLAYABLE } from "./playable";

export default function Playground({ components }: { components: PlayComponent[] }) {
  const [state, setState] = useState<PlayState>(() => parseState(location.search, components));
  const [note, setNote] = useState("");
  const stage = useRef<HTMLDivElement>(null);
  const comp = components.find((c) => c.name === state.c) ?? components[0]!;
  const play = PLAYABLE[comp.name]!;

  useEffect(() => { history.replaceState(history.state, "", `${location.pathname}${serializeState(state, components)}`); }, [state, components]);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    for (const k of OVERRIDABLE) el.style.removeProperty(k);
    for (const [k, v] of Object.entries(overrideVars(state.o))) el.style.setProperty(k, v);
  }, [state.o]);
  useEffect(() => { stage.current?.closest("[data-playground]")?.setAttribute("data-ready", ""); }, []);

  // A short, discrete `role=status` message for a whole-panel change (switching components,
  // resetting tokens, copying a link) — not a per-keystroke prop edit, and not `aria-live` on the
  // whole stage (that re-announced every keystroke, nested inside components' own status regions,
  // and still said nothing about a token change). Cleared first, on its own commit, so a second
  // identical message (e.g. "link copied" twice in a row) still mutates the region and gets
  // re-announced — same text set twice in one render never would.
  const announce = (msg: string) => { setNote(""); requestAnimationFrame(() => setNote(msg)); };

  const setProp = (name: string, v: Scalar) => setState((s) => ({ ...s, props: { ...s.props, [name]: v } }));
  const setO = <K extends keyof Overrides>(k: K, v: Overrides[K]) => setState((s) => ({ ...s, o: { ...s.o, [k]: v } }));
  const pick = (name: string) => {
    const next = components.find((c) => c.name === name)!;
    setState((s) => ({ c: name, props: Object.fromEntries(next.props.map((p) => [p.name, p.default])), o: s.o }));
    announce(`showing ${name}`);
  };
  const resetTokens = () => { setState((s) => ({ ...s, o: DEFAULT_OVERRIDES })); announce("tokens reset"); };
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(location.href); announce("link copied"); }
    catch { announce("couldn't copy — copy the address bar instead"); }
  };

  const element = createElement(play.component, { ...elementProps(comp, state), ...play.fixed });
  const css = overrideCss(state.o);
  // toJsx names an element from its component function's name/displayName (lib/jsx.ts), which every
  // other caller runs at build time in Astro frontmatter, where names survive untouched. Here it runs
  // in the shipped, minified island bundle, where a production minifier can rename or drop a
  // component's function name entirely. A plain string "type" is never renamed (toJsx's nameOf()
  // returns a string type as-is), and it doesn't matter that createElement never actually mounts this
  // one — it exists only to be serialised, not rendered — so the snippet's name can't go stale either
  // way. play.fixed (the noop onChange/onSubmit the preview needs) is left out on purpose: a real
  // caller supplies its own handlers, so the copyable snippet shouldn't show ours.
  const snippet = `import { ${comp.name} } from "@meowerse/ui";\n\n${toJsx(createElement(comp.name, elementProps(comp, state)))}${css ? `\n\n/* the token overrides, scoped to a wrapper */\n${css}` : ""}`;

  return (
    <div className="pg">
      <div className="pg__controls">
        <label className="pg-select"><span>component</span>
          <select value={comp.name} onChange={(e) => pick(e.target.value)}>{components.map((c) => <option key={c.name}>{c.name}</option>)}</select>
        </label>
        <fieldset className="pg__group">
          <legend>props</legend>
          {comp.props.map((p) => p.kind === "enum" ? (
            <label key={p.name} className="pg-select"><span>{p.name}</span>
              <select value={String(state.props[p.name])} onChange={(e) => setProp(p.name, e.target.value)}>{p.values!.map((v) => <option key={v}>{v}</option>)}</select>
            </label>
          ) : p.kind === "boolean" ? (
            <Checkbox key={p.name} label={p.name} checked={state.props[p.name] === true} onChange={(e) => setProp(p.name, e.target.checked)} />
          ) : (
            <Field key={p.name} label={p.name} type={p.kind === "number" ? "number" : "text"} value={String(state.props[p.name] ?? "")}
              min={p.kind === "number" ? p.min : undefined} max={p.kind === "number" ? p.max : undefined}
              onChange={(e) => setProp(p.name, p.kind === "number" ? clampNumber(p, Number(e.target.value)) : e.target.value)} />
          ))}
        </fieldset>
        <fieldset className="pg__group">
          <legend>tokens (this preview only)</legend>
          <RadioGroup name="pg-theme" legend="theme" value={state.o.theme} onChange={(v) => setO("theme", v as Theme)}
            options={[{ label: "follow the system", value: "system" }, { label: "dark", value: "dark" }, { label: "light", value: "light" }]} />
          <RadioGroup name="pg-accent" legend="accent fill" value={state.o.accent} onChange={(v) => setO("accent", v as Accent)}
            options={(Object.keys(ACCENTS) as Accent[]).map((a) => ({ label: a, value: a, hint: `text on it: ${contrast(tokens.semantic.dark.onAccent, ACCENTS[a]).toFixed(1)}:1` }))} />
          <RadioGroup name="pg-radius" legend="radius scale" value={String(state.o.radius)} onChange={(v) => setO("radius", Number(v) as 0 | 1 | 2)}
            options={[{ label: "sharp (×0)", value: "0" }, { label: "default (×1)", value: "1" }, { label: "round (×2)", value: "2" }]} />
          <RadioGroup name="pg-density" legend="density" value={state.o.density} onChange={(v) => setO("density", v as Density)}
            options={[{ label: "compact", value: "compact" }, { label: "normal", value: "normal" }, { label: "comfy", value: "comfy" }]} />
          <Button onClick={resetTokens}>reset tokens</Button>
        </fieldset>
      </div>
      <div className="pg__out">
        <div ref={stage} className={["pg__stage", themeClass(state.o.theme)].filter(Boolean).join(" ")} data-preview>{element}</div>
        <p className="mw-muted">Overrides apply to this preview only and live in the address, never on a server.</p>
        <pre className="pg__code" tabIndex={0}><code>{snippet}</code></pre>
        <div className="btn-row">
          <Button onClick={() => void copyLink()}>copy a link to this setup</Button>
          <span role="status" className="mw-muted">{note}</span>
        </div>
      </div>
    </div>
  );
}
