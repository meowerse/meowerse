import { constantTimeEqual, internalConfirmString } from "@meowerse/auth-shared";
import { sha256Hex, hmacSha256Hex } from "./crypto";

export { internalConfirmString } from "@meowerse/auth-shared";
import { randomId } from "./security";
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
  await db.execute({
    sql: "INSERT INTO telegram_links (telegram_id, account_id, telegram_username, display_name, avatar_url) VALUES (?, ?, ?, ?, ?)",
    args: [tg.telegramId, accountId, tg.username, tg.displayName, tg.avatarUrl],
  });
  await db.execute({ sql: "UPDATE accounts SET verified = 1 WHERE id = ?", args: [accountId] });
  return { ok: true };
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

/** Load a ticket by id (for the owner-bound status poll). */
export async function getTicket(db: DbClient, ticketId: string): Promise<TicketRow | null> {
  const r = await db.execute({ sql: "SELECT * FROM login_tickets WHERE ticket_id = ?", args: [ticketId] });
  return r.rows[0] ? (r.rows[0] as unknown as TicketRow) : null;
}
