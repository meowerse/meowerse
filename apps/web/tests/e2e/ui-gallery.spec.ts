import AxeBuilder from "@axe-core/playwright";
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

// review9: a wide preview (AppHeader) overflowed its half-width gallery column at desktop widths,
// rendering its nav/user-chip over the neighbouring theme's panel at ~1.1-2.1:1 contrast. Fixed by
// stacking a wide preview's dark/light pair into one column at every width (site.css); this proves
// it holds at both a wide (1440) and a narrower (1024) desktop width, and that the fix is a real
// layout fit rather than a clip — every focusable control's rect is fully inside its own themed
// panel, not just invisibly hidden by `overflow`.
for (const width of [1440, 1024]) {
  test(`gallery previews never overflow their themed panel at ${width}px`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "viewport-specific; one pass is enough");
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/ui/gallery/");

    const overflowing = await page.evaluate(() => {
      const bad: string[] = [];
      document.querySelectorAll<HTMLElement>(".gallery-theme .preview__stage").forEach((el) => {
        if (el.scrollWidth > el.clientWidth) {
          const shot = el.closest("[data-shot]")?.getAttribute("data-shot");
          bad.push(`${shot}: scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
        }
      });
      return bad;
    });
    expect(overflowing).toEqual([]);

    const escaped = await page.evaluate(() => {
      const bad: string[] = [];
      document.querySelectorAll<HTMLElement>(".gallery-theme").forEach((box) => {
        const shot = box.closest("[data-shot]")?.getAttribute("data-shot");
        const b = box.getBoundingClientRect();
        box.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return; // not rendered (e.g. visibility:hidden demo control, N/A here)
          const EPS = 0.5; // sub-pixel rounding
          if (r.left < b.left - EPS || r.right > b.right + EPS || r.top < b.top - EPS)
            bad.push(`${shot}: <${el.tagName.toLowerCase()}> "${(el.textContent ?? "").trim().slice(0, 24)}" escapes its panel`);
        });
      });
      return bad;
    });
    expect(escaped).toEqual([]);

    // No exemptions (a11y.spec.ts's own axe pass covers this page too, at its two project
    // viewports): with the panels actually fitting, axe is clean here, dark and light, at this
    // width, with no exclude().
    for (const colorScheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme });
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(axe.violations.map((v) => `${colorScheme} ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    }
  });
}
