/** @vitest-environment happy-dom */
/**
 * Unit tests for the extracted conversation engine. renderHook drives the state
 * machine directly (the refs are private, so we drive via the mock WebSocket +
 * mocked lib and assert on the returned object / the frames the client sent). These
 * cover the branch-heavy paths the black-box <Chat> tests don't reach — every frame
 * type, the read-receipt gate, detached-window paging, reconnect, and the send/
 * edit/delete/react actions — which is the coverage the audit's "zero island tests"
 * finding was about.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, MockWebSocket, MockNotification, setVisibility } from "../test/rtl";
import type { Message } from "../lib/chat";
import type { SessionUser } from "../lib/meowsengerApi";

const H = vi.hoisted(() => ({
  history: {} as Record<string, Message[]>,
  older: [] as Message[],
  around: null as { found: boolean; messages: Message[]; hasOlder: boolean; hasNewer: boolean } | null,
  after: [] as Message[],
}));

vi.mock("../lib/chat", async (importActual) => {
  const actual = await importActual<typeof import("../lib/chat")>();
  return {
    ...actual, // keep applyReaction + wsUrl real
    loadHistory: vi.fn(async (_b: string, chatId: string, before?: string) => (before ? H.older : H.history[chatId] ?? [])),
    loadHistoryAround: vi.fn(async () => H.around ?? { found: false, messages: [], hasOlder: false, hasNewer: false }),
    loadHistoryAfter: vi.fn(async () => H.after),
  };
});

import { useConversation } from "./useConversation";
import { loadHistory, loadHistoryAround } from "../lib/chat";

/** A promise a test resolves by hand, to drive the switched-away race guards. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const ME: SessionUser = { id: "u1", username: "alice", displayName: "Alice", avatarUrl: null, verified: true };
function msg(over: Partial<Message> = {}): Message {
  return { id: "m1", chatId: "c1", senderId: "u2", body: "hello", createdAt: 1000, ...over };
}

function setup(activeId: string | null = "c1", me: SessionUser | null = ME) {
  const cb = { onToast: vi.fn(), onActiveRead: vi.fn(), onMessageDeleted: vi.fn(), consumeReply: vi.fn(), onRevoked: vi.fn() };
  const hook = renderHook(
    (props: { activeId: string | null }) =>
      useConversation({ base: "", activeId: props.activeId, me, resolveSenderName: (id) => `name-${id}`, ...cb }),
    { initialProps: { activeId } },
  );
  return { ...hook, ...cb };
}

/** Mount at a chat, wait for its socket + first history, then open the socket. */
async function open(hist: Message[] = [msg()], activeId = "c1") {
  H.history[activeId] = hist;
  const s = setup(activeId);
  await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
  const ws = MockWebSocket.last;
  await waitFor(() => expect(s.result.current.messages.length).toBe(hist.length));
  act(() => ws.mockOpen());
  return { ...s, ws };
}

/** A stub log element with settable scroll geometry for the pagination paths. */
function fakeLog(scrollTop: number, scrollHeight = 1000, clientHeight = 400): HTMLDivElement {
  return { scrollTop, scrollHeight, clientHeight, scrollIntoView() {} } as unknown as HTMLDivElement;
}

beforeEach(() => {
  H.history = {};
  H.older = [];
  H.around = null;
  H.after = [];
});
afterEach(() => vi.useRealTimers());

describe("useConversation — load + read receipts", () => {
  it("loads history and sends a read on open when visible + at bottom", async () => {
    const { ws } = await open([msg({ id: "m1", createdAt: 1000 }), msg({ id: "m2", createdAt: 2000 })]);
    await waitFor(() => expect(ws.sentFrames().some((f) => f.type === "read" && f.upTo === 2000)).toBe(true));
  });

  it("does NOT send a read while hidden; catches up on focus when visible", async () => {
    setVisibility("hidden");
    const { ws } = await open([msg({ id: "m1", createdAt: 1000 })]);
    expect(ws.sentFrames().some((f) => f.type === "read")).toBe(false);
    act(() => setVisibility("visible"));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(ws.sentFrames().some((f) => f.type === "read" && f.upTo === 1000)).toBe(true));
  });

  it("does not resend a read for an already-acked watermark", async () => {
    const { ws } = await open([msg({ id: "m1", createdAt: 1000 })]);
    await waitFor(() => expect(ws.sentFrames().filter((f) => f.type === "read").length).toBe(1));
    act(() => window.dispatchEvent(new Event("focus")));
    // still exactly one — the sentReadUpTo high-water suppresses the duplicate.
    expect(ws.sentFrames().filter((f) => f.type === "read").length).toBe(1);
  });
});

describe("useConversation — frame handling", () => {
  it("appends a live message and acks it when at bottom", async () => {
    const { result, ws } = await open([msg({ id: "m1", createdAt: 1000 })]);
    act(() => ws.mockEmit({ type: "message", message: msg({ id: "m2", senderId: "u2", body: "live", createdAt: 2000 }) }));
    expect(result.current.messages.map((m) => m.id)).toContain("m2");
    await waitFor(() => expect(ws.sentFrames().some((f) => f.type === "read" && f.upTo === 2000)).toBe(true));
  });

  it("dedupes a re-delivered message id", async () => {
    const { result, ws } = await open([msg({ id: "m1", createdAt: 1000 })]);
    act(() => ws.mockEmit({ type: "message", message: msg({ id: "m2", body: "once", createdAt: 2000 }) }));
    act(() => ws.mockEmit({ type: "message", message: msg({ id: "m2", body: "once", createdAt: 2000 }) }));
    expect(result.current.messages.filter((m) => m.id === "m2").length).toBe(1);
  });

  it("reconciles an optimistic bubble on {sent}", async () => {
    const { result, ws } = await open([]);
    act(() => result.current.send("hi there"));
    const tempId = ws.sentFrames().find((f) => f.type === "send")!.tempId as string;
    expect(result.current.messages.some((m) => m.pending)).toBe(true);
    act(() => ws.mockEmit({ type: "sent", tempId, message: msg({ id: "srv", senderId: "u1", body: "hi there", createdAt: 3000 }) }));
    expect(result.current.messages.some((m) => m.pending)).toBe(false);
    expect(result.current.messages.find((m) => m.id === "srv")).toBeTruthy();
  });

  it("presence_snapshot + presence add/remove + away toggles", async () => {
    const { result, ws } = await open([]);
    act(() => ws.mockEmit({ type: "presence_snapshot", online: ["u2", "u3"], away: ["u3"] }));
    expect([...result.current.online].sort()).toEqual(["u2", "u3"]);
    expect([...result.current.away]).toEqual(["u3"]);
    act(() => ws.mockEmit({ type: "presence", userId: "u4", online: true, away: true }));
    expect(result.current.online.has("u4")).toBe(true);
    expect(result.current.away.has("u4")).toBe(true);
    act(() => ws.mockEmit({ type: "presence", userId: "u2", online: false }));
    expect(result.current.online.has("u2")).toBe(false);
  });

  it("typing sets peerTyping and auto-clears after the TTL", async () => {
    const { result, ws } = await open([]); // mount with real timers (the async open uses them)
    vi.useFakeTimers();
    act(() => ws.mockEmit({ type: "typing", userId: "u2", on: true }));
    expect(result.current.peerTyping).toBe(true);
    act(() => vi.advanceTimersByTime(5001));
    expect(result.current.peerTyping).toBe(false);
  });

  it("read_receipt advances peerLastReadAt monotonically", async () => {
    const { result, ws } = await open([]);
    act(() => ws.mockEmit({ type: "read_receipt", userId: "u2", upTo: 5000 }));
    expect(result.current.peerLastReadAt).toBe(5000);
    act(() => ws.mockEmit({ type: "read_receipt", userId: "u2", upTo: 3000 })); // stale — ignored
    expect(result.current.peerLastReadAt).toBe(5000);
  });

  it("edited updates in place; deleted tombstones + fires onMessageDeleted", async () => {
    const { result, ws, onMessageDeleted } = await open([msg({ id: "m1", body: "old", createdAt: 1000 })]);
    act(() => ws.mockEmit({ type: "edited", id: "m1", body: "new", editedAt: 4000 }));
    expect(result.current.messages.find((m) => m.id === "m1")!.body).toBe("new");
    act(() => ws.mockEmit({ type: "deleted", id: "m1" }));
    expect(result.current.messages.find((m) => m.id === "m1")!.isDeleted).toBe(true);
    expect(onMessageDeleted).toHaveBeenCalledWith("m1");
  });

  it("reaction: a foreign toggle bumps count; our own echo is a no-op (dedupe)", async () => {
    const { result, ws } = await open([msg({ id: "m1", createdAt: 1000, reactions: [] })]);
    act(() => ws.mockEmit({ type: "reaction", id: "m1", emoji: "👍", userId: "u2", on: true }));
    expect(result.current.messages.find((m) => m.id === "m1")!.reactions).toEqual([{ emoji: "👍", count: 1, mine: false }]);
    // our own optimistic react, then the confirming echo must not double-count.
    act(() => result.current.sendReact(result.current.messages.find((m) => m.id === "m1")!, "👍"));
    const afterOptimistic = result.current.messages.find((m) => m.id === "m1")!.reactions!.find((r) => r.emoji === "👍")!;
    expect(afterOptimistic.count).toBe(2);
    act(() => ws.mockEmit({ type: "reaction", id: "m1", emoji: "👍", userId: "u1", on: true }));
    expect(result.current.messages.find((m) => m.id === "m1")!.reactions!.find((r) => r.emoji === "👍")!.count).toBe(2);
  });

  it("error frame surfaces a mapped toast (and a fallback for unknown codes)", async () => {
    const { ws, onToast } = await open([]);
    act(() => ws.mockEmit({ type: "error", code: "rate_limited" }));
    expect(onToast).toHaveBeenCalledWith("you're sending too fast — slow down a moment");
    act(() => ws.mockEmit({ type: "error", code: "mystery" }));
    expect(onToast).toHaveBeenCalledWith("something went wrong");
  });
});

describe("useConversation — actions", () => {
  it("send: optimistic bubble + {send} frame + consumeReply; a closed socket is a no-op", async () => {
    const { result, ws, consumeReply } = await open([]);
    act(() => result.current.send("outgoing", "m1"));
    const f = ws.sentFrames().find((x) => x.type === "send");
    expect(f).toMatchObject({ type: "send", body: "outgoing", replyToId: "m1" });
    expect(consumeReply).toHaveBeenCalledTimes(1);
    // Close the socket → send is a no-op (reply stays armed).
    act(() => ws.mockDrop());
    consumeReply.mockClear();
    act(() => result.current.send("while down"));
    expect(consumeReply).not.toHaveBeenCalled();
  });

  it("sendEdit skips a no-op edit and emits a real one", async () => {
    const { result, ws } = await open([msg({ id: "m1", senderId: "u1", body: "same", createdAt: 1000 })]);
    act(() => result.current.sendEdit(result.current.messages[0], "same")); // no change → no frame
    expect(ws.sentFrames().some((x) => x.type === "edit")).toBe(false);
    act(() => result.current.sendEdit(result.current.messages[0], "changed"));
    expect(ws.sentFrames().some((x) => x.type === "edit" && x.body === "changed")).toBe(true);
  });

  it("sendDelete emits; sendReact skips pending/deleted messages", async () => {
    const { result, ws } = await open([msg({ id: "m1", senderId: "u1", createdAt: 1000 })]);
    act(() => result.current.sendDelete(result.current.messages[0]));
    expect(ws.sentFrames().some((x) => x.type === "delete" && x.id === "m1")).toBe(true);
    act(() => result.current.sendReact({ ...result.current.messages[0], isDeleted: true }, "👍"));
    expect(ws.sentFrames().some((x) => x.type === "react")).toBe(false);
  });
});

describe("useConversation — pagination + jumps", () => {
  it("loadOlder prepends an older page when scrolled to the top", async () => {
    const first = Array.from({ length: 50 }, (_, i) => msg({ id: `m${i}`, createdAt: 1000 + i }));
    H.older = [msg({ id: "old1", createdAt: 1 }), msg({ id: "old2", createdAt: 2 })];
    const { result } = await open(first);
    act(() => { result.current.logRef.current = fakeLog(0); });
    await act(async () => { result.current.onLogScroll(); });
    await waitFor(() => expect(result.current.messages.some((m) => m.id === "old1")).toBe(true));
    expect(result.current.messages[0].id).toBe("old1");
  });

  it("jumpToMessage into a detached window suppresses live-append; jumpToLatest reattaches", async () => {
    H.around = { found: true, messages: [msg({ id: "mOld", body: "back then", createdAt: 100 })], hasOlder: false, hasNewer: true };
    const { result, ws } = await open([msg({ id: "m1", createdAt: 1000 })]);
    await act(async () => { await result.current.jumpToMessage("mOld"); });
    expect(result.current.hasNewer).toBe(true);
    // A live frame must NOT append while detached.
    act(() => ws.mockEmit({ type: "message", message: msg({ id: "m99", body: "suppressed", createdAt: 6000 }) }));
    expect(result.current.messages.some((m) => m.id === "m99")).toBe(false);
    // jumpToLatest reloads the tail + reattaches.
    H.history["c1"] = [msg({ id: "m1", createdAt: 1000 }), msg({ id: "m2", createdAt: 2000 })];
    await act(async () => { await result.current.jumpToLatest(); });
    expect(result.current.hasNewer).toBe(false);
    act(() => ws.mockEmit({ type: "message", message: msg({ id: "m3", createdAt: 3000 }) }));
    expect(result.current.messages.some((m) => m.id === "m3")).toBe(true);
  });

  it("jumpToMessage toasts when the target can't be found", async () => {
    H.around = { found: false, messages: [], hasOlder: false, hasNewer: false };
    const { result, onToast } = await open([msg({ id: "m1", createdAt: 1000 })]);
    await act(async () => { await result.current.jumpToMessage("ghost"); });
    expect(onToast).toHaveBeenCalledWith("message not found");
  });

  it("send from a detached window snaps to latest then resends", async () => {
    H.around = { found: true, messages: [msg({ id: "mOld", createdAt: 100 })], hasOlder: false, hasNewer: true };
    H.history["c1"] = [msg({ id: "m1", createdAt: 1000 })];
    const { result, ws } = await open([msg({ id: "m1", createdAt: 1000 })]);
    await act(async () => { await result.current.jumpToMessage("mOld"); });
    expect(result.current.hasNewer).toBe(true);
    await act(async () => { result.current.send("from detached"); });
    await waitFor(() => expect(result.current.hasNewer).toBe(false));
    await waitFor(() => expect(ws.sentFrames().some((f) => f.type === "send" && f.body === "from detached")).toBe(true));
  });
});

describe("useConversation — scroll, notify, flash", () => {
  it("autoscrolls to the bottom on a new message when attached", async () => {
    const el = fakeLog(0, 500, 400);
    const { result, ws } = await open([msg({ id: "m1", createdAt: 1000 })]);
    act(() => { result.current.logRef.current = el; });
    act(() => ws.mockEmit({ type: "message", message: msg({ id: "m2", createdAt: 2000 }) }));
    expect(el.scrollTop).toBe(el.scrollHeight); // pinned to bottom
  });

  it("onLogScroll acks the newest when scrolled to the real bottom", async () => {
    const { result, ws } = await open([msg({ id: "m1", createdAt: 1000 })]);
    // Bury the open-time read so we can observe a fresh scroll-driven one.
    act(() => ws.mockEmit({ type: "message", message: msg({ id: "m2", senderId: "u2", createdAt: 2000 }) }));
    const before = ws.sentFrames().filter((f) => f.type === "read").length;
    act(() => { result.current.logRef.current = fakeLog(600, 1000, 400); }); // dist = 0 → at bottom
    // move the read watermark back so a new read is warranted
    act(() => ws.mockEmit({ type: "message", message: msg({ id: "m3", senderId: "u2", createdAt: 3000 }) }));
    act(() => { result.current.logRef.current = fakeLog(600, 1000, 400); });
    act(() => result.current.onLogScroll());
    expect(ws.sentFrames().filter((f) => f.type === "read").length).toBeGreaterThanOrEqual(before);
    expect(ws.sentFrames().some((f) => f.type === "read" && f.upTo === 3000)).toBe(true);
  });

  it("loadNewer pages a detached window forward and reattaches on a short page", async () => {
    H.around = { found: true, messages: [msg({ id: "mOld", createdAt: 100 })], hasOlder: false, hasNewer: true };
    const { result } = await open([msg({ id: "m1", createdAt: 1000 })]);
    await act(async () => { await result.current.jumpToMessage("mOld"); });
    expect(result.current.hasNewer).toBe(true);
    // A short forward page (<50) ⇒ we've reached the live tail → reattach.
    H.after = [msg({ id: "mNew", createdAt: 200 })];
    H.history["c1"] = [msg({ id: "mOld", createdAt: 100 }), msg({ id: "mNew", createdAt: 200 })];
    act(() => { result.current.logRef.current = fakeLog(600, 1000, 400); }); // near bottom → triggers loadNewer
    await act(async () => { result.current.onLogScroll(); await Promise.resolve(); });
    await waitFor(() => expect(result.current.hasNewer).toBe(false));
    expect(result.current.messages.some((m) => m.id === "mNew")).toBe(true);
  });

  it("loadNewer appends a full forward page and stays detached", async () => {
    H.around = { found: true, messages: [msg({ id: "mOld", createdAt: 100 })], hasOlder: false, hasNewer: true };
    const { result } = await open([msg({ id: "m1", createdAt: 1000 })]);
    await act(async () => { await result.current.jumpToMessage("mOld"); });
    H.after = Array.from({ length: 50 }, (_, i) => msg({ id: `f${i}`, createdAt: 200 + i })); // full page ⇒ stay detached
    act(() => { result.current.logRef.current = fakeLog(600, 1000, 400); });
    await act(async () => { result.current.onLogScroll(); await Promise.resolve(); await Promise.resolve(); });
    await waitFor(() => expect(result.current.messages.some((m) => m.id === "f0")).toBe(true));
    expect(result.current.hasNewer).toBe(true); // a full page ⇒ there is still more below
  });

  it("maybeNotify fires for a backgrounded message from someone else", async () => {
    setVisibility("hidden");
    const { ws } = await open([msg({ id: "m1", createdAt: 1000 })]);
    act(() => ws.mockEmit({ type: "message", message: msg({ id: "m2", senderId: "u2", body: "ping", createdAt: 2000 }) }));
    expect(MockNotification.instances.length).toBe(1);
    expect(MockNotification.instances[0].body).toBe("ping");
    // Our OWN message never notifies.
    act(() => ws.mockEmit({ type: "message", message: msg({ id: "m3", senderId: "u1", body: "self", createdAt: 3000 }) }));
    expect(MockNotification.instances.length).toBe(1);
  });

  it("jumpToMessage flashes an already-loaded row in place (no server fetch)", async () => {
    const { result } = await open([msg({ id: "m1", body: "target", createdAt: 1000 })]);
    const row = document.createElement("div");
    act(() => { result.current.registerRow("m1", row); });
    await act(async () => { await result.current.jumpToMessage("m1"); });
    expect(row.classList.contains("is-flash")).toBe(true);
    act(() => { result.current.registerRow("m1", null); }); // unregister path
  });
});

describe("useConversation — action guards", () => {
  it("send is a no-op without a signed-in user", async () => {
    H.history["c1"] = [];
    const s = setup("c1", null); // me = null
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.last;
    act(() => ws.mockOpen());
    act(() => s.result.current.send("nope"));
    expect(ws.sentFrames().some((f) => f.type === "send")).toBe(false);
  });

  it("sendReact skips a pending optimistic bubble; edits no-op on a closed socket", async () => {
    const { result, ws } = await open([msg({ id: "m1", senderId: "u1", body: "x", createdAt: 1000 })]);
    act(() => result.current.sendReact({ ...result.current.messages[0], pending: true }, "👍"));
    expect(ws.sentFrames().some((f) => f.type === "react")).toBe(false);
    act(() => ws.mockDrop());
    act(() => result.current.sendEdit(result.current.messages[0], "changed"));
    act(() => result.current.sendDelete(result.current.messages[0]));
    expect(ws.sentFrames().some((f) => f.type === "edit")).toBe(false);
    expect(ws.sentFrames().some((f) => f.type === "delete")).toBe(false);
  });
});

describe("useConversation — branch guards", () => {
  it("maybeNotify no-ops when permission isn't granted", async () => {
    MockNotification.permission = "default";
    setVisibility("hidden");
    const { ws } = await open([msg({ id: "m1", createdAt: 1000 })]);
    act(() => ws.mockEmit({ type: "message", message: msg({ id: "m2", senderId: "u2", createdAt: 2000 }) }));
    expect(MockNotification.instances.length).toBe(0);
  });

  it("maybeNotify no-ops without the Notification API", async () => {
    const saved = (globalThis as { Notification?: unknown }).Notification;
    (globalThis as { Notification?: unknown }).Notification = undefined;
    setVisibility("hidden");
    const { ws } = await open([msg({ id: "m1", createdAt: 1000 })]);
    // Just must not throw (the typeof-undefined guard short-circuits).
    act(() => ws.mockEmit({ type: "message", message: msg({ id: "m2", senderId: "u2", createdAt: 2000 }) }));
    (globalThis as { Notification?: unknown }).Notification = saved;
  });

  it("does not ack a live message while scrolled up (not at bottom)", async () => {
    const { result, ws } = await open([msg({ id: "m1", createdAt: 1000 })]);
    const before = ws.sentFrames().filter((f) => f.type === "read").length;
    act(() => { result.current.logRef.current = fakeLog(0, 5000, 400); }); // far from bottom
    act(() => result.current.onLogScroll()); // sets atBottom=false
    act(() => ws.mockEmit({ type: "message", message: msg({ id: "m2", senderId: "u2", createdAt: 2000 }) }));
    expect(ws.sentFrames().filter((f) => f.type === "read").length).toBe(before);
  });

  it("loadOlder is a no-op when there is no older page", async () => {
    const { result } = await open([msg({ id: "m1", createdAt: 1000 })]); // short first page → hasMore false
    act(() => { result.current.logRef.current = fakeLog(0); });
    await act(async () => { result.current.onLogScroll(); await Promise.resolve(); });
    expect(result.current.messages.length).toBe(1); // nothing prepended
  });

  it("send builds an optimistic reply snippet from an existing parent", async () => {
    const { result, ws } = await open([msg({ id: "m1", senderId: "u2", body: "parent body", createdAt: 1000 })]);
    act(() => result.current.send("a reply", "m1"));
    const bubble = result.current.messages.find((m) => m.pending);
    expect(bubble?.replyTo).toMatchObject({ id: "m1", senderId: "u2" });
    expect(ws.sentFrames().some((f) => f.type === "send" && f.replyToId === "m1")).toBe(true);
  });

  it("sendEdit ignores a blank edit", async () => {
    const { result, ws } = await open([msg({ id: "m1", senderId: "u1", body: "keep", createdAt: 1000 })]);
    act(() => result.current.sendEdit(result.current.messages[0], "   "));
    expect(ws.sentFrames().some((f) => f.type === "edit")).toBe(false);
  });

  it("jumpToLatest with an empty tail clears the detached window without a read", async () => {
    H.around = { found: true, messages: [msg({ id: "mOld", createdAt: 100 })], hasOlder: false, hasNewer: true };
    const { result, ws } = await open([msg({ id: "m1", createdAt: 1000 })]);
    await act(async () => { await result.current.jumpToMessage("mOld"); });
    H.history["c1"] = [];
    const before = ws.sentFrames().filter((f) => f.type === "read").length;
    await act(async () => { await result.current.jumpToLatest(); });
    expect(result.current.hasNewer).toBe(false);
    expect(result.current.messages.length).toBe(0);
    expect(ws.sentFrames().filter((f) => f.type === "read").length).toBe(before);
  });
});

describe("useConversation — frames over a multi-message list", () => {
  it("edit/delete/reaction/sent touch only their target, leaving neighbors intact", async () => {
    const { result, ws } = await open([
      msg({ id: "m1", body: "one", createdAt: 1000 }),
      msg({ id: "m2", body: "two", createdAt: 2000 }),
      msg({ id: "m3", body: "three", createdAt: 3000 }),
    ]);
    act(() => ws.mockEmit({ type: "edited", id: "m2", body: "TWO", editedAt: 4000 }));
    act(() => ws.mockEmit({ type: "deleted", id: "m1" }));
    act(() => ws.mockEmit({ type: "reaction", id: "m3", emoji: "🔥", userId: "u2", on: true }));
    const byId = Object.fromEntries(result.current.messages.map((m) => [m.id, m]));
    expect(byId.m2.body).toBe("TWO");
    expect(byId.m1.isDeleted).toBe(true);
    expect(byId.m3.reactions).toEqual([{ emoji: "🔥", count: 1, mine: false }]);
    // Neighbors are the untouched else-branch of each map.
    expect(byId.m3.body).toBe("three");
    expect(byId.m2.isDeleted).toBeFalsy();
  });

  it("a {sent} ack reconciles only the matching tempId among several pending bubbles", async () => {
    const { result, ws } = await open([]);
    act(() => result.current.send("first"));
    act(() => result.current.send("second"));
    const sends = ws.sentFrames().filter((f) => f.type === "send");
    const firstTemp = sends[0].tempId as string;
    act(() => ws.mockEmit({ type: "sent", tempId: firstTemp, message: msg({ id: "srv1", senderId: "u1", body: "first", createdAt: 5000 }) }));
    expect(result.current.messages.find((m) => m.id === "srv1")).toBeTruthy();
    // The second bubble is still pending (the untouched map else-branch).
    expect(result.current.messages.filter((m) => m.pending).length).toBe(1);
  });

  it("a second typing frame clears the pending auto-clear timer", async () => {
    const { result, ws } = await open([]);
    act(() => ws.mockEmit({ type: "typing", userId: "u2", on: true }));
    act(() => ws.mockEmit({ type: "typing", userId: "u2", on: true })); // finds a non-null timer → clears it
    expect(result.current.peerTyping).toBe(true);
    act(() => ws.mockEmit({ type: "typing", userId: "u2", on: false }));
    expect(result.current.peerTyping).toBe(false);
  });
});

describe("useConversation — switched-away race safety", () => {
  it("loadOlder drops its page if the chat switched away mid-load", async () => {
    const first = Array.from({ length: 50 }, (_, i) => msg({ id: `m${i}`, createdAt: 1000 + i }));
    H.history["c1"] = first;
    H.history["c2"] = [msg({ id: "n1", chatId: "c2", createdAt: 5000 })];
    const s = setup("c1");
    await waitFor(() => expect(s.result.current.messages.length).toBe(50));
    const d = deferred<Message[]>();
    vi.mocked(loadHistory).mockReturnValueOnce(d.promise);
    act(() => { s.result.current.logRef.current = fakeLog(0); });
    act(() => s.result.current.onLogScroll()); // starts loadOlder → awaits d.promise
    act(() => s.rerender({ activeId: "c2" })); // switch away before it resolves
    await waitFor(() => expect(s.result.current.messages.some((m) => m.id === "n1")).toBe(true));
    await act(async () => { d.resolve([msg({ id: "stale", createdAt: 1 })]); await d.promise; });
    expect(s.result.current.messages.some((m) => m.id === "stale")).toBe(false); // guard held
  });

  it("jumpToMessage drops its window if the chat switched away mid-fetch", async () => {
    H.history["c1"] = [msg({ id: "m1", createdAt: 1000 })];
    H.history["c2"] = [msg({ id: "n1", chatId: "c2", createdAt: 5000 })];
    const s = setup("c1");
    await waitFor(() => expect(s.result.current.messages.some((m) => m.id === "m1")).toBe(true));
    const d = deferred<{ found: boolean; messages: Message[]; hasOlder: boolean; hasNewer: boolean }>();
    vi.mocked(loadHistoryAround).mockReturnValueOnce(d.promise);
    let jump!: Promise<void>;
    act(() => { jump = s.result.current.jumpToMessage("mGhost"); });
    act(() => s.rerender({ activeId: "c2" }));
    await waitFor(() => expect(s.result.current.messages.some((m) => m.id === "n1")).toBe(true));
    await act(async () => {
      d.resolve({ found: true, messages: [msg({ id: "stale", createdAt: 1 })], hasOlder: false, hasNewer: true });
      await jump;
    });
    expect(s.result.current.messages.some((m) => m.id === "stale")).toBe(false);
    expect(s.result.current.hasNewer).toBe(false); // never entered a detached window for the wrong chat
  });

  it("jumpToMessage toasts on a load error", async () => {
    const { result, onToast } = await open([msg({ id: "m1", createdAt: 1000 })]);
    vi.mocked(loadHistoryAround).mockRejectedValueOnce(new Error("boom"));
    await act(async () => { await result.current.jumpToMessage("mX"); });
    expect(onToast).toHaveBeenCalledWith("couldn't load that message");
  });

  it("jumpToLatest drops its tail if the chat switched away mid-load", async () => {
    H.around = { found: true, messages: [msg({ id: "mOld", createdAt: 100 })], hasOlder: false, hasNewer: true };
    H.history["c1"] = [msg({ id: "m1", createdAt: 1000 })];
    H.history["c2"] = [msg({ id: "n1", chatId: "c2", createdAt: 5000 })];
    const s = setup("c1");
    await waitFor(() => expect(s.result.current.messages.some((m) => m.id === "m1")).toBe(true));
    await act(async () => { await s.result.current.jumpToMessage("mOld"); });
    expect(s.result.current.hasNewer).toBe(true);
    const d = deferred<Message[]>();
    vi.mocked(loadHistory).mockReturnValueOnce(d.promise);
    let jl!: Promise<void>;
    act(() => { jl = s.result.current.jumpToLatest(); });
    act(() => s.rerender({ activeId: "c2" }));
    await waitFor(() => expect(s.result.current.messages.some((m) => m.id === "n1")).toBe(true));
    await act(async () => { d.resolve([msg({ id: "stale", createdAt: 9 })]); await jl; });
    expect(s.result.current.messages.some((m) => m.id === "stale")).toBe(false);
  });
});

describe("useConversation — lifecycle", () => {
  it("emits away on visibilitychange and reconnects after an unexpected drop", async () => {
    const { ws } = await open([msg({ id: "m1", createdAt: 1000 })]);
    act(() => setVisibility("hidden"));
    await waitFor(() => expect(ws.sentFrames().some((f) => f.type === "away" && f.away === true)).toBe(true));
    act(() => ws.mockDrop());
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(2), { timeout: 2000 });
  });

  it("switching chats tears down the old socket, resets state, and loads the new chat", async () => {
    H.history["c1"] = [msg({ id: "m1", body: "in c1", createdAt: 1000 })];
    H.history["c2"] = [msg({ id: "n1", chatId: "c2", body: "in c2", createdAt: 2000 })];
    const s = setup("c1");
    await waitFor(() => expect(s.result.current.messages.some((m) => m.id === "m1")).toBe(true));
    const first = MockWebSocket.last;
    act(() => s.rerender({ activeId: "c2" }));
    await waitFor(() => expect(s.result.current.messages.some((m) => m.id === "n1")).toBe(true));
    expect(s.result.current.messages.some((m) => m.id === "m1")).toBe(false);
    expect(first.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("closing the chat (activeId → null) tears down the socket", async () => {
    H.history["c1"] = [msg({ id: "m1", createdAt: 1000 })];
    const s = setup("c1");
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.last;
    await waitFor(() => expect(s.result.current.messages.length).toBe(1));
    act(() => s.rerender({ activeId: null }));
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("a {revoked} frame fires onRevoked and stops the socket reconnecting", async () => {
    const { ws, onRevoked } = await open([msg({ id: "m1", createdAt: 1000 })]);
    act(() => ws.mockEmit({ type: "revoked" }));
    expect(onRevoked).toHaveBeenCalledTimes(1);
    // The server then closes the socket — the removed member must NOT reconnect.
    act(() => ws.mockDrop());
    await new Promise((r) => setTimeout(r, 700)); // past the 500ms first backoff
    expect(MockWebSocket.instances.length).toBe(1);
  });

  it("reconnects immediately on online/visibility wake when socket is closed", async () => {
    const { ws } = await open([msg({ id: "m1", createdAt: 1000 })]);
    act(() => ws.mockDrop());
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(1));
  });
});
