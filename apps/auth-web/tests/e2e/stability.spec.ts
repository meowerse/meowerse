import { test, expect, type Page } from "@playwright/test";

// PR-21: the developer dashboard and account page show reserved-geometry skeletons (no spinner swap) while the API
// answers, so loading moves nothing (CLS <= 0.01), and a failed refresh keeps the shown data. The API is mocked
// (same-origin /api/*), with a delay so the skeleton is really on screen before the data lands.
const CLIENT = { clientId: "mw_1", name: "my-app", displayName: "My App", clientType: "public", allowedScopes: ["openid"], verifiedOnly: false, allowOfflineAccess: false, status: "active" };
const ACCOUNT = { username: "alxnko", displayName: null, avatarUrl: null, verified: true, hasPassword: true, deleteEnabled: true, telegram: { linked: true, username: "tg" }, recoveryRemaining: 8, csrf: "c" };
const GRANT = { clientId: "mw_x", displayName: "x app", approvedScopes: ["openid"], updatedAt: null };
const DELAY = 700;

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const later = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), DELAY));

async function mock(page: Page, routes: Record<string, () => ReturnType<typeof json>>, delayed = true) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const h = routes[path];
    if (!h) return route.fulfill(json({ error: "unmocked" }, 404));
    return route.fulfill(delayed && path !== "/api/session" ? await later(h()) : h());
  });
}

const session = () => json({ authenticated: true, username: "alxnko", verified: true });
const startCls = (page: Page) => page.addInitScript(() => {
  const w = window as unknown as { __cls: number };
  w.__cls = 0;
  new PerformanceObserver((l) => { for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) w.__cls += e.value; })
    .observe({ type: "layout-shift", buffered: true });
});
const cls = (page: Page) => page.evaluate(() => new Promise<number>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r((window as unknown as { __cls: number }).__cls)))));

for (const [name, clients] of [["no apps", []], ["one app", [CLIENT]]] as const) {
  test(`dashboard (${name}): skeleton, then data, with CLS <= 0.01`, async ({ page }) => {
    await startCls(page);
    await mock(page, { "/api/session": session, "/api/dev/clients": () => json({ clients, csrf: "c" }) });
    await page.goto("/developers");
    await expect(page.getByRole("status", { name: "loading your apps" })).toBeVisible();
    await expect(page.locator(".mw-spinner")).toHaveCount(0);
    await (clients.length ? expect(page.getByText("My App")) : expect(page.getByText("no apps yet."))).toBeVisible();
    expect(await cls(page)).toBeLessThanOrEqual(0.01);
  });
}

test("account: skeleton, then data, with CLS <= 0.01", async ({ page }) => {
  await startCls(page);
  await mock(page, { "/api/session": session, "/api/account": () => json(ACCOUNT), "/api/account/grants": () => json({ grants: [GRANT] }) });
  await page.goto("/account");
  await expect(page.getByRole("status", { name: "loading account" })).toBeVisible();
  await expect(page.getByText("x app")).toBeVisible();
  expect(await cls(page)).toBeLessThanOrEqual(0.01);
});

test("dashboard: a failed refresh keeps the apps and says so; a 401 drops them and offers sign-in", async ({ page }) => {
  let next = () => json({ clients: [CLIENT], csrf: "c" });
  await mock(page, { "/api/session": session, "/api/dev/clients": () => next() }, false);
  await page.route("**/api/dev/clients", (r) => (r.request().method() === "POST" ? r.fulfill(json({ ok: true, clientId: "mw_new" })) : r.fallback()));
  await page.goto("/developers");
  await expect(page.getByText("My App")).toBeVisible();
  const create = async () => {
    await page.getByLabel(/^name/).fill("other-app");
    await page.getByLabel("redirect uri").fill("https://x.app/cb");
    await page.getByRole("button", { name: "create app" }).click();
  };
  next = () => json({ error: "boom" }, 500);
  await create();
  await expect(page.getByText(/couldn't refresh your apps/)).toBeVisible();
  await expect(page.getByText("My App")).toBeVisible();
  next = () => json({}, 401);
  await page.getByRole("button", { name: "try again" }).click();
  await expect(page.getByText(/to manage your apps/)).toBeVisible();
  await expect(page.getByText("My App")).toHaveCount(0);
});
