import { test, expect } from "vitest";
import { createClient } from "@libsql/client";
import { SCHEMA, SEED } from "../src/db";
import { handle } from "../src/index";
import { hmacSha256Hex } from "../src/crypto";
import { createTicket, internalConfirmString } from "../src/telegram";
import { genSigningKeys } from "./helpers";
import type { DbClient } from "../src/types";

// /internal/tg/confirm: the ticket claim and the link/account write are ONE write transaction, so a
// confirmation that loses a race (duplicate delivery / bot retry) or hits an unusable ticket writes nothing.
// Real libSQL (in-memory), so the changes()=0 abort guard and rollback run for real.

const NOW = 1000;

async function setup() {
  const db = createClient({ url: ":memory:" }) as unknown as DbClient;
  for (const stmt of [...SCHEMA, ...SEED]) await db.execute(stmt);
  await db.execute("PRAGMA foreign_keys = ON");
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(await genSigningKeys()), ISSUER: "https://iss", WEB_ORIGIN: "https://web", CORS_ORIGINS: "https://web", STATE_SECRET: "s", INTERNAL_HMAC_KEY: "ikey" };
  // `beforeBatch` runs once, right BEFORE the next db.batch starts (the "other confirmation slips in first" interleaving).
  let beforeBatch: (() => Promise<void>) | null = null;
  const wrapped: DbClient = {
    execute: (s) => db.execute(s),
    batch: async (stmts, mode) => {
      if (beforeBatch) {
        const h = beforeBatch;
        beforeBatch = null;
        await h();
      }
      return db.batch(stmts, mode);
    },
  };
  const deps = { getDb: () => wrapped, clock: () => NOW };
  const confirm = async (nonce: string, tgId: string, username = "u") => {
    const body = { nonce, telegram_id: tgId, username, display_name: "U", avatar_url: "", ts: "1000" };
    const sig = await hmacSha256Hex("ikey", internalConfirmString({ nonce, telegramId: tgId, username, displayName: "U", avatarUrl: "", ts: "1000" }));
    return handle(new Request("https://iss/internal/tg/confirm", { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": sig }, body: JSON.stringify(body) }), env as never, deps as never);
  };
  const q = async (sql: string, args: unknown[] = []) => (await db.execute({ sql, args })).rows;
  const n = async (table: string) => Number((await q(`SELECT count(*) AS n FROM ${table}`))[0]!.n);
  const account = async (id: string) => db.execute({ sql: "INSERT INTO accounts (id, username, verified) VALUES (?, ?, 0)", args: [id, id] });
  const ticket = (kind: "VERIFY_EXISTING" | "SIGNIN_OR_SIGNUP", accountId: string | null = null, now = NOW) =>
    createTicket(db, { kind, ownerHash: "oh", accountId, now });
  const status = async (ticketId: string) => (await q("SELECT status, account_id FROM login_tickets WHERE ticket_id = ?", [ticketId]))[0]!;
  const setBefore = (fn: () => Promise<void>) => { beforeBatch = fn; };
  return { db, confirm, q, n, account, ticket, status, setBefore };
}

test("normal VERIFY_EXISTING: one link, account verified, ticket consumed with the account id", async () => {
  const f = await setup();
  await f.account("acct_v");
  const t = await f.ticket("VERIFY_EXISTING", "acct_v");
  expect((await f.confirm(t.nonce, "55")).status).toBe(200);
  expect(await f.q("SELECT account_id FROM telegram_links WHERE telegram_id = 55")).toEqual([{ account_id: "acct_v" }]);
  expect((await f.q("SELECT verified FROM accounts WHERE id = 'acct_v'"))[0]!.verified).toBe(1);
  expect(await f.status(t.ticketId)).toMatchObject({ status: "consumed", account_id: "acct_v" });
  expect(await f.n("audit_log")).toBe(1); // telegram.link only; the guard statement writes nothing
});

test("overlapping confirms, VERIFY_EXISTING: exactly one link; the loser gets 409 already_consumed and writes nothing", async () => {
  const f = await setup();
  await f.account("acct_v");
  const t = await f.ticket("VERIFY_EXISTING", "acct_v");
  let second: Response | undefined;
  // Request 1 has read the pending ticket; request 2 (a different Telegram id) completes before request 1's batch.
  f.setBefore(async () => { second = await f.confirm(t.nonce, "777"); });
  const first = await f.confirm(t.nonce, "55");
  expect(second!.status).toBe(200);
  expect(first.status).toBe(409);
  expect(await first.json()).toEqual({ error: "already_consumed" });
  expect(await f.q("SELECT telegram_id, account_id FROM telegram_links")).toEqual([{ telegram_id: 777, account_id: "acct_v" }]);
  expect(await f.n("audit_log")).toBe(1);
});

test("overlapping confirms, SIGNIN_OR_SIGNUP creating an account: exactly one new account and one link", async () => {
  const f = await setup();
  const before = await f.n("accounts");
  const t = await f.ticket("SIGNIN_OR_SIGNUP");
  let second: Response | undefined;
  f.setBefore(async () => { second = await f.confirm(t.nonce, "888"); });
  const first = await f.confirm(t.nonce, "999");
  expect(second!.status).toBe(200);
  expect(first.status).toBe(409);
  expect(await f.n("accounts")).toBe(before + 1);
  expect(await f.q("SELECT telegram_id FROM telegram_links")).toEqual([{ telegram_id: 888 }]);
  expect(await f.n("audit_log")).toBe(1); // signup only
});

test("overlapping duplicate delivery for the SAME telegram id: one account, one link, loser 409", async () => {
  const f = await setup();
  const before = await f.n("accounts");
  const t = await f.ticket("SIGNIN_OR_SIGNUP");
  let second: Response | undefined;
  f.setBefore(async () => { second = await f.confirm(t.nonce, "999"); });
  const first = await f.confirm(t.nonce, "999");
  expect(second!.status).toBe(200);
  expect(first.status).toBe(409);
  expect(await f.n("accounts")).toBe(before + 1);
  expect(await f.n("telegram_links")).toBe(1);
});

test("SIGNIN_OR_SIGNUP with an existing link: claims atomically, no new account, metadata refreshed", async () => {
  const f = await setup();
  await f.account("acct_e");
  await f.db.execute({ sql: "INSERT INTO telegram_links (telegram_id, account_id, telegram_username) VALUES (31, 'acct_e', 'old')", args: [] });
  const before = await f.n("accounts");
  const t = await f.ticket("SIGNIN_OR_SIGNUP");
  expect((await f.confirm(t.nonce, "31", "fresh")).status).toBe(200);
  expect(await f.n("accounts")).toBe(before);
  expect(await f.status(t.ticketId)).toMatchObject({ status: "consumed", account_id: "acct_e" });
  expect((await f.q("SELECT telegram_username FROM telegram_links WHERE telegram_id = 31"))[0]!.telegram_username).toBe("fresh");
  expect(await f.n("audit_log")).toBe(0); // sign-in only: telegram.login is recorded at /tg/status
});

test("existing-link sign-in losing the race refreshes nothing and 409s", async () => {
  const f = await setup();
  await f.account("acct_e");
  await f.db.execute({ sql: "INSERT INTO telegram_links (telegram_id, account_id, telegram_username) VALUES (31, 'acct_e', 'old')", args: [] });
  const t = await f.ticket("SIGNIN_OR_SIGNUP");
  f.setBefore(async () => { expect((await f.confirm(t.nonce, "31", "second")).status).toBe(200); });
  const first = await f.confirm(t.nonce, "31", "loser");
  expect(first.status).toBe(409);
  expect((await f.q("SELECT telegram_username FROM telegram_links WHERE telegram_id = 31"))[0]!.telegram_username).toBe("second");
});

test("expired ticket: nothing written (expiry re-checked inside the claim)", async () => {
  const f = await setup();
  await f.account("acct_v");
  const t = await f.ticket("VERIFY_EXISTING", "acct_v");
  // The ticket was pending when request 1 read it, then it expires before its batch runs.
  await f.db.execute({ sql: "UPDATE login_tickets SET expires_at = ? WHERE ticket_id = ?", args: [NOW - 1, t.ticketId] });
  // Bypass the handler's own pending/expiry read to hit the batch directly.
  const { confirmTicketWithTelegram } = await import("../src/telegram");
  const r = await confirmTicketWithTelegram(f.db, { ticket_id: t.ticketId, kind: "VERIFY_EXISTING", account_id: "acct_v" }, { telegramId: "55", username: null, displayName: null, avatarUrl: null }, NOW);
  expect(r).toEqual({ ok: false, error: "invalid_ticket" });
  expect(await f.n("telegram_links")).toBe(0);
  expect(await f.status(t.ticketId)).toMatchObject({ status: "pending" });
  // And through the handler an expired ticket is simply invalid.
  expect((await f.confirm(t.nonce, "55")).status).toBe(400);
});

test("telegram id already linked to another account: 409, ticket stays pending and the link is unchanged (retry possible)", async () => {
  const f = await setup();
  await f.account("acct_v");
  await f.account("acct_other");
  await f.db.execute({ sql: "INSERT INTO telegram_links (telegram_id, account_id) VALUES (55, 'acct_other')", args: [] });
  const t = await f.ticket("VERIFY_EXISTING", "acct_v");
  const r = await f.confirm(t.nonce, "55");
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: "linked_elsewhere" });
  expect(await f.status(t.ticketId)).toMatchObject({ status: "pending" });
  expect(await f.q("SELECT account_id FROM telegram_links")).toEqual([{ account_id: "acct_other" }]);
  // The user retries with a different Telegram account on the same ticket.
  expect((await f.confirm(t.nonce, "56")).status).toBe(200);
  expect(await f.q("SELECT account_id FROM telegram_links WHERE telegram_id = 56")).toEqual([{ account_id: "acct_v" }]);
});

test("telegram id taken by a concurrent link between the read and the batch: claim rolls back, 409 linked_elsewhere, ticket still pending", async () => {
  const f = await setup();
  await f.account("acct_v");
  await f.account("acct_other");
  const t = await f.ticket("VERIFY_EXISTING", "acct_v");
  f.setBefore(async () => { await f.db.execute({ sql: "INSERT INTO telegram_links (telegram_id, account_id) VALUES (55, 'acct_other')", args: [] }); });
  const r = await f.confirm(t.nonce, "55");
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: "linked_elsewhere" });
  expect(await f.status(t.ticketId)).toMatchObject({ status: "pending" });
  expect(await f.n("audit_log")).toBe(0);
  expect((await f.q("SELECT verified FROM accounts WHERE id = 'acct_v'"))[0]!.verified).toBe(0);
});

test("account deleted between the read and the batch: 409 account_gone, claim rolled back, no link", async () => {
  const f = await setup();
  await f.account("acct_v");
  const t = await f.ticket("VERIFY_EXISTING", "acct_v");
  f.setBefore(async () => { await f.db.execute("DELETE FROM accounts WHERE id = 'acct_v'"); });
  const r = await f.confirm(t.nonce, "55");
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: "account_gone" });
  expect(await f.n("telegram_links")).toBe(0);
  expect(await f.status(t.ticketId)).toMatchObject({ status: "pending" });
});

test("concurrent sign-up with a DIFFERENT ticket linking the same Telegram id first: retries as sign-in, no duplicate account", async () => {
  const f = await setup();
  const t1 = await f.ticket("SIGNIN_OR_SIGNUP");
  const t2 = await f.ticket("SIGNIN_OR_SIGNUP");
  let other: Response | undefined;
  f.setBefore(async () => { other = await f.confirm(t2.nonce, "999"); });
  const before = await f.n("accounts");
  const r = await f.confirm(t1.nonce, "999");
  expect(other!.status).toBe(200);
  expect(r.status).toBe(200);
  expect(await f.n("accounts")).toBe(before + 1);
  expect(await f.n("telegram_links")).toBe(1);
  const s1 = await f.status(t1.ticketId);
  const s2 = await f.status(t2.ticketId);
  expect(s1.account_id).toBe(s2.account_id);
});

test("overlapping confirms, VERIFY_EXISTING, winner's link removed meanwhile (unlink): the loser must NOT re-create a link on a consumed ticket", async () => {
  const f = await setup();
  await f.account("acct_v");
  const t = await f.ticket("VERIFY_EXISTING", "acct_v");
  f.setBefore(async () => {
    expect((await f.confirm(t.nonce, "777")).status).toBe(200);
    await f.db.execute("DELETE FROM telegram_links WHERE account_id = 'acct_v'"); // user unlinks; nothing but the claim guard stops the loser now
  });
  const first = await f.confirm(t.nonce, "55");
  expect(first.status).toBe(409);
  expect(await f.n("telegram_links")).toBe(0);
});
