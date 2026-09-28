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
