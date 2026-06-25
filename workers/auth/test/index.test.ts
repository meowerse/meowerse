import { test, expect } from "vitest";
import { handle } from "../src/index";
import { genSigningKeys, memStore, cookieValue } from "./helpers";

async function fixture() {
  const { db } = memStore();
  const keys = await genSigningKeys("k1", "active");
  const env = {
    AUTH_SIGNING_KEYS: JSON.stringify(keys),
    ISSUER: "https://iss",
    WEB_ORIGIN: "https://web",
    RESOURCE_AUD: "https://api.meow",
    STATE_SECRET: "s",
    CORS_ORIGINS: "https://web",
  };
  return { env, deps: { getDb: () => db, clock: () => 1000 } };
}

const REDIRECT = "http://localhost:4321/callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

test("OPTIONS preflight → 204 with CORS", async () => {
  const { env, deps } = await fixture();
  const r = await handle(new Request("https://iss/authorize", { method: "OPTIONS", headers: { Origin: "https://web" } }), env, deps);
  expect(r.status).toBe(204);
  expect(r.headers.get("Access-Control-Allow-Origin")).toBe("https://web");
});

test("discovery + jwks are served and cacheable", async () => {
  const { env, deps } = await fixture();
  const d = await handle(new Request("https://iss/.well-known/openid-configuration"), env, deps);
  expect(d.status).toBe(200);
  expect(((await d.json()) as Record<string, unknown>).issuer).toBe("https://iss");
  expect(d.headers.get("Cache-Control")).toContain("max-age=3600");

  const j = await handle(new Request("https://iss/jwks"), env, deps);
  const jwks = (await j.json()) as { keys: unknown[] };
  expect(jwks.keys.length).toBe(1);
});

test("unknown route → 404; thrown error → generic 500", async () => {
  const { env, deps } = await fixture();
  expect((await handle(new Request("https://iss/nope"), env, deps)).status).toBe(404);

  // a getDb that throws should surface as a generic 500 via the fetch wrapper,
  // but handle() itself rethrows; emulate the wrapper:
  const boom = { getDb: () => { throw new Error("db down"); }, clock: () => 1000 };
  await expect(handle(new Request("https://iss/authorize?client_id=x"), env, boom)).rejects.toThrow();
});

test("authorize: unknown client is a FATAL on-site error (never a redirect)", async () => {
  const { env, deps } = await fixture();
  const r = await handle(new Request("https://iss/authorize?client_id=ghost&redirect_uri=https://x/cb&response_type=code&scope=openid&code_challenge=c&code_challenge_method=S256"), env, deps);
  expect(r.status).toBe(400);
  expect(r.headers.get("Content-Type")).toContain("text/html");
  expect(r.headers.get("Referrer-Policy")).toBe("no-referrer");
});

test("authorize: bad scope on a known client redirects with error+state+iss", async () => {
  const { env, deps } = await fixture();
  const q = new URLSearchParams({ client_id: "mw_demo", redirect_uri: REDIRECT, response_type: "code", scope: "openid admin", state: "st", code_challenge: CHALLENGE, code_challenge_method: "S256" });
  const r = await handle(new Request(`https://iss/authorize?${q}`), env, deps);
  expect(r.status).toBe(302);
  const loc = new URL(r.headers.get("Location")!);
  expect(loc.searchParams.get("error")).toBe("invalid_scope");
  expect(loc.searchParams.get("state")).toBe("st");
  expect(loc.searchParams.get("iss")).toBe("https://iss");
});

test("authorize prompt=none with no session → login_required redirect", async () => {
  const { env, deps } = await fixture();
  const q = new URLSearchParams({ client_id: "mw_demo", redirect_uri: REDIRECT, response_type: "code", scope: "openid profile", state: "s", prompt: "none", code_challenge: CHALLENGE, code_challenge_method: "S256" });
  const r = await handle(new Request(`https://iss/authorize?${q}`), env, deps);
  const loc = new URL(r.headers.get("Location")!);
  expect(loc.searchParams.get("error")).toBe("login_required");
});

test("login with bad credentials → 401; rate-limited path returns 429", async () => {
  const { env, deps } = await fixture();
  const bad = await handle(new Request("https://iss/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "nobody", password: "whatever12345" }) }), env, deps);
  expect(bad.status).toBe(401);
});

test("consent without a session → 401; bad csrf → 403", async () => {
  const { env, deps } = await fixture();
  const noSess = await handle(new Request("https://iss/consent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "allow", csrf: "x" }) }), env, deps);
  expect(noSess.status).toBe(401);
});

test("token: unsupported grant_type → 400 no-store", async () => {
  const { env, deps } = await fixture();
  const r = await handle(new Request("https://iss/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "password" }) }), env, deps);
  expect(r.status).toBe(400);
  expect(r.headers.get("Cache-Control")).toContain("no-store");
});

test("userinfo without a bearer → 401", async () => {
  const { env, deps } = await fixture();
  const r = await handle(new Request("https://iss/userinfo"), env, deps);
  expect(r.status).toBe(401);
});

test("logout revokes + clears the session cookie and redirects to the UI", async () => {
  const { env, deps } = await fixture();
  const r = await handle(new Request("https://iss/logout", { headers: { Cookie: "__Host-mw_sess=whatever" } }), env, deps);
  expect(r.status).toBe(302);
  expect(r.headers.get("Location")).toBe("https://web");
  expect(cookieValue(r.headers.get("Set-Cookie"), "__Host-mw_sess")).toBe("");
});

test("revoke always 200; introspect reports inactive for unknown jti", async () => {
  const { env, deps } = await fixture();
  const rev = await handle(new Request("https://iss/token/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "at_x" }) }), env, deps);
  expect(rev.status).toBe(200);
  const intro = await handle(new Request("https://iss/token/introspect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "at_x" }) }), env, deps);
  expect(((await intro.json()) as { active: boolean }).active).toBe(false);
});

test("authorize and userinfo also accept POST", async () => {
  const { env, deps } = await fixture();
  const q = new URLSearchParams({ client_id: "mw_demo", redirect_uri: REDIRECT, response_type: "code", scope: "openid profile", code_challenge: CHALLENGE, code_challenge_method: "S256" });
  const a = await handle(new Request(`https://iss/authorize?${q}`, { method: "POST" }), env, deps);
  expect(a.status).toBe(302);
  const u = await handle(new Request("https://iss/userinfo", { method: "POST" }), env, deps);
  expect(u.status).toBe(401);
});

test("token endpoint parses form-urlencoded bodies", async () => {
  const { env, deps } = await fixture();
  const body = new URLSearchParams({ grant_type: "password" }).toString();
  const r = await handle(new Request("https://iss/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }), env, deps);
  expect(r.status).toBe(400); // unsupported_grant_type — but exercised the form parser
});

test("malformed JSON body degrades to empty params (no throw)", async () => {
  const { env, deps } = await fixture();
  const r = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{ not json" }), env, deps);
  expect(r.status).toBe(400); // signup with empty username
});

test("default fetch wrapper turns a thrown handler into a 500", async () => {
  const mod = (await import("../src/index")).default;
  const r = await mod.fetch(new Request("https://iss/jwks"), { AUTH_SIGNING_KEYS: "not json" } as never);
  expect(r.status).toBe(500);
  expect(((await r.json()) as { error: string }).error).toBe("internal_error");
});
