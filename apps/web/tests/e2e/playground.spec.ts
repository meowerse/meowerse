import { test, expect } from "./fixtures";

test("the setup lives in the URL: load it, change it, reload it; nothing goes to a server", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto("/ui/playground/?c=button&p.variant=primary&p.children=send&theme=light");
  const stage = page.locator(".pg__stage");
  await expect(stage.locator(".mw-btn--primary")).toHaveText("send");
  await expect(stage).toHaveClass(/mw-theme--light/);
  await page.getByLabel("variant").selectOption("danger");
  await expect(page).toHaveURL(/p\.variant=danger/);
  await page.getByRole("radio", { name: /round/ }).check();
  await expect(page).toHaveURL(/radius=2/);
  expect(await stage.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--r-m"))).toBe("8px");
  await page.reload();
  await expect(stage.locator(".mw-btn--danger")).toHaveText("send");
  await expect(page.locator(".pg__code")).toContainText('<Button variant="danger">send</Button>');
  await expect(page.locator(".pg__code")).toContainText("--r-m: 8px;");
  const origin = new URL(page.url()).origin;
  expect(requests.filter((u) => !u.startsWith(origin))).toEqual([]);
  expect(await page.locator("[style]").evaluateAll((els) => els.filter((e) => !e.classList.contains("pg__stage")).length)).toBe(0);
});

test("bad URL values fall back to defaults, and switching components keeps the tokens", async ({ page }) => {
  await page.goto("/ui/playground/?c=nope&p.variant=hack&radius=9&density=comfy");
  await expect(page.locator(".pg__stage .mw-btn--secondary")).toHaveText("save");
  await page.getByLabel("component").selectOption("StatusLine");
  await expect(page).toHaveURL(/c=statusline/);
  await expect(page).toHaveURL(/density=comfy/);
  await expect(page.locator(".pg__stage .mw-status")).toContainText("connecting…");
});

test("a URL-valued prop is never playable: a shared link can't turn the site's own wordmark into a link to an attacker's page", async ({ page }) => {
  await page.goto("/ui/playground/?c=wordmark&p.href=https://evil.example/login");
  const link = page.locator(".pg__stage .mw-wordmark");
  await expect(link).toHaveAttribute("href", "/");
  // No p.href control was ever built for it, so there's nothing to write back either.
  await expect(page).not.toHaveURL(/p\.href/);
  await expect(page).not.toHaveURL(/evil\.example/);
  // Clicking it stays on this site (same-origin navigation, not evil.example).
  await link.click();
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/$/);
});

test("announcements: switching a component, resetting tokens, and copying a link are each announced once, concisely", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "clipboard permissions are desktop-only in this setup");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/ui/playground/");
  const note = page.locator(".btn-row [role=status]");
  await expect(note).toHaveText("");
  await page.getByLabel("component").selectOption("StatusLine");
  await expect(note).toHaveText("showing StatusLine");
  await page.getByRole("radio", { name: /round/ }).check();
  await page.getByRole("button", { name: "reset tokens" }).click();
  await expect(note).toHaveText("tokens reset");
  await page.getByRole("button", { name: "copy a link to this setup" }).click();
  await expect(note).toHaveText("link copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("/ui/playground/");
  // The whole preview stage never carries aria-live any more — it re-announced on every keystroke.
  await expect(page.locator(".pg__stage")).not.toHaveAttribute("aria-live");
});
