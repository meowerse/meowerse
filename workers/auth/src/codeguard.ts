// Shared SQL builders that tie token issuance to the single-use credential
// (authorization code or refresh token) that authorises it. The credential's
// consumption and the new rows are written in ONE write transaction, each insert
// conditional on the credential still being unspent, so "spent" and "its
// successors exist" become visible together. Own module so token.ts and
// refresh.ts can both use it without an import cycle.

export type Stmt = { sql: string; args: unknown[] };
/** A WHERE predicate (with its bound args, in order) that must hold for a guarded INSERT to write. */
export type Guard = { sql: string; args: unknown[] };

/** All of the guards must hold (AND). */
export const allOf = (...gs: Guard[]): Guard => ({
  sql: gs.map((g) => `(${g.sql})`).join(" AND "),
  args: gs.flatMap((g) => g.args),
});

/**
 * The account row still exists. Evaluated inside the inserting statement, and
 * deleteAccount is one exclusive write transaction, so a credential row can
 * never be written for an account whose deletion already committed.
 */
export const accountPresent = (accountId: string): Guard => ({
  sql: "EXISTS (SELECT 1 FROM accounts WHERE id = ?)",
  args: [accountId],
});

/** The session row is live (unrevoked, within both expiries) AND its account still exists. */
export const sessionLive = (sessionIdHash: string, accountId: string, now: number): Guard => ({
  sql: `EXISTS (SELECT 1 FROM sessions ss JOIN accounts ac ON ac.id = ss.account_id
          WHERE ss.id_hash = ? AND ss.account_id = ? AND ss.revoked_at IS NULL
            AND ss.idle_expires_at >= ? AND ss.absolute_expires_at >= ?)`,
  args: [sessionIdHash, accountId, now, now],
});

/**
 * The session that originally authorised this authorization code is still live (unrevoked, within both
 * expiries, same account). Evaluated inside the issuing statement at EXCHANGE time, so a session revoked
 * (logout, password change, sign-out-everywhere) after the code was minted cannot still turn it into tokens.
 */
export const codeSessionLive = (codeHash: string, now: number): Guard => ({
  sql: `EXISTS (SELECT 1 FROM oauth_codes oc JOIN sessions ss ON ss.id_hash = oc.session_id_hash AND ss.account_id = oc.account_id
          WHERE oc.code_hash = ? AND ss.revoked_at IS NULL AND ss.idle_expires_at >= ? AND ss.absolute_expires_at >= ?)`,
  args: [codeHash, now, now],
});

/** The authorization code row exists and is unconsumed. */
export const codeUnconsumed = (codeHash: string): Guard => ({
  sql: "EXISTS (SELECT 1 FROM oauth_codes WHERE code_hash = ? AND consumed_at IS NULL)",
  args: [codeHash],
});

/** The refresh token row exists and is unused. */
export const refreshUnused = (tokenHash: string): Guard => ({
  sql: "EXISTS (SELECT 1 FROM refresh_tokens WHERE token_hash = ? AND used_at IS NULL)",
  args: [tokenHash],
});

/**
 * `INSERT INTO t (cols) VALUES (?,..)`, or with a guard the conditional
 * `INSERT INTO t (cols) SELECT ?,.. WHERE <guard>`, which writes the row only if
 * the guard holds at execution time (inside the issuing transaction). The guard
 * arg is appended to `args`.
 */
export function guardedInsert(table: string, cols: string, values: string, args: unknown[], guard?: Guard): Stmt {
  if (!guard) return { sql: `INSERT INTO ${table} (${cols}) VALUES (${values})`, args };
  return { sql: `INSERT INTO ${table} (${cols}) SELECT ${values} WHERE ${guard.sql}`, args: [...args, ...guard.args] };
}

/** The consume UPDATE; last statement of the issuing batch. rowsAffected 1 = we won, 0 = lost. */
export function consumeCodeStmt(codeHash: string): Stmt {
  return {
    sql: "UPDATE oauth_codes SET consumed_at = datetime('now') WHERE code_hash = ? AND consumed_at IS NULL",
    args: [codeHash],
  };
}

/** Mark a refresh token used; last statement of the rotation batch. rowsAffected 1 = we won, 0 = lost. */
export function consumeRefreshStmt(tokenHash: string): Stmt {
  return {
    sql: "UPDATE refresh_tokens SET used_at = datetime('now') WHERE token_hash = ? AND used_at IS NULL",
    args: [tokenHash],
  };
}
