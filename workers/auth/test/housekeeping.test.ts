import { test, expect, vi } from "vitest";
import { createClient } from "@libsql/client";
import { SCHEMA } from "../src/db";
import { runHousekeeping, scheduledHousekeeping, HOUSEKEEPING_MARGIN, RETENTION_GRACE } from "../src/housekeeping";
import { createRefreshToken, rotateRefresh, REFRESH_ABS_TTL, REFRESH_IDLE_TTL } from "../src/refresh";
import { exchangeCode, ACCESS_TTL, CODE_TTL } from "../src/token";
import { sha256Hex } from "../src/crypto";
import { TICKET_CLAIM_GRACE } from "../src/telegram";
import type { DbClient } from "../src/types";

const NOW = 1_800_000_000; // 2027-01-15T08:00:00Z
const DAY = 86400;

async function freshDb(): Promise<DbClient> {
  const c = createClient({ url: ":memory:" }) as unknown as DbClient;
  for (const stmt of SCHEMA) await c.execute(stmt);
  return c;
}
const ts = (epoch: number) => new Date(epoch * 1000).toISOString().slice(0, 19).replace("T", " ");
const count = async (db: DbClient, t: string) => Number((await db.execute(`SELECT count(*) AS n FROM ${t}`)).rows[0]!.n);

async function addAudit(db: DbClient, id: number, epoch: number) {
  await db.execute({ sql: "INSERT INTO audit_log (id, ts, event) VALUES (?, ?, 'x')", args: [id, ts(epoch)] });
}
async function addTicket(db: DbClient, id: string, exp: number, status = "pending") {
  await db.execute({ sql: "INSERT INTO login_tickets (ticket_id, nonce_hash, owner_hash, kind, status, expires_at) VALUES (?, 'n', 'o', 'SIGNIN_OR_SIGNUP', ?, ?)", args: [id, status, exp] });
}
async function addSession(db: DbClient, id: string, abs: number) {
  await db.execute({ sql: "INSERT OR IGNORE INTO accounts (id, username, display_name) VALUES ('a1','alice','Alice')", args: [] });
  await db.execute({ sql: "INSERT INTO sessions (id_hash, account_id, auth_time, csrf_token, idle_expires_at, absolute_expires_at) VALUES (?, 'a1', 0, 'c', ?, ?)", args: [id, abs, abs] });
}
async function addAccess(db: DbClient, jti: string, exp: number) {
  await db.execute({ sql: "INSERT INTO access_tokens (jti, account_id, client_id, scope, family_id, issued_at, expires_at) VALUES (?, 'a1', 'c', 's', 'f', 0, ?)", args: [jti, exp] });
}

test("audit_log: older than 365 days deleted, just inside kept", async () => {
  const db = await freshDb();
  const cut = NOW - 365 * DAY;
  await addAudit(db, 1, cut - 1);
  await addAudit(db, 2, cut + 1);
  await addAudit(db, 3, cut); // exactly at the cutoff: kept (strict <)
  const r = await runHousekeeping(db, NOW);
  expect(r.deleted.audit_log).toBe(1);
  expect((await db.execute("SELECT id FROM audit_log ORDER BY id")).rows.map((x) => Number(x.id))).toEqual([2, 3]);
});

test("login_tickets: expires_at older than now - grace - 1 day deleted (any status), newer kept", async () => {
  const db = await freshDb();
  const cut = NOW - TICKET_CLAIM_GRACE - HOUSEKEEPING_MARGIN;
  await addTicket(db, "old_pending", cut - 1, "pending");
  await addTicket(db, "old_claimed", cut - 1, "claimed");
  await addTicket(db, "edge", cut, "consumed");
  await addTicket(db, "new", cut + 1, "consumed");
  const r = await runHousekeeping(db, NOW);
  expect(r.deleted.login_tickets).toBe(2);
  expect((await db.execute("SELECT ticket_id FROM login_tickets ORDER BY ticket_id")).rows.map((x) => x.ticket_id)).toEqual(["edge", "new"]);
});

test("sessions: absolute expiry + 1 day margin", async () => {
  const db = await freshDb();
  const cut = NOW - HOUSEKEEPING_MARGIN;
  await addSession(db, "s_old", cut - 1);
  await addSession(db, "s_edge", cut);
  await addSession(db, "s_live", NOW + 100);
  const r = await runHousekeeping(db, NOW);
  expect(r.deleted.sessions).toBe(1);
  expect((await db.execute("SELECT id_hash FROM sessions ORDER BY id_hash")).rows.map((x) => x.id_hash)).toEqual(["s_edge", "s_live"]);
});

test("access_tokens: expiry + 1 day margin", async () => {
  const db = await freshDb();
  const cut = NOW - HOUSEKEEPING_MARGIN;
  await addAccess(db, "j_old", cut - 1);
  await addAccess(db, "j_edge", cut);
  const r = await runHousekeeping(db, NOW);
  expect(r.deleted.access_tokens).toBe(1);
  expect(await count(db, "access_tokens")).toBe(1);
});

async function addRefresh(db: DbClient, hash: string, family: string, abs: number, opts: { idle?: number; used?: boolean } = {}) {
  await db.execute({
    sql: "INSERT INTO refresh_tokens (token_hash, family_id, client_id, account_id, scope, used_at, idle_expires_at, absolute_expires_at) VALUES (?, ?, 'c', 'a1', 's', ?, ?, ?)",
    args: [hash, family, opts.used ? "2020-01-01 00:00:00" : null, opts.idle ?? abs, abs],
  });
}
async function addCode(db: DbClient, hash: string, exp: number, consumed: boolean, family = "fam_" + hash) {
  await db.execute({
    sql: "INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, scope, code_challenge, code_challenge_method, account_id, session_id_hash, auth_time, jti_family, expires_at, consumed_at) VALUES (?, 'c', 'u', 's', 'ch', 'S256', 'a1', 's', 0, ?, ?, ?)",
    args: [hash, family, exp, consumed ? "2020-01-01 00:00:00" : null],
  });
}
const ids = async (db: DbClient, col: string, t: string) => (await db.execute(`SELECT ${col} AS v FROM ${t} ORDER BY ${col}`)).rows.map((x) => String(x.v));

const FAM_CUT = NOW - RETENTION_GRACE;
const CODE_CUT = NOW - REFRESH_ABS_TTL - ACCESS_TTL - RETENTION_GRACE;

test("refresh_tokens: family cutoff boundary (1 s past deleted, exactly at cutoff kept)", async () => {
  const db = await freshDb();
  await addRefresh(db, "r_past", "f1", FAM_CUT - 1, { used: true });
  await addRefresh(db, "r_edge", "f2", FAM_CUT, { used: true });
  await addRefresh(db, "r_in", "f3", FAM_CUT + 1, { used: true });
  const r = await runHousekeeping(db, NOW);
  expect(r.deleted.refresh_tokens).toBe(1);
  expect(await ids(db, "token_hash", "refresh_tokens")).toEqual(["r_edge", "r_in"]);
});

test("refresh_tokens: idle-expired but within absolute expiry (+grace) is NOT deleted", async () => {
  const db = await freshDb();
  // idle long dead (way before the grace cutoff), absolute still in the future / inside grace
  await addRefresh(db, "r_live_abs", "f1", NOW + 5 * DAY, { idle: NOW - 400 * DAY, used: true });
  await addRefresh(db, "r_grace_abs", "f2", FAM_CUT + 5 * DAY, { idle: NOW - 400 * DAY, used: true });
  const r = await runHousekeeping(db, NOW);
  expect(r.deleted.refresh_tokens).toBe(0);
  expect(await count(db, "refresh_tokens")).toBe(2);
});

test("refresh_tokens: a row is never deleted while any sibling is inside absolute expiry + grace", async () => {
  const db = await freshDb();
  await addRefresh(db, "a_old", "fam", FAM_CUT - 100, { used: true });
  await addRefresh(db, "a_old2", "fam", FAM_CUT - 1, { used: true });
  await addRefresh(db, "a_sibling", "fam", FAM_CUT, {}); // inside the window -> keeps the whole family
  await addRefresh(db, "b_old", "fam_b", FAM_CUT - 100, { used: true }); // wholly past: goes
  const r = await runHousekeeping(db, NOW);
  expect(r.deleted.refresh_tokens).toBe(1);
  expect(await ids(db, "token_hash", "refresh_tokens")).toEqual(["a_old", "a_old2", "a_sibling"]);
});

test("refresh_tokens: replay of a rotated token inside the window still revokes after housekeeping", async () => {
  const db = await freshDb();
  const t0 = NOW - 20 * DAY; // family lives until t0 + 30d = NOW + 10d
  const first = await createRefreshToken(db, { accountId: "a1", clientId: "c", scope: ["openid"], family: "fam_x", now: t0 });
  const second = await createRefreshToken(db, { accountId: "a1", clientId: "c", scope: ["openid"], family: "fam_x", now: t0 + 5 * DAY, absExpires: t0 + REFRESH_ABS_TTL, prevId: await sha256Hex(first) });
  await db.execute({ sql: "UPDATE refresh_tokens SET used_at = datetime('now') WHERE token_hash = ?", args: [await sha256Hex(first)] });
  await db.execute({ sql: "INSERT INTO access_tokens (jti, account_id, client_id, scope, family_id, issued_at, expires_at) VALUES ('j1','a1','c','s','fam_x',0,?)", args: [NOW + 100] });
  const r = await runHousekeeping(db, NOW);
  expect(r.deleted.refresh_tokens).toBe(0);
  // first token is idle-expired (t0 + 14d < NOW) yet its row survives, so reuse is still detected
  expect(t0 + REFRESH_IDLE_TTL).toBeLessThan(NOW);
  const res = await rotateRefresh(db, { token: first, clientId: "c", now: NOW });
  expect(res).toMatchObject({ ok: false, reuse: true, error: "invalid_grant" });
  // family revoked: the live successor is now spent and the access token is revoked
  expect((await db.execute({ sql: "SELECT used_at FROM refresh_tokens WHERE token_hash = ?", args: [await sha256Hex(second)] })).rows[0]!.used_at).not.toBeNull();
  expect((await db.execute("SELECT revoked_at FROM access_tokens WHERE jti = 'j1'")).rows[0]!.revoked_at).not.toBeNull();
});

test("refresh_tokens: batching deletes a whole family even when it spans batches; a retained family is never partially deleted", async () => {
  const db = await freshDb();
  for (let i = 0; i < 5; i++) await addRefresh(db, `dead_${i}`, "fam_dead", FAM_CUT - 10, { used: true });
  for (let i = 0; i < 5; i++) await addRefresh(db, `keep_${i}`, "fam_keep", FAM_CUT + (i === 0 ? 0 : -10 - i), { used: true });
  const r = await runHousekeeping(db, NOW, { batchSize: 1, maxBatches: 100 });
  expect(r.deleted.refresh_tokens).toBe(5);
  expect((await ids(db, "token_hash", "refresh_tokens")).sort()).toEqual(["keep_0", "keep_1", "keep_2", "keep_3", "keep_4"]);
  // capped run: 2 batches x 2 rows = 4 deleted, the remaining row goes on the next run
  const db2 = await freshDb();
  for (let i = 0; i < 5; i++) await addRefresh(db2, `d_${i}`, "fam_d", FAM_CUT - 10, { used: true });
  const r2 = await runHousekeeping(db2, NOW, { batchSize: 2, maxBatches: 2 });
  expect(r2.deleted.refresh_tokens).toBe(4);
  expect(await count(db2, "refresh_tokens")).toBe(1);
  const r3 = await runHousekeeping(db2, NOW, { batchSize: 2, maxBatches: 2 });
  expect(r3.deleted.refresh_tokens).toBe(1);
  expect(await count(db2, "refresh_tokens")).toBe(0);
});

test("oauth_codes consumed: horizon is expiry + abs TTL + access TTL + grace (1 s past deleted, at horizon kept)", async () => {
  const db = await freshDb();
  await addCode(db, "c_past", CODE_CUT - 1, true);
  await addCode(db, "c_edge", CODE_CUT, true);
  await addCode(db, "c_in", CODE_CUT + 1, true);
  await addCode(db, "c_recent", NOW - 50 * DAY, true); // inside horizon even though expired > 30d ago
  const r = await runHousekeeping(db, NOW);
  expect(r.deleted.oauth_codes_consumed).toBe(1);
  expect(await ids(db, "code_hash", "oauth_codes")).toEqual(["c_edge", "c_in", "c_recent"]);
});

test("oauth_codes unredeemed: kept until expiry + 30d (1 s past deleted, at cutoff kept)", async () => {
  const db = await freshDb();
  await addCode(db, "u_past", NOW - RETENTION_GRACE - 1, false);
  await addCode(db, "u_edge", NOW - RETENTION_GRACE, false);
  await addCode(db, "u_live", NOW - 1, false);
  const r = await runHousekeeping(db, NOW);
  expect(r.deleted.oauth_codes_unredeemed).toBe(1);
  expect(r.deleted.oauth_codes_consumed).toBe(0);
  expect(await ids(db, "code_hash", "oauth_codes")).toEqual(["u_edge", "u_live"]);
});

test("oauth_codes: consumed vs unredeemed use different cutoffs (a consumed code past 30d but inside the horizon is kept; unredeemed same age is deleted)", async () => {
  const db = await freshDb();
  const exp = NOW - RETENTION_GRACE - 10 * DAY;
  await addCode(db, "consumed", exp, true);
  await addCode(db, "unredeemed", exp, false);
  await runHousekeeping(db, NOW);
  expect(await ids(db, "code_hash", "oauth_codes")).toEqual(["consumed"]);
});

test("oauth_codes: consumed code inside the horizon still triggers family revoke on replay", async () => {
  const db = await freshDb();
  const exp = NOW - 40 * DAY; // expired 40d ago, consumed, inside the horizon
  await addCode(db, "placeholder", exp, true, "fam_c");
  const code = "code_replay";
  await db.execute({ sql: "UPDATE oauth_codes SET code_hash = ? WHERE code_hash = 'placeholder'", args: [await sha256Hex(code)] });
  await addRefresh(db, "live_r", "fam_c", NOW + 2 * DAY);
  await runHousekeeping(db, NOW);
  expect(await count(db, "oauth_codes")).toBe(1);
  const res = await exchangeCode(db, { code, verifier: "v", clientId: "c", redirectUri: "u", now: NOW });
  expect(res).toMatchObject({ ok: false, replay: true, error: "invalid_grant" });
  expect((await db.execute("SELECT used_at FROM refresh_tokens WHERE token_hash = 'live_r'")).rows[0]!.used_at).not.toBeNull();
  expect(CODE_TTL).toBe(60);
});

test("batch loop: stops when a batch is short, and at the max-batches cap", async () => {
  const db = await freshDb();
  const old = NOW - 400 * DAY;
  for (let i = 1; i <= 7; i++) await addAudit(db, i, old);
  // cap: 2 batches x 3 rows = 6 deleted, 1 left
  let r = await runHousekeeping(db, NOW, { batchSize: 3, maxBatches: 2 });
  expect(r.deleted.audit_log).toBe(6);
  expect(await count(db, "audit_log")).toBe(1);
  // short batch ends the loop well before the cap
  const log: string[] = [];
  const spy: DbClient = { execute: (s) => (log.push(typeof s === "string" ? s : s.sql), db.execute(s)), batch: db.batch.bind(db) };
  r = await runHousekeeping(spy, NOW, { batchSize: 3, maxBatches: 20 });
  expect(r.deleted.audit_log).toBe(1);
  expect(log.filter((l) => l.startsWith("DELETE FROM audit_log"))).toHaveLength(1);
});

test("a table that throws does not stop the others", async () => {
  const db = await freshDb();
  await addTicket(db, "t_old", NOW - 10 * DAY);
  await addAudit(db, 1, NOW - 400 * DAY);
  const failing: DbClient = {
    execute: (s) => {
      if (typeof s !== "string" && s.sql.startsWith("DELETE FROM audit_log")) throw new Error("boom");
      return db.execute(s);
    },
    batch: db.batch.bind(db),
  };
  const r = await runHousekeeping(failing, NOW);
  expect(r.failed).toEqual(["audit_log"]);
  expect(r.deleted.login_tickets).toBe(1);
  expect(await count(db, "audit_log")).toBe(1);
});

test("a failing refresh_tokens/oauth_codes delete is recorded and the other tables still run", async () => {
  const db = await freshDb();
  await addAudit(db, 1, NOW - 400 * DAY);
  await addCode(db, "u_past", NOW - RETENTION_GRACE - 1, false);
  await addRefresh(db, "r_past", "f1", FAM_CUT - 1, { used: true });
  const failing: DbClient = {
    execute: (s) => {
      if (typeof s !== "string" && s.sql.startsWith("DELETE FROM refresh_tokens")) throw new Error("boom");
      return db.execute(s);
    },
    batch: db.batch.bind(db),
  };
  const r = await runHousekeeping(failing, NOW);
  expect(r.failed).toEqual(["refresh_tokens"]);
  expect(r.deleted.audit_log).toBe(1);
  expect(r.deleted.oauth_codes_unredeemed).toBe(1);
  expect(await count(db, "refresh_tokens")).toBe(1);
});

test("scheduledHousekeeping logs one counts-only line; swallows errors", async () => {
  const db = await freshDb();
  await addAudit(db, 1, NOW - 400 * DAY);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await scheduledHousekeeping({ getDb: () => db }, NOW);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toBe("housekeeping audit_log=1 login_tickets=0 sessions=0 access_tokens=0 refresh_tokens=0 oauth_codes_consumed=0 oauth_codes_unredeemed=0");
    await expect(scheduledHousekeeping({ getDb: () => { throw new Error("no db"); } }, NOW)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith("housekeeping_failed");
    const bad: DbClient = { execute: async () => { throw new Error("x"); }, batch: async () => [] };
    await scheduledHousekeeping({ getDb: () => bad }, NOW);
    expect(log.mock.calls[1]![0]).toContain("failed=audit_log,login_tickets,sessions,access_tokens,refresh_tokens,oauth_codes_consumed,oauth_codes_unredeemed");
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
});

test("default export scheduled() hands the sweep to ctx.waitUntil", async () => {
  const mod = (await import("../src/index")).default;
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waited.push(p) } as unknown as ExecutionContext;
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await mod.scheduled({} as ScheduledController, {} as never, ctx);
    expect(waited).toHaveLength(1);
    await expect(Promise.all(waited)).resolves.toBeDefined(); // never rejects
  } finally {
    err.mockRestore();
  }
});
