import { describe, it, expect } from "vitest";
import worker, { handle } from "./index";
import type { Env } from "./types";

const env = { CORS_ORIGINS: "http://localhost:4321" } as Env;
const ORIGIN = "http://localhost:4321";
const deps = { getDb: () => ({}) } as never;
const req = (m: string, p: string) => new Request(`https://meowsenger-api.alxnko.dev${p}`, { method: m, headers: { Origin: ORIGIN } });

describe("router", () => {
  it("redirects *.alxnko.eu.org to *.alxnko.dev with 301 and HSTS", async () => {
    const r = await handle(new Request("https://meowsenger.alxnko.eu.org/health?x=1"), env, deps);
    expect(r.status).toBe(301);
    expect(r.headers.get("Location")).toBe("https://meowsenger.alxnko.dev/health?x=1");
    expect(r.headers.get("Strict-Transport-Security")).toContain("max-age=31536000");
  });

  it("serves security.txt and robots.txt", async () => {
    const s = await handle(new Request("https://meowsenger-api.alxnko.dev/.well-known/security.txt"), env, deps);
    expect(s.status).toBe(200);
    expect(await s.text()).toContain("Contact: mailto:Alexnekokyn@gmail.com");
    expect(s.headers.get("Strict-Transport-Security")).toContain("max-age=31536000");

    const rob = await handle(new Request("https://meowsenger-api.alxnko.dev/robots.txt"), env, deps);
    expect(rob.status).toBe(200);
    expect(await rob.text()).toContain("User-agent: GPTBot");
  });

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
  it("POST /api/chats/:id/forward is routed (regex) → 401 with no session", async () => {
    const d = { getDb: () => ({ async first() { return undefined; }, async all() { return []; }, async run() {} }), now: () => 1 } as never;
    const res = await handle(req("POST", "/api/chats/c1/forward"), env, d);
    expect(res.status).toBe(401);
  });

  // Slice 5 route wiring: each new endpoint reaches its handler (asserted via the
  // no-session 401, which every mutation returns before touching the DB).
  const noSession = () => ({ getDb: () => ({ async first() { return undefined; }, async all() { return []; }, async run() {} }), now: () => 1 } as never);
  it("GET /api/slug-available is routed → 401 with no session", async () => {
    expect((await handle(req("GET", "/api/slug-available?slug=abc"), env, noSession())).status).toBe(401);
  });
  it("GET /api/chats/:id/members is routed → 401", async () => {
    expect((await handle(req("GET", "/api/chats/g1/members"), env, noSession())).status).toBe(401);
  });
  it("POST /api/chats/:id/members is routed → 401", async () => {
    expect((await handle(req("POST", "/api/chats/g1/members"), env, noSession())).status).toBe(401);
  });
  it("DELETE /api/chats/:id/members/:userId is routed → 401", async () => {
    expect((await handle(req("DELETE", "/api/chats/g1/members/u2"), env, noSession())).status).toBe(401);
  });
  it("POST /api/chats/:id/members/:userId/role is routed → 401", async () => {
    expect((await handle(req("POST", "/api/chats/g1/members/u2/role"), env, noSession())).status).toBe(401);
  });
  it("POST /api/chats/:id/leave is routed → 401", async () => {
    expect((await handle(req("POST", "/api/chats/g1/leave"), env, noSession())).status).toBe(401);
  });
  it("PATCH /api/chats/:id is routed → 401", async () => {
    expect((await handle(req("PATCH", "/api/chats/g1"), env, noSession())).status).toBe(401);
  });
  // Slice 6 route wiring: discovery + open-join reach their handlers (401 no-session).
  it("GET /api/chats/by-slug/:slug is routed → 401", async () => {
    expect((await handle(req("GET", "/api/chats/by-slug/open"), env, noSession())).status).toBe(401);
  });
  it("POST /api/chats/:id/join is routed → 401", async () => {
    expect((await handle(req("POST", "/api/chats/g1/join"), env, noSession())).status).toBe(401);
  });
  it("POST /api/chats/:id/subscribe (channel alias) is routed → 401", async () => {
    expect((await handle(req("POST", "/api/chats/g1/subscribe"), env, noSession())).status).toBe(401);
  });
  // Slice 7 route wiring: invites, join requests, and account privacy reach their
  // handlers (asserted via the no-session 401 every handler returns first).
  it("POST /api/chats/:id/invite is routed → 401", async () => {
    expect((await handle(req("POST", "/api/chats/g1/invite"), env, noSession())).status).toBe(401);
  });
  it("DELETE /api/chats/:id/invite is routed → 401", async () => {
    expect((await handle(req("DELETE", "/api/chats/g1/invite"), env, noSession())).status).toBe(401);
  });
  it("GET /api/invite/:code is routed → 401", async () => {
    expect((await handle(req("GET", "/api/invite/code00000000"), env, noSession())).status).toBe(401);
  });
  it("POST /api/invite/:code/accept is routed → 401", async () => {
    expect((await handle(req("POST", "/api/invite/code00000000/accept"), env, noSession())).status).toBe(401);
  });
  it("POST /api/chats/:id/request is routed → 401", async () => {
    expect((await handle(req("POST", "/api/chats/g1/request"), env, noSession())).status).toBe(401);
  });
  it("GET /api/chats/:id/requests is routed → 401", async () => {
    expect((await handle(req("GET", "/api/chats/g1/requests"), env, noSession())).status).toBe(401);
  });
  it("POST /api/chats/:id/requests/:rid/approve is routed → 401", async () => {
    expect((await handle(req("POST", "/api/chats/g1/requests/r1/approve"), env, noSession())).status).toBe(401);
  });
  it("POST /api/chats/:id/requests/:rid/reject is routed → 401", async () => {
    expect((await handle(req("POST", "/api/chats/g1/requests/r1/reject"), env, noSession())).status).toBe(401);
  });
  it("GET /api/account/privacy is routed → 401", async () => {
    expect((await handle(req("GET", "/api/account/privacy"), env, noSession())).status).toBe(401);
  });
  it("POST /api/account/privacy is routed → 401", async () => {
    expect((await handle(req("POST", "/api/account/privacy"), env, noSession())).status).toBe(401);
  });
  // Slice 9 route wiring: within-chat search + account deletion (401 no-session).
  it("GET /api/chats/:id/search is routed (regex) → 401", async () => {
    expect((await handle(req("GET", "/api/chats/c1/search?q=hi"), env, noSession())).status).toBe(401);
  });
  it("POST /api/account/delete is routed → 401", async () => {
    expect((await handle(req("POST", "/api/account/delete"), env, noSession())).status).toBe(401);
  });
});

describe("GET /ws upgrade", () => {
  const wsReq = (opts: { upgrade?: boolean; chat?: string; cookie?: string } = {}) =>
    new Request(`https://meowsenger-api.alxnko.dev/ws${opts.chat ? `?chat=${opts.chat}` : ""}`, {
      method: "GET",
      headers: {
        Origin: ORIGIN,
        ...(opts.upgrade ? { Upgrade: "websocket" } : {}),
        ...(opts.cookie ? { Cookie: opts.cookie } : {}),
      },
    });
  const session = { id: "s1", user_id: "u1", access_token: "a", refresh_token: null, access_exp: 1, created_at: 1, expires_at: 1e12 };
  const depsWith = (over: Partial<{ session: unknown; member: boolean; role: string; type: string }> = {}) =>
    ({
      getDb: () => ({
        async first(sql: string) {
          if (sql.includes("FROM sessions")) return over.session;
          // getRole (membership gate + role forwarding) reads `role`.
          if (sql.includes("FROM chat_members")) return over.member ? { role: over.role ?? "member" } : undefined;
          // chatType (Slice 6): the chat's type is forwarded to the DO.
          if (sql.includes("SELECT type FROM chats")) return { type: over.type ?? "group" };
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

  const inboxReq = (opts: { upgrade?: boolean; cookie?: string } = {}) =>
    new Request("https://meowsenger-api.alxnko.dev/inbox/ws", {
      method: "GET",
      headers: { Origin: ORIGIN, ...(opts.upgrade ? { Upgrade: "websocket" } : {}), ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    });
  it("inbox/ws: 426 without the Upgrade header", async () => {
    expect((await handle(inboxReq(), env, depsWith())).status).toBe(426);
  });
  it("inbox/ws: 401 without a valid session (no membership gate — own inbox only)", async () => {
    expect((await handle(inboxReq({ upgrade: true, cookie: "__Host-mw_session=stale" }), env, depsWith({ session: undefined }))).status).toBe(401);
  });
  it("inbox/ws: 503 when USER_INBOX isn't bound (session OK, no chat/role read needed)", async () => {
    // env (test fixture) has no USER_INBOX binding → the gated handler reports unavailable.
    expect((await handle(inboxReq({ upgrade: true, cookie: "__Host-mw_session=s1" }), env, depsWith({ session }))).status).toBe(503);
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
    const res = await handle(wsReq({ upgrade: true, chat: "c1", cookie: "__Host-mw_session=s1" }), wsEnv, depsWith({ session, member: true, role: "admin", type: "channel" }));
    expect(res).toBe(stubbed);
    expect(forwardedUrl).toContain("user=u1");
    expect(forwardedUrl).toContain("chat=c1");
    // Slice 5: the caller's D1-derived role is forwarded so the DO can authorize
    // admin/owner message-delete without a second membership read.
    expect(forwardedUrl).toContain("role=admin");
    // Slice 6: the chat's type is forwarded so the DO can enforce the channel
    // read-only posting rule (member sockets on a channel can't post).
    expect(forwardedUrl).toContain("type=channel");
  });
});

describe("per-IP write throttle (WRITE_LIMIT)", () => {
  // Fake the Rate Limiting binding: limit() resolves { success } deterministically.
  const throttleEnv = (success: boolean) =>
    ({ ...env, WRITE_LIMIT: { async limit() { return { success }; } } }) as unknown as Env;
  // No-session deps: an expensive write that passes the throttle falls through to its
  // handler, which returns 401 (proving the throttle let it through, not that it ran).
  const noSession = { getDb: () => ({ async first() { return undefined; }, async all() { return []; }, async run() {} }), now: () => 1 } as never;

  it("returns 429 rate_limited when the limiter denies an expensive write POST", async () => {
    const res = await handle(req("POST", "/api/chats"), throttleEnv(false), noSession);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });
  it("passes through to the handler when the limiter allows the write", async () => {
    const res = await handle(req("POST", "/api/chats"), throttleEnv(true), noSession);
    expect(res.status).toBe(401); // reached handleCreateChat (no session)
  });
  it("does NOT throttle non-expensive routes even when the limiter would deny", async () => {
    // A GET read is never gated; it must reach its handler regardless of the limiter.
    const res = await handle(req("GET", "/api/chats"), throttleEnv(false), noSession);
    expect(res.status).toBe(401);
  });
});

describe("default fetch export", () => {
  it("routes /health through the default fetch handler → 200", async () => {
    const fetchEnv = { DB: {} as never, CORS_ORIGINS: "http://localhost:4321" } as Env;
    const res = await worker.fetch(new Request("https://meowsenger-api.alxnko.dev/health"), fetchEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
