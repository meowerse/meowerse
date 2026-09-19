import { test, expect } from "vitest";
import { handle } from "../src/index";
import { hashPassword, sha256Hex } from "../src/crypto";
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

test("redirects *.alxnko.eu.org to *.alxnko.dev with 308, CORS and HSTS", async () => {
  const { env, deps } = await fixture();
  const r = await handle(new Request("https://auth.alxnko.eu.org/authorize?client_id=foo"), env, deps);
  expect(r.status).toBe(308);
  expect(r.headers.get("Location")).toBe("https://auth.alxnko.dev/authorize?client_id=foo");
  expect(r.headers.get("Strict-Transport-Security")).toContain("max-age=31536000");

  // Preflight OPTIONS on .eu.org domain returns 204 with CORS
  const pre = await handle(new Request("https://auth.alxnko.eu.org/token", { method: "OPTIONS", headers: { Origin: "http://localhost:5173" } }), env, deps);
  expect(pre.status).toBe(204);
  expect(pre.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
});

test("serves security.txt and robots.txt", async () => {
  const { env, deps } = await fixture();
  const s = await handle(new Request("https://iss/.well-known/security.txt"), env, deps);
  expect(s.status).toBe(200);
  expect(await s.text()).toContain("Contact: mailto:Alexnekokyn@gmail.com");
  expect(s.headers.get("Strict-Transport-Security")).toContain("max-age=31536000");

  const rob = await handle(new Request("https://iss/robots.txt"), env, deps);
  expect(rob.status).toBe(200);
  expect(await rob.text()).toContain("User-agent: GPTBot");
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

test("run_worker_first GET pages (/login,/signup,/consent) serve the real asset; unknown → styled 404", async () => {
  const { env: base, deps } = await fixture();
  // Stub the assets binding: real pages 200, the styled 404 doc exists, everything
  // else 404. Mirrors prod, where /login|/signup|/consent run the worker FIRST
  // (run_worker_first) so their GET page is reachable only via the fallback.
  const ASSETS = {
    fetch: async (input: Request | URL | string) => {
      const href = input instanceof Request ? input.url : input.toString();
      const p = new URL(href).pathname;
      if (p === "/login" || p === "/signup" || p === "/consent")
        return new Response("<html>login page</html>", { status: 200, headers: { "Content-Type": "text/html" } });
      if (p === "/404.html")
        return new Response("<html>styled 404</html>", { status: 200, headers: { "Content-Type": "text/html" } });
      return new Response("", { status: 404 });
    },
  };
  const env = { ...base, ASSETS };
  for (const p of ["/login", "/signup", "/consent"]) {
    const r = await handle(new Request(`https://iss${p}`), env, deps);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("login page");
  }
  // A genuinely-unknown GET renders the styled Astro 404 with a real 404 status.
  const nf = await handle(new Request("https://iss/totally-unknown"), env, deps);
  expect(nf.status).toBe(404);
  expect(await nf.text()).toContain("styled 404");
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

// A fetch stub that fails every Turnstile siteverify (so we exercise the gate
// rejecting, not the network). It must never be reached when a token is absent.
const denyVerify = (async () => ({ json: async () => ({ success: false }) })) as unknown as typeof fetch;

test("Turnstile gate: when configured, /signup + /login reject a missing token (403) BEFORE any PBKDF2", async () => {
  const { env, deps } = await fixture();
  const tsEnv = { ...env, TURNSTILE_SECRET_KEY: "s" };
  const tsDeps = { ...deps, fetch: denyVerify };
  const body = JSON.stringify({ username: "neko_bot", password: "abcdefghijkl" }); // no cf-turnstile-response

  const su = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body }), tsEnv, tsDeps);
  expect(su.status).toBe(403);
  expect(((await su.json()) as { error: string }).error).toBe("turnstile_failed");

  const li = await handle(new Request("https://iss/login", { method: "POST", headers: { "Content-Type": "application/json" }, body }), tsEnv, tsDeps);
  expect(li.status).toBe(403);
});

test("Turnstile gate: disabled by default (no key) → /signup proceeds unchanged", async () => {
  const { env, deps } = await fixture();
  const su = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "neko_ok", password: "abcdefghijkl" }) }), env, deps);
  expect(su.status).toBe(200); // gate is a no-op when TURNSTILE_SECRET_KEY is unset
});

test("consent without a session → 401; bad csrf → 403", async () => {
  const { env, deps } = await fixture();
  const noSess = await handle(new Request("https://iss/consent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "allow", csrf: "x" }) }), env, deps);
  expect(noSess.status).toBe(401);
});

test("token: unsupported grant_type → 400 no-store (public client passes auth)", async () => {
  const { env, deps } = await fixture();
  const r = await handle(new Request("https://iss/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "password", client_id: "mw_demo" }) }), env, deps);
  expect(r.status).toBe(400);
  expect(r.headers.get("Cache-Control")).toContain("no-store");
});

test("token endpoint is IP-rate-limited (429 when the bucket is exhausted)", async () => {
  const store = memStore();
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", CORS_ORIGINS: "https://web" };
  const deps = { getDb: () => store.db, clock: () => 1000 };
  store.tables.rate_limits.push({ bucket: "token:" + (await sha256Hex("|token")), count: 120, window_start: 1000 });
  const r = await handle(new Request("https://iss/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", client_id: "mw_demo" }) }), env as never, deps as never);
  expect(r.status).toBe(429);
});

test("token: confidential client with no secret → 401 invalid_client", async () => {
  const store = memStore();
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", CORS_ORIGINS: "https://web" };
  const deps = { getDb: () => store.db, clock: () => 1000 };
  store.tables.oauth_clients.push({ client_id: "mw_conf", status: "active", client_type: "confidential", display_name: "C", logo_url: null, allowed_scopes: '["openid"]', allow_offline_access: 0, verified_only: 0, first_party: 0 });
  const r = await handle(new Request("https://iss/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", client_id: "mw_conf", code: "x", code_verifier: "y" }) }), env as never, deps as never);
  expect(r.status).toBe(401);
  expect(((await r.json()) as { error: string }).error).toBe("invalid_client");
});

test("userinfo without a bearer → 401", async () => {
  const { env, deps } = await fixture();
  const r = await handle(new Request("https://iss/userinfo"), env, deps);
  expect(r.status).toBe(401);
});

test("GET /avatar/<id> routes to the proxy and streams the current Telegram photo", async () => {
  const { env, deps } = await fixture();
  const { db } = memStore();
  db.execute({ sql: "INSERT INTO telegram_links (telegram_id, account_id, telegram_username, display_name, avatar_url) VALUES (?, ?, ?, ?, ?)", args: [42, "acct_tg", "tg", "TG", null] } as never);
  const urls: string[] = [];
  const fetchStub = (async (url: string) => {
    urls.push(url);
    if (url.includes("/getUserProfilePhotos"))
      return { json: async () => ({ ok: true, result: { total_count: 1, photos: [[{ file_id: "big", width: 640, height: 640 }]] } }) } as unknown as Response;
    if (url.includes("/getFile")) return { json: async () => ({ ok: true, result: { file_path: "photos/x.jpg" } }) } as unknown as Response;
    return { ok: true, body: "IMG" as unknown as ReadableStream, headers: { get: () => "image/png" } } as unknown as Response;
  }) as unknown as typeof fetch;
  const avDeps = { getDb: () => db, clock: () => 1000, fetch: fetchStub };
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => waited.push(p) } as unknown as ExecutionContext;
  const r = await handle(
    new Request("https://iss/avatar/acct_tg"),
    { ...env, TELEGRAM_BOT_TOKEN: "T", SKIP_MIGRATIONS: "1" } as never,
    avDeps as never,
    ctx,
  );
  expect(r.status).toBe(200);
  expect(r.headers.get("Content-Type")).toBe("image/png");
  expect(r.headers.get("Cache-Control")).toBe("public, max-age=21600");
  expect(urls.some((u) => u.includes("/getUserProfilePhotos"))).toBe(true);
});

test("GET /avatar/<id> with no bot token configured → 404", async () => {
  const { env, deps } = await fixture();
  const r = await handle(new Request("https://iss/avatar/acct_tg"), env, deps);
  expect(r.status).toBe(404);
  expect(((await r.json()) as { error: string }).error).toBe("no_avatar");
});

test("logout revokes + clears the session cookie and redirects to the UI", async () => {
  const { env, deps } = await fixture();
  const r = await handle(new Request("https://iss/logout", { headers: { Cookie: "__Host-mw_sess=whatever" } }), env, deps);
  expect(r.status).toBe(302);
  expect(r.headers.get("Location")).toBe("https://web");
  expect(cookieValue(r.headers.get("Set-Cookie"), "__Host-mw_sess")).toBe("");
});

// RP-initiated logout: a `post_logout_redirect_uri` registered as a redirect_uri
// on the client named by the (unverified) id_token_hint is honored; anything
// else falls back to the meowerse UI. The hint is a hint, not a credential.
const idHint = (payload: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

test("logout returns to a registered post_logout_redirect_uri (+state)", async () => {
  const { env, deps } = await fixture();
  const q = new URLSearchParams({ id_token_hint: idHint({ aud: "mw_demo" }), post_logout_redirect_uri: REDIRECT, state: "xyz" });
  const r = await handle(new Request(`https://iss/logout?${q}`), env, deps);
  expect(r.status).toBe(302);
  const loc = new URL(r.headers.get("Location")!);
  expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
  expect(loc.searchParams.get("state")).toBe("xyz");
});

test("logout ignores an unregistered post_logout_redirect_uri → UI", async () => {
  const { env, deps } = await fixture();
  const q = new URLSearchParams({ id_token_hint: idHint({ aud: "mw_demo" }), post_logout_redirect_uri: "https://evil.example/steal" });
  const r = await handle(new Request(`https://iss/logout?${q}`), env, deps);
  expect(r.headers.get("Location")).toBe("https://web");
});

test("logout ignores post_logout_redirect_uri with no id_token_hint → UI", async () => {
  const { env, deps } = await fixture();
  const q = new URLSearchParams({ post_logout_redirect_uri: REDIRECT });
  const r = await handle(new Request(`https://iss/logout?${q}`), env, deps);
  expect(r.headers.get("Location")).toBe("https://web");
});

test("revoke/introspect require a confidential client; unauthenticated → 401", async () => {
  const store = memStore();
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", CORS_ORIGINS: "https://web" };
  const deps = { getDb: () => store.db, clock: () => 1000 };

  // unauthenticated → 401 (closes the token-oracle / revoke-DoS hole)
  const un = await handle(new Request("https://iss/token/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "at_x" }) }), env as never, deps as never);
  expect(un.status).toBe(401);

  const phc = await hashPassword("mws_sec", { rounds: 1, iter: 500 });
  store.tables.oauth_clients.push({ client_id: "mw_conf", status: "active", client_type: "confidential", display_name: "C", logo_url: null, allowed_scopes: '["openid"]', allow_offline_access: 0, verified_only: 0, first_party: 0 });
  store.tables.oauth_client_secrets.push({ client_id: "mw_conf", secret_phc: phc });

  const rev = await handle(new Request("https://iss/token/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: "mw_conf", client_secret: "mws_sec", token: "at_x" }) }), env as never, deps as never);
  expect(rev.status).toBe(200);

  // same, but via HTTP Basic client auth (RFC 6749 §2.3.1)
  const basic = "Basic " + btoa("mw_conf:mws_sec");
  const revBasic = await handle(new Request("https://iss/token/revoke", { method: "POST", headers: { "Content-Type": "application/json", Authorization: basic }, body: JSON.stringify({ token: "at_x" }) }), env as never, deps as never);
  expect(revBasic.status).toBe(200);
  const intro = await handle(new Request("https://iss/token/introspect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: "mw_conf", client_secret: "mws_sec", token: "at_x" }) }), env as never, deps as never);
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
  const body = new URLSearchParams({ grant_type: "password", client_id: "mw_demo" }).toString();
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

// --- amplification hardening: in-worker second-line throttles ---

test("/authorize is IP-rate-limited (429) once the bucket is exhausted", async () => {
  const store = memStore();
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", WEB_ORIGIN: "https://web", CORS_ORIGINS: "https://web" };
  const deps = { getDb: () => store.db, clock: () => 1000 };
  store.tables.rate_limits.push({ bucket: "authorize:" + (await sha256Hex("|authorize")), count: 120, window_start: 1000 });
  const q = new URLSearchParams({ client_id: "mw_demo", redirect_uri: REDIRECT, response_type: "code", scope: "openid", code_challenge: CHALLENGE, code_challenge_method: "S256" });
  const r = await handle(new Request(`https://iss/authorize?${q}`), env as never, deps as never);
  expect(r.status).toBe(429);
});

test("/tg/status is IP-rate-limited (429) once the bucket is exhausted", async () => {
  const store = memStore();
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", CORS_ORIGINS: "https://web" };
  const deps = { getDb: () => store.db, clock: () => 1000 };
  store.tables.rate_limits.push({ bucket: "tgstatus:" + (await sha256Hex("|tgstatus")), count: 120, window_start: 1000 });
  const r = await handle(new Request("https://iss/tg/status?ticket=x"), env as never, deps as never);
  expect(r.status).toBe(429);
});

test("/avatar is IP-rate-limited (429) in front of the Bot-API amplification", async () => {
  const store = memStore();
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", TELEGRAM_BOT_TOKEN: "T", CORS_ORIGINS: "https://web" };
  const deps = { getDb: () => store.db, clock: () => 1000 };
  store.tables.rate_limits.push({ bucket: "avatar:" + (await sha256Hex("|avatar")), count: 120, window_start: 1000 });
  const r = await handle(new Request("https://iss/avatar/acct_x"), env as never, deps as never);
  expect(r.status).toBe(429);
});

test("/login is IP-rate-limited (429), keyed on the client IP hash (not the username)", async () => {
  const store = memStore();
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", CORS_ORIGINS: "https://web" };
  const deps = { getDb: () => store.db, clock: () => 1000 };
  store.tables.rate_limits.push({ bucket: "login:" + (await sha256Hex("|login")), count: 10, window_start: 1000 });
  const r = await handle(
    new Request("https://iss/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "whoever", password: "abcdefghijkl" }) }),
    env as never,
    deps as never,
  );
  expect(r.status).toBe(429);
});

test("/jwks + discovery serve PUBLIC wildcard CORS (no reflected origin, no credentials, no Vary)", async () => {
  const { env, deps } = await fixture();
  const j = await handle(new Request("https://iss/jwks", { headers: { Origin: "https://web" } }), env, deps);
  expect(j.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(j.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  expect(j.headers.get("Vary")).toBeNull();
  const d = await handle(new Request("https://iss/.well-known/openid-configuration", { headers: { Origin: "https://web" } }), env, deps);
  expect(d.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(d.headers.get("Access-Control-Allow-Credentials")).toBeNull();
});
