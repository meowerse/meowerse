// Browser check for intent prefetch against the real build + perf mock server.
// Run: bun run build && bun perf/intent-check.ts
import { chromium } from "@playwright/test";
import { join } from "node:path";
import { startMock } from "./mock-server";

const mock = startMock(join(process.cwd(), "dist"));
const browser = await chromium.launch();
const bad: string[] = [];
const check = (name: string, pass: boolean, info = "") => { console.log(pass ? "ok  " : "FAIL", name, info); if (!pass) bad.push(name); };
const hist = /\/api\/chats\/([^/]+)\/messages(\?|$)/;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block", baseURL: mock.url });
  const page = await ctx.newPage();
  const reqs: { t: number; id: string }[] = [];
  const t0 = Date.now();
  page.on("request", (r) => { const m = hist.exec(new URL(r.url()).pathname + new URL(r.url()).search); if (m && r.method() === "GET") reqs.push({ t: Date.now() - t0, id: m[1] }); });
  await page.goto("/app");
  const rows = page.locator(".mw-chatrow");
  await rows.nth(1).waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
  const base = reqs.length;
  // quick pass over rows: no requests
  for (let i = 0; i < 3; i++) { await rows.nth(i).hover(); await page.waitForTimeout(40); }
  await page.mouse.move(5, 5);
  await page.waitForTimeout(500);
  check("quick pass issues 0 history requests", reqs.length === base, `(${reqs.length - base})`);
  // hover then dwell: exactly one history request, before any click
  await rows.nth(1).hover();
  await page.waitForTimeout(600);
  check("hover dwell issues 1 history request", reqs.length === base + 1, `(${reqs.length - base})`);
  const before = reqs.length;
  await rows.nth(1).click();
  await page.locator(".mw-chat__log").waitFor();
  const skel = await page.locator(".mw-skel").count();
  await page.waitForTimeout(600);
  console.log("info click-time history requests (background revalidation):", reqs.length - before, "skeletons at open:", skel);
  check("open after hover shows no loading skeleton", skel === 0);
  await ctx.close();
} finally { await browser.close(); mock.stop(); }
console.log(bad.length ? `VERIFY intent-check: ${bad.length} failure(s)` : "VERIFY intent-check: all ok");
process.exit(bad.length ? 1 : 0);
