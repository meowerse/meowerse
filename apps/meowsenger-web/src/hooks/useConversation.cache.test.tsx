/** @vitest-environment happy-dom */
/**
 * PR-7a: the write path of the in-memory conversation cache. Nothing READS the cache yet
 * (cold load is unchanged); these tests pin WHAT is written, WHEN, and under WHICH
 * authority: every write is authorised by an entry token taken at chat entry, so a wipe,
 * a purge or an account switch can never be undone by a late write or the leave-save.
 */
import { Activity, StrictMode, useLayoutEffect, useRef } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, renderHook, act, waitFor, MockWebSocket } from "../test/rtl";
import type { Message } from "../lib/chat";
import type { SessionUser } from "../lib/meowsengerApi";

const H = vi.hoisted(() => ({
  history: {} as Record<string, Message[]>,
  around: null as { found: boolean; messages: Message[]; hasOlder: boolean; hasNewer: boolean } | null,
  gate: null as Promise<void> | null,
  calls: [] as string[],
  fail: false,
  /** queued answers for the NEXT unpaged loadHistory calls (consumed in order) */
  once: [] as Message[][],
  after: null as Message[] | null,
}));

vi.mock("../lib/chat", async (importActual) => {
  const actual = await importActual<typeof import("../lib/chat")>();
  return {
    ...actual,
    loadHistory: vi.fn(async (_b: string, chatId: string, before?: string) => {
      H.calls.push(`${chatId}:${before ?? ""}`);
      if (H.gate) await H.gate;
      if (H.fail) return { ok: false as const, status: 500 };
      if (!before && H.once.length > 0) return { ok: true as const, status: 200, data: H.once.shift()! };
      return { ok: true as const, status: 200, data: before ? [] : H.history[chatId] ?? [] };
    }),
    loadHistoryAround: vi.fn(async () => H.around ?? { found: false, messages: [], hasOlder: false, hasNewer: false }),
    loadHistoryAfter: vi.fn(async () => ({ ok: true as const, status: 200, data: H.after ?? [] })),
  };
});

import { useConversation } from "./useConversation";
import { clearAll, setScope, purgeChat, getEpoch, conversationCache as cc, conversationTokens as tk } from "../lib/store";

const ME: SessionUser = { id: "u1", username: "alice", displayName: "Alice", avatarUrl: null, verified: true };
const row = (id: string, createdAt: number, over: Partial<Message> = {}): Message => ({ id, chatId: "c1", senderId: "u2", body: `b-${id}`, createdAt, ...over });
const rows = (prefix: string, n: number, chatId = "c1"): Message[] => Array.from({ length: n }, (_, i) => row(`${prefix}${i + 1}`, 1000 + i, { chatId }));
const ids = (chatId: string) => cc.peek(chatId)?.messages.map((m) => m.id);

interface Mounted {
  result: { current: ReturnType<typeof useConversation> };
  rerender: (p: { activeId: string | null }) => void;
  unmount: () => void;
  cb: { onToast: ReturnType<typeof vi.fn>; onRevoked: ReturnType<typeof vi.fn> };
  inject: { fn: ((r: ReturnType<typeof useConversation>) => void) | null };
  renders: Array<{ activeId: string | null; ids: string[] }>;
}

/** Mount the hook; `onRevoked` mimics Chat (it purges the chat everywhere). */
function mount(activeId: string | null, opts: { strict?: boolean } = {}): Mounted {
  const cb = {
    onToast: vi.fn(), onRevoked: vi.fn((id: string) => purgeChat(id)),
  };
  const inject: Mounted["inject"] = { fn: null };
  const renders: Mounted["renders"] = [];
  const hook = renderHook(
    (props: { activeId: string | null }) => {
      const r = useConversation({
        base: "", activeId: props.activeId, me: ME, resolveSenderName: (id) => id,
        onToast: cb.onToast, onActiveRead: vi.fn(), onMessageDeleted: vi.fn(), consumeReply: vi.fn(), onRevoked: cb.onRevoked,
      });
      // Recorded per COMMIT (a layout effect), so a discarded render-phase pass is not counted.
      useLayoutEffect(() => { renders.push({ activeId: props.activeId, ids: r.messages.map((m) => m.id) }); });
      // Declared AFTER the hook: runs in the layout phase of the same commit, i.e. after the
      // hook's layout effect set the NEW chat's refs and before any passive cleanup.
      const injected = useRef(inject);
      useLayoutEffect(() => { const f = injected.current.fn; injected.current.fn = null; f?.(r); }, [props.activeId]);
      return r;
    },
    { initialProps: { activeId }, ...(opts.strict ? { wrapper: StrictMode } : {}) },
  );
  return { ...hook, cb, inject, renders };
}

async function open(chatId: string, hist: Message[], opts: { strict?: boolean } = {}) {
  H.history[chatId] = hist;
  const m = mount(chatId, opts);
  await waitFor(() => expect(m.result.current.messages.length).toBe(hist.length));
  const ws = MockWebSocket.room;
  act(() => ws.mockOpen());
  return { ...m, ws };
}

beforeEach(() => {
  clearAll();
  setScope("A");
  MockWebSocket.reset();
  H.history = {}; H.around = null; H.gate = null; H.calls = []; H.fail = false; H.once = []; H.after = null;
});

describe("PR-7a write path", () => {
  it("T7a-1: a cold load, a live frame and an ack write confirmed rows only, flags stripped", async () => {
    const { ws, result } = await open("c1", [row("m1", 1000)]);
    expect(ids("c1")).toEqual(["m1"]);
    act(() => ws.mockEmit({ type: "message", message: row("m2", 2000) }));
    expect(ids("c1")).toEqual(["m1", "m2"]);
    // a pending optimistic bubble is NOT cached; its ack is
    act(() => { result.current.send("hi"); });
    const tempId = (ws.sentFrames().find((f) => f.type === "send") as { tempId: string }).tempId;
    expect(result.current.messages.some((b) => b.pending)).toBe(true);
    expect(ids("c1")).toEqual(["m1", "m2"]);
    act(() => ws.mockEmit({ type: "sent", tempId, message: row("m3", 3000, { senderId: "u1", body: "hi" }) }));
    expect(ids("c1")).toEqual(["m1", "m2", "m3"]);
    // a refused send is not cached either
    act(() => { result.current.send("nope"); });
    const t2 = (ws.sentFrames().filter((f) => f.type === "send").at(-1) as { tempId: string }).tempId;
    act(() => ws.mockEmit({ type: "error", code: "bad_body", tempId: t2 }));
    expect(result.current.messages.some((b) => b.sendFailed)).toBe(true);
    expect(ids("c1")).toEqual(["m1", "m2", "m3"]);
    for (const m of cc.peek("c1")!.messages) {
      for (const k of ["pending", "queued", "sendFailed", "unconfirmed", "editFailed"]) expect(k in m, `${m.id} has ${k}`).toBe(false);
    }
    expect((cc.peek("c1")!.messages.find((m) => m.id === "m3") as { tempId?: string }).tempId).toBe(tempId); // kept for local recognition only
  });

  it("T7a-1b: a queued (socket never opened) send is not cached", async () => {
    H.history.c1 = [row("m1", 1000)];
    const m = mount("c1");
    await waitFor(() => expect(m.result.current.messages.length).toBe(1));
    act(() => { m.result.current.send("later"); });
    expect(m.result.current.messages.some((b) => b.queued === "send")).toBe(true);
    expect(ids("c1")).toEqual(["m1"]);
  });

  it("T7a-2: leave at the bottom keeps the newest 50 + hasMore + anchor bottom; scrolled up keeps from anchorIdx-50", async () => {
    const a = await open("c1", rows("a", 60));
    a.unmount();
    let e = cc.peek("c1")!;
    expect(e.messages.map((m) => m.id)).toEqual(rows("a", 60).slice(10).map((m) => m.id));
    expect(e.hasMore).toBe(true);
    expect(e.scrollAnchor?.atBottom).toBe(true);

    // scrolled up: stub rects (happy-dom layout is all zeros). Row i top = (i-100)*40 - 12.
    clearAll(); setScope("A"); MockWebSocket.reset();
    const hist = rows("r", 120);
    const b = await open("c2", hist.map((m) => ({ ...m, chatId: "c2" })));
    const log = document.createElement("div");
    hist.forEach((m, i) => {
      const el = document.createElement("div");
      el.dataset.mid = m.id;
      el.getBoundingClientRect = () => ({ top: (i - 99) * 40 - 12, bottom: (i - 99) * 40 + 28, left: 0, right: 0, width: 0, height: 40, x: 0, y: 0, toJSON() {} }) as DOMRect;
      log.appendChild(el);
    });
    log.getBoundingClientRect = () => ({ top: 0, bottom: 400, left: 0, right: 0, width: 0, height: 400, x: 0, y: 0, toJSON() {} }) as DOMRect;
    Object.defineProperties(log, { scrollTop: { value: 500, writable: true }, scrollHeight: { value: 5000 }, clientHeight: { value: 400 } });
    (b.result.current.logRef as { current: HTMLDivElement | null }).current = log;
    act(() => b.result.current.onLogScroll());
    b.unmount();
    e = cc.peek("c2")!;
    // anchor row is index 99 (r100) at offset -12; kept from 99-50 = 49 to the end
    expect(e.messages[0].id).toBe("r50");
    expect(e.messages.at(-1)!.id).toBe("r120");
    expect(e.scrollAnchor).toEqual({ messageId: "r100", offsetPx: -12, atBottom: false });
    expect(e.hasMore).toBe(true);
  });

  it("T7a-3: setScope(B) then the old chat's late frame + unmount (defence in depth): nothing remains", async () => {
    const { ws, unmount } = await open("c1", rows("a", 3));
    expect(ids("c1")).toEqual(["a1", "a2", "a3"]);
    setScope("B"); // wipes A's data and starts a new epoch
    expect(ids("c1")).toBeUndefined();
    act(() => ws.mockEmit({ type: "message", message: row("late", 5000) }));
    unmount();
    expect(ids("c1")).toBeUndefined();
  });

  it("T7a-4: logout (clearAll) then a live frame during the push-disable wait; even after a re-login, nothing is written", async () => {
    const { ws, unmount } = await open("c1", rows("a", 3));
    clearAll();
    act(() => ws.mockEmit({ type: "message", message: row("late1", 5000) }));
    expect(ids("c1")).toBeUndefined();
    setScope("B"); // a new session in the same tab while the old Chat is still mounted
    act(() => ws.mockEmit({ type: "message", message: row("late2", 6000) }));
    expect(ids("c1")).toBeUndefined();
    unmount();
    expect(ids("c1")).toBeUndefined();
  });

  it("T7a-5: a revoked frame and a leave (purgeChat) are each followed by a late frame + switch away: nothing is cached", async () => {
    // revoked frame (the view's onRevoked purges, as Chat does)
    const a = await open("c1", rows("a", 3));
    act(() => a.ws.mockEmit({ type: "revoked" }));
    expect(a.cb.onRevoked).toHaveBeenCalledWith("c1");
    act(() => a.ws.mockEmit({ type: "message", message: row("late", 5000) }));
    a.rerender({ activeId: "c2" });
    expect(ids("c1")).toBeUndefined();
    a.unmount();
    expect(ids("c1")).toBeUndefined();

    // the user leaves the group (Chat calls purgeChat(left))
    MockWebSocket.reset();
    const b = await open("c3", rows("x", 3, "c3"));
    purgeChat("c3");
    act(() => b.ws.mockEmit({ type: "message", message: row("late", 5000, { chatId: "c3" }) }));
    b.rerender({ activeId: null });
    expect(ids("c3")).toBeUndefined();
  });

  it("T7a-6: a jump (detached) never caches the window; detached row frames patch the cached row; leave anchor = bottom", async () => {
    const tail = [row("t1", 1000), row("t2", 2000), row("t3", 3000)];
    const { result, ws, unmount } = await open("c1", tail);
    expect(ids("c1")).toEqual(["t1", "t2", "t3"]);
    H.around = { found: true, hasOlder: true, hasNewer: true, messages: [row("w1", 100), row("w2", 200), row("t2", 2000)] };
    await act(async () => { await result.current.jumpToMessage("w1"); });
    expect(result.current.hasNewer).toBe(true);
    expect(result.current.messages.map((m) => m.id)).toEqual(["w1", "w2", "t2"]);
    // right after the jump commit the cached tail is still the pre-jump tail
    expect(ids("c1")).toEqual(["t1", "t2", "t3"]);
    // a detached message frame never touches the cache
    act(() => ws.mockEmit({ type: "message", message: row("t4", 4000) }));
    expect(ids("c1")).toEqual(["t1", "t2", "t3"]);
    // detached edited / reaction / deleted patch the cached row only
    act(() => ws.mockEmit({ type: "edited", id: "t2", body: "edited!", editedAt: 9 }));
    act(() => ws.mockEmit({ type: "reaction", id: "t2", emoji: "x", userId: "u2", on: true }));
    act(() => ws.mockEmit({ type: "deleted", id: "t3" }));
    let cached = cc.peek("c1")!.messages;
    expect(cached.map((m) => m.id)).toEqual(["t1", "t2", "t3"]);
    expect(cached[1].body).toBe("edited!");
    expect(cached[1].reactions?.[0]?.emoji).toBe("x");
    expect(cached[2].isDeleted).toBe(true);
    unmount();
    cached = cc.peek("c1")!.messages;
    expect(cached.map((m) => m.id)).toEqual(["t1", "t2", "t3"]);
    expect(cc.peek("c1")!.scrollAnchor?.atBottom).toBe(true);
  });

  it("T7a-7: tokens die on purge / clearAll / setScope(other); an evicted entry is recreated by the leave-save", async () => {
    const t1 = tk.enter("x"); expect(tk.valid(t1)).toBe(true);
    purgeChat("x"); expect(tk.valid(t1)).toBe(false);
    const t2 = tk.enter("x"); expect(tk.valid(t2)).toBe(true); // a fresh entry after the purge is fine
    clearAll(); expect(tk.valid(t2)).toBe(false);
    setScope("A");
    const t3 = tk.enter("x"); setScope("B"); expect(tk.valid(t3)).toBe(false);
    setScope("A");
    // write helpers refuse a dead token
    const dead = tk.enter("y"); purgeChat("y");
    expect(tk.putT(dead, { messages: [], hasMore: false, fetchedAt: 1 })).toBe(false);
    expect(cc.peek("y")).toBeUndefined();

    // eviction of the active entry (what PR-11's prefetch can do): the leave-save recreates it
    const { unmount } = await open("c1", rows("a", 3));
    for (let i = 0; i < cc.MAX_CHATS; i++) cc.put(`e${i}`, { messages: [], hasMore: false, fetchedAt: 1 }, getEpoch());
    expect(cc.peek("c1")).toBeUndefined();
    unmount();
    expect(ids("c1")).toEqual(["a1", "a2", "a3"]);
  });

  it("T7a-8: StrictMode: no committed render pairs the new chat with the old chat's rows", async () => {
    const a = await open("c1", rows("a", 3), { strict: true });
    H.history.c2 = rows("b", 2, "c2");
    a.rerender({ activeId: "c2" });
    await waitFor(() => expect(a.result.current.messages.map((m) => m.id)).toEqual(["b1", "b2"]));
    for (const r of a.renders) {
      if (r.activeId === "c2") expect(r.ids.every((id) => id.startsWith("b")), `render for c2 held ${r.ids}`).toBe(true);
    }
    expect(ids("c1")).toEqual(["a1", "a2", "a3"]);
    // StrictMode double-invokes effects on MOUNT only: the switch to c2 reads the chat exactly once
    expect(H.calls.filter((c) => c === "c2:").length).toBe(1);
  });

  it("T7a-9 (static): the hook has no setMessages/getEpoch/conversationCache and imports only conversationTokens from lib/store; no storage APIs in hook or Chat.tsx", () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
    const hook = strip(readFileSync(join(__dirname, "useConversation.ts"), "utf8"));
    expect(hook).not.toMatch(/setMessages\(/);
    expect(hook).not.toMatch(/getEpoch/);
    expect(hook).not.toMatch(/conversationCache/);
    const storeImports = [...hook.matchAll(/from\s+"([^"]*lib\/store[^"]*)"/g)].map((m) => m[1]);
    expect(storeImports).toEqual(["../lib/store/conversationTokens"]);
    for (const f of [join(__dirname, "useConversation.ts"), join(__dirname, "..", "components", "Chat.tsx")]) {
      const src = strip(readFileSync(f, "utf8"));
      for (const bad of ["localStorage", "sessionStorage", "indexedDB", "caches.", "document.cookie"]) {
        expect(src.includes(bad), `${f} uses ${bad}`).toBe(false);
      }
    }
  });

  it("T7a-10: two message frames in one act produce two rows", async () => {
    const { result, ws } = await open("c1", [row("m1", 1000)]);
    act(() => {
      ws.mockEmit({ type: "message", message: row("m2", 2000) });
      ws.mockEmit({ type: "message", message: row("m3", 3000) });
    });
    expect(result.current.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(ids("c1")).toEqual(["m1", "m2", "m3"]);
  });

  it("T7a-11: A -> B: A's entry is the trimmed snapshot of A only (never B's rows), saved at the switch", async () => {
    const a = await open("c1", rows("a", 60));
    H.history.c2 = rows("b", 2, "c2");
    a.rerender({ activeId: "c2" });
    // saved synchronously by the layout cleanup: trimmed to the newest 50 of A, anchor bottom
    expect(ids("c1")).toEqual(rows("a", 60).slice(10).map((m) => m.id));
    expect(cc.peek("c1")!.scrollAnchor?.atBottom).toBe(true);
    await waitFor(() => expect(a.result.current.messages.map((m) => m.id)).toEqual(["b1", "b2"]));
    a.rerender({ activeId: null });
    expect(ids("c1")!.some((id) => id.startsWith("b"))).toBe(false);
    expect(ids("c2")).toEqual(["b1", "b2"]);
  });

  it("T7a-12: a cold load of a full 50-row page stores hasMore: true (a short page stores false)", async () => {
    const a = await open("c1", rows("a", 50));
    expect(cc.peek("c1")!.hasMore).toBe(true);
    a.unmount();
    MockWebSocket.reset();
    const b = await open("c2", rows("b", 5, "c2"));
    expect(cc.peek("c2")!.hasMore).toBe(false);
    b.unmount();
  });

  it("T7a-13: after A -> B the stale A socket's revoked / edited / sent / error act on A only", async () => {
    const a = await open("c1", [row("x", 1000, { body: "orig" })]);
    const wsA = a.ws;
    let release!: () => void;
    H.gate = new Promise<void>((r) => { release = r; });
    H.history.c2 = [row("x", 1000, { chatId: "c2", body: "bee" })];
    // Emitted in the layout phase of the switch commit: B's refs exist, A's socket is still live.
    a.inject.fn = () => {
      wsA.mockEmit({ type: "edited", id: "x", body: "EVIL", editedAt: 5 });
      wsA.mockEmit({ type: "sent", tempId: "t-1", message: row("z", 2000, { body: "ack" }) });
      wsA.mockEmit({ type: "error", code: "bad_body", tempId: "t-1" });
      wsA.mockEmit({ type: "revoked" });
    };
    a.rerender({ activeId: "c2" });
    expect(a.result.current.messages).toEqual([]); // B shows none of A's frames
    expect(a.cb.onRevoked).toHaveBeenCalledTimes(1);
    expect(a.cb.onRevoked).toHaveBeenCalledWith("c1"); // A's revoke purges A, not B
    expect(a.cb.onToast).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(a.result.current.messages.map((m) => m.body)).toEqual(["bee"]));
    expect(ids("c1")).toBeUndefined(); // revoked chat stays purged: the leave-save ran first, then `revoked` purged the entry
    expect(ids("c2")).toEqual(["x"]);
  });
  it("T7a-14: the layout effect re-running for the SAME chat keeps the log mirror and paging flags", async () => {
    H.history.c1 = rows("a", 50); // a full page: hasMore true
    let setMode!: (m: "visible" | "hidden") => void;
    const out: { current: ReturnType<typeof useConversation> | null } = { current: null };
    function Probe() {
      out.current = useConversation({
        base: "", activeId: "c1", me: ME, resolveSenderName: (id) => id,
        onToast: vi.fn(), onActiveRead: vi.fn(), onMessageDeleted: vi.fn(), consumeReply: vi.fn(), onRevoked: vi.fn(),
      });
      return null;
    }
    const { rerender } = render(<Activity mode="visible"><Probe /></Activity>);
    setMode = (m) => rerender(<Activity mode={m}><Probe /></Activity>);
    await waitFor(() => expect(out.current!.messages.length).toBe(50));
    act(() => MockWebSocket.room.mockOpen());
    const log = document.createElement("div");
    out.current!.logRef.current = log;
    // the same chat's effects re-run (Activity hide/show == Fast Refresh / Suspense reveal); the re-read hangs
    H.gate = new Promise<void>(() => {});
    H.calls = [];
    act(() => setMode("hidden"));
    act(() => setMode("visible"));
    expect(out.current!.messages.length).toBe(50); // the view is untouched
    const ws2 = MockWebSocket.room;
    act(() => ws2.mockOpen());
    act(() => ws2.mockEmit({ type: "message", message: row("live", 9000) }));
    // the next live frame is computed from the existing rows, not from []
    expect(out.current!.messages.length).toBe(51);
    // and paging older still works (hasMoreRef survived)
    H.gate = null;
    await act(async () => { await out.current!.retryOlder(); });
    expect(H.calls).toContain("c1:a1");
  });

  it("T7a-15: nothing is cached before the first verified commit (live frame / ack / failed load / early leave); a retry verifies", async () => {
    // cold load still in flight: live frame + ack, then leave
    let release!: () => void;
    H.gate = new Promise<void>((r) => { release = r; });
    H.history.c1 = [row("m1", 1000)];
    const a = mount("c1");
    act(() => MockWebSocket.room.mockOpen());
    act(() => MockWebSocket.room.mockEmit({ type: "message", message: row("live", 2000) }));
    expect(ids("c1")).toBeUndefined();
    act(() => { a.result.current.send("hi"); });
    const tempId = (MockWebSocket.room.sentFrames().find((f) => f.type === "send") as { tempId: string }).tempId;
    act(() => MockWebSocket.room.mockEmit({ type: "sent", tempId, message: row("ack", 3000, { senderId: "u1" }) }));
    expect(ids("c1")).toBeUndefined();
    a.rerender({ activeId: null }); // early leave
    expect(ids("c1")).toBeUndefined();
    release();
    a.unmount();

    // failed cold load: live frame, then leave
    MockWebSocket.reset(); H.gate = null; H.fail = true;
    const b = mount("c2");
    await waitFor(() => expect(b.result.current.historyError).toBe(true));
    act(() => MockWebSocket.room.mockOpen());
    act(() => MockWebSocket.room.mockEmit({ type: "message", message: row("l2", 2000, { chatId: "c2" }) }));
    expect(ids("c2")).toBeUndefined();
    // a retry that succeeds is the first verified commit: now it caches (live row kept + history)
    H.fail = false; H.history.c2 = [row("h1", 1000, { chatId: "c2" })];
    await act(async () => { await b.result.current.retryHistory(); });
    expect(ids("c2")).toEqual(["h1", "l2"]);
    expect(cc.peek("c2")!.fetchedAt).toBeGreaterThan(0);
    b.rerender({ activeId: null });
    expect(ids("c2")).toEqual(["h1", "l2"]);
  });

  it("T7a-16: A -> B: the leave-save of an UNVERIFIED chat is refused, and verification does not carry over to B", async () => {
    let release!: () => void;
    H.gate = new Promise<void>((r) => { release = r; });
    const a = mount("c1");
    act(() => MockWebSocket.room.mockOpen());
    act(() => MockWebSocket.room.mockEmit({ type: "message", message: row("live", 2000) }));
    release(); H.gate = null;
    await waitFor(() => expect(ids("c1")).toEqual(["live"])); // verified now
    H.gate = new Promise<void>(() => {}); // B never loads
    a.rerender({ activeId: "c2" });
    act(() => MockWebSocket.room.mockOpen());
    act(() => MockWebSocket.room.mockEmit({ type: "message", message: row("x", 2000, { chatId: "c2" }) }));
    expect(ids("c2")).toBeUndefined(); // c1's verification did not leak into c2
    a.rerender({ activeId: null });
    expect(ids("c2")).toBeUndefined();
  });

  it("T7a-17: in the gap between B's layout effect and A's passive cleanup nothing is sent on A's socket for B", async () => {
    const a = await open("c1", [row("x", 1000)]);
    const wsA = a.ws;
    const before = wsA.sentFrames().length;
    H.gate = new Promise<void>(() => {});
    H.history.c2 = [];
    a.inject.fn = (r) => { // `r` is B's render: its send/sendTyping are bound to c2
      r.sendTyping(true);
      r.send("for B"); // enqueues to B's outbox and tries to flush on the (A) socket
    };
    a.rerender({ activeId: "c2" });
    const sent = wsA.sentFrames().slice(before);
    expect(sent.filter((f) => f.type === "typing" || f.type === "send" || f.type === "read")).toEqual([]);
  });

  it("T7a-18: leaving a detached window via attachLatest / loadNewer's short page writes through once attached (W1)", async () => {
    const tail = [row("t1", 1000), row("t2", 2000), row("t3", 3000)];
    const { result, unmount } = await open("c1", tail);
    H.around = { found: true, hasOlder: true, hasNewer: true, messages: [row("w1", 100), row("w2", 200), row("t2", 2000)] };
    await act(async () => { await result.current.jumpToMessage("w1"); });
    expect(result.current.hasNewer).toBe(true);
    expect(ids("c1")).toEqual(["t1", "t2", "t3"]);

    // loadNewer: a short page re-attaches; its append is itself written through
    const log = document.createElement("div");
    Object.defineProperties(log, { scrollTop: { value: 4600, writable: true }, scrollHeight: { value: 5000 }, clientHeight: { value: 400 } });
    (result.current.logRef as { current: HTMLDivElement | null }).current = log;
    H.after = [row("t3", 3000)];
    H.once = [[]]; // the follow-up tail read returns nothing: only the short-page commit can write
    await act(async () => { result.current.onLogScroll(); });
    await waitFor(() => expect(result.current.hasNewer).toBe(false));
    expect(ids("c1")).toEqual(["w1", "w2", "t2", "t3"]);

    // attachLatest: jump away again, then back; the first (replace) commit must write
    H.around = { found: true, hasOlder: true, hasNewer: true, messages: [row("w1", 100), row("w2", 200)] };
    await act(async () => { await result.current.jumpToMessage("w1"); });
    expect(result.current.hasNewer).toBe(true);
    H.history.c1 = [...tail, row("t4", 4000)];
    H.once = [H.history.c1, []]; // page, then an empty tail re-read
    await act(async () => { await result.current.jumpToLatest(); });
    expect(ids("c1")).toEqual(["t1", "t2", "t3", "t4"]);
    unmount();
  });
});
