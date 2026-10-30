import { test, expect } from "vitest";
import { createClient } from "@libsql/client";
import { SCHEMA, SEED } from "../src/db";
import { handle } from "../src/index";
import { deleteAccount } from "../src/accounts";
import { sha256Hex } from "../src/crypto";
import { genSigningKeys, cookieValue } from "./helpers";
import type { DbClient } from "../src/types";

async function freshDb(): Promise<DbClient> {
  const c = createClient({ url: ":memory:" }) as unknown as DbClient;
  for (const stmt of [...SCHEMA, ...SEED]) await c.execute(stmt);
  return c;
}
const run = (db: DbClient, sql: string, args: unknown[] = []) => db.execute({ sql, args });
const count = async (db: DbClient, sql: string, args: unknown[] = []) =>
  Number((await db.execute({ sql: `SELECT count(*) AS n FROM ${sql}`, args })).rows[0]!.n);
const snapshot = async (db: DbClient) => {
  const out: Record<string, unknown> = {};
  for (const t of ["accounts", "oauth_clients", "oauth_codes", "access_tokens", "refresh_tokens", "consents", "sessions", "audit_log"])
    out[t] = (await db.execute(`SELECT * FROM ${t} ORDER BY 1, 2`)).rows.map((r) => ({ ...r }));
  return JSON.stringify(out);
};

const IP = "203.0.113.77";
const UA = "TestAgent/1.0 (secret-ua)";

async function setup(wrap?: (db: DbClient) => DbClient) {
  const db = await freshDb();
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", WEB_ORIGIN: "https://web", CORS_ORIGINS: "https://web", ACCOUNT_DELETE_ENABLED: "1" };
  const deps = { getDb: () => (wrap ? wrap(db) : db), clock: () => 1000 };
  const su = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "victim", password: "accttest1234" }) }), env as never, deps as never);
  const { csrf } = (await su.json()) as { csrf: string };
  const sess = cookieValue(su.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  const accountId = String((await run(db, "SELECT id FROM accounts WHERE username = 'victim'")).rows[0]!.id);
  const del = () =>
    handle(new Request("https://iss/api/account/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${sess}`, "CF-Connecting-IP": IP, "User-Agent": UA },
      body: JSON.stringify({ csrf, confirm: "victim" }),
    }), env as never, deps as never);
  return { db, accountId, del };
}

async function addClient(db: DbClient, id: string, owner: string, softDeleted: boolean) {
  await run(db, "INSERT INTO oauth_clients (client_id, name, owner_account_id, client_type, allowed_scopes, deleted_at) VALUES (?, ?, ?, 'public', '[]', ?)", [id, `n_${id}`, owner, softDeleted ? "2026-01-01" : null]);
}
/** A bystander's code + tokens + consent for `clientId`. */
async function addUserRows(db: DbClient, acct: string, clientId: string) {
  await run(db, "INSERT OR IGNORE INTO accounts (id, username) VALUES (?, ?)", [acct, acct]);
  await run(db, "INSERT INTO consents (account_id, client_id, scope_set_max, approved_scope_snapshot) VALUES (?, ?, '[]', '[]')", [acct, clientId]);
  await run(db, "INSERT INTO access_tokens (jti, account_id, client_id, scope, family_id, issued_at, expires_at) VALUES (?, ?, ?, 'openid', ?, 1, 9)", [`at_${acct}_${clientId}`, acct, clientId, `f_${acct}_${clientId}`]);
  await run(db, "INSERT INTO refresh_tokens (token_hash, family_id, client_id, account_id, scope, idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, 'openid', 9, 9)", [`rt_${acct}_${clientId}`, `f_${acct}_${clientId}`, clientId, acct]);
  await run(db, "INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, scope, code_challenge, code_challenge_method, account_id, session_id_hash, auth_time, jti_family, expires_at) VALUES (?, ?, 'http://x/cb', 'openid', 'c', 'S256', ?, 's', 1, ?, 9)", [`oc_${acct}_${clientId}`, clientId, acct, `f_${acct}_${clientId}`]);
}
const userRows = async (db: DbClient, acct: string, clientId: string) =>
  (await count(db, "consents WHERE account_id = ? AND client_id = ?", [acct, clientId])) +
  (await count(db, "access_tokens WHERE account_id = ? AND client_id = ?", [acct, clientId])) +
  (await count(db, "refresh_tokens WHERE account_id = ? AND client_id = ?", [acct, clientId])) +
  (await count(db, "oauth_codes WHERE account_id = ? AND client_id = ?", [acct, clientId]));

test("owning an active client → 409 owns_active_clients, every row unchanged, no account.delete audit row", async () => {
  const { db, accountId, del } = await setup();
  await addClient(db, "cl_active", accountId, false);
  await addUserRows(db, "acct_bystander", "cl_active");
  const before = await snapshot(db);
  const r = await del();
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: "owns_active_clients" });
  expect(r.headers.get("Set-Cookie")).toBeNull();
  expect(await snapshot(db)).toBe(before);
  expect(await count(db, "audit_log WHERE event = 'account.delete'")).toBe(0);
});

test("in-batch guard: deleteAccount itself rolls back everything when an active owned client exists", async () => {
  const { db, accountId } = await setup();
  await addClient(db, "cl_race", accountId, false); // as if created between the handler pre-check and the batch
  const before = await snapshot(db);
  await expect(deleteAccount(db, accountId, { ipTrunc: null, uaHash: null })).rejects.toThrow();
  expect(await snapshot(db)).toBe(before);
});

test("soft-deleted owned client: other users' codes/tokens/consents for it are removed; unrelated rows untouched", async () => {
  const { db, accountId, del } = await setup();
  await addClient(db, "cl_dead", accountId, true);
  await addUserRows(db, "acct_bystander", "cl_dead");
  await addUserRows(db, "acct_bystander", "mw_demo"); // another client: must survive
  expect(await userRows(db, "acct_bystander", "cl_dead")).toBe(4);
  const r = await del();
  expect(r.status).toBe(200);
  expect(await userRows(db, "acct_bystander", "cl_dead")).toBe(0);
  expect(await userRows(db, "acct_bystander", "mw_demo")).toBe(4);
  expect(await count(db, "accounts WHERE id = 'acct_bystander'")).toBe(1);
  expect(await count(db, "oauth_clients WHERE client_id = 'cl_dead'")).toBe(0);
  expect(await count(db, "accounts WHERE id = ?", [accountId])).toBe(0);
});

test("a failing DELETE in the batch → 500 server_error, account untouched, no audit row", async () => {
  const { db, accountId, del } = await setup();
  await run(db, "CREATE TRIGGER boom BEFORE DELETE ON password_credentials BEGIN SELECT RAISE(ABORT, 'boom'); END");
  const before = await snapshot(db);
  const r = await del();
  expect(r.status).toBe(500);
  expect(await r.json()).toEqual({ error: "server_error" });
  expect(r.headers.get("Set-Cookie")).toBeNull();
  expect(await snapshot(db)).toBe(before);
  expect(await count(db, "accounts WHERE id = ?", [accountId])).toBe(1);
  expect(await count(db, "audit_log WHERE event = 'account.delete'")).toBe(0);
});

test("batch commits then the response is lost (throws) → 200 {ok:true}, exactly one audit row, cookie cleared", async () => {
  let armed = false;
  const { db, accountId, del } = await setup((real) => ({
    execute: real.execute.bind(real),
    batch: async (stmts, mode) => {
      const res = await real.batch(stmts, mode);
      if (armed) throw new Error("response lost");
      return res;
    },
  }));
  armed = true;
  const r = await del();
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true });
  expect(r.headers.get("Set-Cookie")).toContain("mw_sess");
  expect(await count(db, "accounts WHERE id = ?", [accountId])).toBe(0);
  expect(await count(db, "audit_log WHERE event = 'account.delete' AND account_id = ?", [accountId])).toBe(1);
});

test("success → exactly one account.delete row with account_id, truncated ip and ua hash; no raw ip/ua stored", async () => {
  const { db, accountId, del } = await setup();
  expect((await del()).status).toBe(200);
  const rows = (await db.execute({ sql: "SELECT * FROM audit_log WHERE event = 'account.delete'", args: [] })).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ account_id: accountId, client_id: null, ip_trunc: "203.0.113.0/24", ua_hash: (await sha256Hex(UA)).slice(0, 16) });
  const dump = JSON.stringify((await db.execute("SELECT * FROM audit_log")).rows);
  expect(dump).not.toContain(IP);
  expect(dump).not.toContain("secret-ua");
});
