import { test, expect } from "./fixtures";

test("every component has a page with props, css variables, a11y notes and do/don't", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/ui/components/");
  const links = page.locator(".component-list a");
  await expect(links).toHaveCount(26);
  for (const href of await links.evaluateAll((as) => as.map((a) => a.getAttribute("href")!))) {
    await page.goto(href);
    for (const id of ["props-title", "css-title", "a11y-title", "dodont-title"]) await expect(page.locator(`#${id}`), `${href} #${id}`).toBeVisible();
  }
});

test("Button: every variant and state previewed; the props table comes from the types", async ({ page }) => {
  await page.goto("/ui/components/button/");
  for (const v of ["primary", "secondary", "ghost", "danger"]) await expect(page.locator(`[data-preview] .mw-btn--${v}`).first()).toBeVisible();
  await expect(page.locator("[data-preview] .mw-btn:disabled")).not.toHaveCount(0);
  const variant = page.locator('section[aria-labelledby="props-title"] tr', { hasText: "variant" });
  await expect(variant).toContainText('"primary" | "secondary" | "ghost" | "danger"');
  await expect(variant).toContainText('"secondary"');
  await expect(page.locator('section[aria-labelledby="css-title"]')).toContainText("--control-height");
  await expect(page.locator('section[aria-labelledby="usage-title"] pre').first()).toContainText('import { Button } from "@meowerse/ui";');
});

test("static component pages ship no React", async ({ page }) => {
  for (const slug of ["badge", "status-line", "field"]) {
    await page.goto(`/ui/components/${slug}/`);
    await expect(page.locator("astro-island")).toHaveCount(0);
  }
});
