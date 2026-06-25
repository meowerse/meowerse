import type { Env } from "./types";
import { corsHeaders, requireAuth } from "./security";
import { type Deps, ensureSchema, prodDeps } from "./db";
import {
  createMeow,
  listMeows,
  runBatchOp,
  validateText,
  MAX_BATCH,
  type BatchOpResult,
} from "./handlers";

const LIST_CACHE_CONTROL = "public, max-age=10";

function json(body: unknown, status: number, cors: Record<string, string>, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors, ...extra },
  });
}

/** Parse a JSON request body, returning undefined (never throwing) on malformed input. */
async function readJson(req: Request): Promise<unknown | undefined> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

/** GET /api/meows — public, edge-cached. */
async function handleList(req: Request, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const cacheKey = new Request(new URL(req.url).toString(), { method: "GET" });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  await ensureSchema(deps);
  const rows = await listMeows(deps.getDb());
  const res = json(rows, 200, cors, { "Cache-Control": LIST_CACHE_CONTROL });
  // Store a clone so the body stays readable for the caller. Origin is varied
  // so a cached entry never leaks across origins.
  if (cache) await cache.put(cacheKey, res.clone());
  return res;
}

/** POST /api/meows — auth required. */
async function handleCreate(req: Request, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const body = await readJson(req);
  if (!body || typeof body !== "object") return json({ error: "invalid json" }, 400, cors);
  const v = validateText((body as { text?: unknown }).text);
  if (!v.ok) return json({ error: v.error }, 400, cors);
  await ensureSchema(deps);
  const meow = await createMeow(deps.getDb(), v.text, v.slug);
  // The next GET within the 10s TTL may serve a slightly stale list — accepted
  // tradeoff; we do not purge per-write to keep writes cheap on the CPU budget.
  return json(meow, 201, cors);
}

/** POST /api/batch — auth required. Many creates in one request. */
async function handleBatch(req: Request, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const body = await readJson(req);
  if (!body || typeof body !== "object") return json({ error: "invalid json" }, 400, cors);
  const ops = (body as { ops?: unknown }).ops;
  if (!Array.isArray(ops)) return json({ error: "ops must be an array" }, 400, cors);
  if (ops.length > MAX_BATCH) return json({ error: `at most ${MAX_BATCH} ops` }, 400, cors);
  await ensureSchema(deps);
  const db = deps.getDb();
  const results: BatchOpResult[] = [];
  for (const op of ops) results.push(await runBatchOp(db, op));
  return json({ results }, 200, cors);
}

/**
 * Thin request router. Keeps the hot path tiny (no framework) for the 10ms CPU
 * budget. `deps` is injectable so tests pass a fake db; production builds it
 * from env once per request (the libsql client + schema promise are memoized
 * inside Deps).
 */
export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const origin = req.headers.get("Origin");
  const cors = corsHeaders(origin, env);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const path = new URL(req.url).pathname;

  if (path === "/api/meows" && req.method === "GET") return handleList(req, deps, cors);

  if (path === "/api/meows" && req.method === "POST") {
    if (!requireAuth(req, env)) return json({ error: "unauthorized" }, 401, cors);
    return handleCreate(req, deps, cors);
  }

  if (path === "/api/batch" && req.method === "POST") {
    if (!requireAuth(req, env)) return json({ error: "unauthorized" }, 401, cors);
    return handleBatch(req, deps, cors);
  }

  return json({ error: "not found" }, 404, cors);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env, prodDeps(env));
    } catch {
      // Never leak internals; a generic 500 with CORS so the browser can read it.
      return json({ error: "internal error" }, 500, corsHeaders(request.headers.get("Origin"), env));
    }
  },
};
