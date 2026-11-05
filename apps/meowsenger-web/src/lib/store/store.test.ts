import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatSummary, Member, Message } from "../chat";
import { notifySessionEnded, resetSessionEnded, hasSessionEnded } from "../sessionEnded";
import {
  setScope, clearAll, begin, isCurrent, getScope, getEpoch, purgeChat, conversationCache as cc,
  memberCache as mc, chatListStore as cl, installAuthChannel, broadcastLogout, subscribe,
} from "./index";
import { _resetAuthChannelForTests } from "./authChannel";

const msg = (i: number): Message => ({ id: `m${i}`, chatId: "c", senderId: "u", body: "b", createdAt: i });
const chat = (id: string): ChatSummary => ({ id, type: "direct", name: null, lastMessage: "", lastSenderId: null, lastActivity: 0, unreadCount: 0, peerId: "p", peerUsername: "p", peerDisplayName: null, peerAvatarUrl: null, peerLastSeenAt: null } as unknown as ChatSummary);
const entry = (n = 1) => ({ messages: Array.from({ length: n }, (_, i) => msg(i)), hasMore: false, fetchedAt: 1 });
const ok = (data: ChatSummary[]) => ({ ok: true as const, status: 200, data });
const roster: Member[] = [{ userId: "u", username: "u", displayName: null, avatarUrl: null, role: "member", joinedAt: 1 }];

beforeEach(() => { clearAll(); setScope("A"); });

describe("memory only", () => {
  it("no persistent-storage APIs in src/lib/store", () => {
    for (const f of readdirSync(__dirname).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
      const src = readFileSync(join(__dirname, f), "utf8");
      for (const bad of ["localStorage", "sessionStorage", "indexedDB", "caches.", "document.cookie"]) {
        expect(src.includes(bad), `${f} mentions ${bad}`).toBe(false);
      }
    }
  });
});

describe("scope / clearAll", () => {
  it("setScope with another user clears every cache", () => {
    cc.put("c1", entry(), getEpoch()); mc.put("c1", roster, getEpoch()); cl.apply([chat("c1")]);
    setScope("B");
    expect(getScope()).toBe("B");
    expect(cc.peek("c1")).toBeUndefined(); expect(mc.get("c1")).toBeUndefined(); expect(cl.getState().list).toBeNull();
  });
  it("same-user setScope keeps data", () => {
    cc.put("c1", entry(), getEpoch());
    setScope("A");
    expect(cc.peek("c1")).toBeDefined();
  });
  it("clearAll aborts registered signals, bumps epoch, is idempotent", () => {
    const t = begin(); const e = getEpoch();
    clearAll();
    expect(t.signal.aborted).toBe(true);
    expect(isCurrent(t.epoch)).toBe(false);
    expect(getEpoch()).toBe(e + 1);
    expect(getScope()).toBeNull();
    expect(() => { clearAll(); clearAll(); }).not.toThrow();
  });
  it("runs abort -> epoch bump -> drop -> scope null -> notify in order", () => {
    const log: string[] = [];
    const t = begin();
    t.signal.addEventListener("abort", () => log.push(`abort@${getEpoch()}`));
    cc.put("c1", entry(), getEpoch());
    const unsub = subscribe(() => log.push(`notify:${getScope()}:${cc.peek("c1") ? "data" : "empty"}`));
    clearAll(); unsub();
    expect(log[0]).toMatch(/^abort@/);
    const abortEpoch = Number(log[0].split("@")[1]);
    expect(abortEpoch).toBe(t.epoch); // aborted BEFORE the epoch bump
    expect(log).toContain("notify:null:empty");
  });
  it("no scope: begin() is dead on arrival and puts are refused", () => {
    clearAll();
    const t = begin();
    expect(t.signal.aborted).toBe(true);
    expect(cc.put("c1", entry(), t.epoch)).toBe(false);
  });
});

describe("late responses after clearAll never repopulate", () => {
  it("conversation cache", async () => {
    const t = begin();
    const fetched = new Promise<Message[]>((r) => setTimeout(() => r([msg(1)]), 0));
    clearAll();
    const messages = await fetched;
    expect(cc.put("c1", { messages, hasMore: false, fetchedAt: 1 }, t.epoch)).toBe(false);
    setScope("A"); // even if the same user signs in again
    expect(cc.put("c1", entry(), t.epoch)).toBe(false);
    expect(cc.peek("c1")).toBeUndefined();
  });
  it("member cache", async () => {
    const t = begin(); clearAll(); setScope("A");
    expect(mc.put("c1", roster, t.epoch)).toBe(false);
    expect(mc.get("c1")).toBeUndefined();
  });
  it("chat list refresh", async () => {
    let resolve!: (v: ReturnType<typeof ok>) => void;
    const p = cl.refresh(() => new Promise((r) => { resolve = r; }));
    clearAll(); setScope("A");
    resolve(ok([chat("c1")]));
    await p;
    expect(cl.getState().list).toBeNull();
  });
});

describe("ConversationCache", () => {
  it("evicts least recently used on the 13th chat; get refreshes recency", () => {
    const e = getEpoch();
    for (let i = 1; i <= 12; i++) cc.put(`c${i}`, entry(), e);
    cc.get("c1"); // c1 now most recent; c2 is LRU
    cc.put("c13", entry(), e);
    expect(cc.peek("c2")).toBeUndefined();
    expect(cc.peek("c1")).toBeDefined();
    expect(cc.ids()).toHaveLength(12);
  });
  it("caps at 200 keeping the newest, marks hasMore", () => {
    cc.put("c1", entry(250), getEpoch());
    const got = cc.peek("c1")!;
    expect(got.messages).toHaveLength(200);
    expect(got.messages[0].id).toBe("m50");
    expect(got.messages[199].id).toBe("m249");
    expect(got.hasMore).toBe(true);
  });
  it("refuses a detached window and a stale epoch", () => {
    expect(cc.put("c1", entry(), getEpoch(), { detached: true })).toBe(false);
    expect(cc.peek("c1")).toBeUndefined();
    expect(cc.put("c1", entry(), getEpoch() - 1)).toBe(false);
  });
  it("patch / setAnchor / purge", () => {
    const e = getEpoch();
    expect(cc.patch("nope", { hasMore: true }, e)).toBe(false);
    cc.put("c1", entry(), e);
    expect(cc.setAnchor("c1", { messageId: "m0", offsetPx: 4, atBottom: false }, e)).toBe(true);
    expect(cc.peek("c1")!.scrollAnchor?.offsetPx).toBe(4);
    expect(cc.patch("c1", (x) => ({ ...x, hasMore: true }))).toBe(true);
    expect(cc.patch("c1", { hasMore: false }, e - 1)).toBe(false);
    cc.patch("c1", { messages: entry(300).messages });
    expect(cc.peek("c1")!.messages).toHaveLength(200);
    cc.purge("c1"); cc.purge("c1");
    expect(cc.peek("c1")).toBeUndefined();
  });
});

describe("MemberCache", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("expires after 5 minutes; invalidate and purge drop it", () => {
    vi.useFakeTimers();
    mc.put("c1", roster, getEpoch());
    vi.advanceTimersByTime(4 * 60_000 + 59_000);
    expect(mc.get("c1")).toBe(roster);
    vi.advanceTimersByTime(2_000);
    expect(mc.get("c1")).toBeUndefined();
    mc.put("c1", roster, getEpoch()); mc.invalidate("c1");
    expect(mc.get("c1")).toBeUndefined();
    mc.put("c1", roster, getEpoch()); mc.purge("c1");
    expect(mc.get("c1")).toBeUndefined();
    mc.invalidate("c1");
  });
});

describe("ChatListStore", () => {
  it("concurrent refreshes share one fetch", async () => {
    const f = vi.fn(async () => ok([chat("c1")]));
    await Promise.all([cl.refresh(f), cl.refresh(f)]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(cl.getState().list).toHaveLength(1);
    await cl.refresh(f); // settled: a new fetch is allowed
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("drops an older sequence result", async () => {
    let r1!: (v: ReturnType<typeof ok>) => void;
    const slow = cl.refresh(() => new Promise((r) => { r1 = r; }));
    await cl.refresh(async () => ok([chat("new")]), { force: true });
    r1(ok([chat("old")]));
    await slow;
    expect(cl.getState().list!.map((c) => c.id)).toEqual(["new"]);
  });
  it("keeps the last good list on failure and exposes the error", async () => {
    await cl.refresh(async () => ok([chat("c1")]));
    await cl.refresh(async () => ({ ok: false as const, error: { kind: "network" } as never }));
    expect(cl.getState().list).toHaveLength(1);
    expect(cl.getState().error).toEqual({ kind: "network" });
    await cl.refresh(async () => { throw new Error("x"); });
    expect(cl.getState().list).toHaveLength(1);
    expect(cl.getState().error).toBeInstanceOf(Error);
    await cl.refresh(async () => ok([chat("c1")]));
    expect(cl.getState().error).toBeNull();
  });
  it("purges a chat that disappears from the list (all caches)", () => {
    const e = getEpoch();
    cl.apply([chat("c1"), chat("c2")]);
    cc.put("c2", entry(), e); mc.put("c2", roster, e);
    cl.apply([chat("c1")]);
    expect(cc.peek("c2")).toBeUndefined(); expect(mc.get("c2")).toBeUndefined();
  });
  it("apply with a stale epoch is ignored", () => {
    cl.apply([chat("c1")], getEpoch() - 1);
    expect(cl.getState().list).toBeNull();
  });
});

describe("purgeChat", () => {
  it("removes the chat from all three caches", () => {
    const e = getEpoch();
    cl.apply([chat("c1"), chat("c2")]); cc.put("c1", entry(), e); mc.put("c1", roster, e);
    purgeChat("c1");
    expect(cc.peek("c1")).toBeUndefined(); expect(mc.get("c1")).toBeUndefined();
    expect(cl.getState().list!.map((c) => c.id)).toEqual(["c2"]);
    purgeChat("c1"); // idempotent
  });
});

describe("chat list: no scope, no data", () => {
  it("a sync apply() after clearAll (no scope bound) stores nothing", () => {
    setScope("A");
    clearAll();
    cl.apply([{ id: "leak" } as never]);
    expect(cl.getState().list).toBeNull();
  });
});

describe("cross-tab auth channel", () => {
  const instances: FakeBC[] = [];
  class FakeBC {
    onmessage: ((e: MessageEvent) => void) | null = null;
    posted: unknown[] = [];
    closed = false;
    constructor(public name: string) { instances.push(this); }
    postMessage(m: unknown) { this.posted.push(m); }
    close() { this.closed = true; }
  }
  beforeEach(() => { instances.length = 0; resetSessionEnded(); _resetAuthChannelForTests(); vi.stubGlobal("BroadcastChannel", FakeBC); });
  afterEach(() => { vi.unstubAllGlobals(); resetSessionEnded(); });

  it("a logout message clears and raises sessionEnded; other shapes are ignored", () => {
    installAuthChannel(); installAuthChannel();
    const listener = instances.find((i) => i.onmessage)!;
    expect(instances.filter((i) => i.onmessage)).toHaveLength(1);
    cc.put("c1", entry(), getEpoch());
    for (const bad of [null, "logout", 7, [], { type: "other" }, { type: "logout", userId: "A" }, {}]) {
      listener.onmessage!({ data: bad } as MessageEvent);
      expect(cc.peek("c1")).toBeDefined();
      expect(hasSessionEnded()).toBe(false);
    }
    listener.onmessage!({ data: { type: "logout" } } as MessageEvent);
    expect(cc.peek("c1")).toBeUndefined();
    expect(hasSessionEnded()).toBe(true);
  });
  it("logout in THIS tab posts through its own listening channel: no self 'session ended', other tabs still hear it", () => {
    // Real BroadcastChannel semantics: delivered to every other object with the same
    // name (including other objects in this same tab), never to the sender object.
    const bus: BusBC[] = [];
    class BusBC {
      onmessage: ((e: MessageEvent) => void) | null = null;
      constructor(public name: string) { bus.push(this); }
      postMessage(m: unknown) { for (const o of bus) if (o !== this && o.name === this.name) o.onmessage?.({ data: m } as MessageEvent); }
      close() { const i = bus.indexOf(this); if (i >= 0) bus.splice(i, 1); }
    }
    vi.stubGlobal("BroadcastChannel", BusBC);
    _resetAuthChannelForTests();
    installAuthChannel();
    const otherTab = new BusBC("mw-auth");
    const heard: unknown[] = [];
    otherTab.onmessage = (e) => heard.push(e.data);
    broadcastLogout();
    expect(hasSessionEnded()).toBe(false); // this tab is navigating to login, not showing the banner
    expect(heard).toEqual([{ type: "logout" }]);
    expect(bus).toHaveLength(2); // no extra channel object was created for the post
    _resetAuthChannelForTests();
  });
  it("session ended clears the store", () => {
    installAuthChannel();
    cc.put("c1", entry(), getEpoch());
    notifySessionEnded();
    expect(cc.peek("c1")).toBeUndefined();
  });
  it("broadcastLogout posts only the type and closes; never throws", () => {
    broadcastLogout();
    expect(instances[0].posted).toEqual([{ type: "logout" }]);
    expect(instances[0].closed).toBe(true);
    vi.stubGlobal("BroadcastChannel", class { constructor() { throw new Error("no"); } });
    expect(() => broadcastLogout()).not.toThrow();
    expect(() => { _resetAuthChannelForTests(); installAuthChannel(); }).not.toThrow();
    vi.stubGlobal("BroadcastChannel", undefined);
    expect(() => broadcastLogout()).not.toThrow();
    _resetAuthChannelForTests();
    expect(() => installAuthChannel()).not.toThrow();
  });
});
