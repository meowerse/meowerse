import { test, expect, PROBED } from "./fixtures";

test.describe("live status (B9)", () => {
  test("up, with the answer time", async ({ page }) => {
    await page.goto("/p/auth/");
    await expect(page.locator(".mw-status__tag")).toHaveText("[ ok ]");
    await expect(page.locator(".mw-status")).toContainText(/auth — up · \d+ ms/);
  });
  test("an error answer is down, announced", async ({ page }) => {
    await page.route(PROBED, (r) => r.fulfill({ status: 503, body: "", headers: { "access-control-allow-origin": "*" } }));
    await page.goto("/p/auth/");
    await expect(page.locator(".mw-status")).toContainText("auth — down · answered 503");
    await expect(page.locator(".mw-status")).toHaveAttribute("role", "alert");
  });
  test("no answer is a visible wait, then unknown after 5 s, never down", async ({ page }) => {
    await page.route(PROBED, () => { /* never answer */ });
    await page.goto("/p/auth/");
    await expect(page.locator(".mw-status__tag")).toHaveText("[wait]");
    await expect(page.locator(".mw-status")).toContainText("auth — unknown · no answer in 5 s", { timeout: 9000 });
  });
  test("unreachable from this browser is unknown", async ({ page }) => {
    await page.route(PROBED, (r) => r.abort("failed"));
    await page.goto("/p/meowsenger/");
    await expect(page.locator(".mw-status")).toContainText("meowsenger — unknown · couldn't reach it from here");
  });
});
