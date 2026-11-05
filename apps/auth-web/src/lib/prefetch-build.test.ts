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
  // Header/footer links are rendered by packages/ui (AppHeader/Footer) via their `prefetch` prop.
  it("header and footer allowlisted links carry it; login/signup/account/developers/external do not", () => {
    const html = readFileSync(join(dist, "index.html"), "utf8");
    const nav = (label: string) => new RegExp(`<nav[^>]*aria-label="${label}"[\\s\\S]*?</nav>`).exec(html)?.[0] ?? "";
    const header = nav("primary");
    const footer = nav("site");
    expect(header).toMatch(/<a[^>]*href="\/about"[^>]*data-astro-prefetch="hover"/);
    expect(header).toMatch(/<a[^>]*href="\/docs"[^>]*data-astro-prefetch="hover"/);
    expect(html).toMatch(/<a class="mw-header__brand" href="\/" data-astro-prefetch="hover"/);
    for (const p of ["about", "privacy", "terms"]) expect(footer).toMatch(new RegExp(`<a[^>]*href="/${p}"[^>]*data-astro-prefetch="hover"`));
    for (const p of ["login", "signup", "account", "dashboard", "developers"]) {
      for (const a of anchors.filter((x) => hrefOf(x)?.split(/[?#]/)[0]?.replace(/\/$/, "") === `/${p}`)) expect(a).not.toMatch(/data-astro-prefetch/);
    }
    for (const a of anchors.filter((x) => /href="(https?:)?\/\//.test(x))) expect(a).not.toMatch(/data-astro-prefetch/);
  });
});
