import { test, expect, vi } from "vitest";
import { handle } from "../src/index";
import { recordAudit, truncIp, uaHash } from "../src/audit";
import { hashPassword, hmacSha256Hex } from "../src/crypto";
import { internalConfirmString } from "../src/telegram";
import { STATEMENTS } from "../src/db";
import type { DbClient } from "../src/types";
import { genSigningKeys, memStore, routedDb, cookieValue, type Route } from "./helpers";

const IP = "203.0.113.77";
const IP_TRUNC = "203.0.113.0/24";
const UA = "AuditTest/1.0 (secret-ish UA string)";
const BOT_TOKEN = "123456:bottoken";
const PW = "accttest1234";
const REDIRECT = "http://localhost:4321/cb4";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const enc = new TextEncoder();

// ---------------------------------------------------------------- truncIp / uaHash

test("truncIp: IPv4 -> /24", () => {
  expect(truncIp("203.0.113.77")).toBe("203.0.113.0/24");
  expect(truncIp("  10.1.2.3 ")).toBe("10.1.2.0/24");
});

test("truncIp: IPv6 full -> first three hextets, lowercase, no leading zeros", () => {
  expect(truncIp("2001:0DB8:0085:a3ff:0000:0000:0000:7334")).toBe("2001:db8:85::/48");
});

test("truncIp: IPv6 compressed -> canonical form keeps expanded zero hextets (2001:db8::1 -> 2001:db8:0::/48)", () => {
  expect(truncIp("2001:db8::1")).toBe("2001:db8:0::/48");
  expect(truncIp("2001:db8:1:2::")).toBe("2001:db8:1::/48");
  expect(truncIp("fe80::1%eth0")).toBe("fe80:0:0::/48");
});

test("truncIp: ::1 and ::", () => {
  expect(truncIp("::1")).toBe("0:0:0::/48");
  expect(truncIp("::")).toBe("0:0:0::/48");
});

test("truncIp: IPv4-mapped IPv6 is treated as IPv4", () => {
  expect(truncIp("::ffff:1.2.3.4")).toBe("1.2.3.0/24");
  expect(truncIp("::FFFF:102:304")).toBe("1.2.3.0/24");
  expect(truncIp("2001:db8::1.2.3.4")).toBe("2001:db8:0::/48"); // v4 tail, not mapped
});

test("truncIp: empty and garbage -> null", () => {
  for (const bad of [null, "", "   ", "garbage", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.x", "1:2:3", "1::2::3", "12345::1", "g::1", "1:2:3:4:5:6:7:8:9", "::ffff:1.2.3.999", "1:2:3:4:5:6:7::8"]) {
    expect(truncIp(bad)).toBeNull();
  }
});

test("uaHash: known SHA-256 vector (first 16 hex chars); empty -> null", async () => {
  expect(await uaHash("abc")).toBe("ba7816bf8f01cfea"); // sha256("abc") = ba7816bf8f01cfea414140de5dae2223...
  expect(await uaHash("")).toBeNull();
  expect(await uaHash(null)).toBeNull();
});

// ---------------------------------------------------------------- schema

test("schema carries the two audit indexes", () => {
  expect(STATEMENTS).toContain("CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts)");
  expect(STATEMENTS).toContain("CREATE INDEX IF NOT EXISTS idx_audit_account ON audit_log(account_id, ts)");
});

// ---------------------------------------------------------------- harness

async function harness(opts: { wrap?: (db: DbClient) => DbClient; ctx?: ExecutionContext } = {}) {
  const store = memStore();
  const seen: unknown[][] = []; // every arg list bound to an audit_log insert
  const base = store.db;
  const spy: DbClient = {
    execute: async (stmt) => {
      if (typeof stmt !== "string" && /INSERT INTO audit_log/.test(stmt.sql)) seen.push(stmt.args);
      return base.execute(stmt);
    },
    batch: (s) => base.batch(s),
  };
  const db = opts.wrap ? opts.wrap(spy) : spy;
  const keys = await genSigningKeys();
  const env = {
    AUTH_SIGNING_KEYS: JSON.stringify(keys),
    ISSUER: "https://iss",
    WEB_ORIGIN: "https://web",
    RESOURCE_AUD: "https://api.meow",
    STATE_SECRET: "s",
    CORS_ORIGINS: "https://web",
    BOT_USERNAME: "meow_bot",
    INTERNAL_HMAC_KEY: "ikey",
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  };
  store.tables.oauth_clients.push({ client_id: "mw_rt", status: "active", client_type: "public", display_name: "RT", logo_url: null, allowed_scopes: '["openid","profile","offline_access"]', allow_offline_access: 1, verified_only: 0, first_party: 0 });
  store.tables.oauth_client_redirect_uris.push({ client_id: "mw_rt", redirect_uri: REDIRECT });
  const deps = { getDb: () => db, clock: () => 1000 };
  function req(path: string, o: { method?: string; sess?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const cookie = [o.sess ? `__Host-mw_sess=${o.sess}` : "", o.cookie ?? ""].filter(Boolean).join("; ");
    return new Request(`https://iss${path}`, {
      method: o.method ?? (o.body !== undefined ? "POST" : "GET"),
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": IP, "User-Agent": UA, ...(cookie ? { Cookie: cookie } : {}), ...o.headers },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
  }
  const call = (path: string, o: Parameters<typeof req>[1] = {}) => handle(req(path, o), env as never, deps as never, opts.ctx);
  async function signup(username: string) {
    const r = await call("/signup", { body: { username, password: PW } });
    const b = (await r.json()) as { csrf: string; recoveryCodes: string[] };
    const accountId = store.tables.accounts.find((a) => a.username === username)!.id as string;
    return { sess: cookieValue(r.headers.get("Set-Cookie"), "__Host-mw_sess")!, csrf: b.csrf, recoveryCodes: b.recoveryCodes, accountId };
  }
  const rows = () => store.tables.audit_log;
  /** Run `fn`, assert it added exactly ONE audit row and return it (with the shape every row must have). */
  async function one<T>(fn: () => Promise<T>): Promise<Record<string, unknown>> {
    const before = rows().length;
    await fn();
    expect(rows().length).toBe(before + 1);
    const row = rows()[before]!;
    expect(row.ip_trunc).toBe(IP_TRUNC);
    expect(row.ua_hash).toMatch(/^[0-9a-f]{16}$/);
    return row;
  }
  return { store, env, deps, seen, req, call, signup, rows, one };
}

// ---------------------------------------------------------------- per-event rows

test("signup -> exactly one `signup` row with the new account id", async () => {
  const h = await harness();
  let accountId = "";
  const row = await h.one(async () => {
    accountId = (await h.signup("aud_signup")).accountId;
  });
  expect(row).toMatchObject({ event: "signup", account_id: accountId, client_id: null });
});

test("signup validation error / rate limit record nothing", async () => {
  const h = await harness();
  const r = await h.call("/signup", { body: { username: "x", password: "short" } });
  expect(r.status).toBe(400);
  expect(h.rows()).toHaveLength(0);
});

test("login.ok -> one row with account id", async () => {
  const h = await harness();
  const { accountId } = await h.signup("aud_login");
  const row = await h.one(async () => {
    expect((await h.call("/login", { body: { username: "aud_login", password: PW } })).status).toBe(200);
  });
  expect(row).toMatchObject({ event: "login.ok", account_id: accountId, client_id: null });
});

test("login.fail -> account id when the username exists, null otherwise; the attempted username is never stored", async () => {
  const h = await harness();
  const { accountId } = await h.signup("aud_known");
  const known = await h.one(async () => {
    expect((await h.call("/login", { body: { username: "aud_known", password: "wrongwrongwrong" } })).status).toBe(401);
  });
  expect(known).toMatchObject({ event: "login.fail", account_id: accountId });
  const unknown = await h.one(async () => {
    expect((await h.call("/login", { body: { username: "aud_ghost_user", password: "wrongwrongwrong" } })).status).toBe(401);
  });
  expect(unknown).toMatchObject({ event: "login.fail", account_id: null });
  const blob = JSON.stringify(h.seen);
  expect(blob).not.toContain("aud_ghost_user");
  expect(blob).not.toContain("aud_known");
  expect(blob).not.toContain("wrongwrongwrong");
});

test("login.fail on a username-less credential (telegram-only account) records the account id", async () => {
  const h = await harness();
  const { accountId } = await h.signup("aud_nopw");
  h.store.tables.password_credentials.length = 0; // account exists, no password credential
  const row = await h.one(async () => {
    expect((await h.call("/login", { body: { username: "aud_nopw", password: PW } })).status).toBe(401);
  });
  expect(row).toMatchObject({ event: "login.fail", account_id: accountId });
});

test("logout -> one row with the session's account; no cookie or already-revoked session records nothing", async () => {
  const h = await harness();
  const { sess, accountId } = await h.signup("aud_logout");
  const none = h.rows().length;
  await h.call("/logout");
  expect(h.rows()).toHaveLength(none);
  const row = await h.one(async () => {
    const r = await h.call("/logout", { sess });
    expect(r.status).toBe(302);
  });
  expect(row).toMatchObject({ event: "logout", account_id: accountId });
  await h.call("/logout", { sess }); // second time: session already revoked
  expect(h.rows()).toHaveLength(none + 1);
});

test("password.change only on success; recovery.regenerate; consent.revoke; telegram.unlink; account.delete", async () => {
  const h = await harness();
  const { sess, csrf, accountId } = await h.signup("aud_acct");
  const n = h.rows().length;
  // failures record nothing
  await h.call("/api/account/password", { sess, body: { csrf, current_password: "nope", new_password: "newpass123456" } });
  await h.call("/api/account/password", { sess, body: { csrf: "WRONG", current_password: PW, new_password: "newpass123456" } });
  expect(h.rows()).toHaveLength(n);

  expect(await h.one(() => h.call("/api/account/password", { sess, body: { csrf, current_password: PW, new_password: "newpass123456" } }))).toMatchObject({ event: "password.change", account_id: accountId, client_id: null });
  expect(await h.one(() => h.call("/api/account/recovery-codes", { sess, body: { csrf } }))).toMatchObject({ event: "recovery.regenerate", account_id: accountId });

  h.store.tables.consents.push({ account_id: accountId, client_id: "mw_demo", scope_set_max: '["openid"]', approved_scope_snapshot: '["openid"]' });
  expect(await h.one(() => h.call("/api/account/grants/revoke", { sess, body: { csrf, client_id: "mw_demo" } }))).toMatchObject({ event: "consent.revoke", account_id: accountId, client_id: "mw_demo" });

  expect(await h.one(() => h.call("/api/account/telegram/unlink", { sess, body: { csrf } }))).toMatchObject({ event: "telegram.unlink", account_id: accountId });

  expect(await h.one(() => h.call("/api/account/delete", { sess, body: { csrf, confirm: "aud_acct" } }))).toMatchObject({ event: "account.delete", account_id: accountId });
});

async function consentFlow(h: Awaited<ReturnType<typeof harness>>, username: string) {
  const q = new URLSearchParams({ client_id: "mw_rt", redirect_uri: REDIRECT, response_type: "code", scope: "openid offline_access", state: "st", code_challenge: CHALLENGE, code_challenge_method: "S256" });
  const a = await h.call(`/authorize?${q}`);
  const tkt = cookieValue(a.headers.get("Set-Cookie"), "__Host-mw_tkt")!;
  const su = await h.call("/signup", { cookie: `__Host-mw_tkt=${tkt}`, body: { username, password: PW } });
  const csrf = ((await su.json()) as { csrf: string }).csrf;
  const sess = cookieValue(su.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  const accountId = h.store.tables.accounts.find((x) => x.username === username)!.id as string;
  return { tkt, csrf, sess, accountId };
}

test("consent.grant (allow only) -> one row with account + client; deny records nothing", async () => {
  const h = await harness();
  const { tkt, csrf, sess, accountId } = await consentFlow(h, "aud_consent");
  const n = h.rows().length;
  await h.call("/consent", { sess, cookie: `__Host-mw_tkt=${tkt}`, body: { decision: "deny", csrf } });
  expect(h.rows()).toHaveLength(n);
  const row = await h.one(() => h.call("/consent", { sess, cookie: `__Host-mw_tkt=${tkt}`, body: { decision: "allow", csrf } }));
  expect(row).toMatchObject({ event: "consent.grant", account_id: accountId, client_id: "mw_rt" });
});

test("token.reuse_detected on refresh-token reuse (family revoked); ordinary rotation records nothing", async () => {
  const h = await harness();
  const { tkt, csrf, sess } = await consentFlow(h, "aud_reuse");
  const r3 = await h.call("/consent", { sess, cookie: `__Host-mw_tkt=${tkt}`, body: { decision: "allow", csrf } });
  const code = new URL(((await r3.json()) as { redirect: string }).redirect).searchParams.get("code")!;
  const r4 = await h.call("/token", { body: { grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: "mw_rt", redirect_uri: REDIRECT } });
  const first = ((await r4.json()) as { refresh_token: string }).refresh_token;
  const n = h.rows().length;
  const r5 = await h.call("/token", { body: { grant_type: "refresh_token", refresh_token: first, client_id: "mw_rt" } });
  expect(r5.status).toBe(200);
  expect(h.rows()).toHaveLength(n);
  const row = await h.one(async () => {
    const r6 = await h.call("/token", { body: { grant_type: "refresh_token", refresh_token: first, client_id: "mw_rt" } });
    expect(r6.status).toBe(400);
    expect(await r6.json()).toEqual({ error: "invalid_grant" });
  });
  expect(row).toMatchObject({ event: "token.reuse_detected", client_id: "mw_rt", account_id: null });
  // an unknown refresh token is NOT reuse
  const n2 = h.rows().length;
  await h.call("/token", { body: { grant_type: "refresh_token", refresh_token: "rt_unknown", client_id: "mw_rt" } });
  expect(h.rows()).toHaveLength(n2);
});

test("token.revoke -> one row with the authenticated client; unauthenticated records nothing", async () => {
  const h = await harness();
  h.store.tables.oauth_clients.push({ client_id: "mw_conf", status: "active", client_type: "confidential", display_name: "C", logo_url: null, allowed_scopes: '["openid"]', allow_offline_access: 0, verified_only: 0, first_party: 0 });
  h.store.tables.oauth_client_secrets.push({ client_id: "mw_conf", secret_phc: await hashPassword("mws_sec", { rounds: 1, iter: 500 }) });
  expect((await h.call("/token/revoke", { body: { token: "at_x" } })).status).toBe(401);
  expect(h.rows()).toHaveLength(0);
  const row = await h.one(async () => {
    expect((await h.call("/token/revoke", { body: { client_id: "mw_conf", client_secret: "mws_sec", token: "at_x" } })).status).toBe(200);
  });
  expect(row).toMatchObject({ event: "token.revoke", client_id: "mw_conf", account_id: null });
  expect(JSON.stringify(h.seen)).not.toContain("at_x");
  expect(JSON.stringify(h.seen)).not.toContain("mws_sec");
});

// ---- telegram

async function tgConfirm(h: Awaited<ReturnType<typeof harness>>, nonce: string, tgId: string) {
  const body = { nonce, telegram_id: tgId, username: "u", display_name: "U", avatar_url: "", ts: "1000" };
  const sig = await hmacSha256Hex("ikey", internalConfirmString({ nonce, telegramId: tgId, username: "u", displayName: "U", avatarUrl: "", ts: "1000" }));
  return h.call("/internal/tg/confirm", { body, headers: { "X-Signature": sig } });
}
async function tgStart(h: Awaited<ReturnType<typeof harness>>, body: unknown, sess?: string) {
  const r = await h.call("/tg/start", { sess, body });
  return new URL(((await r.json()) as { deepLink: string }).deepLink).searchParams.get("start")!;
}

test("telegram.link (deep-link VERIFY_EXISTING confirm) and telegram.login (deep-link sign-in confirm)", async () => {
  const h = await harness();
  const { sess, accountId } = await h.signup("aud_tg");
  const nonce = await tgStart(h, { kind: "VERIFY_EXISTING" }, sess);
  const link = await h.one(async () => {
    expect((await tgConfirm(h, nonce, "55")).status).toBe(200);
  });
  expect(link).toMatchObject({ event: "telegram.link", account_id: accountId, client_id: null });

  const n2 = await tgStart(h, {});
  const login = await h.one(async () => {
    expect((await tgConfirm(h, n2, "777")).status).toBe(200);
  });
  expect(login.event).toBe("telegram.login");
  expect(login.account_id).toBe(h.store.tables.telegram_links.find((t) => String(t.telegram_id) === "777")!.account_id);
});

test("telegram.link failure (linked elsewhere, 409) records nothing", async () => {
  const h = await harness();
  const a = await h.signup("aud_tga");
  const b = await h.signup("aud_tgb");
  expect((await tgConfirm(h, await tgStart(h, { kind: "VERIFY_EXISTING" }, a.sess), "88")).status).toBe(200);
  const n = h.rows().length;
  expect((await tgConfirm(h, await tgStart(h, { kind: "VERIFY_EXISTING" }, b.sess), "88")).status).toBe(409);
  expect(h.rows()).toHaveLength(n);
});

test("telegram.login via the Login Widget", async () => {
  const h = await harness();
  const data: Record<string, string> = { id: "4242", first_name: "Neko", username: "nekow", auth_date: "1000" };
  const dcs = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
  const secret = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(BOT_TOKEN)));
  const k = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const hash = [...new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(dcs)))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const bad = await h.call("/tg/widget", { body: { ...data, hash: "00" } });
  expect(bad.status).toBe(401);
  expect(h.rows()).toHaveLength(0);
  const row = await h.one(async () => {
    expect((await h.call("/tg/widget", { body: { ...data, hash } })).status).toBe(200);
  });
  expect(row.event).toBe("telegram.login");
  expect(row.account_id).toBe(h.store.tables.telegram_links.find((t) => String(t.telegram_id) === "4242")!.account_id);
});

// ---- dashboard + mgmt (routed fake: only the audit insert matters)

function devHarness(extra: Route[] = []) {
  const log: { sql: string; args: unknown[] }[] = [];
  const session: Route = [
    /SELECT account_id, auth_time, csrf_token/,
    () => ({ rows: [{ account_id: "owner1", auth_time: 1000, csrf_token: "csrf1", amr: "pwd", idle_expires_at: 9e9, absolute_expires_at: 9e9, revoked_at: null }] }),
  ];
  const db = routedDb([session, [/SELECT 1 FROM oauth_clients WHERE name/, () => ({ rows: [] })], ...extra], log);
  const deps = { getDb: () => db, clock: () => 1000 };
  const audits = () => log.filter((l) => /INSERT INTO audit_log/.test(l.sql)).map((l) => l.args);
  return { deps, audits };
}
async function devPost(deps: unknown, path: string, body: unknown, method = "POST", headers: Record<string, string> = { Cookie: "__Host-mw_sess=x" }) {
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", CORS_ORIGINS: "https://web" };
  return handle(new Request(`https://iss${path}`, { method, headers: { "Content-Type": "application/json", "CF-Connecting-IP": IP, "User-Agent": UA, ...headers }, body: JSON.stringify(body) }), env as never, deps as never);
}

test("client.create / client.update / client.delete / client.secret_rotate / mgmt_token.create (account + client ids)", async () => {
  const d = devHarness([
    [/UPDATE oauth_clients SET status = 'disabled'/, () => ({ rows: [], rowsAffected: 1 })],
    [/SELECT client_type FROM oauth_clients/, () => ({ rows: [{ client_type: "confidential" }] })],
    [/SELECT 1 FROM oauth_clients WHERE client_id .* AND owner_account_id/, () => ({ rows: [{ "1": 1 }] })],
  ]);
  const created = await devPost(d.deps, "/api/dev/clients", { csrf: "csrf1", name: "my-app", client_type: "public", redirect_uris: "https://app.example/cb", scopes: "openid" });
  const clientId = ((await created.json()) as { clientId: string }).clientId;
  expect(d.audits()).toEqual([["client.create", "owner1", clientId, IP_TRUNC, expect.stringMatching(/^[0-9a-f]{16}$/)]]);

  await devPost(d.deps, "/api/dev/clients/update", { csrf: "csrf1", client_id: "mw_1", display_name: "N" });
  await devPost(d.deps, "/api/dev/clients/delete", { csrf: "csrf1", client_id: "mw_1" });
  await devPost(d.deps, "/api/dev/clients/rotate-secret", { csrf: "csrf1", client_id: "mw_1" });
  const tok = await devPost(d.deps, "/api/dev/tokens", { csrf: "csrf1", label: "ci-label-xyz" });
  const mgmt = ((await tok.json()) as { token: string }).token;
  const all = d.audits();
  expect(all.map((a) => a.slice(0, 3))).toEqual([
    ["client.create", "owner1", clientId],
    ["client.update", "owner1", "mw_1"],
    ["client.delete", "owner1", "mw_1"],
    ["client.secret_rotate", "owner1", "mw_1"],
    ["mgmt_token.create", "owner1", null],
  ]);
  expect(JSON.stringify(all)).not.toContain(mgmt);
  expect(JSON.stringify(all)).not.toContain("ci-label-xyz");
});

test("dev failures (bad csrf, invalid name, not-owned delete, public rotate, update error) record nothing", async () => {
  const d = devHarness([
    [/UPDATE oauth_clients SET status = 'disabled'/, () => ({ rows: [], rowsAffected: 0 })],
    [/SELECT client_type FROM oauth_clients/, () => ({ rows: [{ client_type: "public" }] })],
  ]);
  await devPost(d.deps, "/api/dev/clients", { csrf: "WRONG", name: "my-app", client_type: "public", redirect_uris: "https://a/cb" });
  await devPost(d.deps, "/api/dev/clients", { csrf: "csrf1", name: "BAD", client_type: "public", redirect_uris: "https://a/cb" });
  await devPost(d.deps, "/api/dev/clients/delete", { csrf: "csrf1", client_id: "mw_1" });
  await devPost(d.deps, "/api/dev/clients/rotate-secret", { csrf: "csrf1", client_id: "mw_1" });
  await devPost(d.deps, "/api/dev/clients/update", { csrf: "csrf1", client_id: "" });
  expect(d.audits()).toEqual([]);
});

test("mgmt PAT upsert: create and update are recorded, unchanged and unauthorized are not", async () => {
  const body = { name: "iac-app", client_type: "public", redirect_uris: "https://app/cb", scopes: "openid" };
  const pat: Route = [/FROM management_tokens WHERE token_hash/, () => ({ rows: [{ owner_account_id: "owner1", revoked_at: null }] })];
  const bearer = { Authorization: "Bearer mgmt_tok" };
  const existing = { client_id: "mw_1", owner_account_id: "owner1", allowed_scopes: '["openid"]', verified_only: 0, allow_offline_access: 0, display_name: "iac-app" };

  const c = devHarness([pat, [/SELECT client_id, owner_account_id, allowed_scopes/, () => ({ rows: [] })]]);
  const cr = await devPost(c.deps, "/mgmt/v1/clients", body, "PUT", bearer);
  const cid = ((await cr.json()) as { clientId: string }).clientId;
  expect(c.audits().map((a) => a.slice(0, 3))).toEqual([["client.create", "owner1", cid]]);

  const u = devHarness([pat, [/SELECT client_id, owner_account_id, allowed_scopes/, () => ({ rows: [{ ...existing, allowed_scopes: '["openid","profile"]' }] })], [/redirect_uri FROM oauth_client_redirect_uris/, () => ({ rows: [{ redirect_uri: "https://app/cb" }] })]]);
  await devPost(u.deps, "/mgmt/v1/clients", body, "PUT", bearer);
  expect(u.audits().map((a) => a.slice(0, 3))).toEqual([["client.update", "owner1", "mw_1"]]);

  const same = devHarness([pat, [/SELECT client_id, owner_account_id, allowed_scopes/, () => ({ rows: [existing] })], [/redirect_uri FROM oauth_client_redirect_uris/, () => ({ rows: [{ redirect_uri: "https://app/cb" }] })]]);
  await devPost(same.deps, "/mgmt/v1/clients", body, "PUT", bearer);
  const bad = devHarness([[/FROM management_tokens WHERE token_hash/, () => ({ rows: [] })]]);
  await devPost(bad.deps, "/mgmt/v1/clients", body, "PUT", bearer);
  const badName = devHarness([pat]);
  await devPost(badName.deps, "/mgmt/v1/clients", { ...body, name: "BAD" }, "PUT", bearer);
  expect([...same.audits(), ...bad.audits(), ...badName.audits()]).toEqual([]);
});

// ---------------------------------------------------------------- no secrets

test("no secrets: no password, recovery code, session/csrf id, token or username reaches any audit_log parameter", async () => {
  const h = await harness();
  const su = await h.signup("aud_secret_user");
  const login = await h.call("/login", { body: { username: "aud_secret_user", password: PW } });
  const lb = (await login.json()) as { csrf: string };
  const sess2 = cookieValue(login.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  const pw = await h.call("/api/account/password", { sess: sess2, body: { csrf: lb.csrf, current_password: PW, new_password: "newpass123456" } });
  expect(pw.status).toBe(200);
  const rc = await h.call("/api/account/recovery-codes", { sess: sess2, body: { csrf: lb.csrf } });
  const regenerated = ((await rc.json()) as { recoveryCodes: string[] }).recoveryCodes;
  expect(h.seen.length).toBe(4); // signup, login.ok, password.change, recovery.regenerate

  const blob = JSON.stringify(h.seen);
  const secrets = [PW, "newpass123456", "aud_secret_user", su.sess, su.csrf, sess2, lb.csrf, ...su.recoveryCodes, ...regenerated, UA, IP];
  for (const s of secrets) expect(blob).not.toContain(s);
  for (const code of [...su.recoveryCodes, ...regenerated]) expect(blob.toLowerCase()).not.toContain(code.toLowerCase().replace(/-/g, ""));
});

// ---------------------------------------------------------------- never throws

test("audit write failure never changes the login response and logs only the event name", async () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const ok = await harness();
    await ok.signup("aud_fail");
    const okRes = await ok.call("/login", { body: { username: "aud_fail", password: PW } });
    const okBody = (await okRes.json()) as Record<string, unknown>;

    const h = await harness({
      wrap: (db) => ({
        ...db,
        execute: async (s) => {
          if (typeof s !== "string" && /INSERT INTO audit_log/.test(s.sql)) throw new Error("boom: db down secret-detail");
          return db.execute(s);
        },
      }),
    });
    await h.signup("aud_fail");
    const res = await h.call("/login", { body: { username: "aud_fail", password: PW } });
    expect(res.status).toBe(okRes.status);
    expect(Object.keys((await res.json()) as object).sort()).toEqual(Object.keys(okBody).sort());
    expect(res.headers.get("Set-Cookie")).toContain("__Host-mw_sess=");
    expect(h.rows()).toHaveLength(0);
    expect(spy).toHaveBeenCalledWith("audit_write_failed", "login.ok");
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain("secret-detail");
  } finally {
    spy.mockRestore();
  }
});

test("recordAudit swallows a throwing getDb and a throwing waitUntil", async () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const req = new Request("https://iss/x");
    await expect(recordAudit({ getDb: () => { throw new Error("no db"); } } as never, req, { event: "logout" })).resolves.toBeUndefined();
    const ctx = { waitUntil: () => { throw new Error("no ctx"); } } as unknown as ExecutionContext;
    await expect(recordAudit({ getDb: () => memStore().db, ctx } as never, req, { event: "logout" })).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith("audit_write_failed", "logout");
  } finally {
    spy.mockRestore();
  }
});

// ---------------------------------------------------------------- waitUntil

test("with an ExecutionContext the write is handed to waitUntil (not awaited inline)", async () => {
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waited.push(p) } as unknown as ExecutionContext;
  const h = await harness({ ctx });
  const s = await h.signup("aud_wait"); // signup's own audit also goes through waitUntil
  await Promise.all(waited);
  const before = h.rows().length;
  const waitedBefore = waited.length;
  const r = await h.call("/login", { body: { username: "aud_wait", password: PW } });
  expect(r.status).toBe(200);
  expect(waited.length).toBe(waitedBefore + 1);
  await Promise.all(waited);
  expect(h.rows()).toHaveLength(before + 1);
  expect(h.rows()[before]).toMatchObject({ event: "login.ok", account_id: s.accountId });
});

test("recordAudit with deps.ctx schedules via waitUntil and returns before the insert settles", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const inserted: unknown[][] = [];
  const db: DbClient = {
    execute: async (s) => {
      await gate;
      if (typeof s !== "string") inserted.push(s.args);
      return { rows: [] };
    },
    batch: async () => [],
  };
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waited.push(p) } as unknown as ExecutionContext;
  await recordAudit({ getDb: () => db, ctx }, new Request("https://iss/x", { headers: { "CF-Connecting-IP": IP } }), { event: "logout", accountId: "a1" });
  expect(waited).toHaveLength(1);
  expect(inserted).toHaveLength(0);
  release();
  await Promise.all(waited);
  expect(inserted).toEqual([["logout", "a1", null, IP_TRUNC, null]]);
});

// ---------------------------------------------------------------- prune

function pruneDb(id: number) {
  const log: { sql: string; args: unknown[] }[] = [];
  const db = routedDb([[/INSERT INTO audit_log/, () => ({ rows: [], rowsAffected: 1, lastInsertRowid: id })]], log);
  return { db, deletes: () => log.filter((l) => /^DELETE FROM audit_log WHERE ts < datetime\('now','-365 days'\)$/.test(l.sql)) };
}

test("prune: DELETE of rows older than 365 days runs when the inserted id is a multiple of 500, not otherwise", async () => {
  const req = new Request("https://iss/x");
  for (const [id, expected] of [[500, 1], [1000, 1], [499, 0], [501, 0], [1, 0]] as const) {
    const p = pruneDb(id);
    await recordAudit({ getDb: () => p.db }, req, { event: "login.ok", accountId: "a" });
    expect(p.deletes()).toHaveLength(expected);
  }
});

test("prune failure is swallowed (insert already done)", async () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const db: DbClient = {
      execute: async (s) => {
        if (typeof s === "string") throw new Error("prune failed");
        return { rows: [], lastInsertRowid: 500 };
      },
      batch: async () => [],
    };
    await expect(recordAudit({ getDb: () => db }, new Request("https://iss/x"), { event: "signup" })).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith("audit_write_failed", "signup");
  } finally {
    spy.mockRestore();
  }
});
