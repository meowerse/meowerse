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
// Condition waits instead of fixed sleeps: the log reached `where` ("bottom" = pinned to the tail, "any" = just stable)
// and its scrollTop was unchanged for 3 consecutive frames (>= 2 rAF); capped at ~2 s of frames.
const settled = (page: import("@playwright/test").Page, where: "bottom" | "any") => page.evaluate((w) => new Promise<void>((done) => {
  const l = document.querySelector(".mw-chat__log")!; let last = -1, same = 0, n = 0;
  const f = () => {
    const there = w === "any" ? true : l.scrollHeight - l.scrollTop - l.clientHeight < 80;
    same = there && l.scrollTop === last ? same + 1 : 0; last = l.scrollTop;
    if (same >= 3 || ++n > 120) done(); else requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
}), where);
// Scroll the log to the top and wait for the older page the scroll triggers (if any) to land and the log to stop moving:
// a prepend landing around the pill tap is what shifted every row (CLS 0.27-0.57).
const toTop = async (page: import("@playwright/test").Page) => {
  const older = page.waitForResponse((r) => r.url().includes("before="), { timeout: 1500 }).catch(() => null);
  await page.locator(".mw-chat__log").evaluate((el) => { el.scrollTop = 0; });
  await older;
  await settled(page, "any");
};
const mark = (page: import("@playwright/test").Page) => page.evaluate(() => { (window as unknown as { __mark: number }).__mark = performance.now(); });
const post = (p: string, b: unknown) => fetch(mock.url + p, { method: "POST", body: JSON.stringify(b) });
try {
  for (const vp of [{ width: 390, height: 844, mobile: true }, { width: 1280, height: 800, mobile: false }])
    for (const scheme of ["light", "dark"] as const)
      for (const motion of ["no-preference", "reduce"] as const) {
        const tag = `${vp.width}/${scheme}/${motion}`;
        await post("/__mock/reset", {});
        const ctx = await browser.newContext({ viewport: vp, hasTouch: vp.mobile, isMobile: vp.mobile, colorScheme: scheme, reducedMotion: motion, serviceWorkers: "block", baseURL: mock.url });
        await ctx.addInitScript(() => {
          const w = window as unknown as { __cls: number; __anims: number; __shifts: unknown[]; __mark: number };
          w.__cls = 0; w.__anims = 0; w.__shifts = []; w.__mark = performance.now();
          const rect = (r: DOMRectReadOnly) => `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
          const desc = (n: Node | null) => { const e = n as Element | null; return e?.tagName ? `${e.tagName.toLowerCase()}${e.className ? "." + String(e.className).split(" ").join(".") : ""}` : String(n); };
          new PerformanceObserver((l) => l.getEntries().forEach((e) => {
            const x = e as unknown as { hadRecentInput: boolean; value: number; sources: { node: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[] };
            if (x.hadRecentInput) return;
            w.__cls += x.value;
            w.__shifts.push({ value: x.value, sinceMark: Math.round(e.startTime - w.__mark), sources: x.sources.map((s) => `${desc(s.node)} ${rect(s.previousRect)} -> ${rect(s.currentRect)}`) });
          })).observe({ type: "layout-shift", buffered: true });
          const a = Element.prototype.animate;
          Element.prototype.animate = function (...args: Parameters<typeof a>) { if ((this as HTMLElement).classList.contains("mw-chat__log")) w.__anims++; return a.apply(this, args); };
        });
        const page = await ctx.newPage();
        await page.goto("/app");
        const rows = page.locator(".mw-chatrow");
        await rows.first().waitFor({ timeout: 20000 });
        const click = (i: number) => rows.nth(i).evaluate((el) => (el as HTMLElement).click());
        await mark(page);
        await click(0);
        await page.locator(".mw-chat__log .mw-msg").first().waitFor({ timeout: 20000 });
        const chatId = new URL(page.url()).searchParams.get("chat")!;
        if (vp.mobile) { await page.getByRole("button", { name: "back to chats" }).tap(); await page.waitForFunction(() => document.querySelector(".mw-chat")?.getAttribute("data-open") === "0"); }
        await mark(page);
        await click(1);
        await page.locator(".mw-chat__log .mw-msg").first().waitFor({ timeout: 20000 });
        const anims = await page.evaluate(() => (window as unknown as { __anims: number }).__anims);
        check(motion === "reduce" || vp.mobile ? anims === 0 : anims >= 1, `${tag}: switch fade animations=${anims}${vp.mobile ? " (phone: list<->chat, no direct switch)" : ""}`);
        // pill: at the bottom no pill; scrolled up one appears and scrolls once on click
        const chat2 = new URL(page.url()).searchParams.get("chat")!;
        await settled(page, "bottom");
        await post("/__mock/push", { chat: chat2, body: "at-bottom line" });
        await page.locator(".mw-chat__log").getByText("at-bottom line").waitFor({ timeout: 5000 });
        await settled(page, "bottom");
        check((await page.locator(".mw-chat__newpill").count()) === 0, `${tag}: no pill while at bottom`);
        await toTop(page);
        await post("/__mock/push", { chat: chat2, body: "scrolled-up line" });
        const pill = page.locator(".mw-chat__newpill");
        await pill.waitFor({ timeout: 5000 });
        const pos = await page.evaluate(() => { const l = document.querySelector(".mw-chat__log")!; return { dist: l.scrollHeight - l.scrollTop - l.clientHeight }; });
        check(pos.dist > 200, `${tag}: pill shown, reader not teleported (distance from tail=${pos.dist})`);
        if (shots) await page.screenshot({ path: join(shots, `pill-${vp.width}-${scheme}-${motion}.png`) });
        await mark(page);
        await pill.click();
        await page.waitForFunction(() => { const l = document.querySelector(".mw-chat__log")!; return l.scrollHeight - l.scrollTop - l.clientHeight < 80; }, null, { timeout: 5000 });
        check((await pill.count()) === 0, `${tag}: pill hidden after reaching bottom`);
        const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
        const shifts = cls > 0.01 ? JSON.stringify(await page.evaluate(() => (window as unknown as { __shifts: unknown[] }).__shifts)) : "";
        check(cls <= 0.01, `${tag}: CLS ${cls.toFixed(4)} <= 0.01${shifts ? ` shifts(ms since last tap/switch): ${shifts}` : ""}`);
        void chatId;
        await ctx.close();
      }
  // 320x568, tall multi-line composer: the pill (anchored to the log's bottom) must not overlap the composer.
  {
    await post("/__mock/reset", {});
    const ctx = await browser.newContext({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true, serviceWorkers: "block", baseURL: mock.url });
    const page = await ctx.newPage();
    await page.goto("/app");
    await page.locator(".mw-chatrow").first().waitFor({ timeout: 20000 });
    await page.locator(".mw-chatrow").first().evaluate((el) => (el as HTMLElement).click());
    await page.locator(".mw-chat__log .mw-msg").first().waitFor({ timeout: 20000 });
    const chat = new URL(page.url()).searchParams.get("chat")!;
    const ta = page.getByRole("textbox", { name: "message", exact: true });
    await ta.fill("one\ntwo\nthree\nfour\nfive"); // grows the composer
    await settled(page, "bottom");
    await toTop(page);
    await post("/__mock/push", { chat, body: "overlap probe" });
    const pill = page.locator(".mw-chat__newpill");
    await pill.waitFor({ timeout: 5000 });
    const r = await page.evaluate(() => {
      const b = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      return { pillBottom: b(".mw-chat__newpill").bottom, composerTop: b(".mw-composer").top, logBottom: b(".mw-chat__log").bottom, h: b(".mw-chat__newpill").height };
    });
    check(r.pillBottom <= r.composerTop + 0.5, `320x568 multi-line composer: pill bottom ${r.pillBottom.toFixed(1)} <= composer top ${r.composerTop.toFixed(1)}`);
    if (shots) await page.screenshot({ path: join(shots, "pill-320x568-multiline.png") });
    await ctx.close();
  }
} finally { await browser.close(); mock.stop(); }
process.exit(bad ? 1 : 0);
