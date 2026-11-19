// A prerendered page runs its scripts before the visitor is on it (see activation.ts). So any client code
// that runs probes, fetches, or opens a WebGL context must be wrapped in afterActivation(). This is a
// source-level guard: every .astro <script> block (frontmatter never ships, and may quote sample code) and
// every .tsx island naming one of these effects must also name afterActivation(.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
const EFFECTS = ["runProbes(", "attachAllCat3D(", "fetch(", "getContext("];
const GUARD = "afterActivation(";

/** Known-safe exceptions, keyed by path relative to src. Each needs a justification. Empty today. */
const ALLOWLIST: Record<string, string> = {};

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

/** Client-shipped source of a file: an .astro file's executable <script> blocks, or a whole .tsx file. */
export function clientSource(file: string, src: string): string {
  if (file.endsWith(".tsx")) return src;
  return [...src.replace(/^---\n[\s\S]*?\n---/, "").matchAll(/<script(?![^>]*\btype\s*=\s*["']application\/ld\+json)[^>]*>([\s\S]*?)<\/script\s*>/gi)]
    .map((m) => m[1] ?? "").join("\n");
}

/** The effects a client source names without guarding them; empty when fine. */
export function unguarded(body: string): string[] {
  if (body.includes(GUARD)) return [];
  return EFFECTS.filter((e) => body.includes(e));
}

/** React islands: the modules an .astro template mounts with a client:* directive. */
function islandsOf(astro: string, src: string): string[] {
  const used = new Set([...src.matchAll(/<([A-Z][\w.]*)\b[^>]*\bclient:\w+/g)].map((m) => m[1]!.split(".")[0]!));
  const out: string[] = [];
  for (const m of (/^---\n([\s\S]*?)\n---/.exec(src)?.[1] ?? "").matchAll(/^\s*import\s+([^;]*?)\bfrom\s+["'](\.[^"']+)["']/gm))
    if ([...used].some((n) => new RegExp(`\\b${n}\\b`).test(m[1]!))) {
      const base = normalize(join(dirname(astro), m[2]!));
      const hit = [base, `${base}.tsx`, join(base, "index.tsx")].find((c) => /\.tsx$/.test(c) && existsSync(c));
      if (hit) out.push(hit);
    }
  return out;
}

const astros = walk(SRC).filter((f) => f.endsWith(".astro"));
const files = [...new Set([...astros, ...astros.flatMap((f) => islandsOf(f, readFileSync(f, "utf8")))])];

describe("effectful client code runs after activation (prerender-safe)", () => {
  it.each(files.map((f) => [relative(SRC, f), f] as const))("%s", (r, f) => {
    if (r in ALLOWLIST) return;
    expect(unguarded(clientSource(f, readFileSync(f, "utf8"))), `${r} names an effect without afterActivation()`).toEqual([]);
  });

  it("sanity: the real pages and the Playground island are scanned, and the guarded pages are seen", () => {
    expect(files.map((f) => relative(SRC, f))).toContain("ui-docs/playground/Playground.tsx");
    const withEffects = files.filter((f) => EFFECTS.some((e) => clientSource(f, readFileSync(f, "utf8")).includes(e)));
    expect(withEffects.map((f) => relative(SRC, f)).sort()).toEqual(
      ["pages/index.astro", "pages/p/[slug].astro", "pages/ui/cat3d.astro", "pages/ui/patterns/together.astro"]);
  });

  it("mutation: an unguarded effect is caught, a guarded one and sample code in frontmatter are not", () => {
    for (const e of EFFECTS) {
      expect(unguarded(clientSource("x.astro", `<script>\n  ${e}x);\n</script>`)), e).toEqual([e]);
      expect(unguarded(clientSource("x.astro", `<script>\n  afterActivation(() => ${e}x));\n</script>`)), e).toEqual([]);
      expect(unguarded(clientSource("x.astro", `---\nconst s = "${e}";\n---\n<p/>`)), e).toEqual([]);
    }
    expect(unguarded(clientSource("X.tsx", "useEffect(() => { fetch('/x'); })"))).toEqual(["fetch("]);
  });
});
