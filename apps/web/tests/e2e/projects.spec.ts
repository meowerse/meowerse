import { test, expect, PROBED } from "./fixtures";

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
test("check again re-probes, keeps keyboard focus while busy, and ignores a second click while running", async ({ page }) => {
  await page.goto("/p/auth/");
  await expect(page.locator(".mw-status__tag")).toHaveText("[ ok ]", { timeout: 8000 });
  const retry = page.locator("[data-probe-retry]");
  await expect(retry).toBeVisible();
  await expect(retry).toHaveText("check again");
  const box = await retry.boundingBox();
  expect(box?.width, "retry button width").toBeGreaterThanOrEqual(44);
  expect(box?.height, "retry button height").toBeGreaterThanOrEqual(44);

  // A slow route holds the busy state open long enough to observe it — the fast auto-stub from
  // stubProbes would resolve before an assertion could ever catch the mid-flight state.
  let requests = 0;
  await page.route(PROBED, async (route) => {
    requests++;
    await new Promise((r) => setTimeout(r, 250));
    await route.fulfill({ status: 200, body: "{}", headers: { "access-control-allow-origin": "*", "content-type": "application/json" } });
  });

  // A real click (mouse-driven, through Playwright's actionability checks): it both starts the run
  // and, like any real button click, leaves the button focused.
  await retry.click();
  // aria-disabled, not the disabled attribute: Important #1's fix means the button never becomes
  // natively disabled, so clicking it while busy can't drop focus the way `disabled` would (B9/B26).
  await expect(retry).toHaveAttribute("aria-disabled", "true");
  await expect(retry).toBeFocused();
  // A second, immediate click while busy: dispatched in-page (bypassing Playwright's own actionability
  // wait — hover + frame-stability checks — which has enough real latency here that a second *real*
  // Playwright click could land after the first run already finished, no longer testing anything).
  // This mirrors the unit test's `retry.click(); retry.click();` and the user gesture it stands in for.
  await page.evaluate(() => (document.querySelector("[data-probe-retry]") as HTMLButtonElement).click());
  await expect(retry).toBeFocused(); // the programmatic click must not have moved focus away
  await expect(retry).not.toHaveAttribute("aria-disabled", "true", { timeout: 8000 });
  await expect(retry).toHaveText("check again");
  expect(requests, "exactly one extra probe from the two clicks").toBe(1);
});

// B26 (Lighthouse, T13): the status row sits above the fold on a phone. The probe's result text and the
// retry button that appears with JS must not move the content below it: CLS 0.17 here cost /p/ its 95.
test("the live status never shifts the page below it", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[])
        if (!e.hadRecentInput) w.__cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  // On a slow phone the page's JS and the service's answer both land after the first paint; locally they'd
  // land before it, and a change before the first paint isn't a shift. So hold both back.
  await page.route("**/_astro/*.js", async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
  await page.route(PROBED, async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.fulfill({ status: 200, body: "{}", headers: { "access-control-allow-origin": "*", "content-type": "application/json" } });
  });
  for (const slug of ["meowsenger", "auth"]) {
    await page.goto(`/p/${slug}/`);
    await expect(page.locator(".mw-status__tag")).not.toHaveText("[wait]", { timeout: 8000 });
    await expect(page.locator("[data-probe-retry]")).toHaveText("check again");
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await page.evaluate(() => (window as unknown as { __cls: number }).__cls), `/p/${slug}/ CLS`).toBeLessThan(0.01);
  }
});

// Important #1: [hidden] didn't actually hide .mw-btn (its `display: inline-flex` won on specificity),
// so an enabled, do-nothing button showed before JS ran and stayed that way entirely with JS off.
test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("the retry button stays hidden, and the noscript message explains why", async ({ page }) => {
    await page.goto("/p/auth/");
    await expect(page.locator(".mw-status__tag")).toHaveText("[wait]"); // the server-rendered state, untouched
    await expect(page.locator("[data-probe-retry]")).toBeHidden();
    await expect(page.locator(".probe .mw-muted")).toContainText("live status needs JavaScript");
  });
});

test("the diagram keeps its contrast against its own background in both themes", async ({ page }) => {
  for (const theme of ["dark", "light"] as const) {
    await page.addInitScript((t) => localStorage.setItem("mw-theme", t), theme);
    await page.goto("/p/auth/");
    // Minor #5: prove the theme actually took, so a silent fallback to one theme can't make this
    // test pass in both loop iterations for the wrong reason.
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const ratios = await page.locator(".dg-box").first().evaluate((box) => {
      const title = box.parentElement!.querySelector(".dg-title")!;
      const note = box.parentElement!.querySelector(".dg-note")!;
      const arrow = box.parentElement!.querySelector(".dg-arrow"); // the first step always has one (only the last step doesn't)
      const toRgb = (s: string) => (s.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number);
      const linear = (c: number) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
      const luminance = ([r, g, b]: number[]) => 0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!);
      const contrast = (a: number[], b: number[]) => {
        const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
        return (hi + 0.05) / (lo + 0.05);
      };
      const boxFill = toRgb(getComputedStyle(box).fill);
      const titleFill = toRgb(getComputedStyle(title).fill);
      const noteFill = toRgb(getComputedStyle(note).fill);
      const stroke = toRgb(getComputedStyle(box).stroke);
      const bodyBg = toRgb(getComputedStyle(document.body).backgroundColor);
      return {
        titleOnBox: contrast(titleFill, boxFill),
        noteOnBox: contrast(noteFill, boxFill),
        strokeOnPage: contrast(stroke, bodyBg),
        arrowOnPage: arrow ? contrast(toRgb(getComputedStyle(arrow).stroke), bodyBg) : null,
      };
    });
    expect(ratios.titleOnBox, `${theme}: dg-title text vs its box background`).toBeGreaterThanOrEqual(3);
    expect(ratios.noteOnBox, `${theme}: dg-note text vs its box background`).toBeGreaterThanOrEqual(4.5);
    expect(ratios.strokeOnPage, `${theme}: dg-box stroke vs the page background`).toBeGreaterThanOrEqual(3);
    expect(ratios.arrowOnPage, `${theme}: dg-arrow vs the page background`).not.toBeNull();
    expect(ratios.arrowOnPage!, `${theme}: dg-arrow vs the page background`).toBeGreaterThanOrEqual(3);
  }
});

test("pages without a public service say so instead of pretending", async ({ page }) => {
  for (const slug of ["moonmeow", "sunmeow"]) {
    await page.goto(`/p/${slug}/`);
    await expect(page.locator(".mw-status__tag")).toHaveText("[info]");
    await expect(page.locator(".mw-status")).toContainText("there's no public service to check");
  }
});
