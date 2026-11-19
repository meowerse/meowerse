import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import type { UserInbox } from "./inbox";

// The workers-pool env exposes the real bindings from wrangler.jsonc.
const bindings = env as unknown as { USER_INBOX: DurableObjectNamespace<UserInbox>; DB: D1Database };
const INBOX = bindings.USER_INBOX;
beforeAll(async () => {
  await bindings.DB.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT, access_exp INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)");
});
const seedSession = (id: string, user: string, exp: number) =>
  bindings.DB.prepare("INSERT OR REPLACE INTO sessions (id, user_id, access_token, refresh_token, access_exp, created_at, expires_at) VALUES (?, ?, '', NULL, 0, 0, ?)").bind(id, user, exp).run();
const notify = (s: ReturnType<typeof stub>, preview: string) =>
  s.fetch("https://do/notify", { method: "POST", body: JSON.stringify({ chatId: "c1", preview, at: 1, senderId: "x" }) });
async function open(user: string, sid: string): Promise<WebSocket> {
  const res = await stub(user).fetch(`https://do/ws?user=${user}`, { headers: { Upgrade: "websocket", "X-MW-Sid": sid } });
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}
const closedP = (ws: WebSocket) => new Promise<number>((resolve, reject) => { const t = setTimeout(() => reject(new Error("not closed")), 2000); ws.addEventListener("close", (e) => { clearTimeout(t); resolve(e.code); }); });
type Att = { userId?: string; sid?: string; checkedAt?: number };
/** Make the sockets' last session check look `ms` old (the verdict lives on the attachment). */
const age = (user: string, ms: number) => runInDurableObject(stub(user), async (inst: UserInbox) => { for (const ws of inst.ctx.getWebSockets()) { const a = ws.deserializeAttachment() as Att; ws.serializeAttachment({ ...a, checkedAt: Date.now() - ms }); } });
const expire = (user: string) => age(user, 40_000);
const checkedAtOf = (user: string) => runInDurableObject(stub(user), async (inst: UserInbox) => (inst.ctx.getWebSockets()[0].deserializeAttachment() as Att).checkedAt);
/** Swap the DO's D1 for a counting wrapper; `gate` (if set) holds every read until released; `fail` makes reads throw. */
const instrument = (user: string, opts: { gate?: Promise<void>; fail?: boolean } = {}) => runInDurableObject(stub(user), async (inst: UserInbox) => {
  const real = bindings.DB;
  const counter = { reads: 0 };
  (inst as unknown as { env: unknown }).env = { DB: { prepare: (sql: string) => {
    counter.reads++;
    if (opts.fail) throw new Error("d1 down");
    const st = real.prepare(sql);
    return { bind: (...p: unknown[]) => { const b = st.bind(...p); return { first: async () => { if (opts.gate) await opts.gate; return b.first(); } }; } };
  } } };
  (globalThis as unknown as Record<string, unknown>)["__reads_" + user] = counter;
});
const reads = (user: string) => ((globalThis as unknown as Record<string, { reads: number }>)["__reads_" + user]).reads;

function stub(userId: string) {
  return INBOX.get(INBOX.idFromName("inbox:" + userId));
}

/** Resolve with the first WS frame matching `pred` (skips the inbox_ready handshake). */
function nextFrame(ws: WebSocket, pred: (text: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), 2000);
    ws.addEventListener("message", (e: MessageEvent) => {
      const text = String(e.data);
      if (pred(text)) { clearTimeout(timer); resolve(text); }
    });
  });
}

describe("UserInbox DO", () => {
  it("upgrades a websocket → 101 and sends inbox_ready", async () => {
    const res = await stub("u1").fetch("https://do/ws?user=u1", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error("no webSocket on upgrade");
    ws.accept();
    const ready = await nextFrame(ws, (t) => t.includes("inbox_ready"));
    expect(JSON.parse(ready).type).toBe("inbox_ready");
  });

  it("relays a /notify delta to the user's connected socket as a chat_update", async () => {
    const s = stub("u2");
    const res = await s.fetch("https://do/ws?user=u2", { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket!;
    ws.accept();
    const got = nextFrame(ws, (t) => t.includes("chat_update"));
    await s.fetch("https://do/notify", {
      method: "POST",
      body: JSON.stringify({ chatId: "c9", preview: "hi there", at: 5, senderId: "u3" }),
    });
    const frame = JSON.parse(await got);
    expect(frame).toMatchObject({ type: "chat_update", chatId: "c9", preview: "hi there", senderId: "u3" });
  });

  it("notify is a 204 no-op when the user has no live socket", async () => {
    const res = await stub("offline-user").fetch("https://do/notify", {
      method: "POST",
      body: JSON.stringify({ chatId: "c1", preview: "x", at: 1, senderId: "u9" }),
    });
    expect(res.status).toBe(204);
  });

  it("rejects a non-websocket, non-notify request", async () => {
    const res = await stub("u4").fetch("https://do/ws?user=u4");
    expect(res.status).toBe(426);
  });

  describe("session-bound sockets (I3)", () => {
    const FAR = Date.now() + 86_400_000;
    it("a live session keeps receiving deltas (also after the verdict TTL lapses)", async () => {
      await seedSession("isid-ok", "iu1", FAR);
      const ws = await open("iu1", "isid-ok");
      await expire("iu1");
      const got = nextFrame(ws, (t) => t.includes("still-live"));
      await notify(stub("iu1"), "still-live");
      expect(JSON.parse(await got).preview).toBe("still-live");
    });
    it("logout/expiry: once the session is gone the delta is withheld and the socket is closed 4001", async () => {
      await seedSession("isid-gone", "iu2", FAR);
      const ws = await open("iu2", "isid-gone");
      const frames: string[] = [];
      ws.addEventListener("message", (e: MessageEvent) => frames.push(String(e.data)));
      const closed = closedP(ws);
      await bindings.DB.prepare("DELETE FROM sessions WHERE id = ?").bind("isid-gone").run();
      await expire("iu2");
      await notify(stub("iu2"), "secret-preview");
      expect(await closed).toBe(4001);
      expect(frames.some((f) => f.includes("secret-preview"))).toBe(false);
    });
    it("an expired session row is treated as gone", async () => {
      await seedSession("isid-exp", "iu3", Date.now() - 1000);
      const ws = await open("iu3", "isid-exp");
      const frames: string[] = [];
      ws.addEventListener("message", (e: MessageEvent) => frames.push(String(e.data)));
      const closed = closedP(ws);
      await expire("iu3");
      await notify(stub("iu3"), "late-preview");
      expect(await closed).toBe(4001);
      expect(frames.some((f) => f.includes("late-preview"))).toBe(false);
    });
    it("D1 outage: the last good check is honoured inside the stale window (measured from the socket's checkedAt); past it the delta is withheld but the socket stays", async () => {
      await seedSession("isid-st", "iu4", FAR);
      const ws = await open("iu4", "isid-st");
      await instrument("iu4", { fail: true });
      await age("iu4", 60_000); // older than TTL (30 s), inside the 120 s stale window
      const got = nextFrame(ws, (t) => t.includes("during-outage"));
      await notify(stub("iu4"), "during-outage");
      expect(JSON.parse(await got).preview).toBe("during-outage");
      await age("iu4", 200_000);
      const frames: string[] = [];
      ws.addEventListener("message", (e: MessageEvent) => frames.push(String(e.data)));
      await notify(stub("iu4"), "past-window");
      await new Promise((r) => setTimeout(r, 100));
      expect(frames.some((f) => f.includes("past-window"))).toBe(false);
    });
    it("a D1 failure does NOT refresh checkedAt (the stale window cannot be extended by errors)", async () => {
      await seedSession("isid-st2", "iu6", FAR);
      const ws = await open("iu6", "isid-st2");
      await instrument("iu6", { fail: true });
      await age("iu6", 60_000);
      const before = await checkedAtOf("iu6");
      const got = nextFrame(ws, (t) => t.includes("x1"));
      await notify(stub("iu6"), "x1");
      await got;
      expect(await checkedAtOf("iu6")).toBe(before);
    });
    it("normal flow: a fresh checkedAt (set at open) means NO D1 read per delta; a lapsed one reads once then refreshes", async () => {
      await seedSession("isid-n", "iu7", FAR);
      const ws = await open("iu7", "isid-n");
      await instrument("iu7");
      for (const p of ["n1", "n2", "n3"]) { const g = nextFrame(ws, (t) => t.includes(p)); await notify(stub("iu7"), p); await g; }
      expect(reads("iu7")).toBe(0);
      await expire("iu7");
      const old = await checkedAtOf("iu7");
      for (const p of ["n4", "n5"]) { const g = nextFrame(ws, (t) => t.includes(p)); await notify(stub("iu7"), p); await g; }
      expect(reads("iu7")).toBe(1);
      expect((await checkedAtOf("iu7"))!).toBeGreaterThan(old! + 30_000);
    });
    it("hibernation survival: the verdict is on the socket, not in DO memory (wiped memory + dead D1 still delivers inside the TTL)", async () => {
      await seedSession("isid-h", "iu8", FAR);
      const ws = await open("iu8", "isid-h");
      await runInDurableObject(stub("iu8"), async (inst: UserInbox) => { (inst as unknown as { pending: Map<string, unknown> }).pending.clear(); });
      await instrument("iu8", { fail: true }); // any D1 read would throw (and withhold if the TTL did not hold)
      const got = nextFrame(ws, (t) => t.includes("after-wake"));
      await notify(stub("iu8"), "after-wake");
      expect(JSON.parse(await got).preview).toBe("after-wake");
      expect(reads("iu8")).toBe(0);
    });
    it("two tabs of one session: ONE read refreshes both (verdict is per session)", async () => {
      await seedSession("isid-t", "iu10", FAR);
      const w1 = await open("iu10", "isid-t");
      const w2 = await open("iu10", "isid-t");
      await instrument("iu10");
      await expire("iu10");
      const g1 = nextFrame(w1, (t) => t.includes("tabs")); const g2 = nextFrame(w2, (t) => t.includes("tabs"));
      await notify(stub("iu10"), "tabs");
      await Promise.all([g1, g2]);
      expect(reads("iu10")).toBe(1);
    });
    it("ordering: two overlapping /notify with a slow session read arrive in order, over ONE shared read", async () => {
      await seedSession("isid-o", "iu9", FAR);
      const ws = await open("iu9", "isid-o");
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      await instrument("iu9", { gate });
      await expire("iu9");
      const seen: string[] = [];
      ws.addEventListener("message", (e: MessageEvent) => { const f = JSON.parse(String(e.data)); if (f.type === "chat_update") seen.push(f.preview); });
      const p1 = notify(stub("iu9"), "first");
      const p2 = notify(stub("iu9"), "second");
      await new Promise((r) => setTimeout(r, 50));
      expect(seen).toEqual([]); // both are waiting on the same pending read
      release();
      await Promise.all([p1, p2]);
      await new Promise((r) => setTimeout(r, 50));
      expect(seen).toEqual(["first", "second"]);
      expect(reads("iu9")).toBe(1);
    });
    it("a legacy socket without a sid is not checked (unchanged behaviour)", async () => {
      const ws = (await stub("iu5").fetch("https://do/ws?user=iu5", { headers: { Upgrade: "websocket" } })).webSocket!;
      ws.accept();
      const got = nextFrame(ws, (t) => t.includes("legacy"));
      await notify(stub("iu5"), "legacy");
      expect(JSON.parse(await got).preview).toBe("legacy");
    });
  });
});
