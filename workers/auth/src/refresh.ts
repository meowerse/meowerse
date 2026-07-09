import { sha256Hex } from "./crypto";
import { randomId } from "./security";
import type { DbClient } from "./types";

/** Refresh-token lifetimes (spec §3): 14d idle / 30d absolute, sliding. */
export const REFRESH_IDLE_TTL = 14 * 24 * 3600;
export const REFRESH_ABS_TTL = 30 * 24 * 3600;

/**
 * Mint an opaque refresh token bound to a token family (spec §4). Only the
 * SHA-256 is stored. `absExpires` carries the family's absolute deadline across
 * rotations so a refreshed token never extends the absolute window.
 */
/** Build the refresh-token INSERT + return the raw token, WITHOUT executing. Lets
 *  callers batch it with the access_token INSERT (offline-token pair). */
export async function refreshTokenInsert(
  i: { accountId: string; clientId: string; scope: string[]; family: string; now: number; prevId?: string; absExpires?: number },
): Promise<{ stmt: { sql: string; args: unknown[] }; token: string }> {
  const token = "rt_" + randomId(32);
  const tokenHash = await sha256Hex(token);
  return {
    token,
    stmt: {
      sql: `INSERT INTO refresh_tokens (token_hash, family_id, client_id, account_id, scope, prev_id, idle_expires_at, absolute_expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        tokenHash,
        i.family,
        i.clientId,
        i.accountId,
        i.scope.join(" "),
        i.prevId ?? null,
        i.now + REFRESH_IDLE_TTL,
        i.absExpires ?? i.now + REFRESH_ABS_TTL,
      ],
    },
  };
}

export async function createRefreshToken(
  db: DbClient,
  i: { accountId: string; clientId: string; scope: string[]; family: string; now: number; prevId?: string; absExpires?: number },
): Promise<string> {
  const { stmt, token } = await refreshTokenInsert(i);
  await db.execute(stmt);
  return token;
}

export interface RotateOk {
  ok: true;
  accountId: string;
  scope: string[];
  family: string;
  newRefresh: string;
}
export type RotateResult = RotateOk | { ok: false; error: string; reuse?: boolean };

/**
 * Rotate a refresh token (spec §4, §10): single-use with reuse detection. A
 * token presented after it was already used means the family is compromised →
 * revoke the whole family (refresh rows + access jtis) and reject. A valid token
 * is consumed and a new one issued in the same family, preserving the absolute
 * deadline.
 */
export async function rotateRefresh(
  db: DbClient,
  i: { token: string; clientId: string; now: number },
): Promise<RotateResult> {
  const tokenHash = await sha256Hex(i.token);
  const sel = await db.execute({ sql: "SELECT * FROM refresh_tokens WHERE token_hash = ?", args: [tokenHash] });
  const row = sel.rows[0];
  if (!row) return { ok: false, error: "invalid_grant" };

  if (row.used_at != null) {
    await revokeFamily(db, String(row.family_id));
    return { ok: false, error: "invalid_grant", reuse: true };
  }
  if (String(row.client_id) !== i.clientId) return { ok: false, error: "invalid_grant" };
  if (Number(row.idle_expires_at) < i.now || Number(row.absolute_expires_at) < i.now) {
    return { ok: false, error: "invalid_grant" };
  }

  const consume = await db.execute({
    sql: "UPDATE refresh_tokens SET used_at = datetime('now') WHERE token_hash = ? AND used_at IS NULL",
    args: [tokenHash],
  });
  if ((consume.rowsAffected ?? 0) !== 1) return { ok: false, error: "invalid_grant" };

  const scope = String(row.scope).split(/\s+/).filter(Boolean);
  const family = String(row.family_id);
  const newRefresh = await createRefreshToken(db, {
    accountId: String(row.account_id),
    clientId: i.clientId,
    scope,
    family,
    now: i.now,
    prevId: tokenHash,
    absExpires: Number(row.absolute_expires_at),
  });
  return { ok: true, accountId: String(row.account_id), scope, family, newRefresh };
}

/** Revoke an entire token family — all refresh rows + access jtis. */
export async function revokeFamily(db: DbClient, family: string): Promise<void> {
  await db.execute({ sql: "UPDATE refresh_tokens SET used_at = datetime('now') WHERE family_id = ? AND used_at IS NULL", args: [family] });
  await db.execute({ sql: "UPDATE access_tokens SET revoked_at = datetime('now') WHERE family_id = ?", args: [family] });
}
