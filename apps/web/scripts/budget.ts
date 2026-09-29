// Enforces the byte budgets on dist/ (bun run budget, after bun run build). Prints every figure; exit 1 on any breach.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BUDGETS, dynamicTargets, gz, pageAssets, staticClosure } from "../src/lib/budget";

const dist = join(process.cwd(), "dist");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(dist).map((f) => relative(dist, f).split("\\").join("/"));
const text = (p: string) => (existsSync(join(dist, p)) ? readFileSync(join(dist, p), "utf8") : undefined);
const size = (p: string) => statSync(join(dist, p)).size;
const gzOf = (ps: Iterable<string>) => [...ps].reduce((n, p) => n + gz(readFileSync(join(dist, p))), 0);
// React's error-URL helper (react-dom) or its element symbol (the JSX runtime): either one means React shipped.
const REACT = /react\.dev\/errors|react\.transitional\.element/;
const gzText = (s: string) => (s ? gz(s) : 0); // no inline code on the page costs nothing, not gzip's 20-byte header

type Row = { name: string; value: number; max: number; where?: string };
const rows: Row[] = [];
const problems: string[] = [];
// Each row names the worst real page; a row that measured no page at all is a broken gate, not a pass.
const worst = (name: string, max: number, per: [string, number][]) => {
  if (!per.length) { problems.push(`${name}: measured no page (the gate is broken)`); return; }
  const [where, value] = per.reduce((a, b) => (b[1] > a[1] ? b : a));
  rows.push({ name, value, max, where });
};

const pages = files.filter((f) => f.endsWith(".html"));
const critical: [string, number][] = [], allNoIsland: [string, number][] = [], island: [string, number][] = [];
const css: [string, number][] = [], html: [string, number][] = [], htmlUi: [string, number][] = [];
const preloaded: [string, number][] = [];
let islandReact = false;
for (const page of pages) {
  const src = readFileSync(join(dist, page), "utf8");
  const a = pageAssets(src);
  const initial = staticClosure(a.entries, text);
  critical.push([page, gzText(a.inlineJs) + gzOf(initial)]);
  css.push([page, gzText(a.inlineCss)]);
  (page.startsWith("ui/") ? htmlUi : html).push([page, gz(src)]);
  if (a.islands.length) {
    const closure = staticClosure(a.islands, text);
    island.push([page, gzOf(closure)]);
    for (const f of closure) if (REACT.test(text(f) ?? "")) islandReact = true;
  } else {
    const lazy = staticClosure([...dynamicTargets(initial, text)], text);
    const reach = new Set([...initial, ...lazy]);
    allNoIsland.push([page, gzText(a.inlineJs) + gzOf(reach)]);
    for (const f of reach) if (REACT.test(text(f) ?? "")) problems.push(`${page} reaches React (${f}) without an island`);
  }
  for (const f of [...a.entries, ...a.islands, ...a.preloads]) if (!files.includes(f)) problems.push(`${page} references ${f}, which isn't in dist`);
  const fonts = a.preloads.filter((p) => p.endsWith(".woff2") && files.includes(p));
  if (fonts.length) preloaded.push([page, fonts.reduce((n, p) => n + size(p), 0)]);
}
// The React check is only as good as its marker: it must find React in the islands that do ship it.
if (!islandReact) problems.push("the React marker matched no island chunk, so the no-React check can't be trusted");
worst("critical JS per page (gz)", BUDGETS.criticalJs, critical);
worst("all JS, pages without islands (gz)", BUDGETS.allJsNoIslands, allNoIsland);
worst("island JS per page (gz)", BUDGETS.islandJs, island);
worst("inline CSS per page (gz)", BUDGETS.inlineCss, css);
worst("HTML per page (gz)", BUDGETS.html, html);
worst("HTML per /ui page (gz)", BUDGETS.htmlUi, htmlUi);
worst("preloaded fonts per page (raw woff2)", BUDGETS.preloadFonts, preloaded);

// Exactly one file per expected asset: none means a renamed asset would measure 0 and pass; two means a stale copy.
const one = (label: string, re: RegExp) => {
  const hits = files.filter((f) => re.test(f));
  if (hits.length !== 1) problems.push(`${label}: expected exactly one file in dist, found ${hits.length} (${hits.join(", ") || "none"})`);
  return hits.length === 1 ? hits[0] : undefined;
};
const SITE_FONTS = ["jetbrains-mono-latin-400-normal", "jetbrains-mono-latin-700-normal", "jetbrains-mono-symbols-400", "vt323-marks"];
const woff = SITE_FONTS.flatMap((n) => one(`font ${n}`, new RegExp(`^_astro/${n}\\.[^/]+\\.woff2$`)) ?? []);
rows.push({ name: "site fonts (raw woff2)", value: woff.reduce((n, f) => n + size(f), 0), max: BUDGETS.siteFonts, where: woff.map((f) => f.replace(/^_astro\//, "")).join(" + ") });
const renderer = one("Cat3D renderer chunk", /^_astro\/renderer\.[^/]+\.js$/);
const bin = one("cat.bin", /^_astro\/cat\.[^/]+\.bin$/), poster = one("cat-poster.webp", /^_astro\/cat-poster\.[^/]+\.webp$/);
if (renderer) rows.push({ name: "Cat3D renderer chunk (gz)", value: gz(readFileSync(join(dist, renderer))), max: BUDGETS.renderer, where: renderer });
if (bin) rows.push({ name: "cat.bin (raw)", value: size(bin), max: BUDGETS.catBin, where: bin });
if (poster) rows.push({ name: "cat-poster.webp (raw)", value: size(poster), max: BUDGETS.poster, where: poster });

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
for (const r of rows) {
  const ok = r.value <= r.max;
  if (!ok) problems.push(`${r.name}: ${kb(r.value)} > ${kb(r.max)}${r.where ? ` (${r.where})` : ""}`);
  console.log(`${ok ? "ok  " : "FAIL"} ${r.name.padEnd(38)} ${kb(r.value).padStart(9)}  (budget ${kb(r.max)})${r.where ? `  ${r.where.endsWith(".html") ? "worst: " : ""}${r.where}` : ""}`);
}
if (problems.length) { console.error(`\n${problems.join("\n")}`); process.exit(1); }
