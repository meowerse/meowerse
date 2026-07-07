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
  /** The chat's type ('direct'|'group'|'channel'), forwarded by the router from
   *  D1. Only 'channel' changes behavior: a member socket on a channel is
   *  read-only (broadcast — only owner/admin post). Absent → non-channel. */
  type?: string;
}
/** A short quoted snippet of the message a reply points at. */
interface ReplySnippet {
  id: string;
  senderId: string;
  body: string;
}
/** An aggregated reaction on a message: the emoji, how many users reacted with
 *  it, and whether the requesting viewer is one of them (Slice 9). */
interface ReactionAgg {
  emoji: string;
  count: number;
  mine: boolean;
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
  /** Slice 8: true when this message was forwarded from another chat. */
  isForwarded?: boolean;
  /** Slice 9: aggregated emoji reactions on this message (present on history
   *  rows; omitted on the live send/forward Wire, which carries no reactions yet). */
  reactions?: ReactionAgg[];
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
/** Per-connection flood window + cap: at most RATE_MAX `send`s per RATE_WINDOW_MS. */
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 30;
/** Reaction emoji length cap (Slice 9): non-empty, ≤ 8 chars (a couple of
 *  multi-codepoint emoji fit; anything longer is almost certainly abuse). */
const MAX_EMOJI_LEN = 8;
/** Cap on distinct emojis one user may hold on a single message — a toggle that
 *  would exceed this is refused so a user can't spam a message with reactions. */
const MAX_REACTIONS_PER_USER = 12;

/**
 * Escape SQLite LIKE metacharacters in a user-supplied search term (Slice 9). With
 * `ESCAPE '\'`, a literal `\`, `%`, or `_` in the term is prefixed with `\` so it
 * matches itself instead of acting as a wildcard — preventing wildcard injection
 * that would broaden (or slow) the scan. The backslash is escaped FIRST so the
 * escapes added for `%`/`_` aren't themselves re-escaped.
 */
function escapeLike(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * One instance per chat (addressed by chatId via `idFromName`). Holds the room's
 * live WebSockets (Hibernation API — the runtime evicts the DO between events and
 * rehydrates per-connection state from `serializeAttachment`) plus a local
 * SQLite message log. Membership is gated by the router (same worker) before the
 * upgrade reaches here, so the DO trusts the `?user=&chat=` params it receives.
 */
export class Conversation extends DurableObject<Env> {
  /**
   * Per-connection flood protection: recent `send` timestamps keyed by socket.
   * In-memory (dies on hibernation) is fine — a flood keeps the DO awake, and an
   * idle room hibernates with an empty bucket. Only `send` is metered; typing/
   * read/edit/delete are cheap and unmetered. Not reconstructed from
   * getWebSockets() on wake because a hibernated room has, by definition, no
   * in-flight flood to remember.
   */
  private sendTimes = new Map<WebSocket, number[]>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Create the message table once, before any request is served.
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, reply_to_id TEXT, edited_at INTEGER, is_deleted INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER, is_forwarded INTEGER NOT NULL DEFAULT 0);
         CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
         CREATE TABLE IF NOT EXISTS reactions (message_id TEXT NOT NULL, user_id TEXT NOT NULL, emoji TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (message_id, user_id, emoji));
         CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);`,
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
    // Type is likewise router-derived from D1. Only 'channel' matters (read-only
    // for members); a missing/other value leaves posting unchanged (DMs/groups).
    const type = url.searchParams.get("type") || "group";
    if (!userId || !chatId) return new Response("bad ws params", { status: 400 });

    const pair = new WebSocketPair();
    // WebSocketPair is a tuple-shaped { 0: client, 1: server }.
    const client = pair[0];
    const server = pair[1];
    // Accept into the Hibernation API (not server.accept()) so the DO can sleep.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId, chatId, role, type } satisfies Attach);
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
      emoji?: string;
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
    // React: toggle this user's emoji on a live message, broadcast to ALL (Slice 9).
    if (msg.type === "react") {
      this.handleReact(ws, att, msg.id, msg.emoji);
      return;
    }

    if (msg.type !== "send") return;
    // Channel posting rule (Slice 6): a channel is broadcast — only owner/admin
    // post; a plain member is read-only. Server-enforced here (the socket's type +
    // role come from the gated router's D1 read, never the client), so no persist
    // and no broadcast. DMs/groups aren't 'channel', so they're unaffected.
    if (att.type === "channel" && att.role !== "owner" && att.role !== "admin") {
      ws.send(JSON.stringify({ type: "error", code: "read_only" }));
      return;
    }
    // Per-connection flood protection (Slice 8): drop this socket's `send`
    // timestamps older than the window, then refuse if it's already at the cap —
    // no insert, no broadcast, just a {rate_limited} error frame (the socket
    // stays open; a flood is throttled, not disconnected). Metered here so
    // typing/read/edit/delete stay unaffected.
    if (this.isRateLimited(ws)) {
      ws.send(JSON.stringify({ type: "error", code: "rate_limited" }));
      return;
    }
    const body = (msg.body ?? "").trim();
    if (!body || body.length > MAX_BODY) {
      ws.send(JSON.stringify({ type: "error", code: "bad_body" }));
      return;
    }

    // Reply: only honor replyToId if it points at a live (non-deleted) message in
    // THIS room's log. Anything else (missing id, deleted, other room) → null, so a
    // stale/forged reference silently degrades to a plain message.
    let replyToId: string | undefined;
    if (typeof msg.replyToId === "string" && msg.replyToId) replyToId = msg.replyToId;

    this.insertAndBroadcast(att.userId, att.chatId, body, { replyToId, tempId: msg.tempId, ackTo: ws });
  }

  /**
   * Meter a `send` on this socket: prune timestamps older than RATE_WINDOW_MS,
   * then decide. At/over RATE_MAX in the window → true (caller refuses the send,
   * nothing is recorded). Otherwise record `now` and return false. In-memory only
   * (see `sendTimes`).
   */
  private isRateLimited(ws: WebSocket): boolean {
    const now = Date.now();
    const times = (this.sendTimes.get(ws) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (times.length >= RATE_MAX) {
      this.sendTimes.set(ws, times);
      return true;
    }
    times.push(now);
    this.sendTimes.set(ws, times);
    return false;
  }

  /**
   * The shared insert→broadcast path used by both the WS `send` branch and the
   * `appendMessage` RPC (forwarding). Assigns a monotonic created_at, persists the
   * row (with reply link + is_forwarded), builds the Wire, optionally acks the
   * sender's own socket ({sent, tempId, message} — reconciles their optimistic
   * bubble), fans {message} out to every OTHER socket, and mirrors the sidebar
   * preview to D1 off the critical path. Returns the new message id.
   *
   * `opts.ackTo` is the sender's live socket (WS path); when absent (forward RPC —
   * the forwarder may not be connected to the target) nobody is acked and the
   * message goes to ALL sockets. `replyToId` is validated here against THIS room's
   * log; a stale/forged/foreign id degrades to a plain message.
   */
  private insertAndBroadcast(
    senderId: string,
    chatId: string,
    body: string,
    opts: { replyToId?: string; forwarded?: boolean; tempId?: string; ackTo?: WebSocket } = {},
  ): string {
    // Validate the reply target against this room's live log (see above).
    let replyToId: string | null = null;
    let replyTo: ReplySnippet | null = null;
    if (opts.replyToId) {
      const snippet = this.replySnippet(opts.replyToId);
      if (snippet) {
        replyToId = snippet.id;
        replyTo = snippet;
      }
    }
    const forwarded = opts.forwarded === true;

    // Server-monotonic timestamp: DO event handling is serialized, but two sends
    // in the same millisecond would collide on created_at and break the
    // `created_at < cursor` history paging (a message could be skipped at a page
    // boundary). Clamp to strictly-increasing so the timestamp is a stable cursor.
    const last = this.ctx.storage.sql.exec("SELECT MAX(created_at) AS m FROM messages").toArray()[0]?.m;
    const now = Math.max(Date.now(), (last == null ? 0 : Number(last)) + 1);
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (id, sender_id, body, created_at, reply_to_id, is_forwarded) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      senderId,
      body,
      now,
      replyToId,
      forwarded ? 1 : 0,
    );
    const message: Wire = {
      id,
      chatId,
      senderId,
      body,
      createdAt: now,
      replyToId,
      replyTo,
      isForwarded: forwarded,
    };

    // Ack the sender's own socket if given (reconciles their optimistic bubble via
    // tempId), then fan out to every OTHER socket. With no ackTo (forward RPC),
    // the loop below reaches every socket in the room.
    if (opts.ackTo) opts.ackTo.send(JSON.stringify({ type: "sent", tempId: opts.tempId, message }));
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== opts.ackTo) peer.send(JSON.stringify({ type: "message", message }));
    }
    // Off the critical path: mirror the preview + unread bump to D1 for the sidebar.
    // The message is already persisted + broadcast; a failed sidebar mirror is
    // non-critical, so swallow its error rather than surface an unhandled rejection.
    this.ctx.waitUntil(mirrorLastMessage(this.d1(), chatId, body, senderId, now).catch(() => {}));
    return id;
  }

  /**
   * DO RPC (Slice 8): append a message to THIS chat's log on behalf of `senderId`
   * — used by the forward REST handler, which has already gated the caller against
   * the target chat's membership + channel-post rule. No ack socket (the forwarder
   * isn't necessarily connected to the target), so the message fans out to ALL
   * live sockets and mirrors to the sidebar exactly like a normal send. `forwarded`
   * sets is_forwarded so the target renders the "forwarded" badge. Returns the id.
   */
  async appendMessage(senderId: string, body: string, forwarded: boolean): Promise<string> {
    return this.insertAndBroadcast(senderId, this.chatIdOf(), body, { forwarded });
  }

  /**
   * The chatId this DO serves — recovered from any live socket's attachment (all
   * sockets in a room share it). The forward RPC has no request URL to read it
   * from, and the Wire only needs it for the client's own bookkeeping; if the room
   * has no live socket, "" is harmless (the persisted row + mirror don't use it).
   */
  private chatIdOf(): string {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as { chatId?: string } | null;
      if (a?.chatId) return a.chatId;
    }
    return "";
  }

  /** Hibernation handler: a socket closed — mirror the close back and drop it. */
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Recover the closing socket's user before we close it, so we can decide
    // whether that user is now fully offline.
    const att = ws.deserializeAttachment() as Attach | null;
    // Drop this socket's rate bucket so the in-memory Map doesn't leak entries
    // for closed connections.
    this.sendTimes.delete(ws);
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
   * Toggle the caller's `emoji` reaction on message `id` (Slice 9). Validation is
   * server-side: the emoji must be non-empty and ≤ 8 chars, and `id` must refer to
   * a LIVE (not soft-deleted) message in THIS room — a stale/forged/foreign id is
   * silently ignored (no error frame, matching the "degrade quietly" reply rule).
   * Toggle semantics: present → DELETE (on:false); absent → INSERT (on:true), but
   * an INSERT that would push the user past MAX_REACTIONS_PER_USER distinct emojis
   * on this message is refused. On a successful toggle, broadcast
   * {reaction, id, emoji, userId, on} to ALL sockets (incl. the actor, so their
   * own tabs and optimistic UI converge on the authoritative state).
   */
  private handleReact(ws: WebSocket, att: Attach, id: string | undefined, rawEmoji: string | undefined): void {
    const emoji = (rawEmoji ?? "").trim();
    if (!id || !emoji || emoji.length > MAX_EMOJI_LEN) {
      ws.send(JSON.stringify({ type: "error", code: "cannot_react" }));
      return;
    }
    // Only react to a live message in this room — never a soft-deleted or unknown one.
    const target = this.ctx.storage.sql
      .exec("SELECT is_deleted FROM messages WHERE id = ?", id)
      .toArray()[0];
    if (!target || Number(target.is_deleted) === 1) {
      ws.send(JSON.stringify({ type: "error", code: "cannot_react" }));
      return;
    }
    const existing = this.ctx.storage.sql
      .exec("SELECT 1 AS ok FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?", id, att.userId, emoji)
      .toArray()[0];
    let on: boolean;
    if (existing) {
      this.ctx.storage.sql.exec(
        "DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
        id,
        att.userId,
        emoji,
      );
      on = false;
    } else {
      // Cap distinct emojis this user holds on this message.
      const mine = this.ctx.storage.sql
        .exec("SELECT COUNT(*) AS n FROM reactions WHERE message_id = ? AND user_id = ?", id, att.userId)
        .toArray()[0]?.n;
      if (Number(mine ?? 0) >= MAX_REACTIONS_PER_USER) {
        ws.send(JSON.stringify({ type: "error", code: "too_many_reactions" }));
        return;
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)",
        id,
        att.userId,
        emoji,
        Date.now(),
      );
      on = true;
    }
    this.broadcast({ type: "reaction", id, emoji, userId: att.userId, on });
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
  async historyFor(chatId: string, beforeId: string | null, viewerId?: string): Promise<Wire[]> {
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
      "m.id, m.sender_id, m.body, m.created_at, m.reply_to_id, m.edited_at, m.is_deleted, m.is_forwarded," +
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
    const wires = rows.map((r: Row) => this.rowToWire(r, chatId)).reverse();
    this.attachReactions(wires, viewerId);
    return wires;
  }

  /**
   * Aggregate reactions for a page of Wires in one pass and attach a `reactions`
   * array to each. Queries the reactions table for exactly the page's message ids
   * (a single `IN (...)` scan), tallies each emoji's count, and marks `mine` when
   * the `viewerId` is among that emoji's reactors. A message with no reactions gets
   * an empty array. Mutates the Wires in place. No-op for an empty page.
   */
  private attachReactions(wires: Wire[], viewerId?: string): void {
    if (wires.length === 0) return;
    const ids = wires.map((w) => w.id);
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT message_id, emoji, COUNT(*) AS n,` +
          ` SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine` +
          ` FROM reactions WHERE message_id IN (${placeholders})` +
          ` GROUP BY message_id, emoji ORDER BY MIN(created_at) ASC`,
        viewerId ?? "",
        ...ids,
      )
      .toArray();
    const byMessage = new Map<string, ReactionAgg[]>();
    for (const r of rows) {
      const mid = String(r.message_id);
      const list = byMessage.get(mid) ?? [];
      list.push({ emoji: String(r.emoji), count: Number(r.n), mine: Number(r.mine ?? 0) > 0 });
      byMessage.set(mid, list);
    }
    for (const w of wires) w.reactions = byMessage.get(w.id) ?? [];
  }

  /**
   * DO RPC (Slice 9): within-chat message search. Returns up to `limit` non-deleted
   * messages whose body contains `query` (case-insensitive via SQLite LIKE, which
   * is ASCII-case-insensitive), newest-first, as Wires (with reactions aggregated
   * for `viewerId`). The query is LIKE-escaped — `%`, `_`, and the escape char `\`
   * are neutralized (ESCAPE '\') so a user's literal wildcards match literally and
   * can't broaden the scan. An empty/blank query returns []. Membership is gated at
   * the route (only a member's request reaches this RPC).
   */
  async search(query: string, viewerId?: string, limit = 30): Promise<Wire[]> {
    const q = (query ?? "").trim();
    if (!q) return [];
    const capped = Math.max(1, Math.min(Number(limit) || 30, 100));
    const pattern = `%${escapeLike(q)}%`;
    const cols =
      "m.id, m.sender_id, m.body, m.created_at, m.reply_to_id, m.edited_at, m.is_deleted, m.is_forwarded," +
      " r.id AS reply_id, r.sender_id AS reply_sender, r.body AS reply_body, r.is_deleted AS reply_is_deleted";
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT ${cols} FROM messages m LEFT JOIN messages r ON m.reply_to_id = r.id` +
          " WHERE m.is_deleted = 0 AND m.body LIKE ? ESCAPE '\\' ORDER BY m.created_at DESC LIMIT ?",
        pattern,
        capped,
      )
      .toArray();
    const chatId = this.chatIdOf();
    const wires = rows.map((r: Row) => this.rowToWire(r, chatId));
    this.attachReactions(wires, viewerId);
    return wires;
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
      isForwarded: Number(r.is_forwarded) === 1,
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
