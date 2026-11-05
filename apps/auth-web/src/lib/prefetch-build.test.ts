import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPrefetchable } from "./prefetch";

// Scans the built site (run after `bun --bun run build`); skipped when dist/ is absent.
const dist = join(__dirname, "../../dist");
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const pages = existsSync(dist) ? walk(dist).filter((f) => f.endsWith(".html")) : [];
const anchors = pages.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/<a\b[^>]*>/g)].map((m) => m[0]));
const hrefOf = (a: string) => /\bhref="([^"]*)"/.exec(a)?.[1]?.replaceAll("&#38;", "&").replaceAll("&amp;", "&");

describe.skipIf(pages.length === 0)("built html prefetch attributes", () => {
  it("no prefetch link points at a non-allowlisted target", () => {
    const flagged = anchors.filter((a) => /\bdata-astro-prefetch\b/.test(a));
    expect(flagged.length).toBeGreaterThan(0);
    for (const a of flagged) expect(isPrefetchable(hrefOf(a) ?? ""), a).toBe(true);
  });
  it("no forbidden link carries it", () => {
    for (const a of anchors) {
      const h = hrefOf(a);
      if (h !== undefined && !isPrefetchable(h)) expect(/\bdata-astro-prefetch\b/.test(a), a).toBe(false);
    }
  });
  it("auth-web-owned allowlisted links carry it (404 back-home link)", () => {
    expect(readFileSync(join(dist, "404.html"), "utf8")).toMatch(/<a href="\/" data-astro-prefetch="hover">/);
  });
  // Header/footer links are rendered by packages/ui (AppHeader/Footer), out of scope for this PR.
  it.todo("header/footer allowlisted links carry it (needs a packages/ui follow-up)");
});
