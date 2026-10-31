/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import type { Conversation } from "./conversation";
import { MAX_PUSH_SUBS_PER_USER } from "./push";

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

/** Typed access to the DO internals the tests poke (they are `protected`/`private` in
 *  production; the production types stay as they are). */
interface DoInternals {
  env: Record<string, unknown>;
  ctx: DurableObjectState;
  internalBudget: number;
  alarm(): Promise<void>;
  lastPush: Map<string, number>;
}
const internals = (inst: Conversation): DoInternals => inst as unknown as DoInternals;

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
afterEach(async () => {
  // Real-clock tests can leave a queued retry + a real alarm armed; it would fire in a later
  // fake-clock test (clock far from real time -> retry never due -> ceiling-drop log noise).
  // Disarm every chat this test created.
  for (const c of createdChats.splice(0)) {
    await runInDurableObject(stub(c), async (inst: Conversation) => {
      await internals(inst).ctx.storage.deleteAlarm();
      await internals(inst).ctx.storage.delete("fanout_overflow");
    });
  }
  vi.unstubAllGlobals();
  logSpy.mockRestore();
  for (const ws of sockets.splice(0)) { try { ws.close(); } catch { /* already closed */ } }
});

const createdChats: string[] = [];
function newChat(): string { const c = `push-${++seq}-${Math.random().toString(36).slice(2, 8)}`; createdChats.push(c); return c; }
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
    Object.assign(internals(inst).env as Record<string, string>, vapid);
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
const allDecisionLogs = (): string[] => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith("push_decision"));
/** The decision lines; per-invocation outcome summaries are asserted separately. */
const decisionLogs = (): string[] => allDecisionLogs().filter((l) => !l.startsWith("push_decision outcome"));
const outcomeLogs = (): string[] => allDecisionLogs().filter((l) => l.startsWith("push_decision outcome"));
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
    await vi.waitFor(() => expect(logSpy.mock.calls.some((x: unknown[]) => String(x[0]).startsWith("push_delivery"))).toBe(true));
    const lines = logSpy.mock.calls.map((x: unknown[]) => String(x[0])).filter((l: string) => l.startsWith("push_"));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) {
      for (const secret of [c, "sender", "rcpt", "watcher", "secret-endpoint", "https://"]) expect(l).not.toContain(secret);
    }
    expect(decisionLogs()).toEqual(["push_decision targets=1 active_excluded=1"]);
  });

  it("(h) burst: N concurrent messages push each recipient exactly once (window reserved before any await)", async () => {
    const c = newChat(); await seed(c, ["sender", "rcpt", "rcpt2"], ["rcpt", "rcpt2"]); await configureVapid(c);
    const sender = await connect(c, "sender");
    const N = 6;
    // Slow push service: later messages' decisions run while earlier sends are in flight.
    fetchSpy.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 100)); return new Response(null, { status: 201 }); });
    for (let i = 0; i < N; i++) sender.send(JSON.stringify({ type: "send", tempId: `b${++seq}`, body: `m${i}` }));
    await vi.waitFor(() => expect(decisionLogs()).toHaveLength(N), { timeout: 5000 });
    await vi.waitFor(() => expect(pushCalls()).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(pushedTo().sort()).toEqual([EP(`${c}-rcpt`), EP(`${c}-rcpt2`)]);
  });

  it("(i) DM: pushed at t0, recipient opens the chat then backgrounds, new message at t15 is pushed again; without opening it stays debounced", async () => {
    let t = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => t);
    try {
      const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
      const sender = await connect(c, "sender");
      await send(sender, "one");
      await vi.waitFor(() => expect(pushCalls()).toHaveLength(1));
      t += 5_000;
      await send(sender, "two (rcpt never looked)");
      expect(pushCalls()).toHaveLength(1);
      await connectAway(c, "rcpt", sender); // opened the chat (fresh socket), then backgrounded
      t += 10_000; // t15
      await send(sender, "three");
      await vi.waitFor(() => expect(pushCalls()).toHaveLength(2));
    } finally { nowSpy.mockRestore(); }
  });

  it("(j) group: pushing Carol does not silence Dave (per-recipient window)", async () => {
    const c = newChat(); await seed(c, ["sender", "carol", "dave"], ["carol", "dave"]); await configureVapid(c);
    const sender = await connect(c, "sender");
    const dave = await connect(c, "dave"); // active → excluded from the first push
    await send(sender, "one");
    await vi.waitFor(() => expect(pushedTo()).toEqual([EP(`${c}-carol`)]));
    const away = waitFor(sender, (t) => t.includes('"presence"') && t.includes('"away":true'));
    dave.send(JSON.stringify({ type: "away", away: true }));
    await away;
    await send(sender, "two"); // within 30 s: Carol debounced, Dave pushed
    await vi.waitFor(() => expect(pushedTo()).toEqual([EP(`${c}-carol`), EP(`${c}-dave`)]));
  });

  it("(l) a removed member's inbox gets no preview right after dropUser (member cache cleared)", async () => {
    const c = newChat(); await seed(c, ["sender", "bob", "carol"], []);
    const hits: string[] = [];
    await runInDurableObject(stub(c), async (inst: Conversation) => {
      (internals(inst).env).USER_INBOX = {
        idFromName: (n: string) => n,
        get: (n: string) => ({ fetch: async () => { hits.push(n); return new Response(null, { status: 204 }); } }),
      };
    });
    const sender = await connect(c, "sender");
    await send(sender, "one");
    await vi.waitFor(() => expect(hits).toContain("inbox:carol"));
    // Remove carol (D1 + the REST handler's dropUser), then send immediately (< 5 s).
    await DB.prepare("DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?").bind(c, "carol").run();
    await stub(c).dropUser("carol", true);
    hits.length = 0;
    await send(sender, "two");
    await vi.waitFor(() => expect(hits).toContain("inbox:bob"));
    await new Promise((r) => setTimeout(r, 50));
    expect(hits).not.toContain("inbox:carol");
  });

  /** Send `n` messages at fake times and let the outcome handling settle. */
  async function timeline(status: number, check: (c: string, sender: WebSocket, at: (ms: number) => void) => Promise<void>): Promise<string> {
    let t = 2_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => t);
    fetchSpy.mockImplementation(async () => new Response(null, { status }));
    try {
      const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
      const sender = await connect(c, "sender");
      await check(c, sender, (ms) => { t = 2_000_000 + ms; });
      return c;
    } finally { nowSpy.mockRestore(); }
  }
  const settle = () => new Promise((r) => setTimeout(r, 40));

  for (const status of [503, 429, 0]) {
    it(`(m) transient ${status}: not retried within ~10 s of the failure's window start, retried after (partial backoff)`, async () => {
      await timeline(status, async (c, sender, at) => {
        if (status === 0) fetchSpy.mockImplementation(async () => { throw new Error("net"); });
        await send(sender, "one"); await settle();
        expect(pushCalls()).toHaveLength(1);
        at(5_000); await send(sender, "two"); await settle();
        expect(pushCalls()).toHaveLength(1); // 25 s into the shortened window: still held
        at(11_000); await send(sender, "three");
        await vi.waitFor(() => expect(pushCalls()).toHaveLength(2)); // eligible 10 s after the failure
      });
    });
  }

  it("(n) 403 prunes the endpoint (logged) and never retries it", async () => {
    await timeline(403, async (c, sender, at) => {
      await send(sender, "one");
      await vi.waitFor(() => expect(logSpy.mock.calls.some((x: unknown[]) => String(x[0]) === "push_delivery status=403 service=fcm pruned=1")).toBe(true));
      await settle();
      const row = await DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?").bind(EP(`${c}-rcpt`)).first<{ n: number }>();
      expect(row!.n).toBe(0);
      at(40_000); await send(sender, "two"); await settle();
      expect(pushCalls()).toHaveLength(1);
    });
  });

  it("(o) another 4xx keeps the full window (no retry storm) and does not prune", async () => {
    await timeline(400, async (c, sender, at) => {
      await send(sender, "one"); await settle();
      at(11_000); await send(sender, "two"); await settle();
      expect(pushCalls()).toHaveLength(1);
      const row = await DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?").bind(EP(`${c}-rcpt`)).first<{ n: number }>();
      expect(row!.n).toBe(1);
    });
  });

  it("(q) a member read that overlaps a removal is discarded and re-read: the removed member's inbox gets nothing", async () => {
    const c = newChat(); await seed(c, ["sender", "bob", "carol"], []);
    const hits: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let readStarted = false;
    let gated = false;
    await runInDurableObject(stub(c), async (inst: Conversation) => {
      const env2 = internals(inst).env;
      env2.USER_INBOX = {
        idFromName: (n: string) => n,
        get: (n: string) => ({ fetch: async () => { hits.push(n); return new Response(null, { status: 204 }); } }),
      };
      const real = DB;
      env2.DB = new Proxy(real, {
        get(target, prop) {
          if (prop !== "prepare") return Reflect.get(target, prop).bind?.(target) ?? Reflect.get(target, prop);
          return (sql: string) => {
            const st = target.prepare(sql);
            if (gated || !sql.startsWith("SELECT user_id FROM chat_members")) return st;
            gated = true;
            return { bind: (...a: unknown[]) => ({ all: async () => { const r = await st.bind(...a).all(); readStarted = true; await gate; return r; } }) };
          };
        },
      });
    });
    const sender = await connect(c, "sender");
    sender.send(JSON.stringify({ type: "send", tempId: `t${++seq}`, body: "x" }));
    await vi.waitFor(() => expect(readStarted).toBe(true));
    await DB.prepare("DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?").bind(c, "carol").run();
    await stub(c).dropUser("carol", true);
    release();
    await vi.waitFor(() => expect(hits).toContain("inbox:bob"));
    await settle();
    expect(hits).not.toContain("inbox:carol");
  });

  // ---- per-message cost metering + the follow-up (alarm) fan-out ----------------------
  interface Meter { d1: string[]; inbox: string[]; bodies: string[]; alarms: number; release: () => void; holdInvalidations: Promise<void> | null }
  /** `hold`: alarm invocations (the runtime fires them by itself) wait until
   *  `release()`, so the queued state can be inspected first. */
  async function meter(c: string, hold = false): Promise<Meter> {
    let held = hold;
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const m: Meter = { d1: [], inbox: [], bodies: [], alarms: 0, holdInvalidations: null, release: () => { held = false; open(); } };
    await runInDurableObject(stub(c), async (inst: Conversation) => {
      const e = internals(inst).env;
      e.USER_INBOX = {
        idFromName: (n: string) => n,
        get: (n: string) => ({ fetch: async (_u: string, init?: RequestInit) => { const b = String(init?.body ?? ""); if (m.holdInvalidations && b.includes("invalidate")) await m.holdInvalidations; m.inbox.push(n); m.bodies.push(b); return new Response(null, { status: 204 }); } }),
      };
      e.DB = new Proxy(DB, {
        get(t, prop) {
          if (prop === "prepare") return (sql: string) => { m.d1.push(sql); return t.prepare(sql); };
          const v = Reflect.get(t, prop);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      const orig = internals(inst).alarm.bind(inst);
      internals(inst).alarm = async () => { m.alarms++; if (held) await gate; return orig(); };
    });
    return m;
  }
  /** Let every (auto-fired or manual) follow-up run until nothing is queued. */
  const drainAlarms = async (c: string) => {
    for (let n = 0; n < 40; n++) {
      if (!(await queued(c))) return;
      await runDurableObjectAlarm(stub(c));
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  interface Queued { push: string[]; inbox: string[]; attempts?: Record<string, number>; notBefore?: Record<string, number>; rounds?: number; total?: number; ceiling?: number }
  const queued = (c: string) => runInDurableObject(stub(c), async (inst: Conversation) => internals(inst).ctx.storage.get<Queued>("fanout_overflow"));
  const SECRET = "SECRET-BODY-xyz";
  /** Test-only: lower the per-invocation internal (DO fetch) budget of one room. */
  const setInternal = (c: string, n: number) => runInDurableObject(stub(c), async (inst: Conversation) => { internals(inst).internalBudget = n; });

  it("(k) 61 push targets: 42 pushed inline (external budget), the rest by ONE alarm round; every target pushed exactly once; all 62 members get inline previews; no text persisted; queue gone", async () => {
    const users = Array.from({ length: 61 }, (_, i) => `u${i}`);
    const c = newChat(); await seed(c, ["sender", ...users], users); await configureVapid(c);
    const m = await meter(c, true);
    const importSpy = vi.spyOn(crypto.subtle, "importKey");
    const sender = await connect(c, "sender");
    await send(sender, SECRET);
    await vi.waitFor(async () => expect(await queued(c)).toBeTruthy());
    const q = (await queued(c))!;
    expect(q.push.length + pushCalls().length).toBe(61); // nothing lost, nothing double-booked
    expect(q.inbox).toHaveLength(0); // inbox is on its own (internal) budget: every member got a preview inline
    expect(m.inbox).toHaveLength(62);
    // the first invocation stays within the EXTERNAL budget: D1 + pushes (inbox DO fetches are internal)
    expect(m.d1.length + pushCalls().length).toBeLessThanOrEqual(45);
    expect(pushCalls()).toHaveLength(42);
    expect(q.push).toHaveLength(19);
    // no message text anywhere in DO key-value storage
    const dump = await runInDurableObject(stub(c), async (inst: Conversation) => JSON.stringify([...(await internals(inst).ctx.storage.list()).entries()]));
    expect(dump).not.toContain(SECRET);
    const d1First = m.d1.length;
    m.release();
    await drainAlarms(c);
    await vi.waitFor(() => expect(pushCalls()).toHaveLength(61));
    expect(new Set(pushedTo()).size).toBe(61); // exactly once each
    expect(await queued(c)).toBeUndefined(); // short-lived: the key is gone
    expect(m.bodies.filter((b) => b.includes("invalidate"))).toHaveLength(0);
    expect(m.inbox).toHaveLength(62); // the alarm sent no further inbox traffic
    expect(m.d1.length - d1First).toBe(1); // alarm round: ONE target read
    expect(m.alarms).toBeGreaterThanOrEqual(1);
    expect(importSpy.mock.calls.filter((a: unknown[]) => a[0] === "jwk").length).toBeLessThanOrEqual(1 + m.alarms);
    importSpy.mockRestore();
    console.info(`COST 61-push-target room: d1=${m.d1.length} inbox_fetches=${m.inbox.length} pushes=${pushCalls().length} alarms=${m.alarms}`);
  });

  it("(p) inbox beyond the INTERNAL budget (lowered to 30 for the test): 30 previews inline, the other 10 members get content-free invalidations from the alarm; pushes unaffected", async () => {
    const users = Array.from({ length: 39 }, (_, i) => `u${i}`);
    const c = newChat(); await seed(c, ["sender", ...users], users.slice(0, 20)); await configureVapid(c);
    await setInternal(c, 30);
    const m = await meter(c, true);
    const sender = await connect(c, "sender");
    await send(sender, "one");
    await vi.waitFor(() => expect(pushCalls()).toHaveLength(20)); // all pushed in the first invocation
    await vi.waitFor(async () => expect((await queued(c))?.inbox).toHaveLength(10));
    expect(m.inbox).toHaveLength(30);
    m.release();
    await drainAlarms(c);
    expect(m.inbox).toHaveLength(40);
    const inv = m.bodies.filter((b) => b.includes("invalidate"));
    expect(inv).toHaveLength(10);
    for (const b of inv) expect(JSON.parse(b)).toEqual({ chatId: c, invalidate: true });
    expect(new Set(m.inbox).size).toBe(40);
    expect(pushCalls()).toHaveLength(20);
    expect(await queued(c)).toBeUndefined();
  });

  it("(t) lost update: a message queued while a follow-up is mid-run keeps its recipients (and its reset allowance)", async () => {
    const users = Array.from({ length: 39 }, (_, i) => `u${i}`);
    const c = newChat(); await seed(c, ["sender", ...users], []); await configureVapid(c);
    await setInternal(c, 30);
    const m = await meter(c, true);
    const sender = await connect(c, "sender");
    await send(sender, "one"); // 30 previews inline, the last 10 members queued
    await vi.waitFor(async () => expect((await queued(c))?.inbox).toHaveLength(10));
    const first10 = (await queued(c))!.inbox;
    // the follow-up will block inside its invalidation fetches
    let open!: () => void;
    m.holdInvalidations = new Promise<void>((r) => { open = r; });
    m.release();
    await vi.waitFor(() => expect(m.alarms).toBeGreaterThanOrEqual(1));
    await new Promise((r) => setTimeout(r, 30)); // alarm is now parked in the gated fetches
    await setInternal(c, 20); // message two leaves a different (larger) tail: members 20..39
    await send(sender, "two");
    await vi.waitFor(async () => expect((await queued(c))?.inbox.length).toBeGreaterThan(10));
    const added = (await queued(c))!.inbox.filter((u) => !first10.includes(u));
    expect(added.length).toBeGreaterThan(0);
    m.holdInvalidations = null;
    open();
    await drainAlarms(c);
    expect(await queued(c)).toBeUndefined();
    const gotInvalidation = new Set(m.inbox.filter((_, i) => m.bodies[i]!.includes("invalidate")));
    for (const u of added) expect(gotInvalidation.has(`inbox:${u}`)).toBe(true); // second message's recipients were served
  });

  it("(u) an overflow alarm still runs the soft-delete purge and re-arms it at oldest + 24h + 60 s", async () => {
    const users = Array.from({ length: 39 }, (_, i) => `u${i}`);
    const c = newChat(); await seed(c, ["sender", ...users], []); await configureVapid(c);
    await setInternal(c, 30);
    const m = await meter(c, true);
    const sender = await connect(c, "sender");
    await send(sender, "one");
    await vi.waitFor(async () => expect((await queued(c))?.inbox).toHaveLength(10));
    const T0 = Date.now() - 1000;
    await runInDurableObject(stub(c), async (inst: Conversation) => {
      const sql = internals(inst).ctx.storage.sql;
      sql.exec("INSERT INTO messages (id, sender_id, body, created_at, is_deleted, deleted_at) VALUES ('old', 'x', '', 1, 1, ?)", Date.now() - 25 * 3600_000);
      sql.exec("INSERT INTO messages (id, sender_id, body, created_at, is_deleted, deleted_at) VALUES ('new', 'x', '', 2, 1, ?)", T0);
    });
    m.release();
    await drainAlarms(c);
    const state = await runInDurableObject(stub(c), async (inst: Conversation) => ({
      ids: internals(inst).ctx.storage.sql.exec("SELECT id FROM messages WHERE id IN ('old','new')").toArray().map((r) => String(r.id)),
      alarm: await internals(inst).ctx.storage.getAlarm(),
    }));
    expect(state.ids).toEqual(["new"]); // expired row purged by the same alarm
    expect(await queued(c)).toBeUndefined();
    expect(state.alarm).not.toBeNull();
    expect(Math.abs(state.alarm! - (T0 + 24 * 3600_000 + 60_000))).toBeLessThan(2000);
  });

  it("(v) deleting a message while fan-out work is queued does not postpone the fan-out alarm", async () => {
    const c = newChat(); await seed(c, ["sender", "rcpt"], []); await configureVapid(c);
    const sender = await connect(c, "sender");
    const sentFrame = waitFor(sender, (t) => t.includes('"sent"'));
    sender.send(JSON.stringify({ type: "send", tempId: "tdel", body: "x" }));
    const id = (JSON.parse(await sentFrame) as { message: { id: string } }).message.id;
    const soon = Date.now() + 60_000;
    await runInDurableObject(stub(c), async (inst: Conversation) => {
      await internals(inst).ctx.storage.put("fanout_overflow", { chatId: c, push: [], inbox: ["rcpt"], rounds: 0, seq: 1 });
      await internals(inst).ctx.storage.setAlarm(soon);
    });
    const deleted = waitFor(sender, (t) => t.includes('"deleted"'));
    sender.send(JSON.stringify({ type: "delete", id }));
    await deleted;
    await new Promise((r) => setTimeout(r, 30));
    const alarm = await runInDurableObject(stub(c), async (inst: Conversation) => internals(inst).ctx.storage.getAlarm());
    expect(alarm).toBe(soon);
    await runInDurableObject(stub(c), async (inst: Conversation) => { await internals(inst).ctx.storage.deleteAlarm(); await internals(inst).ctx.storage.delete("fanout_overflow"); });
  });

  it("(w) a follow-up that throws re-queues with rounds+1 (not orphaned) and is bounded: dropped after the max rounds, logged with counts only, key gone", async () => {
    const users = Array.from({ length: 39 }, (_, i) => `u${i}`);
    const c = newChat(); await seed(c, ["sender", ...users], []); await configureVapid(c);
    await setInternal(c, 30);
    const m = await meter(c, true);
    const sender = await connect(c, "sender");
    await send(sender, "one");
    await vi.waitFor(async () => expect((await queued(c))?.inbox).toHaveLength(10));
    // every D1 call from now on fails
    await runInDurableObject(stub(c), async (inst: Conversation) => {
      (internals(inst).env).DB = { prepare: () => { throw new Error("d1 down"); } };
    });
    m.release();
    // the failed run backs off 10 s (re-armed at now+10s, never immediately)
    await vi.waitFor(() => expect(allDecisionLogs().filter((l) => l.startsWith("push_decision overflow_error"))).toHaveLength(1));
    const alarmAt = await vi.waitFor(async () => {
      const a = await runInDurableObject(stub(c), async (inst: Conversation) => internals(inst).ctx.storage.getAlarm());
      expect(a).not.toBeNull();
      return a!;
    });
    expect(alarmAt - Date.now()).toBeGreaterThan(8_000);
    await drainAlarms(c);
    expect(allDecisionLogs()).toContain("push_decision overflow_dropped push=0 inbox=10");
    expect(allDecisionLogs().filter((l) => l.startsWith("push_decision overflow_error")).length).toBe(5);
    expect(await queued(c)).toBeUndefined();
  });

  it("(x) a busy group is served to the end: 300 push targets -> everyone pushed exactly once over progress rounds, queue key gone", async () => {
    const users = Array.from({ length: 300 }, (_, i) => `u${i}`);
    const c = newChat(); await seed(c, ["sender", ...users], users); await configureVapid(c);
    const m = await meter(c);
    const sender = await connect(c, "sender");
    await send(sender, "one");
    await vi.waitFor(() => expect(pushCalls()).toHaveLength(300), { timeout: 15000 });
    await vi.waitFor(async () => expect(await queued(c)).toBeUndefined(), { timeout: 5000 });
    expect(new Set(pushedTo()).size).toBe(300); // exactly once each
    expect(allDecisionLogs().some((l) => l.startsWith("push_decision overflow_dropped"))).toBe(false);
    // each round is bounded by the external budget: 42 inline, then <= 44 per alarm round
    expect(m.alarms).toBeGreaterThanOrEqual(6);
    console.info(`COST 300-push-target room: d1=${m.d1.length} inbox_fetches=${m.inbox.length} pushes=${pushCalls().length} alarms=${m.alarms}`);
  });

  /** Alarm control for tests that must not race the runtime's own alarm firing: the
   *  auto-fired alarm is ALWAYS a no-op (a toggle could let a runtime-fired alarm overlap
   *  a manual one), `runAlarm` calls the real handler directly. */
  async function manualAlarms(c: string): Promise<() => Promise<void>> {
    let orig!: () => Promise<void>;
    await runInDurableObject(stub(c), async (inst: Conversation) => {
      orig = internals(inst).alarm.bind(inst);
      internals(inst).alarm = async () => {};
    });
    // Run the real handler directly (runDurableObjectAlarm only fires a scheduled alarm).
    return async () => { await runInDurableObject(stub(c), async () => { await orig(); }); };
  }
  const withFakeTime = async (start: number, body: (at: (ms: number) => void) => Promise<void>) => {
    let t = start;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => t);
    try { await body((ms) => { t = start + ms; }); } finally { nowSpy.mockRestore(); }
  };

  it("(af) no-progress bound: a push round that keeps failing is retried MAX_FOLLOWUPS (5) times, then dropped and logged; key gone", async () => {
    const users = Array.from({ length: 61 }, (_, i) => `u${i}`);
    const c = newChat(); await seed(c, ["sender", ...users], users); await configureVapid(c);
    const runAlarm = await manualAlarms(c);
    const sender = await connect(c, "sender");
    await send(sender, "one");
    await vi.waitFor(async () => expect((await queued(c))?.push).toHaveLength(19));
    const sentInline = pushCalls().length;
    // every push round now throws (the target read fails)
    // NB: a DO's `env` is shared across the isolate, so the binding MUST be restored.
    const setDb = (db: unknown) => runInDurableObject(stub(c), async (inst: Conversation) => { internals(inst).env.DB = db; });
    await setDb({ prepare: (sql: string) => { if (sql.includes("push_subscriptions")) throw new Error("d1 down"); return DB.prepare(sql); } });
    try {
      for (let i = 0; i < 7 && (await queued(c)); i++) await runAlarm();
    } finally { await setDb(DB); }
    expect(allDecisionLogs().filter((l) => l.startsWith("push_decision overflow_error"))).toHaveLength(5);
    expect(allDecisionLogs()).toContain("push_decision overflow_dropped push=19 inbox=0");
    expect(await queued(c)).toBeUndefined();
    expect(pushCalls()).toHaveLength(sentInline); // nothing was sent by the failing rounds
    // every failing push round and the final drop still log their one outcome line
    expect(outcomeLogs().filter((l) => l.includes("attempted=0 ") && l.includes("deferred=19"))).toHaveLength(5);
    expect(outcomeLogs().filter((l) => l.includes("dropped=19"))).toHaveLength(1);
  });

  it("(ag) transient 503 then 201: retried once after >= 10 s, delivered exactly once, queue key gone", async () => {
    await withFakeTime(3_000_000, async (at) => {
      let n = 0;
      fetchSpy.mockImplementation(async () => new Response(null, { status: ++n === 1 ? 503 : 201 }));
      const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
      const runAlarm = await manualAlarms(c);
      const sender = await connect(c, "sender");
      await send(sender, "one");
      await vi.waitFor(async () => expect(await queued(c)).toBeTruthy());
      const q = (await queued(c))!;
      expect(q.push).toEqual(["rcpt"]);
      expect(q.attempts).toEqual({ rcpt: 1 });
      expect(q.notBefore).toEqual({ rcpt: 3_000_000 + 10_000 });
      expect(pushCalls()).toHaveLength(1);
      at(5_000); await runAlarm(); // too early: nothing is attempted, still queued
      expect(pushCalls()).toHaveLength(1);
      expect(await queued(c)).toBeTruthy();
      expect(outcomeLogs().at(-1)).toMatch(/attempted=0 .*suppressed_active=n\/a/); // one line even when nothing was attempted
      at(10_000); await runAlarm();
      expect(pushCalls()).toHaveLength(2);
      expect(await queued(c)).toBeUndefined();
      expect(outcomeLogs().at(-1)).toContain("accepted=1");
      expect(outcomeLogs().at(-1)).toMatch(/suppressed_active=\d+/); // measured by the exclusion query, never a false 0
      at(60_000); await runAlarm();
      expect(pushCalls()).toHaveLength(2); // delivered once
    });
  });

  it("(ah) transient 503 on every attempt: exactly 3 attempts, then dropped and logged (counts only), key gone", async () => {
    await withFakeTime(4_000_000, async (at) => {
      fetchSpy.mockImplementation(async () => new Response(null, { status: 503 }));
      const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
      const runAlarm = await manualAlarms(c);
      const sender = await connect(c, "sender");
      await send(sender, "one");
      await vi.waitFor(async () => expect(await queued(c)).toBeTruthy());
      at(10_000); await runAlarm();
      expect(pushCalls()).toHaveLength(2);
      expect((await queued(c))?.attempts).toEqual({ rcpt: 2 });
      at(20_000); await runAlarm();
      expect(pushCalls()).toHaveLength(3);
      expect(await queued(c)).toBeUndefined();
      expect(outcomeLogs().at(-1)).toContain("dropped=1");
      at(40_000); await runAlarm(); at(60_000); await runAlarm();
      expect(pushCalls()).toHaveLength(3); // never a 4th
      for (const l of allDecisionLogs()) for (const secret of [c, "rcpt", "https://"]) expect(l).not.toContain(secret);
    });
  });

  it("(ai) a permanent 4xx (400) is never retried or queued", async () => {
    await withFakeTime(5_000_000, async (at) => {
      fetchSpy.mockImplementation(async () => new Response(null, { status: 400 }));
      const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
      const runAlarm = await manualAlarms(c);
      const sender = await connect(c, "sender");
      await send(sender, "one"); await settle();
      expect(await queued(c)).toBeUndefined();
      at(30_000); await runAlarm();
      expect(pushCalls()).toHaveLength(1);
    });
  });

  it("(aa) no push fetch starts before the D1 mirror write resolves (the SW reads /api/chats)", async () => {
    const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await runInDurableObject(stub(c), async (inst: Conversation) => {
      internals(inst).env.DB = new Proxy(DB, {
        get(t, prop) {
          if (prop !== "prepare") { const v = Reflect.get(t, prop); return typeof v === "function" ? v.bind(t) : v; }
          return (sql: string) => {
            const st = t.prepare(sql);
            if (!sql.startsWith("UPDATE chats SET last_message")) return st;
            return {
              bind: (...a: unknown[]) => new Proxy(st.bind(...a), {
                get(b, p) {
                  const v = Reflect.get(b, p);
                  return typeof v === "function" ? async (...x: unknown[]) => { await gate; return v.apply(b, x); } : v;
                },
              }),
            };
          };
        },
      });
    });
    const sender = await connect(c, "sender");
    await send(sender, "hi"); // the push decision (targets=1) is made...
    await settle(); await settle();
    expect(decisionLogs()).toEqual(["push_decision targets=1 active_excluded=0"]);
    expect(pushCalls()).toHaveLength(0); // ...but nothing is sent while the mirror write is pending
    release();
    await vi.waitFor(() => expect(pushedTo()).toEqual([EP(`${c}-rcpt`)]));
    await runInDurableObject(stub(c), async (inst: Conversation) => { internals(inst).env.DB = DB; }); // env is shared: restore
  });

  it("(ab) if fanPush throws after reserving, the debounce reservation is released so the next message still pushes", async () => {
    const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
    const sender = await connect(c, "sender");
    const real = logSpy.getMockImplementation();
    logSpy.mockImplementation((...a: unknown[]) => { if (String(a[0]).startsWith("push_delivery")) throw new Error("log sink down"); return real?.(...a); });
    await send(sender, "one");
    await vi.waitFor(() => expect(pushCalls()).toHaveLength(1));
    await settle();
    logSpy.mockImplementation((...a: unknown[]) => real?.(...a));
    await send(sender, "two"); // inside the 30 s window: only pushed because the reservation was released
    await vi.waitFor(() => expect(pushCalls()).toHaveLength(2));
  });

  it("(ac) a member re-queued by a NEW message during a follow-up run is kept (seq changed), not settled away", async () => {
    const users = Array.from({ length: 39 }, (_, i) => `u${i}`);
    const c = newChat(); await seed(c, ["sender", ...users], []); await configureVapid(c);
    await setInternal(c, 30);
    const m = await meter(c, true);
    const sender = await connect(c, "sender");
    await send(sender, "one"); // the last 10 members queued
    await vi.waitFor(async () => expect((await queued(c))?.inbox).toHaveLength(10));
    const tail = (await queued(c))!.inbox;
    let open!: () => void;
    m.holdInvalidations = new Promise<void>((r) => { open = r; });
    m.release();
    await vi.waitFor(() => expect(m.alarms).toBeGreaterThanOrEqual(1));
    await new Promise((r) => setTimeout(r, 30)); // the run is parked in its gated invalidation fetches
    const seqBefore = (await runInDurableObject(stub(c), async (inst: Conversation) => internals(inst).ctx.storage.get<{ seq: number }>("fanout_overflow")))!.seq;
    await send(sender, "two"); // same members beyond the budget again: the SAME ids are re-queued
    await vi.waitFor(async () => expect((await runInDurableObject(stub(c), async (inst: Conversation) => internals(inst).ctx.storage.get<{ seq: number }>("fanout_overflow")))!.seq).toBeGreaterThan(seqBefore));
    m.holdInvalidations = null;
    open();
    await drainAlarms(c);
    expect(await queued(c)).toBeUndefined();
    const inv = m.inbox.filter((_, i) => m.bodies[i]!.includes("invalidate"));
    for (const u of tail) expect(inv.filter((x) => x === `inbox:${u}`)).toHaveLength(2); // once per message's run
  });

  it("(ad) suppressed_active counts only SUBSCRIBED active recipients (consistent with eligible)", async () => {
    const c = newChat(); await seed(c, ["sender", "rcpt", "lurker"], ["rcpt"]); await configureVapid(c);
    const sender = await connect(c, "sender");
    await connect(c, "lurker"); // active but not subscribed
    await send(sender, "hi");
    await vi.waitFor(() => expect(outcomeLogs()).toHaveLength(1));
    expect(outcomeLogs()[0]).toContain("eligible=1 attempted=1");
    expect(outcomeLogs()[0]).toContain("suppressed_active=0");
  });

  it("(y) outcome counts: accepted / transient / permanent / debounced / active are reported separately (counts only)", async () => {
    const c = newChat(); await seed(c, ["sender", "ok", "tr", "gone", "watcher"], ["ok", "tr", "gone", "watcher"]); await configureVapid(c);
    fetchSpy.mockImplementation(async (url: unknown) => {
      const u = String(url);
      return new Response(null, { status: u.includes("-tr-") || u.endsWith(`-tr-secret-endpoint`) ? 503 : u.includes("-gone-") ? 410 : 201 });
    });
    const sender = await connect(c, "sender");
    await connect(c, "watcher");
    await send(sender, "hi");
    await vi.waitFor(() => expect(outcomeLogs()).toHaveLength(1));
    expect(outcomeLogs()[0]).toBe("push_decision outcome eligible=3 attempted=3 accepted=1 transient_failed=1 permanent_failed=1 dropped=0 suppressed_active=1 suppressed_debounce=0 deferred=0");
    await send(sender, "again");
    await vi.waitFor(() => expect(outcomeLogs()).toHaveLength(2));
    expect(outcomeLogs()[1]).toContain("attempted=0");
    expect(outcomeLogs()[1]).toContain("suppressed_debounce=");
  });

  it("(z) the debounce never suppresses a recipient's FIRST delivery; a user active on any device is excluded on all (known limitation)", async () => {
    const c = newChat(); await seed(c, ["sender", "early", "late", "desk"], ["early", "desk"]); await configureVapid(c);
    const sender = await connect(c, "sender");
    await connect(c, "desk"); // "desk" has the chat open on desktop; their phone is not connected
    await send(sender, "one");
    await vi.waitFor(() => expect(pushedTo()).toEqual([EP(`${c}-early`)]));
    // a recipient who subscribes later is pushed on the next message even inside the window
    await seed(c, ["late"], ["late"]);
    await send(sender, "two");
    await vi.waitFor(() => expect(pushedTo().sort()).toEqual([EP(`${c}-early`), EP(`${c}-late`)].sort()));
    // active exclusion is per USER (any non-away socket): "desk" never gets a push, phone included
    expect(pushedTo()).not.toContain(EP(`${c}-desk`));
  });

  it("(c-retry) a 429 is logged as transient and retried at most once per 10 s window (bounded)", async () => {
    await timeline(429, async (c, sender, at) => {
      await send(sender, "one"); await settle();
      expect(outcomeLogs()[0]).toContain("transient_failed=1");
      for (let i = 0; i < 5; i++) { at(1000 + i * 1000); await send(sender, `m${i}`); }
      await settle();
      expect(pushCalls()).toHaveLength(1); // no retry storm inside the backoff
    });
  });

  it("(r) a member removed while follow-up work is queued gets neither a push nor an invalidation", async () => {
    const users = Array.from({ length: 60 }, (_, i) => `u${i}`);
    const c = newChat(); await seed(c, ["sender", ...users], users); await configureVapid(c);
    await setInternal(c, 30); // so the inbox tail is queued too
    const m = await meter(c, true);
    const sender = await connect(c, "sender");
    await send(sender, "hi");
    await vi.waitFor(async () => expect(await queued(c)).toBeTruthy());
    const q = (await queued(c))!;
    const victim = q.push.find((u) => q.inbox.includes(`${u}`))!;
    expect(victim).toBeDefined();
    await DB.prepare("DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?").bind(c, victim).run();
    await stub(c).dropUser(victim, true);
    const q2 = (await queued(c))!;
    expect(q2.push).not.toContain(victim);
    expect(q2.inbox).not.toContain(victim);
    m.release();
    await drainAlarms(c);
    expect(pushedTo()).not.toContain(EP(`${c}-${victim}`));
    expect(m.inbox).not.toContain(`inbox:${victim}`);
  });

  // ---- review round: progress counting, first-send failures, old records ---------------
  const countsByEndpoint = (): Map<string, number> => {
    const n = new Map<string, number>();
    for (const u of pushedTo()) n.set(u, (n.get(u) ?? 0) + 1);
    return n;
  };
  const setEnv = (c: string, patch: Record<string, unknown>) => runInDurableObject(stub(c), async (inst: Conversation) => { Object.assign(internals(inst).env, patch); });
  /** Runs alarms, 10 s of fake time apart, until nothing is queued. */
  const runUntilDone = async (runAlarm: () => Promise<void>, c: string, at: (ms: number) => void, from = 0, max = 80) => {
    let rounds = 0;
    for (let i = 1; i <= max && (await queued(c)); i++) { at(from + i * 10_000); await runAlarm(); rounds++; }
    return rounds;
  };
  /** Makes the VAPID key import THROW (importVapidKey itself swallows bad key material, so
   *  the only way in is its env read): the first read (pushOffline's "is push configured"
   *  check) succeeds, later ones throw until the returned restore() puts the key back. */
  const breakVapid = async (c: string): Promise<() => Promise<void>> => {
    await runInDurableObject(stub(c), async (inst: Conversation) => {
      const e = internals(inst).env;
      let reads = 0;
      Object.defineProperty(e, "VAPID_PRIVATE_JWK", { configurable: true, get() { if (++reads > 1) throw new Error("kms down"); return vapid.VAPID_PRIVATE_JWK; } });
    });
    return () => runInDurableObject(stub(c), async (inst: Conversation) => {
      Object.defineProperty(internals(inst).env, "VAPID_PRIVATE_JWK", { configurable: true, writable: true, enumerable: true, value: vapid.VAPID_PRIVATE_JWK });
    });
  };

  it("(aj) sustained 503 outage with 300 push targets: every recipient gets exactly 3 attempts, then is dropped and logged; none fewer", async () => {
    await withFakeTime(6_000_000, async (at) => {
      fetchSpy.mockImplementation(async () => new Response(null, { status: 503 }));
      const users = Array.from({ length: 300 }, (_, i) => `u${i}`);
      const c = newChat(); await seed(c, ["sender", ...users], users); await configureVapid(c);
      const runAlarm = await manualAlarms(c);
      const sender = await connect(c, "sender");
      await send(sender, "one");
      await vi.waitFor(async () => expect((await queued(c))?.push).toHaveLength(300));
      expect((await queued(c))!.ceiling).toBe(10 + 3 * Math.ceil(300 / Math.floor(44 / MAX_PUSH_SUBS_PER_USER))); // worst case: whole users packed per round, 4 per 44-endpoint round
      const rounds = await runUntilDone(runAlarm, c, at);
      expect(await queued(c)).toBeUndefined();
      const counts = countsByEndpoint();
      expect(counts.size).toBe(300);
      console.info(`COST 300-push-target room under a 503 outage: pushes=${pushCalls().length} alarm_rounds=${rounds} (ceiling 235)`);
      for (const [, n] of counts) expect(n).toBe(3); // exactly 3: none dropped early, none retried again
      const dropped = outcomeLogs().reduce((t, l) => t + Number(/dropped=(\d+)/.exec(l)![1]), 0);
      expect(dropped).toBe(300);
      expect(allDecisionLogs().some((l) => l.startsWith("push_decision overflow_dropped"))).toBe(false);
    });
  }, 60_000);

  it("(ak) the VAPID import throws on the first send, then is fixed: the recipient is delivered on retry", async () => {
    await withFakeTime(7_000_000, async (at) => {
      const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
      const runAlarm = await manualAlarms(c);
      const sender = await connect(c, "sender");
      const fix = await breakVapid(c);
      try {
        await send(sender, "one");
        await vi.waitFor(async () => expect(await queued(c)).toBeTruthy());
      } finally { await fix(); }
      expect(allDecisionLogs().some((l) => l.startsWith("push_decision send_error"))).toBe(true);
      expect(pushCalls()).toHaveLength(0);
      expect((await queued(c))!.push).toEqual(["rcpt"]);
      expect((await queued(c))!.attempts).toEqual({ rcpt: 1 });
      at(10_000); await runAlarm();
      expect(pushCalls()).toHaveLength(1);
      expect(await queued(c)).toBeUndefined();
    });
  });

  it("(al) the first target read throws once: every member but the sender is queued and delivered via the follow-up", async () => {
    await withFakeTime(8_000_000, async (at) => {
      const c = newChat(); await seed(c, ["sender", "rcpt", "other"], ["rcpt"]); await configureVapid(c);
      const runAlarm = await manualAlarms(c);
      const sender = await connect(c, "sender");
      let thrown = false;
      await setEnv(c, { DB: { prepare: (sql: string) => { if (!thrown && sql.includes("push_subscriptions")) { thrown = true; throw new Error("d1 blip"); } return DB.prepare(sql); } } });
      try {
        await send(sender, "one");
        await vi.waitFor(async () => expect(await queued(c)).toBeTruthy());
      } finally { await setEnv(c, { DB }); }
      const q = (await queued(c))!;
      expect([...q.push].sort()).toEqual(["other", "rcpt"]); // over-included; never the sender
      expect(q.attempts).toEqual({ other: 1, rcpt: 1 });
      expect(q.notBefore).toEqual({ other: 8_010_000, rcpt: 8_010_000 });
      expect(outcomeLogs().at(-1)).toContain("deferred=2");
      expect(pushCalls()).toHaveLength(0);
      at(10_000); await runAlarm();
      expect(pushedTo()).toEqual([EP(`${c}-rcpt`)]); // re-filtered by subscription
      expect(await queued(c)).toBeUndefined();
    });
  });

  it("(am) the target read AND the member read fail: logged with counts, nothing queued, nothing thrown", async () => {
    const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
    const sender = await connect(c, "sender");
    await setEnv(c, { DB: { prepare: (sql: string) => { if (sql.includes("push_subscriptions") || sql.includes("chat_members")) throw new Error("d1 down"); return DB.prepare(sql); } } });
    try {
      await send(sender, "one");
      await settle();
    } finally { await setEnv(c, { DB }); }
    expect(allDecisionLogs().some((l) => /^push_decision overflow_error \S+ members_unreadable=1/.test(l))).toBe(true);
    expect(await queued(c)).toBeUndefined();
  });

  it("(an) budget-cut recipients survive a first-send failure: all 61 delivered exactly once after the fix", async () => {
    await withFakeTime(9_000_000, async (at) => {
      const users = Array.from({ length: 61 }, (_, i) => `u${i}`);
      const c = newChat(); await seed(c, ["sender", ...users], users); await configureVapid(c);
      const runAlarm = await manualAlarms(c);
      const sender = await connect(c, "sender");
      const fix = await breakVapid(c);
      try {
        await send(sender, "one");
        await vi.waitFor(async () => expect((await queued(c))?.push).toHaveLength(61));
      } finally { await fix(); }
      const q = (await queued(c))!;
      expect(Object.keys(q.attempts ?? {})).toHaveLength(42); // the reserved ones failed once; the 19 cut ones keep a fresh allowance
      expect(pushCalls()).toHaveLength(0);
      await runUntilDone(runAlarm, c, at);
      expect(await queued(c)).toBeUndefined();
      const counts = countsByEndpoint();
      expect(counts.size).toBe(61);
      for (const [, n] of counts) expect(n).toBe(1);
    });
  });

  it("(ao) an old-shape record (no attempts / notBefore / total / ceiling) is read and processed", async () => {
    const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
    const runAlarm = await manualAlarms(c);
    await runInDurableObject(stub(c), async (inst: Conversation) => { await internals(inst).ctx.storage.put("fanout_overflow", { chatId: c, push: ["rcpt"], inbox: [], rounds: 1, seq: 3 }); });
    await runAlarm();
    expect(pushedTo()).toEqual([EP(`${c}-rcpt`)]);
    expect(await queued(c)).toBeUndefined();
  });

  it("(ap) the scaled ceiling is hit and logged: the rest is dropped, key gone", async () => {
    const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
    const runAlarm = await manualAlarms(c);
    // 1 recipient -> ceiling 10 + 3 * ceil(1 / 44) = 13; a record that has used all its rounds
    await runInDurableObject(stub(c), async (inst: Conversation) => { await internals(inst).ctx.storage.put("fanout_overflow", { chatId: c, push: ["rcpt"], inbox: [], attempts: {}, notBefore: {}, rounds: 0, total: 13, ceiling: 13, seq: 1 }); });
    await runAlarm();
    expect(allDecisionLogs()).toContain("push_decision overflow_dropped push=1 inbox=0 reason=ceiling");
    expect(outcomeLogs().at(-1)).toContain("dropped=1");
    expect(pushCalls()).toHaveLength(0);
    expect(await queued(c)).toBeUndefined();
    // and one round below the ceiling is still served
    await runInDurableObject(stub(c), async (inst: Conversation) => { await internals(inst).ctx.storage.put("fanout_overflow", { chatId: c, push: ["rcpt"], inbox: [], attempts: {}, notBefore: {}, rounds: 0, total: 12, ceiling: 13, seq: 1 }); });
    await runAlarm();
    expect(pushCalls()).toHaveLength(1);
  });

  it("(aq) follow-up suppressed_active counts only PENDING recipients who were skipped as active", async () => {
    await withFakeTime(10_000_000, async (at) => {
      let n = 0;
      fetchSpy.mockImplementation(async () => new Response(null, { status: ++n === 1 ? 503 : 201 }));
      const c = newChat(); await seed(c, ["sender", "a", "b"], ["a", "b"]); await configureVapid(c);
      const runAlarm = await manualAlarms(c);
      const sender = await connect(c, "sender");
      await connect(c, "b"); // active and subscribed -> counted by the first send only
      await send(sender, "one");
      await vi.waitFor(async () => expect((await queued(c))?.push).toEqual(["a"]));
      expect(outcomeLogs().at(-1)).toContain("suppressed_active=1");
      at(10_000); await runAlarm();
      expect(outcomeLogs().at(-1)).toContain("suppressed_active=0");
      expect(outcomeLogs().at(-1)).toContain("accepted=1");
    });
  });

  it("(ar) multi-device: 100 members x 3 devices in a sustained 503 outage: every endpoint gets exactly 3 attempts, then the batch is dropped and logged; the ceiling is never hit", async () => {
    await withFakeTime(11_000_000, async (at) => {
      fetchSpy.mockImplementation(async () => new Response(null, { status: 503 }));
      const users = Array.from({ length: 100 }, (_, i) => `u${i}`);
      const c = newChat(); await seed(c, ["sender", ...users], users); await configureVapid(c);
      for (const u of users) for (const d of [2, 3]) {
        await DB.prepare("INSERT OR REPLACE INTO push_subscriptions (endpoint, user_id, created_at) VALUES (?, ?, 1)").bind(EP(`${c}-${u}-d${d}`), u).run();
      }
      const runAlarm = await manualAlarms(c);
      const sender = await connect(c, "sender");
      await send(sender, "one");
      await vi.waitFor(async () => expect((await queued(c))?.push?.length).toBeGreaterThan(0));
      const ceiling = (await queued(c))!.ceiling!;
      expect(ceiling).toBe(10 + 3 * Math.ceil(100 / Math.floor(44 / MAX_PUSH_SUBS_PER_USER)));
      const rounds = await runUntilDone(runAlarm, c, at);
      expect(await queued(c)).toBeUndefined();
      expect(rounds).toBeLessThan(ceiling);
      const counts = countsByEndpoint();
      expect(counts.size).toBe(300);
      for (const [, n] of counts) expect(n).toBe(3);
      const dropped = outcomeLogs().reduce((t, l) => t + Number(/dropped=(\d+)/.exec(l)![1]), 0);
      expect(dropped).toBe(100);
      expect(allDecisionLogs().some((l) => l.startsWith("push_decision overflow_dropped"))).toBe(false);
    });
  }, 90_000);

  it("(ar2) 300 members x MAX_PUSH_SUBS_PER_USER devices in a sustained 503 outage: whole users pack per round, every endpoint gets exactly 3 attempts, the ceiling is never hit", async () => {
    await withFakeTime(14_000_000, async (at) => {
      fetchSpy.mockImplementation(async () => new Response(null, { status: 503 }));
      const N = 300;
      const users = Array.from({ length: N }, (_, i) => `u${i}`);
      const c = newChat(); await seed(c, ["sender", ...users], users); await configureVapid(c);
      const stmts = [];
      for (const u of users) for (let d = 2; d <= MAX_PUSH_SUBS_PER_USER; d++) {
        stmts.push(DB.prepare("INSERT OR REPLACE INTO push_subscriptions (endpoint, user_id, created_at) VALUES (?, ?, 1)").bind(EP(`${c}-${u}-d${d}`), u));
      }
      for (let i = 0; i < stmts.length; i += 500) await DB.batch(stmts.slice(i, i + 500));
      const runAlarm = await manualAlarms(c);
      const sender = await connect(c, "sender");
      await send(sender, "one");
      await vi.waitFor(async () => expect((await queued(c))?.push?.length).toBeGreaterThan(0));
      const ceiling = (await queued(c))!.ceiling!;
      const usersPerRound = Math.floor(44 / MAX_PUSH_SUBS_PER_USER);
      expect(ceiling).toBe(10 + 3 * Math.ceil(N / usersPerRound));
      const rounds = await runUntilDone(runAlarm, c, at, 0, 400);
      expect(await queued(c)).toBeUndefined();
      expect(rounds).toBeGreaterThan(10 + 3 * Math.ceil((N * MAX_PUSH_SUBS_PER_USER) / 44)); // beyond the OLD ceiling
      expect(rounds).toBeLessThanOrEqual(ceiling);
      const counts = countsByEndpoint();
      expect(counts.size).toBe(N * MAX_PUSH_SUBS_PER_USER);
      for (const [, n] of counts) expect(n).toBe(3);
      expect(allDecisionLogs().filter((l) => l.startsWith("push_decision overflow_dropped") || l.includes("reason=ceiling"))).toEqual([]);
      const logs = outcomeLogs();
      expect(logs.reduce((t, l) => t + Number(/dropped=(\d+)/.exec(l)![1]), 0)).toBe(N);
      expect(logs.reduce((t, l) => t + Number(/accepted=(\d+)/.exec(l)![1]), 0)).toBe(0);
    });
  }, 300_000);

  it("(av) follow-up: a rejected send does not re-push a recipient who already got a 2xx in that round", async () => {
    await withFakeTime(15_000_000, async (at) => {
      const c = newChat(); await seed(c, ["sender", "okU", "rejU"], ["okU", "rejU"]); await configureVapid(c);
      const runAlarm = await manualAlarms(c);
      const sender = await connect(c, "sender");
      let phase: "outage" | "followup" | "healed" = "outage";
      let broken = false;
      await runInDurableObject(stub(c), async (inst: Conversation) => {
        Object.defineProperty(internals(inst).env, "DB", { configurable: true, get() { if (broken) throw new Error("d1 gone"); return DB; } });
      });
      fetchSpy.mockImplementation(async (url: string) => {
        if (phase === "outage") return new Response(null, { status: 503 });
        if (phase === "followup" && String(url).includes("rejU")) { broken = true; return new Response(null, { status: 404 }); } // prune -> d1() throws -> REJECTS
        if (phase === "followup") await new Promise((r) => setTimeout(r, 60)); // okU finishes AFTER the rejection
        return new Response(null, { status: 201 });
      });
      await send(sender, "one");
      await vi.waitFor(async () => expect([...((await queued(c))?.push ?? [])].sort()).toEqual(["okU", "rejU"]));
      phase = "followup";
      at(10_000); await runAlarm();
      broken = false;
      phase = "healed";
      expect(pushedTo().filter((u) => u.includes("okU"))).toHaveLength(2); // first send + this follow-up
      expect((await queued(c))?.push).toEqual(["rejU"]);
      at(20_000); await runAlarm();
      at(30_000); await runAlarm();
      expect(pushedTo().filter((u) => u.includes("okU"))).toHaveLength(2); // never re-pushed
      expect(pushedTo().filter((u) => u.includes("rejU")).length).toBeGreaterThanOrEqual(3);
      expect(await queued(c)).toBeUndefined();
    });
  }, 30_000);

  it("(as) first send: a rejected send does not lose its recipient, and a recipient who got a 2xx is never retried", async () => {
    await withFakeTime(12_000_000, async (at) => {
      const c = newChat(); await seed(c, ["sender", "okU", "rejU"], ["okU", "rejU"]); await configureVapid(c);
      const runAlarm = await manualAlarms(c);
      const sender = await connect(c, "sender");
      let broken = false;
      await runInDurableObject(stub(c), async (inst: Conversation) => {
        Object.defineProperty(internals(inst).env, "DB", { configurable: true, get() { if (broken) throw new Error("d1 gone"); return DB; } });
      });
      // rejU's 404 triggers the prune, whose d1() construction throws -> that send REJECTS
      let healed = false;
      fetchSpy.mockImplementation(async (url: string) => {
        if (String(url).includes("rejU") && !healed) { broken = true; return new Response(null, { status: 404 }); }
        if (String(url).includes("okU") && !healed) await new Promise((r) => setTimeout(r, 60)); // finishes AFTER rejU's rejection
        return new Response(null, { status: 201 });
      });
      try {
        await send(sender, "one");
        await vi.waitFor(async () => expect((await queued(c))?.push).toEqual(["rejU"]));
        await settle();
        expect((await queued(c))?.push).toEqual(["rejU"]);
      } finally {
        healed = true; broken = false;
        await runInDurableObject(stub(c), async (inst: Conversation) => {
          Object.defineProperty(internals(inst).env, "DB", { configurable: true, writable: true, enumerable: true, value: DB });
        });
      }
      expect((await queued(c))!.attempts).toEqual({ rejU: 1 });
      expect(pushedTo().filter((u) => u.includes("okU"))).toHaveLength(1);
      at(10_000); await runAlarm();
      expect(pushedTo().filter((u) => u.includes("okU"))).toHaveLength(1); // not retried
      expect(pushedTo().filter((u) => u.includes("rejU"))).toHaveLength(2);
      expect(await queued(c)).toBeUndefined();
    });
  });

  it("(at) target read failure fallback excludes users who were active at send time (and the sender)", async () => {
    await withFakeTime(13_000_000, async () => {
      const c = newChat(); await seed(c, ["sender", "act", "other"], ["act", "other"]); await configureVapid(c);
      await manualAlarms(c);
      const sender = await connect(c, "sender");
      await connect(c, "act");
      let thrown = false;
      await setEnv(c, { DB: { prepare: (sql: string) => { if (!thrown && sql.includes("push_subscriptions")) { thrown = true; throw new Error("d1 blip"); } return DB.prepare(sql); } } });
      try {
        await send(sender, "one");
        await vi.waitFor(async () => expect(await queued(c)).toBeTruthy());
      } finally { await setEnv(c, { DB }); }
      expect((await queued(c))!.push).toEqual(["other"]);
    });
  });

  it("(au) a failing overflow queue write is logged with counts only, not swallowed", async () => {
    const users = Array.from({ length: 61 }, (_, i) => `u${i}`);
    const c = newChat(); await seed(c, ["sender", ...users], users); await configureVapid(c);
    await manualAlarms(c);
    await runInDurableObject(stub(c), async (inst: Conversation) => {
      (inst as unknown as { queueOverflow: () => Promise<void> }).queueOverflow = async () => { throw new Error("storage down SECRET"); };
    });
    const sender = await connect(c, "sender");
    await send(sender, "one");
    await vi.waitFor(() => expect(allDecisionLogs()).toContain("push_decision overflow_error Error queue_write_failed push=19 inbox=0"));
    // the planted error message must never reach any log line
    expect(allDecisionLogs().some((l) => l.includes("SECRET") || l.includes("storage down"))).toBe(false);
    expect(logSpy.mock.calls.some((x: unknown[]) => x.some((a) => String(a).includes("SECRET") || String(a).includes("storage down")))).toBe(false);
  });

  // ---- per-device retry (owed) and mirror gating -----------------------------------
  const fp16 = async (url: string): Promise<string> => {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)));
    return [...d.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  /** Second device for `u`; the first is the one `seed` created. */
  const addDevice = async (c: string, u: string): Promise<{ a: string; b: string }> => {
    const b = `https://fcm.googleapis.com/fcm/send/${c}-${u}-device-b`;
    await DB.prepare("INSERT OR REPLACE INTO push_subscriptions (endpoint, user_id, created_at) VALUES (?, ?, 1)").bind(b, u).run();
    return { a: EP(`${c}-${u}`), b };
  };
  const countTo = (url: string) => pushedTo().filter((x) => x === url).length;
  type Q2 = { push: string[]; owed?: Record<string, string[]>; mirrorPending?: boolean; attempts?: Record<string, number> };
  const q2 = (c: string) => queued(c) as unknown as Promise<Q2 | undefined>;
  /** Make every D1 chat-preview write fail while `state.fail` is true. */
  const failMirror = async (c: string, state: { fail: boolean }) => {
    await setEnv(c, {
      DB: { prepare: (sql: string) => { if (state.fail && sql.startsWith("UPDATE chats SET last_message")) throw new Error("d1 mirror down"); return DB.prepare(sql); } },
    });
  };

  it("(aw) mixed devices: 201 on one and 503 on the other; the retry goes ONLY to the failed device", async () => {
    await withFakeTime(14_000_000, async (at) => {
      const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
      const { a, b } = await addDevice(c, "rcpt");
      let bHits = 0;
      fetchSpy.mockImplementation(async (url: unknown) => new Response(null, { status: String(url) === b && ++bHits === 1 ? 503 : 201 }));
      const runAlarm = await manualAlarms(c);
      const sender = await connect(c, "sender");
      await send(sender, "one");
      await vi.waitFor(async () => expect((await q2(c))?.owed).toBeTruthy());
      const q = (await q2(c))!;
      expect(q.owed).toEqual({ rcpt: [await fp16(b)] }); // a fingerprint, never the URL
      expect(JSON.stringify(q)).not.toContain("https://");
      expect(outcomeLogs().at(-1)).toContain("accepted=1");
      at(10_000); await runAlarm();
      expect(countTo(a)).toBe(1);
      expect(countTo(b)).toBe(2);
      expect(await q2(c)).toBeUndefined();
      at(60_000); await runAlarm();
      expect(countTo(a)).toBe(1);
    });
  });

  it("(ax) mixed devices, sustained 503: failing device gets exactly 3 attempts, working device 1; accepted, partial logged on drop", async () => {
    await withFakeTime(15_000_000, async (at) => {
      const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
      const { a, b } = await addDevice(c, "rcpt");
      fetchSpy.mockImplementation(async (url: unknown) => new Response(null, { status: String(url) === b ? 503 : 201 }));
      const runAlarm = await manualAlarms(c);
      const sender = await connect(c, "sender");
      await send(sender, "one");
      await vi.waitFor(async () => expect(await q2(c)).toBeTruthy());
      expect(outcomeLogs().at(-1)).toContain("accepted=1");
      expect(outcomeLogs().at(-1)).not.toContain("partial=");
      at(10_000); await runAlarm();
      expect((await q2(c))?.attempts).toEqual({ rcpt: 2 });
      at(20_000); await runAlarm();
      expect(await q2(c)).toBeUndefined();
      expect(countTo(b)).toBe(3);
      expect(countTo(a)).toBe(1);
      expect(outcomeLogs().at(-1)).toContain("dropped=1");
      expect(outcomeLogs().at(-1)).toContain("partial=1");
      at(60_000); await runAlarm();
      expect(countTo(b)).toBe(3);
      for (const l of allDecisionLogs()) for (const secret of [c, "rcpt", "https://"]) expect(l).not.toContain(secret);
    });
  });

  it("(ay) a new message while `owed` is pending goes to ALL devices and clears the narrowing", async () => {
    await withFakeTime(16_000_000, async (at) => {
      const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
      const { a, b } = await addDevice(c, "rcpt");
      let phase = 1;
      fetchSpy.mockImplementation(async (url: unknown) => new Response(null, { status: phase === 2 || String(url) === b ? 503 : 201 }));
      const runAlarm = await manualAlarms(c);
      const sender = await connect(c, "sender");
      await send(sender, "one");
      await vi.waitFor(async () => expect((await q2(c))?.owed).toEqual({ rcpt: [await fp16(b)] }));
      expect([countTo(a), countTo(b)]).toEqual([1, 1]);
      phase = 2; at(31_000); // past the debounce window; every device now fails
      await send(sender, "two");
      await vi.waitFor(async () => expect(countTo(b)).toBe(2));
      await vi.waitFor(async () => expect((await q2(c))?.owed).toEqual({}));
      expect([countTo(a), countTo(b)]).toEqual([2, 2]); // the new message reached both devices
      expect((await q2(c))?.push).toEqual(["rcpt"]);
    });
  });

  it("(az) an old-shape record without `owed`/`mirrorPending` is processed as before (all devices)", async () => {
    await withFakeTime(17_000_000, async (at) => {
      const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
      const { a, b } = await addDevice(c, "rcpt");
      const runAlarm = await manualAlarms(c);
      await runInDurableObject(stub(c), async (inst: Conversation) => {
        await internals(inst).ctx.storage.put("fanout_overflow", { chatId: c, push: ["rcpt"], inbox: [], attempts: { rcpt: 1 }, notBefore: { rcpt: 0 }, rounds: 0, total: 0, ceiling: 50, seq: 1 });
      });
      at(1_000); await runAlarm();
      expect([countTo(a), countTo(b)]).toEqual([1, 1]);
      expect(await q2(c)).toBeUndefined();
    });
  });

  it("(ba) mirror write fails twice: no push in the first invocation; queued with mirrorPending; the follow-up re-mirrors the latest message, then pushes", async () => {
    await withFakeTime(18_000_000, async (at) => {
      const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
      const runAlarm = await manualAlarms(c);
      const state = { fail: true };
      await failMirror(c, state);
      try {
        const sender = await connect(c, "sender");
        await send(sender, "latest-body");
        await vi.waitFor(async () => expect((await q2(c))?.mirrorPending).toBe(true));
        expect(pushCalls()).toHaveLength(0);
        expect(allDecisionLogs()).toContain("push_decision mirror_failed retried=1 deferred=1");
        expect((await q2(c))!.attempts).toEqual({}); // deferred, not an attempt
        const before = await DB.prepare("SELECT last_message FROM chats WHERE id = ?").bind(c).first<{ last_message: string | null }>();
        expect(before?.last_message).toBeNull();
        state.fail = false;
        at(1_000); await runAlarm();
        const after = await DB.prepare("SELECT last_message, last_sender_id FROM chats WHERE id = ?").bind(c).first<{ last_message: string; last_sender_id: string }>();
        expect(after).toEqual({ last_message: "latest-body", last_sender_id: "sender" });
        expect(pushCalls()).toHaveLength(1);
        expect(await q2(c)).toBeUndefined();
      } finally { await setEnv(c, { DB }); }
    });
  });

  it("(bb) mirror keeps failing: dropped after the bound and logged, no push is ever sent, queue key deleted", async () => {
    await withFakeTime(19_000_000, async (at) => {
      const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
      const runAlarm = await manualAlarms(c);
      await failMirror(c, { fail: true });
      try {
        const sender = await connect(c, "sender");
        await send(sender, "never-mirrored");
        await vi.waitFor(async () => expect((await q2(c))?.mirrorPending).toBe(true));
        await runUntilDone(runAlarm, c, at);
        expect(await q2(c)).toBeUndefined();
        expect(pushCalls()).toHaveLength(0);
        expect(allDecisionLogs()).toContain("push_decision overflow_dropped push=1 inbox=0");
        expect(outcomeLogs().at(-1)).toContain("dropped=1");
        expect(outcomeLogs().some((l) => l.includes("accepted=1"))).toBe(false);
      } finally { await setEnv(c, { DB }); }
    });
  });

  it("(bc) removing a member clears their `owed` entry", async () => {
    await withFakeTime(20_000_000, async () => {
      const c = newChat(); await seed(c, ["sender", "rcpt"], ["rcpt"]); await configureVapid(c);
      const { b } = await addDevice(c, "rcpt");
      fetchSpy.mockImplementation(async (url: unknown) => new Response(null, { status: String(url) === b ? 503 : 201 }));
      await manualAlarms(c);
      const sender = await connect(c, "sender");
      await send(sender, "one");
      await vi.waitFor(async () => expect((await q2(c))?.owed).toBeTruthy());
      await stub(c).dropUser("rcpt", true);
      const q = (await q2(c))!;
      expect(q.owed).toEqual({});
      expect(q.push).toEqual([]);
    });
  });

  it("(s) per-message cost: DM and 10-member group", async () => {
    for (const [label, n] of [["DM", 1], ["10-member group", 9]] as const) {
      const users = Array.from({ length: n }, (_, i) => `${label[0]}${n}x${i}`);
      const c = newChat(); await seed(c, ["sender", ...users], users); await configureVapid(c);
      const m = await meter(c);
      const before = pushCalls().length;
      const sender = await connect(c, "sender");
      await send(sender, "hi");
      await vi.waitFor(() => expect(pushCalls().length - before).toBe(n));
      await drainAlarms(c);
      await new Promise((r) => setTimeout(r, 30));
      console.info(`COST ${label}: d1=${m.d1.length} inbox_fetches=${m.inbox.length} pushes=${pushCalls().length - before} alarms=${m.alarms}`);
      expect(m.alarms).toBe(0);
      expect(m.inbox).toHaveLength(n + 1);
      // mirror write + member read + push-target read (+ nothing else)
      expect(m.d1).toHaveLength(3);
      fetchSpy.mockClear();
    }
  });
});
