// P29 (T6 ruling): `ui-docs/api.ts` pulls in the TypeScript compiler API (`typescript`, ~size of a
// small bundler) to read @meowerse/ui's source at build time. That must never reach the browser.
// Client code (a page's inline <script>, or any .ts/.tsx file outside the server-only build-time
// modules) may import from `ui-docs/api` or `typescript` only as `import type` — a type-only import
// is erased entirely and ships no runtime code. Astro frontmatter (the code between the `---`
// fences) and files under src/lib/** or src/ui-docs/** run on the server at build time, never in a
// browser, so they're allowed a real (non-type) import; this file's own `readFileSync` walk covers
// every other source file. The e2e counterpart (ui-foundations.spec.ts) is the build-output backstop:
// it greps the actual dist/_astro/*.js for `createProgram`, a `typescript` package identifier no
// meowerse code writes itself.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(SRC)
  .filter((f) => /\.(astro|ts|tsx)$/.test(f))
  .filter((f) => !/\.test\.tsx?$/.test(f));

// Never bundled into a browser <script>: build-time-only directories, plus every .astro file's own
// frontmatter (checked separately below, not by this predicate).
const isServerOnlyModule = (rel: string) => rel.startsWith("lib/") || rel.startsWith("ui-docs/");

// A non-`import type` import naming `ui-docs/api` or the bare `typescript` package.
const BAD_IMPORT = /^\s*import\s+(?!type\b)[^;]*?\bfrom\s+["'](?:[./]*ui-docs\/api|typescript)["']/m;

/** The content of every <script> tag in an .astro file, excluding data blocks (e.g. JSON-LD) that
 *  never execute and can't hold an ES import anyway. */
function scriptBlocks(src: string): string[] {
  return [...src.matchAll(/<script(?![^>]*\btype\s*=\s*["']application\/ld\+json)[^>]*>([\s\S]*?)<\/script\s*>/gi)]
    .map((m) => m[1] ?? "");
}

describe("ui-docs/api and the TypeScript compiler stay out of client code (P29)", () => {
  it.each(files.map((f) => [relative(SRC, f), f] as const))("%s", (rel, f) => {
    const src = readFileSync(f, "utf8");
    if (rel.endsWith(".astro")) {
      for (const block of scriptBlocks(src)) expect(block, rel).not.toMatch(BAD_IMPORT);
    } else if (!isServerOnlyModule(rel)) {
      expect(src, rel).not.toMatch(BAD_IMPORT);
    }
  });

  it("sanity: the rule actually catches a real client script that imports ui-docs/api", () => {
    const guilty = '<script>\n  import { uiApi } from "../../ui-docs/api";\n  console.log(uiApi());\n</script>';
    expect(scriptBlocks(guilty).some((b) => BAD_IMPORT.test(b))).toBe(true);
  });

  it("sanity: a type-only import of ui-docs/api is allowed", () => {
    const fine = '<script>\n  import type { UiApi } from "../../ui-docs/api";\n</script>';
    expect(scriptBlocks(fine).some((b) => BAD_IMPORT.test(b))).toBe(false);
  });
});
