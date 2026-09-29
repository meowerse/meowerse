import { test, expect, hydrated } from "./fixtures";

test("ConfirmDialog: the phrase must match exactly, and the reason shows until it does", async ({ page }) => {
  await page.goto("/ui/components/confirm-dialog/");
  await hydrated(page, "#demo-title");
  await page.getByRole("button", { name: "delete “Cats & Co”" }).click();
  const dialog = page.getByRole("dialog", { name: "delete this group?" });
  await expect(dialog.locator("code")).toHaveText("Cats & Co");
  const confirm = dialog.getByRole("button", { name: "delete group" });
  await dialog.getByRole("textbox").fill("cats & co");
  await expect(confirm).toBeDisabled();
  await expect(dialog).toContainText("doesn't match yet");
  await dialog.getByRole("textbox").fill("Cats & Co");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.locator(".demo__out")).toHaveText("deleted (not really: this is a demo).");
});

test("Toast: a pushed toast shows in the notifications region", async ({ page }) => {
  await page.goto("/ui/components/toast-provider/");
  await hydrated(page, "#demo-title");
  await page.getByRole("button", { name: "success" }).click();
  await expect(page.getByRole("region", { name: "notifications" })).toContainText("message sent");
});

test("AuthGate: a failing session check is an error with a retry, never a redirect", async ({ page }) => {
  await page.goto("/ui/components/auth-gate/");
  await hydrated(page, "#demo-title");
  const demo = page.locator(".demo-stage");
  await expect(demo).toContainText("the account service had a problem.");
  await expect(demo.getByRole("button", { name: "try again" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/ui/components/auth-gate/");
});

test("Prompt: sends exactly what was typed; Enter sends on desktop, the button sends on phones", async ({ page }, info) => {
  await page.goto("/ui/components/prompt/");
  await hydrated(page, "#demo-title");
  const box = page.locator(".demo-stage textarea");
  await box.fill("hello ПРИВЕТ Cats");
  if (info.project.name === "desktop") await box.press("Enter");
  else { await box.press("Enter"); await expect(box).toHaveValue("hello ПРИВЕТ Cats\n"); await page.locator(".demo-stage .mw-prompt__send").click(); }
  await expect(page.locator(".bubble--own").last()).toHaveText("hello ПРИВЕТ Cats");
});

test("AppHeader: the session switch drives the header", async ({ page }) => {
  await page.goto("/ui/components/app-header/");
  await hydrated(page, "#demo-title");
  await page.locator(".demo-stage").getByRole("radio", { name: "signed in" }).check();
  await expect(page.locator(".demo-stage .mw-header")).toContainText("alxnko");
});

// B9 (final review): a demo's server-rendered preview must not look ready before React has hydrated it.
test("a demo is inert with a visible wait until it hydrates, then it works", async ({ page }) => {
  // Hold the React client back a moment so the pre-hydration state is observable, then let it through.
  let release = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route(/\/_astro\/client\.[^/]*\.js$/, async (route) => { await held; await route.continue(); });
  await page.goto("/ui/components/modal/");
  const shell = page.locator(".demo-stage [data-demo]");
  await shell.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await expect(shell.locator("[data-demo-stage]")).toHaveAttribute("inert");
  await expect(shell.locator(".mw-status--wait")).toContainText("loading the demo…");
  release();
  await hydrated(page, "#demo-title");
  await expect(shell.locator("[data-demo-stage]")).not.toHaveAttribute("inert");
  await expect(shell.locator("[data-demo-wait]")).toHaveCount(0);
  await expect(shell).toHaveAttribute("data-ready", "");
  await shell.getByRole("button", { name: "rename chat" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("a demo whose chunk never arrives stays inert and turns into an error with a reload", async ({ page }) => {
  test.setTimeout(45_000);
  await page.route(/\/_astro\/client\.[^/]*\.js$/, (route) => route.abort());
  await page.goto("/ui/components/modal/");
  const shell = page.locator(".demo-stage [data-demo]");
  await shell.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await expect(shell.locator(".mw-status--wait")).toContainText("loading the demo…");
  const fail = shell.locator(".mw-status--fail");
  await expect(fail).toContainText("the demo didn't load. reload the page to try again.", { timeout: 20_000 });
  await expect(fail).toHaveAttribute("role", "alert");
  await expect(shell.locator("[data-demo-stage]")).toHaveAttribute("inert");
  // inert: the dead preview button can't take focus or a click
  expect(await shell.locator("button", { hasText: "rename chat" }).evaluate((b: HTMLButtonElement) => { b.focus(); return document.activeElement === b; })).toBe(false);
  await shell.locator("button", { hasText: "rename chat" }).click({ force: true });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.unroute(/\/_astro\/client\.[^/]*\.js$/);
  await Promise.all([page.waitForEvent("load"), fail.getByRole("button", { name: "reload" }).click()]);
});

test("without JavaScript a demo claims no loading: the wait line stays hidden and the note explains", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const page = await ctx.newPage();
  await page.goto("/ui/components/modal/");
  const shell = page.locator(".demo-stage [data-demo]");
  await expect(shell.locator("[data-demo-wait]")).toBeHidden();
  // Playwright turns off script execution, not the parser's scripting flag, so <noscript> stays raw
  // text here: check the note is shipped rather than rendered.
  const note = (sel: string) => page.locator(sel).evaluate((el) => el.querySelector("noscript")?.textContent ?? "");
  expect(await note(".demo-stage [data-demo]")).toContain("This demo needs JavaScript to respond.");
  await page.goto("/ui/playground/");
  await expect(page.locator(".pg-fallback")).toBeHidden();
  expect(await note("[data-playground]")).toContain("The playground needs JavaScript.");
  await ctx.close();
});
