import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
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

export class UserInbox extends DurableObject<Env> {
  /** sid -> last session verdict + when it was read (a user's tabs share one session). */
  private sessionVerdict = new Map<string, { ok: boolean; at: number }>();

  /**
   * Is the session this inbox socket was opened with still live? The inbox carries message
   * previews, so a logged-out / expired session must stop receiving them. A definite "gone"
   * closes the socket (4001); a D1 failure falls back to the last good verdict for a bounded
   * window and otherwise just withholds this delta (the socket stays, nothing leaks).
   * Legacy sockets without a sid are not checkable and are left alone.
   */
  private async sessionAlive(sid: string, userId: string): Promise<boolean> {
    const v = this.sessionVerdict.get(sid);
    if (v && Date.now() - v.at < SESSION_TTL_MS) return v.ok;
    try {
      const row = await d1Client(this.env.DB).first(
        "SELECT 1 AS ok FROM sessions WHERE id = ? AND user_id = ? AND expires_at >= ?",
        [sid, userId, Date.now()],
      );
      const ok = row !== undefined;
      this.sessionVerdict.set(sid, { ok, at: Date.now() });
      return ok;
    } catch {
      return !!v && v.ok && Date.now() - v.at < SESSION_STALE_MS;
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
      let delta: unknown;
      try { delta = JSON.parse(await request.text()); } catch { return new Response(null, { status: 204 }); }
      const frame = JSON.stringify({ type: "chat_update", ...(delta as object) });
      for (const ws of this.ctx.getWebSockets()) {
        const a = ws.deserializeAttachment() as { userId?: string; sid?: string } | null;
        if (a?.sid && a.userId && !(await this.sessionAlive(a.sid, a.userId))) {
          // Definite "session gone" (verdict cached false) closes the socket; an unavailable
          // read only withholds this delta.
          if (this.sessionVerdict.get(a.sid)?.ok === false) { try { ws.close(4001, "revoked"); } catch { /* already closing */ } }
          continue;
        }
        try { ws.send(frame); } catch { /* socket closed underneath us — drop the frame */ }
      }
      return new Response(null, { status: 204 });
    }

    // WS upgrade — the router already validated the session and passes ?user=<id>.
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426, headers: { "Cache-Control": "no-store" } });
    const userId = url.searchParams.get("user");
    const sid = url.searchParams.get("sid") || undefined;
    if (!userId) return new Response("bad ws params", { status: 400, headers: { "Cache-Control": "no-store" } });
    const pair = new WebSocketPair();
    // Accept into the Hibernation API so the inbox sleeps between deltas.
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ userId, ...(sid ? { sid } : {}) });
    if (sid) this.sessionVerdict.set(sid, { ok: true, at: Date.now() }); // the router just validated it
    pair[1].send(JSON.stringify({ type: "inbox_ready" }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // The client only RECEIVES deltas (its keepalive ping is auto-answered by the
  // runtime), so there is no webSocketMessage handler and nothing to clean up on
  // close — the runtime drops the evicted socket; the next getWebSockets() omits it.
}
