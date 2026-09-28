// Byte budgets (spec §9, B26). The ceilings were set from what was measured on 2026-09-24 (plan Global
// Constraints). gzip -9 like the CDN, except fonts and binary assets (already compressed: raw bytes).
import { gzipSync } from "node:zlib";
import { posix } from "node:path";
import { inlineBlocks } from "./csp";

const KB = 1024;
export const BUDGETS = {
  criticalJs: 8 * KB, allJsNoIslands: 12 * KB, islandJs: 90 * KB, inlineCss: 14 * KB,
  html: 25 * KB, htmlUi: 40 * KB, preloadFonts: 24 * KB, siteFonts: 60 * KB,
  renderer: 3 * KB, catBin: 10 * KB, poster: 6 * KB,
} as const;

export const gz = (s: string | Uint8Array): number => gzipSync(s, { level: 9 }).length;

const strip = (url: string) => url.replace(/^\//, "");

export type PageAssets = { inlineJs: string; inlineCss: string; entries: string[]; islands: string[]; preloads: string[] };

export function pageAssets(html: string): PageAssets {
  const all = (re: RegExp) => [...html.matchAll(re)].map((m) => strip(m[1]!));
  const { scripts, styles } = inlineBlocks(html);
  return {
    inlineJs: scripts.join(""),
    inlineCss: styles.join(""),
    entries: all(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g),
    islands: [...all(/<astro-island\b[^>]*\bcomponent-url="([^"]+)"/g), ...all(/<astro-island\b[^>]*\brenderer-url="([^"]+)"/g)],
    preloads: all(/<link\b[^>]*\brel="preload"[^>]*\bhref="([^"]+)"/g),
  };
}

/** dist-relative path of an import specifier seen in a dist-relative JS file. */
export const resolveJs = (from: string, spec: string): string =>
  spec.startsWith("/") ? strip(spec) : posix.normalize(posix.join(posix.dirname(from), spec));

// Specifiers may be quoted with ", ' or ` (Rolldown writes import(`./renderer.x.js`)).
const STATIC = /(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?["'`]([^"'`]+\.js)["'`]/g;
const DYNAMIC = /\bimport\(\s*["'`]([^"'`]+\.js)["'`]\s*\)/g;

/** Files reachable through static import/export (what the browser fetches before running the entry). */
export function staticClosure(entries: string[], read: (p: string) => string | undefined): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    const src = read(f);
    if (src === undefined) continue;
    seen.add(f);
    for (const m of src.matchAll(STATIC)) stack.push(resolveJs(f, m[1]!));
  }
  return seen;
}

/** Targets of dynamic import() in these files, not already in them: the lazy part. */
export function dynamicTargets(files: Iterable<string>, read: (p: string) => string | undefined): Set<string> {
  const have = new Set(files);
  const out = new Set<string>();
  for (const f of have) for (const m of (read(f) ?? "").matchAll(DYNAMIC)) {
    const t = resolveJs(f, m[1]!);
    if (!have.has(t)) out.add(t);
  }
  return out;
}
