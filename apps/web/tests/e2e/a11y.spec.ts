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
        const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
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
