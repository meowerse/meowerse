import { test, expect, sitePaths } from "./fixtures";

// Every page, every island hydrated: no CSP or Trusted Types violation and no console error.
test("no CSP / Trusted Types violations and no console errors on any page", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one pass is enough");
  test.setTimeout(240_000);
  const problems: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") problems.push(`${page.url()} console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`${page.url()} error: ${e.message}`));
  await page.addInitScript(() =>
    addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective} ${e.blockedURI}`)));
  for (const path of sitePaths()) {
    await page.goto(path);
    await page.evaluate(async () => {
      for (let y = 0; y <= document.body.scrollHeight; y += innerHeight / 2) {
        scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
    });
    await expect.poll(() => page.locator("astro-island[ssr]").count(), { timeout: 15_000 }).toBe(0);
  }
  expect(problems).toEqual([]);
});
