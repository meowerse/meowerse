import { test, expect, PROBED } from "./fixtures";

test("hero: the wordmark is the heading, one green action, the cat's poster paints first", async ({ page }) => {
  // Hold the lazy renderer's own network work (the renderer chunk + cat.bin) so the poster is
  // deterministically still the only thing on screen while the assertions below run — no product
  // code should ever carry a delay that exists only so a test can win a race (the fix this test
  // replaces). Once released, both requests complete and the live canvas takes over.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(/\/_astro\/(renderer\.[^/]+\.js|cat\.[^/]+\.bin)$/, async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/");
  await expect(page.locator("h1")).toContainText("meowerse");
  await expect(page.locator("h1 .mw-wordmark")).toBeVisible();
  await expect(page.locator("main .mw-btn--primary")).toHaveCount(1);
  await expect(page.locator(".hero .mw-cat3d img")).toBeVisible();
  await expect(page.locator(".hero .mw-cat3d")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator(".hero .mw-cat3d")).not.toHaveClass(/mw-cat3d--live/);
  release();
  await expect(page.locator(".hero .mw-cat3d")).toHaveClass(/mw-cat3d--live/);
  await expect(page.locator(".hero .mw-cat3d canvas")).toBeVisible();
});

test("ls ~/services: both live services resolve; check again is busy while it runs", async ({ page }) => {
  await page.goto("/");
  const rows = page.locator(".services [data-probe]");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(/auth — up/);
  await expect(rows.nth(1)).toContainText(/meowsenger — up/);
  const again = page.locator("[data-probe-retry]");
  await expect(again).toBeEnabled();
  await expect(again).toHaveText("check again");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(PROBED, async (route) => {
    await gate;
    await route.fulfill({ status: 200, body: "{}", headers: { "access-control-allow-origin": "*" } });
  });
  await again.click();
  await expect(again).toBeDisabled();
  await expect(again).toHaveText("checking…");
  await expect(rows.nth(0).locator(".mw-status__tag")).toHaveText("[wait]");
  release();
  await expect(again).toBeEnabled();
  await expect(rows.nth(0)).toContainText(/auth — up/);
});

test("ls ~/projects: six cards, each to its page", async ({ page }) => {
  await page.goto("/");
  const cards = page.locator("#projects .card-link");
  await expect(cards).toHaveCount(6);
  await expect(cards.first()).toHaveAttribute("href", "/p/auth/");
  await expect(cards.last()).toHaveAttribute("href", "/p/alxnko-dev/");
});

test("Cat3D: poster only under reduced motion; otherwise the renderer loads lazily", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "one pass is enough");
  // Raw browser.newContext() pages don't inherit the fixture's baseURL, so read it from the
  // project config instead of hardcoding a port (T9 note: any port must work, not just 4371).
  const baseURL = info.project.use.baseURL!;
  const stub = { status: 200, body: "{}", headers: { "access-control-allow-origin": "*" } };

  const reduced = await browser.newContext({ reducedMotion: "reduce", colorScheme: "dark" });
  await reduced.route(PROBED, (r) => r.fulfill(stub));
  const rp = await reduced.newPage();
  const rUrls: string[] = [];
  rp.on("request", (r) => rUrls.push(r.url()));
  await rp.goto(baseURL);
  await rp.waitForTimeout(1500);
  expect(rUrls.some((u) => /\/_astro\/(renderer\.[^/]+\.js|cat\.[^/]+\.bin)$/.test(u))).toBe(false);
  await expect(rp.locator(".mw-cat3d canvas")).toBeHidden();
  await reduced.close();

  const normal = await browser.newContext({ reducedMotion: "no-preference", colorScheme: "dark" });
  await normal.route(PROBED, (r) => r.fulfill(stub));
  const np = await normal.newPage();
  const nUrls: string[] = [];
  np.on("request", (r) => nUrls.push(r.url()));
  await np.goto(baseURL);
  await expect.poll(() => nUrls.some((u) => /\/_astro\/cat\.[^/]+\.bin$/.test(u)), { timeout: 10_000 }).toBe(true);
  await expect(np.locator(".mw-cat3d")).toHaveClass(/mw-cat3d--live/, { timeout: 10_000 });
  await normal.close();
});
