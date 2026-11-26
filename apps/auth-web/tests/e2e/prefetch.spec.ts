import { test, expect, type Page } from "@playwright/test";

// Hover prefetch must only ever touch the public allowlist (src/lib/prefetch.ts), never a session, CSRF, Turnstile
// or OIDC path, and must not trip the CSP. Run against dist-e2e (built with a Turnstile site key) served with the
// real _headers. LIMITATION: challenges.cloudflare.com is stubbed (a script, no iframe), so the CSP's frame-src for
// Turnstile and the real challenge are NOT exercised here.
const FORBIDDEN = /^\/(login|signup|consent|verify|account|dashboard|developers|error|mc|authorize|token|logout|api|\.well-known)(\/|$)/;
const ALLOWED_PREFETCH = ["/", "/about/", "/docs/", "/privacy/", "/terms/"];

type Tracked = Window & { __pageshows?: boolean[]; __issued?: string[] };

// Unique token per render/reset, also across page loads (a reload must not look like a restore).
const turnstileStub = async (page: Page) => {
  await page.route("https://challenges.cloudflare.com/**", (r) => r.fulfill({
    contentType: "text/javascript",
    body: `(() => { const cbs = {}; let n = 0; const issue = (id) => { const t = "tok-" + crypto.randomUUID(); (window.__issued ??= []).push(t); setTimeout(() => cbs[id](t), 10); };
      window.turnstile = { render(el, o) { const id = "w" + (++n); cbs[id] = o.callback; issue(id); return id; }, reset(id) { issue(id); }, remove() {} }; })();`,
  }));
};

async function watch(page: Page) {
  const paths: string[] = [];
  const violations: string[] = [];
  page.on("request", (r) => { if (r.url().startsWith("http://127.0.0.1")) paths.push(new URL(r.url()).pathname); });
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => console.error("Refused to: " + e.violatedDirective));
    // one entry per pageshow: a fresh load starts a new array, a bfcache restore appends to the old one
    const w = window as Tracked;
    (w.__pageshows ??= []);
    addEventListener("pageshow", (e) => w.__pageshows!.push(e.persisted));
  });
  return { paths, violations, flow: () => paths.filter((p) => FORBIDDEN.test(p) && p !== "/api/session") }; // /api/session: header's own fetch
}

const hydrated = (page: Page) => expect(page.locator("astro-island[ssr]")).toHaveCount(0);
const prefetched = (page: Page) => page.$$eval("link[rel=prefetch]", (ls) => ls.map((l) => new URL((l as HTMLLinkElement).href).pathname));

/** Asserts every matching link is unmarked, then hovers it (at least one must exist). */
async function hoverAll(page: Page, sel: string) {
  const links = page.locator(sel);
  expect(await links.count()).toBeGreaterThan(0);
  for (const a of await links.all()) {
    await expect(a).not.toHaveAttribute("data-astro-prefetch"); // timing-independent: Astro's hover waits 80 ms and cancels on leave
    await a.hover({ timeout: 2000 });
  }
}

test("hovering every link on public pages prefetches only the allowlist and never requests a flow path", async ({ page }) => {
  const seen = await watch(page);
  const all = new Set<string>();
  for (const start of ["/", "/about/", "/docs/", "/privacy/", "/terms/", "/404/"]) {
    await page.goto(start);
    await hydrated(page);
    const links = page.locator("a[href^='/']");
    expect(await links.count()).toBeGreaterThan(0);
    for (const a of await links.all()) {
      await a.hover({ timeout: 2000 });
      // a marked link to another page must end up prefetched (proves hover works, so "nothing forbidden" is not vacuous)
      const [marked, path] = await a.evaluate((el) => [el.hasAttribute("data-astro-prefetch"), new URL((el as HTMLAnchorElement).href).pathname] as const);
      if (marked && path !== new URL(page.url()).pathname) await expect.poll(() => prefetched(page)).toContain(path);
    }
    (await prefetched(page)).forEach((p) => all.add(p));
    await page.waitForLoadState("networkidle");
  }
  expect(all.size).toBeGreaterThan(0);
  for (const p of all) expect(ALLOWED_PREFETCH).toContain(p);
  expect(seen.flow()).toEqual([]);
  expect(seen.violations).toEqual([]);
});

test("hovering the sign-in / create-account links prefetches nothing", async ({ page }) => {
  const seen = await watch(page);
  await page.goto("/");
  await hydrated(page); // /login and /signup anchors only exist once LandingCta hydrates
  await page.waitForLoadState("networkidle"); // header's own /api/session probe done before we count
  const before = seen.paths.length;
  await hoverAll(page, "a[href^='/login'], a[href^='/signup']");
  await page.locator("a[data-astro-prefetch][href='/about/']").first().hover({ timeout: 2000 }); // barrier
  await expect.poll(() => prefetched(page)).toContain("/about/");
  await page.waitForLoadState("networkidle");
  expect(await prefetched(page)).toEqual(["/about/"]);
  expect(seen.paths.slice(before).filter((p) => FORBIDDEN.test(p))).toEqual([]);
  expect(seen.violations).toEqual([]);
});

// /login is served no-store (public/_headers), so it is intentionally NOT bfcache-eligible: back is a full reload
// (this test also uses page.route, which can itself disable bfcache in Chromium, so it cannot tell the two causes apart)
// and the widget renders a fresh token. This pins that (a restore would carry a stale single-use token) and proves
// the form submits a new token after back/forward. It does not claim bfcache restore of /login works.
test("login after back/forward is a fresh load (no-store or route interception, not bfcache) and submits a fresh Turnstile token", async ({ page }) => {
  await turnstileStub(page);
  const seen = await watch(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/login", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, error: "invalid_credentials" }) });
  });
  const submit = async () => {
    await hydrated(page);
    await page.getByLabel("username").fill("alice");
    await page.getByRole("textbox", { name: "password" }).fill("pw");
    await page.getByRole("button", { name: /sign in|verifying/ }).click();
    await expect(page.getByText("wrong username or password.")).toBeVisible();
  };
  await page.goto("/login/");
  await submit();
  const lastBefore = await page.evaluate(() => (window as Tracked).__issued!.at(-1)!);
  await page.goto("/about/");
  await page.goBack();
  await expect(page).toHaveURL(/\/login\/$/);
  const shows = await page.evaluate(() => (window as Tracked).__pageshows!);
  expect(shows.at(-1)).toBe(false); // not restored (no-store, or route interception)
  await submit();
  expect(bodies).toHaveLength(2);
  const tokens = bodies.map((b) => b["cf-turnstile-response"] as string);
  expect(tokens[1]).toMatch(/^tok-/);
  expect(tokens[1]).not.toBe(lastBefore);
  expect(tokens[1]).not.toBe(tokens[0]);
  expect(seen.violations).toEqual([]);
});

// /about/ is cacheable, so it may be restored from bfcache (Chromium decides). Either way prefetch must still work after back.
test("public page: prefetch still works after back/forward (bfcache restore or reload)", async ({ page }, info) => {
  const seen = await watch(page);
  await page.goto("/about/");
  await hydrated(page);
  await page.goto("/privacy/");
  await page.goBack();
  await expect(page).toHaveURL(/\/about\/$/);
  await hydrated(page);
  // no page.route in this test, so the annotation shows whether Chromium CAN restore pages in this setup
  info.annotations.push({ type: "bfcache-restored", description: String((await page.evaluate(() => (window as Tracked).__pageshows!)).at(-1)) });
  await page.locator("a[data-astro-prefetch][href='/docs/']").first().hover({ timeout: 2000 });
  await expect.poll(() => prefetched(page)).toContain("/docs/");
  expect(seen.flow()).toEqual([]);
  expect(seen.violations).toEqual([]);
});
