import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { headersFor, pageSeo, parseHeaders, rulesSetting, sitemapPaths, sitemapXml, sitePath } from "@meowerse/ui/seo";
import { PAGES, SITE } from "./seo";

const app = (f: string) => readFileSync(join(__dirname, "../..", f), "utf8");
const pageFiles = readdirSync(join(__dirname, "../pages")).filter((f) => f.endsWith(".astro"));
const sourcePaths = pageFiles.map((f) => sitePath(`/${f.replace(/\.astro$/, ".html")}`)).sort();
const PUBLIC = Object.keys(PAGES.public);
const PRIVATE: readonly string[] = PAGES.private;
// The URLs a crawler can hit for a page: with and without the trailing slash (Astro/Cloudflare
// serve /about and /about/), and 404's file name.
const variants = (p: string) => (p === "/" ? ["/"] : p === "/404" ? ["/404", "/404.html"] : [p, p.slice(0, -1)]);
const rules = parseHeaders(app("public/_headers"));

describe("auth.alxnko.dev search-engine classification", () => {
  it("lists exactly the public pages the spec allows", () =>
    expect(PUBLIC.sort()).toEqual(["/", "/about/", "/docs/", "/privacy/", "/terms/"]));
  it("classifies every page in src/pages, and only those", () =>
    expect([...PUBLIC, ...PRIVATE].sort()).toEqual(sourcePaths));
  it("keeps the flows and session-bearing pages out of search", () => {
    for (const p of ["/login/", "/signup/", "/consent/", "/verify/", "/error/", "/account/", "/developers/", "/dashboard/", "/404"])
      expect(pageSeo(SITE, PAGES, p), p).toEqual({ index: false });
  });
  it("gives each public page a canonical on the .dev host and a short sentence-case description", () => {
    for (const p of PUBLIC) {
      const seo = pageSeo(SITE, PAGES, p);
      expect(seo).toMatchObject({ index: true, canonical: `https://auth.alxnko.dev${p}` });
      const d = PAGES.public[p as keyof typeof PAGES.public];
      expect(d.length, p).toBeLessThanOrEqual(160);
      expect(d, p).toMatch(/^[A-Z].*\.$/);
      expect(d, p).not.toMatch(/["<>&]/);
    }
  });
  it("builds the sitemap from the public pages only", () => {
    expect(sitemapPaths(PAGES)).toEqual(["/", "/about/", "/docs/", "/privacy/", "/terms/"]);
    const xml = sitemapXml(SITE, sitemapPaths(PAGES));
    for (const p of PRIVATE) expect(xml).not.toContain(`${SITE}${p}<`);
  });
  it("uses the same host as astro's `site`", () => expect(app("astro.config.mjs")).toContain(`site: "${SITE}"`));
});

describe("auth-web public files", () => {
  it("robots.txt allows crawling, points at the sitemap and still turns the AI crawlers away", () => {
    const robots = app("public/robots.txt");
    expect(robots).toContain("User-agent: *\nAllow: /");
    expect(robots).toContain("Sitemap: https://auth.alxnko.dev/sitemap.xml");
    for (const bot of ["GPTBot", "CCBot", "Google-Extended"]) expect(robots).toContain(`User-agent: ${bot}\nDisallow: /`);
  });
  it("_headers: X-Robots-Tag noindex on every private URL, from exactly one rule", () => {
    for (const p of PRIVATE.flatMap(variants)) {
      expect(rulesSetting(rules, p, "X-Robots-Tag"), p).toHaveLength(1);
      expect(headersFor(rules, p).get("x-robots-tag"), p).toBe("noindex");
    }
  });
  it("_headers: no X-Robots-Tag on public URLs or assets", () => {
    for (const p of [...PUBLIC.flatMap(variants), "/sitemap.xml", "/robots.txt", "/favicon.svg", "/apple-touch-icon.png", "/_astro/x.js", "/site.webmanifest"])
      expect(headersFor(rules, p).has("x-robots-tag"), p).toBe(false);
  });
  it("_headers: at most one Cache-Control rule per page URL (Cloudflare merges them)", () => {
    for (const p of [...PUBLIC, ...PRIVATE].flatMap(variants))
      expect(rulesSetting(rules, p, "Cache-Control").length, p).toBeLessThanOrEqual(1);
  });
  it("_headers: the sitemap and robots.txt cache for an hour, from exactly one rule", () => {
    for (const p of ["/sitemap.xml", "/robots.txt"]) {
      expect(rulesSetting(rules, p, "Cache-Control"), p).toEqual([p]);
      expect(headersFor(rules, p).get("cache-control"), p).toBe("public, max-age=3600");
    }
  });
});
