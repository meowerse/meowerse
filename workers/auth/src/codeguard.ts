// Shared SQL builders that tie token issuance to authorization-code consumption.
// Own module so token.ts and refresh.ts can both use it without an import cycle.

/** Predicate shared by the guarded INSERTs and the consume UPDATE: the code row exists and is unconsumed. */
const CODE_UNCONSUMED = "EXISTS (SELECT 1 FROM oauth_codes WHERE code_hash = ? AND consumed_at IS NULL)";

/**
 * Turn `INSERT INTO t (cols) VALUES (?,..)` into the conditional
 * `INSERT INTO t (cols) SELECT ?,.. WHERE EXISTS(unconsumed code)`, so the row is
 * written only if the code is still unconsumed at execution time (inside the
 * issuing transaction). `values` is the placeholder list; the guard arg is appended.
 */
export function codeGuard(
  table: string,
  cols: string,
  values: string,
  args: unknown[],
  codeHash?: string,
): { sql: string; args: unknown[] } {
  if (codeHash === undefined) return { sql: `INSERT INTO ${table} (${cols}) VALUES (${values})`, args };
  return { sql: `INSERT INTO ${table} (${cols}) SELECT ${values} WHERE ${CODE_UNCONSUMED}`, args: [...args, codeHash] };
}

/** The consume UPDATE; last statement of the issuing batch. rowsAffected 1 = we won, 0 = replay loser. */
export function consumeCodeStmt(codeHash: string): { sql: string; args: unknown[] } {
  return {
    sql: "UPDATE oauth_codes SET consumed_at = datetime('now') WHERE code_hash = ? AND consumed_at IS NULL",
    args: [codeHash],
  };
}

