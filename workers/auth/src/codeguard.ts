// Shared SQL builders that tie token issuance to the single-use credential
// (authorization code or refresh token) that authorises it. The credential's
// consumption and the new rows are written in ONE write transaction, each insert
// conditional on the credential still being unspent, so "spent" and "its
// successors exist" become visible together. Own module so token.ts and
// refresh.ts can both use it without an import cycle.

export type Stmt = { sql: string; args: unknown[] };
/** A WHERE-EXISTS predicate (with its single bound arg) that must hold for a guarded INSERT to write. */
export type Guard = { sql: string; arg: string };

/** The authorization code row exists and is unconsumed. */
export const codeUnconsumed = (codeHash: string): Guard => ({
  sql: "EXISTS (SELECT 1 FROM oauth_codes WHERE code_hash = ? AND consumed_at IS NULL)",
  arg: codeHash,
});

/** The refresh token row exists and is unused. */
export const refreshUnused = (tokenHash: string): Guard => ({
  sql: "EXISTS (SELECT 1 FROM refresh_tokens WHERE token_hash = ? AND used_at IS NULL)",
  arg: tokenHash,
});

/**
 * `INSERT INTO t (cols) VALUES (?,..)`, or with a guard the conditional
 * `INSERT INTO t (cols) SELECT ?,.. WHERE <guard>`, which writes the row only if
 * the guard holds at execution time (inside the issuing transaction). The guard
 * arg is appended to `args`.
 */
export function guardedInsert(table: string, cols: string, values: string, args: unknown[], guard?: Guard): Stmt {
  if (!guard) return { sql: `INSERT INTO ${table} (${cols}) VALUES (${values})`, args };
  return { sql: `INSERT INTO ${table} (${cols}) SELECT ${values} WHERE ${guard.sql}`, args: [...args, guard.arg] };
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
