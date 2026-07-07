/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from "cloudflare:test";
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

/** One stub per chatId (idFromName addresses the room deterministically). */
function stub(chatId: string): DurableObjectStub<Conversation> {
  return CONVERSATION.get(CONVERSATION.idFromName(chatId));
}

/** Open a WebSocket to the DO's fetch() and accept the client end. */
async function connect(chatId: string, userId: string): Promise<WebSocket> {
  const res = await stub(chatId).fetch(
    `https://do/ws?user=${userId}&chat=${chatId}`,
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
});
