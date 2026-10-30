import { test, expect } from "vitest";
import { createClient } from "@libsql/client";
import { SCHEMA, SEED } from "../src/db";
import { handle } from "../src/index";
import { deleteAccount, regenerateRecoveryCodes } from "../src/accounts";
import { issueSession, lookupSession, rotateSession } from "../src/session";
import { createAuthCode } from "../src/token";
import { grantConsent } from "../src/consent";
import { linkTelegramToAccount } from "../src/telegram";
import { sha256Hex } from "../src/crypto";
import { createManagementToken, verifyManagementToken } from "../src/dashboard";
import { authenticateClient } from "../src/clients";
import { genSigningKeys, cookieValue, seedLiveSession, deleteAccountForTest } from "./helpers";
import type { DbClient } from "../src/types";

// Account-deletion races: a request that read a valid session/account just before deleteAccount
// committed must not be able to write credential rows afterwards. Real libSQL, so the guarded
// INSERT ... SELECT ... WHERE EXISTS statements run for real.

const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const REDIRECT = "http://localhost:4321/callback";
const NOW = 1000;
const BOT_TOKEN = "123456:bottoken";

async function freshDb(): Promise<DbClient> {
  const c = createClient({ url: ":memory:" }) as unknown as DbClient;
  for (const stmt of [...SCHEMA, ...SEED]) await c.execute(stmt);
  return c;
}
const run = (db: DbClient, sql: string, args: unknown[] = []) => db.execute({ sql, args });
/** Plant a row that references a missing account (what a lost race would leave; FKs are enforced in this in-memory DB, so switch them off just for the seed). */
const leftover = async (db: DbClient, sql: string, args: unknown[]) => {
  await db.execute("PRAGMA foreign_keys = OFF");
  try { await run(db, sql, args); } finally { await db.execute("PRAGMA foreign_keys = ON"); }
};
const count = async (db: DbClient, sql: string, args: unknown[] = []) =>
  Number((await db.execute({ sql: `SELECT count(*) AS n FROM ${sql}`, args })).rows[0]!.n);

async function setup() {
  const db = await freshDb();
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", WEB_ORIGIN: "https://web", CORS_ORIGINS: "https://web", STATE_SECRET: "s", ACCOUNT_DELETE_ENABLED: "1", TELEGRAM_BOT_TOKEN: BOT_TOKEN };
  // `hook` runs once, right AFTER the next statement matching `hookRe` returns (the "read, then deletion commits" interleaving).
  let hook: (() => Promise<void>) | null = null;
  let hookRe = /FROM sessions WHERE id_hash/;
  const wrapped: DbClient = {
    execute: async (stmt) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      const r = await db.execute(stmt);
      if (hook && hookRe.test(sql)) {
        const h = hook;
        hook = null;
        await h();
      }
      return r;
    },
    batch: (stmts, mode) => db.batch(stmts, mode),
  };
  const deps = { getDb: () => wrapped, clock: () => NOW };
  const call = (path: string, init: { method?: string; sess?: string; cookie?: string; body?: Record<string, string> } = {}) =>
    handle(
      new Request(`https://iss${path}`, {
        method: init.body ? "POST" : (init.method ?? "GET"),
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.9",
          Cookie: [init.sess ? `__Host-mw_sess=${init.sess}` : "", init.cookie ?? ""].filter(Boolean).join("; "),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
      }),
      env as never,
      deps as never,
    );
  const su = await call("/signup", { body: { username: "victim", password: "accttest1234" } });
  const { csrf } = (await su.json()) as { csrf: string };
  const sess = cookieValue(su.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  const accountId = String((await run(db, "SELECT id FROM accounts WHERE username = 'victim'")).rows[0]!.id);
  const idHash = await sha256Hex(sess);
  return {
    db, wrapped, call, sess, csrf, accountId, idHash,
    deleteNow: () => deleteAccountForTest(db, accountId),
    onNextSessionRead: (fn: () => Promise<void>) => { hook = fn; hookRe = /FROM sessions WHERE id_hash/; },
    onNext: (re: RegExp, fn: () => Promise<void>) => { hook = fn; hookRe = re; },
    onNextConsentRead: (fn: () => Promise<void>) => { hook = fn; hookRe = /FROM consents WHERE account_id/; },
  };
}

const authReq = { clientId: "mw_demo", redirectUri: REDIRECT, scope: ["openid"], nonce: "n", codeChallenge: CHALLENGE };
const tg = { telegramId: "4242", username: "u", displayName: "N", avatarUrl: null };

// ------------------------------------------------------------ function level: read -> delete -> guarded insert

test("lookupSession read, deleteAccount, then issueSession writes 0 rows and returns null", async () => {
  const f = await setup();
  expect(await lookupSession(f.db, f.sess, NOW)).not.toBeNull();
  await f.deleteNow();
  expect(await issueSession(f.db, { accountId: f.accountId, amr: "pwd", authTime: NOW, now: NOW })).toBeNull();
  expect(await count(f.db, "sessions WHERE account_id = ?", [f.accountId])).toBe(0);
});

test("rotateSession: account deleted between its session read and its insert -> null, no new session", async () => {
  const f = await setup();
  f.onNextSessionRead(f.deleteNow);
  expect(await rotateSession(f.wrapped, f.sess, { now: NOW, accountId: f.accountId })).toBeNull();
  expect(await count(f.db, "accounts WHERE id = ?", [f.accountId])).toBe(0);
  expect(await count(f.db, "sessions WHERE account_id = ?", [f.accountId])).toBe(0);
});

test("createAuthCode: deleted account / leftover session row / revoked / expired session -> null, no code row", async () => {
  const f = await setup();
  const mk = (sessionIdHash: string, accountId: string, now = NOW) => createAuthCode(f.db, { request: authReq, accountId, sessionIdHash, scope: ["openid"], authTime: NOW, now });
  // Normal path unchanged.
  expect(await mk(f.idHash, f.accountId)).toMatch(/^code_/);
  expect(await count(f.db, "oauth_codes")).toBe(1);
  // Revoked, then expired.
  await run(f.db, "UPDATE sessions SET revoked_at = datetime('now') WHERE id_hash = ?", [f.idHash]);
  expect(await mk(f.idHash, f.accountId)).toBeNull();
  await seedLiveSession(f.db, "sh_exp", f.accountId, NOW);
  expect(await mk("sh_exp", f.accountId, NOW + 10_000_000)).toBeNull();
  // Deleted account: the (read-earlier) session is gone with it...
  await f.deleteNow();
  expect(await mk(f.idHash, f.accountId)).toBeNull();
  // ...and a LEFTOVER live session row pointing at a missing account is not enough either.
  await leftover(f.db, "INSERT INTO sessions (id_hash, account_id, auth_time, amr, csrf_token, idle_expires_at, absolute_expires_at) VALUES ('sh_left', ?, 1, 'pwd', 'c', 9e9, 9e9)", [f.accountId]);
  expect(await mk("sh_left", f.accountId)).toBeNull();
  expect(await count(f.db, "oauth_codes WHERE account_id = ?", [f.accountId])).toBe(0);
});

test("grantConsent after deleteAccount writes 0 rows and returns null; normal upsert still updates", async () => {
  const f = await setup();
  const g = () => grantConsent(f.db, { accountId: f.accountId, clientId: "mw_demo", requested: ["openid"], clientAllowed: ["openid", "profile"], priorMax: null });
  expect(await g()).toEqual(["openid"]);
  expect(await g()).toEqual(["openid"]); // ON CONFLICT path
  expect(await count(f.db, "consents WHERE account_id = ?", [f.accountId])).toBe(1);
  await f.deleteNow();
  expect(await g()).toBeNull();
  expect(await count(f.db, "consents WHERE account_id = ?", [f.accountId])).toBe(0);
});

test("linkTelegramToAccount after deleteAccount -> account_gone, no telegram_links row (no login resolves to the deleted id)", async () => {
  const f = await setup();
  await f.deleteNow();
  expect(await linkTelegramToAccount(f.db, f.accountId, tg)).toEqual({ ok: false, error: "account_gone" });
  expect(await count(f.db, "telegram_links")).toBe(0);
});

test("linkTelegramToAccount on a live account still links and verifies", async () => {
  const f = await setup();
  expect(await linkTelegramToAccount(f.db, f.accountId, tg)).toEqual({ ok: true });
  expect(await count(f.db, "telegram_links WHERE account_id = ?", [f.accountId])).toBe(1);
  expect(Number((await run(f.db, "SELECT verified FROM accounts WHERE id = ?", [f.accountId])).rows[0]!.verified)).toBe(1);
});

test("regenerateRecoveryCodes after deleteAccount -> null, no recovery_codes rows; live account gets a full set", async () => {
  const f = await setup();
  const codes = await regenerateRecoveryCodes(f.db, f.accountId);
  expect(codes).toHaveLength(8);
  expect(await count(f.db, "recovery_codes WHERE account_id = ?", [f.accountId])).toBe(8);
  await f.deleteNow();
  expect(await regenerateRecoveryCodes(f.db, f.accountId)).toBeNull();
  expect(await count(f.db, "recovery_codes WHERE account_id = ?", [f.accountId])).toBe(0);
});

// ------------------------------------------------------------ handler level

test("/authorize with a leftover session for a deleted account redirects to login (no code)", async () => {
  const f = await setup();
  await f.deleteNow();
  await leftover(f.db, "INSERT INTO sessions (id_hash, account_id, auth_time, amr, csrf_token, idle_expires_at, absolute_expires_at) VALUES (?, ?, 1, 'pwd', 'c', 9e9, 9e9)", [f.idHash, f.accountId]);
  const q = new URLSearchParams({ client_id: "mw_demo", redirect_uri: REDIRECT, response_type: "code", scope: "openid", state: "st", code_challenge: CHALLENGE, code_challenge_method: "S256" });
  const r = await f.call(`/authorize?${q}`, { sess: f.sess });
  expect(r.status).toBe(302);
  expect(r.headers.get("Location")).toBe("https://web/login");
  expect(await count(f.db, "oauth_codes")).toBe(0);
});

test("/authorize: consent read says silent, account deleted before the code insert -> login redirect, no code", async () => {
  const f = await setup();
  // Pre-consent so the decision is 'silent' (mint without UI) for the first-party demo client.
  await grantConsent(f.db, { accountId: f.accountId, clientId: "mw_demo", requested: ["openid"], clientAllowed: ["openid", "profile"], priorMax: null });
  f.onNextConsentRead(f.deleteNow);
  const q = new URLSearchParams({ client_id: "mw_demo", redirect_uri: REDIRECT, response_type: "code", scope: "openid", state: "st", code_challenge: CHALLENGE, code_challenge_method: "S256" });
  const r = await f.call(`/authorize?${q}`, { sess: f.sess });
  expect(r.status).toBe(302);
  expect(r.headers.get("Location")).not.toContain("code=");
  expect(r.headers.get("Location")).toBe("https://web/login");
  expect(await count(f.db, "oauth_codes")).toBe(0);
});

test("/consent: session read valid, account deleted before the consent upsert -> 401 account_gone, nothing written", async () => {
  const f = await setup();
  const q = new URLSearchParams({ client_id: "mw_demo", redirect_uri: REDIRECT, response_type: "code", scope: "openid profile", state: "st", code_challenge: CHALLENGE, code_challenge_method: "S256", prompt: "consent" });
  const a = await f.call(`/authorize?${q}`, { sess: f.sess });
  const tkt = cookieValue(a.headers.get("Set-Cookie"), "__Host-mw_tkt")!;
  f.onNextSessionRead(f.deleteNow);
  const r = await f.call("/consent", { sess: f.sess, cookie: `__Host-mw_tkt=${tkt}`, body: { decision: "allow", csrf: f.csrf } });
  expect(r.status).toBe(401);
  expect(await r.json()).toEqual({ error: "account_gone" });
  expect(await count(f.db, "consents")).toBe(0);
  expect(await count(f.db, "oauth_codes")).toBe(0);
});

test("POST /api/account/recovery-codes: account deleted after the session read -> 401 account_gone, no rows", async () => {
  const f = await setup();
  f.onNextSessionRead(f.deleteNow);
  const r = await f.call("/api/account/recovery-codes", { sess: f.sess, body: { csrf: f.csrf } });
  expect(r.status).toBe(401);
  expect(await r.json()).toEqual({ error: "account_gone" });
  expect(await count(f.db, "recovery_codes WHERE account_id = ?", [f.accountId])).toBe(0);
});

test("POST /login: valid credentials but account deleted before the session insert -> 401 account_gone", async () => {
  const f = await setup();
  // The delete lands right after rotateSession's session read (credentials already verified); both the
  // rotate insert and the fallback issueSession must then write nothing.
  f.onNextSessionRead(f.deleteNow);
  const r = await f.call("/login", { sess: f.sess, body: { username: "victim", password: "accttest1234" } });
  expect(r.status).toBe(401);
  expect(await r.json()).toEqual({ error: "account_gone" });
  expect(r.headers.get("Set-Cookie")).toBeNull();
  expect(await count(f.db, "sessions WHERE account_id = ?", [f.accountId])).toBe(0);
});

test("token exchange of a leftover code for a deleted account -> invalid_grant, no access/refresh rows", async () => {
  const f = await setup();
  const code = "code_leftover";
  await f.deleteNow();
  await leftover(f.db, `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, scope, code_challenge, code_challenge_method, account_id, session_id_hash, auth_time, jti_family, expires_at)
    VALUES (?, 'mw_demo', ?, 'openid offline_access', ?, 'S256', ?, 'sh', 1, 'fam_left', 9e9)`, [await sha256Hex(code), REDIRECT, CHALLENGE, f.accountId]);
  const r = await f.call("/token", { body: { grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: "mw_demo", redirect_uri: REDIRECT } });
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: "invalid_grant" });
  expect(await count(f.db, "access_tokens WHERE account_id = ?", [f.accountId])).toBe(0);
  expect(await count(f.db, "refresh_tokens WHERE account_id = ?", [f.accountId])).toBe(0);
});

test("normal path: signup -> authorize(consent) -> code -> token still works for a live account", async () => {
  const f = await setup();
  await grantConsent(f.db, { accountId: f.accountId, clientId: "mw_demo", requested: ["openid"], clientAllowed: ["openid", "profile"], priorMax: null });
  const q = new URLSearchParams({ client_id: "mw_demo", redirect_uri: REDIRECT, response_type: "code", scope: "openid", state: "st", code_challenge: CHALLENGE, code_challenge_method: "S256" });
  const a = await f.call(`/authorize?${q}`, { sess: f.sess });
  expect(a.status).toBe(302);
  const code = new URL(a.headers.get("Location")!).searchParams.get("code")!;
  const t = await f.call("/token", { body: { grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: "mw_demo", redirect_uri: REDIRECT } });
  expect(t.status).toBe(200);
  expect(await count(f.db, "access_tokens WHERE account_id = ?", [f.accountId])).toBe(1);
});

// ------------------------------------------------------------ step C: clients, management tokens, telegram, refresh, M3

const countAudit = (db: DbClient, event: string) => count(db, "audit_log WHERE event = ?", [event]);
const clientBody = (csrf: string, name: string) => ({ csrf, name, client_type: "confidential", redirect_uris: "https://rp.example/cb", scopes: "openid" });

test("POST /api/dev/clients: owner deleted after the session read -> 401 account_gone, no client/uri/secret rows", async () => {
  const f = await setup();
  f.onNextSessionRead(f.deleteNow);
  const r = await f.call("/api/dev/clients", { sess: f.sess, body: clientBody(f.csrf, "ghost-app") });
  expect(r.status).toBe(401);
  expect(await r.json()).toEqual({ error: "account_gone" });
  expect(await count(f.db, "oauth_clients WHERE name = 'ghost-app'")).toBe(0);
  expect(await count(f.db, "oauth_client_redirect_uris WHERE redirect_uri = 'https://rp.example/cb'")).toBe(0);
  expect(await count(f.db, "oauth_client_secrets")).toBe(0);
});

test("POST /api/dev/clients on a live account still creates the client with its uri and secret", async () => {
  const f = await setup();
  const r = await f.call("/api/dev/clients", { sess: f.sess, body: clientBody(f.csrf, "live-app") });
  expect(r.status).toBe(200);
  expect(await count(f.db, "oauth_clients WHERE name = 'live-app' AND owner_account_id = ?", [f.accountId])).toBe(1);
  expect(await count(f.db, "oauth_client_redirect_uris WHERE redirect_uri = 'https://rp.example/cb'")).toBe(1);
  expect(await count(f.db, "oauth_client_secrets")).toBe(1);
});

test("POST /api/dev/tokens: owner deleted after the session read -> 401 account_gone, no management_tokens row", async () => {
  const f = await setup();
  f.onNextSessionRead(f.deleteNow);
  const r = await f.call("/api/dev/tokens", { sess: f.sess, body: { csrf: f.csrf, label: "ci" } });
  expect(r.status).toBe(401);
  expect(await r.json()).toEqual({ error: "account_gone" });
  expect(await count(f.db, "management_tokens")).toBe(0);
});

test("createManagementToken: live account gets a token that verifies; deleted account gets null", async () => {
  const f = await setup();
  const tok = await createManagementToken(f.db, f.accountId, "x");
  expect(tok).toMatch(/^mgmt_/);
  expect(await verifyManagementToken(f.db, tok!)).toBe(f.accountId);
  await f.deleteNow();
  expect(await createManagementToken(f.db, f.accountId)).toBeNull();
  expect(await count(f.db, "management_tokens")).toBe(0);
});

test("verifyManagementToken ignores a leftover token whose owner account is gone", async () => {
  const f = await setup();
  await f.deleteNow();
  await leftover(f.db, "INSERT INTO management_tokens (token_hash, owner_account_id) VALUES (?, ?)", [await sha256Hex("mgmt_left"), f.accountId]);
  expect(await verifyManagementToken(f.db, "mgmt_left")).toBeNull();
  const r = await f.call("/mgmt/v1/clients", { body: { name: "x-app", redirect_uris: "https://rp.example/cb" } });
  expect(r.status).toBe(401);
});

test("management API client upsert: owner deleted after the token check -> 401 account_gone, no rows", async () => {
  const f = await setup();
  const tok = (await createManagementToken(f.db, f.accountId))!;
  f.onNext(/FROM management_tokens/, f.deleteNow);
  const r = await handle(
    new Request("https://iss/mgmt/v1/clients", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name: "iac-app", client_type: "confidential", redirect_uris: "https://rp.example/cb" }),
    }),
    { AUTH_SIGNING_KEYS: JSON.stringify(await genSigningKeys()), ISSUER: "https://iss", WEB_ORIGIN: "https://web", CORS_ORIGINS: "https://web", STATE_SECRET: "s" } as never,
    { getDb: () => f.wrapped, clock: () => NOW } as never,
  );
  expect(r.status).toBe(401);
  expect(await r.json()).toEqual({ error: "account_gone" });
  expect(await count(f.db, "oauth_clients WHERE name = 'iac-app'")).toBe(0);
  expect(await count(f.db, "oauth_client_secrets")).toBe(0);
});

test("authenticateClient rejects a leftover client whose owner is gone; seeded acct_system clients still authenticate", async () => {
  const f = await setup();
  expect((await authenticateClient(f.db, "mw_demo", undefined)).ok).toBe(true);
  await f.deleteNow();
  await leftover(f.db, `INSERT INTO oauth_clients (client_id, name, owner_account_id, client_type, allowed_scopes, first_party, status) VALUES ('mw_orphan2', 'orphan2', ?, 'public', '["openid"]', 0, 'active')`, [f.accountId]);
  expect(await authenticateClient(f.db, "mw_orphan2", undefined)).toEqual({ ok: false, error: "invalid_client" });
});

test("/tg/status: confirmed ticket whose account was deleted -> 401 account_gone, no session", async () => {
  const f = await setup();
  await f.deleteNow();
  const owner = "ownercookie";
  await leftover(f.db, "INSERT INTO login_tickets (ticket_id, nonce_hash, owner_hash, kind, account_id, status, expires_at) VALUES ('tkt_gone', 'nh', ?, 'SIGNIN_OR_SIGNUP', ?, 'consumed', 9e9)", [await sha256Hex(owner), f.accountId]);
  const r = await f.call("/tg/status?ticket=tkt_gone", { cookie: `__Host-mw_tgown=${owner}` });
  expect(r.status).toBe(401);
  expect(await r.json()).toEqual({ error: "account_gone" });
  expect(r.headers.get("Set-Cookie")).toBeNull();
  expect(await count(f.db, "sessions WHERE account_id = ?", [f.accountId])).toBe(0);
});

test("/tg/widget: linked account deleted after the link lookup -> 401 account_gone, no session", async () => {
  const f = await setup();
  expect(await linkTelegramToAccount(f.db, f.accountId, { telegramId: "77", username: "tguser", displayName: "Tg", avatarUrl: null })).toEqual({ ok: true });
  f.onNext(/FROM telegram_links WHERE telegram_id/, f.deleteNow);
  const data: Record<string, string> = { id: "77", first_name: "Tg", username: "tguser", auth_date: "1000" };
  const dcs = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
  const k = await crypto.subtle.importKey("raw", new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(BOT_TOKEN))), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  data.hash = [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(dcs)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const r = await f.call("/tg/widget", { body: data });
  expect(r.status).toBe(401);
  expect(await r.json()).toEqual({ error: "account_gone" });
  expect(r.headers.get("Set-Cookie")).toBeNull();
  expect(await count(f.db, "sessions WHERE account_id = ?", [f.accountId])).toBe(0);
});

test("refresh_token grant with a leftover refresh token for a deleted account -> invalid_grant, nothing inserted, no reuse audit (M3)", async () => {
  const f = await setup();
  await f.deleteNow();
  const rt = "rt_leftover";
  await leftover(f.db, "INSERT INTO refresh_tokens (token_hash, family_id, client_id, account_id, scope, idle_expires_at, absolute_expires_at) VALUES (?, 'fam_l', 'mw_demo', ?, 'openid offline_access', 9e9, 9e9)", [await sha256Hex(rt), f.accountId]);
  const r = await f.call("/token", { body: { grant_type: "refresh_token", refresh_token: rt, client_id: "mw_demo" } });
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: "invalid_grant" });
  expect(await count(f.db, "access_tokens WHERE account_id = ?", [f.accountId])).toBe(0);
  expect(await count(f.db, "refresh_tokens WHERE account_id = ? AND prev_id IS NOT NULL", [f.accountId])).toBe(0);
  expect(await countAudit(f.db, "token.reuse_detected")).toBe(0);
});

test("auth-code exchange lost because the account is gone is not audited as token.code_replay (M3)", async () => {
  const f = await setup();
  const code = "code_leftover2";
  await f.deleteNow();
  await leftover(f.db, `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, scope, code_challenge, code_challenge_method, account_id, session_id_hash, auth_time, jti_family, expires_at)
    VALUES (?, 'mw_demo', ?, 'openid', ?, 'S256', ?, 'sh', 1, 'fam_left2', 9e9)`, [await sha256Hex(code), REDIRECT, CHALLENGE, f.accountId]);
  const r = await f.call("/token", { body: { grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: "mw_demo", redirect_uri: REDIRECT } });
  expect(r.status).toBe(400);
  expect(await countAudit(f.db, "token.code_replay")).toBe(0);
});

test("a genuine code replay (account alive) is still audited as token.code_replay", async () => {
  const f = await setup();
  await grantConsent(f.db, { accountId: f.accountId, clientId: "mw_demo", requested: ["openid"], clientAllowed: ["openid", "profile"], priorMax: null });
  const q = new URLSearchParams({ client_id: "mw_demo", redirect_uri: REDIRECT, response_type: "code", scope: "openid", state: "st", code_challenge: CHALLENGE, code_challenge_method: "S256" });
  const a = await f.call(`/authorize?${q}`, { sess: f.sess });
  const code = new URL(a.headers.get("Location")!).searchParams.get("code")!;
  const body = { grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: "mw_demo", redirect_uri: REDIRECT };
  expect((await f.call("/token", { body })).status).toBe(200);
  expect((await f.call("/token", { body })).status).toBe(400);
  expect(await countAudit(f.db, "token.code_replay")).toBe(1);
});

test("signup: resolveNext returning nothing (new account deleted before the silent code mint) is a clean 401 account_gone, not a 500", async () => {
  const f = await setup();
  // First-party client => the post-signup decision is 'silent', so resolveNext mints a code (guarded) and returns null when the account vanished.
  await run(f.db, "UPDATE oauth_clients SET first_party = 1 WHERE client_id = 'mw_demo'");
  const q = new URLSearchParams({ client_id: "mw_demo", redirect_uri: REDIRECT, response_type: "code", scope: "openid", state: "st", code_challenge: CHALLENGE, code_challenge_method: "S256" });
  const a = await f.call(`/authorize?${q}`);
  const tkt = cookieValue(a.headers.get("Set-Cookie"), "__Host-mw_tkt")!;
  expect(tkt).toBeTruthy();
  f.onNextConsentRead(async () => {
    const id = String((await run(f.db, "SELECT id FROM accounts WHERE username = 'newbie'")).rows[0]!.id);
    await deleteAccountForTest(f.db, id);
  });
  const r = await f.call("/signup", { cookie: `__Host-mw_tkt=${tkt}`, body: { username: "newbie", password: "accttest1234" } });
  expect(r.status).toBe(401);
  expect(await r.json()).toEqual({ error: "account_gone" });
  expect(await count(f.db, "oauth_codes")).toBe(0);
  expect(await count(f.db, "accounts WHERE username = 'newbie'")).toBe(0);
});

// ------------------------------------------------------------ login while another account's cookie is present

test("POST /login as a DIFFERENT account while holding A's session cookie: A's session is revoked, the new session belongs to B (never a fresh A session)", async () => {
  const f = await setup(); // signed up as "victim" (A), f.sess is A's session
  const b = await f.call("/signup", { body: { username: "other_b", password: "accttest1234" } });
  expect(b.status).toBe(200);
  const bId = String((await run(f.db, "SELECT id FROM accounts WHERE username = 'other_b'")).rows[0]!.id);
  const before = Number((await run(f.db, "SELECT auth_time FROM sessions WHERE id_hash = ?", [f.idHash])).rows[0]!.auth_time);

  const r = await f.call("/login", { sess: f.sess, body: { username: "other_b", password: "accttest1234" } });
  expect(r.status).toBe(200);
  const newSess = cookieValue(r.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  const newRow = (await run(f.db, "SELECT account_id FROM sessions WHERE id_hash = ?", [await sha256Hex(newSess)])).rows[0]!;
  expect(String(newRow.account_id)).toBe(bId);
  // A's old session is revoked and no session for A was created or freshened by B's login.
  expect((await run(f.db, "SELECT revoked_at FROM sessions WHERE id_hash = ?", [f.idHash])).rows[0]!.revoked_at).not.toBeNull();
  const aLive = await run(f.db, "SELECT COUNT(*) AS n FROM sessions WHERE account_id = ? AND revoked_at IS NULL", [f.accountId]);
  expect(Number(aLive.rows[0]!.n)).toBe(0);
  // A's (now revoked) row was not freshened by B's login.
  expect(Number((await run(f.db, "SELECT auth_time FROM sessions WHERE id_hash = ?", [f.idHash])).rows[0]!.auth_time)).toBe(before);
});

test("POST /login as the SAME account rotates its own session (old revoked, new one for the same account)", async () => {
  const f = await setup();
  const r = await f.call("/login", { sess: f.sess, body: { username: "victim", password: "accttest1234" } });
  expect(r.status).toBe(200);
  const newSess = cookieValue(r.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  expect(newSess).not.toBe(f.sess);
  const newRow = (await run(f.db, "SELECT account_id FROM sessions WHERE id_hash = ?", [await sha256Hex(newSess)])).rows[0]!;
  expect(String(newRow.account_id)).toBe(f.accountId);
  expect((await run(f.db, "SELECT revoked_at FROM sessions WHERE id_hash = ?", [f.idHash])).rows[0]!.revoked_at).not.toBeNull();
});
