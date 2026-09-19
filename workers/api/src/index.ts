import type { Env } from "./types";
import { corsHeaders, requireAuth } from "./security";
import { type Deps, ensureSchema, prodDeps } from "./db";
import {
  createMeow,
  createMeows,
  listMeows,
  validateBatchOp,
  validateText,
  MAX_BATCH,
  type BatchOpResult,
} from "./handlers";

const LIST_CACHE_CONTROL = "public, max-age=10";

const SECURITY_TXT = `Contact: mailto:Alexnekokyn@gmail.com
Expires: 2027-12-31T23:59:59.000Z
Preferred-Languages: en, ru
Canonical: https://alxnko.dev/.well-known/security.txt
Policy: https://alxnko.dev/privacy
`;

const ROBOTS_TXT = `User-agent: *
Allow: /

User-agent: GPTBot
Disallow: /

User-agent: ChatGPT-User
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: anthropic-ai
Disallow: /

User-agent: Claude-Web
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: Google-Extended
Disallow: /
`;

function json(body: unknown, status: number, cors: Record<string, string>, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
      ...cors,
      ...extra,
    },
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

/** The default edge cache, or undefined in environments without the Cache API. */
function listCache(): Cache | undefined {
  return (globalThis as { caches?: { default?: Cache } }).caches?.default;
}

/**
 * Cache key for the list endpoint at the current request's origin/path. Built
 * the same way for read (handleList) and purge (purgeListCache) so a write
 * deletes exactly the entry a read would have stored.
 */
function listCacheKey(req: Request): Request {
  const url = new URL(req.url);
  url.pathname = "/api/meows";
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}

/**
 * Best-effort purge of the list cache entry after a successful write. NOTE:
 * Cloudflare's cache is per-colo, so this deletes the entry only in the colo
 * that served the write — other colos stay consistent within the 10s TTL. That
 * makes the list strongly consistent for the writer's colo and globally
 * eventually-consistent within 10s (the honest correctness level here).
 */
async function purgeListCache(req: Request): Promise<void> {
  const cache = listCache();
  if (!cache) return;
  try {
    await cache.delete(listCacheKey(req));
  } catch {
    // Ignore purge failures — staleness self-heals at TTL expiry.
  }
}

/** GET /api/meows — public, edge-cached. */
async function handleList(req: Request, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const cache = listCache();
  const cacheKey = listCacheKey(req);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      // The cache key is origin-agnostic (query + Origin stripped), so re-apply the
      // CURRENT requester's CORS over the cached response — otherwise the first
      // caller's Access-Control-Allow-Origin is served to every allowlisted origin
      // and a different origin's browser blocks it.
      const headers = new Headers(hit.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(hit.body, { status: hit.status, headers });
    }
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
  // Purge the cached list so a create-then-reload sees the new row immediately
  // (in this colo); other colos refresh within the 10s TTL.
  await purgeListCache(req);
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
  // Validate every op first (pure, no DB), then insert only the VALID ops in ONE
  // round-trip via db.batch — instead of up to MAX_BATCH sequential INSERTs.
  const validated = ops.map(validateBatchOp);
  const insertable = validated.filter((v): v is { ok: true; text: string; slug: string } => v.ok);
  const inserted = await createMeows(db, insertable.map((v) => ({ text: v.text, slug: v.slug })));
  let k = 0;
  const results: BatchOpResult[] = validated.map((v) =>
    v.ok ? { status: 201, meow: inserted[k++] } : { status: v.status, error: v.error },
  );
  // A batch may have created rows; purge the cached list (best-effort) so the
  // next reload reflects them.
  await purgeListCache(req);
  return json({ results }, 200, cors);
}

/**
 * Thin request router. Keeps the hot path tiny (no framework) for the 10ms CPU
 * budget. `deps` is injectable so tests pass a fake db; production builds it
 * from env once per request (the libsql client + schema promise are memoized
 * inside Deps).
 */
export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  if (url.hostname.endsWith(".alxnko.eu.org")) {
    const newHost = url.hostname.replace(/\.alxnko\.eu\.org$/, ".alxnko.dev");
    const dest = new URL(url.pathname + url.search, `https://${newHost}`);
    return new Response(null, {
      status: 301,
      headers: {
        Location: dest.toString(),
        "Cache-Control": "public, max-age=86400",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
      },
    });
  }

  const origin = req.headers.get("Origin");
  const cors = corsHeaders(origin, env);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const path = url.pathname;

  if (req.method === "GET" && (path === "/.well-known/security.txt" || path === "/security.txt")) {
    return new Response(SECURITY_TXT, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
        ...cors,
      },
    });
  }

  if (req.method === "GET" && path === "/robots.txt") {
    return new Response(ROBOTS_TXT, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
        ...cors,
      },
    });
  }

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
