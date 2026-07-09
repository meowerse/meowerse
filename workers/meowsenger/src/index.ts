import type { Env } from "./types";
// Durable Object class must be exported from the worker entrypoint so wrangler
// can bind CONVERSATION (wrangler.jsonc) and register its SQLite migration.
export { Conversation } from "./conversation";
import { corsHeaders, json } from "./security";
import { type Deps, prodDeps } from "./deps";
import { handleLogin, handleCallback } from "./oidc";
import { handleSession, handleLogout } from "./api";
import {
  callerId,
  handleListChats,
  handleCreateChat,
  handleHistory,
  handleResolveChat,
  handlePushKey,
  handlePushSubscribe,
  handlePushUnsubscribe,
  handleSearch,
  handleGlobalSearch,
  handleForward,
  handleListMembers,
  handleAddMember,
  handleRemoveMember,
  handleSetRole,
  handleLeave,
  handleUpdateChat,
  handleSlugAvailable,
  handleGetBySlug,
  handleJoin,
  handleCreateInvite,
  handleRevokeInvite,
  handleResolveInvite,
  handleAcceptInvite,
  handleRequestJoin,
  handleListRequests,
  handleApproveRequest,
  handleRejectRequest,
  handleGetPrivacy,
  handleSetPrivacy,
  handleDeleteAccount,
} from "./chatapi";
import { getRole, chatType } from "./chats";

// The expensive D1-write POSTs (create-group / add-member / join|subscribe /
// invite / join-request / push-subscribe). Free-tier D1 caps writes at 100k/day
// ACCOUNT-WIDE, so an authenticated abuser looping these could drain the whole
// fleet's daily budget. These get the per-IP write throttle before dispatch;
// everything else is intentionally left alone: GETs/reads, logout, the message hot
// path (that's WS→DO, not an HTTP route here), and single-row edits (role/remove/
// leave). The trailing `$` keeps `/request` from matching the `/requests` inbox and
// keeps `/members` from matching `/members/:id/role`.
const EXPENSIVE_WRITE = /^\/api\/(?:chats(?:\/[^/]+\/(?:members|join|subscribe|invite|request))?|push\/subscribe)$/;

/**
 * Per-IP edge rate limit for the expensive D1-write POSTs. Returns true (allow)
 * when the WRITE_LIMIT binding is absent (tests / unconfigured env) so behavior is
 * unchanged; otherwise consults the Cloudflare Workers Rate Limiting binding keyed
 * by client IP. That binding is edge-local and performs NO D1 writes, so throttling
 * never itself consumes the write budget it exists to protect.
 */
async function writeThrottle(env: Env, req: Request): Promise<boolean> {
  if (!env.WRITE_LIMIT) return true;
  const ip = req.headers.get("CF-Connecting-IP") ?? "";
  const { success } = await env.WRITE_LIMIT.limit({ key: "w:" + ip });
  return success;
}

/** Thin hand-rolled router (no framework) to stay under the 10ms CPU budget. */
export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req.headers.get("Origin"), env);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const path = new URL(req.url).pathname;
  const m = req.method;

  // Guard the expensive write POSTs with the per-IP throttle before any dispatch.
  if (m === "POST" && EXPENSIVE_WRITE.test(path) && !(await writeThrottle(env, req))) {
    return json({ error: "rate_limited" }, 429, cors);
  }

  if (path === "/health" && m === "GET") return json({ ok: true }, 200, cors);
  if (path === "/auth/login" && m === "GET") return handleLogin(deps.auth());
  if (path === "/auth/callback" && m === "GET") return handleCallback(req, env, deps);
  if (path === "/api/session" && m === "GET") return handleSession(req, deps.getDb(), deps.now(), cors);
  if (path === "/auth/logout" && m === "POST") return handleLogout(req, deps.getDb(), deps.now(), cors);

  // Slice 7: account privacy (auto-group-add opt-out) + invite resolve/accept by
  // code. These are NOT chat-scoped, so they live outside the /api/chats/:id block.
  if (path === "/api/account/privacy" && m === "GET") return handleGetPrivacy(req, deps.getDb(), deps.now(), cors);
  if (path === "/api/account/privacy" && m === "POST") return handleSetPrivacy(req, deps.getDb(), deps.now(), cors);
  // Slice 9: erase the caller's meowsenger data (session-gated + confirm-required).
  if (path === "/api/account/delete" && m === "POST") return handleDeleteAccount(req, deps.getDb(), deps.now(), cors);
  // Web Push: the VAPID public key (public), + subscribe/unsubscribe (session-gated).
  if (path === "/api/push/key" && m === "GET") return handlePushKey(env, cors);
  if (path === "/api/push/subscribe" && m === "POST") return handlePushSubscribe(req, deps.getDb(), deps.now(), cors);
  if (path === "/api/push/unsubscribe" && m === "POST") return handlePushUnsubscribe(req, deps.getDb(), deps.now(), cors);
  // Global cross-chat message search (fans out to the caller's chats' DOs).
  if (path === "/api/search" && m === "GET") return handleGlobalSearch(req, env, deps.getDb(), deps.now(), cors);
  const inviteAccept = path.match(/^\/api\/invite\/([^/]+)\/accept$/);
  if (inviteAccept && m === "POST") return handleAcceptInvite(req, deps.getDb(), deps.now(), decodeURIComponent(inviteAccept[1]), cors);
  const inviteResolve = path.match(/^\/api\/invite\/([^/]+)$/);
  if (inviteResolve && m === "GET") return handleResolveInvite(req, deps.getDb(), deps.now(), decodeURIComponent(inviteResolve[1]), cors);

  // Slice 2 chat graph (REST over D1) + the /ws upgrade into the Conversation DO.
  if (path === "/api/chats" && m === "GET") return handleListChats(req, deps.getDb(), deps.now(), cors);
  if (path === "/api/chats" && m === "POST") return handleCreateChat(req, deps.getDb(), deps.now(), cors);
  if (path === "/api/slug-available" && m === "GET") return handleSlugAvailable(req, deps.getDb(), deps.now(), cors);
  // Slice 6 discovery: resolve a public chat by slug. Placed before the bare
  // `/api/chats/:id` so `by-slug` isn't mistaken for a chat id.
  const bySlug = path.match(/^\/api\/chats\/by-slug\/([^/]+)$/);
  if (bySlug && m === "GET") return handleGetBySlug(req, deps.getDb(), deps.now(), decodeURIComponent(bySlug[1]), cors);
  const hist = path.match(/^\/api\/chats\/([^/]+)\/messages$/);
  if (hist && m === "GET") return handleHistory(req, env, deps.getDb(), deps.now(), hist[1], cors);
  // Resolve a chat by id-or-slug for a shareable deep-link (member → open; public/
  // private+slug → preview; else 404). The `/resolve` suffix disambiguates from
  // the bare `/api/chats/:id` PATCH below.
  const resolveM = path.match(/^\/api\/chats\/([^/]+)\/resolve$/);
  if (resolveM && m === "GET") return handleResolveChat(req, deps.getDb(), deps.now(), decodeURIComponent(resolveM[1]), cors);
  // Slice 9: within-chat search (member-gated). :id is the chat being searched.
  const search = path.match(/^\/api\/chats\/([^/]+)\/search$/);
  if (search && m === "GET") return handleSearch(req, env, deps.getDb(), deps.now(), search[1], cors);
  // Slice 8: forward messages into a target chat (gated on target membership +
  // the channel-post rule). :id is the TARGET chat.
  const forward = path.match(/^\/api\/chats\/([^/]+)\/forward$/);
  if (forward && m === "POST") return handleForward(req, env, deps.getDb(), deps.now(), forward[1], cors);

  // Slice 5: member management + chat metadata. Order matters — the more
  // specific member/role sub-routes must precede the bare `/api/chats/:id`.
  const memberRole = path.match(/^\/api\/chats\/([^/]+)\/members\/([^/]+)\/role$/);
  if (memberRole && m === "POST") return handleSetRole(req, env, deps.getDb(), deps.now(), memberRole[1], memberRole[2], cors);
  const member = path.match(/^\/api\/chats\/([^/]+)\/members\/([^/]+)$/);
  if (member && m === "DELETE") return handleRemoveMember(req, env, deps.getDb(), deps.now(), member[1], member[2], cors);
  const members = path.match(/^\/api\/chats\/([^/]+)\/members$/);
  if (members && m === "GET") return handleListMembers(req, deps.getDb(), deps.now(), members[1], cors);
  if (members && m === "POST") return handleAddMember(req, deps.getDb(), deps.now(), members[1], cors);
  const leaveM = path.match(/^\/api\/chats\/([^/]+)\/leave$/);
  if (leaveM && m === "POST") return handleLeave(req, env, deps.getDb(), deps.now(), leaveM[1], cors);
  // Slice 6 open-join: `/join` (groups) + its `/subscribe` alias (channels) share
  // one handler — both add the caller to a public chat as a plain member.
  const joinM = path.match(/^\/api\/chats\/([^/]+)\/(?:join|subscribe)$/);
  if (joinM && m === "POST") return handleJoin(req, deps.getDb(), deps.now(), joinM[1], cors);

  // Slice 7 chat-scoped: invite create/refresh (POST) + revoke (DELETE); a join
  // request (POST /request); the requests inbox (GET) + approve/reject decisions.
  // The more specific /requests/:rid/(approve|reject) precede the bare /requests.
  const invite = path.match(/^\/api\/chats\/([^/]+)\/invite$/);
  if (invite && m === "POST") return handleCreateInvite(req, deps.getDb(), deps.now(), invite[1], cors);
  if (invite && m === "DELETE") return handleRevokeInvite(req, deps.getDb(), deps.now(), invite[1], cors);
  const request = path.match(/^\/api\/chats\/([^/]+)\/request$/);
  if (request && m === "POST") return handleRequestJoin(req, deps.getDb(), deps.now(), request[1], cors);
  const reqDecide = path.match(/^\/api\/chats\/([^/]+)\/requests\/([^/]+)\/(approve|reject)$/);
  if (reqDecide && m === "POST") {
    return reqDecide[3] === "approve"
      ? handleApproveRequest(req, deps.getDb(), deps.now(), reqDecide[1], reqDecide[2], cors)
      : handleRejectRequest(req, deps.getDb(), deps.now(), reqDecide[1], reqDecide[2], cors);
  }
  const requests = path.match(/^\/api\/chats\/([^/]+)\/requests$/);
  if (requests && m === "GET") return handleListRequests(req, deps.getDb(), deps.now(), requests[1], cors);

  const chat = path.match(/^\/api\/chats\/([^/]+)$/);
  if (chat && m === "PATCH") return handleUpdateChat(req, deps.getDb(), deps.now(), chat[1], cors);

  if (path === "/ws" && m === "GET") return handleWs(req, env, deps);

  // Matching static assets are served by Cloudflare BEFORE the worker runs; a
  // request only reaches here if it's an API route (above) or a non-asset path.
  // Serve the styled 404 page (built to /404.html) with a real 404 status — fetched
  // EXPLICITLY rather than via assets.not_found_handling, which can shadow API routes
  // before the worker runs (see the auth worker + its wrangler note). Falls back to
  // JSON 404 in tests, where ASSETS is unbound.
  if (env.ASSETS) {
    const page = await env.ASSETS.fetch(new URL("/404.html", req.url));
    return new Response(page.body, { status: 404, headers: page.headers });
  }
  return json({ error: "not found" }, 404, cors);
}

/**
 * GET /ws?chat=<id> — authenticate the BFF session (same cookie as REST), gate on
 * D1 membership, then forward the upgrade to the chat's Conversation DO. The DO
 * trusts the `?user=&chat=` params because only this (gated) path can reach it.
 * Guard failures short-circuit with a status code (426/400/401/403) instead of
 * upgrading; the happy path hands the socket back from the DO stub.
 */
async function handleWs(req: Request, env: Env, deps: Deps): Promise<Response> {
  if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
  const chatId = new URL(req.url).searchParams.get("chat");
  if (!chatId) return new Response("chat required", { status: 400 });
  const me = await callerId(req, deps.getDb(), deps.now());
  if (!me) return new Response("unauthorized", { status: 401 });
  // A single membership lookup: getRole returns null for non-members (the gate)
  // and the caller's role otherwise. The role is forwarded to the DO so it can
  // authorize admin/owner message-delete (Slice 5) without a second D1 read.
  const role = await getRole(deps.getDb(), chatId, me);
  if (role == null) return new Response("forbidden", { status: 403 });
  // Slice 6: forward the chat's `type` too, so the DO can enforce the channel
  // read-only rule (member sockets on a channel can't post) without a D1 read.
  const type = (await chatType(deps.getDb(), chatId)) ?? "group";
  const ns = env.CONVERSATION!;
  const stub = ns.get(ns.idFromName(chatId));
  // Preserve the original request (carries the Upgrade header) while overriding
  // the URL so the DO receives the gated identity + role + type via query params.
  const fwd = new Request(
    `https://do/ws?user=${encodeURIComponent(me)}&chat=${encodeURIComponent(chatId)}&role=${encodeURIComponent(role)}&type=${encodeURIComponent(type)}`,
    req,
  );
  return stub.fetch(fwd);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env, prodDeps(env));
    } catch (e) {
      // Log server-side (surfaces in `wrangler tail`); client still gets a generic 500.
      console.error("meowsenger fetch error:", (e as Error)?.stack ?? String(e));
      return json({ error: "internal error" }, 500, corsHeaders(request.headers.get("Origin"), env));
    }
  },
};
