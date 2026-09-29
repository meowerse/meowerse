import { test, expect } from "./fixtures";

test("together: all twelve pairings, numbered", async ({ page }) => {
  await page.goto("/ui/patterns/together/");
  await expect(page.locator("[data-pairing]")).toHaveCount(12);
  for (let n = 1; n <= 12; n++) await expect(page.locator(`[data-pairing="${n}"] h2`)).toContainText(`${n}. `);
});

test("pairing 4: field, prompt and button share one height, border and radius (B10.3)", async ({ page }) => {
  await page.goto("/ui/patterns/together/");
  const box = (sel: string) => page.locator(`[data-pairing="4"] ${sel}`).first().evaluate((el) => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return { h: Math.round(r.height), radius: s.borderTopLeftRadius, border: s.borderTopWidth };
  });
  const field = await box(".mw-field input");
  const prompt = await box(".mw-prompt textarea");
  const button = await box(".together-row > .mw-btn");
  expect([field.h, prompt.h, button.h]).toEqual([44, 44, 44]);
  expect(prompt.radius).toBe(field.radius);
  expect(button.radius).toBe(field.radius);
  expect(prompt.border).toBe(field.border);
});

test("forms, states and composer: rules and specimens", async ({ page }) => {
  await page.goto("/ui/patterns/forms/");
  await expect(page.locator(".specimen .mw-field--error")).not.toHaveCount(0);
  await page.goto("/ui/patterns/states/");
  for (const s of ["wait", "fail", "info"]) await expect(page.locator(`.specimen .mw-status--${s}`).first()).toBeVisible();
  await expect(page.locator(".specimen .empty")).toBeVisible();
  await page.goto("/ui/patterns/composer/");
  await expect(page.locator(".rules-table tbody tr")).not.toHaveCount(0);
});

test("cat3d: the live cat and its still fallback", async ({ page }, info) => {
  await page.goto("/ui/cat3d/");
  await expect(page.locator(".mw-cat3d")).toHaveCount(2);
  if (info.project.name === "desktop")
    await expect(page.locator(".mw-cat3d:not(.mw-cat3d--static)")).toHaveClass(/mw-cat3d--live/, { timeout: 10_000 });
  await page.waitForTimeout(500);
  await expect(page.locator(".mw-cat3d--static")).not.toHaveClass(/mw-cat3d--live/);
  await expect(page.locator(".mw-cat3d--static img")).toBeVisible();
});

// B10.3, extended to the patterns pages (T9 ruling: a real layout fit, not just an invisible clip)
// at the widths this task must prove: phone (390), narrow desktop (1024) and wide desktop (1440).
for (const width of [390, 1024, 1440]) {
  test(`together and composer: pairing bodies never overflow their panel at ${width}px`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "viewport-specific; one pass is enough");
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/ui/patterns/together/", "/ui/patterns/composer/"]) {
      await page.goto(path);
      const overflowing = await page.evaluate(() => {
        const bad: string[] = [];
        document.querySelectorAll<HTMLElement>(".pairing__body, .demo-stage").forEach((el) => {
          if (el.scrollWidth > el.clientWidth + 1) {
            const owner = el.closest("[data-pairing]")?.getAttribute("data-pairing") ?? "composer";
            bad.push(`${owner}: scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
          }
        });
        return bad;
      });
      expect(overflowing).toEqual([]);
    }
  });
}
