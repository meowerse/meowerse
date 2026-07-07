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
});

describe("default fetch export", () => {
  it("routes /health through the default fetch handler → 200", async () => {
    const fetchEnv = { DB: {} as never, CORS_ORIGINS: "http://localhost:4321" } as Env;
    const res = await worker.fetch(new Request("https://meowsenger-api.alxnko.eu.org/health"), fetchEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
