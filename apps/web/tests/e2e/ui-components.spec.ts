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

// labelPlacement="float" is CSS only (:placeholder-shown / :focus-within), so it must hold in the built CSS
// on these static (un-hydrated) previews: resting inside the empty control, on the top border once focused
// or filled, never wider than the control, never pushing the page sideways, and never moving the control.
for (const [slug, root, ctl] of [["field", ".mw-field--float", "input"], ["prompt", ".mw-prompt--float", "textarea"]] as const) {
  test(`${slug}: the floating label rests inside when empty and sits on the border when focused or filled`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" }); // near-instant transitions (they still need a frame: poll)
    await page.goto(`/ui/components/${slug}/`);
    const box = page.locator(`[data-preview] ${root}`).first();
    await box.scrollIntoViewIfNeeded();
    const control = box.locator(ctl);
    const label = box.locator("label");
    await expect(control).toHaveAccessibleName(slug === "field" ? "username" : "message");
    const measure = () => box.evaluate((r, sel) => {
      const c = r.querySelector(sel)!.getBoundingClientRect(), l = r.querySelector("label")!.getBoundingClientRect();
      const doc = document.documentElement;
      return { mid: l.top + l.height / 2 - c.top, left: l.left - c.left, right: c.right - l.right, font: parseFloat(getComputedStyle(r.querySelector("label")!).fontSize),
        ctlTop: c.top, ctlH: c.height, pageOverflow: doc.scrollWidth > doc.clientWidth };
    }, ctl);
    const onBorder = async () => { await expect.poll(async () => Math.abs((await measure()).mid)).toBeLessThanOrEqual(1); return measure(); };
    const rest = await measure();
    expect(rest.mid).toBeGreaterThan(rest.ctlH / 2 - 4);             // centred on the (first) line inside
    await control.focus();
    const focused = await onBorder();                                // centred on the top border line
    expect(focused.font).toBeLessThan(rest.font);
    await control.fill("meow");
    await control.blur();
    const filled = await onBorder();
    for (const m of [rest, focused, filled]) {
      expect(m.left).toBeGreaterThanOrEqual(0);
      expect(m.right).toBeGreaterThanOrEqual(0);
      expect(m.pageOverflow).toBe(false);
      expect(m.ctlTop).toBeCloseTo(rest.ctlTop, 0);                  // the control never moves
      expect(m.ctlH).toBe(rest.ctlH);
    }
    await expect(label).toHaveCSS("text-overflow", "ellipsis");
    await control.fill("");
    await control.blur();
    await expect.poll(async () => (await measure()).mid).toBeCloseTo(rest.mid, 0);
  });
}
