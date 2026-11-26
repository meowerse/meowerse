import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Message } from "../chat";

const loadHistory = vi.fn();
vi.mock("../chat", () => ({ loadHistory: (...a: unknown[]) => loadHistory(...a) }));

import { prefetchChat, MAX_CONCURRENT, MAX_STORES_PER_MIN, _resetForTests } from "./prefetch";
import { setScope, clearAll, conversationCache as cc, getEpoch, purgeChat } from "./index";
import * as tokens from "./conversationTokens";
import { loadHistory as lh } from "../chat";
const deps = { ...tokens, loadHistory: lh };

const rows = (n: number): Message[] => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, chatId: "c", senderId: "u", body: "b", createdAt: i }));
const deferred = () => { let res!: (v: unknown) => void; const p = new Promise((r) => { res = r; }); return { p, res }; };
const setConn = (c: unknown) => Object.defineProperty(navigator, "connection", { value: c, configurable: true });

beforeEach(() => { _resetForTests(); clearAll(); setScope("A"); loadHistory.mockReset(); loadHistory.mockResolvedValue({ ok: true, status: 200, data: rows(3) }); setConn(undefined); });
afterEach(() => setConn(undefined));

describe("prefetchChat", () => {
  it("warms the newest page into the cache; hasMore only for a full page", async () => {
    await prefetchChat(deps, "", "c1");
    expect(cc.peek("c1")?.messages).toHaveLength(3);
    expect(cc.peek("c1")?.hasMore).toBe(false);
    expect(cc.peek("c1")!.fetchedAt).toBeGreaterThan(0);
    loadHistory.mockResolvedValue({ ok: true, status: 200, data: rows(50) });
    await prefetchChat(deps, "", "c2");
    expect(cc.peek("c2")?.hasMore).toBe(true);
  });
  it("skips a chat that already has an entry (0 requests)", async () => {
    await prefetchChat(deps, "", "c1");
    loadHistory.mockClear();
    await prefetchChat(deps, "", "c1");
    expect(loadHistory).not.toHaveBeenCalled();
  });
  it("Save-Data and 2g disable it", async () => {
    for (const c of [{ saveData: true }, { effectiveType: "2g" }, { effectiveType: "slow-2g" }]) {
      setConn(c);
      await prefetchChat(deps, "", "c1");
    }
    expect(loadHistory).not.toHaveBeenCalled();
  });
  it("a result arriving after clearAll is dropped", async () => {
    const d = deferred();
    loadHistory.mockReturnValue(d.p);
    const run = prefetchChat(deps, "", "c1");
    clearAll(); setScope("A"); // same user re-login: new epoch
    d.res({ ok: true, status: 200, data: rows(3) });
    await run;
    expect(cc.peek("c1")).toBeUndefined();
    expect(getEpoch()).toBeGreaterThan(0);
  });
  it("a result arriving after purge(chat) is dropped", async () => {
    const d = deferred();
    loadHistory.mockReturnValue(d.p);
    const run = prefetchChat(deps, "", "c1");
    purgeChat("c1");
    d.res({ ok: true, status: 200, data: rows(3) });
    await run;
    expect(cc.peek("c1")).toBeUndefined();
  });
  it("caps concurrency at 2 and does not double-fetch one chat", async () => {
    const ds = [deferred(), deferred(), deferred()];
    let i = 0;
    loadHistory.mockImplementation(() => ds[i++].p);
    const a = prefetchChat(deps, "", "c1"); const dup = prefetchChat(deps, "", "c1"); const b = prefetchChat(deps, "", "c2"); const c = prefetchChat(deps, "", "c3");
    await Promise.all([dup, c]);
    expect(MAX_CONCURRENT).toBe(2);
    expect(loadHistory).toHaveBeenCalledTimes(2);
    ds.forEach((d) => d.res({ ok: true, status: 200, data: rows(1) }));
    await Promise.all([a, b]);
    expect(cc.peek("c3")).toBeUndefined();
  });
  it("failures, empty chats and a signed-out scope store nothing", async () => {
    loadHistory.mockResolvedValue({ ok: false, status: 500 });
    await prefetchChat(deps, "", "c1");
    loadHistory.mockResolvedValue({ ok: true, status: 200, data: [] });
    await prefetchChat(deps, "", "c2");
    loadHistory.mockRejectedValue(new Error("abort"));
    await prefetchChat(deps, "", "c3");
    clearAll();
    loadHistory.mockResolvedValue({ ok: true, status: 200, data: rows(3) });
    await prefetchChat(deps, "", "c4");
    expect([1, 2, 3, 4].map((n) => cc.peek(`c${n}`))).toEqual([undefined, undefined, undefined, undefined]);
  });
  it("a failed / empty / unknown result is not refetched for 30 s, then may retry", async () => {
    vi.useFakeTimers();
    try {
      loadHistory.mockResolvedValue({ ok: true, status: 200, data: [] });
      await prefetchChat(deps, "", "c1");
      await prefetchChat(deps, "", "c1");
      expect(loadHistory).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(30_001);
      await prefetchChat(deps, "", "c1");
      expect(loadHistory).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it("stores per minute are budgeted so hovering cannot flush the LRU", async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < MAX_STORES_PER_MIN + 2; i++) await prefetchChat(deps, "", `x${i}`);
      expect(loadHistory).toHaveBeenCalledTimes(MAX_STORES_PER_MIN);
      vi.advanceTimersByTime(60_001);
      await prefetchChat(deps, "", "y");
      expect(cc.peek("y")).toBeDefined();
    } finally { vi.useRealTimers(); }
  });
});
