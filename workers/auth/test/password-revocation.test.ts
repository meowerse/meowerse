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

test("password change keeps the current session but revokes other sessions and all refresh/access tokens", async () => {
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

  expect(await lookupSession(store.db, s2.rawId, 1000)).toBeNull();
  expect(await lookupSession(store.db, s1, 1000)).not.toBeNull();
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
