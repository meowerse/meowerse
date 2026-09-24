import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// One stylesheet (site.css via BaseLayout) → one inline <style> → one CSP hash. A component <style>
// block or style="" attribute would add hashes or be blocked outright.
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const astro = walk(join(__dirname, "..")).filter((f) => f.endsWith(".astro"));

describe("no per-component styles", () => {
  it.each(astro.map((f) => [f.slice(f.indexOf("src/")), f]))("%s has no <style> block or style attribute", (_n, f) => {
    const src = readFileSync(f, "utf8");
    expect(src).not.toMatch(/<style[\s>]/);
    expect(src).not.toMatch(/\sstyle=/);
  });
});
