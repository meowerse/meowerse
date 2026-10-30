import { test, expect } from "vitest";
import { createClient } from "@libsql/client";
import { SCHEMA, SEED } from "../src/db";
import { deleteAccount } from "../src/accounts";
import { accessTokenInsert } from "../src/token";
import { codeUnconsumed, refreshUnused } from "../src/codeguard";
import { refreshTokenInsert } from "../src/refresh";
import type { DbClient } from "../src/types";

async function freshDb(): Promise<DbClient> {
  const c = createClient({ url: ":memory:" }) as unknown as DbClient;
  for (const stmt of [...SCHEMA, ...SEED]) await c.execute(stmt);
  return c;
}
const count = async (db: DbClient, sql: string, args: unknown[] = []) =>
  Number((await db.execute({ sql: `SELECT count(*) AS n FROM ${sql}`, args })).rows[0]!.n);

/** Every table deleteAccount erases, with the column that keys it to the account. */
const KEYED: [string, string][] = [
  ["recovery_codes", "account_id"], ["password_credentials", "account_id"], ["telegram_links", "account_id"],
  ["sessions", "account_id"], ["consents", "account_id"], ["access_tokens", "account_id"],
  ["refresh_tokens", "account_id"], ["management_tokens", "owner_account_id"], ["oauth_codes", "account_id"],
  ["login_requests", "account_id"], ["login_tickets", "account_id"], ["oauth_clients", "owner_account_id"],
  ["accounts", "id"],
];

async function seedAccount(db: DbClient, a: string, tgId: number) {
  const c = `cl_${a}`;
  const run = (sql: string, args: unknown[] = []) => db.execute({ sql, args });
  await run("INSERT INTO accounts (id, username) VALUES (?, ?)", [a, `u_${a}`]);
  await run("INSERT INTO password_credentials (account_id, phc) VALUES (?, 'p')", [a]);
  await run("INSERT INTO telegram_links (telegram_id, account_id) VALUES (?, ?)", [tgId, a]);
  await run("INSERT INTO recovery_codes (account_id, code_hash) VALUES (?, 'h')", [a]);
  await run("INSERT INTO sessions (id_hash, account_id, auth_time, csrf_token, idle_expires_at, absolute_expires_at) VALUES (?, ?, 1, 'c', 9, 9)", [`s_${a}`, a]);
  await run("INSERT INTO oauth_clients (client_id, name, owner_account_id, client_type, allowed_scopes) VALUES (?, ?, ?, 'public', '[]')", [c, `n_${a}`, a]);
  await run("INSERT INTO oauth_client_secrets (client_id, secret_phc) VALUES (?, 'x')", [c]);
  await run("INSERT INTO oauth_client_redirect_uris (client_id, redirect_uri) VALUES (?, 'http://x/cb')", [c]);
  // own consent on the seeded demo client + someone else's consent on this account's client
  await run("INSERT INTO consents (account_id, client_id, scope_set_max, approved_scope_snapshot) VALUES (?, 'mw_demo', '[]', '[]')", [a]);
  await run("INSERT INTO consents (account_id, client_id, scope_set_max, approved_scope_snapshot) VALUES ('acct_system', ?, '[]', '[]')", [c]);
  await run("INSERT INTO access_tokens (jti, account_id, client_id, scope, family_id, issued_at, expires_at) VALUES (?, ?, 'mw_demo', 'openid', ?, 1, 9)", [`at_${a}`, a, `f_${a}`]);
  await run("INSERT INTO refresh_tokens (token_hash, family_id, client_id, account_id, scope, idle_expires_at, absolute_expires_at) VALUES (?, ?, 'mw_demo', ?, 'openid', 9, 9)", [`rt_${a}`, `f_${a}`, a]);
  await run("INSERT INTO management_tokens (token_hash, owner_account_id) VALUES (?, ?)", [`mt_${a}`, a]);
  await run("INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, scope, code_challenge, code_challenge_method, account_id, session_id_hash, auth_time, jti_family, expires_at) VALUES (?, 'mw_demo', 'http://x/cb', 'openid', 'c', 'S256', ?, 's', 1, ?, 9)", [`oc_${a}`, a, `f_${a}`]);
  await run("INSERT INTO login_requests (rid, owner_hash, client_id, redirect_uri, scope, code_challenge, account_id, expires_at) VALUES (?, 'o', 'mw_demo', 'http://x/cb', 'openid', 'c', ?, 9)", [`lr_${a}`, a]);
  await run("INSERT INTO login_tickets (ticket_id, nonce_hash, owner_hash, kind, account_id, expires_at) VALUES (?, 'n', 'o', 'SIGNIN_OR_SIGNUP', ?, 9)", [`lt_${a}`, a]);
}
async function rowsFor(db: DbClient, a: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [t, col] of KEYED) out[t] = await count(db, `${t} WHERE ${col} = ?`, [a]);
  out.client_secrets = await count(db, "oauth_client_secrets WHERE client_id = ?", [`cl_${a}`]);
  out.client_redirects = await count(db, "oauth_client_redirect_uris WHERE client_id = ?", [`cl_${a}`]);
  out.consents_on_owned = await count(db, "consents WHERE client_id = ?", [`cl_${a}`]);
  return out;
}

async function twoAccounts() {
  const db = await freshDb();
  await seedAccount(db, "acct_v", 101);
  await seedAccount(db, "acct_o", 102);
  return db;
}

test("(a) deleteAccount empties every table for the account; other accounts untouched; audit_log kept", async () => {
  const db = await twoAccounts();
  await db.execute({ sql: "INSERT INTO audit_log (event, account_id) VALUES ('account.delete', 'acct_v')", args: [] });
  const bystander = await rowsFor(db, "acct_o");
  const before = await rowsFor(db, "acct_v");
  for (const v of Object.values(before)) expect(v).toBeGreaterThan(0);

  await deleteAccount(db, "acct_v");

  for (const v of Object.values(await rowsFor(db, "acct_v"))) expect(v).toBe(0);
  expect(await rowsFor(db, "acct_o")).toEqual(bystander);
  expect(await count(db, "audit_log WHERE account_id = 'acct_v'")).toBe(1);
});

test("(b) a failing DELETE inside the batch rolls everything back and throws", async () => {
  const db = await twoAccounts();
  await db.execute("CREATE TRIGGER boom BEFORE DELETE ON refresh_tokens BEGIN SELECT RAISE(ABORT, 'boom'); END");
  const before = await rowsFor(db, "acct_v");
  await expect(deleteAccount(db, "acct_v")).rejects.toThrow();
  expect(await rowsFor(db, "acct_v")).toEqual(before);
  for (const v of Object.values(before)) expect(v).toBeGreaterThan(0);
});

test("(c) guarded token issuance attempted after deletion inserts nothing", async () => {
  const db = await twoAccounts();
  await deleteAccount(db, "acct_v");
  const base = { accountId: "acct_v", clientId: "mw_demo", scope: ["openid", "offline_access"], family: "f_acct_v", now: 1000 };

  // authorization-code path
  const cg = codeUnconsumed("oc_acct_v");
  const { stmt } = await refreshTokenInsert(base, cg);
  const res = await db.batch([accessTokenInsert({ ...base, jti: "at_late" }, cg), stmt], "write");
  expect(res.map((r) => r.rowsAffected)).toEqual([0, 0]);

  // refresh-rotation path
  const rg = refreshUnused("rt_acct_v");
  const { stmt: rstmt } = await refreshTokenInsert(base, rg);
  const res2 = await db.batch([accessTokenInsert({ ...base, jti: "at_late2" }, rg), rstmt], "write");
  expect(res2.map((r) => r.rowsAffected)).toEqual([0, 0]);

  expect(await count(db, "access_tokens WHERE account_id = 'acct_v'")).toBe(0);
  expect(await count(db, "refresh_tokens WHERE account_id = 'acct_v'")).toBe(0);
});
