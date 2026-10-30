import { constantTimeEqual, internalConfirmString } from "@meowerse/auth-shared";
import { sha256Hex, hmacSha256Hex } from "./crypto";

export { internalConfirmString } from "@meowerse/auth-shared";
import { randomId } from "./security";
import { accountPresent } from "./codeguard";
import type { DbClient } from "./types";

const enc = new TextEncoder();

export interface TgUser {
  telegramId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/**
 * Verify a Telegram Login Widget payload (spec §6). The check string is the
 * sorted `key=value` lines (excluding `hash`) joined by \n; the HMAC key is the
 * RAW SHA-256 of the bot token. Rejects stale `auth_date` (>60s) to block replay.
 */
export async function verifyLoginWidget(
  data: Record<string, string>,
  botToken: string,
  now: number,
): Promise<{ ok: boolean; telegram?: TgUser }> {
  const hash = data.hash;
  if (!hash) return { ok: false };
  const dcs = Object.keys(data)
    .filter((k) => k !== "hash")
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join("\n");
  const secretKey = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(botToken)));
  const k = await crypto.subtle.importKey("raw", secretKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = toHex(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(dcs))));
  if (!constantTimeEqual(mac, hash)) return { ok: false };
  const authDate = Number(data.auth_date);
  if (!Number.isFinite(authDate) || Math.abs(now - authDate) > 60) return { ok: false };
  return { ok: true, telegram: tgUserFromWidget(data) };
}

function tgUserFromWidget(d: Record<string, string>): TgUser {
  const name = [d.first_name, d.last_name].filter(Boolean).join(" ") || null;
  return { telegramId: String(d.id), username: d.username ?? null, displayName: name, avatarUrl: d.photo_url ?? null };
}

/** Verify the HMAC-signed internal callback from the auth-bot worker (spec §6). */
export async function verifyInternalConfirm(
  body: Record<string, string>,
  signature: string,
  hmacKey: string,
  now: number,
): Promise<boolean> {
  const ts = Number(body.ts);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 120) return false;
  const expected = await hmacSha256Hex(
    hmacKey,
    internalConfirmString({
      nonce: body.nonce ?? "",
      telegramId: body.telegram_id ?? "",
      username: body.username ?? "",
      displayName: body.display_name ?? "",
      avatarUrl: body.avatar_url ?? "",
      ts: body.ts ?? "",
    }),
  );
  return constantTimeEqual(signature, expected);
}

/** Account currently linked to a Telegram id, or null. */
export async function findAccountByTelegram(db: DbClient, telegramId: string): Promise<string | null> {
  const r = await db.execute({ sql: "SELECT account_id FROM telegram_links WHERE telegram_id = ?", args: [telegramId] });
  return r.rows[0] ? String(r.rows[0].account_id) : null;
}

/**
 * "Continue with Telegram": resolve to the existing account for this Telegram id
 * (refreshing its metadata), or create a fresh verified account if none exists.
 */
export async function signInOrSignUpTelegram(db: DbClient, tg: TgUser): Promise<{ accountId: string; created: boolean }> {
  const existing = await findAccountByTelegram(db, tg.telegramId);
  if (existing) {
    await db.execute({
      sql: "UPDATE telegram_links SET telegram_username = ?, display_name = ?, avatar_url = ?, updated_at = datetime('now') WHERE telegram_id = ?",
      args: [tg.username, tg.displayName, tg.avatarUrl, tg.telegramId],
    });
    return { accountId: existing, created: false };
  }
  const accountId = "acct_" + randomId(16);
  await db.execute({
    sql: "INSERT INTO accounts (id, username, display_name, avatar_url, verified) VALUES (?, NULL, ?, ?, 1)",
    args: [accountId, tg.displayName, tg.avatarUrl],
  });
  await db.execute({
    sql: "INSERT INTO telegram_links (telegram_id, account_id, telegram_username, display_name, avatar_url) VALUES (?, ?, ?, ?, ?)",
    args: [tg.telegramId, accountId, tg.username, tg.displayName, tg.avatarUrl],
  });
  return { accountId, created: true };
}

/** Link a Telegram id to an EXISTING account (verify-upgrade). Refuses a silent remap. */
export async function linkTelegramToAccount(
  db: DbClient,
  accountId: string,
  tg: TgUser,
): Promise<{ ok: boolean; error?: string }> {
  const existing = await findAccountByTelegram(db, tg.telegramId);
  if (existing && existing !== accountId) return { ok: false, error: "linked_elsewhere" };
  if (existing === accountId) return { ok: true };
  // Conditional on the account still existing (inside the statement): a link row for a deleted
  // account would make later Telegram logins resolve to the deleted account id.
  const exists = accountPresent(accountId);
  const res = await db.execute({
    sql: `INSERT INTO telegram_links (telegram_id, account_id, telegram_username, display_name, avatar_url)
          SELECT ?, ?, ?, ?, ? WHERE ${exists.sql}`,
    args: [tg.telegramId, accountId, tg.username, tg.displayName, tg.avatarUrl, ...exists.args],
  });
  if ((res.rowsAffected ?? 0) !== 1) return { ok: false, error: "account_gone" };
  await db.execute({ sql: "UPDATE accounts SET verified = 1 WHERE id = ?", args: [accountId] });
  return { ok: true };
}

export type ConfirmResult =
  | { ok: true; accountId: string; created: boolean }
  | { ok: false; error: "already_consumed" | "linked_elsewhere" | "account_gone" | "invalid_ticket" };

/** Aborts the whole write batch when the immediately preceding statement changed no row (audit_log.event is NOT NULL). */
const ABORT_IF_NO_CHANGE: { sql: string; args: unknown[] } = { sql: "INSERT INTO audit_log (event) SELECT NULL WHERE changes() = 0", args: [] };

/**
 * Bot confirmation of a pending Telegram ticket: claim the ticket AND write the link/account in ONE write
 * transaction. The claim is the first statement and a `changes() = 0` guard aborts the batch right after it,
 * so a confirmation that lost the race (or hit an expired/consumed ticket) writes nothing at all, and a link
 * that cannot be written (telegram id taken, account gone) rolls the claim back so the user can retry.
 */
export async function confirmTicketWithTelegram(
  db: DbClient,
  ticket: { ticket_id: string; kind: TicketKind; account_id: string | null },
  tg: TgUser,
  now: number,
): Promise<ConfirmResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const claim = (accountId: string) => [
      {
        // Same expiry semantics as findPendingTicketByNonce (expired = expires_at < now).
        sql: "UPDATE login_tickets SET status = 'consumed', account_id = ? WHERE ticket_id = ? AND status = 'pending' AND expires_at >= ?",
        args: [accountId, ticket.ticket_id, now],
      },
      ABORT_IF_NO_CHANGE,
    ];
    const existing = await findAccountByTelegram(db, tg.telegramId);
    let accountId: string;
    let created = false;
    let stmts: { sql: string; args: unknown[] }[];
    if (ticket.kind === "VERIFY_EXISTING") {
      if (!ticket.account_id) return { ok: false, error: "invalid_ticket" };
      accountId = ticket.account_id;
      if (existing && existing !== accountId) return { ok: false, error: "linked_elsewhere" };
      stmts = claim(accountId);
      if (!existing) {
        // Conditional on the account still existing (inside the statement): a link row for a deleted
        // account would make later Telegram logins resolve to the deleted account id.
        const exists = accountPresent(accountId);
        stmts.push(
          {
            sql: `INSERT INTO telegram_links (telegram_id, account_id, telegram_username, display_name, avatar_url)
                  SELECT ?, ?, ?, ?, ? WHERE ${exists.sql}`,
            args: [tg.telegramId, accountId, tg.username, tg.displayName, tg.avatarUrl, ...exists.args],
          },
          ABORT_IF_NO_CHANGE,
          { sql: "UPDATE accounts SET verified = 1 WHERE id = ?", args: [accountId] },
        );
      }
    } else if (existing) {
      accountId = existing;
      stmts = [
        ...claim(accountId),
        {
          sql: "UPDATE telegram_links SET telegram_username = ?, display_name = ?, avatar_url = ?, updated_at = datetime('now') WHERE telegram_id = ?",
          args: [tg.username, tg.displayName, tg.avatarUrl, tg.telegramId],
        },
      ];
    } else {
      accountId = "acct_" + randomId(16);
      created = true;
      stmts = [
        ...claim(accountId),
        {
          sql: "INSERT INTO accounts (id, username, display_name, avatar_url, verified) VALUES (?, NULL, ?, ?, 1)",
          args: [accountId, tg.displayName, tg.avatarUrl],
        },
        {
          sql: "INSERT INTO telegram_links (telegram_id, account_id, telegram_username, display_name, avatar_url) VALUES (?, ?, ?, ?, ?)",
          args: [tg.telegramId, accountId, tg.username, tg.displayName, tg.avatarUrl],
        },
      ];
    }
    try {
      await db.batch(stmts, "write");
      return { ok: true, accountId, created };
    } catch (err) {
      // Nothing was written (one transaction). Say why, from fresh reads.
      const t = await getTicket(db, ticket.ticket_id);
      if (!t || t.status !== "pending") return { ok: false, error: "already_consumed" };
      if (Number((t as unknown as { expires_at: number }).expires_at) < now) return { ok: false, error: "invalid_ticket" };
      const linked = await findAccountByTelegram(db, tg.telegramId);
      if (ticket.kind === "VERIFY_EXISTING") {
        if (linked && linked !== ticket.account_id) return { ok: false, error: "linked_elsewhere" };
        const a = await db.execute({ sql: "SELECT 1 FROM accounts WHERE id = ?", args: [ticket.account_id] });
        if (a.rows.length === 0) return { ok: false, error: "account_gone" };
      } else if (linked && attempt === 0) {
        continue; // a concurrent sign-up linked this Telegram id first: retry as a plain sign-in
      }
      throw err;
    }
  }
  throw new Error("tg confirm: unreachable");
}

export const TICKET_TTL = 300;
export type TicketKind = "SIGNIN_OR_SIGNUP" | "VERIFY_EXISTING" | "RESET_APPROVAL";

/** Mint a Telegram login ticket bound to the originating browser (owner_hash). */
export async function createTicket(
  db: DbClient,
  i: { kind: TicketKind; ownerHash: string; accountId?: string | null; rid?: string | null; now: number },
): Promise<{ ticketId: string; nonce: string }> {
  const ticketId = "tkt_" + randomId(16);
  const nonce = randomId(24); // base64url, well under Telegram's 64-char start-param cap
  await db.execute({
    sql: "INSERT INTO login_tickets (ticket_id, nonce_hash, owner_hash, kind, account_id, rid, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [ticketId, await sha256Hex(nonce), i.ownerHash, i.kind, i.accountId ?? null, i.rid ?? null, i.now + TICKET_TTL],
  });
  return { ticketId, nonce };
}

export interface TicketRow {
  ticket_id: string;
  kind: TicketKind;
  status: string;
  account_id: string | null;
  rid: string | null;
  owner_hash: string;
}

/** Load a pending, unexpired ticket by its deep-link nonce. */
export async function findPendingTicketByNonce(db: DbClient, nonce: string, now: number): Promise<TicketRow | null> {
  const r = await db.execute({ sql: "SELECT * FROM login_tickets WHERE nonce_hash = ?", args: [await sha256Hex(nonce)] });
  const row = r.rows[0];
  if (!row || row.status !== "pending" || Number(row.expires_at) < now) return null;
  return row as unknown as TicketRow;
}

/** Atomically mark a ticket consumed, recording the resolved account. Returns true if this call won the race. */
export async function consumeTicket(db: DbClient, ticketId: string, accountId: string): Promise<boolean> {
  const upd = await db.execute({
    sql: "UPDATE login_tickets SET status = 'consumed', account_id = ? WHERE ticket_id = ? AND status = 'pending'",
    args: [accountId, ticketId],
  });
  return (upd.rowsAffected ?? 0) === 1;
}

/**
 * Seconds past `expires_at` a consumed ticket may still be claimed. It only absorbs clock/latency skew: the
 * owner cookie and the UI poll both end at TICKET_TTL, so it does not extend the user's 5-minute window.
 */
export const TICKET_CLAIM_GRACE = 60;

/**
 * One-time claim of a consumed ticket: `consumed` → `claimed`. A ticket yields at most ONE session, and only
 * while fresh (`expires_at` + grace). The conditional UPDATE is atomic, so concurrent polls can't both win.
 */
export async function claimTicket(db: DbClient, ticketId: string, now: number): Promise<boolean> {
  const upd = await db.execute({
    sql: "UPDATE login_tickets SET status = 'claimed' WHERE ticket_id = ? AND status = 'consumed' AND expires_at >= ?",
    args: [ticketId, now - TICKET_CLAIM_GRACE],
  });
  return (upd.rowsAffected ?? 0) === 1;
}

/** Undo a claim when the session could not be issued, so the browser's next poll can retry. */
export async function unclaimTicket(db: DbClient, ticketId: string): Promise<void> {
  await db.execute({ sql: "UPDATE login_tickets SET status = 'consumed' WHERE ticket_id = ? AND status = 'claimed'", args: [ticketId] });
}

/** Load a ticket by id (for the owner-bound status poll). */
export async function getTicket(db: DbClient, ticketId: string): Promise<TicketRow | null> {
  const r = await db.execute({ sql: "SELECT * FROM login_tickets WHERE ticket_id = ?", args: [ticketId] });
  return r.rows[0] ? (r.rows[0] as unknown as TicketRow) : null;
}

/** Telegram link status for the account page (spec R14). */
export async function getTelegramLink(db: DbClient, accountId: string): Promise<{ linked: boolean; username: string | null }> {
  const r = await db.execute({ sql: "SELECT telegram_username FROM telegram_links WHERE account_id = ?", args: [accountId] });
  const row = r.rows[0];
  return row ? { linked: true, username: row.telegram_username == null ? null : String(row.telegram_username) } : { linked: false, username: null };
}

/** Unlink Telegram: removes verified status and bumps identity_epoch so any armed silent grant can't fire (§10/#9). */
export async function unlinkTelegram(db: DbClient, accountId: string): Promise<void> {
  await db.execute({ sql: "DELETE FROM telegram_links WHERE account_id = ?", args: [accountId] });
  await db.execute({ sql: "UPDATE accounts SET verified = 0, identity_epoch = identity_epoch + 1 WHERE id = ?", args: [accountId] });
}
