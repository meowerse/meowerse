import { test, expect } from "./fixtures";

// SP1 deferral: Modal's usable() skips display:none and visibility:hidden controls. jsdom can't lay
// out, so this runs in a real browser against the Modal demo.
const focused = (page: import("@playwright/test").Page) => page.evaluate(() => {
  const a = document.activeElement as HTMLElement;
  return [a.tagName.toLowerCase(), a.getAttribute("type") ?? "", a.getAttribute("aria-label") ?? a.textContent?.trim() ?? ""].join(":");
});

test("focus skips invisible and collapsed controls, follows them when they appear, and returns to the trigger", async ({ page }) => {
  await page.goto("/ui/components/modal/");
  const trigger = page.getByRole("button", { name: "rename chat" });
  await trigger.scrollIntoViewIfNeeded();
  await expect(page.locator("astro-island[ssr]")).toHaveCount(0, { timeout: 15_000 });
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "rename chat" })).toBeVisible();
  expect(await focused(page)).toBe("input:text:");

  const tabs = async (n: number, shift = false) => {
    const seen: string[] = [];
    for (let i = 0; i < n; i++) { await page.keyboard.press(shift ? "Shift+Tab" : "Tab"); seen.push(await focused(page)); }
    return seen;
  };
  // empty name: "clear" is visibility:hidden, "save" disabled, the options display:none
  expect(await tabs(3)).toEqual(["button::more options", "button::cancel", "input:text:"]);
  expect(await tabs(1, true)).toEqual(["button::cancel"]);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab"); // back on the name field
  await page.keyboard.type("Cats & Co");
  expect(await tabs(5)).toEqual(["button:button:clear the name", "button::more options", "button::cancel", "button::save", "input:text:"]);
  await page.getByRole("button", { name: "more options" }).click();
  expect(await tabs(1)).toEqual(["input:checkbox:"]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByLabel("new name").fill("Cats & Co");
  await page.getByRole("button", { name: "save" }).click();
  await expect(page.locator(".demo__out")).toHaveText("renamed to “Cats & Co”");
});
