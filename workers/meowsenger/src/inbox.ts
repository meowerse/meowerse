import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

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
export class UserInbox extends DurableObject<Env> {
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
        try { ws.send(frame); } catch { /* socket closed underneath us — drop the frame */ }
      }
      return new Response(null, { status: 204 });
    }

    // WS upgrade — the router already validated the session and passes ?user=<id>.
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const userId = url.searchParams.get("user");
    if (!userId) return new Response("bad ws params", { status: 400 });
    const pair = new WebSocketPair();
    // Accept into the Hibernation API so the inbox sleeps between deltas.
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ userId });
    pair[1].send(JSON.stringify({ type: "inbox_ready" }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // The client only RECEIVES deltas (its keepalive ping is auto-answered by the
  // runtime), so there is no webSocketMessage handler and nothing to clean up on
  // close — the runtime drops the evicted socket; the next getWebSockets() omits it.
}
