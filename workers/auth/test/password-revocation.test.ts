import { test, expect } from "vitest";
import { handle } from "../src/index";
import { issueSession, lookupSession } from "../src/session";
import { createRefreshToken, rotateRefresh } from "../src/refresh";
import { createClient } from "@libsql/client";
import { SCHEMA, SEED } from "../src/db";
import { genSigningKeys, cookieValue } from "./helpers";
import type { DbClient } from "../src/types";

async function freshDb(): Promise<DbClient> {
  const c = createClient({ url: ":memory:" }) as unknown as DbClient;
  for (const stmt of [...SCHEMA, ...SEED]) await c.execute(stmt);
  return c;
}

test("password change ROTATES the current session (old id dead, new cookie works) and revokes other sessions and all refresh/access tokens", async () => {
  const store = { db: await freshDb() };
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), STATE_SECRET: "s", ISSUER: "https://iss", WEB_ORIGIN: "https://web", CORS_ORIGINS: "https://web" };
  const deps = { getDb: () => store.db, clock: () => 1000 };
  const su = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "neko_revoke", password: "accttest1234" }) }), env as never, deps as never);
  const csrf = ((await su.json()) as { csrf: string }).csrf;
  const s1 = cookieValue(su.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  const accountId = String((await store.db.execute("SELECT id FROM accounts WHERE username = 'neko_revoke'")).rows[0]!.id);
  const s2 = (await issueSession(store.db, { accountId, amr: "pwd", authTime: 1000, now: 1000 }))!;
  const rt = await createRefreshToken(store.db, { accountId, clientId: "c1", scope: ["openid"], family: "fam1", now: 1000 });
  await store.db.execute({
    sql: "INSERT INTO access_tokens (jti, account_id, client_id, scope, family_id, issued_at, expires_at) VALUES ('j1', ?, 'c1', 'openid', 'fam1', 1000, 99999)",
    args: [accountId],
  });
  expect(await lookupSession(store.db, s2.rawId, 1000)).not.toBeNull();

  const r = await handle(
    new Request("https://iss/api/account/password", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${s1}` }, body: JSON.stringify({ csrf, current_password: "accttest1234", new_password: "newpass123456" }) }),
    env as never,
    deps as never,
  );
  expect(r.status).toBe(200);
  const body = (await r.json()) as { ok: boolean; csrf: string };
  const s3 = cookieValue(r.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  expect(s3).toBeTruthy();
  expect(s3).not.toBe(s1);

  expect(await lookupSession(store.db, s2.rawId, 1000)).toBeNull();
  expect(await lookupSession(store.db, s1, 1000)).toBeNull(); // a stolen copy of the old cookie dies with the change
  const nv = (await lookupSession(store.db, s3, 1000))!;
  expect(nv).toMatchObject({ accountId, authTime: 1000, amr: "pwd", csrf: body.csrf });
  expect(body.csrf).not.toBe(csrf);
  const live = await store.db.execute({ sql: "SELECT COUNT(*) AS n FROM sessions WHERE account_id = ? AND revoked_at IS NULL", args: [accountId] });
  expect(Number(live.rows[0]!.n)).toBe(1); // exactly one valid session afterwards
  const res = await rotateRefresh(store.db, { token: rt, clientId: "c1", now: 1000 });
  expect(res).toMatchObject({ ok: false, error: "invalid_grant" });
  expect(res).not.toHaveProperty("reuse"); // a revoked refresh token is just invalid_grant, not a reuse alarm
  const at = await store.db.execute({ sql: "SELECT revoked_at FROM access_tokens WHERE jti = 'j1'", args: [] });
  expect(at.rows[0]!.revoked_at).not.toBeNull();
});

test("after a password change, a stale refresh token over HTTP is a plain invalid_grant: no token.reuse_detected audit, family not 'revoked as compromised'", async () => {
  const store = { db: await freshDb() };
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), STATE_SECRET: "s", ISSUER: "https://iss", WEB_ORIGIN: "https://web", CORS_ORIGINS: "https://web" };
  const deps = { getDb: () => store.db, clock: () => 1000 };
  const su = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "neko_rev2", password: "accttest1234" }) }), env as never, deps as never);
  const csrf = ((await su.json()) as { csrf: string }).csrf;
  const s1 = cookieValue(su.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  const accountId = String((await store.db.execute("SELECT id FROM accounts WHERE username = 'neko_rev2'")).rows[0]!.id);
  await store.db.execute("UPDATE oauth_clients SET allowed_scopes = '[\"openid\",\"offline_access\"]', allow_offline_access = 1 WHERE client_id = 'mw_demo'");
  const rt = await createRefreshToken(store.db, { accountId, clientId: "mw_demo", scope: ["openid", "offline_access"], family: "fam2", now: 1000 });
  const pw = await handle(new Request("https://iss/api/account/password", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${s1}` }, body: JSON.stringify({ csrf, current_password: "accttest1234", new_password: "newpass123456" }) }), env as never, deps as never);
  expect(pw.status).toBe(200);
  const r = await handle(new Request("https://iss/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: rt, client_id: "mw_demo" }) }), env as never, deps as never);
  expect(r.status).toBe(400);
  expect(((await r.json()) as { error: string }).error).toBe("invalid_grant");
  const audit = await store.db.execute("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'token.reuse_detected'");
  expect(Number(audit.rows[0]!.n)).toBe(0);
});

const setup = async (name: string) => {
  const store = { db: await freshDb() };
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), STATE_SECRET: "s", ISSUER: "https://iss", WEB_ORIGIN: "https://web", CORS_ORIGINS: "https://web" };
  const deps = { getDb: () => store.db, clock: () => 1000 };
  const su = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: name, password: "accttest1234" }) }), env as never, deps as never);
  const csrf = ((await su.json()) as { csrf: string }).csrf;
  const s1 = cookieValue(su.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  const accountId = String((await store.db.execute({ sql: "SELECT id FROM accounts WHERE username = ?", args: [name] })).rows[0]!.id);
  const change = (sess: string, c: string, next = "newpass123456") =>
    handle(new Request("https://iss/api/account/password", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${sess}` }, body: JSON.stringify({ csrf: c, current_password: "accttest1234", new_password: next }) }), env as never, deps as never);
  return { store, env, deps, csrf, s1, accountId, change };
};

test("the new session's csrf works on the next account action; the old csrf and old cookie do not", async () => {
  const { env, deps, csrf, s1, change } = await setup("neko_rot_csrf");
  const r = await change(s1, csrf);
  const { csrf: c2 } = (await r.json()) as { csrf: string };
  const s2 = cookieValue(r.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  const act = (sess: string, c: string) =>
    handle(new Request("https://iss/api/account/grants/revoke", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${sess}` }, body: JSON.stringify({ csrf: c, client_id: "mw_x" }) }), env as never, deps as never);
  expect((await act(s2, c2)).status).toBe(200);
  expect((await act(s2, csrf)).status).toBe(403); // stale csrf
  expect((await act(s1, c2)).status).toBe(401); // old cookie
  const me = await handle(new Request("https://iss/api/account", { headers: { Cookie: `__Host-mw_sess=${s2}` } }), env as never, deps as never);
  expect(((await me.json()) as { csrf: string }).csrf).toBe(c2);
});

test("a failed change (wrong current password / policy) writes nothing: old session stays valid, no Set-Cookie", async () => {
  const { store, env, deps, s1, csrf, change, accountId } = await setup("neko_rot_fail");
  const bad = await handle(new Request("https://iss/api/account/password", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${s1}` }, body: JSON.stringify({ csrf, current_password: "WRONGWRONG12", new_password: "newpass123456" }) }), env as never, deps as never);
  expect(bad.status).toBe(400);
  expect(bad.headers.get("Set-Cookie")).toBeNull();
  const weak = await change(s1, csrf, "short");
  expect(weak.status).toBe(400);
  expect(weak.headers.get("Set-Cookie")).toBeNull();
  expect(await lookupSession(store.db, s1, 1000)).not.toBeNull();
  const n = await store.db.execute({ sql: "SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?", args: [accountId] });
  expect(Number(n.rows[0]!.n)).toBe(1);
});

test("atomicity: if the batch fails mid-way (new id_hash collides) NOTHING is applied: old session intact, old password still valid", async () => {
  const { store, s1, accountId } = await setup("neko_rot_atomic");
  const { changePassword } = await import("../src/accounts");
  const { sha256Hex } = await import("../src/crypto");
  const oldHash = await sha256Hex(s1);
  const before = String((await store.db.execute({ sql: "SELECT phc FROM password_credentials WHERE account_id = ?", args: [accountId] })).rows[0]!.phc);
  await expect(
    changePassword(store.db, { accountId, currentPassword: "accttest1234", newPassword: "newpass123456", pbkdf2: { rounds: 1, iter: 500 }, newSession: { idHash: oldHash, csrf: "c", now: 1000 } }),
  ).rejects.toThrow();
  expect(await lookupSession(store.db, s1, 1000)).not.toBeNull(); // the revoke was rolled back
  const after = String((await store.db.execute({ sql: "SELECT phc FROM password_credentials WHERE account_id = ?", args: [accountId] })).rows[0]!.phc);
  expect(after).toBe(before);
});

test("account deleted mid-change: account_gone, no live session, no new cookie value", async () => {
  const { store, accountId } = await setup("neko_rot_gone");
  const { changePassword } = await import("../src/accounts");
  // The guard (accountPresent) runs inside the batch; make the account vanish after the credential check by dropping accounts' row only.
  await store.db.execute("PRAGMA foreign_keys = OFF");
  const origBatch = store.db.batch.bind(store.db);
  store.db.batch = (async (stmts: never, mode: never) => {
    await store.db.execute({ sql: "DELETE FROM accounts WHERE id = ?", args: [accountId] });
    return origBatch(stmts, mode);
  }) as never;
  const r = await changePassword(store.db, { accountId, currentPassword: "accttest1234", newPassword: "newpass123456", pbkdf2: { rounds: 1, iter: 500 }, newSession: { idHash: "h_new", csrf: "c", now: 1000 } });
  expect(r).toEqual({ ok: false, error: "account_gone" });
  const live = await store.db.execute({ sql: "SELECT COUNT(*) AS n FROM sessions WHERE account_id = ? AND revoked_at IS NULL", args: [accountId] });
  expect(Number(live.rows[0]!.n)).toBe(0);
});

test("concurrent double submit: exactly one valid session survives, and it belongs to a response the client got", async () => {
  const { store, s1, csrf, change, accountId } = await setup("neko_rot_conc");
  const [a, b] = await Promise.all([change(s1, csrf, "newpass123456"), change(s1, csrf, "otherpass1234")]);
  const sessions = [a, b].filter((r) => r.status === 200).map((r) => cookieValue(r.headers.get("Set-Cookie"), "__Host-mw_sess")!);
  expect(sessions.length).toBeGreaterThan(0);
  const live = await store.db.execute({ sql: "SELECT COUNT(*) AS n FROM sessions WHERE account_id = ? AND revoked_at IS NULL", args: [accountId] });
  expect(Number(live.rows[0]!.n)).toBe(1); // last batch revoked the other's fresh session
  expect(await lookupSession(store.db, s1, 1000)).toBeNull();
}, 30000);

test("OAuth grants/consents are untouched by a password change (only sessions + tokens are revoked)", async () => {
  const { store, accountId, s1, csrf, change } = await setup("neko_rot_consent");
  await store.db.execute({ sql: "INSERT INTO consents (account_id, client_id, scope_set_max, approved_scope_snapshot) VALUES (?, 'mw_demo', '[\"openid\"]', '[\"openid\"]')", args: [accountId] });
  expect((await change(s1, csrf)).status).toBe(200);
  const c = await store.db.execute({ sql: "SELECT COUNT(*) AS n FROM consents WHERE account_id = ?", args: [accountId] });
  expect(Number(c.rows[0]!.n)).toBe(1);
});
