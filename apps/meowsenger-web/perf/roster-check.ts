// Roster cache check against the real build + perf mock server: re-entering a group within the TTL makes no
// /members request, and a channel owner sees the composer. Run: bun run build && bun perf/roster-check.ts
import { chromium } from "@playwright/test";
import { join } from "node:path";
import { startMock } from "./mock-server";

const mock = startMock(join(process.cwd(), "dist"));
const browser = await chromium.launch();
let bad = 0;
const check = (c: boolean, m: string) => { console.log(c ? "ok  " : "FAIL", m); if (!c) bad++; };
try {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, serviceWorkers: "block", baseURL: mock.url });
  const page = await ctx.newPage();
  let members = 0;
  page.on("request", (r) => { if (/\/api\/chats\/[^/]+\/members/.test(r.url())) members++; });
  await page.goto("/app");
  const row = (name: string) => page.locator(".mw-chatrow", { hasText: name }).first();
  await row("platform-team").waitFor({ timeout: 20000 });
  await row("platform-team").click();
  await page.locator(".mw-chat__log").waitFor();
  await page.waitForFunction(() => document.querySelector(".mw-chat__log")?.textContent?.includes("PERF-MARK::grp1000"));
  await page.waitForTimeout(500);
  check(members === 1, `first entry fetches the roster once (${members})`);
  await row("Ada").click();
  await page.waitForFunction(() => document.querySelector(".mw-chat__log")?.textContent?.includes("PERF-MARK::dm300"));
  await row("platform-team").click();
  await page.waitForFunction(() => document.querySelector(".mw-chat__log")?.textContent?.includes("PERF-MARK::grp1000"));
  await page.waitForTimeout(500);
  check(members === 1, `re-entering within the TTL makes no member request (${members})`);
  await row("release-notes").click();
  await page.waitForFunction(() => document.querySelector(".mw-chat__log")?.textContent?.includes("PERF-MARK::chan60"));
  check(await page.getByRole("textbox", { name: "message", exact: true }).isVisible(), "channel owner sees the composer");
  await ctx.close();
} finally { await browser.close(); mock.stop(); }
console.log(bad ? `VERIFY roster-check: ${bad} failure(s)` : "VERIFY roster-check: all ok");
process.exit(bad ? 1 : 0);
