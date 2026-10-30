/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import type { Conversation } from "./conversation";

// Offline-push decision inside the Conversation DO: who is skipped (only users with a
// NON-away socket + the sender), when the 30 s debounce is stamped (only when something
// is actually sent), and that the decision logs carry counts only. The outbound push
// fetch is stubbed — no real network.
const bindings = env as unknown as { CONVERSATION: DurableObjectNamespace<Conversation>; DB: D1Database };
const CONVERSATION = bindings.CONVERSATION;
const DB = bindings.DB;

const EP = (u: string) => `https://fcm.googleapis.com/fcm/send/${u}-secret-endpoint`;
let seq = 0;
let vapid: { VAPID_PUBLIC_KEY: string; VAPID_PRIVATE_JWK: string };
let fetchSpy: ReturnType<typeof vi.fn>;
let logSpy: ReturnType<typeof vi.spyOn>;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  await DB.exec("CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity INTEGER NOT NULL, last_message TEXT, last_sender_id TEXT, direct_key TEXT UNIQUE)");
  await DB.exec("CREATE TABLE IF NOT EXISTS chat_members (chat_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', unread_count INTEGER NOT NULL DEFAULT 0, last_read_at INTEGER, joined_at INTEGER NOT NULL, PRIMARY KEY (chat_id, user_id))");
  await DB.exec("CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, p256dh TEXT, auth TEXT, created_at INTEGER NOT NULL)");
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  vapid = {
    VAPID_PUBLIC_KEY: btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    VAPID_PRIVATE_JWK: JSON.stringify(jwk),
  };
});
beforeEach(async () => {
  await DB.exec("DELETE FROM push_subscriptions"); // a user's subscriptions span chats; isolate per test
  fetchSpy = vi.fn(async () => new Response(null, { status: 201 }));
  vi.stubGlobal("fetch", fetchSpy);
  logSpy = vi.spyOn(console, "log");
});
afterEach(() => {
  vi.unstubAllGlobals();
  logSpy.mockRestore();
  for (const ws of sockets.splice(0)) { try { ws.close(); } catch { /* already closed */ } }
});

function newChat(): string { return `push-${++seq}-${Math.random().toString(36).slice(2, 8)}`; }
async function seed(chatId: string, users: string[], subscribed: string[]): Promise<void> {
  await DB.prepare("INSERT OR IGNORE INTO chats (id, type, created_by, created_at, last_activity) VALUES (?, 'direct', 'sender', 0, 0)").bind(chatId).run();
  for (const u of users) {
    await DB.prepare("INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, unread_count, joined_at) VALUES (?, ?, 'member', 0, 0)").bind(chatId, u).run();
  }
  for (const u of subscribed) {
    await DB.prepare("INSERT OR REPLACE INTO push_subscriptions (endpoint, user_id, created_at) VALUES (?, ?, 1)").bind(EP(`${chatId}-${u}`), u).run();
  }
}
function stub(chatId: string): DurableObjectStub<Conversation> { return CONVERSATION.get(CONVERSATION.idFromName(chatId)); }
async function configureVapid(chatId: string): Promise<void> {
  await runInDurableObject(stub(chatId), async (inst: Conversation) => {
    Object.assign(inst.env as unknown as Record<string, string>, vapid);
  });
}
async function connect(chatId: string, userId: string): Promise<WebSocket> {
  const res = await stub(chatId).fetch(`https://do/ws?user=${userId}&chat=${chatId}`, { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket;
  if (!ws) throw new Error("no webSocket");
  ws.accept();
  sockets.push(ws);
  return ws;
}
function waitFor(ws: WebSocket, pred: (t: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for frame")), 3000);
    ws.addEventListener("message", (e: MessageEvent) => {
      const t = String(e.data);
      if (pred(t)) { clearTimeout(timer); resolve(t); }
    });
  });
}
/** Make `userId` have an AWAY socket; resolves once the DO has applied it. */
async function connectAway(chatId: string, userId: string, observer: WebSocket): Promise<WebSocket> {
  const ws = await connect(chatId, userId);
  const seen = waitFor(observer, (t) => t.includes('"presence"') && t.includes(userId) && t.includes('"away":true'));
  ws.send(JSON.stringify({ type: "away", away: true }));
  await seen;
  return ws;
}
/** Sender posts a message; resolves once the DO made its push decision (logged). */
async function send(sender: WebSocket, body: string): Promise<void> {
  const before = decisionLogs().length;
  sender.send(JSON.stringify({ type: "send", tempId: `t${++seq}`, body }));
  await vi.waitFor(() => expect(decisionLogs().length).toBeGreaterThan(before), { timeout: 3000 });
}
const decisionLogs = (): string[] => logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("push_decision"));
const pushCalls = () => fetchSpy.mock.calls.filter((c) => String(c[0]).startsWith("https://fcm.googleapis.com/"));
const pushedTo = (): string[] => pushCalls().map((c) => String(c[0]));

describe("Conversation offline push decision", () => {
  it("(a) recipient with only an AWAY socket in the room is pushed", async () => {
    const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
    const sender = await connect(c, "sender");
    await connectAway(c, "rcpt", sender);
    await send(sender, "hi");
    await vi.waitFor(() => expect(pushedTo()).toEqual([EP(`${c}-rcpt`)]));
    expect(decisionLogs()).toEqual(["push_decision targets=1 active_excluded=0"]);
  });

  it("(b) recipient with a VISIBLE socket is not pushed", async () => {
    const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
    const sender = await connect(c, "sender");
    await connect(c, "rcpt"); // never reported → treated as visible (default)
    await send(sender, "hi");
    expect(decisionLogs()).toEqual(["push_decision targets=0 active_excluded=1"]);
    expect(pushCalls()).toHaveLength(0);
  });

  it("(b2) a user with one away and one visible socket counts as active → no push", async () => {
    const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
    const sender = await connect(c, "sender");
    await connectAway(c, "rcpt", sender);
    await connect(c, "rcpt");
    await send(sender, "hi");
    expect(decisionLogs()).toEqual(["push_decision targets=0 active_excluded=1"]);
    expect(pushCalls()).toHaveLength(0);
  });

  it("(c) recipient with no socket is pushed", async () => {
    const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
    const sender = await connect(c, "sender");
    await send(sender, "hi");
    await vi.waitFor(() => expect(pushedTo()).toEqual([EP(`${c}-rcpt`)]));
  });

  it("(d) the sender is never pushed, even when subscribed and away", async () => {
    const c = newChat(); await seed(c, ["sender", "rcpt"], ["sender", "rcpt"]); await configureVapid(c);
    const sender = await connect(c, "sender");
    sender.send(JSON.stringify({ type: "away", away: true }));
    await send(sender, "hi");
    await vi.waitFor(() => expect(pushCalls()).toHaveLength(1));
    expect(pushedTo()).toEqual([EP(`${c}-rcpt`)]);
  });

  it("(e) no targets does not stamp the debounce: a second message right after the recipient goes away is pushed", async () => {
    const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
    const sender = await connect(c, "sender");
    const rcpt = await connect(c, "rcpt"); // visible
    await send(sender, "first");
    expect(pushCalls()).toHaveLength(0);
    const away = waitFor(sender, (t) => t.includes('"presence"') && t.includes('"away":true'));
    rcpt.send(JSON.stringify({ type: "away", away: true }));
    await away;
    await send(sender, "second");
    await vi.waitFor(() => expect(pushedTo()).toEqual([EP(`${c}-rcpt`)]));
    expect(decisionLogs()).toEqual(["push_decision targets=0 active_excluded=1", "push_decision targets=1 active_excluded=0"]);
  });

  it("(f) with targets, the debounce still coalesces a burst", async () => {
    const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
    const sender = await connect(c, "sender");
    await send(sender, "one");
    await vi.waitFor(() => expect(pushCalls()).toHaveLength(1));
    await send(sender, "two");
    await send(sender, "three");
    expect(pushCalls()).toHaveLength(1);
    expect(decisionLogs()).toEqual(["push_decision targets=1 active_excluded=0", "push_decision skipped=debounce", "push_decision skipped=debounce"]);
  });

  it("(g) decision/delivery logs contain only counts, never ids or endpoints", async () => {
    const c = newChat(); await seed(c, ["sender", "rcpt", "watcher"], ["rcpt", "watcher"]); await configureVapid(c);
    const sender = await connect(c, "sender");
    await connect(c, "watcher");
    await send(sender, "hi");
    await vi.waitFor(() => expect(pushCalls()).toHaveLength(1));
    await vi.waitFor(() => expect(logSpy.mock.calls.some((x) => String(x[0]).startsWith("push_delivery"))).toBe(true));
    const lines = logSpy.mock.calls.map((x) => String(x[0])).filter((l) => l.startsWith("push_"));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) {
      for (const secret of [c, "sender", "rcpt", "watcher", "secret-endpoint", "https://"]) expect(l).not.toContain(secret);
    }
    expect(decisionLogs()).toEqual(["push_decision targets=1 active_excluded=1"]);
  });
});
