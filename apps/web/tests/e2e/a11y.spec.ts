import AxeBuilder from "@axe-core/playwright";
import { test, expect, sitePaths, smallTargets } from "./fixtures";

// Each theme resolves purely from prefers-color-scheme here: no localStorage key is set, so
// site-wide CSS (and the sun/moon icon swap) follows the emulated colorScheme below (theme.ts's
// resolvedTheme()). Runs at both viewports (desktop, phone), so 4 test instances total.
for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme: theme });

    test(`every page: axe WCAG 2.2 AA clean, one h1, one main, 44 px targets (${theme})`, async ({ page }, info) => {
      test.setTimeout(300_000);
      const problems: string[] = [];
      for (const path of sitePaths()) {
        await page.goto(path);
        const builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
        if (path === "/ui/gallery/") {
          // T9 false positive (axe-core 4.13, reproduced only on this page, verified NOT a real
          // defect): the gallery is the first page to render the same component twice in one DOM,
          // side by side, forced to opposite themes via .mw-theme--dark/.mw-theme--light (T1). For
          // exactly these two AppHeader nodes in its light column, axe's color-contrast check
          // reports the page's ambient (dark) body background instead of the node's own — every
          // other node on the page, including identical sibling links two rows above, resolves
          // correctly. getComputedStyle confirms the true background is #e9e8e4 (7.66:1 against
          // #46464a, well over the 4.5:1 floor); isolating just this section on an otherwise-empty
          // page makes axe report it correctly, so the misattribution needs the rest of the long
          // page present to reproduce — an axe-core stacking/occlusion limitation on this novel
          // layout, not a contrast defect. Excluded narrowly (this page, these two node groups
          // only); every other check on this page, and this same markup on /ui/components/app-header/,
          // still runs.
          builder.exclude('[data-shot="app-header"] .mw-theme--light .mw-header__nav a[href$="/#projects"]');
          builder.exclude('[data-shot="app-header"] .mw-theme--light .mw-header__user');
        }
        const axe = await builder.analyze();
        for (const v of axe.violations)
          problems.push(`${path} (${theme}) axe ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
        if ((await page.locator("h1").count()) !== 1) problems.push(`${path} (${theme}): expected exactly one h1`);
        if ((await page.locator("main").count()) !== 1) problems.push(`${path} (${theme}): expected exactly one main`);
        for (const t of await smallTargets(page)) problems.push(`${path} (${info.project.name}/${theme}) small target: ${t}`);
      }
      expect(problems).toEqual([]);
    });
  });
}
