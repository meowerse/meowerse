import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { headersFor, pageSeo, parseHeaders, rulesSetting, sitemapPaths, sitemapXml, sitePath } from "@meowerse/ui/seo";
import { PAGES, SITE } from "./seo";

const app = (f: string) => readFileSync(join(__dirname, "../..", f), "utf8");
const pageFiles = readdirSync(join(__dirname, "../pages")).filter((f) => f.endsWith(".astro"));
const sourcePaths = pageFiles.map((f) => sitePath(`/${f.replace(/\.astro$/, ".html")}`)).sort();
const PUBLIC = Object.keys(PAGES.public);
const UNLISTED = Object.keys(PAGES.unlisted);
const PRIVATE: readonly string[] = PAGES.private;
const DESCRIPTIONS: Record<string, string> = { ...PAGES.public, ...PAGES.unlisted };
// The URLs a crawler can hit for a page: with and without the trailing slash (Astro/Cloudflare
// serve /about and /about/), and 404's file name.
const variants = (p: string) => (p === "/" ? ["/"] : p === "/404" ? ["/404", "/404.html"] : [p, p.slice(0, -1)]);
const rules = parseHeaders(app("public/_headers"));

describe("meowsenger.alxnko.dev search-engine classification", () => {
  it("lists exactly the public pages the spec allows (no chats: none are anonymously viewable)", () =>
    expect(PUBLIC.sort()).toEqual(["/about/", "/privacy/", "/terms/"]));
  it("classifies every page in src/pages, and only those", () =>
    expect([...PUBLIC, ...UNLISTED, ...PRIVATE].sort()).toEqual(sourcePaths));
  it("keeps the app, join and 404 pages out of search", () => {
    for (const p of ["/app/", "/join/", "/404"]) expect(pageSeo(SITE, PAGES, p), p).toEqual({ index: false });
  });
  it("leaves the home page (the app shell) indexable, canonical to itself, but out of the sitemap", () => {
    expect(pageSeo(SITE, PAGES, "/")).toMatchObject({ index: true, canonical: "https://meowsenger.alxnko.dev/" });
    expect(sitemapPaths(PAGES)).not.toContain("/");
  });
  it("gives each indexable page a canonical on the .dev host and a short sentence-case description", () => {
    for (const p of [...PUBLIC, ...UNLISTED]) {
      expect(pageSeo(SITE, PAGES, p)).toMatchObject({ index: true, canonical: `https://meowsenger.alxnko.dev${p}` });
      const d = DESCRIPTIONS[p];
      expect(d.length, p).toBeLessThanOrEqual(160);
      expect(d, p).toMatch(/^[A-Z].*\.$/);
      expect(d, p).not.toMatch(/["<>&]/);
    }
  });
  it("builds the sitemap from the public pages only", () => {
    expect(sitemapPaths(PAGES)).toEqual(["/about/", "/privacy/", "/terms/"]);
    const xml = sitemapXml(SITE, sitemapPaths(PAGES));
    for (const p of [...UNLISTED, ...PRIVATE]) expect(xml).not.toContain(`${SITE}${p}<`);
  });
  it("uses the same host as astro's `site`", () => expect(app("astro.config.mjs")).toContain(`site: "${SITE}"`));
});

describe("meowsenger-web public files", () => {
  it("robots.txt allows crawling, points at the sitemap and still turns the AI crawlers away", () => {
    const robots = app("public/robots.txt");
    expect(robots).toContain("User-agent: *\nAllow: /");
    expect(robots).toContain("Sitemap: https://meowsenger.alxnko.dev/sitemap.xml");
    for (const bot of ["GPTBot", "CCBot", "Google-Extended"]) expect(robots).toContain(`User-agent: ${bot}\nDisallow: /`);
  });
  it("_headers: X-Robots-Tag noindex on every private URL (and below /app/), from exactly one rule", () => {
    for (const p of [...PRIVATE.flatMap(variants), "/app/c/123"]) {
      expect(rulesSetting(rules, p, "X-Robots-Tag"), p).toHaveLength(1);
      expect(headersFor(rules, p).get("x-robots-tag"), p).toBe("noindex");
    }
  });
  it("_headers: no X-Robots-Tag on indexable URLs or assets (mind /app vs /apple-touch-icon.png)", () => {
    for (const p of [...PUBLIC, ...UNLISTED].flatMap(variants).concat(
      ["/sitemap.xml", "/robots.txt", "/favicon.svg", "/apple-touch-icon.png", "/_astro/x.js", "/site.webmanifest", "/sw.js"]))
      expect(headersFor(rules, p).has("x-robots-tag"), p).toBe(false);
  });
  it("_headers: at most one Cache-Control rule per page URL (Cloudflare merges them)", () => {
    for (const p of [...PUBLIC, ...UNLISTED, ...PRIVATE].flatMap(variants).concat(["/apple-touch-icon.png"]))
      expect(rulesSetting(rules, p, "Cache-Control").length, p).toBeLessThanOrEqual(1);
  });
  it("_headers: the sitemap and robots.txt cache for an hour, from exactly one rule", () => {
    for (const p of ["/sitemap.xml", "/robots.txt"]) {
      expect(rulesSetting(rules, p, "Cache-Control"), p).toEqual([p]);
      expect(headersFor(rules, p).get("cache-control"), p).toBe("public, max-age=3600");
    }
  });
});
