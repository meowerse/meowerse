// Bundle report for /app (report-only in PR-0): gzip -9 per JS/CSS chunk reachable from dist/app/index.html, the
// eager closure (renderer + island + their static imports) and the total of all built JS.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const gz = (b: Uint8Array) => gzipSync(b, { level: 9 }).length;
export type Chunk = { file: string; raw: number; gzip: number };
export type BundleReport = { eagerJs: Chunk[]; eagerJsGzip: number; eagerJsRaw: number; css: Chunk[]; cssGzip: number; allJsGzip: number; allJs: Chunk[]; htmlGzip: number; fontsPreloadedBytes: number };

export function bundleReport(dist: string): BundleReport {
  const html = readFileSync(join(dist, "app", "index.html"), "utf8");
  const read = (p: string) => readFileSync(join(dist, p.replace(/^\//, "")));
  const entries = [...html.matchAll(/(?:component-url|renderer-url)="(\/_astro\/[^"]+\.js)"/g)].map((m) => m[1]!);
  const seen = new Set<string>();
  const walk = (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    const src = read(p).toString("utf8");
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']\.\/([^"']+\.js)["']/g)) walk(`/_astro/${m[1]}`);
  };
  entries.forEach(walk);
  const chunk = (p: string): Chunk => { const b = read(p); return { file: p.replace("/_astro/", ""), raw: b.length, gzip: gz(b) }; };
  const eagerJs = [...seen].map(chunk).sort((a, b) => b.gzip - a.gzip);
  const css = [...html.matchAll(/href="(\/_astro\/[^"]+\.css)"/g)].map((m) => chunk(m[1]!));
  const allJs = readdirSync(join(dist, "_astro")).filter((f) => f.endsWith(".js")).map((f) => chunk(`/_astro/${f}`)).sort((a, b) => b.gzip - a.gzip);
  const fonts = [...html.matchAll(/rel="preload"[^>]*href="([^"]+\.woff2)"/g)].reduce((n, m) => n + statSync(join(dist, m[1]!.replace(/^\//, ""))).size, 0);
  return {
    eagerJs, eagerJsGzip: eagerJs.reduce((n, c) => n + c.gzip, 0), eagerJsRaw: eagerJs.reduce((n, c) => n + c.raw, 0),
    css, cssGzip: css.reduce((n, c) => n + c.gzip, 0), allJs, allJsGzip: allJs.reduce((n, c) => n + c.gzip, 0),
    htmlGzip: gz(Buffer.from(html)), fontsPreloadedBytes: fonts,
  };
}
