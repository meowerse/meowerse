// A prerendered page runs its scripts before the visitor is on it (see activation.ts). So any client code
// that runs probes, fetches, or opens a WebGL context must be wrapped in afterActivation(). This is a
// source-level guard: every .astro <script> block (frontmatter never ships, and may quote sample code) and
// every .tsx island naming one of these effects must also name afterActivation(, checked per <script> block
// with comments stripped.
//
// Known scope limits (a source-level guard, not a proof): imported modules are not followed (an effect hidden in
// a lib function a script calls is only caught where the effect itself is named in a scanned file); effects
// outside EFFECTS (new Image(), <link rel=preload> injection, XMLHttpRequest, navigator.* APIs...) are not seen;
// comment stripping is regex-based, and the frontmatter fence finder only understands backtick strings. For
// the build output, scripts/prerender-check.ts is the runtime backstop.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
// Matched as whole identifiers (import statements removed), so a bare reference like setTimeout(attachAllCat3D, 200) counts too.
const EFFECTS = ["runProbes", "attachAllCat3D", "fetch", "getContext", "WebSocket", "EventSource", "sendBeacon"];
const GUARD = "afterActivation(";

/** Known-safe exceptions, keyed by path relative to src. Each needs a justification. Empty today. */
const ALLOWLIST: Record<string, string> = {};

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

/** Everything before the closing frontmatter fence is server-side and never ships. The fence is the first
 *  line-start `---` outside a template literal: cat3d.astro quotes a whole sample .astro file (with its own
 *  `---` fences) in a backtick string, so a plain "first \n---" would cut the frontmatter short. */
function stripFrontmatter(src: string): string {
  if (!src.startsWith("---\n")) return src;
  let ticks = 0;
  for (let i = 4; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "`") ticks++;
    else if (src[i] === "\n" && ticks % 2 === 0 && src.startsWith("---", i + 1) && /^(\r?\n|$)/.test(src.slice(i + 4))) return src.slice(i + 4);
  }
  return src;
}

/** Comments out: a mention in a comment is neither an effect nor a guard. */
export function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Client-shipped sources of a file, one per executable <script> block (an .astro file) or the whole file (.tsx),
 *  comments removed. Checked one by one: a guard in one block does not cover an effect in another. */
export function clientSources(file: string, src: string): string[] {
  if (file.endsWith(".tsx")) return [stripComments(src)];
  return [...stripFrontmatter(src).matchAll(/<script(?![^>]*\btype\s*=\s*["']application\/ld\+json)[^>]*>([\s\S]*?)<\/script\s*>/gi)]
    .map((m) => stripComments(m[1] ?? ""));
}

/** The effects a client source names without guarding them; empty when fine. */
export function unguarded(body: string): string[] {
  if (body.includes(GUARD)) return [];
  const code = body.replace(/^\s*import\b[^;\n]*(?:;|\n)/gm, "");
  return EFFECTS.filter((e) => new RegExp(`\\b${e}\\b`).test(code));
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

const blocks = (f: string) => clientSources(f, readFileSync(f, "utf8"));

describe("effectful client code runs after activation (prerender-safe)", () => {
  it.each(files.map((f) => [relative(SRC, f), f] as const))("%s", (r, f) => {
    if (r in ALLOWLIST) return;
    blocks(f).forEach((b, i) => expect(unguarded(b), `${r} (block ${i}) names an effect without afterActivation()`).toEqual([]));
  });

  it("sanity: the real pages and the Playground island are scanned, and the guarded pages are seen", () => {
    expect(files.map((f) => relative(SRC, f))).toContain("ui-docs/playground/Playground.tsx");
    const withEffects = files.filter((f) => blocks(f).some((b) => EFFECTS.some((e) => new RegExp(`\\b${e}\\b`).test(b))));
    expect(withEffects.map((f) => relative(SRC, f)).sort()).toEqual(
      ["pages/index.astro", "pages/p/[slug].astro", "pages/ui/cat3d.astro", "pages/ui/patterns/together.astro"]);
  });

  it("cat3d.astro's quoted sample page (a backtick string in its frontmatter) is not scanned as shipped code", () => {
    const src = readFileSync(join(SRC, "pages/ui/cat3d.astro"), "utf8");
    expect(src).toContain("// in an .astro page: server-rendered markup"); // the sample really is there...
    expect(blocks(join(SRC, "pages/ui/cat3d.astro")).join("\n")).not.toContain("server-rendered markup"); // ...and does not ship
    expect(blocks(join(SRC, "pages/ui/cat3d.astro"))).toHaveLength(1);
  });

  it("mutation: an unguarded effect is caught; a guarded one, a comment and frontmatter sample code are not", () => {
    const run = (src: string) => clientSources("x.astro", src).flatMap(unguarded);
    for (const e of EFFECTS) {
      expect(run(`<script>\n  ${e}(x);\n</script>`), e).toEqual([e]);
      expect(run(`<script>\n  afterActivation(() => ${e}(x));\n</script>`), e).toEqual([]);
      expect(run(`---\nconst s = "${e}(x)";\n---\n<p/>`), e).toEqual([]);
      // a guard named only in a comment does not count; an effect named only in a comment is not one
      expect(run(`<script>\n  // afterActivation(\n  /* afterActivation( */ ${e}(x);\n</script>`), e).toEqual([e]);
      expect(run(`<script>\n  // ${e}(x)\n</script>`), e).toEqual([]);
      // per block: a guard in one <script> does not cover an effect in another
      expect(run(`<script>afterActivation(() => 1)</script>\n<script>${e}(x)</script>`), e).toEqual([e]);
    }
    expect(clientSources("X.tsx", "useEffect(() => { fetch('/x'); })").flatMap(unguarded)).toEqual(["fetch"]);
  });
});
