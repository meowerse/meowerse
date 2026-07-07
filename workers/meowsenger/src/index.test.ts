import { describe, it, expect } from "vitest";
import worker, { handle } from "./index";
import type { Env } from "./types";

const env = { CORS_ORIGINS: "http://localhost:4321" } as Env;
const ORIGIN = "http://localhost:4321";
const deps = { getDb: () => ({}) } as never;
const req = (m: string, p: string) => new Request(`https://meowsenger-api.alxnko.eu.org${p}`, { method: m, headers: { Origin: ORIGIN } });

describe("router", () => {
  it("answers OPTIONS with 204 + CORS", async () => {
    const res = await handle(req("OPTIONS", "/health"), env, deps);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });
  it("GET /health returns 200 {ok:true}", async () => {
    const res = await handle(req("GET", "/health"), env, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
  it("unknown route → 404 JSON", async () => {
    const res = await handle(req("GET", "/nope"), env, deps);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("GET /auth/login 302s (via injected auth)", async () => {
    const auth = {
      async buildAuthorizationUrl() { return { url: "https://auth/authorize", state: "s", nonce: "n", codeVerifier: "c" }; },
      async exchangeCode() { return {}; }, async refresh() { return {}; },
      async verifyIdToken() { return {}; }, buildLogoutUrl() { return ""; },
    };
    const d = { getDb: () => ({}), auth: () => auth, fetchFn: fetch, now: () => 1, newId: () => "x" } as never;
    const res = await handle(req("GET", "/auth/login"), env, d);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/authorize");
  });

  it("GET /api/session returns authenticated:false with no cookie", async () => {
    const d = { getDb: () => ({ async first() { return undefined; }, async all() { return []; }, async run() {} }), auth: () => ({}), fetchFn: fetch, now: () => 1, newId: () => "x" } as never;
    const res = await handle(req("GET", "/api/session"), env, d);
    expect(await res.json()).toEqual({ authenticated: false });
  });

  it("GET /auth/callback is routed (400 without a valid txn)", async () => {
    const d = { getDb: () => ({}), auth: () => ({}), fetchFn: fetch, now: () => 1, newId: () => "x" } as never;
    const res = await handle(req("GET", "/auth/callback"), env, d);
    expect(res.status).toBe(400);
  });

  it("POST /auth/logout is routed → 200 clearing the cookie", async () => {
    const d = { getDb: () => ({ async first() { return undefined; }, async all() { return []; }, async run() {} }), auth: () => ({}), fetchFn: fetch, now: () => 1, newId: () => "x" } as never;
    const res = await handle(req("POST", "/auth/logout"), env, d);
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("GET /api/chats is routed → 401 with no session", async () => {
    const d = { getDb: () => ({ async first() { return undefined; }, async all() { return []; }, async run() {} }), now: () => 1 } as never;
    const res = await handle(req("GET", "/api/chats"), env, d);
    expect(res.status).toBe(401);
  });
  it("POST /api/chats is routed → 401 with no session", async () => {
    const d = { getDb: () => ({ async first() { return undefined; }, async all() { return []; }, async run() {} }), now: () => 1 } as never;
    const res = await handle(req("POST", "/api/chats"), env, d);
    expect(res.status).toBe(401);
  });
  it("GET /api/chats/:id/messages is routed (regex) → 401 with no session", async () => {
    const d = { getDb: () => ({ async first() { return undefined; }, async all() { return []; }, async run() {} }), now: () => 1 } as never;
    const res = await handle(req("GET", "/api/chats/c1/messages"), env, d);
    expect(res.status).toBe(401);
  });
});

describe("GET /ws upgrade", () => {
  const wsReq = (opts: { upgrade?: boolean; chat?: string; cookie?: string } = {}) =>
    new Request(`https://meowsenger-api.alxnko.eu.org/ws${opts.chat ? `?chat=${opts.chat}` : ""}`, {
      method: "GET",
      headers: {
        Origin: ORIGIN,
        ...(opts.upgrade ? { Upgrade: "websocket" } : {}),
        ...(opts.cookie ? { Cookie: opts.cookie } : {}),
      },
    });
  const session = { id: "s1", user_id: "u1", access_token: "a", refresh_token: null, access_exp: 1, created_at: 1, expires_at: 1e12 };
  const depsWith = (over: Partial<{ session: unknown; member: boolean }> = {}) =>
    ({
      getDb: () => ({
        async first(sql: string) {
          if (sql.includes("FROM sessions")) return over.session;
          if (sql.includes("FROM chat_members")) return over.member ? { ok: 1 } : undefined;
          return undefined;
        },
        async all() { return []; },
        async run() {},
      }),
      now: () => 1,
    }) as never;

  it("426 when the Upgrade header is missing", async () => {
    const res = await handle(wsReq({ chat: "c1" }), env, depsWith());
    expect(res.status).toBe(426);
  });
  it("400 when ?chat is missing", async () => {
    const res = await handle(wsReq({ upgrade: true }), env, depsWith());
    expect(res.status).toBe(400);
  });
  it("401 with no valid session", async () => {
    const res = await handle(wsReq({ upgrade: true, chat: "c1", cookie: "__Host-mw_session=stale" }), env, depsWith({ session: undefined }));
    expect(res.status).toBe(401);
  });
  it("403 for a non-member of the chat", async () => {
    const res = await handle(wsReq({ upgrade: true, chat: "c1", cookie: "__Host-mw_session=s1" }), env, depsWith({ session, member: false }));
    expect(res.status).toBe(403);
  });
  it("forwards to the DO stub for a member, passing the gated identity", async () => {
    // The node pool's `Response` rejects a real 101 (workerd-only); the actual
    // upgrade is covered by conversation.workers.test.ts. Here we just assert the
    // gated request reaches the stub with ?user=&chat= and its response is returned.
    let forwardedUrl = "";
    const stubbed = new Response("upgraded", { status: 200 });
    const wsEnv = {
      ...env,
      CONVERSATION: {
        idFromName: (n: string) => n,
        get: () => ({ fetch: (r: Request) => { forwardedUrl = r.url; return stubbed; } }),
      },
    } as unknown as Env;
    const res = await handle(wsReq({ upgrade: true, chat: "c1", cookie: "__Host-mw_session=s1" }), wsEnv, depsWith({ session, member: true }));
    expect(res).toBe(stubbed);
    expect(forwardedUrl).toContain("user=u1");
    expect(forwardedUrl).toContain("chat=c1");
  });
});

describe("default fetch export", () => {
  it("routes /health through the default fetch handler → 200", async () => {
    const fetchEnv = { DB: {} as never, CORS_ORIGINS: "http://localhost:4321" } as Env;
    const res = await worker.fetch(new Request("https://meowsenger-api.alxnko.eu.org/health"), fetchEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
