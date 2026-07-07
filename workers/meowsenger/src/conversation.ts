import { DurableObject } from "cloudflare:workers";
import type { DbClient, Env, Row } from "./types";
import { markRead, mirrorLastMessage } from "./chats";

/** Per-connection metadata stashed on the socket (survives hibernation). */
interface Attach {
  userId: string;
  chatId: string;
  /** The user's role in THIS chat, forwarded (already gated) by the router. Used
   *  for admin/owner message-delete. DM sockets carry 'member' → no behavior
   *  change for DMs. Absent on legacy sockets → treated as 'member'. */
  role?: string;
}
/** A short quoted snippet of the message a reply points at. */
interface ReplySnippet {
  id: string;
  senderId: string;
  body: string;
}
/** A message as it goes over the wire / out of history (see Shared contracts §6). */
interface Wire {
  id: string;
  chatId: string;
  senderId: string;
  body: string;
  createdAt: number;
  replyToId?: string | null;
  replyTo?: ReplySnippet | null;
  editedAt?: number | null;
  isDeleted?: boolean;
}

const MAX_BODY = 4000;
const HISTORY_PAGE = 50;
/** How long the reply quote-preview keeps of the original body. */
const REPLY_SNIPPET = 120;
/** Own-message edit window (1h) and delete window (24h). */
const EDIT_WINDOW_MS = 3600_000;
const DELETE_WINDOW_MS = 24 * 3600_000;
/** How long a soft-deleted row lingers before the alarm hard-purges it. */
const PURGE_AFTER_MS = 24 * 3600_000;

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
        `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, reply_to_id TEXT, edited_at INTEGER, is_deleted INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER);
         CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);`,
      );
    });
    // Answer keepalive ping/pong in the runtime without waking the DO.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Router forwards the upgrade here with ?user=<id>&chat=<id>&role=<role> (already gated). */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const userId = url.searchParams.get("user");
    const chatId = url.searchParams.get("chat");
    // Role is trusted here because ONLY the gated router path can reach the DO,
    // and it derives the role from D1 (never from the client). Default 'member'
    // for legacy/DM sockets so behavior is unchanged when it's absent.
    const role = url.searchParams.get("role") || "member";
    if (!userId || !chatId) return new Response("bad ws params", { status: 400 });

    const pair = new WebSocketPair();
    // WebSocketPair is a tuple-shaped { 0: client, 1: server }.
    const client = pair[0];
    const server = pair[1];
    // Accept into the Hibernation API (not server.accept()) so the DO can sleep.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId, chatId, role } satisfies Attach);
    server.send(JSON.stringify({ type: "ready", chatId, you: userId }));

    // Presence: derive who was online BEFORE this socket joined (exclude the
    // just-accepted `server` so a reconnecting user's own new socket doesn't hide
    // a genuine transition). Tell the new socket the current roster, and — only if
    // this user wasn't already present — announce them coming online to the peers.
    const before = this.onlineUsers(server);
    server.send(JSON.stringify({ type: "presence_snapshot", online: before }));
    if (!before.includes(userId)) {
      this.broadcast({ type: "presence", userId, online: true }, server);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Distinct userIds with ≥1 live socket, optionally excluding one socket (a
   * closing one, or a just-accepted one). Derives ONLY from `getWebSockets()` +
   * serialized attachments, so it survives DO hibernation/eviction — never an
   * in-memory Map (which dies on wake).
   */
  private onlineUsers(except?: WebSocket): string[] {
    const s = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment() as { userId?: string } | null;
      if (a?.userId) s.add(a.userId);
    }
    return [...s];
  }

  /** Send a JSON frame to every live socket, optionally excluding one. */
  private broadcast(obj: unknown, except?: WebSocket): void {
    const text = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) ws.send(text);
  }

  /** Hibernation handler: a frame arrived on a live socket. */
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attach | null;
    if (!att) return;
    let msg: {
      type?: string;
      tempId?: string;
      body?: string;
      on?: boolean;
      upTo?: number;
      id?: string;
      replyToId?: string | null;
    };
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : "");
    } catch {
      return;
    }

    // Typing: ephemeral, peers-only, never persisted.
    if (msg.type === "typing") {
      this.broadcast({ type: "typing", userId: att.userId, on: !!msg.on }, ws);
      return;
    }
    // Read receipt: clear this member's unread + advance last_read_at in D1 (off
    // the critical path — a failed write is non-fatal), then tell peers "seen".
    if (msg.type === "read") {
      const upTo = Number(msg.upTo) || 0;
      this.ctx.waitUntil(markRead(this.d1(), att.chatId, att.userId, upTo).catch(() => {}));
      this.broadcast({ type: "read_receipt", userId: att.userId, upTo }, ws);
      return;
    }

    // Edit: own message, within the 1h window, not soft-deleted. All checks are
    // server-side — never trust the client's view of ownership or the clock.
    if (msg.type === "edit") {
      this.handleEdit(ws, att, msg.id, msg.body);
      return;
    }
    // Delete: own message, within the 24h window, soft (keep the row + placeholder).
    if (msg.type === "delete") {
      this.handleDelete(ws, att, msg.id);
      return;
    }

    if (msg.type !== "send") return;
    const body = (msg.body ?? "").trim();
    if (!body || body.length > MAX_BODY) {
      ws.send(JSON.stringify({ type: "error", code: "bad_body" }));
      return;
    }

    // Reply: only honor replyToId if it points at a live (non-deleted) message in
    // THIS room's log. Anything else (missing id, deleted, other room) → null, so a
    // stale/forged reference silently degrades to a plain message.
    let replyToId: string | null = null;
    let replyTo: ReplySnippet | null = null;
    if (typeof msg.replyToId === "string" && msg.replyToId) {
      const snippet = this.replySnippet(msg.replyToId);
      if (snippet) {
        replyToId = snippet.id;
        replyTo = snippet;
      }
    }

    // Server-monotonic timestamp: DO event handling is serialized, but two sends
    // in the same millisecond would collide on created_at and break the
    // `created_at < cursor` history paging (a message could be skipped at a page
    // boundary). Clamp to strictly-increasing so the timestamp is a stable cursor.
    const last = this.ctx.storage.sql.exec("SELECT MAX(created_at) AS m FROM messages").toArray()[0]?.m;
    const now = Math.max(Date.now(), (last == null ? 0 : Number(last)) + 1);
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (id, sender_id, body, created_at, reply_to_id) VALUES (?, ?, ?, ?, ?)",
      id,
      att.userId,
      body,
      now,
      replyToId,
    );
    const message: Wire = {
      id,
      chatId: att.chatId,
      senderId: att.userId,
      body,
      createdAt: now,
      replyToId,
      replyTo,
    };

    // Ack the sender (reconciles their optimistic bubble via tempId), then fan
    // out to every other socket in the room.
    ws.send(JSON.stringify({ type: "sent", tempId: msg.tempId, message }));
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) peer.send(JSON.stringify({ type: "message", message }));
    }
    // Off the critical path: mirror the preview + unread bump to D1 for the sidebar.
    // The message is already persisted + broadcast; a failed sidebar mirror is
    // non-critical, so swallow its error rather than surface an unhandled rejection.
    this.ctx.waitUntil(mirrorLastMessage(this.d1(), att.chatId, body, att.userId, now).catch(() => {}));
  }

  /** Hibernation handler: a socket closed — mirror the close back and drop it. */
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Recover the closing socket's user before we close it, so we can decide
    // whether that user is now fully offline.
    const att = ws.deserializeAttachment() as Attach | null;
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
    }
    // Presence: only announce offline if this user has NO other live socket. The
    // exclude-and-recheck (`onlineUsers(ws)` skips the closing socket) means a
    // multi-tab user closing ONE tab doesn't flap offline while another remains.
    if (att?.userId && !this.onlineUsers(ws).includes(att.userId)) {
      this.broadcast({ type: "presence", userId: att.userId, online: false }, ws);
    }
  }

  /**
   * Look up a message in THIS room's log and return the reply quote-preview
   * ({id, senderId, body-truncated}). Returns null if the id is unknown or the
   * target is soft-deleted — a reply must point at a live message.
   */
  private replySnippet(id: string): ReplySnippet | null {
    const r = this.ctx.storage.sql
      .exec("SELECT id, sender_id, body, is_deleted FROM messages WHERE id = ?", id)
      .toArray()[0];
    if (!r || Number(r.is_deleted) === 1) return null;
    return {
      id: String(r.id),
      senderId: String(r.sender_id),
      body: String(r.body).slice(0, REPLY_SNIPPET),
    };
  }

  /**
   * Edit an own message within the 1h window. Ownership + window + not-deleted are
   * all enforced here against the stored row — the client's claims are ignored.
   * On success, broadcast {edited} to ALL sockets (incl. the sender) so a user's
   * other tabs converge; on any failure, reply {error, cannot_edit} to the sender.
   */
  private handleEdit(ws: WebSocket, att: Attach, id: string | undefined, rawBody: string | undefined): void {
    const body = (rawBody ?? "").trim();
    if (!id || !body || body.length > MAX_BODY) {
      ws.send(JSON.stringify({ type: "error", code: "cannot_edit" }));
      return;
    }
    const row = this.ctx.storage.sql
      .exec("SELECT sender_id, created_at, is_deleted FROM messages WHERE id = ?", id)
      .toArray()[0];
    const own = row && String(row.sender_id) === att.userId;
    const within = row && Date.now() - Number(row.created_at) <= EDIT_WINDOW_MS;
    if (!row || Number(row.is_deleted) === 1 || !own || !within) {
      ws.send(JSON.stringify({ type: "error", code: "cannot_edit" }));
      return;
    }
    const editedAt = Date.now();
    this.ctx.storage.sql.exec("UPDATE messages SET body = ?, edited_at = ? WHERE id = ?", body, editedAt, id);
    this.broadcast({ type: "edited", id, body, editedAt });
  }

  /**
   * Soft-delete a message. Allowed when EITHER the caller owns it and it's within
   * the 24h window (Slice 4), OR the caller is an owner/admin of the chat (Slice 5
   * — any message, any age; a group moderation power). The role is taken from the
   * socket's Attach (set by the gated router from D1), never from the client.
   * not-already-deleted is enforced against the stored row. The row survives with
   * is_deleted=1 + blank body (history renders a placeholder); an alarm hard-purges
   * it once it ages out. Broadcast {deleted} to ALL; on failure {error, cannot_delete}.
   */
  private handleDelete(ws: WebSocket, att: Attach, id: string | undefined): void {
    if (!id) {
      ws.send(JSON.stringify({ type: "error", code: "cannot_delete" }));
      return;
    }
    const row = this.ctx.storage.sql
      .exec("SELECT sender_id, created_at, is_deleted FROM messages WHERE id = ?", id)
      .toArray()[0];
    const own = row && String(row.sender_id) === att.userId;
    const within = row && Date.now() - Number(row.created_at) <= DELETE_WINDOW_MS;
    const isAdmin = att.role === "owner" || att.role === "admin";
    // Own+recent OR moderator. Admins may delete any message at any time.
    const allowed = (own && within) || isAdmin;
    if (!row || Number(row.is_deleted) === 1 || !allowed) {
      ws.send(JSON.stringify({ type: "error", code: "cannot_delete" }));
      return;
    }
    this.ctx.storage.sql.exec(
      "UPDATE messages SET is_deleted = 1, deleted_at = ?, body = '' WHERE id = ?",
      Date.now(),
      id,
    );
    this.broadcast({ type: "deleted", id });
    // Schedule the hard purge for just after this row ages out of the window.
    this.ctx.storage.setAlarm(Date.now() + PURGE_AFTER_MS + 60_000);
  }

  /**
   * Hard-purge soft-deleted rows that have aged past the 24h window (reclaims DO
   * SQLite space; no VACUUM per spec §9). If any soft-deleted rows remain (deleted
   * more recently), re-arm the alarm to purge them once they too age out.
   */
  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec(
      "DELETE FROM messages WHERE is_deleted = 1 AND deleted_at < ?",
      Date.now() - PURGE_AFTER_MS,
    );
    const remaining = this.ctx.storage.sql
      .exec("SELECT MIN(deleted_at) AS oldest FROM messages WHERE is_deleted = 1")
      .toArray()[0]?.oldest;
    if (remaining != null) {
      this.ctx.storage.setAlarm(Number(remaining) + PURGE_AFTER_MS + 60_000);
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
    // LEFT JOIN the reply target so each row carries its quote-preview (reply_*).
    // A soft-deleted target yields no snippet (the join keeps the row but we drop
    // the preview below). Deleted rows themselves stay in the page as placeholders.
    const cols =
      "m.id, m.sender_id, m.body, m.created_at, m.reply_to_id, m.edited_at, m.is_deleted," +
      " r.id AS reply_id, r.sender_id AS reply_sender, r.body AS reply_body, r.is_deleted AS reply_is_deleted";
    const rows =
      cursor != null
        ? this.ctx.storage.sql
            .exec(
              `SELECT ${cols} FROM messages m LEFT JOIN messages r ON m.reply_to_id = r.id` +
                " WHERE m.created_at < ? ORDER BY m.created_at DESC LIMIT ?",
              cursor,
              HISTORY_PAGE,
            )
            .toArray()
        : this.ctx.storage.sql
            .exec(
              `SELECT ${cols} FROM messages m LEFT JOIN messages r ON m.reply_to_id = r.id` +
                " ORDER BY m.created_at DESC LIMIT ?",
              HISTORY_PAGE,
            )
            .toArray();
    // Rows come newest-first (for the LIMIT); flip to chronological for the UI.
    return rows.map((r: Row) => this.rowToWire(r, chatId)).reverse();
  }

  /** Map a joined history row to the wire shape (deleted → placeholder, reply snippet). */
  private rowToWire(r: Row, chatId: string): Wire {
    const deleted = Number(r.is_deleted) === 1;
    // A reply preview only if the target still exists and isn't soft-deleted.
    const replyTo: ReplySnippet | null =
      r.reply_id != null && Number(r.reply_is_deleted) !== 1
        ? {
            id: String(r.reply_id),
            senderId: String(r.reply_sender),
            body: String(r.reply_body).slice(0, REPLY_SNIPPET),
          }
        : null;
    return {
      id: String(r.id),
      chatId,
      senderId: String(r.sender_id),
      body: deleted ? "" : String(r.body),
      createdAt: Number(r.created_at),
      replyToId: r.reply_to_id == null ? null : String(r.reply_to_id),
      replyTo,
      editedAt: r.edited_at == null ? null : Number(r.edited_at),
      isDeleted: deleted,
    };
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
