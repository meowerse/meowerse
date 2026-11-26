// PR-17b motion check against the real build + perf mock server: chat-switch fade (animates under
// no-preference, never under reduce), "new messages" pill (scrolled up only, one scroll on activation),
// and CLS <= 0.01 across a switch + pill appearance.
// Run: bun run build && bun perf/motion-check.ts [screenshotDir]
import { chromium } from "@playwright/test";
import { join } from "node:path";
import { startMock } from "./mock-server";

const mock = startMock(join(process.cwd(), "dist"));
const browser = await chromium.launch();
const shots = process.argv[2];
let bad = 0;
const check = (c: boolean, m: string) => { console.log(c ? "ok  " : "FAIL", m); if (!c) bad++; };
const post = (p: string, b: unknown) => fetch(mock.url + p, { method: "POST", body: JSON.stringify(b) });
try {
  for (const vp of [{ width: 390, height: 844, mobile: true }, { width: 1280, height: 800, mobile: false }])
    for (const scheme of ["light", "dark"] as const)
      for (const motion of ["no-preference", "reduce"] as const) {
        const tag = `${vp.width}/${scheme}/${motion}`;
        await post("/__mock/reset", {});
        const ctx = await browser.newContext({ viewport: vp, hasTouch: vp.mobile, isMobile: vp.mobile, colorScheme: scheme, reducedMotion: motion, serviceWorkers: "block", baseURL: mock.url });
        await ctx.addInitScript(() => {
          const w = window as unknown as { __cls: number; __anims: number };
          w.__cls = 0; w.__anims = 0;
          new PerformanceObserver((l) => l.getEntries().forEach((e) => { const x = e as unknown as { hadRecentInput: boolean; value: number }; if (!x.hadRecentInput) w.__cls += x.value; })).observe({ type: "layout-shift", buffered: true });
          const a = Element.prototype.animate;
          Element.prototype.animate = function (...args: Parameters<typeof a>) { if ((this as HTMLElement).classList.contains("mw-chat__log")) w.__anims++; return a.apply(this, args); };
        });
        const page = await ctx.newPage();
        await page.goto("/app");
        const rows = page.locator(".mw-chatrow");
        await rows.first().waitFor({ timeout: 20000 });
        const click = (i: number) => rows.nth(i).evaluate((el) => (el as HTMLElement).click());
        await click(0);
        await page.locator(".mw-chat__log .mw-msg").first().waitFor({ timeout: 20000 });
        const chatId = new URL(page.url()).searchParams.get("chat")!;
        if (vp.mobile) { await page.getByRole("button", { name: "back to chats" }).tap(); await page.waitForFunction(() => document.querySelector(".mw-chat")?.getAttribute("data-open") === "0"); }
        await click(1);
        await page.locator(".mw-chat__log .mw-msg").first().waitFor({ timeout: 20000 });
        const anims = await page.evaluate(() => (window as unknown as { __anims: number }).__anims);
        check(motion === "reduce" || vp.mobile ? anims === 0 : anims >= 1, `${tag}: switch fade animations=${anims}${vp.mobile ? " (phone: list<->chat, no direct switch)" : ""}`);
        // pill: at the bottom no pill; scrolled up one appears and scrolls once on click
        const chat2 = new URL(page.url()).searchParams.get("chat")!;
        await page.waitForTimeout(400);
        await post("/__mock/push", { chat: chat2, body: "at-bottom line" });
        await page.waitForTimeout(400);
        check((await page.locator(".mw-chat__newpill").count()) === 0, `${tag}: no pill while at bottom`);
        await page.locator(".mw-chat__log").evaluate((el) => { el.scrollTop = 0; });
        await page.waitForTimeout(300);
        await post("/__mock/push", { chat: chat2, body: "scrolled-up line" });
        const pill = page.locator(".mw-chat__newpill");
        await pill.waitFor({ timeout: 5000 });
        const pos = await page.evaluate(() => { const l = document.querySelector(".mw-chat__log")!; return { dist: l.scrollHeight - l.scrollTop - l.clientHeight }; });
        check(pos.dist > 200, `${tag}: pill shown, reader not teleported (distance from tail=${pos.dist})`);
        if (shots) await page.screenshot({ path: join(shots, `pill-${vp.width}-${scheme}-${motion}.png`) });
        await pill.click();
        await page.waitForFunction(() => { const l = document.querySelector(".mw-chat__log")!; return l.scrollHeight - l.scrollTop - l.clientHeight < 80; }, null, { timeout: 5000 });
        check((await pill.count()) === 0, `${tag}: pill hidden after reaching bottom`);
        const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
        check(cls <= 0.01, `${tag}: CLS ${cls.toFixed(4)} <= 0.01`);
        void chatId;
        await ctx.close();
      }
} finally { await browser.close(); mock.stop(); }
process.exit(bad ? 1 : 0);
