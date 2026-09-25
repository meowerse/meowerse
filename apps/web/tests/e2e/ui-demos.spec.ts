import { test, expect } from "./fixtures";

async function hydrated(page: import("@playwright/test").Page, selector: string) {
  // Center it: scrollIntoViewIfNeeded only guarantees the heading's own edge is in view, which can
  // leave a short page's astro-island (right below the heading, display:contents) a few px past the
  // fold — never intersecting, so client:visible never fires. Centering leaves headroom below it.
  await page.locator(selector).evaluate((el) => el.scrollIntoView({ block: "center" }));
  await expect(page.locator("astro-island[ssr]")).toHaveCount(0, { timeout: 15_000 });
}

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
