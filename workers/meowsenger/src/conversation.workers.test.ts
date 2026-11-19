/// <reference types="@cloudflare/vitest-plugin/types" />
import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Conversation } from "./conversation";

// `env` from cloudflare:test is typed as the (here empty) ambient Cloudflare.Env;
// narrow the bindings we use so the DO RPC method `historyFor`, the DO instance
// type (for runInDurableObject), and the D1 binding are all typed.
const bindings = env as unknown as {
  CONVERSATION: DurableObjectNamespace<Conversation>;
  DB: D1Database;
};
const CONVERSATION = bindings.CONVERSATION;
const DB = bindings.DB;

// The DO waitUntil-mirrors each message's preview into D1 (chats/chat_members).
// The test D1 starts empty, so create those tables once — otherwise the mirror
// write throws an (uncaught, non-fatal) "no such table" rejection.
beforeAll(async () => {
  await DB.exec(
    "CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity INTEGER NOT NULL, last_message TEXT, last_sender_id TEXT, direct_key TEXT UNIQUE)",
  );
  await DB.exec(
    "CREATE TABLE IF NOT EXISTS chat_members (chat_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', unread_count INTEGER NOT NULL DEFAULT 0, last_read_at INTEGER, joined_at INTEGER NOT NULL, PRIMARY KEY (chat_id, user_id))",
  );
  await DB.exec(
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT, access_exp INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
  );
});

/** Open a socket the way the router does for a session-bound upgrade (`&sid=<sessions.id>`). */
async function connectSession(chatId: string, userId: string, sid: string): Promise<WebSocket> {
  await seedChatMember(chatId, userId, 0);
  const res = await stub(chatId).fetch(`https://do/ws?user=${userId}&chat=${chatId}&sid=${sid}`, { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}
async function seedSession(id: string, userId: string, expiresAt: number): Promise<void> {
  await DB.prepare("INSERT OR REPLACE INTO sessions (id, user_id, access_token, refresh_token, access_exp, created_at, expires_at) VALUES (?, ?, '', NULL, 0, 0, ?)").bind(id, userId, expiresAt).run();
}

/** Insert a chats row so the DO's D1 mirror write has a target to update. */
async function seedChat(chatId: string): Promise<void> {
  await DB.prepare(
    "INSERT OR IGNORE INTO chats (id, type, created_by, created_at, last_activity) VALUES (?, 'direct', 'u1', 0, 0)",
  )
    .bind(chatId)
    .run();
}

/** Insert a chat_members row so the DO's read-receipt markRead has a target. */
async function seedChatMember(chatId: string, userId: string, unread: number): Promise<void> {
  await DB.prepare(
    "INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, unread_count, last_read_at, joined_at) VALUES (?, ?, 'member', ?, NULL, 0)",
  )
    .bind(chatId, userId, unread)
    .run();
}

/** One stub per chatId (idFromName addresses the room deterministically). */
function stub(chatId: string): DurableObjectStub<Conversation> {
  return CONVERSATION.get(CONVERSATION.idFromName(chatId));
}

/** Open a WebSocket to the DO's fetch() and accept the client end. Optional
 *  role + type mirror what the gated router forwards (?role=&type=); they default
 *  to 'member'/'group' when omitted. */
async function connect(chatId: string, userId: string, role?: string, type?: string): Promise<WebSocket> {
  // The DO re-validates D1 membership per frame, so a connected test user must be a member.
  await seedChatMember(chatId, userId, 0);
  const res = await stub(chatId).fetch(
    `https://do/ws?user=${userId}&chat=${chatId}${role ? `&role=${role}` : ""}${type ? `&type=${type}` : ""}`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no webSocket on upgrade response");
  ws.accept();
  return ws;
}

/** Resolve on the first frame whose text matches `pred`, or reject after 2s. */
function waitFor(ws: WebSocket, pred: (text: string) => boolean): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for frame")), 2000);
    ws.addEventListener("message", (e: MessageEvent) => {
      const text = String(e.data);
      if (pred(text)) {
        clearTimeout(timer);
        resolve(text);
      }
    });
  });
}

/** Resolve when the client socket closes, or reject after 2s. */
function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for close")), 2000);
    ws.addEventListener("close", () => { clearTimeout(timer); resolve(); });
  });
}

describe("Conversation DO", () => {
  it("upgrades a websocket request → 101 + a client socket", async () => {
    const res = await stub("c1").fetch(
      "https://do/ws?user=u1&chat=c1",
      { headers: { Upgrade: "websocket" } },
    );
    expect(res.status).toBe(101);
    expect(res.webSocket).toBeTruthy();
  });

  it("rejects an upgrade missing user/chat params → 400", async () => {
    const res = await stub("c1").fetch("https://do/ws", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(400);
  });

  it("persists sent messages and returns them from historyFor (ascending)", async () => {
    const s = stub("c2");
    // Seed two messages directly into the DO's SQLite via its own context.
    await runInDurableObject(s, async (_instance: Conversation, ctx: DurableObjectState) => {
      ctx.storage.sql.exec(
        "INSERT INTO messages (id, sender_id, body, created_at) VALUES ('m1','u1','first',1000)",
      );
      ctx.storage.sql.exec(
        "INSERT INTO messages (id, sender_id, body, created_at) VALUES ('m2','u2','second',2000)",
      );
      const count = ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM messages").one().n;
      expect(Number(count)).toBe(2);
    });

    // historyFor is an RPC method on the DO — call it through the stub.
    const history = await s.historyFor("c2", null);
    expect(history.map((m) => m.body)).toEqual(["first", "second"]);
    expect(history[0]).toMatchObject({ id: "m1", chatId: "c2", senderId: "u1", createdAt: 1000 });

    // Cursor paging: `before=m2` returns only the earlier message.
    const older = await s.historyFor("c2", "m2");
    expect(older.map((m) => m.body)).toEqual(["first"]);
  });

  it("historyAround: centered window (incl. anchor), ascending, hasOlder/hasNewer; unknown id → found:false", async () => {
    const s = stub("caround");
    await runInDurableObject(s, async (_i: Conversation, ctx: DurableObjectState) => {
      for (let i = 1; i <= 60; i++) {
        ctx.storage.sql.exec("INSERT INTO messages (id, sender_id, body, created_at) VALUES (?, 'u1', ?, ?)", `m${i}`, `b${i}`, i * 1000);
      }
    });
    const around = await s.historyAround("caround", "m30");
    expect(around.found).toBe(true);
    // 25 older-or-equal (m6..m30) + 25 strictly-newer (m31..m55), ascending, incl. anchor.
    expect(around.messages.length).toBe(50);
    expect(around.messages[0].id).toBe("m6");
    expect(around.messages[around.messages.length - 1].id).toBe("m55");
    expect(around.messages.some((m) => m.id === "m30")).toBe(true);
    const times = around.messages.map((m) => m.createdAt);
    expect(times).toEqual([...times].sort((a, b) => a - b)); // strictly ascending
    expect(around.hasOlder).toBe(true); // m1..m5 exist below the window
    expect(around.hasNewer).toBe(true); // m56..m60 exist above
    expect(await s.historyAround("caround", "nope")).toEqual({ messages: [], hasOlder: false, hasNewer: false, found: false });
  });

  it("historyAround: anchoring on the newest message → hasNewer:false", async () => {
    const s = stub("caround2");
    await runInDurableObject(s, async (_i: Conversation, ctx: DurableObjectState) => {
      for (let i = 1; i <= 10; i++) {
        ctx.storage.sql.exec("INSERT INTO messages (id, sender_id, body, created_at) VALUES (?, 'u1', ?, ?)", `n${i}`, `b${i}`, i * 1000);
      }
    });
    const around = await s.historyAround("caround2", "n10");
    expect(around.found).toBe(true);
    expect(around.hasNewer).toBe(false);
    expect(around.messages[around.messages.length - 1].id).toBe("n10");
  });

  it("historyAfter: a forward page of strictly-newer messages, ascending; unknown id → []", async () => {
    const s = stub("cafter");
    await runInDurableObject(s, async (_i: Conversation, ctx: DurableObjectState) => {
      for (let i = 1; i <= 5; i++) {
        ctx.storage.sql.exec("INSERT INTO messages (id, sender_id, body, created_at) VALUES (?, 'u1', ?, ?)", `f${i}`, `b${i}`, i * 1000);
      }
    });
    expect((await s.historyAfter("cafter", "f3")).map((m) => m.id)).toEqual(["f4", "f5"]);
    expect(await s.historyAfter("cafter", "nope")).toEqual([]);
    // found distinguishes "nothing newer" from "the anchor is gone" (reconnect catch-up).
    expect(await s.historyAfterEx("cafter", "f5")).toEqual({ messages: [], found: true });
    expect(await s.historyAfterEx("cafter", "nope")).toEqual({ messages: [], found: false });
  });

  it("historyForEx: two older pages join the newest with no gap or overlap; unknown before → [] found:false", async () => {
    const s = stub("cbefore");
    await runInDurableObject(s, async (_i: Conversation, ctx: DurableObjectState) => {
      for (let i = 1; i <= 120; i++) {
        ctx.storage.sql.exec("INSERT INTO messages (id, sender_id, body, created_at) VALUES (?, 'u1', ?, ?)", `p${i}`, `b${i}`, i * 1000);
      }
    });
    const newest = (await s.historyForEx("cbefore", null)).messages;
    const mid = (await s.historyForEx("cbefore", newest[0]!.id)).messages;
    const oldest = (await s.historyForEx("cbefore", mid[0]!.id)).messages;
    const all = [...oldest, ...mid, ...newest].map((m) => m.id);
    expect(newest).toHaveLength(50);
    expect(mid).toHaveLength(50);
    expect(oldest).toHaveLength(20);
    expect(all).toEqual(Array.from({ length: 120 }, (_, i) => `p${i + 1}`)); // each id once, ascending
    // An unknown / hard-purged cursor is NOT the newest page.
    expect(await s.historyForEx("cbefore", "purged-id")).toEqual({ messages: [], found: false });
    expect(await s.historyFor("cbefore", "purged-id")).toEqual([]);
    expect(await s.historyForEx("cbefore", "p1")).toEqual({ messages: [], found: true }); // oldest row: nothing older
  });

  it("auto-responds to the client heartbeat ping with pong (keeps the DO hibernated)", async () => {
    await seedChat("cping");
    const w = await connect("cping", "u1");
    const pong = waitFor(w, (t) => t === "pong");
    w.send("ping");
    expect(await pong).toBe("pong");
  });

  it("persists a message sent over the socket and mirrors it into historyFor", async () => {
    await seedChat("c4");
    const wa = await connect("c4", "u1");
    const acked = waitFor(wa, (t) => t.includes('"sent"'));
    wa.send(JSON.stringify({ type: "send", tempId: "t1", body: "over-the-wire" }));
    const ackText = await acked;
    const ack = JSON.parse(ackText) as { type: string; tempId: string; message: { body: string } };
    expect(ack.type).toBe("sent");
    expect(ack.tempId).toBe("t1");
    expect(ack.message.body).toBe("over-the-wire");

    const history = await stub("c4").historyFor("c4", null);
    expect(history.some((m) => m.body === "over-the-wire" && m.senderId === "u1")).toBe(true);
  });

  it("broadcasts a sent message to peers and acks the sender", async () => {
    await seedChat("c3");
    const wa = await connect("c3", "u1");
    const wb = await connect("c3", "u2");

    // The peer should receive a {type:"message"} frame; the sender a {type:"sent"} ack.
    const peerGot = waitFor(wb, (t) => t.includes('"message"') && t.includes("hello"));
    const senderAck = waitFor(wa, (t) => t.includes('"sent"'));

    wa.send(JSON.stringify({ type: "send", tempId: "t1", body: "hello" }));

    const [peerText, ackText] = await Promise.all([peerGot, senderAck]);
    const peer = JSON.parse(peerText) as { type: string; message: { senderId: string; body: string } };
    expect(peer.type).toBe("message");
    expect(peer.message.body).toBe("hello");
    expect(peer.message.senderId).toBe("u1");
    // The sender got the ack, not the broadcast.
    expect(ackText).toContain('"sent"');
  });

  it("gives back-to-back sends strictly-increasing createdAt (stable history cursor)", async () => {
    await seedChat("c7");
    const wa = await connect("c7", "u1");
    // Two sends in quick succession likely share a Date.now() millisecond; the
    // monotonic clamp must still give them distinct, increasing created_at so the
    // `created_at < cursor` paging never skips a same-ms message.
    const ackA = waitFor(wa, (t) => t.includes('"sent"') && t.includes("m-a"));
    wa.send(JSON.stringify({ type: "send", tempId: "ta", body: "m-a" }));
    await ackA;
    const ackB = waitFor(wa, (t) => t.includes('"sent"') && t.includes("m-b"));
    wa.send(JSON.stringify({ type: "send", tempId: "tb", body: "m-b" }));
    await ackB;

    const mine = (await stub("c7").historyFor("c7", null)).filter((m) => m.body === "m-a" || m.body === "m-b");
    expect(mine.map((m) => m.body)).toEqual(["m-a", "m-b"]);
    expect(mine[1]!.createdAt).toBeGreaterThan(mine[0]!.createdAt);
  });

  it("rejects an empty body with an error frame", async () => {
    const wa = await connect("c5", "u1");
    const err = waitFor(wa, (t) => t.includes('"error"'));
    wa.send(JSON.stringify({ type: "send", tempId: "t1", body: "   " }));
    const errText = await err;
    expect(JSON.parse(errText)).toMatchObject({ type: "error", code: "bad_body" });
  });

  it("mirrors the last message into D1 off the critical path (waitUntil)", async () => {
    await seedChat("c6");
    const wa = await connect("c6", "u1");
    const acked = waitFor(wa, (t) => t.includes('"sent"'));
    wa.send(JSON.stringify({ type: "send", tempId: "t1", body: "sidebar-preview" }));
    await acked;

    // The mirror runs in waitUntil (after the frame is handled), so poll briefly.
    let lastMessage: string | null = null;
    for (let i = 0; i < 20; i++) {
      const row = await DB.prepare("SELECT last_message FROM chats WHERE id = ?")
        .bind("c6")
        .first<{ last_message: string | null }>();
      lastMessage = row?.last_message ?? null;
      if (lastMessage === "sidebar-preview") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(lastMessage).toBe("sidebar-preview");
  });

  it("announces presence: 2nd socket → 1st gets {presence,online:true}, 2nd gets snapshot incl. user1", async () => {
    const wa = await connect("c8", "u1");
    // The 1st socket should be told user2 came online once the 2nd connects.
    const aGotPresence = waitFor(wa, (t) => t.includes('"presence"') && t.includes('"u2"') && t.includes("true"));

    const wb = await connect("c8", "u2");
    // The 2nd socket's snapshot lists who was online before it (user1).
    const snapText = await waitFor(wb, (t) => t.includes("presence_snapshot"));
    const snap = JSON.parse(snapText) as { type: string; online: string[] };
    expect(snap.type).toBe("presence_snapshot");
    expect(snap.online).toContain("u1");
    expect(snap.online).not.toContain("u2");

    const aText = await aGotPresence;
    expect(JSON.parse(aText)).toMatchObject({ type: "presence", userId: "u2", online: true });

    wa.close();
    wb.close();
  });

  it("multi-tab: closing ONE of a user's two sockets does NOT flap offline; closing BOTH does", async () => {
    // A peer (u2) observes u1's presence transitions.
    const peer = await connect("c9", "u2");
    const tab1 = await connect("c9", "u1");
    const tab2 = await connect("c9", "u1");

    // Any offline frame for u1 seen while a tab remains is a bug (flap).
    let sawEarlyOffline = false;
    peer.addEventListener("message", (e: MessageEvent) => {
      const t = String(e.data);
      if (t.includes('"presence"') && t.includes('"u1"') && t.includes("false")) sawEarlyOffline = true;
    });

    // Close ONE tab — u1 still has tab2, so NO offline should be broadcast.
    tab1.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(sawEarlyOffline).toBe(false);

    // Close the LAST tab — now u1 is fully gone, expect a single offline frame.
    const offline = waitFor(peer, (t) => t.includes('"presence"') && t.includes('"u1"') && t.includes("false"));
    tab2.close();
    expect(JSON.parse(await offline)).toMatchObject({ type: "presence", userId: "u1", online: false });

    peer.close();
  });

  it("typing reaches the peer but not the sender", async () => {
    const wa = await connect("c10", "u1");
    const wb = await connect("c10", "u2");

    const peerGot = waitFor(wb, (t) => t.includes('"typing"') && t.includes('"u1"'));
    // The sender must NOT receive its own typing frame back.
    let senderEcho = false;
    wa.addEventListener("message", (e: MessageEvent) => {
      if (String(e.data).includes('"typing"')) senderEcho = true;
    });

    wa.send(JSON.stringify({ type: "typing", on: true }));
    const peerText = await peerGot;
    expect(JSON.parse(peerText)).toMatchObject({ type: "typing", userId: "u1", on: true });

    await new Promise((r) => setTimeout(r, 100));
    expect(senderEcho).toBe(false);

    wa.close();
    wb.close();
  });

  it("read → peer gets read_receipt and D1 last_read_at advances (unread derived, not counted)", async () => {
    await seedChat("c11");
    await seedChatMember("c11", "u1", 0);
    const wa = await connect("c11", "u1");
    const wb = await connect("c11", "u2");

    const peerGot = waitFor(wb, (t) => t.includes("read_receipt") && t.includes('"u1"'));
    wa.send(JSON.stringify({ type: "read", upTo: 5000 }));

    const peerText = await peerGot;
    expect(JSON.parse(peerText)).toMatchObject({ type: "read_receipt", userId: "u1", upTo: 5000 });

    // markRead runs in waitUntil, so poll D1 for the advanced last_read_at.
    let row: { last_read_at: number | null } | null = null;
    for (let i = 0; i < 20; i++) {
      row = await DB.prepare("SELECT last_read_at FROM chat_members WHERE chat_id = ? AND user_id = ?")
        .bind("c11", "u1")
        .first<{ last_read_at: number | null }>();
      if (row && row.last_read_at === 5000) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(row?.last_read_at).toBe(5000);

    // A stale (lower) read is a no-op — the monotonic guard won't move it backwards.
    wa.send(JSON.stringify({ type: "read", upTo: 4000 }));
    await new Promise((r) => setTimeout(r, 100));
    const after = await DB.prepare("SELECT last_read_at FROM chat_members WHERE chat_id = ? AND user_id = ?")
      .bind("c11", "u1")
      .first<{ last_read_at: number | null }>();
    expect(after?.last_read_at).toBe(5000);

    wa.close();
    wb.close();
  });

  // ---- Slice 4: reply / edit / delete / alarm purge ----

  it("reply: ack + peer broadcast carry the replyTo snippet {id,senderId,body}", async () => {
    await seedChat("c12");
    // Seed the message being replied to directly into the DO's SQLite.
    await runInDurableObject(stub("c12"), async (_i: Conversation, ctx: DurableObjectState) => {
      ctx.storage.sql.exec(
        "INSERT INTO messages (id, sender_id, body, created_at) VALUES ('orig','u2','original text',1000)",
      );
    });
    const wa = await connect("c12", "u1");
    const wb = await connect("c12", "u2");

    const peerGot = waitFor(wb, (t) => t.includes('"message"') && t.includes("the reply"));
    const senderAck = waitFor(wa, (t) => t.includes('"sent"'));
    wa.send(JSON.stringify({ type: "send", tempId: "t1", body: "the reply", replyToId: "orig" }));

    const [peerText, ackText] = await Promise.all([peerGot, senderAck]);
    const ack = JSON.parse(ackText) as { message: { replyToId: string; replyTo: { id: string; senderId: string; body: string } } };
    expect(ack.message.replyToId).toBe("orig");
    expect(ack.message.replyTo).toMatchObject({ id: "orig", senderId: "u2", body: "original text" });
    const peer = JSON.parse(peerText) as { message: { replyTo: { id: string; senderId: string; body: string } } };
    expect(peer.message.replyTo).toMatchObject({ id: "orig", senderId: "u2", body: "original text" });

    wa.close();
    wb.close();
  });

  it("reply: a bogus replyToId is ignored → stored null, no replyTo", async () => {
    await seedChat("c13");
    const wa = await connect("c13", "u1");
    const acked = waitFor(wa, (t) => t.includes('"sent"'));
    wa.send(JSON.stringify({ type: "send", tempId: "t1", body: "no such target", replyToId: "does-not-exist" }));
    const ack = JSON.parse(await acked) as { message: { replyToId: string | null; replyTo: unknown } };
    expect(ack.message.replyToId).toBeNull();
    expect(ack.message.replyTo).toBeNull();

    // historyFor confirms the persisted row has no reply link.
    const history = await stub("c13").historyFor("c13", null);
    const stored = history.find((m) => m.body === "no such target");
    expect(stored?.replyToId).toBeNull();
    expect(stored?.replyTo).toBeNull();

    wa.close();
  });

  it("edit: own message within 1h → {edited} broadcast to all, editedAt set, historyFor shows new body", async () => {
    await seedChat("c14");
    // Seed a fresh own message (created_at = now, well within the 1h window).
    await runInDurableObject(stub("c14"), async (_i: Conversation, ctx: DurableObjectState) => {
      ctx.storage.sql.exec(
        "INSERT INTO messages (id, sender_id, body, created_at) VALUES ('e1','u1','before edit',?)",
        Date.now(),
      );
    });
    const wa = await connect("c14", "u1");
    const wb = await connect("c14", "u2");

    // The editor's own socket also receives the broadcast (multi-tab convergence).
    const senderGot = waitFor(wa, (t) => t.includes('"edited"'));
    const peerGot = waitFor(wb, (t) => t.includes('"edited"'));
    wa.send(JSON.stringify({ type: "edit", id: "e1", body: "after edit" }));

    const [senderText, peerText] = await Promise.all([senderGot, peerGot]);
    const ed = JSON.parse(senderText) as { type: string; id: string; body: string; editedAt: number };
    expect(ed).toMatchObject({ type: "edited", id: "e1", body: "after edit" });
    expect(ed.editedAt).toBeGreaterThan(0);
    expect(JSON.parse(peerText)).toMatchObject({ type: "edited", id: "e1", body: "after edit" });

    const history = await stub("c14").historyFor("c14", null);
    const row = history.find((m) => m.id === "e1");
    expect(row?.body).toBe("after edit");
    expect(row?.editedAt).toBeGreaterThan(0);

    wa.close();
    wb.close();
  });

  it("edit: not-own message → {error, cannot_edit}, body unchanged", async () => {
    await seedChat("c15");
    await runInDurableObject(stub("c15"), async (_i: Conversation, ctx: DurableObjectState) => {
      ctx.storage.sql.exec(
        "INSERT INTO messages (id, sender_id, body, created_at) VALUES ('e2','u2','peer msg',?)",
        Date.now(),
      );
    });
    // u1 tries to edit u2's message.
    const wa = await connect("c15", "u1");
    const err = waitFor(wa, (t) => t.includes('"error"'));
    wa.send(JSON.stringify({ type: "edit", id: "e2", body: "hijacked" }));
    expect(JSON.parse(await err)).toMatchObject({ type: "error", code: "cannot_edit" });

    const history = await stub("c15").historyFor("c15", null);
    expect(history.find((m) => m.id === "e2")?.body).toBe("peer msg");

    wa.close();
  });

  it("edit: a message older than 1h → {error, cannot_edit}", async () => {
    await seedChat("c16");
    await runInDurableObject(stub("c16"), async (_i: Conversation, ctx: DurableObjectState) => {
      // 2h old → outside the 1h edit window.
      ctx.storage.sql.exec(
        "INSERT INTO messages (id, sender_id, body, created_at) VALUES ('e3','u1','old own msg',?)",
        Date.now() - 2 * 3600_000,
      );
    });
    const wa = await connect("c16", "u1");
    const err = waitFor(wa, (t) => t.includes('"error"'));
    wa.send(JSON.stringify({ type: "edit", id: "e3", body: "too late" }));
    expect(JSON.parse(await err)).toMatchObject({ type: "error", code: "cannot_edit" });

    const history = await stub("c16").historyFor("c16", null);
    expect(history.find((m) => m.id === "e3")?.body).toBe("old own msg");

    wa.close();
  });

  it("delete: own recent → {deleted} broadcast, historyFor shows isDeleted:true + body:''", async () => {
    await seedChat("c17");
    await runInDurableObject(stub("c17"), async (_i: Conversation, ctx: DurableObjectState) => {
      ctx.storage.sql.exec(
        "INSERT INTO messages (id, sender_id, body, created_at) VALUES ('d1','u1','delete me',?)",
        Date.now(),
      );
    });
    const wa = await connect("c17", "u1");
    const wb = await connect("c17", "u2");

    const senderGot = waitFor(wa, (t) => t.includes('"deleted"'));
    const peerGot = waitFor(wb, (t) => t.includes('"deleted"'));
    wa.send(JSON.stringify({ type: "delete", id: "d1" }));

    const [senderText, peerText] = await Promise.all([senderGot, peerGot]);
    expect(JSON.parse(senderText)).toMatchObject({ type: "deleted", id: "d1" });
    expect(JSON.parse(peerText)).toMatchObject({ type: "deleted", id: "d1" });

    const history = await stub("c17").historyFor("c17", null);
    const row = history.find((m) => m.id === "d1");
    expect(row?.isDeleted).toBe(true);
    expect(row?.body).toBe("");

    wa.close();
    wb.close();
  });

  it("delete: a message older than 24h → {error, cannot_delete}, still not deleted", async () => {
    await seedChat("c18");
    await runInDurableObject(stub("c18"), async (_i: Conversation, ctx: DurableObjectState) => {
      // 25h old → outside the 24h delete window.
      ctx.storage.sql.exec(
        "INSERT INTO messages (id, sender_id, body, created_at) VALUES ('d2','u1','old own msg',?)",
        Date.now() - 25 * 3600_000,
      );
    });
    const wa = await connect("c18", "u1");
    const err = waitFor(wa, (t) => t.includes('"error"'));
    wa.send(JSON.stringify({ type: "delete", id: "d2" }));
    expect(JSON.parse(await err)).toMatchObject({ type: "error", code: "cannot_delete" });

    const history = await stub("c18").historyFor("c18", null);
    const row = history.find((m) => m.id === "d2");
    expect(row?.isDeleted).toBe(false);
    expect(row?.body).toBe("old own msg");

    wa.close();
  });

  // ---- Slice 5: admin/owner message-delete (role forwarded by the router) ----

  it("admin-delete: a role=admin socket deletes a PEER's message → {deleted} broadcast + historyFor isDeleted", async () => {
    await seedChat("c20");
    // A peer's (u2) message, deliberately OLD (48h) to prove admins bypass the 24h window.
    await runInDurableObject(stub("c20"), async (_i: Conversation, ctx: DurableObjectState) => {
      ctx.storage.sql.exec(
        "INSERT INTO messages (id, sender_id, body, created_at) VALUES ('am1','u2','peer message',?)",
        Date.now() - 48 * 3600_000,
      );
    });
    // u1 connects as an admin (as the router would forward after reading D1).
    const admin = await connect("c20", "u1", "admin");
    const peer = await connect("c20", "u2");

    const adminGot = waitFor(admin, (t) => t.includes('"deleted"'));
    const peerGot = waitFor(peer, (t) => t.includes('"deleted"'));
    admin.send(JSON.stringify({ type: "delete", id: "am1" }));

    const [adminText, peerText] = await Promise.all([adminGot, peerGot]);
    expect(JSON.parse(adminText)).toMatchObject({ type: "deleted", id: "am1" });
    expect(JSON.parse(peerText)).toMatchObject({ type: "deleted", id: "am1" });

    const history = await stub("c20").historyFor("c20", null);
    const row = history.find((m) => m.id === "am1");
    expect(row?.isDeleted).toBe(true);
    expect(row?.body).toBe("");

    admin.close();
    peer.close();
  });

  it("admin-delete: a role=member socket deleting a PEER's message → {error, cannot_delete}, not deleted", async () => {
    await seedChat("c21");
    await runInDurableObject(stub("c21"), async (_i: Conversation, ctx: DurableObjectState) => {
      // A fresh peer message (well within 24h) — a plain member STILL can't delete it.
      ctx.storage.sql.exec(
        "INSERT INTO messages (id, sender_id, body, created_at) VALUES ('am2','u2','peer message',?)",
        Date.now(),
      );
    });
    // u1 connects as a plain member (default role).
    const member = await connect("c21", "u1", "member");
    const err = waitFor(member, (t) => t.includes('"error"'));
    member.send(JSON.stringify({ type: "delete", id: "am2" }));
    expect(JSON.parse(await err)).toMatchObject({ type: "error", code: "cannot_delete" });

    const history = await stub("c21").historyFor("c21", null);
    const row = history.find((m) => m.id === "am2");
    expect(row?.isDeleted).toBe(false);
    expect(row?.body).toBe("peer message");

    member.close();
  });

  // ---- Slice 6: channel posting rule (broadcast — only owner/admin post) ----

  it("channel + role=member send → {error, read_only}, nothing persisted, no broadcast", async () => {
    await seedChat("c22");
    // A member on a channel is read-only. A peer proves no broadcast escapes.
    const member = await connect("c22", "u1", "member", "channel");
    const peer = await connect("c22", "u2", "member", "channel");
    let peerSawMessage = false;
    peer.addEventListener("message", (e: MessageEvent) => {
      if (String(e.data).includes('"message"')) peerSawMessage = true;
    });

    const err = waitFor(member, (t) => t.includes('"error"'));
    member.send(JSON.stringify({ type: "send", tempId: "t1", body: "should be blocked" }));
    expect(JSON.parse(await err)).toMatchObject({ type: "error", code: "read_only" });

    // Nothing was persisted to the DO log...
    const history = await stub("c22").historyFor("c22", null);
    expect(history.some((m) => m.body === "should be blocked")).toBe(false);
    // ...and no message frame reached the peer.
    await new Promise((r) => setTimeout(r, 100));
    expect(peerSawMessage).toBe(false);

    member.close();
    peer.close();
  });

  it("channel + role=owner send → posts + broadcasts to peers normally", async () => {
    await seedChat("c23");
    const owner = await connect("c23", "u1", "owner", "channel");
    const sub = await connect("c23", "u2", "member", "channel");

    const peerGot = waitFor(sub, (t) => t.includes('"message"') && t.includes("broadcast body"));
    const ownerAck = waitFor(owner, (t) => t.includes('"sent"'));
    owner.send(JSON.stringify({ type: "send", tempId: "t1", body: "broadcast body" }));

    const [peerText, ackText] = await Promise.all([peerGot, ownerAck]);
    expect(JSON.parse(peerText)).toMatchObject({ type: "message", message: { senderId: "u1", body: "broadcast body" } });
    expect(ackText).toContain('"sent"');

    const history = await stub("c23").historyFor("c23", null);
    expect(history.some((m) => m.body === "broadcast body" && m.senderId === "u1")).toBe(true);

    owner.close();
    sub.close();
  });

  it("channel + role=admin send → posts normally (admins may broadcast)", async () => {
    await seedChat("c24");
    const admin = await connect("c24", "u1", "admin", "channel");
    const acked = waitFor(admin, (t) => t.includes('"sent"'));
    admin.send(JSON.stringify({ type: "send", tempId: "t1", body: "admin post" }));
    await acked;
    const history = await stub("c24").historyFor("c24", null);
    expect(history.some((m) => m.body === "admin post")).toBe(true);
    admin.close();
  });

  it("regression: group + role=member send → posts normally (rule is channel-only)", async () => {
    await seedChat("c25");
    // type='group' (or absent) — a plain member posts normally; only channels are read-only.
    const member = await connect("c25", "u1", "member", "group");
    const acked = waitFor(member, (t) => t.includes('"sent"'));
    member.send(JSON.stringify({ type: "send", tempId: "t1", body: "group member post" }));
    const ack = JSON.parse(await acked) as { type: string; message: { body: string } };
    expect(ack.type).toBe("sent");
    expect(ack.message.body).toBe("group member post");

    const history = await stub("c25").historyFor("c25", null);
    expect(history.some((m) => m.body === "group member post")).toBe(true);

    member.close();
  });

  it("alarm: hard-purges soft-deleted rows aged past the 24h window", async () => {
    const s = stub("c19");
    await runInDurableObject(s, async (_i: Conversation, ctx: DurableObjectState) => {
      // An old soft-deleted row (deleted 25h ago → past the purge horizon) plus a
      // live row that must survive.
      ctx.storage.sql.exec(
        "INSERT INTO messages (id, sender_id, body, created_at, is_deleted, deleted_at) VALUES ('gone','u1','',1000,1,?)",
        Date.now() - 25 * 3600_000,
      );
      ctx.storage.sql.exec(
        "INSERT INTO messages (id, sender_id, body, created_at) VALUES ('keep','u1','alive',2000)",
      );
      // A reaction on the doomed message + one on the survivor: the purge must reap
      // the orphan ('gone') but keep the live one ('keep').
      ctx.storage.sql.exec("INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES ('gone','u1','👍',1)");
      ctx.storage.sql.exec("INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES ('keep','u1','🎉',2)");
      // Arm an alarm so runDurableObjectAlarm has a scheduled handler to fire.
      await ctx.storage.setAlarm(Date.now() + 1000);
    });

    // runDurableObjectAlarm fires the DO's alarm() handler and reports whether an
    // alarm was scheduled (it was, above).
    const ran = await runDurableObjectAlarm(s);
    expect(ran).toBe(true);

    await runInDurableObject(s, async (_i: Conversation, ctx: DurableObjectState) => {
      const ids = ctx.storage.sql.exec("SELECT id FROM messages").toArray().map((r) => String(r.id));
      expect(ids).not.toContain("gone");
      expect(ids).toContain("keep");
      // The orphaned reaction is reaped; the survivor's reaction stays.
      const reactedIds = ctx.storage.sql.exec("SELECT DISTINCT message_id FROM reactions").toArray().map((r) => String(r.message_id));
      expect(reactedIds).not.toContain("gone");
      expect(reactedIds).toContain("keep");
    });
  });

  // ---- Slice 8: appendMessage RPC (forwarding) · rate bucket · is_forwarded ----

  it("appendMessage RPC: inserts the message and returns its id → shows in historyFor with isForwarded:true", async () => {
    await seedChat("c26");
    const s = stub("c26");
    // No socket is connected to this room — the RPC must still mirror the sidebar
    // (the forward-into-an-unopened-chat case). chatId is passed in explicitly.
    const id = await s.appendMessage("c26", "u1", "forwarded body", true);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const history = await s.historyFor("c26", null);
    const row = history.find((m) => m.id === id);
    expect(row?.body).toBe("forwarded body");
    expect(row?.senderId).toBe("u1");
    expect(row?.isForwarded).toBe(true);

    // CO1: with the real chatId threaded through, the D1 sidebar mirror lands even
    // with zero live sockets (previously chatId was "" → the UPDATE matched nothing).
    let chat: { last_message: string | null } | null = null;
    for (let i = 0; i < 20; i++) {
      chat = await DB.prepare("SELECT last_message FROM chats WHERE id = ?")
        .bind("c26")
        .first<{ last_message: string | null }>();
      if (chat && chat.last_message === "forwarded body") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(chat?.last_message).toBe("forwarded body");
  });

  it("appendMessage RPC: broadcasts {message} to a connected peer (no ack, forwarder not connected)", async () => {
    await seedChat("c27");
    const peer = await connect("c27", "u2");
    const peerGot = waitFor(peer, (t) => t.includes('"message"') && t.includes("fwd to peer"));
    // The forwarder (u1) is NOT connected — the RPC fans out to all live sockets.
    await stub("c27").appendMessage("c27", "u1", "fwd to peer", true);
    const peerText = await peerGot;
    const frame = JSON.parse(peerText) as { type: string; message: { senderId: string; body: string; isForwarded: boolean } };
    expect(frame.type).toBe("message");
    expect(frame.message.senderId).toBe("u1");
    expect(frame.message.body).toBe("fwd to peer");
    expect(frame.message.isForwarded).toBe(true);

    peer.close();
  });

  it("is_forwarded round-trips: a NON-forwarded send shows isForwarded:false in historyFor", async () => {
    await seedChat("c28");
    const wa = await connect("c28", "u1");
    const acked = waitFor(wa, (t) => t.includes('"sent"'));
    wa.send(JSON.stringify({ type: "send", tempId: "t1", body: "plain send" }));
    const ack = JSON.parse(await acked) as { message: { isForwarded: boolean } };
    // The ack Wire carries the (false) flag too.
    expect(ack.message.isForwarded).toBe(false);

    const history = await stub("c28").historyFor("c28", null);
    const row = history.find((m) => m.body === "plain send");
    expect(row?.isForwarded).toBe(false);

    wa.close();
  });

  it("appendMessage RPC: per-user forward flood meter throws rate_limited past the cap", async () => {
    await seedChat("cfwdrl");
    // Run every call inside ONE instance so the in-memory per-user bucket persists.
    await runInDurableObject(stub("cfwdrl"), async (inst: Conversation) => {
      // RATE_MAX (30) forwards in the window succeed...
      for (let i = 0; i < 30; i++) await inst.appendMessage("cfwdrl", "u1", `f${i}`, true);
      // ...the next from the SAME user is refused (mirrors the WS send flood limiter),
      // so forward can't bypass throttling to spam messages + Web Push.
      await expect(inst.appendMessage("cfwdrl", "u1", "over", true)).rejects.toThrow(/rate_limited/);
      // A DIFFERENT user is metered independently → still allowed.
      await expect(inst.appendMessage("cfwdrl", "u2", "ok", true)).resolves.toBeTruthy();
    });
  });

  it("webSocketError: an abnormal drop of the last socket clears presence (mirrors close)", async () => {
    await seedChat("cwserr");
    const peer = await connect("cwserr", "u2");
    const gone = waitFor(peer, (t) => t.includes('"presence"') && t.includes('"online":false') && t.includes('"u1"'));
    await connect("cwserr", "u1");
    // The runtime routes an abnormal termination (network loss / killed tab) to
    // webSocketError, NOT webSocketClose — it must run the same presence cleanup.
    await runInDurableObject(stub("cwserr"), async (inst: Conversation, ctx: DurableObjectState) => {
      const u1sock = ctx
        .getWebSockets()
        .find((w) => (w.deserializeAttachment() as { userId?: string } | null)?.userId === "u1");
      await inst.webSocketError(u1sock!);
    });
    expect(JSON.parse(await gone)).toMatchObject({ type: "presence", userId: "u1", online: false });
    peer.close();
  });

  it("dropUser(revoked=true): sends {revoked} to the target's sockets then closes them", async () => {
    await seedChat("cdrop1");
    const target = await connect("cdrop1", "u1");
    const peer = await connect("cdrop1", "u2");
    const gotRevoked = waitFor(target, (t) => t.includes('"revoked"'));
    const closed = waitForClose(target);
    await stub("cdrop1").dropUser("u1", true);
    expect(JSON.parse(await gotRevoked)).toMatchObject({ type: "revoked" });
    await closed; // the server closed the socket → the client's close fires
    peer.close();
  });

  it("dropUser(revoked=false): closes the target's sockets WITHOUT a {revoked} frame (demote → reconnect fresh)", async () => {
    await seedChat("cdrop2");
    const target = await connect("cdrop2", "u3");
    let sawRevoked = false;
    target.addEventListener("message", (e: MessageEvent) => { if (String(e.data).includes('"revoked"')) sawRevoked = true; });
    const closed = waitForClose(target);
    await stub("cdrop2").dropUser("u3", false);
    await closed;
    expect(sawRevoked).toBe(false); // plain close so the client reconnects with its new role
  });

  it("a socket whose D1 membership row is gone gets error:forbidden on its next frame (lost dropUser backstop)", async () => {
    await seedChat("cmem1");
    const a = await connect("cmem1", "u1");
    const peer = await connect("cmem1", "u2");
    // Prime: a member can send (and the verdict is cached).
    const ack = waitFor(a, (t) => t.includes('"sent"'));
    a.send(JSON.stringify({ type: "send", tempId: "t-mem-1", body: "hi" }));
    await ack;
    // Membership removed in D1 WITHOUT a dropUser (the RPC was lost), cache expired.
    await DB.prepare("DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?").bind("cmem1", "u1").run();
    await runInDurableObject(stub("cmem1"), async (instance: Conversation) => {
      (instance as unknown as { memberVerdict: Map<string, unknown> }).memberVerdict.clear();
    });
    let peerSaw = false;
    peer.addEventListener("message", (e: MessageEvent) => { if (String(e.data).includes("leak")) peerSaw = true; });
    const err = waitFor(a, (t) => t.includes('"error"'));
    a.send(JSON.stringify({ type: "send", tempId: "t-mem-2", body: "leak" }));
    expect(JSON.parse(await err)).toMatchObject({ type: "error", code: "forbidden" });
    await new Promise((r) => setTimeout(r, 100));
    expect(peerSaw).toBe(false);
    expect(Number((await stub("cmem1").historyFor("cmem1", null)).filter((m) => m.body === "leak").length)).toBe(0);
    peer.close();
  });

  async function lastMsg(chatId: string): Promise<string | null> {
    const r = await DB.prepare("SELECT last_message FROM chats WHERE id = ?").bind(chatId).first<{ last_message: string | null }>();
    return r?.last_message ?? null;
  }
  async function sendAndAck(ws: WebSocket, tempId: string, body: string): Promise<string> {
    const ack = waitFor(ws, (t) => t.includes('"sent"') && t.includes(tempId));
    ws.send(JSON.stringify({ type: "send", tempId, body }));
    return (JSON.parse(await ack) as { message: { id: string } }).message.id;
  }

  it("deleting the newest message re-mirrors chats.last_message from the newest LIVE row; deleting the only one clears it", async () => {
    await seedChat("cmir1");
    const a = await connect("cmir1", "u1");
    const idA = await sendAndAck(a, "t-mir-a", "alpha-keep");
    await vi.waitFor(async () => expect(await lastMsg("cmir1")).toBe("alpha-keep"));
    await new Promise((r) => setTimeout(r, 5));
    const idB = await sendAndAck(a, "t-mir-b", "bravo-secret");
    await vi.waitFor(async () => expect(await lastMsg("cmir1")).toBe("bravo-secret"));
    const gone = waitFor(a, (t) => t.includes('"deleted"'));
    a.send(JSON.stringify({ type: "delete", id: idB }));
    await gone;
    await vi.waitFor(async () => expect(await lastMsg("cmir1")).toBe("alpha-keep"));
    // Deleting a NON-newest message must not touch the preview.
    const idC = await sendAndAck(a, "t-mir-c", "charlie");
    await vi.waitFor(async () => expect(await lastMsg("cmir1")).toBe("charlie"));
    const gone2 = waitFor(a, (t) => t.includes('"deleted"') && t.includes(idA));
    a.send(JSON.stringify({ type: "delete", id: idA }));
    await gone2;
    await new Promise((r) => setTimeout(r, 100));
    expect(await lastMsg("cmir1")).toBe("charlie");
    const gone3 = waitFor(a, (t) => t.includes('"deleted"') && t.includes(idC));
    a.send(JSON.stringify({ type: "delete", id: idC }));
    await gone3;
    await vi.waitFor(async () => expect(await lastMsg("cmir1")).toBeNull());
    a.close();
  });

  it("editing the newest message re-mirrors the new body; editing an older one leaves the preview", async () => {
    await seedChat("cmir2");
    const a = await connect("cmir2", "u1");
    const idA = await sendAndAck(a, "t-mir2-a", "first");
    await new Promise((r) => setTimeout(r, 5));
    const idB = await sendAndAck(a, "t-mir2-b", "second");
    await vi.waitFor(async () => expect(await lastMsg("cmir2")).toBe("second"));
    const ed1 = waitFor(a, (t) => t.includes('"edited"') && t.includes(idB));
    a.send(JSON.stringify({ type: "edit", id: idB, body: "second-edited" }));
    await ed1;
    await vi.waitFor(async () => expect(await lastMsg("cmir2")).toBe("second-edited"));
    const ed2 = waitFor(a, (t) => t.includes('"edited"') && t.includes(idA));
    a.send(JSON.stringify({ type: "edit", id: idA, body: "first-edited" }));
    await ed2;
    await new Promise((r) => setTimeout(r, 100));
    expect(await lastMsg("cmir2")).toBe("second-edited");
    a.close();
  });

  it("dropUser: leaves OTHER users' sockets untouched", async () => {
    await seedChat("cdrop3");
    const target = await connect("cdrop3", "u1");
    const bystander = await connect("cdrop3", "u2");
    let bystanderClosed = false;
    bystander.addEventListener("close", () => { bystanderClosed = true; });
    const closedT = waitForClose(target);
    await stub("cdrop3").dropUser("u1", true);
    await closedT;
    // The bystander (u2) was never dropped.
    expect(bystanderClosed).toBe(false);
    bystander.close();
  });

  it("rate bucket: >30 sends in the window → a {rate_limited} error frame and the over-limit message is NOT persisted", async () => {
    await seedChat("c29");
    const wa = await connect("c29", "u1");

    // Watch for the first rate_limited error frame.
    let rateLimited = false;
    wa.addEventListener("message", (e: MessageEvent) => {
      const t = String(e.data);
      if (t.includes('"error"') && t.includes("rate_limited")) rateLimited = true;
    });

    // Fire 35 sends in a tight loop (same 10s window). The first 30 persist; the
    // rest are refused. Each body is unique so we can count persisted rows.
    for (let i = 0; i < 35; i++) {
      wa.send(JSON.stringify({ type: "send", tempId: `t${i}`, body: `flood-${i}` }));
    }

    // Wait for the DO to drain the queued frames and deliver the rate_limited
    // reply. A fixed sleep flakes on slower/loaded CI runners (the frame can take
    // >300ms to round-trip), so poll for the condition with a generous ceiling.
    for (let waited = 0; !rateLimited && waited < 5000; waited += 25) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(rateLimited).toBe(true);

    // At most RATE_MAX (30) of the flood bodies were persisted; the over-limit ones
    // (flood-30..flood-34) must NOT be in history.
    const history = await stub("c29").historyFor("c29", null);
    const persisted = history.filter((m) => m.body.startsWith("flood-"));
    expect(persisted.length).toBe(30);
    expect(persisted.some((m) => m.body === "flood-34")).toBe(false);

    wa.close();
  });

  it("typing-on frames are throttled per user (a burst reaches the peer once); typing-off always passes", async () => {
    await seedChat("ctyp1");
    const wa = await connect("ctyp1", "u1");
    const wb = await connect("ctyp1", "u2");
    const frames: string[] = [];
    wb.addEventListener("message", (e: MessageEvent) => { if (String(e.data).includes('"typing"')) frames.push(String(e.data)); });
    for (let i = 0; i < 10; i++) wa.send(JSON.stringify({ type: "typing", on: true }));
    wa.send(JSON.stringify({ type: "typing", on: false }));
    await vi.waitFor(() => expect(frames.some((f) => f.includes('"on":false'))).toBe(true), { timeout: 5000 });
    expect(frames.filter((f) => f.includes('"on":true'))).toHaveLength(1);
    wa.close(); wb.close();
  });

  it("send cap is per USER: two sockets of the same user share it (not 30 each)", async () => {
    await seedChat("cshare1");
    const wa = await connect("cshare1", "u1");
    const wb = await connect("cshare1", "u1");
    for (let i = 0; i < 20; i++) {
      wa.send(JSON.stringify({ type: "send", tempId: `ta${i}`, body: `share-a-${i}` }));
      wb.send(JSON.stringify({ type: "send", tempId: `tb${i}`, body: `share-b-${i}` }));
    }
    await vi.waitFor(async () => {
      const h = await stub("cshare1").historyFor("cshare1", null);
      expect(h.filter((m) => m.body.startsWith("share-")).length).toBeGreaterThanOrEqual(30);
    }, { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 300));
    const h = await stub("cshare1").historyFor("cshare1", null);
    expect(h.filter((m) => m.body.startsWith("share-")).length).toBe(30); // 40 sent across 2 sockets
    wa.close(); wb.close();
  });

  it("read frames are coalesced: 100 frames in ~1s cause at most 2 markRead D1 writes (latest cursor wins, flushed on close)", async () => {
    await seedChat("cread1");
    await seedChatMember("cread1", "u1", 0);
    const wa = await connect("cread1", "u1");
    const writes: unknown[][] = [];
    await runInDurableObject(stub("cread1"), async (inst: Conversation) => {
      const e = (inst as unknown as { env: { DB: D1Database } }).env;
      e.DB = new Proxy(DB, {
        get(t, prop) {
          if (prop === "prepare") {
            return (sql: string) => {
              const st = t.prepare(sql);
              if (!sql.startsWith("UPDATE chat_members SET last_read_at")) return st;
              return new Proxy(st, { get(x, k) { if (k === "bind") return (...a: unknown[]) => { writes.push(a); return x.bind(...a); }; const v = Reflect.get(x, k); return typeof v === "function" ? v.bind(x) : v; } });
            };
          }
          const v = Reflect.get(t, prop);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    });
    for (let i = 1; i <= 100; i++) wa.send(JSON.stringify({ type: "read", upTo: i * 10 }));
    await vi.waitFor(async () => {
      const r = await DB.prepare("SELECT last_read_at FROM chat_members WHERE chat_id = ? AND user_id = ?").bind("cread1", "u1").first<{ last_read_at: number | null }>();
      expect(r?.last_read_at).not.toBeNull();
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(writes.length).toBeLessThanOrEqual(2);
    const before = writes.length;
    wa.close(); // flushes the pending (latest) cursor
    await vi.waitFor(async () => {
      const r = await DB.prepare("SELECT last_read_at FROM chat_members WHERE chat_id = ? AND user_id = ?").bind("cread1", "u1").first<{ last_read_at: number }>();
      expect(r?.last_read_at).toBe(1000);
    }, { timeout: 5000 });
    expect(writes.length).toBeLessThanOrEqual(before + 1);
    expect(writes.length).toBeLessThanOrEqual(2);
  });

  // ---- Slice 9: reactions (toggle · broadcast · historyFor aggregation) ----

  it("react: toggle add → {reaction, on:true} broadcast to ALL (incl. the actor)", async () => {
    await seedChat("c30");
    await runInDurableObject(stub("c30"), async (_i: Conversation, ctx: DurableObjectState) => {
      ctx.storage.sql.exec("INSERT INTO messages (id, sender_id, body, created_at) VALUES ('r1','u2','react to me',1000)");
    });
    const actor = await connect("c30", "u1");
    const peer = await connect("c30", "u2");

    // The actor's own socket ALSO receives the reaction broadcast (multi-tab convergence).
    const actorGot = waitFor(actor, (t) => t.includes('"reaction"'));
    const peerGot = waitFor(peer, (t) => t.includes('"reaction"'));
    actor.send(JSON.stringify({ type: "react", id: "r1", emoji: "👍" }));

    const [actorText, peerText] = await Promise.all([actorGot, peerGot]);
    expect(JSON.parse(actorText)).toMatchObject({ type: "reaction", id: "r1", emoji: "👍", userId: "u1", on: true });
    expect(JSON.parse(peerText)).toMatchObject({ type: "reaction", id: "r1", emoji: "👍", userId: "u1", on: true });

    actor.close();
    peer.close();
  });

  it("react: toggling the SAME emoji again removes it → {reaction, on:false}", async () => {
    await seedChat("c31");
    await runInDurableObject(stub("c31"), async (_i: Conversation, ctx: DurableObjectState) => {
      ctx.storage.sql.exec("INSERT INTO messages (id, sender_id, body, created_at) VALUES ('r2','u2','toggle me',1000)");
    });
    const actor = await connect("c31", "u1");

    const onFrame = waitFor(actor, (t) => t.includes('"reaction"') && t.includes("true"));
    actor.send(JSON.stringify({ type: "react", id: "r2", emoji: "❤️" }));
    expect(JSON.parse(await onFrame)).toMatchObject({ type: "reaction", emoji: "❤️", on: true });

    const offFrame = waitFor(actor, (t) => t.includes('"reaction"') && t.includes("false"));
    actor.send(JSON.stringify({ type: "react", id: "r2", emoji: "❤️" }));
    expect(JSON.parse(await offFrame)).toMatchObject({ type: "reaction", emoji: "❤️", on: false });

    // After a full toggle cycle the message has no reactions in history.
    const history = await stub("c31").historyFor("c31", null, "u1");
    expect(history.find((m) => m.id === "r2")?.reactions).toEqual([]);

    actor.close();
  });

  it("react: historyFor aggregates counts + sets `mine` relative to viewerId", async () => {
    await seedChat("c32");
    await runInDurableObject(stub("c32"), async (_i: Conversation, ctx: DurableObjectState) => {
      ctx.storage.sql.exec("INSERT INTO messages (id, sender_id, body, created_at) VALUES ('r3','u3','popular',1000)");
      // u1 + u2 react 👍; only u1 reacts 🎉.
      const t = Date.now();
      ctx.storage.sql.exec("INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES ('r3','u1','👍',?)", t);
      ctx.storage.sql.exec("INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES ('r3','u2','👍',?)", t + 1);
      ctx.storage.sql.exec("INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES ('r3','u1','🎉',?)", t + 2);
    });

    // Viewer = u1: 👍 count 2 (mine), 🎉 count 1 (mine).
    const asU1 = await stub("c32").historyFor("c32", null, "u1");
    const rowU1 = asU1.find((m) => m.id === "r3");
    expect(rowU1?.reactions).toEqual([
      { emoji: "👍", count: 2, mine: true },
      { emoji: "🎉", count: 1, mine: true },
    ]);

    // Viewer = u2: 👍 count 2 (mine:true — u2 reacted), 🎉 count 1 (mine:false).
    const asU2 = await stub("c32").historyFor("c32", null, "u2");
    const rowU2 = asU2.find((m) => m.id === "r3");
    expect(rowU2?.reactions).toEqual([
      { emoji: "👍", count: 2, mine: true },
      { emoji: "🎉", count: 1, mine: false },
    ]);

    // No viewerId → all `mine:false`.
    const asAnon = await stub("c32").historyFor("c32", null);
    expect(asAnon.find((m) => m.id === "r3")?.reactions?.every((x) => x.mine === false)).toBe(true);
  });

  it("react: a bogus/deleted message id or empty emoji → {error, cannot_react}, nothing persisted", async () => {
    await seedChat("c33");
    await runInDurableObject(stub("c33"), async (_i: Conversation, ctx: DurableObjectState) => {
      ctx.storage.sql.exec("INSERT INTO messages (id, sender_id, body, created_at, is_deleted) VALUES ('gone','u2','',1000,1)");
    });
    const actor = await connect("c33", "u1");

    // Unknown id.
    const err1 = waitFor(actor, (t) => t.includes('"error"'));
    actor.send(JSON.stringify({ type: "react", id: "nope", emoji: "👍" }));
    expect(JSON.parse(await err1)).toMatchObject({ type: "error", code: "cannot_react" });

    // Soft-deleted target.
    const err2 = waitFor(actor, (t) => t.includes('"error"'));
    actor.send(JSON.stringify({ type: "react", id: "gone", emoji: "👍" }));
    expect(JSON.parse(await err2)).toMatchObject({ type: "error", code: "cannot_react" });

    // Empty emoji.
    const err3 = waitFor(actor, (t) => t.includes('"error"'));
    actor.send(JSON.stringify({ type: "react", id: "gone", emoji: "   " }));
    expect(JSON.parse(await err3)).toMatchObject({ type: "error", code: "cannot_react" });

    actor.close();
  });

  // ---- Slice 9: within-chat search RPC ----

  it("search: matches message bodies (newest-first), excludes soft-deleted", async () => {
    await seedChat("c34");
    await runInDurableObject(stub("c34"), async (_i: Conversation, ctx: DurableObjectState) => {
      ctx.storage.sql.exec("INSERT INTO messages (id, sender_id, body, created_at) VALUES ('s1','u1','hello world',1000)");
      ctx.storage.sql.exec("INSERT INTO messages (id, sender_id, body, created_at) VALUES ('s2','u2','say HELLO again',2000)");
      ctx.storage.sql.exec("INSERT INTO messages (id, sender_id, body, created_at) VALUES ('s3','u1','unrelated',3000)");
      // A soft-deleted message that also contains the term — must be excluded.
      ctx.storage.sql.exec("INSERT INTO messages (id, sender_id, body, created_at, is_deleted, deleted_at) VALUES ('s4','u2','',4000,1,4000)");
      ctx.storage.sql.exec("INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES ('s2','u1','👍',5000)");
    });
    const results = await stub("c34").search("hello", "c34", "u1");
    // Case-insensitive (LIKE), newest-first → s2 before s1; unrelated + deleted excluded.
    expect(results.map((m) => m.id)).toEqual(["s2", "s1"]);
    // Reactions ride along, with `mine` for the viewer.
    expect(results.find((m) => m.id === "s2")?.reactions).toEqual([{ emoji: "👍", count: 1, mine: true }]);
  });

  it("search: an empty/blank query returns []", async () => {
    await seedChat("c35");
    await runInDurableObject(stub("c35"), async (_i: Conversation, ctx: DurableObjectState) => {
      ctx.storage.sql.exec("INSERT INTO messages (id, sender_id, body, created_at) VALUES ('s5','u1','anything',1000)");
    });
    expect(await stub("c35").search("", "c35", "u1")).toEqual([]);
    expect(await stub("c35").search("   ", "c35", "u1")).toEqual([]);
  });

  it("search: LIKE wildcards in the query are escaped (match literally, not as wildcards)", async () => {
    await seedChat("c36");
    await runInDurableObject(stub("c36"), async (_i: Conversation, ctx: DurableObjectState) => {
      // One body literally contains "50%"; another would only match if % were a wildcard.
      ctx.storage.sql.exec("INSERT INTO messages (id, sender_id, body, created_at) VALUES ('s6','u1','deal is 50% off',1000)");
      ctx.storage.sql.exec("INSERT INTO messages (id, sender_id, body, created_at) VALUES ('s7','u2','5 apples and 0 pears',2000)");
    });
    // "50%" must match ONLY the literal "50%" body — not "5...0..." via a wildcard.
    const results = await stub("c36").search("50%", "u1");
    expect(results.map((m) => m.id)).toEqual(["s6"]);
  });

  // ---- PR-4: idempotent send + correlated errors ----

  /** Collect every frame a socket receives (parsed), so tests can count acks/broadcasts. */
  function collect(ws: WebSocket): Array<Record<string, unknown> & { type: string }> {
    const frames: Array<Record<string, unknown> & { type: string }> = [];
    ws.addEventListener("message", (e: MessageEvent) => {
      try { frames.push(JSON.parse(String(e.data))); } catch { /* ignore */ }
    });
    return frames;
  }
  async function until(pred: () => boolean): Promise<void> {
    for (let waited = 0; !pred() && waited < 3000; waited += 20) await new Promise((r) => setTimeout(r, 20));
  }

  it("dedupe: a duplicate tempId yields ONE row, ONE peer broadcast and TWO acks with the same message id", async () => {
    await seedChat("d1");
    const wa = await connect("d1", "u1");
    const wb = await connect("d1", "u2");
    const aFrames = collect(wa);
    const bFrames = collect(wb);
    wa.send(JSON.stringify({ type: "send", tempId: "t-dup", body: "once" }));
    await until(() => aFrames.some((f) => f.type === "sent"));
    // The resend (e.g. after a reconnect: a fresh socket, same tempId).
    const wa2 = await connect("d1", "u1");
    const a2Frames = collect(wa2);
    wa2.send(JSON.stringify({ type: "send", tempId: "t-dup", body: "once" }));
    await until(() => a2Frames.some((f) => f.type === "sent"));

    const acks = [...aFrames, ...a2Frames].filter((f) => f.type === "sent");
    expect(acks).toHaveLength(2);
    const ids = acks.map((f) => (f.message as { id: string }).id);
    expect(ids[0]).toBe(ids[1]);
    expect(acks.every((f) => f.tempId === "t-dup")).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(bFrames.filter((f) => f.type === "message")).toHaveLength(1);
    const hist = await stub("d1").historyFor("d1", null);
    expect(hist.filter((m) => m.body === "once")).toHaveLength(1);
  });

  it("dedupe before the role gate: a channel admin demoted after their send landed gets the re-ack, not read_only", async () => {
    await seedChat("d9-demote");
    const wa = await connect("d9-demote", "u1", "admin", "channel");
    const aFrames = collect(wa);
    wa.send(JSON.stringify({ type: "send", tempId: "t-demoted", body: "posted" }));
    await until(() => aFrames.some((f) => f.type === "sent"));
    // Reconnect as a plain member (demoted meanwhile) and resend the same tempId.
    const wa2 = await connect("d9-demote", "u1", "member", "channel");
    const a2Frames = collect(wa2);
    wa2.send(JSON.stringify({ type: "send", tempId: "t-demoted", body: "posted" }));
    await until(() => a2Frames.some((f) => f.type === "sent" || f.type === "error"));
    expect(a2Frames.find((f) => f.type === "error")).toBeUndefined();
    expect(a2Frames.find((f) => f.type === "sent")).toMatchObject({ tempId: "t-demoted" });
    // A NEW send from the demoted member is still refused.
    wa2.send(JSON.stringify({ type: "send", tempId: "t-new", body: "nope" }));
    await until(() => a2Frames.some((f) => f.type === "error"));
    expect(a2Frames.find((f) => f.type === "error")).toMatchObject({ code: "read_only", tempId: "t-new" });
  });

  it("dedupe: the same tempId from a DIFFERENT sender inserts a separate message", async () => {
    await seedChat("d2");
    const wa = await connect("d2", "u1");
    const wb = await connect("d2", "u2");
    const aFrames = collect(wa);
    const bFrames = collect(wb);
    wa.send(JSON.stringify({ type: "send", tempId: "t-same", body: "from u1" }));
    await until(() => aFrames.some((f) => f.type === "sent"));
    wb.send(JSON.stringify({ type: "send", tempId: "t-same", body: "from u2" }));
    await until(() => bFrames.some((f) => f.type === "sent"));
    const bAck = bFrames.find((f) => f.type === "sent") as unknown as { message: { body: string; senderId: string } };
    expect(bAck.message).toMatchObject({ body: "from u2", senderId: "u2" });
    const hist = await stub("d2").historyFor("d2", null);
    expect(hist.map((m) => m.body)).toEqual(["from u1", "from u2"]);
  });

  it("dedupe: send_dedupe stores ids only (never the body)", async () => {
    await seedChat("d3");
    const wa = await connect("d3", "u1");
    const frames = collect(wa);
    wa.send(JSON.stringify({ type: "send", tempId: "t-ids", body: "secret-body-xyz" }));
    await until(() => frames.some((f) => f.type === "sent"));
    await runInDurableObject(stub("d3"), async (_i: Conversation, ctx: DurableObjectState) => {
      const rows = ctx.storage.sql.exec("SELECT * FROM send_dedupe").toArray();
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]!).sort()).toEqual(["created_at", "message_id", "sender_id", "temp_id"]);
      expect(JSON.stringify(rows)).not.toContain("secret-body-xyz");
    });
  });

  it("dedupe: a resend is not metered by the rate limiter and a stale tempId from >24h ago is a fresh send", async () => {
    await seedChat("d4");
    await runInDurableObject(stub("d4"), async (_i: Conversation, ctx: DurableObjectState) => {
      ctx.storage.sql.exec("INSERT INTO messages (id, sender_id, body, created_at) VALUES ('old1','u1','ancient',1000)");
      ctx.storage.sql.exec(
        "INSERT INTO send_dedupe (sender_id, temp_id, message_id, created_at) VALUES ('u1','t-old','old1',?)",
        Date.now() - 25 * 3600_000,
      );
    });
    const wa = await connect("d4", "u1");
    const frames = collect(wa);
    wa.send(JSON.stringify({ type: "send", tempId: "t-old", body: "fresh" }));
    await until(() => frames.some((f) => f.type === "sent"));
    const ack = frames.find((f) => f.type === "sent") as unknown as { message: { id: string; body: string } };
    expect(ack.message.id).not.toBe("old1");
    expect(ack.message.body).toBe("fresh");
  });

  it("prune: keeps entries under 24h, drops older ones, on a send write", async () => {
    await seedChat("d5");
    await runInDurableObject(stub("d5"), async (_i: Conversation, ctx: DurableObjectState) => {
      const ins = "INSERT INTO send_dedupe (sender_id, temp_id, message_id, created_at) VALUES (?,?,?,?)";
      ctx.storage.sql.exec(ins, "u9", "t-young", "m-young", Date.now() - 23 * 3600_000);
      ctx.storage.sql.exec(ins, "u9", "t-old", "m-old", Date.now() - 25 * 3600_000);
    });
    const wa = await connect("d5", "u1");
    const frames = collect(wa);
    wa.send(JSON.stringify({ type: "send", tempId: "t-trigger", body: "prune now" }));
    await until(() => frames.some((f) => f.type === "sent"));
    await runInDurableObject(stub("d5"), async (_i: Conversation, ctx: DurableObjectState) => {
      const ids = ctx.storage.sql.exec("SELECT temp_id FROM send_dedupe ORDER BY temp_id").toArray().map((r) => r.temp_id);
      expect(ids).toEqual(["t-trigger", "t-young"]);
    });
  });

  it("errors carry the tempId: bad_body, read_only and rate_limited", async () => {
    await seedChat("d6");
    const wa = await connect("d6", "u1");
    const frames = collect(wa);
    wa.send(JSON.stringify({ type: "send", tempId: "t-bad", body: "   " }));
    await until(() => frames.some((f) => f.type === "error"));
    expect(frames.find((f) => f.type === "error")).toMatchObject({ code: "bad_body", tempId: "t-bad" });

    await seedChat("d7");
    const member = await connect("d7", "u1", "member", "channel");
    const mFrames = collect(member);
    member.send(JSON.stringify({ type: "send", tempId: "t-ro", body: "nope" }));
    await until(() => mFrames.some((f) => f.type === "error"));
    expect(mFrames.find((f) => f.type === "error")).toMatchObject({ code: "read_only", tempId: "t-ro" });

    await seedChat("d8");
    const flooder = await connect("d8", "u1");
    const fFrames = collect(flooder);
    for (let i = 0; i < 35; i++) flooder.send(JSON.stringify({ type: "send", tempId: `f${i}`, body: `fl-${i}` }));
    await until(() => fFrames.some((f) => f.code === "rate_limited"));
    const rl = fFrames.find((f) => f.code === "rate_limited");
    expect(rl).toMatchObject({ type: "error", code: "rate_limited" });
    expect(String(rl!.tempId)).toMatch(/^f\d+$/);
  });

  it("an oversized or malformed tempId is rejected (bad_body, not echoed, nothing persisted)", async () => {
    await seedChat("d9");
    const wa = await connect("d9", "u1");
    const frames = collect(wa);
    wa.send(JSON.stringify({ type: "send", tempId: "x".repeat(65), body: "big id" }));
    wa.send(JSON.stringify({ type: "send", tempId: "has space/<script>", body: "odd id" }));
    wa.send(JSON.stringify({ type: "send", tempId: 12345, body: "num id" }));
    await until(() => frames.filter((f) => f.type === "error").length >= 3);
    const errs = frames.filter((f) => f.type === "error");
    expect(errs).toHaveLength(3);
    for (const e of errs) {
      expect(e.code).toBe("bad_body");
      expect("tempId" in e).toBe(false);
    }
    const hist = await stub("d9").historyFor("d9", null);
    expect(hist).toHaveLength(0);
  });

  it("edit/delete errors echo the messageId (and tempId when sent)", async () => {
    await seedChat("d10");
    const wa = await connect("d10", "u1");
    const frames = collect(wa);
    wa.send(JSON.stringify({ type: "edit", id: "nope-1", body: "x" }));
    wa.send(JSON.stringify({ type: "delete", id: "nope-2", tempId: "t-del" }));
    await until(() => frames.filter((f) => f.type === "error").length >= 2);
    const errs = frames.filter((f) => f.type === "error");
    expect(errs.find((e) => e.code === "cannot_edit")).toMatchObject({ messageId: "nope-1" });
    expect(errs.find((e) => e.code === "cannot_delete")).toMatchObject({ messageId: "nope-2", tempId: "t-del" });
  });
});

// ---- Opus-review fixes: membership stale-while-error, revoked backstop, serialized
// preview writes, sidebar invalidate, in-flight dedupe, typing throttle ----------------
describe("Conversation DO: security-review fixes", () => {
  type Db = { all: (...a: unknown[]) => Promise<unknown>; first: (...a: unknown[]) => Promise<unknown>; run: (...a: unknown[]) => Promise<unknown>; batch?: unknown };
  type Inst = { d1: () => Db; memberVerdict: Map<string, { ok: boolean; at: number }>; memberInflight: Map<string, Promise<boolean>>; loadMember: (a: { chatId: string; userId: string }) => Promise<boolean> };

  /** Wrap the DO's D1 client for this chat (instance property shadows the prototype method). */
  async function patchD1(chatId: string, wrap: (real: Db) => Db): Promise<void> {
    await runInDurableObject(stub(chatId), async (inst: Conversation) => {
      const i = inst as unknown as Inst;
      delete (i as unknown as Record<string, unknown>).d1;
      const real = i.d1.call(i) as Db;
      (i as unknown as Record<string, unknown>).d1 = () => wrap(real);
    });
  }
  async function restoreD1(chatId: string): Promise<void> {
    await runInDurableObject(stub(chatId), async (inst: Conversation) => { delete (inst as unknown as Record<string, unknown>).d1; });
  }
  async function ageVerdict(chatId: string, userId: string, ageMs: number): Promise<void> {
    await runInDurableObject(stub(chatId), async (inst: Conversation) => {
      const m = (inst as unknown as Inst).memberVerdict;
      const v = m.get(userId);
      if (!v) throw new Error("no cached verdict to age");
      m.set(userId, { ok: v.ok, at: Date.now() - ageMs });
    });
  }
  async function lastMsg(chatId: string): Promise<string | null> {
    const r = await DB.prepare("SELECT last_message FROM chats WHERE id = ?").bind(chatId).first<{ last_message: string | null }>();
    return r?.last_message ?? null;
  }
  async function sendAndAck(ws: WebSocket, tempId: string, body: string): Promise<string> {
    const ack = waitFor(ws, (t) => t.includes('"sent"') && t.includes(tempId));
    ws.send(JSON.stringify({ type: "send", tempId, body }));
    return (JSON.parse(await ack) as { message: { id: string } }).message.id;
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** A gate that holds the FIRST preview write (`UPDATE chats SET last_message`) until released. */
  function holdFirstPreviewWrite() {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const heldP = new Promise<void>((r) => { held = r; });
    let first = true;
    const wrap = (real: Db): Db => ({
      ...real,
      all: real.all, first: real.first,
      run: async (sql: unknown, p?: unknown) => {
        if (first && String(sql).startsWith("UPDATE chats SET last_message")) { first = false; held(); await gate; }
        return real.run(sql, p);
      },
    });
    return { wrap, release, held: heldP };
  }

  it("D1 outage: the last good membership verdict keeps live chat working for the stale window", async () => {
    await seedChat("cstale1");
    const a = await connect("cstale1", "u1");
    await sendAndAck(a, "t-st-0", "prime");
    await patchD1("cstale1", (real) => ({ ...real, first: async (sql: unknown, p?: unknown) => { if (String(sql).includes("FROM chat_members WHERE chat_id = ? AND user_id")) throw new Error("d1 down"); return real.first(sql, p); } }));
    await ageVerdict("cstale1", "u1", 10_000); // TTL (5s) expired, still inside the 60s stale window
    const id = await sendAndAck(a, "t-st-1", "during-outage");
    expect(id).toBeTruthy();
    expect((await stub("cstale1").historyFor("cstale1", null)).some((m) => m.body === "during-outage")).toBe(true);
    a.close();
    await restoreD1("cstale1");
  });

  it("D1 outage past the stale window: send errors carry tempId (item resolves); typing/read/away get NOTHING back; socket stays open", async () => {
    await seedChat("cstale2");
    const a = await connect("cstale2", "u1");
    const peer = await connect("cstale2", "u2");
    await sendAndAck(a, "t-st2-0", "prime");
    await patchD1("cstale2", (real) => ({ ...real, first: async (sql: unknown, p?: unknown) => { if (String(sql).includes("FROM chat_members WHERE chat_id = ? AND user_id")) throw new Error("d1 down"); return real.first(sql, p); } }));
    await ageVerdict("cstale2", "u1", 120_000); // beyond the stale window
    const frames: string[] = [];
    a.addEventListener("message", (e: MessageEvent) => { frames.push(String(e.data)); });
    let closed = false;
    a.addEventListener("close", () => { closed = true; });
    let peerSaw = false;
    peer.addEventListener("message", (e: MessageEvent) => { if (/typing|read_receipt|presence|never-sent/.test(String(e.data))) peerSaw = true; });
    a.send(JSON.stringify({ type: "typing", on: true }));
    a.send(JSON.stringify({ type: "read", upTo: 5 }));
    a.send(JSON.stringify({ type: "away", away: true }));
    a.send(JSON.stringify({ type: "send", tempId: "t-st2-1", body: "never-sent" }));
    a.send(JSON.stringify({ type: "delete", id: "some-msg" }));
    await vi.waitFor(() => expect(frames.filter((f) => f.includes('"unavailable"'))).toHaveLength(2), { timeout: 3000 });
    const errs = frames.map((f) => JSON.parse(f)).filter((f) => f.type === "error");
    expect(errs).toHaveLength(2); // ONLY the send and the delete answered; typing/read/away silent
    expect(errs[0]).toMatchObject({ code: "unavailable", tempId: "t-st2-1" });
    expect(errs[1]).toMatchObject({ code: "unavailable", messageId: "some-msg" });
    expect(closed).toBe(false);
    expect(peerSaw).toBe(false);
    expect((await stub("cstale2").historyFor("cstale2", null)).some((m) => m.body === "never-sent")).toBe(false);
    // D1 back: the very next send is honoured again.
    await restoreD1("cstale2");
    await sendAndAck(a, "t-st2-2", "recovered");
    a.close(); peer.close();
  });

  it("a definite 'not a member' answer fails closed even inside the stale window, and sends {revoked} before closing", async () => {
    await seedChat("crev1");
    const a = await connect("crev1", "u1");
    await sendAndAck(a, "t-rv-0", "prime");
    await DB.prepare("DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?").bind("crev1", "u1").run();
    await runInDurableObject(stub("crev1"), async (inst: Conversation) => { (inst as unknown as Inst).memberVerdict.clear(); });
    const revoked = waitFor(a, (t) => t.includes('"revoked"'));
    const forbidden = waitFor(a, (t) => t.includes('"forbidden"'));
    const closed = waitForClose(a);
    a.send(JSON.stringify({ type: "send", tempId: "t-rv-1", body: "leak" }));
    expect(JSON.parse(await revoked)).toEqual({ type: "revoked" }); // what stops the client's reconnect loop
    expect(JSON.parse(await forbidden)).toMatchObject({ code: "forbidden", tempId: "t-rv-1" });
    await closed;
  });

  describe("edit/delete amplification (I1, M2)", () => {
    /** Count preview writes and member-list reads (= inbox fan-outs) the DO issues. */
    async function countD1(chatId: string): Promise<{ writes: () => number; fanouts: () => number }> {
      let writes = 0, fanouts = 0;
      await patchD1(chatId, (real) => ({
        ...real,
        // A realistically slow D1 write (production D1 is tens of ms; local miniflare is ~instant).
        run: async (sql: unknown, p?: unknown) => { if (String(sql).startsWith("UPDATE chats SET last_message")) { writes++; await sleep(40); } return real.run(sql, p); },
        all: async (sql: unknown, p?: unknown) => { if (String(sql).includes("SELECT user_id FROM chat_members WHERE chat_id")) fanouts++; return real.all(sql, p); },
      }));
      return { writes: () => writes, fanouts: () => fanouts };
    }
    it("50 rapid edits of the newest message: a handful of D1 preview writes and ONE immediate fan-out (one trailing), and a real send mirrors promptly after", async () => {
      await seedChat("camp1");
      const a = await connect("camp1", "u1");
      await connect("camp1", "u2");
      const id = await sendAndAck(a, "t-am1", "original");
      await vi.waitFor(async () => expect(await lastMsg("camp1")).toBe("original"));
      await sleep(2100); // let any invalidate window from the send settle
      const c = await countD1("camp1");
      for (let i = 0; i < 50; i++) a.send(JSON.stringify({ type: "edit", id, body: `edit-${i}` }));
      await vi.waitFor(async () => expect(await lastMsg("camp1")).toBe("edit-49"), { timeout: 3000 });
      await sleep(800); // an uncoalesced backlog (50 x 40 ms) would still be draining here
      expect(c.writes()).toBeLessThanOrEqual(3); // coalesced: NOT 50
      expect(c.fanouts()).toBeLessThanOrEqual(2); // first call immediate (+ at most the trailing one)
      // a real send's mirror is not queued behind a 50-deep backlog
      const t0 = Date.now();
      await sendAndAck(a, "t-am1b", "fresh");
      await vi.waitFor(async () => expect(await lastMsg("camp1")).toBe("fresh"), { timeout: 1500 });
      expect(Date.now() - t0).toBeLessThan(1500);
      // exactly one trailing fan-out follows the burst, then it goes quiet
      await sleep(2300);
      expect(c.fanouts()).toBeLessThanOrEqual(4);
      await restoreD1("camp1");
    });
    it("edit/delete/react frames share a per-user cap: frames beyond it get rate_limited (with the correlation id) and change nothing", async () => {
      await seedChat("camp2");
      const a = await connect("camp2", "u1");
      const errs: Array<{ code: string; messageId?: string }> = [];
      a.addEventListener("message", (e: MessageEvent) => { const m = JSON.parse(String(e.data)); if (m.type === "error") errs.push(m); });
      for (let i = 0; i < 70; i++) a.send(JSON.stringify({ type: i % 2 ? "delete" : "edit", id: `ghost-${i}`, body: "x" }));
      await vi.waitFor(() => expect(errs.length).toBe(70), { timeout: 3000 });
      expect(errs.filter((e) => e.code === "rate_limited")).toHaveLength(10);
      expect(errs.filter((e) => e.code === "cannot_edit" || e.code === "cannot_delete")).toHaveLength(60);
      expect(errs.find((e) => e.code === "rate_limited")?.messageId).toBe("ghost-60");
      // sends have their own window: still allowed
      await sendAndAck(a, "t-am2", "still-can-send");
    });
    it("a different user's window is independent", async () => {
      await seedChat("camp3");
      const a = await connect("camp3", "u1");
      const b = await connect("camp3", "u2");
      for (let i = 0; i < 61; i++) a.send(JSON.stringify({ type: "edit", id: `g${i}`, body: "x" }));
      const got = waitFor(b, (t) => t.includes("cannot_edit"));
      b.send(JSON.stringify({ type: "edit", id: "nope", body: "x" }));
      expect(JSON.parse(await got).code).toBe("cannot_edit"); // not rate_limited
    });
    it("M2: members beyond the inline inbox budget are queued on the overflow record for the alarm's invalidate", async () => {
      await seedChat("camp4");
      const a = await connect("camp4", "u1");
      for (const u of ["m2", "m3", "m4", "m5"]) await seedChatMember("camp4", u, 0);
      const id = await sendAndAck(a, "t-am4", "to-be-deleted");
      await sleep(50);
      const queued: string[][] = [];
      await runInDurableObject(stub("camp4"), async (inst: Conversation) => {
        const i = inst as unknown as { internalBudget: number; queueOverflow: (...x: unknown[]) => Promise<void>; invalidateState: { last: number } };
        i.internalBudget = 2;
        i.invalidateState.last = 0; // open the throttle window
        i.queueOverflow = async (_c: unknown, _s: unknown, push: unknown, inbox: unknown) => { expect(push).toEqual([]); queued.push(inbox as string[]); };
      });
      const gone = waitFor(a, (t) => t.includes('"deleted"'));
      a.send(JSON.stringify({ type: "delete", id }));
      await gone;
      await vi.waitFor(() => expect(queued).toHaveLength(1), { timeout: 2000 });
      expect(queued[0]).toHaveLength(3); // 5 members, budget 2
    });
  });

  describe("session-bound sockets (I3)", () => {
    const FAR = Date.now() + 86_400_000;
    const clearVerdicts = (chat: string) => runInDurableObject(stub(chat), async (inst: Conversation) => { (inst as unknown as Inst).memberVerdict.clear(); });
    it("normal flow: a socket with a live session sends fine", async () => {
      await seedChat("csess0");
      await seedSession("sid-ok", "u1", FAR);
      const a = await connectSession("csess0", "u1", "sid-ok");
      await sendAndAck(a, "t-s0", "hello");
      await clearVerdicts("csess0"); // forces a real D1 read with the session check
      await sendAndAck(a, "t-s0b", "still fine");
    });
    it("logout (session row deleted): the next frame is revoked + forbidden and the socket closes", async () => {
      await seedChat("csess1");
      await seedSession("sid-gone", "u1", FAR);
      const a = await connectSession("csess1", "u1", "sid-gone");
      await sendAndAck(a, "t-s1", "prime");
      await DB.prepare("DELETE FROM sessions WHERE id = ?").bind("sid-gone").run();
      await clearVerdicts("csess1");
      const revoked = waitFor(a, (t) => t.includes('"revoked"'));
      const forbidden = waitFor(a, (t) => t.includes('"forbidden"'));
      const closed = waitForClose(a);
      a.send(JSON.stringify({ type: "send", tempId: "t-s1b", body: "after-logout" }));
      expect(JSON.parse(await revoked)).toEqual({ type: "revoked" });
      expect(JSON.parse(await forbidden)).toMatchObject({ code: "forbidden", tempId: "t-s1b" });
      await closed;
      expect((await stub("csess1").historyFor("csess1", null)).some((m) => m.body === "after-logout")).toBe(false);
    });
    it("an expired session row ends the socket too", async () => {
      await seedChat("csess2");
      await seedSession("sid-exp", "u1", FAR);
      const a = await connectSession("csess2", "u1", "sid-exp");
      await DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").bind(Date.now() - 1000, "sid-exp").run();
      await clearVerdicts("csess2");
      const revoked = waitFor(a, (t) => t.includes('"revoked"'));
      a.send(JSON.stringify({ type: "send", tempId: "t-s2", body: "late" }));
      expect(JSON.parse(await revoked)).toEqual({ type: "revoked" });
    });
    it("a session belonging to ANOTHER user does not satisfy the check", async () => {
      await seedChat("csess3");
      await seedSession("sid-other", "someone-else", FAR);
      const a = await connectSession("csess3", "u1", "sid-other");
      await clearVerdicts("csess3");
      const revoked = waitFor(a, (t) => t.includes('"revoked"'));
      a.send(JSON.stringify({ type: "send", tempId: "t-s3", body: "x" }));
      expect(JSON.parse(await revoked)).toEqual({ type: "revoked" });
    });
    it("verdicts are per SESSION: logging out one login does not kill the user's other socket", async () => {
      await seedChat("csess4");
      await seedSession("sid-a", "u1", FAR);
      await seedSession("sid-b", "u1", FAR);
      const a = await connectSession("csess4", "u1", "sid-a");
      const b = await connectSession("csess4", "u1", "sid-b");
      await DB.prepare("DELETE FROM sessions WHERE id = ?").bind("sid-a").run();
      await clearVerdicts("csess4");
      const revoked = waitFor(a, (t) => t.includes('"revoked"'));
      a.send(JSON.stringify({ type: "send", tempId: "t-s4a", body: "x" }));
      await revoked;
      await sendAndAck(b, "t-s4b", "other login still works");
    });
    it("D1 outage: the last good session+membership verdict is honoured inside the stale window", async () => {
      await seedChat("csess5");
      await seedSession("sid-st", "u1", FAR);
      const a = await connectSession("csess5", "u1", "sid-st");
      await sendAndAck(a, "t-s5", "prime");
      await patchD1("csess5", (real) => ({ ...real, first: async (sql: unknown, p?: unknown) => { if (String(sql).includes("FROM chat_members WHERE chat_id = ? AND user_id")) throw new Error("d1 down"); return real.first(sql, p); } }));
      await runInDurableObject(stub("csess5"), async (inst: Conversation) => {
        const m = (inst as unknown as Inst).memberVerdict;
        const k = [...m.keys()].find((x) => x.endsWith("sid-st"))!;
        m.set(k, { ok: true, at: Date.now() - 10_000 }); // TTL expired, inside the 60 s stale window
      });
      await sendAndAck(a, "t-s5b", "during-outage");
      await restoreD1("csess5");
    });
  });

  it("serialized preview writes: deleting the newest message while its mirror is in flight ends on the previous live message", async () => {
    await seedChat("crace1");
    const a = await connect("crace1", "u1");
    await sendAndAck(a, "t-r1-a", "alpha-live");
    await vi.waitFor(async () => expect(await lastMsg("crace1")).toBe("alpha-live"));
    await sleep(5);
    const h = holdFirstPreviewWrite();
    await patchD1("crace1", h.wrap);
    const idB = await sendAndAck(a, "t-r1-b", "bravo-doomed");
    await h.held; // the send's mirror is now mid-write holding the OLD body
    const gone = waitFor(a, (t) => t.includes('"deleted"'));
    a.send(JSON.stringify({ type: "delete", id: idB }));
    await gone;
    await sleep(100); // an unserialized re-point would land (and be overwritten) in this gap
    h.release();
    await vi.waitFor(async () => expect(await lastMsg("crace1")).toBe("alpha-live"), { timeout: 5000 });
    await sleep(150);
    expect(await lastMsg("crace1")).toBe("alpha-live");
    a.close();
    await restoreD1("crace1");
  });

  it("serialized preview writes: an edit right after a send is not overwritten by the late mirror of the old text", async () => {
    await seedChat("crace2");
    const a = await connect("crace2", "u1");
    const h = holdFirstPreviewWrite();
    await patchD1("crace2", h.wrap);
    const id = await sendAndAck(a, "t-r2-a", "original-text");
    await h.held;
    const ed = waitFor(a, (t) => t.includes('"edited"'));
    a.send(JSON.stringify({ type: "edit", id, body: "edited-text" }));
    await ed;
    await sleep(100);
    h.release();
    await vi.waitFor(async () => expect(await lastMsg("crace2")).toBe("edited-text"), { timeout: 5000 });
    await sleep(150);
    expect(await lastMsg("crace2")).toBe("edited-text");
    a.close();
    await restoreD1("crace2");
  });

  it("serialized preview writes: a FAILED first mirror is retried from the CURRENT newest row, not the captured body", async () => {
    await seedChat("crace3");
    const a = await connect("crace3", "u1");
    let failNext = true;
    let gateFail!: () => void;
    const failGate = new Promise<void>((r) => { gateFail = r; });
    await patchD1("crace3", (real) => ({
      ...real,
      run: async (sql: unknown, p?: unknown) => {
        if (failNext && String(sql).startsWith("UPDATE chats SET last_message")) { failNext = false; await failGate; throw new Error("d1 blip"); }
        return real.run(sql, p);
      },
    }));
    const id = await sendAndAck(a, "t-r3-a", "pre-edit");
    const ed = waitFor(a, (t) => t.includes('"edited"'));
    a.send(JSON.stringify({ type: "edit", id, body: "post-edit" }));
    await ed;
    gateFail();
    await vi.waitFor(async () => expect(await lastMsg("crace3")).toBe("post-edit"), { timeout: 5000 });
    a.close();
    await restoreD1("crace3");
  });

  it("deleting/editing the newest message sends members' open sidebars a content-free invalidate AFTER the preview is re-pointed (no preview/at, so no unread bump)", async () => {
    await seedChat("cinbx1");
    const a = await connect("cinbx1", "u1");
    const b = await connect("cinbx1", "u2");
    const inboxNs = (env as unknown as { USER_INBOX: DurableObjectNamespace }).USER_INBOX;
    const res = await inboxNs.get(inboxNs.idFromName("inbox:u2")).fetch("https://do/ws?user=u2", { headers: { Upgrade: "websocket" } });
    const inbox = res.webSocket!;
    inbox.accept();
    await sendAndAck(a, "t-ib-a", "keep-me");
    await sleep(5);
    const idB = await sendAndAck(a, "t-ib-b", "secret-body");
    await vi.waitFor(async () => expect(await lastMsg("cinbx1")).toBe("secret-body"));
    const after: string[] = [];
    inbox.addEventListener("message", (e: MessageEvent) => after.push(String(e.data)));
    await sleep(200); // let the send's own fan-out settle
    after.length = 0;
    let previewAtInvalidate: string | null = null;
    inbox.addEventListener("message", (e: MessageEvent) => { if (String(e.data).includes('"invalidate"') && previewAtInvalidate === null) void lastMsg("cinbx1").then((v) => { previewAtInvalidate = v; }); });
    a.send(JSON.stringify({ type: "delete", id: idB }));
    await vi.waitFor(() => expect(after.some((f) => f.includes('"invalidate":true'))).toBe(true), { timeout: 4000 });
    const frame = JSON.parse(after.find((f) => f.includes('"invalidate"'))!);
    expect(frame).toEqual({ type: "chat_update", chatId: "cinbx1", invalidate: true });
    expect(after.some((f) => f.includes('"preview"') || f.includes('"at"'))).toBe(false);
    await vi.waitFor(() => expect(previewAtInvalidate).toBe("keep-me")); // already re-pointed when the signal arrived
    a.close(); b.close(); inbox.close();
  });

  it("in-flight membership dedupe: a stale read finishing after dropUser must not delete the NEWER read's entry", async () => {
    await seedChat("cinfl1");
    await runInDurableObject(stub("cinfl1"), async (inst: Conversation) => {
      const i = inst as unknown as Inst;
      const att = { chatId: "cinfl1", userId: "u1" };
      const gates: Array<() => void> = [];
      (i as unknown as Record<string, unknown>).d1 = () => ({
        all: async () => [],
        run: async () => undefined,
        first: () => new Promise((res) => { gates.push(() => res({ ok: 1 })); }),
      });
      const p1 = i.loadMember(att);
      expect(i.memberInflight.get("u1")).toBe(p1);
      await inst.dropUser("u1", false); // clears the map, bumps the generation
      const p2 = i.loadMember(att);
      expect(i.memberInflight.get("u1")).toBe(p2);
      expect(p2).not.toBe(p1);
      gates[0]!(); // the OLD read finishes first
      await p1;
      await Promise.resolve(); await Promise.resolve();
      expect(i.memberInflight.get("u1")).toBe(p2); // the old read's cleanup left the newer entry alone
      gates[1]!();
      await p2;
      await Promise.resolve(); await Promise.resolve();
      expect(i.memberInflight.has("u1")).toBe(false);
      delete (i as unknown as Record<string, unknown>).d1;
    });
  });

  it("typing: a quick follow-up 'on' after an 'off' always reaches peers; floods are capped separately", async () => {
    await seedChat("ctyp2");
    const wa = await connect("ctyp2", "u1");
    const wb = await connect("ctyp2", "u2");
    const frames: string[] = [];
    wb.addEventListener("message", (e: MessageEvent) => { if (String(e.data).includes('"typing"')) frames.push(String(e.data)); });
    for (const on of [true, false, true, false, true]) wa.send(JSON.stringify({ type: "typing", on }));
    await vi.waitFor(() => expect(frames).toHaveLength(5), { timeout: 5000 });
    expect(frames.map((f) => JSON.parse(f).on)).toEqual([true, false, true, false, true]);
    // Flood: 100 alternating frames in one window; the cap (40 incl. the 5 above) bounds what peers see.
    for (let i = 0; i < 100; i++) wa.send(JSON.stringify({ type: "typing", on: i % 2 === 0 }));
    await sleep(600);
    expect(frames.length).toBeLessThanOrEqual(40);
    expect(frames.length).toBeGreaterThan(30);
    wa.close(); wb.close();
  });
});
