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
      (inst.env as unknown as Record<string, unknown>).USER_INBOX = {
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
      await vi.waitFor(() => expect(logSpy.mock.calls.some((x) => String(x[0]) === "push_delivery status=403 service=fcm pruned=1")).toBe(true));
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
      const env2 = inst.env as unknown as Record<string, unknown>;
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
  interface Meter { d1: string[]; inbox: string[]; bodies: string[]; alarms: number; release: () => void }
  /** `hold`: alarm invocations (the runtime fires them by itself) wait until
   *  `release()`, so the queued state can be inspected first. */
  async function meter(c: string, hold = false): Promise<Meter> {
    let held = hold;
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const m: Meter = { d1: [], inbox: [], bodies: [], alarms: 0, release: () => { held = false; open(); } };
    await runInDurableObject(stub(c), async (inst: Conversation) => {
      const e = inst.env as unknown as Record<string, unknown>;
      e.USER_INBOX = {
        idFromName: (n: string) => n,
        get: (n: string) => ({ fetch: async (_u: string, init?: RequestInit) => { m.inbox.push(n); m.bodies.push(String(init?.body ?? "")); return new Response(null, { status: 204 }); } }),
      };
      e.DB = new Proxy(DB, {
        get(t, prop) {
          if (prop === "prepare") return (sql: string) => { m.d1.push(sql); return t.prepare(sql); };
          const v = Reflect.get(t, prop);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      const orig = inst.alarm.bind(inst);
      inst.alarm = async () => { m.alarms++; if (held) await gate; return orig(); };
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
  const queued = (c: string) => runInDurableObject(stub(c), async (inst: Conversation) => inst.ctx.storage.get<{ push: string[]; inbox: string[] }>("fanout_overflow"));
  const SECRET = "SECRET-BODY-xyz";

  it("(k) 61-member group: every subscribed member is pushed exactly once across the original + alarm invocations; overflow inbox members get content-free invalidations; no text is persisted", async () => {
    const users = Array.from({ length: 60 }, (_, i) => `u${i}`);
    const c = newChat(); await seed(c, ["sender", ...users], users); await configureVapid(c);
    const m = await meter(c, true);
    const importSpy = vi.spyOn(crypto.subtle, "importKey");
    const sender = await connect(c, "sender");
    await send(sender, SECRET);
    await vi.waitFor(async () => expect(await queued(c)).toBeTruthy());
    const q = (await queued(c))!;
    expect(q.push.length + pushCalls().length).toBe(60); // nothing lost, nothing double-booked
    expect(q.inbox).toHaveLength(41);
    // the first invocation stays within the per-event subrequest budget: D1 + inbox + pushes
    expect(m.d1.length + m.inbox.length + pushCalls().length).toBeLessThanOrEqual(45);
    expect(pushCalls()).toHaveLength(22);
    // no message text anywhere in DO key-value storage
    const dump = await runInDurableObject(stub(c), async (inst: Conversation) => JSON.stringify([...(await inst.ctx.storage.list()).entries()]));
    expect(dump).not.toContain(SECRET);
    expect(m.inbox).toHaveLength(20); // inline previews only
    m.release();
    await drainAlarms(c);
    await vi.waitFor(() => expect(pushCalls()).toHaveLength(60));
    expect(new Set(pushedTo()).size).toBe(60); // exactly once each
    expect(await queued(c)).toBeUndefined();
    const invalidations = m.bodies.filter((b) => b.includes("invalidate"));
    expect(invalidations).toHaveLength(41);
    for (const b of invalidations) expect(JSON.parse(b)).toEqual({ chatId: c, invalidate: true });
    expect(m.inbox).toHaveLength(61); // every member signalled exactly once
    expect(new Set(m.inbox).size).toBe(61);
    // VAPID key imported once per invocation that sent pushes: the original + the alarm round(s)
    expect(importSpy.mock.calls.filter((a) => a[0] === "jwk").length).toBeLessThanOrEqual(1 + m.alarms);
    importSpy.mockRestore();
    console.info(`COST 61-member: d1=${m.d1.length} inbox_fetches=${m.inbox.length} pushes=${pushCalls().length} alarms=${m.alarms}`);
  });

  it("(p) 40 inbox members + 20 push targets: pushes are served first inline, inbox previews are capped at 20 and the other 20 members get invalidations from the alarm", async () => {
    const users = Array.from({ length: 39 }, (_, i) => `u${i}`);
    const c = newChat(); await seed(c, ["sender", ...users], users.slice(0, 20)); await configureVapid(c);
    const m = await meter(c, true);
    const sender = await connect(c, "sender");
    await send(sender, "one");
    await vi.waitFor(() => expect(pushCalls()).toHaveLength(20)); // all pushed in the first invocation
    await vi.waitFor(async () => expect((await queued(c))?.inbox).toHaveLength(20));
    expect(m.inbox).toHaveLength(20);
    m.release();
    await drainAlarms(c);
    expect(m.inbox).toHaveLength(40);
    expect(pushCalls()).toHaveLength(20);
  });

  it("(r) a member removed while follow-up work is queued gets neither a push nor an invalidation", async () => {
    const users = Array.from({ length: 60 }, (_, i) => `u${i}`);
    const c = newChat(); await seed(c, ["sender", ...users], users); await configureVapid(c);
    const m = await meter(c, true);
    const sender = await connect(c, "sender");
    await send(sender, "hi");
    await vi.waitFor(async () => expect(await queued(c)).toBeTruthy());
    const q = (await queued(c))!;
    const victim = q.push.find((u) => q.inbox.includes(`${u}`)) ?? q.push[0]!;
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
