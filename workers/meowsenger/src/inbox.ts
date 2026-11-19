import { DurableObject } from "cloudflare:workers";
import { SID_HEADER, type Env } from "./types";
import { d1Client } from "./db";

/**
 * One instance per USER (addressed by `inbox:<userId>` via `idFromName`). Holds that
 * user's live "inbox" WebSocket(s) — one per open tab — over the Hibernation API, so
 * an idle inbox costs nothing and evicts between events. It carries NO message
 * content and NO SQLite: every Conversation DO, on a new message, POSTs a compact
 * `{chatId, preview, at, senderId}` delta to the recipients' inbox DOs (see
 * `Conversation.inboxFanout`), and this DO relays it straight to the user's sockets
 * so their SIDEBAR updates in realtime — even for chats they don't have open. If the
 * user has no live inbox socket (fully offline), `notify` is a no-op and the existing
 * Web Push path handles the alert instead.
 *
 * Trust model mirrors Conversation: the router (same worker) validates the session
 * cookie before the WS upgrade reaches here and only ever addresses the caller's OWN
 * inbox (`inbox:<callerId>`), and `notify` is reachable only DO-to-DO (never from the
 * public internet — no route maps to it), so the `user`/delta it receives are trusted.
 */
/** How long a session-alive verdict for an inbox socket is trusted before D1 is asked again. */
const SESSION_TTL_MS = 30_000;
/** While D1 errors, the last good verdict keeps being honoured this long (stale-while-error). */
const SESSION_STALE_MS = 120_000;

/** The socket attachment. `checkedAt` = when the session was last KNOWN live (open time, then
 *  every successful D1 check). It lives on the socket so TTL and the stale window survive
 *  hibernation (an in-memory cache would be empty after every wake: one D1 read per delta). */
interface Attach { userId?: string; sid?: string; checkedAt?: number; missed?: true }

/** A session read slower than this counts as "unavailable" (stale window applies): a hung D1
 *  must not freeze the delivery line (and the Conversation fan-out awaiting /notify). */
const READ_TIMEOUT_MS = 2_500;

export class UserInbox extends DurableObject<Env> {
  /** sid -> the ONE in-flight D1 read for that session. Inside the serialised `tail` there is
   *  never a concurrent reader, so this only guards future reads made outside the chain; the
   *  ordering test proves the combination (it fails only when BOTH are removed). */
  private warnedNoSid = false;
  private pending = new Map<string, Promise<boolean | "unavailable">>();
  /** Delivery tail: /notify calls are processed strictly in arrival order, so a slow session
   *  read can never let a later delta overtake an earlier one (the client keeps the last one). */
  private tail: Promise<unknown> = Promise.resolve();

  private read(sid: string, userId: string): Promise<boolean | "unavailable"> {
    let p = this.pending.get(sid);
    if (!p) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"unavailable">((resolve) => { timer = setTimeout(() => resolve("unavailable"), READ_TIMEOUT_MS); });
      const query = (async (): Promise<boolean | "unavailable"> => {
        try {
          const row = await d1Client(this.env.DB).first(
            "SELECT 1 AS ok FROM sessions WHERE id = ? AND user_id = ? AND expires_at >= ?",
            [sid, userId, Date.now()],
          );
          return row !== undefined;
        } catch { return "unavailable"; }
      })();
      p = Promise.race([query, timeout]).finally(() => clearTimeout(timer));
      this.pending.set(sid, p);
      const clear = (): void => { if (this.pending.get(sid) === p) this.pending.delete(sid); };
      p.then(clear, clear);
    }
    return p;
  }

  /**
   * Is the session this inbox socket was opened with still live? The inbox carries message
   * previews, so a logged-out / expired session must stop receiving them. Trusted for
   * SESSION_TTL_MS after `checkedAt` (read from the attachment, so it survives hibernation);
   * a definite "gone" closes the socket (4001); a D1 failure falls back to the last good
   * check for SESSION_STALE_MS and otherwise just withholds this delta (the socket stays,
   * nothing leaks). Legacy sockets without a sid are not checkable and are left alone.
   */
  private async sessionAlive(ws: WebSocket, a: Attach): Promise<boolean> {
    if (!a.sid || !a.userId) return true;
    const last = a.checkedAt ?? 0;
    if (Date.now() - last < SESSION_TTL_MS) return true;
    const verdict = await this.read(a.sid, a.userId);
    if (verdict === "unavailable") return Date.now() - last < SESSION_STALE_MS;
    if (!verdict) { try { ws.close(4001, "revoked"); } catch { /* already closing */ } return false; }
    // The verdict is per SESSION: stamp every tab that shares it so they don't each re-read.
    const now = Date.now();
    for (const peer of this.ctx.getWebSockets()) {
      const pa = peer.deserializeAttachment() as Attach | null;
      if (pa?.sid === a.sid && pa.userId === a.userId) { try { peer.serializeAttachment({ ...pa, checkedAt: now }); } catch { /* socket gone */ } }
    }
    return true;
  }

  /** Send one frame to every live socket of this user whose session still checks out. */
  private async deliver(frame: string, chatId: unknown): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a && !(await this.sessionAlive(ws, a))) {
        // Withheld (stale window passed / D1 unavailable): remember it, so the next delivery
        // that does get through first tells the client to refetch what it missed.
        try { const cur = (ws.deserializeAttachment() as Attach | null) ?? a; ws.serializeAttachment({ ...cur, missed: true }); } catch { /* socket gone */ }
        continue;
      }
      try {
        const cur = ws.deserializeAttachment() as Attach | null;
        if (cur?.missed) {
          if (typeof chatId === "string") ws.send(JSON.stringify({ type: "chat_update", chatId, invalidate: true }));
          const { missed: _m, ...rest } = cur;
          ws.serializeAttachment(rest);
        }
        ws.send(frame);
      } catch { /* socket closed underneath us — drop the frame */ }
    }
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answer keepalive ping/pong in the runtime without waking the DO.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal fan-out from a Conversation DO: relay one sidebar delta to every live
    // socket this user has open. No-op (204) when the user has no inbox socket.
    if (url.pathname.endsWith("/notify")) {
      // Take a place in line SYNCHRONOUSLY (before any await) and read the body inside the turn,
      // so neither body parsing nor a slow session read can reorder two deltas.
      const turn = this.tail.then(async () => {
        let delta: unknown;
        try { delta = JSON.parse(await request.text()); } catch { return; }
        if (delta === null || typeof delta !== "object") return;
        await this.deliver(JSON.stringify({ type: "chat_update", ...(delta as object) }), (delta as { chatId?: unknown }).chatId);
      }).catch(() => { /* one bad delivery never wedges the line */ });
      this.tail = turn;
      await turn;
      return new Response(null, { status: 204 });
    }

    // WS upgrade — the router already validated the session and passes ?user=<id>.
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426, headers: { "Cache-Control": "no-store" } });
    const userId = url.searchParams.get("user");
    // The session hash arrives in an internal router-set header, never in the URL (logged).
    const sid = request.headers.get(SID_HEADER) || undefined;
    if (!sid && !this.warnedNoSid) {
      // A router regression (header lost) would silently disable session checks: make it visible once.
      this.warnedNoSid = true;
      console.warn("ws_no_sid inbox");
    }
    if (!userId) return new Response("bad ws params", { status: 400, headers: { "Cache-Control": "no-store" } });
    const pair = new WebSocketPair();
    // Accept into the Hibernation API so the inbox sleeps between deltas.
    this.ctx.acceptWebSocket(pair[1]);
    // checkedAt: the router just validated the session.
    pair[1].serializeAttachment({ userId, ...(sid ? { sid, checkedAt: Date.now() } : {}) } satisfies Attach);
    pair[1].send(JSON.stringify({ type: "inbox_ready" }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // The client only RECEIVES deltas (its keepalive ping is auto-answered by the
  // runtime), so there is no webSocketMessage handler and nothing to clean up on
  // close — the runtime drops the evicted socket; the next getWebSockets() omits it.
}
