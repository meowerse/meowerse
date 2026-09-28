// Screenshot baselines for the gallery, the twelve tty/app pairings and the real pages.
// Run locally with `bun run shots` (playwright.screenshots.config.ts); never part of `bun run e2e`
// and never in CI — runner fonts differ, the same local-only deviation as tokens:drift (B28).
// `animations: "disabled"` and `caret: "hide"` (which also freezes the .mw-cursor blink) come from
// playwright.config.ts's expect.toHaveScreenshot. The Cat3D canvas is masked in every shot: a WebGL
// canvas isn't deterministic even with animations disabled. Probe status is stubbed by fixtures.ts's
// auto PROBED route (no live network, no clock/millisecond text) and the probe's own status text is
// masked besides, since it isn't literally frozen output.
import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

test.skip(!!process.env.CI, "screenshots are compared on the release machine only: CI runner fonts differ (like tokens:drift, B28)");

const THEMES = ["dark", "light"] as const;

/**
 * Fonts loaded, then every island inside `scope` hydrated. Scoped rather than the shared
 * `hydrated()` helper (fixtures.ts, T9): that helper waits for every `astro-island[ssr]` on the
 * whole page, which is right for a one-island component-demo page but wrong here — the together
 * page carries three `client:visible` islands (pairings 1, 9, 11) spread far apart, and checking
 * the earliest pairing would block on islands the loop hasn't scrolled to yet (reproduced: waiting
 * on pairing 1 timed out with 2 still-unhydrated islands elsewhere on the page). Scoping the check
 * to the shot's own subtree is correct for every page this spec covers, including the gallery and
 * the real pages, which currently ship zero islands either way.
 */
const settle = async (page: Page, scope: Locator) => {
  await scope.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  await expect(scope.locator("astro-island[ssr]")).toHaveCount(0, { timeout: 15_000 });
};

test("gallery: every component section, dark and light side by side", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/ui/gallery/");
  const slugs = await page.locator("[data-shot]").evaluateAll((els) => els.map((e) => e.getAttribute("data-shot")!));
  for (const slug of slugs) {
    const s = page.locator(`[data-shot="${slug}"]`);
    await settle(page, s);
    await expect(s).toBeVisible();
    await expect(s).toHaveScreenshot(`gallery-${slug}.png`, { mask: [page.locator(".mw-cat3d")] });
  }
});

for (const theme of THEMES) {
  test(`together: every pairing, ${theme}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.addInitScript((t) => localStorage.setItem("mw-theme", t), theme);
    await page.goto("/ui/patterns/together/");
    for (let n = 1; n <= 12; n++) {
      const s = page.locator(`[data-pairing="${n}"]`);
      await settle(page, s);
      await expect(s).toBeVisible();
      await expect(s).toHaveScreenshot(`together-${n}-${theme}.png`, { mask: [page.locator(".mw-cat3d")] });
    }
    // states the pairings promise besides default: hover and focus-visible (pairing 4's row)
    const row = page.locator('[data-pairing="4"] .together-row');
    await expect(row).toBeVisible();
    await row.locator(".mw-btn").hover();
    await expect(row).toHaveScreenshot(`together-4-hover-${theme}.png`);
    await row.locator(".mw-field input").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(row).toHaveScreenshot(`together-4-focus-${theme}.png`);
  });
}

test("together 1–3 under reduced motion and forced colours", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await page.goto("/ui/patterns/together/");
  for (const n of [1, 2, 3]) {
    const s = page.locator(`[data-pairing="${n}"]`);
    await settle(page, s);
    await expect(s).toBeVisible();
    await expect(s).toHaveScreenshot(`together-${n}-reduced-forced.png`);
  }
});

for (const theme of THEMES) {
  test(`real pages: home and a project page, ${theme}`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("mw-theme", t), theme);
    for (const [name, path] of [["home", "/"], ["project-auth", "/p/auth/"]] as const) {
      await page.goto(path);
      await settle(page, page.locator("body"));
      await expect(page.locator(".mw-status__tag").first()).not.toHaveText("[wait]");
      await expect(page.locator("h1")).toBeVisible();
      await expect(page).toHaveScreenshot(`page-${name}-${theme}.png`, {
        fullPage: true, mask: [page.locator(".mw-cat3d"), page.locator("[data-probe] .mw-status__text")],
      });
    }
  });
}
