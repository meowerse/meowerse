/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
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
});

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

  it("read → peer gets read_receipt and D1 chat_members is cleared/advanced", async () => {
    await seedChat("c11");
    await seedChatMember("c11", "u1", 3); // u1 has 3 unread to clear
    const wa = await connect("c11", "u1");
    const wb = await connect("c11", "u2");

    const peerGot = waitFor(wb, (t) => t.includes("read_receipt") && t.includes('"u1"'));
    wa.send(JSON.stringify({ type: "read", upTo: 5000 }));

    const peerText = await peerGot;
    expect(JSON.parse(peerText)).toMatchObject({ type: "read_receipt", userId: "u1", upTo: 5000 });

    // markRead runs in waitUntil, so poll D1 for the cleared/advanced state.
    let row: { unread_count: number; last_read_at: number | null } | null = null;
    for (let i = 0; i < 20; i++) {
      row = await DB.prepare("SELECT unread_count, last_read_at FROM chat_members WHERE chat_id = ? AND user_id = ?")
        .bind("c11", "u1")
        .first<{ unread_count: number; last_read_at: number | null }>();
      if (row && row.unread_count === 0 && row.last_read_at === 5000) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(row?.unread_count).toBe(0);
    expect(row?.last_read_at).toBe(5000);

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
    });
  });
});
