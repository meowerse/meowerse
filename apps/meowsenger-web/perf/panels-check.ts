// Browser check for the on-demand panels against the real build + perf mock server: every panel opens, no CSP errors,
// and a 404ing chunk (stale deploy) shows the Reload alert. Run: bun run build && bun perf/panels-check.ts
import { chromium } from "@playwright/test";
import { join } from "node:path";
import { startMock } from "./mock-server";

const mock = startMock(join(process.cwd(), "dist"));
const browser = await chromium.launch();
const bad: string[] = [];
const fail = (m: string) => { bad.push(m); console.log("FAIL", m); };
const ok = (m: string) => console.log("ok  ", m);
async function fresh(block?: RegExp) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block", baseURL: mock.url });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (/content security policy|refused to/i.test(m.text())) fail(`CSP: ${m.text()}`); });
  page.on("pageerror", (e) => { if (!block) fail(`pageerror: ${e.message}`); });
  if (block) await page.route(block, (r) => r.abort());
  await page.goto("/app");
  await page.locator(".mw-chatrow").first().waitFor({ timeout: 20000 });
  await page.locator(".mw-chatrow").first().click();
  await page.locator(".mw-chat__log").waitFor();
  return { ctx, page };
}
try {
  const { ctx, page } = await fresh();
  const step = async (name: string, open: () => Promise<void>, sel: string) => {
    await open();
    try { await page.locator(sel).first().waitFor({ timeout: 5000 }); ok(`${name} opens`); } catch { fail(`${name} did not open (${sel})`); }
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5).catch(() => {});
  };
  await step("new chat", () => page.getByRole("button", { name: "new chat" }).click(), "[role=dialog]");
  await step("settings", () => page.getByRole("button", { name: "settings" }).click(), "[role=dialog]");
  await step("search", () => page.getByRole("button", { name: "search this chat" }).click(), ".mw-chat__searchbtn.is-on");
  await step("message menu", () => page.locator(".mw-chat__log [data-mid], .mw-chat__log .mw-bubble").first().click({ button: "right" }), "[role=menu]");
  await page.setViewportSize({ width: 390, height: 800 }); // the "more" button is mobile-only
  await step("more menu", () => page.getByRole("button", { name: "more chat actions" }).click(), "[role=menu]");
  await page.setViewportSize({ width: 1280, height: 800 });
  const rows = page.locator(".mw-chatrow");
  for (let i = 0; i < (await rows.count()) && !(await page.locator(".mw-chat__grouphead").count()); i++) await rows.nth(i).click();
  await step("members", () => page.locator(".mw-chat__grouphead").click(), "[role=dialog], .mw-drawer");
  await ctx.close();

  // Stale deploy: every panel chunk 404s (the aborted fetch also stands in for offline).
  const f = await fresh(/\/_astro\/(Settings|NewChatModal|ForwardModal|MemberDrawer|SearchPanel|MessageMenu|EmojiPicker)\.[^/]+\.js$/);
  await f.page.getByRole("button", { name: "settings" }).click();
  const reload = f.page.getByRole("button", { name: "reload" });
  try { await reload.waitFor({ timeout: 8000 }); ok("failed chunk shows Reload"); } catch { fail("no Reload button after failed chunk"); }
  await f.ctx.close();
} finally { await browser.close(); mock.stop(); }
console.log(bad.length ? `VERIFY panels-check: ${bad.length} failure(s)` : "VERIFY panels-check: all ok, no CSP errors");
process.exit(bad.length ? 1 : 0);
