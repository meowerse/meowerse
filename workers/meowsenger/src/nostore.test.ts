import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker, { handle } from "./index";
import { json } from "./security";
import { sha256hex, SESSION_COOKIE, TXN_COOKIE } from "./session";
import type { Env } from "./types";

// Safe-by-default caching: every response this worker produces (other than the
// explicit public exceptions below, WebSocket 101s and ASSETS pages) must carry
// `Cache-Control: ...no-store`, including error / 401 / 404 / 500 / redirect /
// cookie-setting paths. The walk is driven by a hand-maintained table that is
// asserted to match the router's route table in src/index.ts, so a new route
// cannot be silently skipped.

const NOT_FOUND_BODY = JSON.stringify({ error: "not found" });
const ORIGIN = "http://localhost:4321";
const env = { CORS_ORIGINS: ORIGIN, WEB_ORIGIN: "https://meowsenger.alxnko.dev" } as Env;
const noRows = { async first() { return undefined; }, async all() { return []; }, async run() {} };
const auth = {
  async buildAuthorizationUrl() { return { url: "https://auth/authorize", state: "s", nonce: "n", codeVerifier: "c" }; },
  async exchangeCode() { return {}; }, async refresh() { return {}; },
  async verifyIdToken() { return {}; }, buildLogoutUrl() { return ""; },
};
const deps = { getDb: () => noRows, auth: () => auth, fetchFn: fetch, now: () => 1, newId: () => "x" } as never;
const call = (m: string, p: string, headers: Record<string, string> = {}) =>
  handle(new Request(`https://meowsenger.alxnko.dev${p}`, { method: m, headers: { Origin: ORIGIN, ...headers } }), env, deps);

type Sample = [method: string, path: string, headers?: Record<string, string>];
// router pattern (as written in src/index.ts) -> concrete requests exercising it.
const ROUTES: Record<string, Sample[]> = {
  "/.well-known/security.txt": [["GET", "/.well-known/security.txt"]],
  "/security.txt": [["GET", "/security.txt"]],
  "/health": [["GET", "/health"], ["HEAD", "/health"]],
  "/auth/login": [["GET", "/auth/login"]],
  "/auth/callback": [
    ["GET", "/auth/callback"],
    ["GET", "/auth/callback", { Accept: "text/html" }],
    ["GET", "/auth/callback?code=c&state=s", { Cookie: "__Host-mw_txn=%7B%22state%22%3A%22other%22%7D" }],
    ["GET", "/auth/callback?code=c&state=s", { Accept: "text/html", Cookie: "__Host-mw_txn=%7B%22state%22%3A%22other%22%7D" }],
    ["GET", "/auth/callback?code=c&state=s", { Cookie: "__Host-mw_txn=%7B%22state%22%3A%22s%22%2C%22codeVerifier%22%3A%22c%22%7D" }],
    ["GET", "/auth/callback?code=c&state=s", { Cookie: "__Host-mw_txn=%7Bbroken" }],
  ],
  "/api/session": [["GET", "/api/session"], ["GET", "/api/session", { Cookie: "__Host-mw_session=zzz" }]],
  "/auth/logout": [["POST", "/auth/logout"], ["POST", "/auth/logout", { Cookie: "__Host-mw_session=zzz" }]],
  "/api/account/privacy": [["GET", "/api/account/privacy"], ["POST", "/api/account/privacy"]],
  "/api/account/delete": [["POST", "/api/account/delete"]],
  "/api/push/key": [["GET", "/api/push/key"]],
  "/api/push/subscribe": [["POST", "/api/push/subscribe"]],
  "/api/push/unsubscribe": [["POST", "/api/push/unsubscribe"]],
  "/api/search": [["GET", "/api/search?q=x"]],
  "/^\\/api\\/invite\\/([^/]+)\\/accept$/": [["POST", "/api/invite/abc/accept"]],
  "/^\\/api\\/invite\\/([^/]+)$/": [["GET", "/api/invite/abc"]],
  "/api/chats": [["GET", "/api/chats"], ["POST", "/api/chats"]],
  "/api/slug-available": [["GET", "/api/slug-available?slug=abc"]],
  "/^\\/api\\/chats\\/by-slug\\/([^/]+)$/": [["GET", "/api/chats/by-slug/abc"]],
  "/^\\/api\\/chats\\/([^/]+)\\/messages$/": [["GET", "/api/chats/c1/messages"]],
  "/^\\/api\\/chats\\/([^/]+)\\/resolve$/": [["GET", "/api/chats/c1/resolve"]],
  "/^\\/api\\/chats\\/([^/]+)\\/search$/": [["GET", "/api/chats/c1/search?q=x"]],
  "/^\\/api\\/chats\\/([^/]+)\\/forward$/": [["POST", "/api/chats/c1/forward"]],
  "/^\\/api\\/chats\\/([^/]+)\\/members\\/([^/]+)\\/role$/": [["POST", "/api/chats/c1/members/u2/role"]],
  "/^\\/api\\/chats\\/([^/]+)\\/members\\/([^/]+)$/": [["DELETE", "/api/chats/c1/members/u2"]],
  "/^\\/api\\/chats\\/([^/]+)\\/members$/": [["GET", "/api/chats/c1/members"], ["POST", "/api/chats/c1/members"]],
  "/^\\/api\\/chats\\/([^/]+)\\/leave$/": [["POST", "/api/chats/c1/leave"]],
  "/^\\/api\\/chats\\/([^/]+)\\/(?:join|subscribe)$/": [["POST", "/api/chats/c1/join"], ["POST", "/api/chats/c1/subscribe"]],
  "/^\\/api\\/chats\\/([^/]+)\\/invite$/": [["POST", "/api/chats/c1/invite"], ["DELETE", "/api/chats/c1/invite"]],
  "/^\\/api\\/chats\\/([^/]+)\\/request$/": [["POST", "/api/chats/c1/request"]],
  "/^\\/api\\/chats\\/([^/]+)\\/requests\\/([^/]+)\\/(approve|reject)$/": [
    ["POST", "/api/chats/c1/requests/r1/approve"], ["POST", "/api/chats/c1/requests/r1/reject"],
  ],
  "/^\\/api\\/chats\\/([^/]+)\\/requests$/": [["GET", "/api/chats/c1/requests"]],
  "/^\\/api\\/chats\\/([^/]+)$/": [["PATCH", "/api/chats/c1"]],
  "/ws": [
    ["GET", "/ws"],
    ["GET", "/ws", { Upgrade: "websocket" }],
    ["GET", "/ws?chat=c1", { Upgrade: "websocket" }],
  ],
  "/inbox/ws": [["GET", "/inbox/ws"], ["GET", "/inbox/ws", { Upgrade: "websocket" }]],
};

// Deliberately public (no private data, no cookies): asserted to be exactly this.
const PUBLIC: Record<string, string> = {
  "/.well-known/security.txt": "public, max-age=86400",
  "/security.txt": "public, max-age=86400",
};

const indexSrc = () => readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");

/**
 * Route patterns exactly as written in the router source. LIMITS: only the two
 * styles `path === "<literal>"` and `path.match(/^...$/)` are recognised; the
 * second scan below fails if index.ts uses any other path-matching style, so a
 * new style cannot silently bypass the table.
 */
function routerPatterns(): string[] {
  const src = indexSrc();
  const found = new Set<string>();
  for (const m of src.matchAll(/path === "([^"]+)"/g)) found.add(m[1]);
  for (const m of src.matchAll(/path\.match\((\/\^.*\$\/)\)/g)) found.add(m[1]);
  return [...found];
}

describe("Cache-Control: router route table", () => {
  it("index.ts uses no route-matching style the table scan cannot see", () => {
    // `EXPENSIVE_WRITE.test(path)` is the write throttle, not a route.
    const src = indexSrc().replace("EXPENSIVE_WRITE.test(path)", "");
    const other = /\bpathname\s*[!=]==|\bpath\s*!==|\bpath\.(?:startsWith|endsWith|includes|slice|split|indexOf)\(|\.test\(\s*path\s*\)|\.exec\(\s*path\s*\)|switch\s*\(\s*path\s*\)/;
    expect(src.match(other)?.[0], "unrecognised route style in index.ts; extend routerPatterns()").toBeUndefined();
  });

  it("the walked table matches the router's route table (no route silently skipped)", () => {
    expect(Object.keys(ROUTES).sort()).toEqual(routerPatterns().sort());
  });
});

describe("Cache-Control: every response is no-store unless explicitly public", () => {
  for (const [pattern, samples] of Object.entries(ROUTES)) {
    for (const [method, path, headers] of samples) {
      it(`${method} ${path}${headers ? " " + JSON.stringify(headers) : ""}`, async () => {
        const res = await call(method, path, headers);
        expect(res.status, "must not be a WS upgrade").not.toBe(101);
        // No sample may pass by falling through to the router's catch-all 404.
        expect(await res.clone().text(), `${method} ${path} fell through to the router 404`).not.toBe(NOT_FOUND_BODY);
        const cc = res.headers.get("Cache-Control");
        if (PUBLIC[pattern]) expect(cc).toBe(PUBLIC[pattern]);
        else expect(cc, `${method} ${path} -> ${res.status}`).toContain("no-store");
        if (res.headers.get("Set-Cookie")) expect(cc).toContain("no-store");
      });
    }
  }

  // The origin sends `no-store` here and the cache rule in infra/cloudflare/cache.tf
  // uses `respect_origin`, so nothing is edge-cached: this pins the origin header.
  it("GET /api/push/key sends exactly `no-store`", async () => {
    const res = await handle(new Request("https://meowsenger.alxnko.dev/api/push/key", { headers: { Origin: ORIGIN } }), { ...env, VAPID_PUBLIC_KEY: "K" }, deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("unknown route 404, OPTIONS preflight and the 429 throttle are no-store", async () => {
    const nf = await call("GET", "/nope");
    expect(nf.status).toBe(404);
    expect(await nf.text()).toBe(NOT_FOUND_BODY); // this sample exists to test the 404
    expect(nf.headers.get("Cache-Control")).toContain("no-store");
    expect((await call("DELETE", "/api/chats/c1")).headers.get("Cache-Control")).toContain("no-store");
    const pre = await call("OPTIONS", "/api/chats");
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Cache-Control")).toContain("no-store");
    const limited = { ...env, WRITE_LIMIT: { limit: async () => ({ success: false }) } } as Env;
    const r = await handle(new Request("https://meowsenger.alxnko.dev/api/chats", { method: "POST" }), limited, deps);
    expect(r.status).toBe(429);
    expect(r.headers.get("Cache-Control")).toContain("no-store");
  });

  it("the top-level 500 handler is no-store", async () => {
    const boom = { ...env, DB: undefined } as unknown as Env;
    const err = console.error;
    console.error = () => {};
    try {
      const r = await worker.fetch(new Request("https://meowsenger.alxnko.dev/api/chats", { headers: { Origin: ORIGIN, Cookie: "__Host-mw_session=zzz" } }), boom);
      expect(r.status).toBe(500);
      expect(r.headers.get("Cache-Control")).toContain("no-store");
    } finally {
      console.error = err;
    }
  });

  it("the .eu.org 308 redirect stays public (no cookies, no private data)", async () => {
    const r = await handle(new Request("https://meowsenger.alxnko.eu.org/api/chats"), env, deps);
    expect(r.status).toBe(308);
    expect(r.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("json() Cache-Control", () => {
  it("defaults to private, no-store", () => {
    expect(json({}, 200, {}).headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("a caller-provided value wins", () => {
    expect(json({}, 200, {}, { "Cache-Control": "public, max-age=60" }).headers.get("Cache-Control")).toBe("public, max-age=60");
  });
  it("detects an override in any header-name casing, without duplicating", () => {
    for (const k of ["cache-control", "CACHE-CONTROL", "Cache-control"]) {
      const r = json({}, 200, {}, { [k]: "no-cache" });
      expect(r.headers.get("Cache-Control"), k).toBe("no-cache");
    }
  });
  it("an override supplied via the cors map is honoured too", () => {
    expect(json({}, 200, { "cache-control": "max-age=5" }).headers.get("Cache-Control")).toBe("max-age=5");
  });
});

// ---------------------------------------------------------------------------
// Authenticated 200 paths: the unauthenticated walk above never reaches them.
// ---------------------------------------------------------------------------

const COOKIE = "test-session-cookie";
const COOKIE_HASH = await sha256hex(COOKIE);
const authedDb = {
  async first(sql: string, params: unknown[] = []) {
    if (sql.includes("FROM sessions WHERE id")) {
      // sessions.id is sha256hex(cookie); expires far in the future (deps.now() = 1).
      return params[0] === COOKIE_HASH
        ? { id: COOKIE_HASH, user_id: "u1", access_exp: 0, created_at: 0, expires_at: 9e15 }
        : undefined;
    }
    if (sql.includes("FROM users WHERE id")) {
      return { id: "u1", username: "alice", display_name: "Alice", avatar_url: null, verified: 1 };
    }
    // getRole / isMember: u1 is a member of c1 only.
    if (sql.includes("FROM chat_members WHERE chat_id = ? AND user_id = ?")) {
      return params[0] === "c1" && params[1] === "u1" ? { role: "member", ok: 1 } : undefined;
    }
    return undefined;
  },
  async all(sql: string) {
    if (sql.includes("JOIN chats c ON c.id = m.chat_id")) {
      return [{ id: "c1", type: "group", name: "G", slug: null, visibility: "private", last_message: null, last_sender_id: null, last_activity: 1, unread_count: 0 }];
    }
    if (sql.includes("JOIN users u ON u.id = m.user_id")) {
      return [{ user_id: "u1", role: "member", joined_at: 1, username: "alice", display_name: "Alice", avatar_url: null }];
    }
    return [];
  },
  async run() {},
  async batch(stmts: unknown[]) { return stmts.map(() => 1); },
};
const conv = { get: () => ({ historyFor: async () => [] }), idFromName: (n: string) => n };
const authedEnv = { ...env, CONVERSATION: conv, OIDC_ISSUER: "https://auth" } as unknown as Env;
const authedDeps = { ...deps, getDb: () => authedDb } as never;
const authedCall = (p: string, method = "GET") =>
  handle(new Request(`https://meowsenger.alxnko.dev${p}`, { method, headers: { Origin: ORIGIN, Cookie: `${SESSION_COOKIE}=${COOKIE}` } }), authedEnv, authedDeps);

describe("Cache-Control: authenticated 200 responses are no-store", () => {
  const SAMPLES: Array<[string, (b: Record<string, unknown>) => void]> = [
    ["/api/session", (b) => expect(b.authenticated).toBe(true)],
    ["/api/chats", (b) => expect(b.viewerId).toBe("u1")],
    ["/api/chats/c1/messages", (b) => expect(b.messages).toEqual([])],
    ["/api/chats/c1/members", (b) => expect((b.members as unknown[]).length).toBe(1)],
  ];
  for (const [path, check] of SAMPLES) {
    it(`GET ${path}`, async () => {
      const res = await authedCall(path);
      expect(res.status).toBe(200);
      const text = await res.clone().text();
      expect(text, "fell through to the router 404").not.toBe(NOT_FOUND_BODY);
      check(JSON.parse(text));
      expect(res.headers.get("Cache-Control")).toContain("no-store");
    });
  }

  // Relies purely on json()'s default (no explicit Cache-Control in the handler).
  it("POST /auth/logout (authenticated, sets a cookie) relies on json()'s default", async () => {
    const res = await authedCall("/auth/logout", "POST");
    expect(res.status).toBe(200);
    expect(await res.clone().text()).not.toBe(NOT_FOUND_BODY);
    expect(res.headers.get("Set-Cookie")).toContain(`${SESSION_COOKIE}=;`);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("a non-member gets a no-store 403 on the same authenticated path", async () => {
    const res = await authedCall("/api/chats/other/members");
    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("the successful OIDC callback 302 (sets the session cookie) is no-store", async () => {
    const okAuth = {
      ...auth,
      async exchangeCode() { return { access_token: "a", id_token: "i", expires_in: 60 }; },
      async verifyIdToken() { return { sub: "u1" }; },
    };
    const okDeps = {
      ...deps,
      getDb: () => authedDb,
      auth: () => okAuth,
      fetchFn: async () => new Response(JSON.stringify({ sub: "u1", preferred_username: "alice" }), { status: 200 }),
      newId: () => "fresh-session-id",
    } as never;
    const txn = encodeURIComponent(JSON.stringify({ state: "s", nonce: "n", codeVerifier: "c" }));
    const res = await handle(
      new Request("https://meowsenger.alxnko.dev/auth/callback?code=c&state=s", { headers: { Origin: ORIGIN, Cookie: `${TXN_COOKIE}=${txn}` } }),
      { ...env, OIDC_ISSUER: "https://auth" } as Env,
      okDeps,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://meowsenger.alxnko.dev/app");
    expect(res.headers.get("Set-Cookie")).toContain(`${SESSION_COOKIE}=fresh-session-id`);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });
});

// ---------------------------------------------------------------------------
// Source-scan invariant: every `new Response(` in non-test source sets
// Cache-Control (any casing, or NO_STORE / NS) or is an explicit allowlisted case.
// ---------------------------------------------------------------------------

/** Exact `new Response(` occurrences allowed WITHOUT a Cache-Control, by file + snippet + expected count. */
const ALLOW: Array<{ file: string; snippet: string; count: number; why: string }> = [
  { file: "conversation.ts", snippet: "status: 101", count: 1, why: "WebSocket 101 upgrade (no body)" },
  { file: "inbox.ts", snippet: "status: 101", count: 1, why: "WebSocket 101 upgrade (no body)" },
  { file: "inbox.ts", snippet: "{ status: 204 }", count: 2, why: "DO-internal /notify ack; never reaches a client" },
  { file: "index.ts", snippet: "new Response(page.body", count: 1, why: "ASSETS 404 page passthrough: carries the asset's own headers" },
  // security.txt and the .eu.org 308 are public but set an explicit Cache-Control,
  // so the scan passes them on their own merits (no allowlist entry needed).
];

/** Text of each `new Response(...)` call, found with a paren-depth scanner that skips string literals. */
function responseCalls(src: string): Array<{ text: string; before: string }> {
  const out: Array<{ text: string; before: string }> = [];
  const needle = "new Response(";
  for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + 1)) {
    let depth = 0;
    let i = at + needle.length - 1;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") {
        for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      } else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) break;
    }
    out.push({ text: src.slice(at, i + 1), before: src.slice(0, at).split("\n").slice(-15).join("\n") });
  }
  return out;
}

const SETS_CC = /cache-control|\bNO_STORE\b|\bNS\b/i;
/** A bare `headers` identifier argument (variable built just above) rather than an inline object. */
const BARE_HEADERS = /\bheaders\b(?!\s*:)/;

/** Violations in one file's source; `used` counts allowlist hits. */
function scanSource(file: string, src: string, used: Map<number, number>): string[] {
  const bad: string[] = [];
  for (const { text, before } of responseCalls(src)) {
    const ai = ALLOW.findIndex((a) => a.file === file && text.includes(a.snippet));
    if (ai !== -1) { used.set(ai, (used.get(ai) ?? 0) + 1); continue; }
    if (SETS_CC.test(text)) continue;
    // `new Response(x, { status, headers })` where `headers` was assembled in the preceding lines.
    if (BARE_HEADERS.test(text) && SETS_CC.test(before)) continue;
    bad.push(`${file}: ${text.replace(/\s+/g, " ").slice(0, 100)}`);
  }
  return bad;
}

describe("Cache-Control: source scan of every `new Response(`", () => {
  const dir = fileURLToPath(new URL("./", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("every non-test Response sets Cache-Control or is explicitly allowlisted (and no allowlist entry is stale)", () => {
    expect(files).toContain("chatapi.ts");
    const used = new Map<number, number>();
    const bad = files.flatMap((f) => scanSource(f, readFileSync(dir + f, "utf8"), used));
    expect(bad, "Response without Cache-Control").toEqual([]);
    ALLOW.forEach((a, i) => expect(used.get(i) ?? 0, `allowlist ${a.file} "${a.snippet}" (${a.why})`).toBe(a.count));
  });

  it("the scanner flags a raw Response and accepts the known-good shapes", () => {
    const scan = (s: string) => scanSource("x.ts", s, new Map());
    expect(scan('return new Response(JSON.stringify({ a: "(" }), { status: 200 });')).toHaveLength(1);
    expect(scan('return new Response("x", { status: 400, headers: { "cache-control": "no-store" } });')).toEqual([]);
    expect(scan('return new Response("x", { status: 400, headers: NS });')).toEqual([]);
    expect(scan('const headers = new Headers({ "Cache-Control": "no-store" });\nreturn new Response(null, { status: 302, headers });')).toEqual([]);
    expect(scan('const headers = {};\nreturn new Response(null, { status: 302, headers });')).toHaveLength(1);
  });
});
