import type { Env } from "./types";
// Durable Object class must be exported from the worker entrypoint so wrangler
// can bind CONVERSATION (wrangler.jsonc) and register its SQLite migration.
export { Conversation } from "./conversation";
import { corsHeaders, json } from "./security";
import { type Deps, prodDeps } from "./deps";
import { handleLogin, handleCallback } from "./oidc";
import { handleSession, handleLogout } from "./api";
import { callerId, handleListChats, handleCreateChat, handleHistory } from "./chatapi";
import { isMember } from "./chats";

/** Thin hand-rolled router (no framework) to stay under the 10ms CPU budget. */
export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req.headers.get("Origin"), env);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const path = new URL(req.url).pathname;
  const m = req.method;

  if (path === "/health" && m === "GET") return json({ ok: true }, 200, cors);
  if (path === "/auth/login" && m === "GET") return handleLogin(deps.auth());
  if (path === "/auth/callback" && m === "GET") return handleCallback(req, env, deps);
  if (path === "/api/session" && m === "GET") return handleSession(req, deps.getDb(), deps.now(), cors);
  if (path === "/auth/logout" && m === "POST") return handleLogout(req, deps.getDb(), deps.now(), cors);

  // Slice 2 chat graph (REST over D1) + the /ws upgrade into the Conversation DO.
  if (path === "/api/chats" && m === "GET") return handleListChats(req, deps.getDb(), deps.now(), cors);
  if (path === "/api/chats" && m === "POST") return handleCreateChat(req, deps.getDb(), deps.now(), cors);
  const hist = path.match(/^\/api\/chats\/([^/]+)\/messages$/);
  if (hist && m === "GET") return handleHistory(req, env, deps.getDb(), deps.now(), hist[1], cors);
  if (path === "/ws" && m === "GET") return handleWs(req, env, deps);

  // Matching static assets are served by Cloudflare BEFORE the worker runs; a
  // request only reaches here if it's an API route (above) or a non-asset path.
  // Hand unknown paths to the assets binding so Astro's 404 page renders (falls
  // back to JSON 404 in tests, where ASSETS is unbound).
  if (env.ASSETS) return env.ASSETS.fetch(req);
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
  if (!(await isMember(deps.getDb(), chatId, me))) return new Response("forbidden", { status: 403 });
  const ns = env.CONVERSATION!;
  const stub = ns.get(ns.idFromName(chatId));
  // Preserve the original request (carries the Upgrade header) while overriding
  // the URL so the DO receives the gated identity via query params.
  const fwd = new Request(`https://do/ws?user=${encodeURIComponent(me)}&chat=${encodeURIComponent(chatId)}`, req);
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
