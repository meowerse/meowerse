import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker, { handle } from "./index";
import { json } from "./security";
import type { Env } from "./types";

// Safe-by-default caching: every response this worker produces (other than the
// explicit public exceptions below, WebSocket 101s and ASSETS pages) must carry
// `Cache-Control: ...no-store`, including error / 401 / 404 / 500 / redirect /
// cookie-setting paths. The walk is driven by a hand-maintained table that is
// asserted to match the router's route table in src/index.ts, so a new route
// cannot be silently skipped.

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
    ["GET", "/auth/callback?code=c&state=s", { Cookie: "mw_txn=%7B%22state%22%3A%22other%22%7D" }],
    ["GET", "/auth/callback?code=c&state=s", { Accept: "text/html", Cookie: "mw_txn=%7B%22state%22%3A%22other%22%7D" }],
    ["GET", "/auth/callback?code=c&state=s", { Cookie: "mw_txn=%7B%22state%22%3A%22s%22%2C%22codeVerifier%22%3A%22c%22%7D" }],
    ["GET", "/auth/callback?code=c&state=s", { Cookie: "mw_txn=%7Bbroken" }],
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

/** Route patterns exactly as written in the router source (literals + regexes). */
function routerPatterns(): string[] {
  const src = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  const found = new Set<string>();
  for (const m of src.matchAll(/path === "([^"]+)"/g)) found.add(m[1]);
  for (const m of src.matchAll(/path\.match\((\/\^.*\$\/)\)/g)) found.add(m[1]);
  return [...found];
}

describe("Cache-Control: router route table", () => {
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
        const cc = res.headers.get("Cache-Control");
        if (PUBLIC[pattern]) expect(cc).toBe(PUBLIC[pattern]);
        else expect(cc, `${method} ${path} -> ${res.status}`).toContain("no-store");
        if (res.headers.get("Set-Cookie")) expect(cc).toContain("no-store");
      });
    }
  }

  it("GET /api/push/key keeps its pre-existing header exactly (edge-cached by infra/cloudflare/cache.tf)", async () => {
    const res = await handle(new Request("https://meowsenger.alxnko.dev/api/push/key", { headers: { Origin: ORIGIN } }), { ...env, VAPID_PUBLIC_KEY: "K" }, deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("unknown route 404, OPTIONS preflight and the 429 throttle are no-store", async () => {
    expect((await call("GET", "/nope")).headers.get("Cache-Control")).toContain("no-store");
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
