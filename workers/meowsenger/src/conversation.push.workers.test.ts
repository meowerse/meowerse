/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
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
  interface Queued { push: string[]; inbox: string[]; attempts?: Record<string, number>; notBefore?: Record<string, number>; rounds?: number; total?: number }
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
   *  auto-fired alarm becomes a no-op, `runAlarm` runs one real invocation. */
  async function manualAlarms(c: string): Promise<() => Promise<void>> {
    let manual = false;
    let orig!: () => Promise<void>;
    await runInDurableObject(stub(c), async (inst: Conversation) => {
      orig = internals(inst).alarm.bind(inst);
      internals(inst).alarm = async () => { if (manual) await orig(); };
    });
    // Run the real handler directly (runDurableObjectAlarm only fires a scheduled alarm).
    return async () => {
      manual = true;
      try { await runInDurableObject(stub(c), async () => { await orig(); }); } finally { manual = false; }
    };
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
