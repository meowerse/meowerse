import { test, expect } from "vitest";
import { handle } from "../src/index";
import { sha256Hex } from "../src/crypto";
import { genSigningKeys, memStore, cookieValue } from "./helpers";

const REDIRECT = "http://localhost:4321/callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

async function fixture() {
  const store = memStore();
  const keys = await genSigningKeys("k1", "active");
  const env = {
    AUTH_SIGNING_KEYS: JSON.stringify(keys),
    ISSUER: "https://iss",
    WEB_ORIGIN: "https://web",
    RESOURCE_AUD: "https://api.meow",
    STATE_SECRET: "s",
    CORS_ORIGINS: "https://web",
  };
  // extra clients for the gated/expanded-scope branches
  store.tables.oauth_clients.push(
    { client_id: "mw_full", status: "active", client_type: "public", display_name: "Full", logo_url: null, allowed_scopes: '["openid","profile","telegram"]', allow_offline_access: 0, verified_only: 0, first_party: 0 },
    { client_id: "mw_vo", status: "active", client_type: "public", display_name: "VO", logo_url: null, allowed_scopes: '["openid","profile"]', allow_offline_access: 0, verified_only: 1, first_party: 0 },
    { client_id: "mw_rt", status: "active", client_type: "public", display_name: "RT", logo_url: null, allowed_scopes: '["openid","profile","offline_access"]', allow_offline_access: 1, verified_only: 0, first_party: 0 },
  );
  store.tables.oauth_client_redirect_uris.push(
    { client_id: "mw_full", redirect_uri: "http://localhost:4321/cb2" },
    { client_id: "mw_vo", redirect_uri: "http://localhost:4321/cb3" },
    { client_id: "mw_rt", redirect_uri: "http://localhost:4321/cb4" },
  );
  return { env, deps: { getDb: () => store.db, clock: () => 1000 }, store };
}

function authzUrl(clientId: string, redirect: string, scope: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", scope, state: "st", code_challenge: CHALLENGE, code_challenge_method: "S256", ...extra });
  return `https://iss/authorize?${q}`;
}

async function signupUser(env: Record<string, string>, deps: { getDb: () => unknown; clock: () => number }, username: string) {
  const r = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: "abcdefghijkl" }) }), env as never, deps as never);
  const b = (await r.json()) as { csrf: string };
  return { sess: cookieValue(r.headers.get("Set-Cookie"), "__Host-mw_sess")!, csrf: b.csrf };
}

test("logged-in with covering prior consent → silent code (SSO, zero clicks)", async () => {
  const { env, deps, store } = await fixture();
  const { sess } = await signupUser(env, deps, "neko_sso");
  const account = store.tables.accounts.find((a) => a.username === "neko_sso")!;
  store.tables.consents.push({ account_id: account.id, client_id: "mw_demo", scope_set_max: '["openid","profile"]', approved_scope_snapshot: '["openid","profile"]' });

  const r = await handle(new Request(authzUrl("mw_demo", REDIRECT, "openid profile"), { headers: { Cookie: `__Host-mw_sess=${sess}` } }), env as never, deps as never);
  expect(r.status).toBe(302);
  const loc = new URL(r.headers.get("Location")!);
  expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
  expect(loc.searchParams.get("code")).toBeTruthy();
});

test("logged-in needing NEW-scope consent → 302 to /consent with tkt", async () => {
  const { env, deps } = await fixture();
  const { sess } = await signupUser(env, deps, "neko_new");
  const r = await handle(new Request(authzUrl("mw_full", "http://localhost:4321/cb2", "openid telegram"), { headers: { Cookie: `__Host-mw_sess=${sess}` } }), env as never, deps as never);
  expect(r.headers.get("Location")).toBe("https://web/consent");
  expect(cookieValue(r.headers.get("Set-Cookie"), "__Host-mw_tkt")).toBeTruthy();
});

test("logged-in prompt=none needing consent → consent_required", async () => {
  const { env, deps } = await fixture();
  const { sess } = await signupUser(env, deps, "neko_pn");
  const r = await handle(new Request(authzUrl("mw_full", "http://localhost:4321/cb2", "openid telegram", { prompt: "none" }), { headers: { Cookie: `__Host-mw_sess=${sess}` } }), env as never, deps as never);
  expect(new URL(r.headers.get("Location")!).searchParams.get("error")).toBe("consent_required");
});

test("verified-only client + unverified user → /verify (and interaction_required for prompt=none)", async () => {
  const { env, deps } = await fixture();
  const { sess } = await signupUser(env, deps, "neko_vo");
  const r = await handle(new Request(authzUrl("mw_vo", "http://localhost:4321/cb3", "openid profile"), { headers: { Cookie: `__Host-mw_sess=${sess}` } }), env as never, deps as never);
  expect(r.headers.get("Location")).toBe("https://web/verify");

  const pn = await handle(new Request(authzUrl("mw_vo", "http://localhost:4321/cb3", "openid profile", { prompt: "none" }), { headers: { Cookie: `__Host-mw_sess=${sess}` } }), env as never, deps as never);
  expect(new URL(pn.headers.get("Location")!).searchParams.get("error")).toBe("interaction_required");
});

test("granular consent grants only the checked scopes (openid always kept)", async () => {
  const { env, deps, store } = await fixture();
  const { sess, csrf } = await signupUser(env, deps, "neko_gran");
  const account = store.tables.accounts.find((a) => a.username === "neko_gran")!;
  // authorize mw_full requesting openid+telegram → consent needed
  const a = await handle(new Request(authzUrl("mw_full", "http://localhost:4321/cb2", "openid telegram"), { headers: { Cookie: `__Host-mw_sess=${sess}` } }), env as never, deps as never);
  const tkt = cookieValue(a.headers.get("Set-Cookie"), "__Host-mw_tkt")!;
  // approve ONLY openid (uncheck telegram)
  const r = await handle(new Request("https://iss/consent", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${sess}; __Host-mw_tkt=${tkt}` }, body: JSON.stringify({ decision: "allow", csrf, scopes: "openid" }) }), env as never, deps as never);
  expect(r.status).toBe(200);
  const grant = store.tables.consents.find((c) => c.account_id === account.id && c.client_id === "mw_full")!;
  expect(JSON.parse(String(grant.approved_scope_snapshot))).toEqual(["openid"]); // telegram NOT granted
});

test("consent deny → access_denied redirect", async () => {
  const { env, deps } = await fixture();
  const { sess, csrf } = await signupUser(env, deps, "neko_deny");
  // obtain a tkt for mw_full
  const a = await handle(new Request(authzUrl("mw_full", "http://localhost:4321/cb2", "openid telegram"), { headers: { Cookie: `__Host-mw_sess=${sess}` } }), env as never, deps as never);
  const tkt = cookieValue(a.headers.get("Set-Cookie"), "__Host-mw_tkt")!;
  const r = await handle(new Request("https://iss/consent", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${sess}; __Host-mw_tkt=${tkt}` }, body: JSON.stringify({ decision: "deny", csrf }) }), env as never, deps as never);
  const loc = new URL(((await r.json()) as { redirect: string }).redirect);
  expect(loc.searchParams.get("error")).toBe("access_denied");
});

test("consent allow on a verified-only client by an unverified user → 403", async () => {
  const { env, deps } = await fixture();
  const { sess, csrf } = await signupUser(env, deps, "neko_vo2");
  const a = await handle(new Request(authzUrl("mw_vo", "http://localhost:4321/cb3", "openid profile"), { headers: { Cookie: `__Host-mw_sess=${sess}` } }), env as never, deps as never);
  const tkt = cookieValue(a.headers.get("Set-Cookie"), "__Host-mw_tkt")!;
  const r = await handle(new Request("https://iss/consent", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${sess}; __Host-mw_tkt=${tkt}` }, body: JSON.stringify({ decision: "allow", csrf }) }), env as never, deps as never);
  expect(r.status).toBe(403);
});

test("login rotates an existing session and resolves next=done with no pending request", async () => {
  const { env, deps } = await fixture();
  const { sess } = await signupUser(env, deps, "neko_login");
  const r = await handle(new Request("https://iss/login", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${sess}` }, body: JSON.stringify({ username: "neko_login", password: "abcdefghijkl" }) }), env as never, deps as never);
  const b = (await r.json()) as { ok: boolean; next: { action: string } };
  expect(r.status).toBe(200);
  expect(b.ok).toBe(true);
  expect(b.next.action).toBe("done");
  expect(cookieValue(r.headers.get("Set-Cookie"), "__Host-mw_sess")).not.toBe(sess); // rotated
});

test("signup is rate-limited once the bucket is exhausted", async () => {
  const { env, deps, store } = await fixture();
  const bucket = "signup:" + (await sha256Hex("|signup"));
  store.tables.rate_limits.push({ bucket, count: 20, window_start: 1000 });
  const r = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "blocked_user", password: "abcdefghijkl" }) }), env as never, deps as never);
  expect(r.status).toBe(429);
});

test("login with no existing session issues a fresh one (no rotate)", async () => {
  const { env, deps } = await fixture();
  await signupUser(env, deps, "neko_fresh");
  const r = await handle(new Request("https://iss/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "neko_fresh", password: "abcdefghijkl" }) }), env as never, deps as never);
  expect(r.status).toBe(200);
  expect(cookieValue(r.headers.get("Set-Cookie"), "__Host-mw_sess")).toBeTruthy();
});

test("login with a pending request + covering prior consent → next=redirect (silent)", async () => {
  const { env, deps, store } = await fixture();
  await signupUser(env, deps, "neko_silent");
  const account = store.tables.accounts.find((a) => a.username === "neko_silent")!;
  store.tables.consents.push({ account_id: account.id, client_id: "mw_demo", scope_set_max: '["openid","profile"]', approved_scope_snapshot: '["openid","profile"]' });
  // get a tkt for mw_demo while logged out
  const a = await handle(new Request(authzUrl("mw_demo", REDIRECT, "openid profile")), env as never, deps as never);
  const tkt = cookieValue(a.headers.get("Set-Cookie"), "__Host-mw_tkt")!;
  const r = await handle(new Request("https://iss/login", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_tkt=${tkt}` }, body: JSON.stringify({ username: "neko_silent", password: "abcdefghijkl" }) }), env as never, deps as never);
  const b = (await r.json()) as { next: { action: string; url: string } };
  expect(b.next.action).toBe("redirect");
  expect(new URL(b.next.url).searchParams.get("code")).toBeTruthy();
});

test("consent POST without a pending request → 400 no_request", async () => {
  const { env, deps } = await fixture();
  const { sess, csrf } = await signupUser(env, deps, "neko_nr");
  const r = await handle(new Request("https://iss/consent", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${sess}` }, body: JSON.stringify({ decision: "allow", csrf }) }), env as never, deps as never);
  expect(r.status).toBe(400);
});

test("GET /authorize/pending returns client+scope+csrf for the consent UI; 401/400 otherwise", async () => {
  const { env, deps } = await fixture();
  const { sess } = await signupUser(env, deps, "neko_pend");
  // no pending request yet → 400
  const empty = await handle(new Request("https://iss/authorize/pending", { headers: { Cookie: `__Host-mw_sess=${sess}` } }), env as never, deps as never);
  expect(empty.status).toBe(400);
  // no session → 401
  const noSess = await handle(new Request("https://iss/authorize/pending"), env as never, deps as never);
  expect(noSess.status).toBe(401);
  // with a pending request → 200 with details
  const a = await handle(new Request(authzUrl("mw_full", "http://localhost:4321/cb2", "openid telegram"), { headers: { Cookie: `__Host-mw_sess=${sess}` } }), env as never, deps as never);
  const tkt = cookieValue(a.headers.get("Set-Cookie"), "__Host-mw_tkt")!;
  const r = await handle(new Request("https://iss/authorize/pending", { headers: { Cookie: `__Host-mw_sess=${sess}; __Host-mw_tkt=${tkt}` } }), env as never, deps as never);
  const b = (await r.json()) as { client: { name: string }; scope: string[]; csrf: string };
  expect(r.status).toBe(200);
  expect(b.client.name).toBe("Full");
  expect(b.scope).toEqual(["openid", "telegram"]);
  expect(b.csrf).toBeTruthy();
});

test("refresh token: issued with offline_access, rotates, reuse revokes family", async () => {
  const { env, deps } = await fixture();
  const RT_REDIRECT = "http://localhost:4321/cb4";
  // authorize (logged out) → tkt
  const r1 = await handle(new Request(authzUrl("mw_rt", RT_REDIRECT, "openid offline_access")), env as never, deps as never);
  const tkt = cookieValue(r1.headers.get("Set-Cookie"), "__Host-mw_tkt")!;
  // signup → session
  const r2 = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_tkt=${tkt}` }, body: JSON.stringify({ username: "neko_rt", password: "abcdefghijkl" }) }), env as never, deps as never);
  const b2 = (await r2.json()) as { csrf: string };
  const sess = cookieValue(r2.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  // consent allow → code
  const r3 = await handle(new Request("https://iss/consent", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${sess}; __Host-mw_tkt=${tkt}` }, body: JSON.stringify({ decision: "allow", csrf: b2.csrf }) }), env as never, deps as never);
  const code = new URL(((await r3.json()) as { redirect: string }).redirect).searchParams.get("code")!;
  // token → includes refresh_token
  const r4 = await handle(new Request("https://iss/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: "mw_rt", redirect_uri: RT_REDIRECT }) }), env as never, deps as never);
  const b4 = (await r4.json()) as { refresh_token: string; scope: string };
  expect(b4.refresh_token?.startsWith("rt_")).toBe(true);
  expect(b4.scope).toBe("openid offline_access");

  // refresh grant → new tokens + rotated refresh
  const r5 = await handle(new Request("https://iss/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: b4.refresh_token, client_id: "mw_rt" }) }), env as never, deps as never);
  const b5 = (await r5.json()) as { refresh_token: string; access_token: string };
  expect(r5.status).toBe(200);
  expect(b5.refresh_token).not.toBe(b4.refresh_token);
  expect(b5.access_token).toBeTruthy();

  // reusing the FIRST (now-consumed) refresh → invalid_grant (family revoked)
  const r6 = await handle(new Request("https://iss/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: b4.refresh_token, client_id: "mw_rt" }) }), env as never, deps as never);
  expect(r6.status).toBe(400);
});

test("full loop works on built-in defaults when ISSUER/WEB_ORIGIN/RESOURCE_AUD/STATE_SECRET are omitted", async () => {
  const store = memStore();
  const keys = await genSigningKeys("k1", "active");
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), CORS_ORIGINS: "https://x" };
  const deps = { getDb: () => store.db, clock: () => 1000 };

  const r1 = await handle(new Request(authzUrl("mw_demo", REDIRECT, "openid profile")), env as never, deps as never);
  expect(r1.headers.get("Location")).toBe("https://auth.alxnko.eu.org/login"); // default WEB_ORIGIN
  const tkt = cookieValue(r1.headers.get("Set-Cookie"), "__Host-mw_tkt")!;

  const r2 = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_tkt=${tkt}` }, body: JSON.stringify({ username: "neko_def", password: "abcdefghijkl" }) }), env as never, deps as never);
  const b2 = (await r2.json()) as { csrf: string };
  const sess = cookieValue(r2.headers.get("Set-Cookie"), "__Host-mw_sess")!;

  const r3 = await handle(new Request("https://iss/consent", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${sess}; __Host-mw_tkt=${tkt}` }, body: JSON.stringify({ decision: "allow", csrf: b2.csrf }) }), env as never, deps as never);
  const code = new URL(((await r3.json()) as { redirect: string }).redirect).searchParams.get("code")!;

  const r4 = await handle(new Request("https://iss/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: "mw_demo", redirect_uri: REDIRECT }) }), env as never, deps as never);
  const b4 = (await r4.json()) as { access_token: string };
  expect(r4.status).toBe(200);

  const r5 = await handle(new Request("https://iss/userinfo", { headers: { Authorization: `Bearer ${b4.access_token}` } }), env as never, deps as never);
  expect(r5.status).toBe(200); // default RESOURCE_AUD path
});

async function login(username: string) {
  const store = memStore();
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", CORS_ORIGINS: "https://web" };
  const deps = { getDb: () => store.db, clock: () => 1000 };
  const su = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: "accttest1234" }) }), env as never, deps as never);
  const sess = cookieValue(su.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  return { store, env, deps, sess };
}

test("GET /api/session reports the logged-in user", async () => {
  const { env, deps, sess } = await login("sess_user");
  const r = await handle(new Request("https://iss/api/session", { headers: { Cookie: `__Host-mw_sess=${sess}` } }), env as never, deps as never);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ authenticated: true, username: "sess_user", verified: false });
});

test("GET /api/session reports a guest with no session (200, not 401)", async () => {
  const { env, deps } = await login("sess_guest");
  const r = await handle(new Request("https://iss/api/session"), env as never, deps as never);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ authenticated: false });
});

test("GET /api/session with a session whose account was deleted → authenticated:false", async () => {
  const { store, env, deps, sess } = await login("sess_gone");
  // drop the account row out from under a still-valid session cookie
  store.tables.accounts = store.tables.accounts.filter((a) => a.username !== "sess_gone");
  const r = await handle(new Request("https://iss/api/session", { headers: { Cookie: `__Host-mw_sess=${sess}` } }), env as never, deps as never);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ authenticated: false });
});

test("GET /api/session falls back to displayName for a username-less (telegram-only) account", async () => {
  const { store, env, deps } = await login("sess_seed"); // just to build env/deps + a memStore
  const idHash = await (await import("../src/crypto")).sha256Hex("tgraw");
  store.tables.accounts.push({ id: "acct_tgs", username: null, display_name: "Neko TG", avatar_url: null, verified: 1 });
  store.tables.telegram_links.push({ telegram_id: "9", account_id: "acct_tgs", telegram_username: "nekotg" });
  store.tables.sessions.push({ id_hash: idHash, account_id: "acct_tgs", auth_time: 1000, amr: "tg", csrf_token: "c", idle_expires_at: 9e9, absolute_expires_at: 9e9, revoked_at: null });
  const r = await handle(new Request("https://iss/api/session", { headers: { Cookie: "__Host-mw_sess=tgraw" } }), env as never, deps as never);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ authenticated: true, username: "Neko TG", verified: true });
});
