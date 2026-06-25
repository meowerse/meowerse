import { sha256Hex } from "./crypto";
import { randomId } from "./security";
import type { DbClient } from "./types";

/** Idle (sliding) and absolute session lifetimes, in seconds (spec §3, §7). */
export const IDLE_TTL = 14 * 24 * 3600;
export const ABSOLUTE_TTL = 30 * 24 * 3600;

export interface IssueInput {
  accountId: string;
  amr: string; // 'pwd' | 'tg'
  authTime: number;
  now: number;
}
export interface IssuedSession {
  rawId: string; // goes in the __Host-mw_sess cookie; never stored
  csrf: string;
  idHash: string;
}

/** Issue a session: a 256-bit opaque id (cookie) whose SHA-256 is the stored key. */
export async function issueSession(db: DbClient, input: IssueInput): Promise<IssuedSession> {
  const rawId = randomId(32);
  const idHash = await sha256Hex(rawId);
  const csrf = randomId(24);
  await db.execute({
    sql: `INSERT INTO sessions (id_hash, account_id, auth_time, amr, csrf_token, idle_expires_at, absolute_expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [idHash, input.accountId, input.authTime, input.amr, csrf, input.now + IDLE_TTL, input.now + ABSOLUTE_TTL],
  });
  return { rawId, csrf, idHash };
}

export interface SessionView {
  accountId: string;
  authTime: number;
  csrf: string;
  amr: string | null;
}

/**
 * Resolve a session cookie to its account. Returns null when the row is absent,
 * revoked, or past either expiry. On a hit, rolls the idle window forward.
 */
export async function lookupSession(db: DbClient, rawId: string | undefined, now: number): Promise<SessionView | null> {
  if (!rawId) return null;
  const idHash = await sha256Hex(rawId);
  const res = await db.execute({
    sql: `SELECT account_id, auth_time, csrf_token, amr, idle_expires_at, absolute_expires_at, revoked_at
          FROM sessions WHERE id_hash = ?`,
    args: [idHash],
  });
  const row = res.rows[0];
  if (!row) return null;
  if (row.revoked_at != null) return null;
  if (now > Number(row.idle_expires_at) || now > Number(row.absolute_expires_at)) return null;
  await db.execute({
    sql: "UPDATE sessions SET last_seen = datetime('now'), idle_expires_at = ? WHERE id_hash = ?",
    args: [now + IDLE_TTL, idHash],
  });
  return {
    accountId: String(row.account_id),
    authTime: Number(row.auth_time),
    csrf: String(row.csrf_token),
    amr: row.amr == null ? null : String(row.amr),
  };
}

/** Server-side revoke (logout) — a stolen cookie dies immediately. */
export async function revokeSession(db: DbClient, rawId: string): Promise<void> {
  const idHash = await sha256Hex(rawId);
  await db.execute({ sql: "UPDATE sessions SET revoked_at = datetime('now') WHERE id_hash = ?", args: [idHash] });
}

/**
 * Rotate the session id on every privilege transition (login, link, consent),
 * revoking the old row and issuing a fresh one for the same account. Returns
 * null if the old session is already gone (caller forces re-auth).
 */
export async function rotateSession(
  db: DbClient,
  oldRawId: string,
  input: { now: number; authTime?: number },
): Promise<IssuedSession | null> {
  const view = await lookupSession(db, oldRawId, input.now);
  if (!view) return null;
  await revokeSession(db, oldRawId);
  return issueSession(db, {
    accountId: view.accountId,
    amr: view.amr ?? "pwd",
    authTime: input.authTime ?? view.authTime,
    now: input.now,
  });
}
