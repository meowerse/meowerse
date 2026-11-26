import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { warmUrls } from "./landing";

// Needs a built dist/ (bun run build); skipped in a bare `vitest run` so the unit lane stays fast.
const dist = join(__dirname, "../../dist");
const built = existsSync(join(dist, "index.html"));
const read = (f: string) => readFileSync(join(dist, f), "utf8");

describe.skipIf(!built)("landing build output", () => {
  it("has the title, an open-app link to /app/, an indexable canonical and links to about/privacy/terms", () => {
    const h = read("index.html");
    expect(h).toContain("<title>meowsenger — real-time chat for the meowerse</title>");
    expect(h).toMatch(/<a id="open-app"[^>]*href="\/app\/"/);
    expect(h).toContain('rel="canonical" href="https://meowsenger.alxnko.dev/"');
    expect(h).not.toContain("noindex");
    for (const p of ["/about", "/privacy", "/terms"]) expect(h).toContain(`href="${p}"`);
    expect(h).not.toContain("client:"); // no React island
    expect(h).not.toContain("astro-island");
  });
  it("keeps /app/ noindex and lists / in the sitemap", () => {
    expect(read("app/index.html")).toContain('<meta name="robots" content="noindex">');
    expect(read("sitemap.xml")).toContain("<loc>https://meowsenger.alxnko.dev/</loc>");
  });
  it("data-warm lists exactly /app/'s eager chunks, all real dist files, including the AppShell chunk", () => {
    const urls = warmUrls(/data-warm="([^"]*)"/.exec(read("index.html"))?.[1]);
    const app = read("app/index.html");
    const entry = /component-url="(\/_astro\/[^"]+\.js)"/.exec(app)![1];
    expect(urls).toContain(entry);
    expect(urls.length).toBe(new Set(urls).size);
    for (const u of urls) expect(existsSync(join(dist, u)), u).toBe(true);
    expect(urls.length).toBe(/data-warm="([^"]*)"/.exec(read("index.html"))![1].split(" ").length); // nothing filtered out
  });
});
