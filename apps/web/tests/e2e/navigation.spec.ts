import { test, expect } from "./fixtures";

// Smooth navigation (PR-19): hover prefetch + CSS-only cross-document view transitions, under the real CSP.
const HOP = ["/", "/ui/", "/ui/playground/", "/ui/gallery/", "/"];

test("5 same-origin navigations: no CSP violations, no page errors", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one pass is enough");
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`error: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  await page.addInitScript(() =>
    addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective} ${e.blockedURI}`)));
  await page.goto(HOP[0]!);
  for (const path of HOP.slice(1)) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
  }
  expect(problems).toEqual([]);
});

test("hovering a nav link prefetches its page", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "hover needs a pointer");
  const violations: string[] = [];
  await page.addInitScript(() =>
    addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective} ${e.blockedURI}`)));
  page.on("console", (m) => { if (m.type() === "error") violations.push(m.text()); });
  await page.goto("/");
  // Astro prefetches with <link rel=prefetch> (or a low-priority fetch): never a document navigation.
  const prefetched = page.waitForRequest((r) => new URL(r.url()).pathname === "/ui/" && !r.isNavigationRequest(), { timeout: 5_000 });
  await page.locator('.site-nav a[href="/ui/"]').hover();
  await prefetched;
  expect(violations).toEqual([]);
  // Prefetching never navigates.
  expect(new URL(page.url()).pathname).toBe("/");
});

test("view transition applies only without reduced motion", async ({ page, browser }, info) => {
  test.skip(info.project.name !== "desktop", "one pass is enough");
  const rule = (p: typeof page) => p.evaluate(() => {
    const walk = (rules: CSSRuleList): boolean => [...rules].some((r) =>
      r.constructor.name === "CSSViewTransitionRule" || /^@view-transition/.test(r.cssText) ||
      (("cssRules" in r) && walk((r as CSSGroupingRule).cssRules)));
    return [...document.styleSheets].some((s) => walk(s.cssRules));
  });
  // The rule is inside the no-preference media block: present in the sheet either way, but only matches when allowed.
  const media = (p: typeof page) => p.evaluate(() => matchMedia("(prefers-reduced-motion: no-preference)").matches);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  expect(await rule(page)).toBe(true);
  expect(await media(page)).toBe(true);

  const ctx = await browser.newContext({ reducedMotion: "reduce", baseURL: info.project.use.baseURL });
  const reduced = await ctx.newPage();
  await reduced.goto("/");
  expect(await media(reduced)).toBe(false);
  // Navigate by click: no view-transition pseudo-elements animate.
  await reduced.locator('.site-nav a[href="/ui/"]').click();
  await reduced.waitForURL("**/ui/");
  const anim = await reduced.evaluate(() => getComputedStyle(document.documentElement, "::view-transition-old(root)").animationName);
  expect(anim === "none" || anim === "").toBe(true);
  await ctx.close();
});
