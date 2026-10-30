import { test, expect, vi } from "vitest";
import { createClient } from "@libsql/client";
import { SCHEMA } from "../src/db";
import { runHousekeeping, scheduledHousekeeping, HOUSEKEEPING_MARGIN } from "../src/housekeeping";
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

test("refresh_tokens and oauth_codes are never touched (reuse/replay detection)", async () => {
  const db = await freshDb();
  await db.execute({ sql: "INSERT INTO refresh_tokens (token_hash, family_id, client_id, account_id, scope, used_at, idle_expires_at, absolute_expires_at) VALUES ('r','f','c','a','s','2020-01-01',1,1)", args: [] });
  await db.execute({ sql: "INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, scope, code_challenge, code_challenge_method, account_id, session_id_hash, auth_time, jti_family, expires_at, consumed_at) VALUES ('c','c','u','s','ch','S256','a','s',0,'f',1,'2020-01-01')", args: [] });
  await runHousekeeping(db, NOW);
  expect(await count(db, "refresh_tokens")).toBe(1);
  expect(await count(db, "oauth_codes")).toBe(1);
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

test("scheduledHousekeeping logs one counts-only line; swallows errors", async () => {
  const db = await freshDb();
  await addAudit(db, 1, NOW - 400 * DAY);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await scheduledHousekeeping({ getDb: () => db }, NOW);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toBe("housekeeping audit_log=1 login_tickets=0 sessions=0 access_tokens=0");
    await expect(scheduledHousekeeping({ getDb: () => { throw new Error("no db"); } }, NOW)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith("housekeeping_failed");
    const bad: DbClient = { execute: async () => { throw new Error("x"); }, batch: async () => [] };
    await scheduledHousekeeping({ getDb: () => bad }, NOW);
    expect(log.mock.calls[1]![0]).toContain("failed=audit_log,login_tickets,sessions,access_tokens");
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
