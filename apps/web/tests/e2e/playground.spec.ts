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

// Regression: clearing a required text control (Prompt's value) handed the component `undefined`, its
// `value.trim()` threw, and React unmounted the whole island: controls, preview and snippet all gone.
test("clearing Prompt's value or Avatar's name keeps the playground: the preview renders the empty value, and the URL keeps it", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/ui/playground/?c=prompt");
  const stage = page.locator(".pg__stage");
  await page.getByRole("textbox", { name: "value", exact: true }).fill("");
  await expect(page).toHaveURL(/p\.value=(&|$)/);
  await expect(stage.locator("textarea")).toHaveValue("");
  await expect(stage.getByRole("button", { name: "send" })).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator(".pg__code")).toContainText('<Prompt label="message" value="" />');
  await expect(page.getByLabel("component")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "value", exact: true })).toHaveValue("");
  await expect(stage.locator("textarea")).toHaveValue("");

  await page.getByLabel("component").selectOption("Avatar");
  await page.getByRole("textbox", { name: "name", exact: true }).fill("");
  await expect(stage.getByRole("img", { name: "no name" })).toHaveText("?");
  await page.getByRole("textbox", { name: "name", exact: true }).fill("   ");
  await expect(stage.getByRole("img", { name: "no name" })).toHaveText("?");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "name", exact: true })).toHaveValue("   ");
  await expect(stage.locator(".mw-status--fail")).toHaveCount(0);
  expect(errors).toEqual([]);
});

// Containment: any component that does throw (forced here, on a sentinel value, by making the String
// method Avatar calls throw) is an inline error in the stage; the controls stay, the island's watchdog
// doesn't flip to "didn't load", and fixing the input brings the preview back.
test("a preview that throws is contained: an inline error, live controls, and it recovers when the input changes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const trim = String.prototype.trim;
    String.prototype.trim = function (this: string) {
      if (String(this) === "boom") throw new Error("forced failure for the test");
      return trim.call(this);
    };
  });
  await page.goto("/ui/playground/?c=avatar&p.name=boom");
  const stage = page.locator(".pg__stage");
  const fail = stage.locator(".mw-status--fail");
  await expect(fail).toContainText("this combination of props can't render");
  await expect(fail).toHaveAttribute("role", "alert");
  await expect(fail.locator("code")).toHaveText("forced failure for the test");
  // The rest of the island is still there and usable.
  const name = page.getByRole("textbox", { name: "name", exact: true });
  await expect(name).toHaveValue("boom");
  await expect(page.locator("[data-playground]")).toHaveAttribute("data-ready", "");
  await page.getByLabel("size").selectOption("lg");
  await expect(fail).toBeVisible();
  await name.fill("alxnko");
  await expect(fail).toHaveCount(0);
  await expect(stage.getByRole("img", { name: "alxnko" })).toHaveText("A");
  await name.fill("boom");
  await expect(fail).toBeVisible();
  await name.fill("cat");
  await expect(stage.getByRole("img", { name: "cat" })).toHaveClass(/mw-avatar--lg/);
  // The island marked itself ready although its first preview threw, so the watchdog (which only acts
  // on a root without data-ready) never turns this into "the playground didn't load".
  await expect(page.locator("[data-playground] .pg-fallback")).toHaveCount(0);
  expect(errors).toEqual([]);
});
