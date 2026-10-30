// Tier-A perf harness (PR-0). Usage (from apps/meowsenger-web, after `bun run build`):
//   bun perf/run.ts [--runs 5] [--profiles desktop,phone] [--warm 20] [--leak-switches 50] [--api-ms 150] [--ws-ms 120]
//                   [--out /var/tmp/mw-perf] [--publish]
// Output: <out>/<sha>/A/results.json + summary.md. --publish also writes docs/performance/meowsenger-baseline.json
// and refreshes the table between the markers in docs/performance/meowsenger.md.
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg, release } from "node:os";
import { join, resolve } from "node:path";
import { bundleReport } from "./bundle";
import { INSTRUMENT } from "./instrument";
import { startMock } from "./mock-server";
import { median, pct, r1 } from "./stats";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1]! : d; };
const OPT = {
  runs: Number(arg("runs", "5")), warm: Number(arg("warm", "20")), leak: Number(arg("leak-switches", "50")),
  apiMs: Number(arg("api-ms", "150")), wsMs: Number(arg("ws-ms", "120")), out: arg("out", "/var/tmp/mw-perf"),
  rtts: arg("rtts", "80,150,300").split(",").filter(Boolean).map(Number), latRuns: Number(arg("lat-runs", "3")), profiles: arg("profiles", "desktop,phone").split(","), publish: process.argv.includes("--publish"),
};
const APP = resolve(import.meta.dir, "..");
const REPO = resolve(APP, "../..");
const DIST = join(APP, "dist");
if (!existsSync(join(DIST, "app", "index.html"))) throw new Error("dist/ missing: run `bun run build` in apps/meowsenger-web first");

const PROFILES = {
  desktop: { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, cpu: 1 },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, cpu: 4 },
} as const;
type ProfileName = keyof typeof PROFILES;

// title shown in the sidebar -> chat key / marker
const CHATS = {
  dm300: { title: "Ada", marker: "PERF-MARK::dm300" }, grp1000: { title: "platform-team", marker: "PERF-MARK::grp1000" },
  chan60: { title: "release-notes", marker: "PERF-MARK::chan60" }, dm80a: { title: "Борис", marker: "PERF-MARK::dm80a" },
  dm80b: { title: "Chloe", marker: "PERF-MARK::dm80b" }, dm40: { title: "Eve", marker: "PERF-MARK::dm40" },
} as const;
type Key = keyof typeof CHATS;

type Sw = { ms: number; flashes: number; offs: number; waitMs: number; reqs: Record<string, number>; wsChat: number };
type Run = {
  boot: { rowsMs: number; reqs: Record<string, number>; wsInbox: number; wsChat: number; cls: number; longTasks: number };
  cold: Sw[]; warm: Sw[]; warmLongTasks: { n: number; totalMs: number; maxMs: number; loafBlockingMs: number };
  inp: { click: number[]; key: number[]; all: number[] };
  burst: { longTasks: number; maxMs: number; loafN: number };
  cls: { boot: number; switches: number };
  probes: { tabReturnListChats: number; tabReturnMaxConcurrentChats: number; sidebarEmptySeenOnFailedPoll: boolean; lossSent: number; lossFound: number; lostAckCopies: number; csp: number };
  reopen: Sw[]; concurrent: { switchMs: number; editApplied: boolean; editStale: boolean; deleteApplied: boolean; reactionApplied: boolean; live1: number; live2: number };
  keyboard: { focusKept: boolean; sameNode: boolean; draftKept: boolean };
  leak: { heapDeltaMB: number; nodesDelta: number; listenersDelta: number; winDocListenersDelta: number; openSocketsEnd: number; chatSocketsOpened: number; heapBaseMB: number; heapEndMB: number };
};

const gitSha = () => execSync("git rev-parse HEAD", { cwd: REPO }).toString().trim();
const gitDirty = () => execSync("git status --porcelain -- . ':!apps/meowsenger-web/dist'", { cwd: REPO }).toString().trim().length > 0;

async function ctl(base: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${base}/__mock/${path}`, { method: body === undefined && path === "stats" ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body) });
  return r.json();
}

async function newPage(browser: Browser, name: ProfileName, base: string) {
  const prof = PROFILES[name];
  const ctx: BrowserContext = await browser.newContext({
    viewport: prof.viewport, isMobile: prof.isMobile, hasTouch: prof.hasTouch, deviceScaleFactor: 1, colorScheme: "dark", serviceWorkers: "block", baseURL: base,
  });
  await ctx.addInitScript(INSTRUMENT);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: prof.cpu });
  // Request tap
  const reqs: { route: string; t: number; url: string }[] = [];
  const inflight = new Map<string, number>();
  let maxConcChats = 0;
  const routeOf = (u: URL) => (u.pathname === "/api/chats" ? "chats" : u.pathname.endsWith("/messages") ? "messages" : u.pathname.endsWith("/members") ? "members" : u.pathname === "/api/session" ? "session" : "other");
  page.on("request", (rq) => {
    const u = new URL(rq.url());
    if (!u.pathname.startsWith("/api/")) return;
    reqs.push({ route: routeOf(u), t: Date.now(), url: u.pathname + u.search });
    const n = (inflight.get(rq.url()) ?? 0) + 1;
    inflight.set(rq.url(), n);
    if (routeOf(u) === "chats") maxConcChats = Math.max(maxConcChats, n);
  });
  const done = (rq: { url(): string }) => { const n = inflight.get(rq.url()); if (n) inflight.set(rq.url(), n - 1); };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  const tap = { reqs, get maxConcChats() { return maxConcChats; }, mark: () => reqs.length, since: (i: number) => { const o: Record<string, number> = {}; for (const r of reqs.slice(i)) o[r.route] = (o[r.route] ?? 0) + 1; return o; } };
  return { ctx, page, cdp, tap };
}

// All page-side logic lives in window.__perf (instrument.ts): the app CSP forbids string eval, so Playwright only
// ever gets function bodies.
const perf = <T,>(page: Page, method: string, ...args: unknown[]): Promise<T> => page.evaluate(([m, a]) => (window as any).__perf[m as string](...(a as unknown[])), [method, args] as const) as Promise<T>;
const waitP = (page: Page, timeout: number, method: string, ...args: unknown[]) => page.waitForFunction(([m, a]) => (window as any).__perf[m as string](...(a as unknown[])), [method, args] as const, { timeout });
const evalP = <T,>(page: Page, name: string): Promise<T> => perf<T>(page, "get", name);
const perfNow = (page: Page) => perf<number>(page, "now");

async function switchTo(page: Page, tap: TapT, mock: string, key: Key): Promise<Sw> {
  const c = CHATS[key];
  const r0 = tap.mark();
  const w0 = (await ctl(mock, "stats")).wsOpen.chat as number;
  const t0 = await perfNow(page);
  const ms = await perf<number>(page, "switchTo", c.title, c.marker);
  if (ms < 0) throw new Error(`switch to ${key} failed (${ms})`);
  await perf(page, "waitState", "on", 6000);
  await page.waitForTimeout(120); // let trailing requests/frames land before counting
  const conn = await page.evaluate((from) => (window as any).__perf.conn.filter((e: any) => e.t >= from), t0) as { t: number; state: string | null }[];
  let waitMs = 0;
  conn.forEach((e, i) => { if (e.state === "wait") waitMs += (conn[i + 1]?.t ?? e.t) - e.t; });
  const w1 = (await ctl(mock, "stats")).wsOpen.chat as number;
  return { ms, flashes: conn.filter((e) => e.state === "wait").length, offs: conn.filter((e) => e.state === "off").length, waitMs, reqs: tap.since(r0), wsChat: w1 - w0 };
}
type TapT = Awaited<ReturnType<typeof newPage>>["tap"];

const sumCls = (xs: { t: number; v: number }[], from = -Infinity, to = Infinity) => xs.filter((x) => x.t >= from && x.t <= to).reduce((n, x) => n + x.v, 0);

async function journeyRun(browser: Browser, name: ProfileName, mock: string): Promise<Run> {
  await ctl(mock, "reset");
  const { ctx, page, cdp, tap } = await newPage(browser, name, mock);
  try {
    // ---- boot
    const tb = Date.now();
    await page.goto(`${mock}/app`, { waitUntil: "commit" });
    await waitP(page, 30000, "rowCount", 8);
    const rowsMs = Date.now() - tb;
    await waitP(page, 15000, "inboxOpen");
    await page.waitForTimeout(400);
    const st0 = await ctl(mock, "stats");
    const clsBoot = sumCls(await evalP(page, "cls"));
    const boot = { rowsMs, reqs: tap.since(0), wsInbox: st0.wsOpen.inbox, wsChat: st0.wsOpen.chat, cls: clsBoot, longTasks: (await evalP<any[]>(page, "lt")).length };

    // ---- cold opens (first visit of each)
    const cold: Sw[] = [];
    for (const k of ["dm300", "grp1000", "chan60", "dm80a"] as Key[]) cold.push(await switchTo(page, tap, mock, k));

    // ---- warm re-entry A -> B -> C -> A ...
    const cyc: Key[] = ["dm300", "grp1000", "dm80a"];
    const tWarm0 = await perfNow(page);
    const warm: Sw[] = [];
    for (let i = 0; i < OPT.warm; i++) warm.push(await switchTo(page, tap, mock, cyc[i % 3]!));
    const tWarm1 = await perfNow(page);
    const lt = (await evalP<{ t: number; d: number }[]>(page, "lt")).filter((x) => x.t >= tWarm0 && x.t <= tWarm1);
    const loaf = (await evalP<{ t: number; d: number; b: number }[]>(page, "loaf")).filter((x) => x.t >= tWarm0 && x.t <= tWarm1);
    const warmLongTasks = { n: lt.length, totalMs: lt.reduce((n, x) => n + x.d, 0), maxMs: Math.max(0, ...lt.map((x) => x.d)), loafBlockingMs: loaf.reduce((n, x) => n + x.b, 0) };
    const clsSwitches = sumCls(await evalP(page, "cls"), tWarm0, tWarm1);

    // ---- INP-ish: real input events
    const backIfPhone = async () => { const b = page.getByRole("button", { name: "back to chats" }); if (await b.isVisible().catch(() => false)) await b.click(); };
    const e0 = await perfNow(page);
    await backIfPhone();
    await page.locator(".mw-chatrow", { hasText: CHATS.dm300.title }).first().click();
    await waitP(page, 15000, "logHas", CHATS.dm300.marker);
    await waitP(page, 15000, "stateIs", "on");
    const ta = page.getByRole("textbox", { name: "message" });
    await ta.click();
    await ta.pressSequentially("perf harness typing: forty characters!!", { delay: 8 }); // 40 chars
    await page.keyboard.press("Enter");
    await waitP(page, 15000, "logHas", "perf harness typing");
    await backIfPhone();
    await page.locator(".mw-chatrow", { hasText: CHATS.grp1000.title }).first().click();
    await waitP(page, 15000, "logHas", CHATS.grp1000.marker);
    await waitP(page, 15000, "stateIs", "on");
    await page.getByRole("button", { name: "group members" }).click();
    await page.getByRole("dialog", { name: /members/ }).waitFor();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const ev = (await evalP<{ name: string; t: number; d: number; id: number }[]>(page, "ev")).filter((x) => x.t >= e0);
    const byId = new Map<number, { d: number; key: boolean }>();
    for (const x of ev) { const p = byId.get(x.id); const key = x.name.startsWith("key"); if (!p || x.d > p.d) byId.set(x.id, { d: x.d, key }); }
    const inp = { click: [...byId.values()].filter((x) => !x.key).map((x) => x.d), key: [...byId.values()].filter((x) => x.key).map((x) => x.d), all: [...byId.values()].map((x) => x.d) };

    // ---- repeated navigation: open / leave (back) / re-open the same chat
    const reopen: Sw[] = [];
    for (let i = 0; i < 10; i++) { await perf(page, "back"); await page.waitForTimeout(80); reopen.push(await switchTo(page, tap, mock, "dm300")); }

    // ---- mobile-keyboard proxy: does the composer (focus, node, draft) survive a chat switch? (headless has no OS keyboard)
    await perf(page, "tagComposer");
    await perf(page, "focusComposer", "draft-keep");
    await switchTo(page, tap, mock, "dm80a");
    const cs = await perf<{ present: boolean; focused: boolean; sameNode: boolean; value: string | null }>(page, "composerState");
    const keyboard = { focusKept: cs.focused, sameNode: cs.sameNode, draftKept: cs.value === "draft-keep" };

    // ---- simultaneous events while re-entering a cached chat (scripted second client)
    await switchTo(page, tap, mock, "dm300");
    const ed = await ctl(mock, "push", { chat: "grp1000", body: "CONC-TARGET-EDIT", sender: "u_002" });
    const del = await ctl(mock, "push", { chat: "grp1000", body: "CONC-TARGET-DEL", sender: "u_002" });
    const sched = (ms: number, fn: () => Promise<unknown>) => new Promise<void>((res) => setTimeout(() => void fn().then(() => res()), ms));
    const evs = [
      sched(40, async () => { await ctl(mock, "frame", { chat: "grp1000", frame: { type: "edited", id: ed.id, body: "CONC-EDITED", editedAt: Date.now() } }); await ctl(mock, "frame", { chat: "grp1000", frame: { type: "reaction", id: ed.id, emoji: "🔥", userId: "u_002", on: true } }); }),
      sched(250, async () => { await ctl(mock, "frame", { chat: "grp1000", frame: { type: "deleted", id: del.id } }); await ctl(mock, "push", { chat: "grp1000", body: "CONC-LIVE-1", sender: "u_002" }); }),
      sched(700, async () => { await ctl(mock, "push", { chat: "grp1000", body: "CONC-LIVE-2", sender: "u_002" }); }),
    ];
    const csw = await switchTo(page, tap, mock, "grp1000");
    await Promise.all(evs);
    await page.waitForTimeout(500);
    const concurrent = {
      switchMs: csw.ms, editApplied: await perf<boolean>(page, "logHas", "CONC-EDITED"), editStale: await perf<boolean>(page, "logHas", "CONC-TARGET-EDIT"),
      deleteApplied: !(await perf<boolean>(page, "logHas", "CONC-TARGET-DEL")), reactionApplied: await perf<boolean>(page, "hasAria", "🔥"),
      live1: await perf<number>(page, "occurrences", "CONC-LIVE-1"), live2: await perf<number>(page, "occurrences", "CONC-LIVE-2"),
    };

    // ---- burst in the 1000-message group: 20 typing frames + 20 reactions
    const b0 = await perfNow(page);
    for (let i = 0; i < 20; i++) {
      await ctl(mock, "frame", { chat: "grp1000", frame: { type: "typing", userId: "u_002", on: i % 2 === 0 } });
      await ctl(mock, "frame", { chat: "grp1000", frame: { type: "reaction", id: `m_grp1000_${String(980 + i).padStart(5, "0")}`, emoji: "🔥", userId: "u_002", on: true } });
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(300);
    const b1 = await perfNow(page);
    const blt = (await evalP<{ t: number; d: number }[]>(page, "lt")).filter((x) => x.t >= b0 && x.t <= b1);
    const bloaf = (await evalP<{ t: number }[]>(page, "loaf")).filter((x) => x.t >= b0 && x.t <= b1);
    const burst = { longTasks: blt.length, maxMs: Math.max(0, ...blt.map((x) => x.d)), loafN: bloaf.length };

    // ---- probes
    const tabReturn = async () => { await perf(page, "tabReturn"); };
    let i0 = tap.mark();
    await tabReturn();
    await page.waitForTimeout(900);
    const tabReturnListChats = tap.since(i0).chats ?? 0;
    const tabReturnMaxConcurrentChats = tap.maxConcChats;
    await ctl(mock, "config", { failChatsPoll: true });
    await perf(page, "watchEmpty");
    await tabReturn();
    await page.waitForTimeout(900);
    const sidebarEmptySeenOnFailedPoll = await perf<boolean>(page, "stopEmpty");
    await ctl(mock, "config", { failChatsPoll: false });
    // forced WS close while the peer sends 5 messages
    await perf(page, "waitState", "on", 8000);
    await ctl(mock, "drop");
    await page.waitForTimeout(100);
    for (let i = 0; i < 5; i++) await ctl(mock, "push", { chat: "grp1000", body: `LOSS-PROBE-${i}`, sender: "u_002" });
        await perf(page, "waitState", "on", 10000);
    await page.waitForTimeout(600);
    const lossFound = await perf<number>(page, "countIn", "LOSS-PROBE-");
    // send whose ack is lost
    await ctl(mock, "config", { dropAck: true });
    await ta.click();
    await ta.pressSequentially("ACK-PROBE", { delay: 5 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    await ctl(mock, "drop");
    await perf(page, "waitState", "on", 10000);
    await page.waitForTimeout(600);
    const lostAckCopies = await perf<number>(page, "occurrences", "ACK-PROBE");
    await ctl(mock, "config", { dropAck: false });
    const csp = await evalP<number>(page, "csp");

    return { boot, cold, warm, reopen, keyboard, concurrent, warmLongTasks, inp, burst, cls: { boot: clsBoot, switches: clsSwitches }, probes: { tabReturnListChats, tabReturnMaxConcurrentChats, sidebarEmptySeenOnFailedPoll, lossSent: 5, lossFound, lostAckCopies, csp }, leak: undefined as never };
  } finally { await cdp.detach().catch(() => {}); await ctx.close(); }
}

async function leakRun(browser: Browser, name: ProfileName, mock: string): Promise<Run["leak"]> {
  await ctl(mock, "reset");
  const { ctx, page, cdp, tap } = await newPage(browser, name, mock);
  try {
    await cdp.send("Performance.enable");
    await page.goto(`${mock}/app`, { waitUntil: "commit" });
    await waitP(page, 30000, "rowCount", 8);
    const cyc: Key[] = ["dm300", "grp1000", "dm80a"];
    for (const k of cyc) await switchTo(page, tap, mock, k); // post-boot steady state: every chat visited once
    const snap = async () => {
      await cdp.send("HeapProfiler.collectGarbage"); await cdp.send("HeapProfiler.collectGarbage");
      const m = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
      let wd = 0;
      for (const expr of ["window", "document"]) {
        const o = await cdp.send("Runtime.evaluate", { expression: expr });
        const l = await cdp.send("DOMDebugger.getEventListeners", { objectId: o.result.objectId! });
        wd += l.listeners.length;
      }
      return { heap: m.JSHeapUsedSize!, nodes: m.Nodes!, listeners: m.JSEventListeners!, wd };
    };
    const a = await snap();
    for (let i = 0; i < OPT.leak; i++) await switchTo(page, tap, mock, cyc[(i + 1) % 3]!);
    const b = await snap();
    const ws = await evalP<{ close: number | null; kind: string }[]>(page, "ws");
    return {
      heapDeltaMB: (b.heap - a.heap) / 1048576, nodesDelta: b.nodes - a.nodes, listenersDelta: b.listeners - a.listeners, winDocListenersDelta: b.wd - a.wd,
      openSocketsEnd: ws.filter((w) => w.close == null).length, chatSocketsOpened: ws.filter((w) => w.kind === "chat").length, heapBaseMB: a.heap / 1048576, heapEndMB: b.heap / 1048576,
    };
  } finally { await cdp.detach().catch(() => {}); await ctx.close(); }
}

async function latencyRun(browser: Browser, name: ProfileName, mock: string, rtt: number): Promise<{ cold: Sw[]; warm: Sw[] }> {
  await ctl(mock, "reset");
  await ctl(mock, "config", { apiMs: rtt, wsOpenMs: Math.round(rtt * 0.8), jitterMs: Math.round(rtt * 0.2) });
  const { ctx, page, cdp, tap } = await newPage(browser, name, mock);
  try {
    await page.goto(`${mock}/app`, { waitUntil: "commit" });
    await waitP(page, 30000, "rowCount", 8);
    await waitP(page, 15000, "inboxOpen");
    const cold: Sw[] = [];
    for (const k of ["dm300", "grp1000", "dm80a"] as Key[]) cold.push(await switchTo(page, tap, mock, k));
    const cyc: Key[] = ["dm300", "grp1000", "dm80a"];
    const warm: Sw[] = [];
    for (let i = 0; i < OPT.warm; i++) warm.push(await switchTo(page, tap, mock, cyc[i % 3]!));
    return { cold, warm };
  } finally { await cdp.detach().catch(() => {}); await ctx.close(); await ctl(mock, "reset"); }
}

// ---------------------------------------------------------------- aggregation
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function aggregate(runs: Run[]) {
  const lat = (sel: (r: Run) => Sw[]) => ({
    p50: r1(median(runs.map((r) => median(sel(r).map((s) => s.ms))))), p95: r1(pct(runs.flatMap((r) => sel(r).map((s) => s.ms)), 0.95)),
    perRunP50: runs.map((r) => r1(median(sel(r).map((s) => s.ms)))), n: runs.flatMap(sel).length,
  });
  const perSwitchReqs = (sel: (r: Run) => Sw[]) => {
    const all = runs.flatMap(sel); const routes = new Set(all.flatMap((s) => Object.keys(s.reqs)));
    return Object.fromEntries([...routes].map((k) => [k, r1(mean(all.map((s) => s.reqs[k] ?? 0)))]));
  };
  const warm = (r: Run) => r.warm;
  return {
    reentryWarmMs: lat(warm), coldOpenMs: lat((r) => r.cold),
    waitFlashesPerWarmSwitch: r1(mean(runs.flatMap((r) => r.warm.map((s) => s.flashes)))),
    waitFlashesPerColdOpen: r1(mean(runs.flatMap((r) => r.cold.map((s) => s.flashes)))),
    waitDwellMsPerWarmSwitch: r1(median(runs.flatMap((r) => r.warm.map((s) => s.waitMs)))),
    httpPerWarmSwitch: perSwitchReqs(warm), httpPerColdOpen: perSwitchReqs((r) => r.cold), httpBoot: Object.fromEntries(Object.keys(runs[0]!.boot.reqs).map((k) => [k, r1(median(runs.map((r) => r.boot.reqs[k] ?? 0)))])),
    chatSocketsOpenedPerSwitch: r1(mean(runs.flatMap((r) => r.warm.map((s) => s.wsChat)))),
    reopenAfterBackMs: { p50: r1(median(runs.map((r) => median(r.reopen.map((s) => s.ms))))), p95: r1(pct(runs.flatMap((r) => r.reopen.map((s) => s.ms)), 0.95)), flashes: r1(mean(runs.flatMap((r) => r.reopen.map((s) => s.flashes)))) },
    keyboard: { focusKeptRuns: runs.filter((r) => r.keyboard.focusKept).length, sameComposerNodeRuns: runs.filter((r) => r.keyboard.sameNode).length, draftKeptRuns: runs.filter((r) => r.keyboard.draftKept).length },
    concurrentEvents: { runs: runs.length, editAppliedRuns: runs.filter((r) => r.concurrent.editApplied && !r.concurrent.editStale).length, deleteAppliedRuns: runs.filter((r) => r.concurrent.deleteApplied).length, reactionAppliedRuns: runs.filter((r) => r.concurrent.reactionApplied).length, liveExactlyOnceRuns: runs.filter((r) => r.concurrent.live1 === 1 && r.concurrent.live2 === 1).length, switchMsMedian: r1(median(runs.map((r) => r.concurrent.switchMs))) },
    bootRowsVisibleMs: r1(median(runs.map((r) => r.boot.rowsMs))),
    wsAtBoot: { inbox: median(runs.map((r) => r.boot.wsInbox)), chat: median(runs.map((r) => r.boot.wsChat)) },
    inpMs: { clickP75: r1(pct(runs.flatMap((r) => r.inp.click), 0.75)), clickMax: r1(Math.max(...runs.flatMap((r) => r.inp.click), 0)), keyP75: r1(pct(runs.flatMap((r) => r.inp.key), 0.75)), keyMax: r1(Math.max(...runs.flatMap((r) => r.inp.key), 0)), allP75: r1(pct(runs.flatMap((r) => r.inp.all), 0.75)), n: runs.flatMap((r) => r.inp.all).length },
    cls: { boot: r1(median(runs.map((r) => r.cls.boot * 1000)) / 1000), bootMax: Math.max(...runs.map((r) => r.cls.boot)), switches: Math.max(...runs.map((r) => r.cls.switches)) },
    longTasksPerWarmRun: { n: r1(median(runs.map((r) => r.warmLongTasks.n))), totalMs: r1(median(runs.map((r) => r.warmLongTasks.totalMs))), maxMs: r1(Math.max(...runs.map((r) => r.warmLongTasks.maxMs))), loafBlockingMs: r1(median(runs.map((r) => r.warmLongTasks.loafBlockingMs))) },
    burst1000: { longTasksMedian: median(runs.map((r) => r.burst.longTasks)), maxMs: r1(Math.max(...runs.map((r) => r.burst.maxMs))) },
    probes: {
      tabReturnListChatsMedian: median(runs.map((r) => r.probes.tabReturnListChats)), tabReturnMaxConcurrentChats: Math.max(...runs.map((r) => r.probes.tabReturnMaxConcurrentChats)),
      sidebarEmptyOnFailedPollRuns: runs.filter((r) => r.probes.sidebarEmptySeenOnFailedPoll).length,
      messagesLostAcrossForcedCloseMedian: median(runs.map((r) => r.probes.lossSent - r.probes.lossFound)), lostAckCopiesMax: Math.max(...runs.map((r) => r.probes.lostAckCopies)), cspViolations: runs.reduce((n, r) => n + r.probes.csp, 0),
    },
    leak: {
      heapDeltaMB: r1(median(runs.map((r) => r.leak.heapDeltaMB))), heapDeltaMBMax: r1(Math.max(...runs.map((r) => r.leak.heapDeltaMB))), heapBaseMB: r1(median(runs.map((r) => r.leak.heapBaseMB))),
      nodesDelta: median(runs.map((r) => r.leak.nodesDelta)), listenersDelta: median(runs.map((r) => r.leak.listenersDelta)), winDocListenersDelta: median(runs.map((r) => r.leak.winDocListenersDelta)),
      openSocketsEndMax: Math.max(...runs.map((r) => r.leak.openSocketsEnd)), chatSocketsOpenedMedian: median(runs.map((r) => r.leak.chatSocketsOpened)),
    },
  };
}

type Lat = Record<string, Record<string, { warmP50: number | null; warmP95: number | null; coldP50: number | null; coldP95: number | null; flashes: number | null; n: number }>>;
function summaryMd(meta: any, bundle: any, agg: Record<string, ReturnType<typeof aggregate>>, lat: Lat): string {
  const L: string[] = [];
  L.push(`# Meowsenger tier-A perf baseline`, "", `- commit: \`${meta.sha}\`${meta.dirty ? " (+ uncommitted harness changes)" : ""}`, `- browser: ${meta.browser} (Playwright ${meta.playwright}, headless)`, `- host: ${meta.cpu} x${meta.cores}, load avg at start ${meta.loadStart.join(" / ")}, end ${meta.loadEnd.join(" / ")}`, `- mock latency: API ${meta.apiMs} ms, WS open ${meta.wsMs} ms (injected in the mock server; no CDP network throttling)`, `- runs: ${meta.runs} fresh browser contexts per profile (+ ${meta.runs} for the leak test), ${meta.warm} warm switches/context, ${meta.leak} switches in the leak test`, `- date: ${meta.date}`, "");
  for (const [p, a] of Object.entries(agg)) {
    const prof = PROFILES[p as ProfileName];
    L.push(`## ${p} (${prof.viewport.width}x${prof.viewport.height}, CPU ${prof.cpu}x${prof.hasTouch ? ", touch" : ""})`, "", "| metric | value |", "|---|---|");
    L.push(`| warm re-entry to visible messages p50 / p95 (ms) | ${a.reentryWarmMs.p50} / ${a.reentryWarmMs.p95} (n=${a.reentryWarmMs.n}; per-run p50: ${a.reentryWarmMs.perRunP50.join(", ")}) |`);
    L.push(`| cold chat open p50 / p95 (ms) | ${a.coldOpenMs.p50} / ${a.coldOpenMs.p95} (n=${a.coldOpenMs.n}) |`);
    L.push(`| wait (yellow) flashes per warm switch / per cold open | ${a.waitFlashesPerWarmSwitch} / ${a.waitFlashesPerColdOpen} (median dwell ${a.waitDwellMsPerWarmSwitch} ms) |`);
    L.push(`| HTTP /api per warm switch | ${JSON.stringify(a.httpPerWarmSwitch)} |`, `| HTTP /api per cold open | ${JSON.stringify(a.httpPerColdOpen)} |`, `| HTTP /api at boot (median) | ${JSON.stringify(a.httpBoot)} |`);
    L.push(`| chat sockets opened per warm switch; at boot (inbox/chat) | ${a.chatSocketsOpenedPerSwitch}; ${a.wsAtBoot.inbox}/${a.wsAtBoot.chat} |`, `| boot: 8 sidebar rows visible (ms, median) | ${a.bootRowsVisibleMs} |`);
    L.push(`| re-open same chat after "back" p50 / p95 (ms), flashes | ${a.reopenAfterBackMs.p50} / ${a.reopenAfterBackMs.p95}, ${a.reopenAfterBackMs.flashes} |`);
    L.push(`| composer across a chat switch (runs of ${meta.runs}): focus kept / same node / draft kept | ${a.keyboard.focusKeptRuns} / ${a.keyboard.sameComposerNodeRuns} / ${a.keyboard.draftKeptRuns} |`);
    L.push(`| events during re-entry (edit+react, delete, 2 live msgs), runs OK of ${a.concurrentEvents.runs}: edit / delete / reaction / live exactly once | ${a.concurrentEvents.editAppliedRuns} / ${a.concurrentEvents.deleteAppliedRuns} / ${a.concurrentEvents.reactionAppliedRuns} / ${a.concurrentEvents.liveExactlyOnceRuns} (switch ${a.concurrentEvents.switchMsMedian} ms) |`);
    L.push(`| INP-ish (ms): click p75 / max, keys p75 / max (n=${a.inpMs.n}) | ${a.inpMs.clickP75} / ${a.inpMs.clickMax}, ${a.inpMs.keyP75} / ${a.inpMs.keyMax} |`);
    L.push(`| CLS: /app boot (median / max), across ${meta.warm} switches (max) | ${a.cls.boot} / ${r1(a.cls.bootMax * 1000)! / 1000}, ${r1(a.cls.switches * 1000)! / 1000} |`);
    L.push(`| long tasks per ${meta.warm}-switch run: n / total ms / max ms / LoAF blocking ms | ${a.longTasksPerWarmRun.n} / ${a.longTasksPerWarmRun.totalMs} / ${a.longTasksPerWarmRun.maxMs} / ${a.longTasksPerWarmRun.loafBlockingMs} |`);
    L.push(`| long tasks in 1000-msg burst (20 typing + 20 reactions): median n / max ms | ${a.burst1000.longTasksMedian} / ${a.burst1000.maxMs} |`);
    L.push(`| leak after ${meta.leak} switches: heap delta MB median / max (base ${a.leak.heapBaseMB}), DOM nodes, JS listeners, window+document listeners | ${a.leak.heapDeltaMB} / ${a.leak.heapDeltaMBMax}, ${a.leak.nodesDelta}, ${a.leak.listenersDelta}, ${a.leak.winDocListenersDelta} |`);
    L.push(`| sockets still open at end of leak test (max); chat sockets opened | ${a.leak.openSocketsEndMax}; ${a.leak.chatSocketsOpenedMedian} |`);
    L.push(`| listChats per tab return (focus + visibilitychange); max concurrent | ${a.probes.tabReturnListChatsMedian}; ${a.probes.tabReturnMaxConcurrentChats} |`, `| sidebar "no chats yet" shown during a failed poll (runs of ${meta.runs}) | ${a.probes.sidebarEmptyOnFailedPollRuns} |`, `| peer messages lost across forced WS close (of 5, median) | ${a.probes.messagesLostAcrossForcedCloseMedian} |`, `| copies of a message whose ack was lost, after reconnect (max) | ${a.probes.lostAckCopiesMax} |`, `| CSP violations (all runs) | ${a.probes.cspViolations} |`, "");
  }
  if (lat) {
    L.push("## Service-latency sweep (warm re-entry, API RTT with +-20% seeded jitter, WS open = 0.8 x RTT)", "", "| profile | RTT ms | warm p50 / p95 (ms) | cold p50 / p95 (ms) | flashes per warm switch | n warm |", "|---|---|---|---|---|---|");
    for (const [p, byRtt] of Object.entries(lat)) for (const [rtt, v] of Object.entries(byRtt)) L.push(`| ${p} | ${rtt} | ${v.warmP50} / ${v.warmP95} | ${v.coldP50} / ${v.coldP95} | ${v.flashes} | ${v.n} |`);
    L.push("");
  }
  L.push("## Owner targets (warm cached re-entry p50 < 50 ms, p95 < 100 ms at the default 150 ms RTT; zero false-outage flashes on a normal switch)", "", "| profile | p50 | p95 | flashes/switch | verdict |", "|---|---|---|---|---|");
  for (const [p, a] of Object.entries(agg)) { const ok = a.reentryWarmMs.p50! < 50 && a.reentryWarmMs.p95! < 100 && a.waitFlashesPerWarmSwitch === 0; L.push(`| ${p} | ${a.reentryWarmMs.p50} | ${a.reentryWarmMs.p95} | ${a.waitFlashesPerWarmSwitch} | ${ok ? "MEETS" : "MISSES"} |`); }
  L.push("");
  L.push("## Bundle (/app, gzip -9)", "", `eager JS: ${bundle.eagerJsGzip} B gz / ${bundle.eagerJsRaw} B raw across ${bundle.eagerJs.length} chunks; CSS ${bundle.cssGzip} B gz; all built JS ${bundle.allJsGzip} B gz; HTML ${bundle.htmlGzip} B gz`, "", "| chunk | raw B | gzip B |", "|---|---|---|");
  for (const c of bundle.allJs) L.push(`| ${c.file}${bundle.eagerJs.some((e: any) => e.file === c.file) ? " (eager)" : ""} | ${c.raw} | ${c.gzip} |`);
  for (const c of bundle.css) L.push(`| ${c.file} (css) | ${c.raw} | ${c.gzip} |`);
  return L.join("\n") + "\n";
}

// ---------------------------------------------------------------- main
const mock = startMock(DIST, 0, { apiMs: OPT.apiMs, wsOpenMs: OPT.wsMs });
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
const loadStart = loadavg().map((x) => r1(x)!);
const agg: Record<string, ReturnType<typeof aggregate>> = {};
const raw: Record<string, Run[]> = {};
const latRaw: Record<string, Record<string, { cold: Sw[]; warm: Sw[] }[]>> = {};
const latAgg: Lat = {};
try {
  for (const name of OPT.profiles as ProfileName[]) {
    const runs: Run[] = [];
    for (let i = 0; i < OPT.runs; i++) {
      const t = Date.now();
      const r = await journeyRun(browser, name, mock.url);
      r.leak = await leakRun(browser, name, mock.url);
      runs.push(r);
      console.log(`[${name}] run ${i + 1}/${OPT.runs} done in ${((Date.now() - t) / 1000).toFixed(1)}s: warm p50 ${r1(median(r.warm.map((s) => s.ms)))} ms, flashes/switch ${r1(mean(r.warm.map((s) => s.flashes)))}`);
    }
    raw[name] = runs;
    agg[name] = aggregate(runs);
    latRaw[name] = {}; latAgg[name] = {};
    for (const rtt of OPT.rtts) {
      const rs: { cold: Sw[]; warm: Sw[] }[] = [];
      for (let i = 0; i < OPT.latRuns; i++) rs.push(await latencyRun(browser, name, mock.url, rtt));
      console.log(`[${name}] RTT ${rtt} ms: ${OPT.latRuns} runs done`);
      latRaw[name]![rtt] = rs;
      const w = (r: { warm: Sw[] }) => r.warm.map((s) => s.ms);
      latAgg[name]![rtt] = {
        warmP50: r1(median(rs.map((r) => median(w(r))))), warmP95: r1(pct(rs.flatMap(w), 0.95)), coldP50: r1(median(rs.map((r) => median(r.cold.map((s) => s.ms))))), coldP95: r1(pct(rs.flatMap((r) => r.cold.map((s) => s.ms)), 0.95)),
        flashes: r1(mean(rs.flatMap((r) => r.warm.map((s) => s.flashes)))), n: rs.flatMap(w).length,
      };
    }
  }
  const bundle = bundleReport(DIST);
  const sha = gitSha();
  const meta = {
    sha, dirty: gitDirty(), date: new Date().toISOString(), browser: `Chromium ${browser.version()}`, playwright: JSON.parse(readFileSync(join(APP, "package.json"), "utf8")).devDependencies["@playwright/test"] as string,
    cpu: cpus()[0]?.model ?? "?", cores: cpus().length, os: release(), loadStart, loadEnd: loadavg().map((x) => r1(x)!), apiMs: OPT.apiMs, wsMs: OPT.wsMs, runs: OPT.runs, warm: OPT.warm, leak: OPT.leak,
    throttling: { network: "none (latency injected by the mock server per route)", cpu: Object.fromEntries(OPT.profiles.map((p) => [p, PROFILES[p as ProfileName].cpu])) },
  };
  const results = { meta, bundle, aggregate: agg, latencySweep: latAgg, raw, rawLatency: latRaw };
  const outDir = join(OPT.out, sha, "A");
  mkdirSync(outDir, { recursive: true });
  const md = summaryMd(meta, bundle, agg, latAgg);
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(outDir, "summary.md"), md);
  console.log(md);
  console.log(`VERIFY perf results written to ${outDir}`);
  if (OPT.publish) {
    const docs = join(REPO, "docs", "performance");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "meowsenger-baseline.json"), JSON.stringify({ meta, bundle, aggregate: agg, latencySweep: latAgg }, null, 2) + "\n");
    const f = join(docs, "meowsenger.md");
    const body = md.replace(/^# .*\n\n/, "");
    const cur = readFileSync(f, "utf8");
    writeFileSync(f, cur.replace(/<!-- baseline:start -->[\s\S]*<!-- baseline:end -->/, () => `<!-- baseline:start -->\n${body}<!-- baseline:end -->`));
    console.log(`published to ${docs}`);
  }
} finally {
  await browser.close();
  mock.stop();
}
process.exit(0);
