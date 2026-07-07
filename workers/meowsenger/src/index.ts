import type { Env } from "./types";
// Durable Object class must be exported from the worker entrypoint so wrangler
// can bind CONVERSATION (wrangler.jsonc) and register its SQLite migration.
export { Conversation } from "./conversation";
import { corsHeaders, json } from "./security";
import { type Deps, prodDeps } from "./deps";
import { handleLogin, handleCallback } from "./oidc";
import { handleSession, handleLogout } from "./api";

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

  // Matching static assets are served by Cloudflare BEFORE the worker runs; a
  // request only reaches here if it's an API route (above) or a non-asset path.
  // Hand unknown paths to the assets binding so Astro's 404 page renders (falls
  // back to JSON 404 in tests, where ASSETS is unbound).
  if (env.ASSETS) return env.ASSETS.fetch(req);
  return json({ error: "not found" }, 404, cors);
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
