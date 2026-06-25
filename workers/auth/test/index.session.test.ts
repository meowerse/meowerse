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
    { client_id: "mw_full", status: "active", client_type: "public", display_name: "Full", logo_url: null, allowed_scopes: '["openid","profile","telegram"]', verified_only: 0, first_party: 0 },
    { client_id: "mw_vo", status: "active", client_type: "public", display_name: "VO", logo_url: null, allowed_scopes: '["openid","profile"]', verified_only: 1, first_party: 0 },
  );
  store.tables.oauth_client_redirect_uris.push(
    { client_id: "mw_full", redirect_uri: "http://localhost:4321/cb2" },
    { client_id: "mw_vo", redirect_uri: "http://localhost:4321/cb3" },
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
