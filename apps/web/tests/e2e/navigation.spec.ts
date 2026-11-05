import { test, expect } from "./fixtures";

// Smooth navigation (PR-19): hover prefetch + CSS-only cross-document view transitions, under the real CSP.

/** Installed on every new document: CSP violations become console errors; `pagereveal` records whether a view transition ran. */
function instrument() {
  addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective} ${e.blockedURI}`));
  addEventListener("pagereveal", (e) => {
    (window as unknown as { __vt: boolean }).__vt = (e as Event & { viewTransition: unknown }).viewTransition != null;
  });
}
/** `pagereveal` can fire just after the URL commits, so wait for it to have been recorded. */
const revealed = async (p: import("@playwright/test").Page) => {
  const get = () => (window as unknown as { __vt?: boolean }).__vt;
  await p.waitForFunction(() => (window as unknown as { __vt?: boolean }).__vt !== undefined);
  return p.evaluate(get);
};

// Five real clicks on distinct same-origin pages: header nav, footer, wordmark, a project card.
const HOPS: ReadonlyArray<{ link: string; path: string }> = [
  { link: '.site-nav a[href="/ui/"]', path: "/ui/" },
  { link: 'footer a[href="/ui/playground/"]', path: "/ui/playground/" },
  { link: '.mw-header a[href="/"]', path: "/" },
  { link: 'a[href="/p/auth/"]', path: "/p/auth/" },
  { link: '.site-nav a[href="/ui/"]', path: "/ui/" },
];

test("5 click navigations: no CSP violations, no page errors", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one pass is enough");
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`error: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  await page.addInitScript(instrument);
  await page.goto("/");
  for (const hop of HOPS) {
    await page.locator(hop.link).first().click();
    await page.waitForURL(`**${hop.path}`);
    await expect(page.locator("main")).toBeVisible();
    // Each page really was a new document that saw the view transition (no-preference is the default).
    expect(await revealed(page)).toBe(true);
  }
  expect(problems).toEqual([]);
});

test("hovering a nav link prefetches its page", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "hover needs a pointer");
  const violations: string[] = [];
  await page.addInitScript(instrument);
  page.on("console", (m) => { if (m.type() === "error") violations.push(m.text()); });
  await page.goto("/");
  // Astro prefetches with <link rel=prefetch> (or a low-priority fetch): never a document navigation.
  const prefetched = page.waitForRequest((r) => new URL(r.url()).pathname === "/ui/" && !r.isNavigationRequest(), { timeout: 5_000 });
  await page.locator('.site-nav a[href="/ui/"]').hover();
  const req = await prefetched;
  const fromLink = await page.locator('link[rel="prefetch"][href="/ui/"]').count();
  const purpose = (await req.allHeaders())["sec-purpose"];
  expect(fromLink > 0 || purpose === "prefetch").toBe(true);
  expect(violations).toEqual([]);
  // Prefetching never navigates.
  expect(new URL(page.url()).pathname).toBe("/");
});

test("view-transition at-rule is gated by prefers-reduced-motion: no-preference (CSSOM)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one pass is enough");
  await page.goto("/");
  const conditions = await page.evaluate(() => {
    const out: string[] = [];
    const walk = (rules: CSSRuleList, media: string[]) => {
      for (const r of rules) {
        if (r.constructor.name === "CSSViewTransitionRule" || /^@view-transition/.test(r.cssText)) out.push(media.join(" | ") || "<top level>");
        else if ("cssRules" in r) walk((r as CSSGroupingRule).cssRules, r instanceof CSSMediaRule ? [...media, r.conditionText] : media);
      }
    };
    for (const s of document.styleSheets) walk(s.cssRules, []);
    return out;
  });
  expect(conditions).toHaveLength(1);
  expect(conditions[0]).toContain("prefers-reduced-motion: no-preference");
});

for (const [mode, expected] of [["no-preference", true], ["reduce", false]] as const) {
  test(`navigating by click ${expected ? "runs" : "skips"} a view transition under reducedMotion=${mode}`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "one pass is enough");
    // Behavioral: `pagereveal.viewTransition` on the destination document (Chromium cross-document view transitions).
    await page.emulateMedia({ reducedMotion: mode });
    await page.addInitScript(instrument);
    await page.goto("/");
    await page.locator('.site-nav a[href="/ui/"]').click();
    await page.waitForURL("**/ui/");
    expect(await revealed(page)).toBe(expected);
  });
}
