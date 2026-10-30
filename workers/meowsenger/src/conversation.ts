import { DurableObject } from "cloudflare:workers";
import { MAX_MESSAGE_BODY } from "@meowerse/ts-shared";
import type { DbClient, Env, Row } from "./types";
import { markRead, mirrorLastMessage, chatMemberIds } from "./chats";
import { touchLastSeen } from "./users";
import { d1Client } from "./db";
import { pushTargetsForChat, sendPush, importVapidKey, deleteDeadPushSubscription, pushHostFamily } from "./push";

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
  /** True while this tab is backgrounded/hidden (the client sends {type:"away"} on
   *  visibilitychange). A user is shown "away" (not "online") when ALL their sockets
   *  are away. Absent → not away. */
  away?: boolean;
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

/** Max message body length — the single source is `@meowerse/ts-shared` (shared with
 *  the REST forward handler) so the DO and the API can never drift apart. */
const MAX_BODY = MAX_MESSAGE_BODY;
const HISTORY_PAGE = 50;
/** Half-window size for a centered `historyAround` page: up to this many messages
 *  on each side of (and including) the anchor, so a deep-link lands with context. */
const AROUND_HALF = 25;
/** The message columns every history/search query selects, including the LEFT JOIN
 *  reply-preview columns. Kept in ONE place so history (before/after/around) and
 *  search can never drift apart when a column is added. Used with the same
 *  `FROM messages m LEFT JOIN messages r ON m.reply_to_id = r.id` join. */
const HISTORY_COLS =
  "m.id, m.sender_id, m.body, m.created_at, m.reply_to_id, m.edited_at, m.is_deleted, m.is_forwarded," +
  " r.id AS reply_id, r.sender_id AS reply_sender, r.body AS reply_body, r.is_deleted AS reply_is_deleted";
/** How long the reply quote-preview keeps of the original body. */
const REPLY_SNIPPET = 120;
/** Own-message edit window (1h) and delete window (24h). */
const EDIT_WINDOW_MS = 3600_000;
const DELETE_WINDOW_MS = 24 * 3600_000;
/** How long a soft-deleted row lingers before the alarm hard-purges it. */
const PURGE_AFTER_MS = 24 * 3600_000;
/** Per-connection flood window + cap: at most RATE_MAX `send`s per RATE_WINDOW_MS.
 *  The same window+cap meters the forward RPC (`appendMessage`), keyed by user. */
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 30;
/** Coalesce Web Push per chat: at most one offline fan-out (D1 read + POSTs) per
 *  this window. A tickle only needs to say "something happened"; the recipient's SW
 *  fetches the details. Skips the per-message D1 read on a busy channel. */
const PUSH_DEBOUNCE_MS = 30_000;
/** Two independent per-invocation subrequest budgets (Cloudflare limits page, Oct 2026,
 *  Free plan): external `fetch()` subrequests are capped at 50; "subrequests to internal
 *  services" (DO stub fetches) have a SEPARATE cap of 1,000.
 *  EXTERNAL: Web Push POSTs, plus D1 queries counted conservatively (the docs list D1
 *  ambiguously). 45 keeps headroom under 50.
 *  INTERNAL: UserInbox /notify DO fetches. 900 keeps headroom under 1,000. */
const EXTERNAL_BUDGET = 45;
const INTERNAL_BUDGET = 900;
/** After a transient push failure (429/5xx/network) a recipient becomes eligible again
 *  this long after the failure — not immediately, not after the full window. */
const PUSH_RETRY_MS = 10_000;

/** Subrequests spent so far in ONE invocation, per budget. `ext`: mirror write, member
 *  read, push-target read, push sends, prunes (counted synchronously). `int`: inbox DO
 *  fetches. */
interface SubBudget { ext: number; int: number }

/** Max follow-up (alarm) rounds that may make NO progress (or fail) before the queued
 *  work is dropped (logged, counts only): the next message re-queues it and the client's
 *  45 s sidebar poll covers the sidebar. Rounds that make progress do not count: each is
 *  bounded by the per-invocation budgets and the DO serves other events between alarms. */
const MAX_FOLLOWUPS = 5;
/** Hard safety ceiling on TOTAL rounds per queued batch (progress or not), logged when hit. */
const MAX_TOTAL_ROUNDS = 50;
/** Max delivery attempts per recipient per queued batch (the first send counts as one);
 *  transient failures (429/5xx/network) are retried until then, then dropped. */
const MAX_PUSH_ATTEMPTS = 3;
/** Pending fan-out work persisted in DO storage: recipient ids and the chat id only
 *  (never message text, endpoints or keys). `seq` increments on every queueOverflow so
 *  a running follow-up can tell that new work arrived while it awaited. `attempts` /
 *  `notBefore` (push recipients only): failed delivery attempts so far, and the earliest
 *  time a transiently-failed recipient may be retried. `rounds` = no-progress rounds,
 *  `total` = all rounds. */
interface Overflow {
  chatId: string; push: string[]; inbox: string[];
  attempts: Record<string, number>; notBefore: Record<string, number>;
  rounds: number; total: number; seq: number;
}
/** What one push round hands back: `cut` = not reached (budget), `retry` = transient
 *  failures with their attempt count so far, `dropped` = recipients out of attempts. */
interface PushResult { cut: string[]; retry: Record<string, number>; dropped: number }
const OVERFLOW_KEY = "fanout_overflow";
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
  // Same flood meter for the forward RPC (`appendMessage`), keyed by userId — the
  // forwarder has no socket, so it can't use `sendTimes`. In-memory/best-effort
  // (dies on hibernation, like `sendTimes`); all forwards to THIS chat funnel through
  // this one DO, so it bounds per-user forward volume + the push fan-out it triggers.
  private appendTimes = new Map<string, number[]>();
  // Last time (ms) we wrote each user's last_seen_at, to debounce that D1 write to
  // ~once/60s per user (see handleDisconnect). Bounded by this chat's member count.
  private lastSeenStamp = new Map<string, number>();
  // Per-RECIPIENT push window: userId → time (ms) we last reserved a Web Push for them,
  // to coalesce pushes to ~once/PUSH_DEBOUNCE_MS per user (see pushOffline). Reserved
  // synchronously (before any await) so a concurrent burst can't double-push; cleared
  // when the user next has an active socket here (they have seen the chat). Bounded by
  // this chat's member count.
  private lastPush = new Map<string, number>();

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
    this.lastPush.delete(userId); // a fresh socket is visible: they're seeing the chat → reset their push window
    server.send(JSON.stringify({ type: "ready", chatId, you: userId }));

    // Presence: derive who was online BEFORE this socket joined (exclude the
    // just-accepted `server` so a reconnecting user's own new socket doesn't hide
    // a genuine transition). Tell the new socket the current roster, and — only if
    // this user wasn't already present — announce them coming online to the peers.
    const before = this.onlineUsers(server);
    server.send(JSON.stringify({ type: "presence_snapshot", online: before, away: this.awayUsers(server) }));
    if (!before.includes(userId)) {
      // A brand-new connection is visible/online (the client sends {away:true} if the
      // tab is actually hidden); if the user was already present-but-away elsewhere,
      // this fresh socket makes them active → away:false is correct.
      this.broadcast({ type: "presence", userId, online: true, away: false }, server);
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

  /** Users with at least one NON-away socket in this room (the chat is on screen
   *  somewhere for them). Same hibernation-safe derivation as onlineUsers. */
  private activeUsers(): string[] {
    const active = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a?.userId && !a.away) active.add(a.userId);
    }
    return [...active];
  }

  /** Users who are online (≥1 socket) but whose EVERY socket is `away` (all their
   *  tabs backgrounded) — shown as "away" rather than "online". Same hibernation-safe
   *  derivation as onlineUsers. */
  private awayUsers(except?: WebSocket): string[] {
    const all = new Set<string>();
    const active = new Set<string>(); // has ≥1 NON-away socket
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment() as Attach | null;
      if (!a?.userId) continue;
      all.add(a.userId);
      if (!a.away) active.add(a.userId);
    }
    return [...all].filter((u) => !active.has(u));
  }

  /** Send a text frame to one socket, swallowing the synchronous "send after close"
   *  TypeError workerd throws when a socket has closed underneath us (a broadcast can
   *  race a peer's close — dropping the frame for a gone socket is correct). */
  private safeSend(ws: WebSocket, text: string): void {
    try { ws.send(text); } catch { /* socket closed/closing — drop the frame */ }
  }

  /** Send a JSON frame to every live socket, optionally excluding one. */
  private broadcast(obj: unknown, except?: WebSocket): void {
    const text = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) this.safeSend(ws, text);
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
      away?: boolean;
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
    // Away/back: record this tab's visibility on its attachment, then broadcast the
    // user's DERIVED status (away iff ALL their sockets are away). Peers-only.
    if (msg.type === "away") {
      ws.serializeAttachment({ ...att, away: !!msg.away });
      if (!msg.away) this.lastPush.delete(att.userId); // back on screen → reset their push window
      this.broadcast({ type: "presence", userId: att.userId, online: true, away: this.awayUsers().includes(att.userId) }, ws);
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
    // the loop below reaches every socket in the room. Serialize the message frame
    // ONCE (not per-recipient) — this is the hottest path in the app (every live
    // send); the identical multi-KB Wire is broadcast to all peers verbatim.
    if (opts.ackTo) this.safeSend(opts.ackTo, JSON.stringify({ type: "sent", tempId: opts.tempId, message }));
    const frame = JSON.stringify({ type: "message", message });
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== opts.ackTo) this.safeSend(peer, frame);
    }
    // Off the critical path: mirror the preview to D1, notify all members' UserInbox DOs
    // and send Web Push. The mirror write is its OWN promise: the inbox fan-out waits for
    // it (a client that refetches on a notification must see the new last_activity), and
    // fanPush waits for it just before the first push is sent (the service worker builds
    // the notification from /api/chats, and unread state depends on chats.last_activity).
    // Nothing awaits the whole inbox fan-out before pushing.
    // External: the mirror write + the member read (reserved up front, even when the
    // member list is cached, so push sizing never depends on the inbox fan-out's timing).
    const budget: SubBudget = { ext: 2, int: 0 };
    const mirror: Promise<void> = (async () => {
      try {
        await mirrorLastMessage(this.d1(), chatId, body, senderId, now);
      } catch {}
    })();
    const sidebar = (async (): Promise<string[]> => {
      await mirror;
      try {
        return await this.inboxFanout(chatId, senderId, message, budget);
      } catch {
        return [];
      }
    })();
    // Web Push: notify members with NO active socket in this room (offline, busy in
    // another chat, or backgrounded) — their service worker decides whether to show it.
    // Whatever the per-invocation budget cut off (or a transient failure) continues from
    // the DO alarm.
    this.ctx.waitUntil(
      (async () => {
        const push = await this.pushOffline(chatId, senderId, budget, mirror).catch((): PushResult => ({ cut: [], retry: {}, dropped: 0 }));
        const inboxLeft = await sidebar;
        await this.queueOverflow(chatId, senderId, push.cut, inboxLeft, push.retry).catch(() => {});
      })(),
    );
    return id;
  }

  /**
   * Push a `{chatId, preview, at, senderId}` sidebar delta to the UserInbox DO of
   * all chat members. An inbox DO with no open socket is an immediate 204 no-op,
   * while any tab or window the user has open (including other devices) receives
   * the real-time sidebar delta.
   * Member ids are cached ~5s per chat so a busy room doesn't read chat_members on
   * every message; a just-joined member starts getting deltas within that window.
   * `dropUser` (removal/leave/demotion) clears the cache and bumps a generation; a
   * member read that overlapped it is discarded and re-read, never cached. A removed
   * member therefore gets no preview from a message sent after the REST handler
   * returns (a message already mid-fan-out may still reach them: it predates the removal).
   */
  private inboxMembers = new Map<string, { ids: string[]; at: number }>();
  /** Bumped by dropUser; a member read that raced a removal must not be cached/used. */
  private membershipGen = 0;
  /** Per-invocation internal (DO fetch) budget; an instance field only so tests can
   *  lower it (not production configuration). */
  private internalBudget = INTERNAL_BUDGET;
  private async inboxFanout(chatId: string, senderId: string, message: Wire, budget: SubBudget): Promise<string[]> {
    const ns = this.env.USER_INBOX;
    if (!ns) return []; // binding not configured (older deploy / tests)
    const cached = this.inboxMembers.get(chatId);
    const now = Date.now();
    let ids: string[];
    if (cached && now - cached.at < 5000) {
      ids = cached.ids;
    } else {
      // A read that overlaps a membership change (dropUser bumps the generation) may
      // hold the removed member: discard it and re-read once, and never cache it.
      for (let attempt = 0; ; attempt++) {
        const gen = this.membershipGen;
        if (attempt > 0) budget.ext++; // the re-read (the first read is reserved by the caller)
        ids = await chatMemberIds(this.d1(), chatId);
        if (gen === this.membershipGen) {
          this.inboxMembers.set(chatId, { ids, at: now });
          break;
        }
        if (attempt >= 1) return []; // still racing: skip this preview rather than leak it
      }
    }
    if (ids.length === 0) return [];
    const body = JSON.stringify({
      chatId,
      preview: message.body.slice(0, 140),
      at: message.createdAt,
      senderId,
      forwarded: message.isForwarded,
    });
    // Every member gets a preview up to the INTERNAL budget; members beyond it are
    // returned and get a content-free invalidation from a follow-up.
    const take = Math.max(0, this.internalBudget - budget.int);
    const bounded = ids.slice(0, take);
    budget.int += bounded.length;
    await Promise.all(
      bounded.map((id) =>
        ns.get(ns.idFromName("inbox:" + id)).fetch("https://do/notify", { method: "POST", body }).catch(() => {}),
      ),
    );
    return ids.slice(take);
  }

  /**
   * Send a payloadless Web Push to every subscription of a chat member who is not the
   * sender and has no ACTIVE (non-away) socket in this room — offline, busy in another
   * chat, or with the tab backgrounded (their service worker decides whether to show
   * it). No-op when VAPID isn't configured. Returns the recipients the per-invocation
   * budget cut off and those to retry after a transient failure (queued for the alarm
   * by the caller).
   * Debounced PER RECIPIENT (see `lastPush`); the window is reserved synchronously,
   * right after the single D1 read and before any send, so concurrent messages can't
   * double-push and one recipient's push never silences another. Shares this event's
   * external `budget` (the inbox fan-out spends the separate internal one). `gate` (the
   * D1 mirror write) is awaited just before the first send.
   */
  private async pushOffline(chatId: string, senderId: string, budget: SubBudget, gate: Promise<void>): Promise<PushResult> {
    if (!this.env.VAPID_PRIVATE_JWK) return { cut: [], retry: {}, dropped: 0 }; // push not configured
    // Only users actively LOOKING at this chat (>=1 non-away socket) are skipped: a
    // backgrounded tab still gets a push (its service worker suppresses the toast while
    // a Meowsenger window is visible).
    const active = this.activeUsers();
    for (const u of active) this.lastPush.delete(u); // they've seen the chat
    budget.ext++; // the target read
    const skipped = new Set<string>();
    const all = await pushTargetsForChat(this.d1(), chatId, [senderId, ...active], skipped);
    skipped.delete(senderId);
    return this.fanPush(all, budget, { suppressedActive: skipped.size, followup: false, prior: {}, gate });
  }

  /**
   * Debounce, budget and send pushes for `all` (endpoint, owner) pairs. Whole
   * recipients only (all their endpoints). Outcomes per recipient: any 2xx → full
   * window; 404/410/403 → endpoint pruned (403 = it can never accept our VAPID key);
   * other 4xx → full window (never retried); 429/5xx/network → eligible again after
   * PUSH_RETRY_MS and returned in `retry` with its attempt count, until
   * MAX_PUSH_ATTEMPTS (then counted in `dropped`). `cut` = recipients the budget cut
   * off (NOT reserved). `suppressedActive`: subscribed recipients excluded as active
   * (null = not measured → "n/a"). Emits exactly one outcome line per call.
   */
  private async fanPush(
    all: Array<{ endpoint: string; userId: string }>,
    budget: SubBudget,
    o: { suppressedActive: number | null; followup: boolean; prior: Record<string, number>; gate?: Promise<void> },
  ): Promise<PushResult> {
    // ---- synchronous section: filter by window, apply budget, reserve (no await) ----
    const now = Date.now();
    const byUser = new Map<string, string[]>();
    for (const t of all) byUser.set(t.userId, [...(byUser.get(t.userId) ?? []), t.endpoint]);
    let debounced = 0;
    const cut: string[] = [];
    const targets: Array<{ endpoint: string; userId: string }> = [];
    for (const [userId, endpoints] of byUser) {
      if (now - (this.lastPush.get(userId) ?? -Infinity) < PUSH_DEBOUNCE_MS) { debounced++; continue; }
      if (budget.ext + endpoints.length > EXTERNAL_BUDGET) { cut.push(userId); continue; }
      budget.ext += endpoints.length;
      for (const endpoint of endpoints) targets.push({ endpoint, userId });
      this.lastPush.set(userId, now);
    }
    const reserved = new Set(targets.map((t) => t.userId));
    // ---- end synchronous section ----
    // Observability without identities: counts only.
    let accepted = 0, transientFailed = 0, permanentFailed = 0, dropped = 0;
    const retry: Record<string, number> = {};
    const suppressed = o.suppressedActive === null ? "n/a" : String(o.suppressedActive);
    const outcomeLine = () => console.log(
      `push_decision outcome eligible=${byUser.size} attempted=${reserved.size} accepted=${accepted} transient_failed=${transientFailed} permanent_failed=${permanentFailed} dropped=${dropped} suppressed_active=${suppressed} suppressed_debounce=${debounced} deferred=${cut.length}`,
    );
    if (!o.followup) {
      if (byUser.size > 0 && debounced === byUser.size) {
        console.log("push_decision skipped=debounce");
        outcomeLine();
        return { cut, retry, dropped };
      }
      console.log(`push_decision targets=${targets.length} active_excluded=${suppressed}${debounced > 0 ? ` debounced=${debounced}` : ""}`);
    } else if (targets.length > 0) {
      console.log(`push_decision followup targets=${targets.length}`);
    }
    if (cut.length > 0) console.log(`push_decision truncated=${cut.length}`);
    if (targets.length === 0) { outcomeLine(); return { cut, retry, dropped }; }
    const outcome = new Map<string, "ok" | "transient" | "final">();
    const rank = { ok: 2, transient: 1, final: 0 } as const;
    try {
      const key = await importVapidKey(this.env);
      // Push only after the D1 mirror write: the service worker reads /api/chats.
      if (o.gate) await o.gate;
      await Promise.all(
        targets.map(async ({ endpoint: ep, userId }) => {
          const status = await sendPush(ep, this.env, now, fetch, key);
          // Delivery observability: ONLY the push service's HTTP status and its host
          // family — never the endpoint URL, keys, user or chat ids.
          const prune = status === 404 || status === 410 || status === 403;
          console.log(`push_delivery status=${status} service=${pushHostFamily(ep)}${status === 403 ? " pruned=1" : ""}`);
          if (prune && budget.ext < EXTERNAL_BUDGET) {
            budget.ext++;
            await deleteDeadPushSubscription(this.d1(), ep, userId, now).catch(() => {});
          }
          const oc = status >= 200 && status < 300 ? "ok" : status === 0 || status === 429 || status >= 500 ? "transient" : "final";
          const prev = outcome.get(userId);
          if (!prev || rank[oc] > rank[prev]) outcome.set(userId, oc);
        }),
      );
    } catch (e) {
      // Release the reservation so the next round can still push these recipients.
      for (const u of reserved) if (this.lastPush.get(u) === now) this.lastPush.delete(u);
      throw e;
    }
    // A recipient whose pushes all failed transiently is retried after PUSH_RETRY_MS
    // (never immediately, so an outage can't turn every message into a retry storm).
    for (const u of reserved) {
      if (outcome.get(u) === "transient" && this.lastPush.get(u) === now) {
        this.lastPush.set(u, now - PUSH_DEBOUNCE_MS + PUSH_RETRY_MS);
      }
    }
    // Per-recipient outcome counts (no identities). `eligible` = recipients with a
    // subscription that were not excluded as active/sender; `suppressed_active` =
    // subscribed recipients excluded as active; `deferred` = queued for the alarm.
    // Active exclusion is per USER: any non-away socket in this room suppresses push on
    // all of that user's devices.
    for (const u of reserved) {
      const oc = outcome.get(u);
      if (oc === "ok") accepted++;
      else if (oc === "transient") {
        transientFailed++;
        const n = (o.prior[u] ?? 0) + 1;
        if (n >= MAX_PUSH_ATTEMPTS) dropped++; else retry[u] = n;
      } else permanentFailed++;
    }
    outcomeLine();
    return { cut, retry, dropped };
  }

  // ---- follow-up fan-out (DO alarm) ---------------------------------------------

  /** Arm the alarm for `at` unless one is already due sooner (the purge alarm shares
   *  this single slot). */
  private async armAlarm(at: number): Promise<void> {
    const cur = await this.ctx.storage.getAlarm();
    if (cur == null || at < cur) await this.ctx.storage.setAlarm(at);
  }

  /** The queued record, normalised (older records lack the retry fields). */
  private async readOverflow(): Promise<Overflow | undefined> {
    const raw = await this.ctx.storage.get<Partial<Overflow>>(OVERFLOW_KEY);
    if (!raw) return undefined;
    return {
      chatId: raw.chatId ?? "", push: raw.push ?? [], inbox: raw.inbox ?? [],
      attempts: raw.attempts ?? {}, notBefore: raw.notBefore ?? {},
      rounds: raw.rounds ?? 0, total: raw.total ?? 0, seq: raw.seq ?? 0,
    };
  }

  /** When the queued work next has something to do: now for inbox work or a due push
   *  recipient, else the earliest retry time. */
  private nextDue(o: Overflow, now: number): number {
    if (o.inbox.length > 0) return now;
    let at = Infinity;
    for (const u of o.push) at = Math.min(at, o.notBefore[u] ?? 0);
    return Math.max(now, at === Infinity ? now : at);
  }

  /** Persist recipients (ids and attempt counts only) that the first invocation could
   *  not serve or that failed transiently (`retry`: id → attempts made), merged with any
   *  work already queued by earlier messages, and arm the alarm: immediately for new
   *  work, at now + PUSH_RETRY_MS when only retries are waiting. The current sender is
   *  never a queued push target (they are looking at the chat). */
  private async queueOverflow(chatId: string, senderId: string, push: string[], inbox: string[], retry: Record<string, number>): Promise<void> {
    const retryIds = Object.keys(retry).filter((u) => u !== senderId);
    if (push.length === 0 && inbox.length === 0 && retryIds.length === 0) return;
    const now = Date.now();
    const prev = (await this.readOverflow()) ?? { chatId, push: [], inbox: [], attempts: {}, notBefore: {}, rounds: 0, total: 0, seq: 0 };
    const all = [...new Set([...prev.push, ...push, ...retryIds])].filter((u) => u !== senderId);
    const attempts: Record<string, number> = {};
    const notBefore: Record<string, number> = {};
    for (const u of all) {
      if (prev.attempts[u] !== undefined) attempts[u] = prev.attempts[u]!;
      if (prev.notBefore[u] !== undefined) notBefore[u] = prev.notBefore[u]!;
    }
    for (const u of retryIds) { attempts[u] = retry[u]!; notBefore[u] = now + PUSH_RETRY_MS; }
    const next: Overflow = {
      chatId,
      push: all,
      inbox: [...new Set([...prev.inbox, ...inbox])],
      attempts, notBefore,
      rounds: 0, // new work: a fresh follow-up allowance
      total: 0,
      seq: prev.seq + 1,
    };
    await this.ctx.storage.put(OVERFLOW_KEY, next);
    await this.armAlarm(this.nextDue(next, now));
  }

  /** Write back the outcome of one follow-up run WITHOUT losing work queued meanwhile:
   *  keep everything in the current record that the run did not start with (new work),
   *  plus this run's leftovers that are still queued (dropUser may have pruned some).
   *  If `queueOverflow` ran meanwhile (seq changed) its reset counters stand and EVERY
   *  id it holds is kept — even one this run also started with, which a new message may
   *  have re-queued (a redundant invalidation/push is cheap; a lost one is not). */
  private async settleOverflow(
    work: Overflow,
    r: { push: string[]; inbox: string[]; attempts: Record<string, number>; notBefore: Record<string, number>; progress: boolean; attempted: boolean; failed: boolean },
  ): Promise<void> {
    const cur = await this.readOverflow();
    if (!cur) return; // pruned empty by dropUser: nothing left to serve
    const seqChanged = cur.seq !== work.seq;
    const hadPush = new Set(work.push);
    const hadInbox = new Set(work.inbox);
    const curPush = new Set(cur.push);
    const curInbox = new Set(cur.inbox);
    const runPush = new Set(r.push);
    const push = [...new Set([...cur.push.filter((u) => seqChanged || !hadPush.has(u)), ...r.push.filter((u) => curPush.has(u))])];
    const inbox = [...new Set([...cur.inbox.filter((u) => seqChanged || !hadInbox.has(u)), ...r.inbox.filter((u) => curInbox.has(u))])];
    if (push.length === 0 && inbox.length === 0) { await this.ctx.storage.delete(OVERFLOW_KEY); return; }
    const attempts: Record<string, number> = {};
    const notBefore: Record<string, number> = {};
    for (const u of push) {
      const a = runPush.has(u) ? r.attempts[u] : cur.attempts[u];
      const n = runPush.has(u) ? r.notBefore[u] : cur.notBefore[u];
      if (a !== undefined) attempts[u] = a;
      if (n !== undefined) notBefore[u] = n;
    }
    const rounds = seqChanged ? cur.rounds : work.rounds + (!r.progress && r.attempted ? 1 : 0);
    const total = seqChanged ? cur.total : work.total + 1;
    const next: Overflow = { chatId: work.chatId, push, inbox, attempts, notBefore, rounds, total, seq: cur.seq };
    await this.ctx.storage.put(OVERFLOW_KEY, next);
    const now = Date.now();
    // A failed run backs off; otherwise continue as soon as something is due.
    await this.armAlarm(r.failed ? now + PUSH_RETRY_MS : this.nextDue(next, now));
  }

  /** One follow-up invocation: pushes first (re-read, so removed members and users now
   *  looking at the chat drop out) to recipients that are due (a transiently-failed one
   *  waits PUSH_RETRY_MS, at most MAX_PUSH_ATTEMPTS attempts), then content-free
   *  `{chatId, invalidate}` inbox signals to members beyond the inline budget (client
   *  refetches the list). Anything still cut by this invocation's own budgets is
   *  re-queued. Rounds that made progress continue (each is bounded by the budgets);
   *  only MAX_FOLLOWUPS no-progress/failed rounds, or MAX_TOTAL_ROUNDS in all, drop the
   *  rest (logged). A failure re-queues the whole run, backing off PUSH_RETRY_MS. */
  private async runOverflow(): Promise<void> {
    const work = await this.readOverflow();
    if (!work) return;
    if (work.rounds >= MAX_FOLLOWUPS || work.total >= MAX_TOTAL_ROUNDS) {
      console.log(`push_decision overflow_dropped push=${work.push.length} inbox=${work.inbox.length}${work.rounds >= MAX_FOLLOWUPS ? "" : " reason=ceiling"}`);
      await this.ctx.storage.delete(OVERFLOW_KEY);
      return;
    }
    const now = Date.now();
    const budget: SubBudget = { ext: 0, int: 0 };
    const vapid = !!this.env.VAPID_PRIVATE_JWK;
    const due = vapid ? work.push.filter((u) => (work.notBefore[u] ?? 0) <= now) : [];
    const dueSet = new Set(due);
    let pushLeft: string[] = vapid ? work.push : [];
    let inboxLeft: string[] = this.env.USER_INBOX ? work.inbox : [];
    let attempts = { ...work.attempts };
    let notBefore = { ...work.notBefore };
    let pushResolved = 0, inboxResolved = 0, failed = false;
    try {
      if (due.length > 0) {
        const pending = new Set(due);
        const active = this.activeUsers();
        for (const u of active) this.lastPush.delete(u);
        budget.ext++;
        const skipped = new Set<string>();
        const all = await pushTargetsForChat(this.d1(), work.chatId, active, skipped); // join on chat_members: removed users drop out
        const r = await this.fanPush(all.filter((t) => pending.has(t.userId)), budget, { suppressedActive: skipped.size, followup: true, prior: work.attempts });
        const retryIds = Object.keys(r.retry);
        pushLeft = [...work.push.filter((u) => !dueSet.has(u)), ...r.cut, ...retryIds];
        attempts = { ...work.attempts };
        notBefore = { ...work.notBefore };
        for (const u of due) { delete attempts[u]; delete notBefore[u]; }
        for (const u of r.cut) if (work.attempts[u] !== undefined) attempts[u] = work.attempts[u]!;
        for (const u of retryIds) { attempts[u] = r.retry[u]!; notBefore[u] = Date.now() + PUSH_RETRY_MS; }
        pushResolved = due.length - r.cut.length - retryIds.length;
      } else if (vapid && work.push.length > 0) {
        // Only transiently-failed recipients still waiting: nothing attempted this round,
        // but the invocation still reports exactly one outcome line.
        await this.fanPush([], budget, { suppressedActive: null, followup: true, prior: work.attempts });
      }
      const ns = this.env.USER_INBOX;
      if (work.inbox.length > 0 && ns) {
        budget.ext++;
        const members = new Set(await chatMemberIds(this.d1(), work.chatId));
        const pending = work.inbox.filter((u) => members.has(u));
        const take = Math.max(0, this.internalBudget - budget.int);
        const now2 = pending.slice(0, take);
        inboxLeft = pending.slice(take);
        inboxResolved = work.inbox.length - inboxLeft.length;
        budget.int += now2.length;
        const body = JSON.stringify({ chatId: work.chatId, invalidate: true });
        await Promise.all(
          now2.map((id) => ns.get(ns.idFromName("inbox:" + id)).fetch("https://do/notify", { method: "POST", body }).catch(() => {})),
        );
      }
    } catch (e) {
      failed = true;
      console.log(`push_decision overflow_error ${e instanceof Error ? e.name : "unknown"}`);
    }
    await this.settleOverflow(work, {
      push: pushLeft, inbox: inboxLeft, attempts, notBefore,
      progress: !failed && (pushResolved > 0 || inboxResolved > 0),
      attempted: due.length > 0 || work.inbox.length > 0,
      failed,
    });
  }

  /**
   * DO RPC (Slice 8): append a message to `chatId`'s log on behalf of `senderId`
   * — used by the forward REST handler, which has already gated the caller against
   * the target chat's membership + channel-post rule and passes the real `chatId`
   * (a DO with no live socket can't recover it, so mirror + push would otherwise
   * no-op). No ack socket (the forwarder isn't necessarily connected to the
   * target), so the message fans out to ALL live sockets and mirrors to the sidebar
   * exactly like a normal send. `forwarded` sets is_forwarded so the target renders
   * the "forwarded" badge. Metered per-user (see `appendTimes`) so forward can't
   * bypass the WS flood limiter — a rate-limited call throws so the handler stops.
   * Returns the id.
   */
  async appendMessage(chatId: string, senderId: string, body: string, forwarded: boolean): Promise<string> {
    if (this.isAppendRateLimited(senderId)) throw new Error("rate_limited");
    return this.insertAndBroadcast(senderId, chatId, body, { forwarded });
  }

  /**
   * Meter a forward on `userId`: prune timestamps older than RATE_WINDOW_MS, then
   * decide. At/over RATE_MAX in the window → true (caller stops, nothing recorded).
   * Otherwise record `now` and return false. In-memory only (see `appendTimes`).
   */
  private isAppendRateLimited(userId: string): boolean {
    const now = Date.now();
    const times = (this.appendTimes.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (times.length >= RATE_MAX) {
      this.appendTimes.set(userId, times);
      return true;
    }
    times.push(now);
    this.appendTimes.set(userId, times);
    return false;
  }

  /**
   * DO RPC: drop `userId`'s live sockets in this room after a membership/role change
   * (Slice 9 hardening). The socket's `role`/`type` are cached at connect (the gated
   * router reads them from D1 once) so the hot send/delete path never re-reads D1;
   * the flip side is a demoted/removed user keeps their old power until they
   * reconnect. Calling this from the REST member handlers fixes that WITHOUT a
   * per-message D1 read: it forces the affected sockets to close so the client
   * reconnects (and the router re-derives the fresh role) — or, when `revoked`
   * (removed/left, not merely demoted), it first sends a `{revoked}` frame so the
   * client drops the chat and STOPS reconnecting (the /ws gate would reject it now
   * anyway). Closing runs the normal presence cleanup via webSocketClose.
   */
  async dropUser(userId: string, revoked: boolean): Promise<void> {
    // The cached member list (inbox fan-out) may still contain a just-removed user;
    // drop it so the next message re-reads chat_members and the removed user's inbox
    // gets no further previews. Also forget their push window.
    this.inboxMembers.clear();
    this.membershipGen++;
    this.lastPush.delete(userId);
    // Drop the user from any queued follow-up fan-out too.
    const queued = await this.readOverflow();
    if (queued && (queued.push.includes(userId) || queued.inbox.includes(userId))) {
      const { [userId]: _a, ...attempts } = queued.attempts;
      const { [userId]: _n, ...notBefore } = queued.notBefore;
      await this.ctx.storage.put(OVERFLOW_KEY, { ...queued, push: queued.push.filter((u) => u !== userId), inbox: queued.inbox.filter((u) => u !== userId), attempts, notBefore });
    }
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a?.userId !== userId) continue;
      if (revoked) this.safeSend(ws, JSON.stringify({ type: "revoked" }));
      try { ws.close(4001, revoked ? "revoked" : "role_changed"); } catch { /* already closing */ }
    }
  }

  /** Hibernation handler: a socket closed cleanly — clean up, then mirror the close back. */
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.handleDisconnect(ws);
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
    }
  }

  /**
   * Hibernation handler: a socket dropped ABNORMALLY (network loss, tab killed).
   * The runtime routes these to `webSocketError`, NOT `webSocketClose` — without
   * this handler an abnormal drop would remove the socket from getWebSockets() but
   * never clear presence or stamp last-seen, so peers would show the user online
   * forever. Runs the exact same cleanup as a clean close.
   */
  async webSocketError(ws: WebSocket): Promise<void> {
    this.handleDisconnect(ws);
  }

  /**
   * Shared close/error cleanup: drop the socket's rate bucket, and — if this was the
   * user's LAST live socket in the room — broadcast presence-offline and stamp
   * last_seen_at. The exclude-and-recheck (`onlineUsers(ws)` skips the departing
   * socket) means a multi-tab user closing ONE tab doesn't flap offline while another
   * remains. The last_seen write is DEBOUNCED to ~once/60s per user (the UI is
   * minute-grained, and a flapping client reconnects to THIS same warm DO, so the
   * in-memory stamp collapses a reconnect storm to one write/min) and runs off the
   * path (waitUntil; wall time is fine — no ordering requirement).
   */
  private handleDisconnect(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attach | null;
    this.sendTimes.delete(ws);
    if (att?.userId && !this.onlineUsers(ws).includes(att.userId)) {
      this.broadcast({ type: "presence", userId: att.userId, online: false }, ws);
      const nowMs = Date.now();
      if (nowMs - (this.lastSeenStamp.get(att.userId) ?? 0) >= 60_000) {
        this.lastSeenStamp.set(att.userId, nowMs);
        this.ctx.waitUntil(touchLastSeen(this.d1(), att.userId, nowMs).catch(() => {}));
      }
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
    // never postpones a sooner alarm (e.g. a queued fan-out); failure is logged, not floating
    this.ctx.waitUntil(this.armAlarm(Date.now() + PURGE_AFTER_MS + 60_000).catch(() => console.log("purge_arm_failed")));
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
    // Reap reactions whose message is gone (hard-purged above, or never existed) so
    // they don't accumulate as dead rows — attachReactions filters by page ids, so
    // these are invisible but still leak DO SQLite space.
    this.ctx.storage.sql.exec("DELETE FROM reactions WHERE message_id NOT IN (SELECT id FROM messages)");
    const remaining = this.ctx.storage.sql
      .exec("SELECT MIN(deleted_at) AS oldest FROM messages WHERE is_deleted = 1")
      .toArray()[0]?.oldest;
    if (remaining != null) {
      await this.armAlarm(Number(remaining) + PURGE_AFTER_MS + 60_000);
    }
    await this.runOverflow();
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
    const cols = HISTORY_COLS;
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
   * Forward history page (deep-linking): mirror of `historyFor` but FORWARD —
   * returns up to HISTORY_PAGE messages STRICTLY NEWER than `afterId`, ascending.
   * `afterId`'s created_at is resolved exactly as `historyFor` resolves `beforeId`;
   * an unknown `afterId` yields [] (there's nothing to page forward from). The
   * query is already ascending, so — unlike `historyFor` — there's no `.reverse()`.
   * Reactions attach for `viewerId`.
   */
  async historyAfter(chatId: string, afterId: string, viewerId?: string): Promise<Wire[]> {
    const at = this.ctx.storage.sql
      .exec("SELECT created_at FROM messages WHERE id = ?", afterId)
      .toArray()[0]?.created_at;
    if (at == null) return [];
    const cols = HISTORY_COLS;
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT ${cols} FROM messages m LEFT JOIN messages r ON m.reply_to_id = r.id` +
          " WHERE m.created_at > ? ORDER BY m.created_at ASC LIMIT ?",
        Number(at),
        HISTORY_PAGE,
      )
      .toArray();
    // Already ascending — do NOT reverse.
    const wires = rows.map((r: Row) => this.rowToWire(r, chatId));
    this.attachReactions(wires, viewerId);
    return wires;
  }

  /**
   * Centered history window around `msgId` (deep-linking): resolves the anchor's
   * created_at (`targetAt`); an unknown id → { messages: [], hasOlder:false,
   * hasNewer:false, found:false }. Otherwise builds a window of up to AROUND_HALF
   * older messages (created_at <= targetAt — INCLUDING the anchor) reversed to
   * ascending, concatenated with up to AROUND_HALF strictly-newer messages
   * (ascending). `hasOlder`/`hasNewer` report whether any message exists beyond the
   * respective window edge (so the client knows more can be paged). Reactions
   * attach for `viewerId`.
   */
  async historyAround(
    chatId: string,
    msgId: string,
    viewerId?: string,
  ): Promise<{ messages: Wire[]; hasOlder: boolean; hasNewer: boolean; found: boolean }> {
    const at = this.ctx.storage.sql
      .exec("SELECT created_at FROM messages WHERE id = ?", msgId)
      .toArray()[0]?.created_at;
    if (at == null) return { messages: [], hasOlder: false, hasNewer: false, found: false };
    const targetAt = Number(at);
    const cols = HISTORY_COLS;
    // Older half INCLUDES the anchor (created_at <= targetAt); newest-first for the
    // LIMIT, then reversed to ascending.
    const older = this.ctx.storage.sql
      .exec(
        `SELECT ${cols} FROM messages m LEFT JOIN messages r ON m.reply_to_id = r.id` +
          " WHERE m.created_at <= ? ORDER BY m.created_at DESC LIMIT ?",
        targetAt,
        AROUND_HALF,
      )
      .toArray()
      .map((r: Row) => this.rowToWire(r, chatId))
      .reverse();
    const newer = this.ctx.storage.sql
      .exec(
        `SELECT ${cols} FROM messages m LEFT JOIN messages r ON m.reply_to_id = r.id` +
          " WHERE m.created_at > ? ORDER BY m.created_at ASC LIMIT ?",
        targetAt,
        AROUND_HALF,
      )
      .toArray()
      .map((r: Row) => this.rowToWire(r, chatId));
    const window = [...older, ...newer];
    // Existence probes just past each window edge (created_at is strictly
    // monotonic, so a single row beyond the edge means there's more to page).
    const first = window[0];
    const last = window[window.length - 1];
    const hasOlder =
      first != null &&
      this.ctx.storage.sql
        .exec("SELECT 1 AS ok FROM messages WHERE created_at < ? LIMIT 1", first.createdAt)
        .toArray().length > 0;
    const hasNewer =
      last != null &&
      this.ctx.storage.sql
        .exec("SELECT 1 AS ok FROM messages WHERE created_at > ? LIMIT 1", last.createdAt)
        .toArray().length > 0;
    this.attachReactions(window, viewerId);
    return { messages: window, hasOlder, hasNewer, found: true };
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
    // A soft-deleted message renders as a "message deleted" placeholder — it must
    // NOT carry reaction pills. Only aggregate for live rows; tombstones get [].
    const live = wires.filter((w) => !w.isDeleted);
    if (live.length === 0) {
      for (const w of wires) w.reactions = [];
      return;
    }
    const ids = live.map((w) => w.id);
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
  async search(query: string, chatId: string, viewerId?: string, limit = 30): Promise<Wire[]> {
    const q = (query ?? "").trim();
    if (!q) return [];
    const capped = Math.max(1, Math.min(Number(limit) || 30, 100));
    const pattern = `%${escapeLike(q)}%`;
    const cols = HISTORY_COLS;
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT ${cols} FROM messages m LEFT JOIN messages r ON m.reply_to_id = r.id` +
          " WHERE m.is_deleted = 0 AND m.body LIKE ? ESCAPE '\\' ORDER BY m.created_at DESC LIMIT ?",
        pattern,
        capped,
      )
      .toArray();
    // chatId is passed in (not recovered from a live socket) so a REST search with
    // no open connection still stamps the right chatId on each result. (§ audit #5)
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
   * D1 adapter (shared `d1Client`). It MUST implement `all`/`first` for real: the DO
   * reads chat membership (inbox fan-out) and push targets through them. They were
   * once stubbed to `[]`, which made every push/inbox target list silently empty.
   */
  private d1(): DbClient {
    return d1Client(this.env.DB);
  }
}
