// P29 (T6 ruling; T7 fix round 1). `src/ui-docs/api.ts` and the two modules it's built from,
// `src/lib/ui-api.ts` (pulls in the TypeScript compiler, `typescript`) and `src/lib/css-api.ts`,
// read @meowerse/ui's source at build time so the docs' props/utilities tables can't drift. That
// must never reach the browser.
//
// Fix round 1: the first version of this test exempted every file under `src/lib/**` by
// directory, on the theory that `src/lib` is "build-time only". That was wrong — several lib
// files ship to the browser from an inline <script> (`theme-button.ts`, `probe-runner.ts`,
// `copy-buttons.ts`, `motion-demo.ts`), so a directory alone can't say "safe". There is no
// directory exemption any more: every file is scanned, and only three specific files are ever
// allowed to hold the sensitive import.
//
// Two checks, run over every file in src/**/*.{astro,ts,tsx} (test files excluded):
//
//  1. A value (non-`import type`) import of the bare `typescript` package or of `.../ui-docs/api`
//     is allowed only in SENSITIVE_FILES below. Astro frontmatter (the code between the `---`
//     fences) is not scanned by this check — unlike a directory, that's not a heuristic: Astro
//     frontmatter runs on the server at build time and is categorically never bundled for the
//     browser, so `DocsLayout.astro`/`ui/index.astro`/`ui/utilities.astro` can import `uiApi` from
//     their frontmatter freely. Only a <script> block (client code) is scanned.
//  2. None of SENSITIVE_FILES is reachable — directly or transitively, following only value
//     imports (a type-only import is erased and carries no runtime code into a bundle) — from any
//     client entry point: every <script> block in every .astro file, and any component used with
//     a client:* directive. This is the real guarantee: it would catch a client script that reaches
//     a sensitive file through some innocent-looking intermediate module, not only a direct
//     `from "typescript"`/`from "ui-docs/api"`.
//
// The e2e counterpart (ui-foundations.spec.ts) is the build-output backstop: it greps the actual
// dist/_astro/*.js for a string that only the `typescript` package's source contains.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

/** The only files allowed a real (non-type) import of `typescript` or `ui-docs/api`. Being listed
 *  here doesn't exempt a file from check 2: it must still be unreachable from every client entry. */
const SENSITIVE_FILES = new Set(["ui-docs/api.ts", "lib/ui-api.ts", "lib/css-api.ts"]);

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const allFiles = walk(SRC)
  .filter((f) => /\.(astro|ts|tsx)$/.test(f))
  .filter((f) => !/\.test\.tsx?$/.test(f));
const rel = (f: string) => relative(SRC, f);

type ImportEdge = { spec: string; typeOnly: boolean };

/** Every static `import`/`export ... from "spec"` in `source`, flagged for whether the whole
 *  statement is `import type`/`export type` (erased entirely; carries no runtime code). */
function parseImports(source: string): ImportEdge[] {
  return [...source.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\bfrom\s+["']([^"']+)["']|\*\s*from\s+["']([^"']+)["'])/gm)]
    .map((m) => ({ spec: (m[2] ?? m[3])!, typeOnly: !!m[1] }));
}

/** The content of every <script> tag in an .astro file, excluding data blocks (e.g. JSON-LD) that
 *  never execute and can't hold an ES import anyway. */
function scriptBlocks(src: string): string[] {
  return [...src.matchAll(/<script(?![^>]*\btype\s*=\s*["']application\/ld\+json)[^>]*>([\s\S]*?)<\/script\s*>/gi)]
    .map((m) => m[1] ?? "");
}

/** A file's own client-relevant source: an .astro file's <script> blocks only (frontmatter never
 *  ships), or the whole file otherwise. */
function clientBodyOf(file: string, src: string): string {
  return file.endsWith(".astro") ? scriptBlocks(src).join("\n") : src;
}

/** Components named on a `client:*` directive in an .astro file's template, resolved to the module
 *  specifier that imports them in frontmatter (e.g. `<Foo client:load />`, `import { Foo } from
 *  "../islands/Foo"` → "../islands/Foo"). None exist in this codebase today — checked by the
 *  "no astro-island" e2e assertions — but the graph must still cover one if it ever ships. */
function clientDirectiveSpecs(src: string): string[] {
  const used = new Set<string>();
  for (const m of src.matchAll(/<([A-Z][\w.]*)\b[^>]*\bclient:(?:load|idle|visible|media|only)\b/g)) used.add(m[1]!.split(".")[0]!);
  if (used.size === 0) return [];
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(src)?.[1] ?? "";
  const specs: string[] = [];
  for (const m of frontmatter.matchAll(/^\s*import\s+(?:type\s+)?([^;]*?)\bfrom\s+["']([^"']+)["']/gm))
    for (const name of used) if (new RegExp(`\\b${name}\\b`).test(m[1]!)) specs.push(m[2]!);
  return specs;
}

/** Resolve a relative import specifier from `fromFile` to one of `allFiles`, or undefined for a
 *  bare/package specifier (node_modules, @meowerse/ui, "typescript", …) — those can't reach our own
 *  sensitive files except through our own relative imports, which this graph already follows. */
function resolveLocal(fromFile: string, spec: string, files: readonly string[]): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = normalize(join(dirname(fromFile), spec));
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.astro`, join(base, "index.ts"), join(base, "index.astro")]
    .find((cand) => files.includes(cand));
}

/** Every local file a value import of `file` can reach in one hop. */
function edgesOf(file: string, files: readonly string[]): string[] {
  const src = readFileSync(file, "utf8");
  const body = clientBodyOf(file, src);
  const specs = [...parseImports(body).filter((e) => !e.typeOnly).map((e) => e.spec), ...clientDirectiveSpecs(src)];
  return specs.map((s) => resolveLocal(file, s, files)).filter((f): f is string => !!f);
}

/** BFS reachability: every node reachable from `entries` (inclusive) via `edgesOf`. A pure function
 *  of its inputs, so the self-test below can drive it with a synthetic graph instead of real files. */
function reachableFrom(entries: readonly string[], edgesOf_: (n: string) => string[]): Set<string> {
  const seen = new Set(entries);
  const queue = [...entries];
  while (queue.length) {
    const n = queue.pop()!;
    for (const next of edgesOf_(n)) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  return seen;
}

describe("ui-docs/api and the TypeScript compiler stay out of client code (P29)", () => {
  describe("check 1: the sensitive import itself, everywhere, no directory exemption", () => {
    const BAD_IMPORT = /^\s*import\s+(?!type\b)[^;]*?\bfrom\s+["'](?:[./]*ui-docs\/api|typescript)["']/m;

    it.each(allFiles.map((f) => [rel(f), f] as const))("%s", (r, f) => {
      const src = readFileSync(f, "utf8");
      const body = clientBodyOf(f, src);
      const violates = BAD_IMPORT.test(body);
      if (SENSITIVE_FILES.has(r)) return; // allowed here; check 2 verifies it's still unreachable
      expect(violates, r).toBe(false);
    });

    it("sanity: a client script that value-imports ui-docs/api is caught", () => {
      const guilty = '<script>\n  import { uiApi } from "../../ui-docs/api";\n  console.log(uiApi());\n</script>';
      expect(BAD_IMPORT.test(clientBodyOf("x.astro", guilty))).toBe(true);
    });

    it("sanity: a type-only import of ui-docs/api is allowed", () => {
      const fine = '<script>\n  import type { UiApi } from "../../ui-docs/api";\n</script>';
      expect(BAD_IMPORT.test(clientBodyOf("x.astro", fine))).toBe(false);
    });
  });

  describe("check 2: none of SENSITIVE_FILES is reachable from a real client entry point", () => {
    // Every .astro file is a candidate entry (edgesOf yields nothing for one with no <script>);
    // client:* components (none today) would add their own file as an entry too, but they're
    // already covered because their specifier is folded into whatever .astro references them.
    const entries = allFiles.filter((f) => f.endsWith(".astro"));
    const reached = reachableFrom(entries, (f) => edgesOf(f, allFiles));
    const sensitiveAbs = [...SENSITIVE_FILES].map((s) => join(SRC, s));

    it("the client bundle graph never reaches a sensitive file", () => {
      const hit = sensitiveAbs.filter((f) => reached.has(f));
      expect(hit.map(rel)).toEqual([]);
    });

    it("sanity (real repo): the modules that DO ship to the browser are reachable, proving the graph isn't trivially empty", () => {
      for (const f of ["lib/theme-button.ts", "lib/probe-runner.ts", "lib/copy-buttons.ts", "lib/motion-demo.ts"])
        expect(reached.has(join(SRC, f)), f).toBe(true);
    });
  });

  describe("check 2, self-test: the reachability algorithm itself, on a synthetic graph", () => {
    // Proves reachableFrom() actually flags a sensitive node when one is wired in — the real-repo
    // check above can only prove "found none reachable", which would also pass if the algorithm
    // were silently broken (e.g. always returning an empty set). This fixture graph is independent
    // of the filesystem entirely.
    const graph: Record<string, string[]> = {
      "entry-script": ["helper"],
      "helper": ["sensitive"], // an innocent-looking intermediate — no direct mention of "typescript"
      "sensitive": [],
      "unreachable-script": ["also-unreachable"],
      "also-unreachable": ["sensitive"],
    };
    const edges = (n: string) => graph[n] ?? [];

    it("flags a sensitive node reachable through an intermediate module", () => {
      const reached = reachableFrom(["entry-script"], edges);
      expect(reached.has("sensitive")).toBe(true);
    });

    it("does not flag a sensitive node reachable only from an entry point that isn't in the scan", () => {
      const reached = reachableFrom(["entry-script"], edges);
      expect(reached.has("also-unreachable")).toBe(false);
      // "sensitive" is reachable from "unreachable-script", which this call never started from —
      // exactly the situation this test would need to catch if the real scan ever missed an entry.
    });
  });

  // T8a ruling: `edgesOf` silently drops any relative specifier `resolveLocal` can't match to a real
  // file (`.filter((f): f is string => !!f)`, above) — that's correct for a bare/package specifier
  // ("@meowerse/ui", "typescript", …), which this graph was never meant to follow, but WRONG for a
  // relative specifier that should have resolved and didn't: a typo'd path, a moved file, or a
  // resolveLocal candidate list that's missing an extension a new file type needs. Any of those would
  // silently shrink check 2's reachability graph instead of failing — a sensitive file could become
  // "unreachable" only because the edge that would have found it was dropped, not because it's
  // actually safe. This asserts every relative specifier this scan finds resolves to a real file, so
  // that failure mode is loud instead of silent.
  describe("check 3: every relative import specifier resolves to a real file (no silently dropped edge)", () => {
    // Checks the real filesystem, not membership in `allFiles` (the .astro/.ts/.tsx walk): a
    // relative import can legitimately target a non-source asset resolveLocal was never meant to
    // follow into the graph (e.g. `lib/site.ts`'s `import ... from "./nav.json"`), and that's fine —
    // what must never happen is a relative specifier that resolves to NOTHING, source or asset alike.
    function existsAsFile(fromFile: string, spec: string): boolean {
      const base = normalize(join(dirname(fromFile), spec));
      if (/\.[a-zA-Z0-9]+$/.test(spec)) return existsSync(base); // already has its own extension (.json, .css, …)
      return [base, `${base}.ts`, `${base}.tsx`, `${base}.astro`, join(base, "index.ts"), join(base, "index.astro")].some(existsSync);
    }

    const cases = allFiles.flatMap((f) => {
      const src = readFileSync(f, "utf8");
      const body = clientBodyOf(f, src);
      const specs = [...parseImports(body).filter((e) => !e.typeOnly).map((e) => e.spec), ...clientDirectiveSpecs(src)]
        .filter((s) => s.startsWith("."));
      return specs.map((spec) => [`${rel(f)} imports "${spec}"`, f, spec] as const);
    });

    it.each(cases)("%s", (_label, f, spec) => {
      expect(existsAsFile(f, spec), `${rel(f)}: "${spec}" doesn't resolve to any real file on disk`).toBe(true);
    });

    it("sanity: an import of a file that doesn't exist is caught, not silently ignored", () => {
      expect(existsAsFile(join(SRC, "lib/does-not-exist.ts"), "./nope-really")).toBe(false);
      expect(existsAsFile(join(SRC, "lib/does-not-exist.ts"), "./nope-really.json")).toBe(false);
    });
  });
});
