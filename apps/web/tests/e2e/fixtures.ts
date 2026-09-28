import { test as base, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Every origin the site probes (src/content/projects). Tests never reach the real services. */
export const PROBED = /^https:\/\/(?:auth\.alxnko\.dev|meowsenger\.alxnko\.dev|alxnko\.dev)\//;

export const test = base.extend<{ stubProbes: void }>({
  stubProbes: [async ({ page }, use) => {
    await page.route(PROBED, (route) => route.fulfill({
      status: 200, body: "{}", headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
    }));
    await use();
  }, { auto: true }],
});
export { expect };

/** Site paths from the built sitemap (`bun run build` first). */
export function sitePaths(): string[] {
  const xml = readFileSync(join(process.cwd(), "dist/sitemap.xml"), "utf8");
  return [...xml.matchAll(/<loc>https:\/\/meow\.alxnko\.dev(\/[^<]*)<\/loc>/g)].map((m) => m[1]!);
}

/**
 * Waits for every `client:visible` island under `selector` to hydrate. Centers the target instead of
 * `scrollIntoViewIfNeeded()`: that only guarantees the target's own edge is in view, and `astro-island`
 * is `display:contents` (an all-zero `getBoundingClientRect()`), so a heading right at the viewport's
 * bottom edge can leave the demo content just below it a few px past the fold — never intersecting,
 * so `client:visible` never fires (reproduced deterministically for the AppHeader demo). Centering
 * leaves headroom below the target so the island is actually in view.
 */
export async function hydrated(page: Page, selector: string): Promise<void> {
  await page.locator(selector).evaluate((el) => el.scrollIntoView({ block: "center" }));
  await expect(page.locator("astro-island[ssr]")).toHaveCount(0, { timeout: 15_000 });
}

/**
 * Visible interactive elements under 44×44 CSS px. Exempt: inline links in running text (WCAG 2.5.8),
 * `.mw-btn--sm` (36 px drawn, 44 px hit area through ::after), native checkboxes/radios inside a ≥44 px
 * label, and component previews in the /ui docs ([data-preview]: ui's own geometry tests cover those).
 */
export async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("a[href], button, summary, input, select, textarea, [role=button]")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
      if (el.closest(".sr-only, [data-preview]")) continue;
      if (el.tagName === "A" && el.closest("p, td, dd, figcaption")) continue;
      if (el.matches(".mw-btn--sm")) continue;
      const label = el.matches("input[type=checkbox], input[type=radio]") ? el.closest("label") : null;
      if (label && label.getBoundingClientRect().height >= 44) continue;
      if (r.width < 44 || r.height < 44)
        out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return out;
  });
}
