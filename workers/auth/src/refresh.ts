import { sha256Hex } from "./crypto";
import { randomId } from "./security";
import type { DbClient } from "./types";
import { guardedInsert, type Guard } from "./codeguard";

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
  guard?: Guard,
): Promise<{ stmt: { sql: string; args: unknown[] }; token: string }> {
  const token = "rt_" + randomId(32);
  const tokenHash = await sha256Hex(token);
  return {
    token,
    stmt: guardedInsert(
      "refresh_tokens",
      "token_hash, family_id, client_id, account_id, scope, prev_id, idle_expires_at, absolute_expires_at",
      "?, ?, ?, ?, ?, ?, ?, ?",
      [
        tokenHash,
        i.family,
        i.clientId,
        i.accountId,
        i.scope.join(" "),
        i.prevId ?? null,
        i.now + REFRESH_IDLE_TTL,
        i.absExpires ?? i.now + REFRESH_ABS_TTL,
      ],
      guard,
    ),
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
  /** SHA-256 of the presented token: the rotation batch spends it (see `refreshUnused`). */
  tokenHash: string;
  absExpires: number;
}
/** On reuse, `accountId`/`familyClientId` identify the compromised family (for the audit trail only). */
export type RotateResult =
  | RotateOk
  | { ok: false; error: string; reuse?: boolean; revokeFailed?: boolean; accountId?: string; familyClientId?: string };

/**
 * Validate a refresh token for rotation (spec §4, §10): single-use with reuse
 * detection. A token presented after it was already used means the family is
 * compromised → revoke the whole family (refresh rows + access jtis) and reject.
 *
 * This does NOT mark the token used. The caller spends it in the SAME write
 * transaction that inserts the successor refresh + access rows (guarded on the
 * old row still being unused); otherwise a reuse landing between "mark used" and
 * "insert successors" would revoke an empty family and the successors would then
 * be inserted into it as usable tokens.
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
    const ids = { reuse: true, accountId: String(row.account_id), familyClientId: String(row.client_id) };
    try {
      await revokeFamilyWithRetry(db, String(row.family_id));
    } catch {
      // The revoke did not persist: fail closed (the caller still audits, then answers 5xx).
      console.error("family_revoke_failed");
      return { ok: false, error: "server_error", revokeFailed: true, ...ids };
    }
    return { ok: false, error: "invalid_grant", ...ids };
  }
  if (String(row.client_id) !== i.clientId) return { ok: false, error: "invalid_grant" };
  if (Number(row.idle_expires_at) < i.now || Number(row.absolute_expires_at) < i.now) {
    return { ok: false, error: "invalid_grant" };
  }

  return {
    ok: true,
    accountId: String(row.account_id),
    scope: String(row.scope).split(/\s+/).filter(Boolean),
    family: String(row.family_id),
    tokenHash,
    absExpires: Number(row.absolute_expires_at),
  };
}

/** Revoke an entire token family — all refresh rows + access jtis. */
export async function revokeFamily(db: DbClient, family: string): Promise<void> {
  // One batch: either both kinds of token in the family are revoked or neither is.
  await db.batch([
    { sql: "UPDATE refresh_tokens SET used_at = datetime('now') WHERE family_id = ? AND used_at IS NULL", args: [family] },
    { sql: "UPDATE access_tokens SET revoked_at = datetime('now') WHERE family_id = ?", args: [family] },
  ]);
}

const REVOKE_BACKOFF_MS = [0, 50, 200];
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `revokeFamily` with bounded retry (3 attempts, 0/50/200 ms backoff) so one
 * transient database error does not leave a replayed/compromised family live.
 * Rethrows the last error if every attempt fails. `sleep` is injectable for tests.
 */
export async function revokeFamilyWithRetry(db: DbClient, family: string, sleep: (ms: number) => Promise<void> = realSleep): Promise<void> {
  let last: unknown;
  for (const delay of REVOKE_BACKOFF_MS) {
    if (delay > 0) await sleep(delay);
    try {
      await revokeFamily(db, family);
      return;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
