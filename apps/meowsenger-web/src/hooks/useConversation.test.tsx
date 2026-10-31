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
    loadHistory: vi.fn(async (_b: string, chatId: string, before?: string) => ({ ok: true as const, status: 200, data: before ? H.older : H.history[chatId] ?? [] })),
    loadHistoryAround: vi.fn(async () => H.around ?? { found: false, messages: [], hasOlder: false, hasNewer: false }),
    loadHistoryAfter: vi.fn(async () => ({ ok: true as const, status: 200, data: H.after })),
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
    // A closed socket no longer drops the send: it queues (see the outbox tests below).
    act(() => ws.mockDrop());
    let r = "";
    act(() => { r = result.current.send("while down"); });
    expect(r).toBe("queued");
  });

  it("send returns \"sent\" when the socket is open", async () => {
    const { result } = await open([]);
    let r = "";
    act(() => { r = result.current.send("hi"); });
    expect(r).toBe("sent");
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

describe("useConversation — outbox (PR-3)", () => {
  /** Mount WITHOUT opening the socket: still CONNECTING. */
  async function connecting(activeId = "c1") {
    H.history[activeId] = [];
    const s = setup(activeId);
    await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
    return { ...s, ws: MockWebSocket.last };
  }
  const sends = (ws: MockWebSocket) => ws.sentFrames().filter((f) => f.type === "send");

  it("send while CONNECTING queues (no frame, pending bubble marked queued), then flushes on open with the SAME tempId", async () => {
    const { result, ws } = await connecting();
    let r = "";
    act(() => { r = result.current.send("typed early"); });
    expect(r).toBe("queued");
    expect(ws.sentFrames()).toEqual([]);
    const bubble = result.current.messages.find((m) => m.body === "typed early")!;
    expect(bubble).toMatchObject({ pending: true, queued: "send" });
    act(() => ws.mockOpen());
    expect(sends(ws)).toHaveLength(1);
    expect(sends(ws)[0].tempId).toBe(bubble.tempId); // minted once at enqueue, reused on flush
    const after = result.current.messages.find((m) => m.body === "typed early")!;
    expect(after.queued).toBeUndefined(); // now in flight, no longer queued
    expect(after.pending).toBe(true);
    act(() => ws.mockEmit({ type: "sent", tempId: bubble.tempId, message: msg({ id: "real1", senderId: "u1", body: "typed early" }) }));
    expect(result.current.messages.filter((m) => m.body === "typed early")).toHaveLength(1);
    expect(result.current.messages.find((m) => m.body === "typed early")!.id).toBe("real1");
  });

  it("send during a close race (readyState CLOSING while connected is still true) queues, then flushes on the next socket", async () => {
    const { result, ws } = await open([]);
    expect(result.current.connected).toBe(true);
    ws.readyState = MockWebSocket.CLOSING; // `connected` only flips in onclose, so it lags
    expect(result.current.connected).toBe(true);
    let r = "";
    act(() => { r = result.current.send("racing"); });
    expect(r).toBe("queued");
    expect(sends(ws)).toHaveLength(0);
    const tempId = result.current.messages.find((m) => m.body === "racing")!.tempId;
    act(() => ws.mockDrop());
    // reconnect timer
    await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(1), { timeout: 3000 });
    const ws2 = MockWebSocket.last;
    act(() => ws2.mockOpen());
    expect(sends(ws2)).toHaveLength(1);
    expect(sends(ws2)[0]).toMatchObject({ body: "racing", tempId });
  });

  it("flushes queued items in order on open (sends, then an edit and a delete)", async () => {
    H.history["c1"] = [msg({ id: "m1", senderId: "u1", body: "old", createdAt: 1000 }), msg({ id: "m2", senderId: "u1", body: "bye", createdAt: 1100 })];
    const s = setup("c1");
    await waitFor(() => expect(s.result.current.messages.length).toBe(2));
    const ws = MockWebSocket.last;
    act(() => { s.result.current.send("one"); s.result.current.send("two"); });
    act(() => { s.result.current.sendEdit(s.result.current.messages[0], "new"); });
    act(() => { s.result.current.sendDelete(s.result.current.messages[1]); });
    act(() => { s.result.current.send("three"); });
    const shown = s.result.current.messages;
    expect(shown.find((m) => m.id === "m1")).toMatchObject({ body: "new", queued: "edit" });
    expect(shown.find((m) => m.id === "m2")).toMatchObject({ queued: "delete" });
    expect(s.result.current.queuedCount()).toBe(5);
    expect(ws.sentFrames()).toEqual([]);
    act(() => ws.mockOpen());
    const frames = ws.sentFrames().filter((f) => f.type !== "read" && f.type !== "away");
    expect(frames.map((f) => `${f.type}:${(f.body as string | undefined) ?? (f.id as string)}`)).toEqual(["send:one", "send:two", "edit:new", "delete:m2", "send:three"]);
    expect(s.result.current.queuedCount()).toBe(0);
    // flushed sends append to the log in the order they were typed
    expect(s.result.current.messages.filter((m) => m.pending).map((m) => m.body)).toEqual(["one", "two", "three"]);
  });

  it("a later edit replaces a queued edit; a delete supersedes queued edits", async () => {
    H.history["c1"] = [msg({ id: "m1", senderId: "u1", body: "old", createdAt: 1000 })];
    const s = setup("c1");
    await waitFor(() => expect(s.result.current.messages.length).toBe(1));
    const ws = MockWebSocket.last;
    act(() => { s.result.current.sendEdit(s.result.current.messages[0], "v1"); });
    act(() => { s.result.current.sendEdit(s.result.current.messages[0], "v2"); });
    expect(s.result.current.queuedCount()).toBe(1);
    act(() => { s.result.current.sendDelete(s.result.current.messages[0]); });
    expect(s.result.current.queuedCount()).toBe(1);
    act(() => ws.mockOpen());
    expect(ws.sentFrames().filter((f) => f.type === "edit")).toEqual([]);
    expect(ws.sentFrames().filter((f) => f.type === "delete")).toHaveLength(1);
  });

  it("each chat keeps its own outbox across a switch; only the open chat's queue flushes", async () => {
    H.history["c1"] = []; H.history["c2"] = [];
    const s = setup("c1");
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    act(() => { s.result.current.send("for c1"); });
    s.rerender({ activeId: "c2" });
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(2));
    const ws2 = MockWebSocket.last;
    expect(ws2.url).toContain("c2");
    expect(s.result.current.messages.map((m) => m.body)).toEqual([]); // c1's queue is not shown in c2
    act(() => { s.result.current.send("for c2"); });
    expect(s.result.current.messages.map((m) => m.body)).toEqual(["for c2"]);
    s.rerender({ activeId: "c1" });
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(3));
    expect(s.result.current.messages.map((m) => m.body)).toEqual(["for c1"]);
    const ws3 = MockWebSocket.last;
    act(() => ws3.mockOpen());
    expect(sends(ws3).map((f) => f.body)).toEqual(["for c1"]); // c2's item did not leak into c1's socket
    expect(s.result.current.queuedCount()).toBe(1); // c2's is still held
    s.rerender({ activeId: "c2" });
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(4));
    act(() => MockWebSocket.last.mockOpen());
    expect(sends(MockWebSocket.last).map((f) => f.body)).toEqual(["for c2"]);
    expect(s.result.current.queuedCount()).toBe(0);
  });

  it("rejects (and keeps nothing queued) with no signed-in user, an empty body or an over-long body", async () => {
    const noUser = setup("c1", null);
    await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
    let r = "";
    act(() => { r = noUser.result.current.send("hello"); });
    expect(r).toBe("rejected");
    expect(noUser.onToast).toHaveBeenCalled();
    expect(noUser.result.current.queuedCount()).toBe(0);
    noUser.unmount();
    const { result } = await connecting();
    act(() => { r = result.current.send("   "); });
    expect(r).toBe("rejected");
    act(() => { r = result.current.send("x".repeat(4001)); });
    expect(r).toBe("rejected");
    expect(result.current.queuedCount()).toBe(0);
  });

  it("a send from a detached window stays queued, then flushes once the live tail is reattached", async () => {
    H.around = { found: true, messages: [msg({ id: "mOld", createdAt: 100 })], hasOlder: false, hasNewer: true };
    const { result, ws } = await open([msg({ id: "m1", createdAt: 1000 })]);
    await act(async () => { await result.current.jumpToMessage("mOld"); });
    let r = "";
    await act(async () => { r = result.current.send("from afar"); });
    expect(r).toBe("queued");
    await waitFor(() => expect(sends(ws).some((f) => f.body === "from afar")).toBe(true));
    expect(result.current.hasNewer).toBe(false);
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
    await waitFor(() => expect(MockNotification.instances.length).toBe(1));
    expect(MockNotification.instances[0].body).toBe("ping");
    // Our OWN message never notifies.
    act(() => ws.mockEmit({ type: "message", message: msg({ id: "m3", senderId: "u1", body: "self", createdAt: 3000 }) }));
    await new Promise((r) => setTimeout(r, 20));
    expect(MockNotification.instances.length).toBe(1);
  });

  describe("with a service worker", () => {
    const showNotification = vi.fn(async () => {});
    function installSw(subscribed: boolean, marker?: string) {
      vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "mw_push_synced" ? marker ?? null : null), setItem() {}, removeItem() {} });
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: { getRegistration: async () => ({ showNotification, pushManager: { getSubscription: async () => (subscribed ? { endpoint: "https://e/1" } : null) } }) },
      });
      (window as unknown as { PushManager: unknown }).PushManager = function PushManager() {};
    }
    afterEach(() => {
      delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
      delete (window as unknown as { PushManager?: unknown }).PushManager;
      showNotification.mockClear();
      vi.unstubAllGlobals();
    });

    it("a push subscription CONFIRMED for this account suppresses the in-page notification (the SW push covers it)", async () => {
      installSw(true, "u1|https://e/1");
      setVisibility("hidden");
      const { ws } = await open([msg({ id: "m1", createdAt: 1000 })]);
      act(() => ws.mockEmit({ type: "message", message: msg({ id: "m2", senderId: "u2", body: "ping", createdAt: 2000 }) }));
      await new Promise((r) => setTimeout(r, 30));
      expect(showNotification).not.toHaveBeenCalled();
      expect(MockNotification.instances.length).toBe(0);
    });

    it("a subscription that is not confirmed for this account (no / foreign marker) still shows the in-page notification", async () => {
      for (const marker of [undefined, "u2|https://e/1", "u1|https://e/other"]) {
        installSw(true, marker);
        setVisibility("hidden");
        const { ws } = await open([msg({ id: "m1", createdAt: 1000 })]);
        act(() => ws.mockEmit({ type: "message", message: msg({ id: "m2", senderId: "u2", body: "ping", createdAt: 2000 }) }));
        await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1));
        showNotification.mockClear();
      }
    });

    it("without a push subscription it shows via the registration with the SW's tag", async () => {
      installSw(false);
      setVisibility("hidden");
      const { ws } = await open([msg({ id: "m1", createdAt: 1000 })]);
      act(() => ws.mockEmit({ type: "message", message: msg({ id: "m2", senderId: "u2", body: "ping", createdAt: 2000 }) }));
      await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1));
      expect(showNotification).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: "ping", tag: "meowsenger-msg", data: { chatId: "c1" } }));
      expect(MockNotification.instances.length).toBe(0);
    });
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
    await new Promise((r) => setTimeout(r, 20));
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
    vi.mocked(loadHistory).mockReturnValueOnce(d.promise.then((data) => ({ ok: true as const, status: 200, data })));
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
    vi.mocked(loadHistory).mockReturnValueOnce(d.promise.then((data) => ({ ok: true as const, status: 200, data })));
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
