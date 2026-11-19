// Plain Playwright test: the shared fixture's page.route() (Fetch interception) would also sit in front of the rules fetch.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Speculation rules (Speculation-Rules header -> /speculation-rules.json) under the real CSP.
// Playwright attaches DevTools, and Chromium then refuses to actually prerender ("PrerenderingDisabledByDevTools"),
// so activation itself is proven by `bun scripts/prerender-check.ts` (plain Chromium, no CDP); tried without
// viewport/colorScheme emulation and without our own CDP session: hover+click still ended with activationStart 0,
// as Playwright's own DevTools pipe is enough to disable it, so no activation test lives here. Here: the header,
// the file, that Chromium accepts the rule set under our CSP, WHICH links it would speculate, and that a hover
// really starts the attempt (it then fails with PrerenderingDisabledByDevTools: expected here, see above).

type Attempt = { action: string; url: string };

async function preloading(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const rulesets: { errorType?: string; errorMessage?: string }[] = [];
  const sources: Attempt[] = [], started: Attempt[] = [];
  cdp.on("Preload.ruleSetUpdated", (e: { ruleSet: { errorType?: string; errorMessage?: string } }) => rulesets.push(e.ruleSet));
  // every link the rules would speculate (Chromium lists them as soon as it has matched the document rules)
  cdp.on("Preload.preloadingAttemptSourcesUpdated", (e: { preloadingAttemptSources: { key: Attempt }[] }) => {
    for (const s of e.preloadingAttemptSources) sources.push({ action: s.key.action, url: s.key.url });
  });
  // an attempt that actually began (hover/pointerdown at moderate eagerness)
  cdp.on("Preload.prerenderStatusUpdated", (e: { key: Attempt }) => started.push({ action: e.key.action, url: e.key.url }));
  cdp.on("Preload.prefetchStatusUpdated", (e: { key: Attempt }) => started.push({ action: e.key.action, url: e.key.url }));
  await cdp.send("Preload.enable");
  return { rulesets, sources, started };
}
const path = (u: string) => new URL(u).pathname;
const HEAVY = /^\/ui\/(cat3d|playground)\//;

test.describe("speculation rules", () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== "desktop", "one pass is enough");
    test.skip(info.project.use.browserName !== "chromium", "Chromium-only feature");
  });

  test("the rules file and header are served exactly, CSP unchanged", async ({ request }) => {
    const home = await request.get("/");
    expect(home.headers()["speculation-rules"]).toBe('"/speculation-rules.json"');
    const csp = home.headers()["content-security-policy"] ?? "";
    expect(csp).not.toMatch(/speculation|unsafe-/);
    expect(csp).toContain("require-trusted-types-for 'script'; trusted-types 'none'");
    const rules = await request.get("/speculation-rules.json");
    expect(rules.status()).toBe(200);
    expect(rules.headers()["content-type"]).toBe("application/speculationrules+json");
    const body = JSON.parse(await rules.text());
    expect(body).toEqual(JSON.parse(readFileSync(join(process.cwd(), "dist/speculation-rules.json"), "utf8")));
    expect(body.prerender[0].eagerness).toBe("moderate");
  });

  test("Chromium accepts the rule set under the CSP and would speculate same-origin pages only", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(e.message));
    const { rulesets, sources } = await preloading(page);
    await page.goto("/ui/");
    await expect.poll(() => sources.length).toBeGreaterThan(0);
    expect(rulesets.length).toBeGreaterThan(0);
    expect(rulesets.every((r) => r.errorType === undefined), JSON.stringify(rulesets)).toBe(true);
    const origin = new URL(page.url()).origin;
    expect(sources.filter((a) => new URL(a.url).origin !== origin), "never cross-origin").toEqual([]);
    expect(sources.filter((a) => /\.(png|svg|ico|xml|txt|json|webmanifest)$/.test(path(a.url))), "never assets").toEqual([]);
    expect(sources.some((a) => a.action === "Prerender" && path(a.url) === "/")).toBe(true);
    expect(errors).toEqual([]);
  });

  test("heavy pages are only prefetched, never prerendered", async ({ page }) => {
    const { sources } = await preloading(page);
    await page.goto("/ui/");
    await expect.poll(() => sources.some((a) => HEAVY.test(path(a.url)))).toBe(true);
    const heavy = sources.filter((a) => HEAVY.test(path(a.url)));
    expect(heavy.filter((a) => a.action === "Prerender"), JSON.stringify(heavy)).toEqual([]);
    expect(heavy.some((a) => a.action === "Prefetch")).toBe(true);
  });

  test("a hover starts a prerender attempt for a same-origin link, and only that origin", async ({ page }) => {
    const { started } = await preloading(page);
    await page.goto("/ui/");
    await page.locator(".mw-header a[href='/']").first().hover();
    await expect.poll(() => started.some((a) => a.action === "Prerender" && path(a.url) === "/"), { timeout: 10_000 }).toBe(true);
    expect(started.filter((a) => new URL(a.url).origin !== new URL(page.url()).origin)).toEqual([]);
  });

  test("a cross-origin link is never speculated, even hovered", async ({ page }) => {
    const { started, sources } = await preloading(page);
    await page.goto("/");
    const ext = page.locator("a[href^='https://']:visible").first();
    await expect(ext).toBeVisible();
    await ext.hover();
    await page.waitForTimeout(1200);
    const origin = new URL(page.url()).origin;
    expect([...started, ...sources].filter((a) => new URL(a.url).origin !== origin)).toEqual([]);
  });

  test("a same-tab cross-origin link (no target=_blank) is never speculated: the origin rule itself", async ({ page }) => {
    const { started, sources } = await preloading(page);
    await page.goto("/ui/");
    await page.evaluate(() => {
      const a = document.createElement("a");
      a.href = "https://auth.alxnko.dev/login/";
      a.id = "xo";
      a.textContent = "cross-origin same-tab";
      a.style.cssText = "position:fixed;top:80px;left:20px;z-index:9999;padding:8px;background:#fff;color:#000";
      document.body.append(a);
    });
    await expect(page.locator("#xo")).toHaveAttribute("href", "https://auth.alxnko.dev/login/");
    expect(await page.locator("#xo").getAttribute("target")).toBeNull();
    await page.locator("#xo").hover();
    await page.waitForTimeout(1200);
    const origin = new URL(page.url()).origin;
    expect([...started, ...sources].filter((a) => new URL(a.url).origin !== origin)).toEqual([]);
  });
});
