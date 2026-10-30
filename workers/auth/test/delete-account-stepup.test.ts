import { test, expect } from "vitest";
import { createClient } from "@libsql/client";
import { SCHEMA, SEED } from "../src/db";
import { handle } from "../src/index";
import { sha256Hex, hashPassword, CHEAP_PBKDF2 } from "../src/crypto";
import { genSigningKeys } from "./helpers";
import type { DbClient } from "../src/types";

// Step D: server-verified fresh auth + single-use, account/session-bound, expiring delete confirmation.
// Real in-memory libsql, driven through handle() with the delete flag ON.

const PW = "accttest1234";
const T0 = 100_000;

async function freshDb(): Promise<DbClient> {
  const c = createClient({ url: ":memory:" }) as unknown as DbClient;
  for (const stmt of [...SCHEMA, ...SEED]) await c.execute(stmt);
  return c;
}
const run = (db: DbClient, sql: string, args: unknown[] = []) => db.execute({ sql, args });
const count = async (db: DbClient, sql: string, args: unknown[] = []) =>
  Number((await db.execute({ sql: `SELECT count(*) AS n FROM ${sql}`, args })).rows[0]!.n);

interface Sess { raw: string; csrf: string }

async function setup(envExtra: Record<string, string> = { ACCOUNT_DELETE_ENABLED: "1" }) {
  const db = await freshDb();
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", WEB_ORIGIN: "https://web", CORS_ORIGINS: "https://web", ...envExtra };
  let clock = T0;
  let beforeBatch: ((stmts: { sql: string }[]) => Promise<void>) | null = null;
  const wrapped: DbClient = {
    execute: (s) => db.execute(s),
    batch: async (stmts, mode) => {
      if (beforeBatch && stmts.some((s) => /account_delete_confirmations SET used_at/.test(s.sql))) {
        const h = beforeBatch;
        beforeBatch = null;
        await h(stmts);
      }
      return db.batch(stmts, mode);
    },
  };
  const deps = { getDb: () => wrapped, clock: () => clock };
  const call = (path: string, s: Sess, body: Record<string, unknown>) =>
    handle(new Request(`https://iss${path}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${s.raw}` }, body: JSON.stringify({ csrf: s.csrf, ...body }) }), env as never, deps as never);
  /** A live session for `accountId` with the given real login time. */
  const addSession = async (accountId: string, raw: string, authTime: number): Promise<Sess> => {
    await run(db, "INSERT INTO sessions (id_hash, account_id, auth_time, amr, csrf_token, idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, 'pwd', ?, ?, ?)",
      [await sha256Hex(raw), accountId, authTime, `csrf_${raw}`, T0 + 1e6, T0 + 1e6]);
    return { raw, csrf: `csrf_${raw}` };
  };
  const addAccount = async (id: string, username: string | null, password: string | null, display = "D") => {
    await run(db, "INSERT INTO accounts (id, username, display_name) VALUES (?, ?, ?)", [id, username, display]);
    if (password) await run(db, "INSERT INTO password_credentials (account_id, phc) VALUES (?, ?)", [id, await hashPassword(password, CHEAP_PBKDF2)]);
  };
  const start = async (s: Sess, body: Record<string, unknown> = {}) => {
    const r = await call("/api/account/delete/start", s, body);
    return { r, body: (await r.json()) as Record<string, unknown> };
  };
  const token = async (s: Sess) => (await start(s)).body.confirm_token as string;
  const del = (s: Sess, confirm: string, confirm_token?: string) => call("/api/account/delete", s, { confirm, ...(confirm_token === undefined ? {} : { confirm_token }) });
  return { db, call, addSession, addAccount, start, token, del, setClock: (t: number) => (clock = t), onBatch: (h: typeof beforeBatch) => (beforeBatch = h) };
}
const stale = T0 - 301;

test("stale auth + no password (Telegram-only) → 401 step_up_required reauth=telegram; nothing written", async () => {
  const f = await setup();
  await f.addAccount("a_tg", null, null, "TG User");
  const s = await f.addSession("a_tg", "tgraw", stale);
  const { r, body } = await f.start(s, { current_password: "whatever" });
  expect(r.status).toBe(401);
  expect(body).toEqual({ error: "step_up_required", reauth: "telegram" });
  expect(await count(f.db, "account_delete_confirmations")).toBe(0);
});

test("stale auth + password account, no password supplied → 401 step_up_required reauth=password", async () => {
  const f = await setup();
  await f.addAccount("a_pw", "pwuser", PW);
  const s = await f.addSession("a_pw", "pwraw", stale);
  const { r, body } = await f.start(s);
  expect(r.status).toBe(401);
  expect(body).toEqual({ error: "step_up_required", reauth: "password" });
});

test("fresh auth (auth_time within 300 s) → token issued; only its hash is stored, bound to account + session, 300 s expiry", async () => {
  const f = await setup();
  await f.addAccount("a_pw", "pwuser", PW);
  const s = await f.addSession("a_pw", "pwraw", T0 - 300);
  const { r, body } = await f.start(s);
  expect(r.status).toBe(200);
  const tok = body.confirm_token as string;
  expect(tok.length).toBeGreaterThanOrEqual(43);
  const row = (await run(f.db, "SELECT * FROM account_delete_confirmations")).rows[0]!;
  expect(row).toMatchObject({ token_hash: await sha256Hex(tok), account_id: "a_pw", session_id_hash: await sha256Hex("pwraw"), created_at: T0, expires_at: T0 + 300, used_at: null });
  expect(JSON.stringify((await run(f.db, "SELECT * FROM account_delete_confirmations")).rows)).not.toContain(tok);
});

test("correct password with stale auth → token", async () => {
  const f = await setup();
  await f.addAccount("a_pw", "pwuser", PW);
  const s = await f.addSession("a_pw", "pwraw", stale);
  const { r, body } = await f.start(s, { current_password: PW });
  expect(r.status).toBe(200);
  expect(typeof body.confirm_token).toBe("string");
});

test("wrong password → 403 wrong_password + audit account.delete_stepup_fail (no secrets); 6th attempt → 429", async () => {
  const f = await setup();
  await f.addAccount("a_pw", "pwuser", PW);
  const s = await f.addSession("a_pw", "pwraw", stale);
  for (let i = 0; i < 5; i++) {
    const { r, body } = await f.start(s, { current_password: `bad-guess-${i}` });
    expect(r.status).toBe(403);
    expect(body).toEqual({ error: "wrong_password" });
  }
  expect(await count(f.db, "audit_log WHERE event = 'account.delete_stepup_fail' AND account_id = 'a_pw'")).toBe(5);
  expect(JSON.stringify((await run(f.db, "SELECT * FROM audit_log")).rows)).not.toContain("bad-guess");
  const sixth = await f.start(s, { current_password: PW }); // even the right password is throttled
  expect(sixth.r.status).toBe(429);
  expect(await count(f.db, "account_delete_confirmations")).toBe(0);
});

test("delete without a token / with a missing-or-garbage token / wrong username → nothing changes", async () => {
  const f = await setup();
  await f.addAccount("a_pw", "pwuser", PW);
  const s = await f.addSession("a_pw", "pwraw", T0);
  const tok = await f.token(s);
  const before = JSON.stringify([(await run(f.db, "SELECT * FROM accounts")).rows, (await run(f.db, "SELECT * FROM sessions")).rows, (await run(f.db, "SELECT * FROM account_delete_confirmations")).rows, (await run(f.db, "SELECT * FROM audit_log")).rows]);
  expect((await f.del(s, "pwuser")).status).toBe(403);
  expect((await f.del(s, "pwuser", "garbage")).status).toBe(403);
  const mm = await f.del(s, "not-the-user", tok);
  expect(mm.status).toBe(400);
  expect(await mm.json()).toEqual({ error: "confirm_mismatch" });
  const after = JSON.stringify([(await run(f.db, "SELECT * FROM accounts")).rows, (await run(f.db, "SELECT * FROM sessions")).rows, (await run(f.db, "SELECT * FROM account_delete_confirmations")).rows, (await run(f.db, "SELECT * FROM audit_log")).rows]);
  expect(after).toBe(before);
  // the token is still usable afterwards (mismatch consumed nothing)
  expect((await f.del(s, "pwuser", tok)).status).toBe(200);
});

test("happy path: deletes, exactly one account.delete audit row, confirmation row gone", async () => {
  const f = await setup();
  await f.addAccount("a_pw", "pwuser", PW);
  const s = await f.addSession("a_pw", "pwraw", T0);
  const r = await f.del(s, "pwuser", await f.token(s));
  expect(r.status).toBe(200);
  expect(await count(f.db, "accounts WHERE id = 'a_pw'")).toBe(0);
  expect(await count(f.db, "account_delete_confirmations")).toBe(0);
  expect(await count(f.db, "audit_log WHERE event = 'account.delete'")).toBe(1);
});

test("replay: the same token twice → second is rejected and nothing more changes (token consumed even when the account survives)", async () => {
  const f = await setup();
  await f.addAccount("a_pw", "pwuser", PW);
  await f.addAccount("a_other", "other", PW);
  const s = await f.addSession("a_pw", "pwraw", T0);
  const tok = await f.token(s);
  // Real path: delete, then replay the same token (the session died with the account).
  expect((await f.del(s, "pwuser", tok)).status).toBe(200);
  const auditBefore = await count(f.db, "audit_log");
  const second = await f.del(s, "pwuser", tok);
  expect(second.status).toBe(401); // session died with the account
  expect(await count(f.db, "audit_log")).toBe(auditBefore);
  expect(await count(f.db, "accounts WHERE id = 'a_other'")).toBe(1);
});

test("replay at the DB layer: a used token (used_at set) is rejected by the consume guard; nothing changes", async () => {
  const f = await setup();
  await f.addAccount("a_pw", "pwuser", PW);
  const s = await f.addSession("a_pw", "pwraw", T0);
  const tok = await f.token(s);
  await run(f.db, "UPDATE account_delete_confirmations SET used_at = ?", [T0]); // as if already consumed
  const before = await count(f.db, "audit_log");
  const r = await f.del(s, "pwuser", tok);
  expect(r.status).toBe(403);
  expect(await r.json()).toEqual({ error: "confirm_invalid" });
  expect(await count(f.db, "accounts WHERE id = 'a_pw'")).toBe(1);
  expect(await count(f.db, "audit_log")).toBe(before);
});

test("concurrent double consumption (interleaved): exactly one deletion + one audit row; the loser fails cleanly with 403", async () => {
  const f = await setup();
  await f.addAccount("a_pw", "pwuser", PW);
  const s = await f.addSession("a_pw", "pwraw", T0);
  const tok = await f.token(s);
  let winner: Response | null = null;
  // Request A has passed every pre-check and is about to run its batch; request B runs to completion first.
  f.onBatch(async () => { winner = await f.del(s, "pwuser", tok); });
  const loser = await f.del(s, "pwuser", tok);
  expect(winner!.status).toBe(200);
  expect(loser.status).toBe(403);
  expect(await loser.json()).toEqual({ error: "confirm_invalid" });
  expect(loser.headers.get("Set-Cookie")).toBeNull();
  expect(await count(f.db, "accounts WHERE id = 'a_pw'")).toBe(0);
  expect(await count(f.db, "audit_log WHERE event = 'account.delete' AND account_id = 'a_pw'")).toBe(1);
});

test("concurrent double consumption (Promise.all): never two successes, never two audit rows", async () => {
  const f = await setup();
  await f.addAccount("a_pw", "pwuser", PW);
  const s = await f.addSession("a_pw", "pwraw", T0);
  const tok = await f.token(s);
  const rs = await Promise.all([f.del(s, "pwuser", tok), f.del(s, "pwuser", tok)]);
  expect(rs.filter((r) => r.status === 200).length).toBe(1);
  expect(await count(f.db, "audit_log WHERE event = 'account.delete'")).toBe(1);
  expect(await count(f.db, "accounts WHERE id = 'a_pw'")).toBe(0);
});

test("expired token (clock past expiry) → 403 confirm_invalid; account kept", async () => {
  const f = await setup();
  await f.addAccount("a_pw", "pwuser", PW);
  const s = await f.addSession("a_pw", "pwraw", T0);
  const tok = await f.token(s);
  f.setClock(T0 + 300); // expires_at = T0+300; not strictly greater
  const r = await f.del(s, "pwuser", tok);
  expect(r.status).toBe(403);
  expect(await r.json()).toEqual({ error: "confirm_invalid" });
  expect(await count(f.db, "accounts WHERE id = 'a_pw'")).toBe(1);
  expect(await count(f.db, "audit_log WHERE event = 'account.delete'")).toBe(0);
});

test("token minted in another session of the same account → 403; the minting session can still use it", async () => {
  const f = await setup();
  await f.addAccount("a_pw", "pwuser", PW);
  const s1 = await f.addSession("a_pw", "raw1", T0);
  const s2 = await f.addSession("a_pw", "raw2", T0);
  const tok = await f.token(s1);
  expect((await f.del(s2, "pwuser", tok)).status).toBe(403);
  expect(await count(f.db, "accounts WHERE id = 'a_pw'")).toBe(1);
  expect((await f.del(s1, "pwuser", tok)).status).toBe(200);
});

test("token minted for another account → 403 and neither account is touched", async () => {
  const f = await setup();
  await f.addAccount("a_one", "userone", PW);
  await f.addAccount("a_two", "usertwo", PW);
  const s1 = await f.addSession("a_one", "raw1", T0);
  const s2 = await f.addSession("a_two", "raw2", T0);
  const tok2 = await f.token(s2);
  expect((await f.del(s1, "userone", tok2)).status).toBe(403);
  expect(await count(f.db, "accounts WHERE id IN ('a_one','a_two')")).toBe(2);
  expect(await count(f.db, "audit_log WHERE event = 'account.delete'")).toBe(0);
});

test("issuing a new token invalidates the previous unused one", async () => {
  const f = await setup();
  await f.addAccount("a_pw", "pwuser", PW);
  const s = await f.addSession("a_pw", "pwraw", T0);
  const t1 = await f.token(s);
  const t2 = await f.token(s);
  expect(t1).not.toBe(t2);
  expect(await count(f.db, "account_delete_confirmations")).toBe(1);
  expect((await f.del(s, "pwuser", t1)).status).toBe(403);
  expect((await f.del(s, "pwuser", t2)).status).toBe(200);
});

test("flag off: /start and /delete both 503 deletion_unavailable and nothing is written", async () => {
  const f = await setup({});
  await f.addAccount("a_pw", "pwuser", PW);
  const s = await f.addSession("a_pw", "pwraw", T0);
  const before = JSON.stringify([(await run(f.db, "SELECT * FROM accounts")).rows, (await run(f.db, "SELECT * FROM audit_log")).rows, (await run(f.db, "SELECT * FROM rate_limits")).rows]);
  const a = await f.start(s, { current_password: "wrong" });
  expect(a.r.status).toBe(503);
  expect(a.body).toEqual({ error: "deletion_unavailable" });
  const b = await f.del(s, "pwuser", "x");
  expect(b.status).toBe(503);
  expect(await count(f.db, "account_delete_confirmations")).toBe(0);
  expect(JSON.stringify([(await run(f.db, "SELECT * FROM accounts")).rows, (await run(f.db, "SELECT * FROM audit_log")).rows, (await run(f.db, "SELECT * FROM rate_limits")).rows])).toBe(before);
});

test("start requires session + CSRF", async () => {
  const f = await setup();
  await f.addAccount("a_pw", "pwuser", PW);
  const s = await f.addSession("a_pw", "pwraw", T0);
  expect((await f.call("/api/account/delete/start", { ...s, csrf: "WRONG" }, {})).status).toBe(403);
  expect((await f.call("/api/account/delete/start", { raw: "nope", csrf: "x" }, {})).status).toBe(401);
});
