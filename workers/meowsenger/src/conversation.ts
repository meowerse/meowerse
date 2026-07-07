import { DurableObject } from "cloudflare:workers";
import type { DbClient, Env, Row } from "./types";
import { mirrorLastMessage } from "./chats";

/** Per-connection metadata stashed on the socket (survives hibernation). */
interface Attach {
  userId: string;
  chatId: string;
}
/** A message as it goes over the wire / out of history (see Shared contracts §6). */
interface Wire {
  id: string;
  chatId: string;
  senderId: string;
  body: string;
  createdAt: number;
}

const MAX_BODY = 4000;
const HISTORY_PAGE = 50;

/**
 * One instance per chat (addressed by chatId via `idFromName`). Holds the room's
 * live WebSockets (Hibernation API — the runtime evicts the DO between events and
 * rehydrates per-connection state from `serializeAttachment`) plus a local
 * SQLite message log. Membership is gated by the router (same worker) before the
 * upgrade reaches here, so the DO trusts the `?user=&chat=` params it receives.
 */
export class Conversation extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Create the message table once, before any request is served.
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);`,
      );
    });
    // Answer keepalive ping/pong in the runtime without waking the DO.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Router forwards the upgrade here with ?user=<id>&chat=<id> (already gated). */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const userId = url.searchParams.get("user");
    const chatId = url.searchParams.get("chat");
    if (!userId || !chatId) return new Response("bad ws params", { status: 400 });

    const pair = new WebSocketPair();
    // WebSocketPair is a tuple-shaped { 0: client, 1: server }.
    const client = pair[0];
    const server = pair[1];
    // Accept into the Hibernation API (not server.accept()) so the DO can sleep.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId, chatId } satisfies Attach);
    server.send(JSON.stringify({ type: "ready", chatId, you: userId }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Hibernation handler: a frame arrived on a live socket. */
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attach | null;
    if (!att) return;
    let msg: { type?: string; tempId?: string; body?: string };
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : "");
    } catch {
      return;
    }
    if (msg.type !== "send") return;
    const body = (msg.body ?? "").trim();
    if (!body || body.length > MAX_BODY) {
      ws.send(JSON.stringify({ type: "error", code: "bad_body" }));
      return;
    }

    const now = Date.now();
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (id, sender_id, body, created_at) VALUES (?, ?, ?, ?)",
      id,
      att.userId,
      body,
      now,
    );
    const message: Wire = { id, chatId: att.chatId, senderId: att.userId, body, createdAt: now };

    // Ack the sender (reconciles their optimistic bubble via tempId), then fan
    // out to every other socket in the room.
    ws.send(JSON.stringify({ type: "sent", tempId: msg.tempId, message }));
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) peer.send(JSON.stringify({ type: "message", message }));
    }
    // Off the critical path: mirror the preview + unread bump to D1 for the sidebar.
    this.ctx.waitUntil(mirrorLastMessage(this.d1(), att.chatId, body, att.userId, now));
  }

  /** Hibernation handler: a socket closed — mirror the close back and drop it. */
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
    }
  }

  /**
   * History page for the chat's own SQLite log — called over RPC by the REST
   * `GET /api/chats/:id/messages` handler (Task 5). `chatId` is passed in
   * explicitly (not recovered from a live socket) so it works even with no
   * connections open. Returns up to 50 messages ascending; pass `beforeId` to
   * page backwards from an earlier message.
   */
  async historyFor(chatId: string, beforeId: string | null): Promise<Wire[]> {
    let cursor: number | undefined;
    if (beforeId) {
      const at = this.ctx.storage.sql
        .exec("SELECT created_at FROM messages WHERE id = ?", beforeId)
        .toArray()[0]?.created_at;
      cursor = at == null ? undefined : Number(at);
    }
    const rows =
      cursor != null
        ? this.ctx.storage.sql
            .exec(
              "SELECT * FROM messages WHERE created_at < ? ORDER BY created_at DESC LIMIT ?",
              cursor,
              HISTORY_PAGE,
            )
            .toArray()
        : this.ctx.storage.sql
            .exec("SELECT * FROM messages ORDER BY created_at DESC LIMIT ?", HISTORY_PAGE)
            .toArray();
    // Rows come newest-first (for the LIMIT); flip to chronological for the UI.
    return rows
      .map((r: Row) => ({
        id: String(r.id),
        chatId,
        senderId: String(r.sender_id),
        body: String(r.body),
        createdAt: Number(r.created_at),
      }))
      .reverse();
  }

  /**
   * Minimal D1 adapter (same shape as `d1Client` in db.ts) for the mirror write.
   * The DO only ever needs `run`; `all`/`first` are stubbed to satisfy DbClient.
   */
  private d1(): DbClient {
    const db = this.env.DB;
    return {
      all: async () => [],
      first: async () => undefined,
      run: async (sql: string, params: unknown[] = []) => {
        await db
          .prepare(sql)
          .bind(...params)
          .run();
      },
    };
  }
}
