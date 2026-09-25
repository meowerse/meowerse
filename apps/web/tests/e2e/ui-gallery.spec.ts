import { test, expect } from "./fixtures";

test("the gallery shows every component, each state in dark and light side by side", async ({ page }) => {
  await page.goto("/ui/gallery/");
  await expect(page.locator("[data-shot]")).toHaveCount(26);
  for (const slug of ["button", "status-line", "field", "prompt"]) {
    const s = page.locator(`[data-shot="${slug}"]`);
    await expect(s.locator(".mw-theme--dark .preview")).not.toHaveCount(0);
    expect(await s.locator(".mw-theme--dark .preview").count()).toBe(await s.locator(".mw-theme--light .preview").count());
  }
  const bg = (sel: string) => page.locator(`[data-shot="button"] ${sel} .preview__stage`).first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await bg(".mw-theme--dark")).not.toBe(await bg(".mw-theme--light"));
  await expect(page.locator("astro-island")).toHaveCount(0);
});
