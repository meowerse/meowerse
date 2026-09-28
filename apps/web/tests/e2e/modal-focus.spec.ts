import { test, expect, hydrated } from "./fixtures";

// SP1 deferral, fix round 1: Modal's usable() skips display:none and visibility:hidden controls.
// jsdom can't lay out, so this runs in a real browser. Fix round 1 moved the demo's two hidden
// controls to the trap's EDGES: "clear" (visibility:hidden while the name is empty) is the first
// focusable thing in the panel, and "advanced" (display:none while collapsed, holding a checkbox)
// is the last. A hidden control mid-order leaves native Tab skipping it on its own — the previous
// version of this demo put both there, so a broken usable() never showed up here. At the edges, a
// broken usable() shows immediately: the trap's own Tab/Shift+Tab interception only fires when
// document.activeElement equals its (wrongly-computed) first/last, so a wrong edge either fails to
// wrap at all (focus silently stays put, or a Tab/Shift+Tab escapes the dialog to the browser
// chrome) or wraps onto a genuinely unfocusable node (a no-op — see the report's mutation evidence).
const focused = (page: import("@playwright/test").Page) => page.evaluate(() => {
  const a = document.activeElement as HTMLElement;
  return [a.tagName.toLowerCase(), a.getAttribute("type") ?? "", a.getAttribute("aria-label") ?? a.textContent?.trim() ?? ""].join(":");
});

test("focus skips invisible and collapsed edge controls, wraps to the true first/last, and returns to the trigger", async ({ page }) => {
  await page.goto("/ui/components/modal/");
  await hydrated(page, "#demo-title");
  const trigger = page.getByRole("button", { name: "rename chat" });
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "rename chat" })).toBeVisible();
  expect(await focused(page)).toBe("input:text:"); // the name field, not "clear" (hidden, DOM-first)

  const tabs = async (n: number, shift = false) => {
    const seen: string[] = [];
    for (let i = 0; i < n; i++) { await page.keyboard.press(shift ? "Shift+Tab" : "Tab"); seen.push(await focused(page)); }
    return seen;
  };

  // State A — empty name, "advanced" collapsed. True order: field, cancel, "more options". "clear"
  // (visibility:hidden) must never be the first; the collapsed checkbox (display:none ancestor)
  // must never be the last.
  expect(await tabs(2)).toEqual(["button::cancel", "button::more options"]);
  expect(await tabs(1)).toEqual(["input:text:"]); // Tab from the true last wraps to the true first
  await page.keyboard.press("Shift+Tab"); // back on "more options"
  expect(await tabs(1, true)).toEqual(["button::cancel"]);
  await page.keyboard.press("Shift+Tab"); // back on the name field, the true first
  expect(await tabs(1, true)).toEqual(["button::more options"]); // Shift+Tab from it wraps to the true last

  // Fill the name: "clear" becomes real and is now the true first; save enables; "advanced" is
  // still collapsed, so "more options" is still the true last.
  await page.getByLabel("new name").focus();
  await page.keyboard.type("Cats & Co");
  expect(await tabs(4)).toEqual(["button::cancel", "button::save", "button::more options", "button:button:clear the name"]);
  expect(await tabs(1)).toEqual(["input:text:"]); // a normal forward step (field follows clear), not a wrap
  await page.getByRole("button", { name: "more options" }).focus();
  expect(await tabs(1)).toEqual(["button:button:clear the name"]); // Tab from the true last wraps to the true first

  // Open "advanced": its checkbox is now real and becomes the new true last.
  await page.getByRole("button", { name: "more options" }).click();
  expect(await tabs(1)).toEqual(["input:checkbox:"]);
  expect(await tabs(1)).toEqual(["button:button:clear the name"]); // Tab from the true last (checkbox) wraps to the true first
  expect(await tabs(1, true)).toEqual(["input:checkbox:"]); // Shift+Tab from the true first wraps to the true last (checkbox)

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.getByLabel("new name").fill("Cats & Co");
  await page.getByRole("button", { name: "save" }).click();
  await expect(page.locator(".demo__out")).toHaveText("renamed to “Cats & Co”");
});
