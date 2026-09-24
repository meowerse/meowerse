import AxeBuilder from "@axe-core/playwright";
import { test, expect, sitePaths, smallTargets } from "./fixtures";

test("every page: axe WCAG 2.2 AA clean, one h1, one main, 44 px targets", async ({ page }, info) => {
  test.setTimeout(300_000);
  const problems: string[] = [];
  for (const path of sitePaths()) {
    await page.goto(path);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    for (const v of axe.violations)
      problems.push(`${path} axe ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
    if ((await page.locator("h1").count()) !== 1) problems.push(`${path}: expected exactly one h1`);
    if ((await page.locator("main").count()) !== 1) problems.push(`${path}: expected exactly one main`);
    for (const t of await smallTargets(page)) problems.push(`${path} (${info.project.name}) small target: ${t}`);
  }
  expect(problems).toEqual([]);
});
