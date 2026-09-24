import { describe, expect, it } from "vitest";
import { pagePaths, sitemapXml } from "./sitemap";

describe("sitemap", () => {
  it("turns built index files into site paths and leaves out the 404", () =>
    expect(pagePaths(["p/auth/index.html", "404.html", "index.html", "ui\\index.html", "_astro/x.html"]))
      .toEqual(["/", "/p/auth/", "/ui/"]));
  it("writes a sitemaps.org urlset on the canonical host", () => {
    const xml = sitemapXml("https://meow.alxnko.dev/", ["/", "/ui/"]);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("<url><loc>https://meow.alxnko.dev/</loc></url>");
    expect(xml).toContain("<url><loc>https://meow.alxnko.dev/ui/</loc></url>");
  });
});
