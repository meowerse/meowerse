import { test, expect, sitePaths } from "./fixtures";

test("external links open safely in a new tab, mailto never does, internal links resolve", async ({ page, request }, info) => {
  test.skip(info.project.name !== "desktop", "links don't depend on the viewport");
  test.setTimeout(240_000);
  const bad: string[] = [];
  const internal = new Set<string>();
  for (const path of sitePaths()) {
    await page.goto(path);
    const links = await page.locator("a[href]").evaluateAll((as) => as.map((a) => ({
      raw: a.getAttribute("href")!, abs: (a as HTMLAnchorElement).href, target: a.getAttribute("target"), rel: a.getAttribute("rel") ?? "",
    })));
    for (const l of links) {
      if (l.raw.startsWith("mailto:")) { if (l.target) bad.push(`${path}: mailto with a target`); continue; }
      const u = new URL(l.abs);
      if (u.origin !== new URL(page.url()).origin) {
        if (l.target !== "_blank" || !/\bnoopener\b/.test(l.rel) || !/\bnoreferrer\b/.test(l.rel))
          bad.push(`${path}: ${l.raw} target=${l.target} rel="${l.rel}"`);
      } else {
        if (l.target) bad.push(`${path}: same-site ${l.raw} opens a new tab`);
        internal.add(u.pathname);
      }
    }
  }
  for (const p of internal) {
    const status = (await request.get(p)).status();
    if (status !== 200) bad.push(`${p} → ${status}`);
  }
  expect(bad).toEqual([]);
});
