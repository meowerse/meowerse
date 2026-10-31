/** @vitest-environment happy-dom */
/**
 * PR-5 reconnect correctness, driven with fake timers + a fake WebSocket + an in-memory
 * "server" behind the history reads: outage catch-up (?after=, paged, merged by id), heartbeat,
 * the session probe after repeated failed opens, and the PR-3/PR-4 review follow-ups.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, MockWebSocket, setVisibility } from "../test/rtl";
import type { Message } from "../lib/chat";
import type { SessionUser } from "../lib/meowsengerApi";
import { hasSessionEnded, notifySessionEnded, resetSessionEnded } from "../lib/sessionEnded";

const S = vi.hoisted(() => ({
  msgs: [] as Array<Record<string, unknown>>,
  latestQueue: [] as Array<Array<Record<string, unknown>>>,
  aroundHasNewer: false,
  afterCalls: 0,
  session: { ok: false as boolean, error: { kind: "unauthorized" as string } } as unknown,
  sessionCalls: 0,
  afterFail: 0,
  afterKind: "network" as string,
  latestFail: false,
  aroundThrow: 0,
}));

vi.mock("../lib/meowsengerApi", async (importActual) => {
  const actual = await importActual<typeof import("../lib/meowsengerApi")>();
  return { ...actual, getSession: vi.fn(async () => { S.sessionCalls++; return S.session; }) };
});
vi.mock("../lib/chat", async (importActual) => {
  const actual = await importActual<typeof import("../lib/chat")>();
  const page = (a: Array<Record<string, unknown>>) => a.slice(-50) as unknown as Message[];
  return {
    ...actual,
    loadHistory: vi.fn(async (_b: string, _c: string, before?: string) => {
      if (before) return { ok: true as const, status: 200, data: [] as Message[] };
      if (S.latestFail) return { ok: false as const, error: { kind: "network" as const } };
      const q = S.latestQueue.shift();
      return { ok: true as const, status: 200, data: page(q ?? S.msgs) };
    }),
    loadHistoryAround: vi.fn(async (_b: string, _c: string, id: string) => {
      if (S.aroundThrow > 0) { S.aroundThrow--; throw new Error("net"); }
      const m = S.msgs.find((x) => x.id === id);
      return { found: !!m, messages: (m ? [m] : []) as unknown as Message[], hasOlder: false, hasNewer: S.aroundHasNewer };
    }),
    loadHistoryAfter: vi.fn(async (_b: string, _c: string, id: string) => {
      S.afterCalls++;
      if (S.afterFail > 0) {
        S.afterFail--;
        return S.afterKind === "forbidden"
          ? { ok: false as const, error: { kind: "http" as const, status: 403 } }
          : { ok: false as const, error: { kind: "network" as const } };
      }
      const i = S.msgs.findIndex((x) => x.id === id);
      if (i < 0) return { ok: true as const, status: 200, data: [] as Message[], unknown: true };
      return { ok: true as const, status: 200, data: S.msgs.slice(i + 1, i + 51) as unknown as Message[] };
    }),
  };
});

import { useConversation } from "./useConversation";

const ME: SessionUser = { id: "u1", username: "alice", displayName: "Alice", avatarUrl: null, verified: true };
const msg = (id: string, createdAt: number, over: Record<string, unknown> = {}) =>
  ({ id, chatId: "c1", senderId: "u2", body: `body-${id}`, createdAt, ...over });

function setup() {
  const cb = { onToast: vi.fn(), onActiveRead: vi.fn(), onMessageDeleted: vi.fn(), consumeReply: vi.fn(), onRevoked: vi.fn() };
  const hook = renderHook(() => useConversation({ base: "", activeId: "c1", me: ME, resolveSenderName: (id) => id, ...cb }));
  return { ...hook, ...cb };
}
const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const room = () => MockWebSocket.room;
const ids = (r: { current: { messages: Array<{ id: string }> } }) => r.current.messages.map((m) => m.id);

/** Mount, load history and open the first socket. */
async function boot(hist: Array<Record<string, unknown>>) {
  S.msgs = [...hist];
  const s = setup();
  await tick();
  act(() => room().mockOpen());
  await tick();
  return s;
}
const sendFrames = (ws: MockWebSocket) => ws.sentFrames().filter((f) => f.type === "send");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  S.msgs = []; S.latestQueue = []; S.aroundHasNewer = false; S.afterCalls = 0; S.sessionCalls = 0; S.afterFail = 0; S.afterKind = "network"; S.latestFail = false; S.aroundThrow = 0;
  S.session = { ok: false, error: { kind: "unauthorized" } };
  resetSessionEnded();
});
afterEach(() => { vi.useRealTimers(); resetSessionEnded(); });

describe("reconnect catch-up", () => {
  it("the peer sends 5 messages during an outage: reconnect shows all 5 exactly once", async () => {
    const { result } = await boot([msg("m1", 1000), msg("m2", 2000)]);
    act(() => room().mockDrop());
    for (let i = 1; i <= 5; i++) S.msgs.push(msg(`p${i}`, 2000 + i * 100));
    await tick(1000);
    act(() => room().mockOpen());
    await tick();
    // a live broadcast of the last one racing the catch-up must not double it
    act(() => room().mockEmit({ type: "message", message: msg("p5", 2500) }));
    await tick();
    expect(ids(result)).toEqual(["m1", "m2", "p1", "p2", "p3", "p4", "p5"]);
  });

  it("pages until short and merges 120 missed messages exactly once", async () => {
    const { result } = await boot([msg("m1", 1000)]);
    act(() => room().mockDrop());
    for (let i = 1; i <= 120; i++) S.msgs.push(msg(`p${String(i).padStart(3, "0")}`, 1000 + i));
    await tick(1000);
    act(() => room().mockOpen());
    await tick();
    expect(S.afterCalls).toBe(3);
    expect(ids(result)).toHaveLength(121);
    expect(new Set(ids(result)).size).toBe(121);
    expect(ids(result)[120]).toBe("p120");
  });

  it("is bounded: past the page cap it falls back to the newest page and says so", async () => {
    const { result, onToast } = await boot([msg("m1", 1000)]);
    act(() => room().mockDrop());
    for (let i = 1; i <= 400; i++) S.msgs.push(msg(`p${String(i).padStart(3, "0")}`, 1000 + i));
    await tick(1000);
    act(() => room().mockOpen());
    await tick();
    expect(S.afterCalls).toBe(5);
    expect(ids(result)).toHaveLength(50);
    expect(ids(result)[49]).toBe("p400");
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining("showing the latest"));
  });

  it("an anchor the server no longer has falls back to the newest page and reconciles", async () => {
    const { result } = await boot([msg("m1", 1000), msg("m2", 2000)]);
    act(() => room().mockDrop());
    S.msgs = [msg("m1", 1000), msg("p1", 3000)]; // m2 is gone
    await tick(1000);
    act(() => room().mockOpen());
    await tick();
    expect(ids(result)).toEqual(["m1", "p1"]);
  });

  it("does not catch up on the FIRST open", async () => {
    await boot([msg("m1", 1000)]);
    expect(S.afterCalls).toBe(0);
  });

  it("interleaving: outage + unacked send + queued sends + peer messages + a lost edit", async () => {
    const { result } = await boot([msg("m1", 1000, { body: "hello" }), msg("m2", 2000)]);
    act(() => { result.current.sendEdit(result.current.messages[0], "mine"); });
    act(() => { result.current.send("u1-text"); });
    const first = room();
    const u1 = sendFrames(first)[0].tempId as string;
    expect(result.current.messages[0].body).toBe("mine");
    act(() => first.mockDrop());
    // offline: two more sends queue behind the unacked one
    act(() => { result.current.send("q1-text"); });
    act(() => { result.current.send("q2-text"); });
    // the server received u1 before the drop, never applied the edit, and the peer spoke twice
    S.msgs.push(msg("s-u1", 2500, { senderId: "u1", body: "u1-text" }), msg("p1", 3000), msg("p2", 4000));
    await tick(1000);
    const second = room();
    act(() => second.mockOpen());
    await tick();
    // resend of the unacked item (same tempId) comes before the outbox flush, in order
    const sent = sendFrames(second);
    expect(sent.map((f) => f.body)).toEqual(["u1-text", "q1-text", "q2-text"]);
    expect(sent[0].tempId).toBe(u1);
    // the server re-acks u1 and acks the two new ones
    act(() => second.mockEmit({ type: "sent", tempId: u1, message: msg("s-u1", 2500, { senderId: "u1", body: "u1-text" }) }));
    act(() => second.mockEmit({ type: "sent", tempId: sent[1].tempId, message: msg("s-q1", 5000, { senderId: "u1", body: "q1-text" }) }));
    act(() => second.mockEmit({ type: "sent", tempId: sent[2].tempId, message: msg("s-q2", 5001, { senderId: "u1", body: "q2-text" }) }));
    await tick();
    expect(ids(result)).toEqual(["m1", "m2", "s-u1", "p1", "p2", "s-q1", "s-q2"]);
    expect(result.current.messages[0].body).toBe("hello"); // the lost edit's optimistic text is gone
    expect(result.current.messages.some((m) => m.pending)).toBe(false);
  });
});

describe("deferred review items", () => {
  it("(2) an edit in flight when the socket closed is reconciled: the server's text wins", async () => {
    const { result } = await boot([msg("m1", 1000, { body: "hello" })]);
    act(() => { result.current.sendEdit(result.current.messages[0], "mine"); });
    expect(result.current.messages[0].body).toBe("mine");
    act(() => room().mockDrop());
    await tick(1000);
    act(() => room().mockOpen());
    await tick();
    expect(result.current.messages[0].body).toBe("hello");
  });

  it("(2) ...and when the edit DID land, the caught-up server text is shown", async () => {
    const { result } = await boot([msg("m1", 1000, { body: "hello" })]);
    act(() => { result.current.sendEdit(result.current.messages[0], "mine"); });
    act(() => room().mockDrop());
    S.msgs = [msg("m1", 1000, { body: "mine", editedAt: 9 })];
    await tick(1000);
    act(() => room().mockOpen());
    await tick();
    expect(result.current.messages[0]).toMatchObject({ body: "mine", editedAt: 9 });
  });

  it("(1) attachLatest re-fetches the tail so a peer message that landed meanwhile is not skipped", async () => {
    const { result } = await boot([msg("m1", 1000), msg("m2", 2000)]);
    S.aroundHasNewer = true;
    await act(async () => { await result.current.jumpToMessage("m1"); });
    expect(result.current.hasNewer).toBe(true);
    // first tail read lacks p1 (it landed after it), the re-fetch has it
    S.latestQueue = [[msg("m1", 1000), msg("m2", 2000)], [msg("m1", 1000), msg("m2", 2000), msg("p1", 3000)]];
    await act(async () => { await result.current.jumpToLatest(); });
    expect(ids(result)).toEqual(["m1", "m2", "p1"]);
  });

  it("(3) an acked own bubble missing from the page lands in createdAt order, not after newer rows", async () => {
    const { result } = await boot([msg("m1", 1000)]);
    act(() => { result.current.send("hi"); });
    const tempId = sendFrames(room())[0].tempId as string;
    act(() => room().mockEmit({ type: "sent", tempId, message: msg("s1", 2000, { senderId: "u1", body: "hi" }) }));
    S.msgs = [msg("m1", 1000), msg("p1", 3000)]; // the server window does not have s1 yet
    await act(async () => { await result.current.jumpToMessage("p1"); }); // replaces the log via keepLocalOwn
    expect(ids(result)).toEqual(["s1", "p1"]);
  });

  it("(4) an `edited` from our other tab does not consume this tab's in-flight edit", async () => {
    const { result } = await boot([msg("m1", 1000, { body: "hello" })]);
    act(() => { result.current.sendEdit(result.current.messages[0], "x"); });
    act(() => room().mockEmit({ type: "edited", id: "m1", body: "y", editedAt: 5 })); // other tab's edit
    act(() => room().mockEmit({ type: "error", code: "cannot_edit", messageId: "m1" })); // OUR edit refused
    // reverts to the last server-confirmed text (the other tab's), flagged as failed
    expect(result.current.messages[0]).toMatchObject({ body: "y", editFailed: true });
  });
});

describe("heartbeat", () => {
  it("pings every 25 s while visible, and a pong keeps the socket", async () => {
    await boot([msg("m1", 1000)]);
    const ws = room();
    await tick(25_000);
    expect(ws.pings()).toBe(1);
    act(() => ws.onmessage?.({ data: "pong" }));
    await tick(10_000);
    expect(MockWebSocket.instances.length).toBe(1);
    await tick(15_000);
    expect(ws.pings()).toBe(2);
  });

  it("a missing pong within 10 s closes and reconnects", async () => {
    const { result } = await boot([msg("m1", 1000)]);
    const ws = room();
    await tick(25_000);
    expect(ws.pings()).toBe(1);
    await tick(9_000);
    expect(MockWebSocket.instances.length).toBe(1);
    expect(result.current.connected).toBe(true);
    await tick(1_000); // 10 s without a pong
    expect(result.current.connected).toBe(false);
    await tick(1_000);
    expect(MockWebSocket.instances.length).toBe(2);
  });

  it("hidden tabs don't ping; coming back visible pings at once", async () => {
    await boot([msg("m1", 1000)]);
    const ws = room();
    act(() => setVisibility("hidden"));
    await tick(120_000);
    expect(ws.pings()).toBe(0);
    expect(MockWebSocket.instances.length).toBe(1);
    act(() => setVisibility("visible"));
    expect(ws.pings()).toBe(1);
  });
});

describe("session probe", () => {
  it("a 401 storm stops after the probe and raises sessionEnded", async () => {
    setup();
    await tick();
    act(() => room().mockDrop());          // failed open 1
    await tick(1000);
    expect(S.sessionCalls).toBe(0);
    act(() => room().mockDrop());          // failed open 2 -> probe
    await tick();
    expect(S.sessionCalls).toBe(1);
    expect(hasSessionEnded()).toBe(true);
    const n = MockWebSocket.instances.length;
    await tick(120_000);
    expect(MockWebSocket.instances.length).toBe(n);
    expect(S.sessionCalls).toBe(1);
  });

  it("a probe that is NOT a 401 keeps reconnecting", async () => {
    S.session = { ok: false, error: { kind: "network" } };
    setup();
    await tick();
    act(() => room().mockDrop());
    await tick(1000);
    act(() => room().mockDrop());
    await tick();
    expect(S.sessionCalls).toBe(1);
    expect(hasSessionEnded()).toBe(false);
    await tick(2000);
    expect(MockWebSocket.instances.length).toBe(3);
  });
});

describe("catch-up failure and edge paths", () => {
  async function outage(hist: Array<Record<string, unknown>>) {
    const h = await boot(hist);
    act(() => room().mockDrop());
    return h;
  }
  const reopen = async () => { await tick(1000); act(() => room().mockOpen()); await tick(); };

  it("a failed catch-up fetch is retried with backoff and then merges once", async () => {
    const { result } = await outage([msg("m1", 1000)]);
    S.msgs.push(msg("p1", 2000));
    S.afterFail = 1;
    await reopen();
    expect(ids(result)).toEqual(["m1"]);
    await tick(1000);
    expect(S.afterCalls).toBe(2);
    expect(ids(result)).toEqual(["m1", "p1"]);
  });

  it("a 403 during catch-up reports the revocation instead of retrying", async () => {
    const { onRevoked } = await outage([msg("m1", 1000)]);
    S.afterFail = 1; S.afterKind = "forbidden";
    await reopen();
    await tick(20_000);
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(S.afterCalls).toBe(1);
  });

  it("gives up after the retry cap (the next reconnect tries again)", async () => {
    await outage([msg("m1", 1000)]);
    S.afterFail = 99;
    await reopen();
    await tick(60_000);
    expect(S.afterCalls).toBe(5); // first try + 4 retries
  });

  it("a failed newest-page fallback is retried too", async () => {
    const { result } = await outage([msg("m1", 1000)]);
    S.msgs = [msg("p1", 3000)]; // anchor gone
    S.latestFail = true;
    await reopen();
    S.latestFail = false;
    await tick(1000);
    expect(ids(result)).toEqual(["p1"]);
  });

  it("a lookup failure while reconciling an edit retries; the server text then wins", async () => {
    const { result } = await boot([msg("m1", 1000, { body: "hello" })]);
    act(() => { result.current.sendEdit(result.current.messages[0], "mine"); });
    act(() => room().mockDrop());
    S.aroundThrow = 1;
    await reopen();
    expect(result.current.messages[0].body).toBe("mine"); // not yet reconciled
    await tick(1000);
    expect(result.current.messages[0].body).toBe("hello");
  });

  it("an edited message that is no longer on the server falls back to the last confirmed text", async () => {
    const { result } = await boot([msg("m1", 1000, { body: "hello" }), msg("m2", 2000)]);
    act(() => { result.current.sendEdit(result.current.messages[0], "mine"); });
    act(() => room().mockDrop());
    S.msgs = [msg("m2", 2000), msg("p1", 3000)]; // m1 gone from the server
    await reopen();
    expect(result.current.messages.find((m) => m.id === "m1")?.body).toBe("hello");
    expect(ids(result)).toContain("p1");
  });

  it("an edit re-sent on the new socket is not clobbered by the catch-up", async () => {
    const { result } = await boot([msg("m1", 1000, { body: "hello" })]);
    act(() => { result.current.sendEdit(result.current.messages[0], "mine"); });
    act(() => room().mockDrop());
    act(() => { result.current.sendEdit(result.current.messages[0], "again"); }); // queued while offline
    await reopen();
    expect(result.current.messages[0].body).toBe("again");
  });

  it("a detached window is not extended by the catch-up", async () => {
    const { result } = await boot([msg("m1", 1000), msg("m2", 2000)]);
    S.aroundHasNewer = true;
    await act(async () => { await result.current.jumpToMessage("m1"); });
    act(() => room().mockDrop());
    await reopen();
    expect(S.afterCalls).toBe(0);
  });

  it("sessionEnded while connected stops the socket and any reconnect", async () => {
    const { result } = await boot([msg("m1", 1000)]);
    act(() => notifySessionEnded());
    expect(result.current.connected).toBe(false);
    await tick(60_000);
    expect(MockWebSocket.instances.length).toBe(1);
    act(() => window.dispatchEvent(new Event("online")));
    expect(MockWebSocket.instances.length).toBe(1);
  });
});
