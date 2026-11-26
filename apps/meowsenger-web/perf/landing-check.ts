// Landing ("/") check against the real build + perf mock server (real _headers CSP): hovering "open app" preloads the
// app's chunks and nothing else (no /api, /auth, /app/ HTML), no CSP violations, CLS 0, old /?chat= deep links forward.
// Run: bun run build && bun perf/landing-check.ts
import { chromium } from "@playwright/test";
import { join } from "node:path";
import { startMock } from "./mock-server";

const mock = startMock(join(process.cwd(), "dist"));
const browser = await chromium.launch();
const bad: string[] = [];
const check = (name: string, pass: boolean, info = "") => { console.log(pass ? "ok  " : "FAIL", name, info); if (!pass) bad.push(name); };
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, serviceWorkers: "block", baseURL: mock.url });
  const page = await ctx.newPage();
  const paths: string[] = [];
  const csp: string[] = [];
  page.on("request", (r) => paths.push(new URL(r.url()).pathname));
  page.on("console", (m) => { if (/content security policy/i.test(m.text())) csp.push(m.text()); });
  await page.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const link = page.getByRole("link", { name: "open app" });
  check("open app link targets /app/", (await link.getAttribute("href")) === "/app/");
  check("no modulepreload before intent", (await page.locator("link[rel=modulepreload]").count()) === 0);
  const before = paths.length;
  await page.mouse.move(5, 5);
  await link.hover();
  await page.waitForTimeout(500);
  const warmed = await page.locator("link[rel=modulepreload]").evaluateAll((ls) => ls.map((l) => new URL((l as HTMLLinkElement).href).pathname));
  check("hover injects modulepreload for /_astro/*.js", warmed.length > 0 && warmed.every((p) => /^\/_astro\/[\w.-]+\.js$/.test(p)), `(${warmed.length})`);
  const fetched = paths.slice(before);
  check("every warm-up request is a /_astro/*.js chunk", fetched.length > 0 && fetched.every((p) => /^\/_astro\/[\w.-]+\.js$/.test(p)), fetched.join(","));
  check("zero requests to /api, /auth or /app/", !paths.some((p) => /^\/(api|auth|app)(\/|$)/.test(p)), paths.filter((p) => /^\/(api|auth|app)/.test(p)).join(","));
  const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
  check("landing CLS is 0", cls === 0, `(${cls})`);
  check("0 CSP violations on the landing", csp.length === 0, csp.join(" | "));
  // old deep link → app, query + hash preserved
  await page.goto("/?chat=x&m=1#h");
  await page.waitForURL(/\/app\/\?chat=x&m=1#h$/);
  check("/?chat=x forwards to /app/?chat=x", true, page.url());
  await ctx.close();
} finally { await browser.close(); mock.stop(); }
console.log(bad.length ? `VERIFY landing-check: ${bad.length} failure(s)` : "VERIFY landing-check: all ok");
process.exit(bad.length ? 1 : 0);
