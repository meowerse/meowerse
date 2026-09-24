import { test, expect } from "./fixtures";

const SLUGS = ["auth", "meowsenger", "ui", "moonmeow", "sunmeow", "alxnko-dev"];

test("six project pages: summary, what, how + diagram, facts, links, a resolved status", async ({ page }) => {
  for (const slug of SLUGS) {
    await page.goto(`/p/${slug}/`);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator(".lede")).not.toBeEmpty();
    await expect(page.locator(".diagram svg[role=img] > title")).toHaveCount(1);
    await expect(page.locator("#what-title + .project__list li").first()).toBeVisible();
    await expect(page.locator(".facts__row").first()).toBeVisible();
    await expect(page.locator(".project__head .mw-btn--primary")).toHaveCount(1);
    await expect(page.locator(".mw-status")).toHaveCount(1);
    await expect(page.locator(".mw-status__tag")).not.toHaveText("[wait]", { timeout: 8000 });
  }
});

// C6: the ruling adds this retry button — the brief's ProjectStatus.astro omitted it, but
// probe-runner.ts (built in T4a) always assumes it exists to drive a retry.
test("check again re-probes, and a second click while it's running is ignored", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", (req) => { if (/^https:\/\/auth\.alxnko\.dev\//.test(req.url())) calls.push(req.url()); });
  await page.goto("/p/auth/");
  await expect(page.locator(".mw-status__tag")).toHaveText("[ ok ]", { timeout: 8000 });
  const afterLoad = calls.length;
  const retry = page.locator("[data-probe-retry]");
  await expect(retry).toBeVisible();
  await expect(retry).toHaveText("check again");
  const box = await retry.boundingBox();
  expect(box?.width, "retry button width").toBeGreaterThanOrEqual(44);
  expect(box?.height, "retry button height").toBeGreaterThanOrEqual(44);
  // Two clicks fired back-to-back in the page (not through Playwright's actionability wait, which
  // would itself wait for the button to re-enable): the runner must ignore the second one.
  await page.evaluate(() => {
    const btn = document.querySelector("[data-probe-retry]") as HTMLButtonElement;
    btn.click();
    btn.click();
  });
  await expect(retry).toBeEnabled({ timeout: 8000 });
  await expect(retry).toHaveText("check again");
  expect(calls.length, "exactly one extra probe from the two clicks").toBe(afterLoad + 1);
});

test("the diagram keeps at least 3:1 contrast against its own background in both themes", async ({ page }) => {
  for (const theme of ["dark", "light"] as const) {
    await page.addInitScript((t) => localStorage.setItem("mw-theme", t), theme);
    await page.goto("/p/auth/");
    const ratios = await page.locator(".dg-box").first().evaluate((box) => {
      const title = box.parentElement!.querySelector(".dg-title")!;
      const toRgb = (s: string) => (s.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number);
      const linear = (c: number) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
      const luminance = ([r, g, b]: number[]) => 0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!);
      const contrast = (a: number[], b: number[]) => {
        const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
        return (hi + 0.05) / (lo + 0.05);
      };
      const boxFill = toRgb(getComputedStyle(box).fill);
      const titleFill = toRgb(getComputedStyle(title).fill);
      const stroke = toRgb(getComputedStyle(box).stroke);
      const bodyBg = toRgb(getComputedStyle(document.body).backgroundColor);
      return { textOnBox: contrast(titleFill, boxFill), strokeOnPage: contrast(stroke, bodyBg) };
    });
    expect(ratios.textOnBox, `${theme}: dg-title text vs its box background`).toBeGreaterThanOrEqual(3);
    expect(ratios.strokeOnPage, `${theme}: dg-box stroke vs the page background`).toBeGreaterThanOrEqual(3);
  }
});

test("pages without a public service say so instead of pretending", async ({ page }) => {
  for (const slug of ["moonmeow", "sunmeow"]) {
    await page.goto(`/p/${slug}/`);
    await expect(page.locator(".mw-status__tag")).toHaveText("[info]");
    await expect(page.locator(".mw-status")).toContainText("there's no public service to check");
  }
});
