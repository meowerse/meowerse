// Phone navigation check against the real build + perf mock server: Back from a chat shows the list (stays in the app),
// Forward reopens, list scroll is restored, a deep link opens and Back doesn't loop, touch Enter = newline.
// Run: bun run build && bun perf/nav-check.ts [screenshotDir]
import { chromium } from "@playwright/test";
import { join } from "node:path";
import { startMock } from "./mock-server";

const mock = startMock(join(process.cwd(), "dist"));
const browser = await chromium.launch();
const shots = process.argv[2];
let bad = 0;
const check = (c: boolean, m: string) => { console.log(c ? "ok  " : "FAIL", m); if (!c) bad++; };
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 420 }, hasTouch: true, isMobile: true, serviceWorkers: "block", baseURL: mock.url });
  const page = await ctx.newPage();
  const open = () => page.locator(".mw-chat").getAttribute("data-open");
  await page.goto("/app");
  await page.locator(".mw-chatrow").first().waitFor({ timeout: 20000 });
  await page.locator(".mw-chatrow").nth(5).scrollIntoViewIfNeeded(); await page.locator(".mw-chat__list").evaluate((el) => { el.scrollTop = Math.min(150, el.scrollHeight - el.clientHeight); });
  const st = await page.locator(".mw-chat__list").evaluate((el) => el.scrollTop);
  await page.locator(".mw-chatrow").nth(2).evaluate((el) => (el as HTMLElement).click()); // no auto-scroll before the click
  await page.locator(".mw-chat__log").waitFor();
  check((await open()) === "1", "chat opened");
  if (shots) await page.screenshot({ path: join(shots, "chat.png") });
  const ta = page.getByRole("textbox", { name: "message", exact: true });
  await ta.tap(); await ta.fill("a"); await ta.press("Enter"); await ta.type("b");
  check((await ta.inputValue()) === "a\nb", "touch Enter inserts a newline (not sent)");
  await page.getByRole("button", { name: "send", exact: true }).tap();
  check((await ta.inputValue()) === "", "send button sends on touch");
  await page.goBack();
  await page.waitForFunction(() => document.querySelector(".mw-chat")?.getAttribute("data-open") === "0");
  check(!page.url().includes("chat="), "Back returns to the list, still in the app");
  const back = await page.locator(".mw-chat__list").evaluate((el) => el.scrollTop);
  check(st > 0 && Math.abs(back - st) <= 1, `list scroll restored (${st} -> ${back})`);
  if (shots) await page.screenshot({ path: join(shots, "list-after-back.png") });
  await page.goForward();
  await page.locator(".mw-chat__log").waitFor();
  check((await open()) === "1" && page.url().includes("chat="), "Forward reopens the chat");
  await page.getByRole("button", { name: "back to chats" }).tap();
  await page.waitForFunction(() => document.querySelector(".mw-chat")?.getAttribute("data-open") === "0");
  check(!page.url().includes("chat="), "in-app back button pops to the list");
  // deep link
  await ctx.close();
  const c2 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: "block", baseURL: mock.url });
  const p2 = await c2.newPage();
  await p2.goto("/app");
  await p2.locator(".mw-chatrow").first().waitFor({ timeout: 20000 });
  await p2.locator(".mw-chatrow").first().tap();
  await p2.locator(".mw-chat__log").waitFor();
  const deep = p2.url();
  await p2.goto(deep);
  await p2.locator(".mw-chat__log").waitFor({ timeout: 20000 });
  const before = await p2.evaluate(() => history.length);
  check(before >= 1 && p2.url() === deep, `deep link opens (${deep})`);
  await p2.getByRole("button", { name: "back to chats" }).tap();
  await p2.waitForFunction(() => document.querySelector(".mw-chat")?.getAttribute("data-open") === "0");
  check(!p2.url().includes("chat=") && (await p2.evaluate(() => history.length)) === before, "deep link close: replaced, no extra entry");
  await c2.close();
} finally { await browser.close(); mock.stop(); }
console.log(bad ? `VERIFY nav-check: ${bad} failure(s)` : "VERIFY nav-check: all ok");
process.exit(bad ? 1 : 0);
