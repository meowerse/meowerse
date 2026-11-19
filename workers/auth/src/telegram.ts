import { constantTimeEqual, internalConfirmString, internalDescribeString, internalCancelString } from "@meowerse/auth-shared";
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

const INTERNAL_TS_WINDOW = 120;

/** Verify the HMAC-signed internal callback from the auth-bot worker (spec §6). */
export async function verifyInternalConfirm(
  body: Record<string, string>,
  signature: string,
  hmacKey: string,
  now: number,
): Promise<boolean> {
  const ts = Number(body.ts);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > INTERNAL_TS_WINDOW) return false;
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

/** Verify the bot's signed `describe` / `cancel` call (same key and ts window as confirm; domain-separated string). */
export async function verifyInternalAction(
  action: "describe" | "cancel",
  body: Record<string, string>,
  signature: string,
  hmacKey: string,
  now: number,
): Promise<boolean> {
  const ts = Number(body.ts);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > INTERNAL_TS_WINDOW) return false;
  const f = { nonce: body.nonce ?? "", telegramId: body.telegram_id ?? "", ts: body.ts ?? "" };
  const expected = await hmacSha256Hex(hmacKey, action === "describe" ? internalDescribeString(f) : internalCancelString(f));
  return constantTimeEqual(signature, expected);
}

/** Coarse browser/OS family from a User-Agent: deliberately imprecise (shown to the Telegram user, never stored raw). */
export function coarseUserAgent(ua: string | null): { browser: string; os: string } {
  const u = ua ?? "";
  const browser = /Edg\//.test(u) ? "Edge" : /OPR\/|Opera/.test(u) ? "Opera" : /Firefox\//.test(u) ? "Firefox" : /Chrome\/|CriOS/.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : "an unknown browser";
  const os = /Android/.test(u) ? "Android" : /iPhone|iPad|iPod/.test(u) ? "iOS" : /Windows/.test(u) ? "Windows" : /Mac OS X|Macintosh/.test(u) ? "macOS" : /Linux|X11/.test(u) ? "Linux" : "an unknown OS";
  return { browser, os };
}

export const CODE_MAX_ATTEMPTS = 5;

/** 8-digit one-time code from the CSPRNG (rejection sampling: no modulo bias). */
export function generateTgCode(): string {
  const limit = 4_294_967_296 - (4_294_967_296 % 100_000_000);
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return String(buf[0]! % 100_000_000).padStart(8, "0");
  }
}

/** Keyed hash of the code (bound to the ticket): the DB only ever holds this, and an 8-digit code is not brute-forceable offline without the key. */
export function tgCodeHash(hmacKey: string, ticketId: string, code: string): Promise<string> {
  return hmacSha256Hex(hmacKey, `tg-code|${ticketId}|${code}`);
}

/** Normalise user input ("1234 5678", "1234-5678") to the 8 digits, or null. */
export function normaliseTgCode(raw: string): string | null {
  const d = raw.replace(/[\s-]/g, "");
  return /^\d{8}$/.test(d) ? d : null;
}

export interface TicketContext {
  ticket_id: string;
  country: string | null;
  browser: string | null;
  os: string | null;
  created_at: number;
  code_hash: string | null;
  attempts: number;
  tg_id: string | null;
  tg_username: string | null;
  tg_display: string | null;
}

export async function saveTicketContext(
  db: DbClient,
  i: { ticketId: string; country: string | null; browser: string; os: string; now: number },
): Promise<void> {
  await db.execute({
    sql: "INSERT INTO login_ticket_ctx (ticket_id, country, browser, os, created_at, attempts) VALUES (?, ?, ?, ?, ?, 0)",
    args: [i.ticketId, i.country, i.browser, i.os, i.now],
  });
}

export async function getTicketContext(db: DbClient, ticketId: string): Promise<TicketContext | null> {
  const r = await db.execute({ sql: "SELECT * FROM login_ticket_ctx WHERE ticket_id = ?", args: [ticketId] });
  return r.rows[0] ? (r.rows[0] as unknown as TicketContext) : null;
}

/**
 * Store the code HASH + the confirming Telegram identity, once. The statement itself requires the ticket to be
 * still pending/unexpired and no code issued yet, so a second confirm (or one racing a cancel/burn) changes nothing.
 */
export async function issueTicketCode(
  db: DbClient,
  ticketId: string,
  codeHash: string,
  tg: TgUser,
  now: number,
): Promise<boolean> {
  const r = await db.execute({
    sql: `UPDATE login_ticket_ctx SET code_hash = ?, tg_id = ?, tg_username = ?, tg_display = ?
          WHERE ticket_id = ? AND code_hash IS NULL
          AND EXISTS (SELECT 1 FROM login_tickets WHERE ticket_id = ? AND status = 'pending' AND expires_at >= ?)`,
    args: [codeHash, tg.telegramId, tg.username, tg.displayName, ticketId, ticketId, now],
  });
  return (r.rowsAffected ?? 0) === 1;
}

/** Atomically spend one code attempt; false once the budget is exhausted (or no code was issued). */
export async function spendCodeAttempt(db: DbClient, ticketId: string): Promise<boolean> {
  const r = await db.execute({
    sql: "UPDATE login_ticket_ctx SET attempts = attempts + 1 WHERE ticket_id = ? AND code_hash IS NOT NULL AND attempts < ?",
    args: [ticketId, CODE_MAX_ATTEMPTS],
  });
  return (r.rowsAffected ?? 0) === 1;
}

/**
 * Burn a still-pending ticket (cancel / too many wrong codes) and drop the stored Telegram identity.
 * With `onlyTgId` the burn is atomically refused once a code was issued to a DIFFERENT Telegram user.
 * Returns whether THIS call burned it; a refused/lost burn leaves the ticket (and its identity) untouched.
 */
export async function burnTicket(db: DbClient, ticketId: string, onlyTgId?: string): Promise<boolean> {
  const guard = onlyTgId === undefined ? { sql: "", args: [] as string[] } : {
    sql: " AND NOT EXISTS (SELECT 1 FROM login_ticket_ctx WHERE ticket_id = ? AND code_hash IS NOT NULL AND tg_id IS NOT ?)",
    args: [ticketId, onlyTgId],
  };
  const r = await db.execute({ sql: `UPDATE login_tickets SET status = 'burned' WHERE ticket_id = ? AND status = 'pending'${guard.sql}`, args: [ticketId, ...guard.args] });
  const burned = (r.rowsAffected ?? 0) === 1;
  if (burned) await clearTicketIdentity(db, ticketId);
  return burned;
}

export async function clearTicketIdentity(db: DbClient, ticketId: string): Promise<void> {
  await db.execute({ sql: "UPDATE login_ticket_ctx SET tg_id = NULL, tg_username = NULL, tg_display = NULL WHERE ticket_id = ?", args: [ticketId] });
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
  | { ok: false; error: "already_consumed" | "linked_elsewhere" | "already_linked" | "account_gone" | "invalid_ticket" };

/** True when the account already has a Telegram link for a DIFFERENT Telegram id. */
async function hasOtherTelegram(db: DbClient, accountId: string, telegramId: string): Promise<boolean> {
  const r = await db.execute({ sql: "SELECT telegram_id FROM telegram_links WHERE account_id = ?", args: [accountId] });
  return r.rows.length > 0 && String(r.rows[0]!.telegram_id) !== telegramId;
}

/** Aborts the whole write batch when the immediately preceding statement changed no row (audit_log.event is NOT NULL). */
const ABORT_IF_NO_CHANGE: { sql: string; args: unknown[] } = { sql: "INSERT INTO audit_log (event) SELECT NULL WHERE changes() = 0", args: [] };

/** Aborts the whole write batch unless the (telegram_id, account_id) link exists right now. */
const abortUnlessLinked = (telegramId: string, accountId: string): { sql: string; args: unknown[] } => ({
  sql: "INSERT INTO audit_log (event) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM telegram_links WHERE telegram_id = ? AND account_id = ?)",
  args: [telegramId, accountId],
});

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
        // One Telegram per account (telegram_links.account_id is UNIQUE): refuse a different one cleanly.
        if (await hasOtherTelegram(db, accountId, tg.telegramId)) return { ok: false, error: "already_linked" };
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
      } else {
        // Already linked to this very account: the link must still exist when the claim commits
        // (it may have been removed by an unlink or account deletion since the read).
        stmts.push(abortUnlessLinked(tg.telegramId, accountId));
      }
    } else if (existing) {
      accountId = existing;
      stmts = [
        ...claim(accountId),
        {
          // Account-scoped + guarded: if the link is gone or moved since the read, abort (claim included).
          sql: "UPDATE telegram_links SET telegram_username = ?, display_name = ?, avatar_url = ?, updated_at = datetime('now') WHERE telegram_id = ? AND account_id = ?",
          args: [tg.username, tg.displayName, tg.avatarUrl, tg.telegramId, accountId],
        },
        ABORT_IF_NO_CHANGE,
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
      if (Number(t.expires_at) < now) return { ok: false, error: "invalid_ticket" };
      const linked = await findAccountByTelegram(db, tg.telegramId);
      if (ticket.kind === "VERIFY_EXISTING") {
        if (linked && linked !== ticket.account_id) return { ok: false, error: "linked_elsewhere" };
        const a = await db.execute({ sql: "SELECT 1 FROM accounts WHERE id = ?", args: [ticket.account_id] });
        if (a.rows.length === 0) return { ok: false, error: "account_gone" };
        if (!linked && (await hasOtherTelegram(db, ticket.account_id!, tg.telegramId))) return { ok: false, error: "already_linked" };
      }
      // The link state changed under the batch (concurrent sign-up / same-account verify linked it, or it was
      // unlinked / moved): re-read and retry once against the new state.
      if (linked !== existing && attempt === 0) continue;
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
  expires_at: number;
}

/** Load a pending, unexpired ticket by its deep-link nonce. */
export async function findPendingTicketByNonce(db: DbClient, nonce: string, now: number): Promise<TicketRow | null> {
  const r = await db.execute({ sql: "SELECT * FROM login_tickets WHERE nonce_hash = ?", args: [await sha256Hex(nonce)] });
  const row = r.rows[0];
  if (!row || row.status !== "pending" || Number(row.expires_at) < now) return null;
  return row as unknown as TicketRow;
}

/** Load a ticket by its deep-link nonce regardless of status/expiry (cancel needs to tell "already used" from "unknown"). */
export async function findTicketByNonce(db: DbClient, nonce: string): Promise<TicketRow | null> {
  const r = await db.execute({ sql: "SELECT * FROM login_tickets WHERE nonce_hash = ?", args: [await sha256Hex(nonce)] });
  return r.rows[0] ? (r.rows[0] as unknown as TicketRow) : null;
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
