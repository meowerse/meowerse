// The CSS custom properties a component's rules use, with their dark/light values from the generated
// tokens, read at build time from packages/ui/src/styles so the table can't drift (spec §5.2).
export type CssVar = { name: string; dark?: string; light?: string; alias?: string };
export type CssApi = { classes: string[]; vars: CssVar[]; declared: string[] };

/** Root BEM blocks a component's source uses: "mw-btn--primary", "mw-btn__x", `mw-btn--${v}` → "mw-btn". */
export function rootClasses(source: string): string[] {
  return [...new Set([...source.matchAll(/\bmw-[a-z0-9]+(?:-[a-z0-9]+)*/g)].map((m) => m[0]))].sort();
}

/** `--name: value;` pairs of the first top-level block with exactly this selector. */
function block(css: string, selector: string): Map<string, string> {
  const out = new Map<string, string>();
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return out;
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

export function tokenValues(tokensGenCss: string): { dark: Map<string, string>; light: Map<string, string> } {
  return { dark: block(tokensGenCss, ":root"), light: block(tokensGenCss, ':root[data-theme="light"]') };
}

/** Innermost `selector { body }` rules; comments dropped, @media preludes never glued to a selector. */
function rules(css: string): { selector: string; body: string }[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
}

export function cssApiFor(source: string, componentsCss: string, tokensGenCss: string, aliasesCss: string): CssApi {
  const classes = rootClasses(source);
  const matchers = classes.map((c) => new RegExp(`\\.${c}(?![a-z0-9])`));
  const used = new Set<string>(), declared = new Set<string>();
  for (const r of rules(componentsCss)) {
    if (!matchers.some((re) => re.test(r.selector))) continue;
    for (const m of r.body.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) used.add(m[1]!);
    for (const m of r.body.matchAll(/(?:^|[;\s])(--[a-z0-9-]+)\s*:/g)) declared.add(m[1]!);
  }
  const { dark, light } = tokenValues(tokensGenCss);
  const aliases = block(aliasesCss, ":root");
  const vars = [...used].sort().map((name): CssVar => {
    const v: CssVar = { name };
    if (dark.has(name)) v.dark = dark.get(name);
    if (light.has(name) && light.get(name) !== dark.get(name)) v.light = light.get(name);
    if (aliases.has(name)) v.alias = aliases.get(name);
    return v;
  });
  return { classes, vars, declared: [...declared].sort() };
}
