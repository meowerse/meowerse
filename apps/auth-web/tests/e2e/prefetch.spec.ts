import { test, expect, type Page } from "@playwright/test";

// Hover prefetch must only ever touch the public allowlist (src/lib/prefetch.ts), never a session, CSRF, Turnstile
// or OIDC path, and must not trip the CSP; the login form must survive back/forward with a working Turnstile token.
// Run against dist-e2e (built with a Turnstile site key); challenges.cloudflare.com is stubbed below.
const FORBIDDEN = /^\/(login|signup|consent|verify|account|dashboard|developers|error|mc|authorize|token|logout|api|\.well-known)(\/|$)/;

const turnstileStub = async (page: Page) => {
  await page.route("https://challenges.cloudflare.com/**", (r) => r.fulfill({
    contentType: "text/javascript",
    body: `(() => { let n = 0; const cbs = {};
      window.turnstile = { render(el, o) { const id = "w" + (++n); cbs[id] = o.callback; setTimeout(() => o.callback("tok-" + id), 10); return id; },
        reset(id) { setTimeout(() => cbs[id]("tok-" + id + "-reset" + (++n)), 10); }, remove() {} }; })();`,
  }));
};

async function watch(page: Page) {
  const paths: string[] = [];
  const violations: string[] = [];
  page.on("request", (r) => { if (r.url().startsWith("http://127.0.0.1")) paths.push(new URL(r.url()).pathname); });
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error("Refused to: " + e.violatedDirective)));
  return { paths, violations };
}

test("hovering every link on public pages never requests a flow path; CSP stays quiet", async ({ page }) => {
  const seen = await watch(page);
  const prefetched: string[] = [];
  for (const start of ["/", "/about/", "/docs/", "/privacy/", "/terms/", "/404/"]) {
    await page.goto(start);
    const hrefs = await page.$$eval("a[href^='/']", (as) => as.map((a) => a.getAttribute("href")!));
    for (const a of await page.locator("a[href^='/']").all()) { await a.hover().catch(() => {}); await page.waitForTimeout(150); } // Astro waits 80ms of hover
    prefetched.push(...await page.$$eval("link[rel=prefetch]", (ls) => ls.map((l) => new URL((l as HTMLLinkElement).href).pathname)));
    expect(hrefs.length).toBeGreaterThan(0);
  }
  // sanity: the mechanism is live (so "nothing forbidden" is not vacuous) and only allowlisted pages were prefetched
  expect(prefetched.length).toBeGreaterThan(0);
  for (const p of prefetched) expect(["/", "/about/", "/docs/", "/privacy/", "/terms/"]).toContain(p);
  // the only requests to flow paths are our own goto()s (the /404 page is a missing path), none are prefetches
  // /api/session is the header's own session probe (a fetch on load, not a prefetch)
  expect(seen.paths.filter((p) => FORBIDDEN.test(p) && p !== "/api/session")).toEqual([]);
  expect(seen.violations).toEqual([]);
});

test("login hover issues no request to /login or /signup", async ({ page }) => {
  await turnstileStub(page);
  await page.goto("/");
  await page.waitForLoadState("networkidle"); // let the header's own /api/session probe finish first
  const seen = await watch(page);
  for (const a of await page.locator("a[href^='/login'], a[href^='/signup']").all()) { await a.hover().catch(() => {}); await page.waitForTimeout(250); }
  expect(seen.paths.filter((p) => FORBIDDEN.test(p))).toEqual([]);
  expect(await page.locator("link[rel=prefetch]").count()).toBe(0);
});

test("login form works after back/forward with a Turnstile token", async ({ page }) => {
  await turnstileStub(page);
  const seen = await watch(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/login", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, error: "invalid_credentials" }) });
  });
  await page.goto("/login/");
  await page.goto("/about/");
  await page.goBack();
  await page.goForward();
  await page.goBack();
  await expect(page).toHaveURL(/\/login\/$/);
  const submit = async () => {
    await page.getByLabel("username").fill("alice");
    await page.getByRole("textbox", { name: "password" }).fill("pw");
    await page.getByRole("button", { name: /sign in|verifying/ }).click();
    await expect(page.getByText("wrong username or password.")).toBeVisible();
  };
  await submit();
  await submit();
  expect(bodies).toHaveLength(2);
  const tokens = bodies.map((b) => b["cf-turnstile-response"] as string);
  expect(tokens[0]).toMatch(/^tok-/);
  expect(tokens[1]).toMatch(/^tok-/);
  expect(tokens[1]).not.toBe(tokens[0]); // reset after the failed attempt issued a fresh token
  expect(seen.violations).toEqual([]);
});
