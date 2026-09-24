import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";

// site.ts can't be imported here: it pulls in @meowerse/ui/tokens.json, which Vite/Vitest load
// fine but Node's native ESM loader (Playwright's test runner) rejects without an import
// attribute. NAV is parsed straight from the source instead — still grounded in site.ts, not a
// hand-maintained copy — and isCurrent is site.ts's own one-line prefix match (also covered by
// site.test.ts).
type NavLink = { label: string; href: string; match: string };
function readNav(): NavLink[] {
  const src = readFileSync(join(process.cwd(), "src/lib/site.ts"), "utf8");
  const body = /export const NAV:[^=]*=\s*\[([\s\S]*?)\];/.exec(src)?.[1] ?? "";
  return [...body.matchAll(/\{\s*label:\s*"([^"]+)",\s*href:\s*"([^"]+)",\s*match:\s*"([^"]+)"\s*\}/g)]
    .map((m) => ({ label: m[1]!, href: m[2]!, match: m[3]! }));
}
const isCurrent = (pathname: string, match: string): boolean => pathname.startsWith(match);

test("skip link, main landmark, theme button that persists", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.locator(".skip")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
  const btn = page.locator("[data-theme-button]");
  await expect(btn).toHaveAttribute("aria-label", "switch to light theme");
  await btn.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(btn).toHaveAttribute("aria-label", "switch to dark theme");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("B16: no write demo, no input, no token anywhere in the build", async ({ page }, info) => {
  await page.goto("/");
  await expect(page.locator("input, textarea")).toHaveCount(0);
  test.skip(info.project.name !== "desktop", "the file scan runs once");
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  for (const f of walk(join(process.cwd(), "dist")).filter((f) => /\.(html|js)$/.test(f))) {
    const src = readFileSync(f, "utf8");
    expect(src, f).not.toMatch(/PUBLIC_DEMO_TOKEN|Bearer |\/api\/meows/);
  }
});

test("nav marks the current section per site.ts NAV, and no other link", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "aria-current doesn't depend on the viewport");
  await page.goto("/");
  const NAV = readNav();
  expect(NAV.length).toBeGreaterThan(0); // guards against this test silently checking nothing
  for (const link of NAV) {
    const loc = page.locator(`.site-nav a[href="${link.href}"]`);
    if (isCurrent("/", link.match)) await expect(loc, link.label).toHaveAttribute("aria-current", "page");
    else await expect(loc, link.label).not.toHaveAttribute("aria-current");
  }
});

test("the 404 page is a real page with a 404 status", async ({ page }) => {
  const res = await page.goto("/nope/");
  expect(res?.status()).toBe(404);
  await expect(page.locator("h1")).toContainText("not found");
  await expect(page.locator(".mw-header")).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
});

test("SEO basics (W-08)", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://meow.alxnko.dev/");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /one account/);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "meowerse");
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);
  expect(await (await request.get("/robots.txt")).text()).toContain("Sitemap: https://meow.alxnko.dev/sitemap.xml");
  expect(await (await request.get("/sitemap.xml")).text()).toContain("<loc>https://meow.alxnko.dev/</loc>");
  expect(await (await request.get("/.well-known/security.txt")).text()).toContain("Canonical: https://meow.alxnko.dev/");
});

test("fonts: the preloaded files are the ones the inline CSS uses", async ({ page }) => {
  await page.goto("/");
  const hrefs = await page.locator('link[rel="preload"][as="font"]').evaluateAll((ls) => ls.map((l) => l.getAttribute("href")!));
  expect(hrefs).toHaveLength(2);
  const css = await page.locator("style").allTextContents();
  for (const h of hrefs) expect(css.join("")).toContain(h);
});
