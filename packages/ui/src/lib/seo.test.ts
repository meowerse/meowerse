import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkBuild, headersFor, pagePaths, pageSeo, parseHeaders, rulesSetting, sitemapPaths,
  sitemapXml, sitePath, siteOrigin, type SeoPages,
} from "./seo";

const SITE = "https://auth.alxnko.dev";
const PAGES: SeoPages = {
  public: { "/": "Home.", "/about/": "About." },
  unlisted: { "/app-shell/": "The app." },
  private: ["/login/", "/404"],
};
const pub = (path: string, desc = "x") =>
  `<head><meta name="description" content="${desc}"><link rel="canonical" href="${SITE}${path}"></head>`;
const priv = `<head><meta name="robots" content="noindex"></head>`;
const GOOD = { "/": pub("/"), "/about/": pub("/about/"), "/app-shell/": pub("/app-shell/"), "/login/": priv, "/404": priv };

describe("@meowerse/ui/seo is build-time only", () => {
  it("imports nothing (no React, no DOM, no node builtins), so it can't drag anything into a bundle", () => {
    const src = readFileSync(join(__dirname, "seo.ts"), "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\(/);
  });
});

describe("siteOrigin / sitePath", () => {
  it("accepts a bare origin with or without the slash, and refuses a path", () => {
    expect(siteOrigin("https://meow.alxnko.dev/")).toBe("https://meow.alxnko.dev");
    expect(siteOrigin(SITE)).toBe(SITE);
    expect(() => siteOrigin("https://meow.alxnko.dev/sub/")).toThrow(/bare origin/);
  });
  it("maps request and file paths to Astro's directory URLs", () => {
    expect(sitePath("/")).toBe("/");
    expect(sitePath("/about")).toBe("/about/");
    expect(sitePath("/about/")).toBe("/about/");
    expect(sitePath("about/index.html")).toBe("/about/");
    expect(sitePath("index.html")).toBe("/");
    expect(sitePath("/404.html")).toBe("/404");
    expect(sitePath("/404/")).toBe("/404");
    expect(sitePath("docs\\a\\index.html")).toBe("/docs/a/");
  });
});

describe("sitemap", () => {
  it("turns built index files into site paths and leaves out the 404", () =>
    expect(pagePaths(["p/auth/index.html", "404.html", "index.html", "ui\\index.html", "_astro/x.html"]))
      .toEqual(["/", "/p/auth/", "/ui/"]));
  it("writes a sitemaps.org urlset on the canonical host", () => {
    const xml = sitemapXml("https://meow.alxnko.dev/", ["/", "/ui/"]);
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
      + "  <url><loc>https://meow.alxnko.dev/</loc></url>\n  <url><loc>https://meow.alxnko.dev/ui/</loc></url>\n</urlset>\n");
  });
  it("sorts, dedupes, adds the directory slash and escapes XML", () => {
    const xml = sitemapXml(SITE, ["/terms", "/about/", "/terms/", "/a&b/"]);
    expect([...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]))
      .toEqual([`${SITE}/a&amp;b/`, `${SITE}/about/`, `${SITE}/terms/`]);
  });
  it("refuses a relative path", () => expect(() => sitemapXml(SITE, ["about/"])).toThrow(/start with/));
  it("takes the public pages only", () => expect(sitemapPaths(PAGES)).toEqual(["/", "/about/"]));
});

describe("pageSeo", () => {
  it("gives public and unlisted pages a canonical on the site and their description", () => {
    expect(pageSeo(SITE, PAGES, "/about")).toEqual({ index: true, canonical: `${SITE}/about/`, description: "About." });
    expect(pageSeo(`${SITE}/`, PAGES, "/")).toEqual({ index: true, canonical: `${SITE}/`, description: "Home." });
    expect(pageSeo(SITE, PAGES, "/app-shell/")).toEqual({ index: true, canonical: `${SITE}/app-shell/`, description: "The app." });
  });
  it("marks private pages noindex", () => {
    expect(pageSeo(SITE, PAGES, "/login/")).toEqual({ index: false });
    expect(pageSeo(SITE, PAGES, "/404")).toEqual({ index: false });
  });
  it("throws for a page nobody classified", () => {
    expect(() => pageSeo(SITE, PAGES, "/secret/")).toThrow(/not classified/);
    expect(() => pageSeo(SITE, { public: {}, private: [] }, "/")).toThrow(/not classified/);
  });
});

describe("checkBuild", () => {
  it("passes a build that matches the classification", () => expect(checkBuild(SITE, PAGES, GOOD)).toEqual([]));
  it("fails a classified page that wasn't built", () => {
    const { "/about/": _, ...rest } = GOOD;
    expect(checkBuild(SITE, PAGES, rest)).toEqual(["/about/ is public but no page was built for it"]);
  });
  it("fails a built page nobody classified", () =>
    expect(checkBuild(SITE, PAGES, { ...GOOD, "/new/": pub("/new/") }))
      .toEqual(["/new/ was built but is not classified as public, unlisted or private"]));
  it("fails a path in two lists or not written as a site path", () => {
    const pages: SeoPages = { public: { "/": "Home.", "/about": "About." }, private: ["/"] };
    const problems = checkBuild(SITE, pages, { "/": pub("/"), "/about": pub("/about/") });
    expect(problems).toContain("/about (public) is not a site path; write it as /about/");
    expect(problems).toContain("/ is both public and private");
  });
  it("fails public pages missing their canonical, description or carrying noindex", () => {
    const problems = checkBuild(SITE, PAGES, {
      ...GOOD,
      "/": priv,
      "/about/": pub("/elsewhere/", " "),
    });
    expect(problems).toEqual([
      `/ needs exactly one canonical link to ${SITE}/`,
      "/ is public but carries noindex",
      "/ needs exactly one non-empty meta description",
      `/about/ needs exactly one canonical link to ${SITE}/about/`,
      "/about/ needs exactly one non-empty meta description",
    ]);
  });
  it("fails private pages without noindex or with a canonical", () =>
    expect(checkBuild(SITE, PAGES, { ...GOOD, "/login/": pub("/login/") })).toEqual([
      '/login/ is private but has no <meta name="robots" content="noindex">',
      "/login/ is private but has a canonical link",
    ]));
  it("works without an unlisted list", () =>
    expect(checkBuild(SITE, { public: { "/": "Home." }, private: [] }, { "/": pub("/") })).toEqual([]));
});

const SRC = `# comment
/*
  X-A: 1
  Cache-Control: public
https://:project.pages.dev/*
  X-Robots-Tag: noindex
/_astro/*
  Cache-Control: immutable
`;

describe("_headers parsing", () => {
  it("applies path rules, joins same-name headers like Cloudflare, and skips host rules", () => {
    const rules = parseHeaders(SRC);
    expect(rules).toHaveLength(2);
    expect(Object.fromEntries(headersFor(rules, "/"))).toEqual({ "x-a": "1", "cache-control": "public" });
    expect(headersFor(rules, "/_astro/a.js").get("cache-control")).toBe("public, immutable");
    expect(headersFor(rules, "/").has("x-robots-tag")).toBe(false);
  });
  it("skips a header line without a colon", () => {
    const rules = parseHeaders("/*\n  garbage\n  X-A: 1\n");
    expect(Object.fromEntries(headersFor(rules, "/"))).toEqual({ "x-a": "1" });
  });
  it("names every rule that sets a header for a path", () => {
    const rules = parseHeaders(SRC);
    expect(rulesSetting(rules, "/_astro/a.js", "cache-control")).toEqual(["/*", "/_astro/*"]);
    expect(rulesSetting(rules, "/", "Cache-Control")).toEqual(["/*"]);
    expect(rulesSetting(rules, "/", "x-robots-tag")).toEqual([]);
  });
});
