import { validatePassword, genRecoveryCodes, normalizeRecoveryCode } from "@meowerse/auth-shared";
import { hashPassword, verifyPassword, DEFAULT_PBKDF2, CHEAP_PBKDF2, type Pbkdf2Params } from "./crypto";
import { randomId } from "./security";
import { accountPresent, allOf, sessionLive, guardedInsert } from "./codeguard";
import type { DbClient } from "./types";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;

export interface SignupInput {
  username: string;
  password: string;
  displayName?: string;
}
export type SignupResult = { ok: true; accountId: string; recoveryCodes: string[] } | { ok: false; error: string };

export interface SignupOpts {
  pbkdf2?: Pbkdf2Params;
  recoveryParams?: Pbkdf2Params;
}

/**
 * Create a password account (spec §4, §7). Validates username + password, fails
 * with a generic "unavailable" if the username is taken, then writes the
 * account + PBKDF2 credential + 8 hashed recovery codes. Recovery codes are
 * returned ONCE (shown to the user, never stored in clear).
 */
export async function signup(db: DbClient, input: SignupInput, opts: SignupOpts = {}): Promise<SignupResult> {
  const username = (input.username ?? "").trim();
  if (!USERNAME_RE.test(username)) return { ok: false, error: "invalid username" };
  const pw = validatePassword(input.password);
  if (!pw.ok) return { ok: false, error: pw.error };

  const existing = await db.execute({ sql: "SELECT id FROM accounts WHERE username = ?", args: [username] });
  if (existing.rows.length > 0) return { ok: false, error: "unavailable" };

  const accountId = "acct_" + randomId(16);
  const phc = await hashPassword(pw.password, opts.pbkdf2 ?? DEFAULT_PBKDF2);
  await db.execute({
    sql: "INSERT INTO accounts (id, username, display_name) VALUES (?, ?, ?)",
    args: [accountId, username, input.displayName ?? username],
  });
  await db.execute({
    sql: "INSERT INTO password_credentials (account_id, phc) VALUES (?, ?)",
    args: [accountId, phc],
  });

  const codes = genRecoveryCodes();
  // Hashes are independent + known up front → hash all, then write in ONE batch
  // (was 8 sequential INSERT round-trips).
  const inserts = await Promise.all(
    codes.map(async (code) => ({
      sql: "INSERT INTO recovery_codes (account_id, code_hash) VALUES (?, ?)",
      args: [accountId, await hashPassword(normalizeRecoveryCode(code), opts.recoveryParams ?? CHEAP_PBKDF2)],
    })),
  );
  await db.batch(inserts);
  return { ok: true, accountId, recoveryCodes: codes };
}

/**
 * Canonical dummy PHC (default params). A login for an unknown username runs a
 * full verify against this so CPU + wall-time are account-independent — the
 * structural half of enumeration-safety (spec §10/#7). Salt/hash are arbitrary;
 * only the rounds/iter (the cost) must mirror real credentials.
 */
export const DEFAULT_DUMMY_PHC =
  `pbkdf2$sha256$${DEFAULT_PBKDF2.rounds}$${DEFAULT_PBKDF2.iter}$` +
  "AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export interface LoginInput {
  username: string;
  password: string;
}
/** On failure `accountId` is set only when the username exists (for the audit log; never exposed to clients). */
export type LoginResult = { ok: true; accountId: string } | { ok: false; accountId?: string };

/**
 * Verify username + password. On a missing user OR a missing credential it still
 * runs a verify against the dummy PHC, so the response time does not reveal
 * whether the account exists.
 */
export async function loginVerify(
  db: DbClient,
  input: LoginInput,
  opts: { dummyPhc?: string } = {},
): Promise<LoginResult> {
  const username = (input.username ?? "").trim();
  const dummy = opts.dummyPhc ?? DEFAULT_DUMMY_PHC;

  // One round-trip: account id + its password hash (null if account or credential
  // is missing). Either miss still runs a dummy verify so wall-time is
  // account-independent (enumeration-safety, spec §10/#7).
  const res = await db.execute({
    sql: `SELECT a.id AS id,
                 (SELECT phc FROM password_credentials p WHERE p.account_id = a.id) AS phc
          FROM accounts a WHERE a.username = ?`,
    args: [username],
  });
  const row = res.rows[0];
  if (!row || row.phc == null) {
    await verifyPassword(input.password, dummy);
    return row ? { ok: false, accountId: String(row.id) } : { ok: false };
  }
  const ok = await verifyPassword(input.password, String(row.phc));
  return ok ? { ok: true, accountId: String(row.id) } : { ok: false, accountId: String(row.id) };
}

/**
 * The authoritative `verified` value: derived LIVE from the existence of a
 * Telegram link, never read from the `accounts.verified` mirror (spec §10/#9).
 */
export async function deriveVerified(db: DbClient, accountId: string): Promise<boolean> {
  const res = await db.execute({ sql: "SELECT 1 FROM telegram_links WHERE account_id = ? LIMIT 1", args: [accountId] });
  return res.rows.length > 0;
}

// --- account self-service (spec R14) ---

export interface AccountInfo {
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  hasPassword: boolean;
}

/** Profile + whether a password credential exists (telegram-only accounts have
 *  none) — folded into ONE round-trip via an EXISTS subquery. */
export async function getAccountInfo(db: DbClient, accountId: string): Promise<AccountInfo | null> {
  const a = await db.execute({
    sql: `SELECT username, display_name, avatar_url,
                 EXISTS(SELECT 1 FROM password_credentials p WHERE p.account_id = ?) AS has_password
          FROM accounts WHERE id = ?`,
    args: [accountId, accountId],
  });
  const row = a.rows[0];
  if (!row) return null;
  return {
    username: row.username == null ? null : String(row.username),
    displayName: row.display_name == null ? null : String(row.display_name),
    avatarUrl: row.avatar_url == null ? null : String(row.avatar_url),
    hasPassword: Number(row.has_password) === 1,
  };
}

export interface AccountDetail extends AccountInfo {
  verified: boolean;
  telegram: { linked: boolean; username: string | null };
  recoveryRemaining: number;
}

/**
 * Everything the account page renders — profile + password/telegram/verified +
 * remaining recovery codes — in ONE query. Replaces getAccountInfo +
 * deriveVerified + getTelegramLink + countRecoveryCodes (4 hops). `verified` is
 * the LIVE existence of a telegram link (never the accounts.verified mirror),
 * which is also exactly "telegram linked".
 */
export async function getAccountDetail(db: DbClient, accountId: string): Promise<AccountDetail | null> {
  const r = await db.execute({
    sql: `SELECT a.username, a.display_name, a.avatar_url,
                 EXISTS(SELECT 1 FROM password_credentials p WHERE p.account_id = a.id) AS has_password,
                 (SELECT telegram_username FROM telegram_links t WHERE t.account_id = a.id) AS telegram_username,
                 EXISTS(SELECT 1 FROM telegram_links t WHERE t.account_id = a.id) AS verified,
                 (SELECT COUNT(*) FROM recovery_codes rc WHERE rc.account_id = a.id AND rc.used_at IS NULL) AS recovery_remaining
          FROM accounts a WHERE a.id = ?`,
    args: [accountId],
  });
  const row = r.rows[0];
  if (!row) return null;
  const verified = Number(row.verified) === 1;
  return {
    username: row.username == null ? null : String(row.username),
    displayName: row.display_name == null ? null : String(row.display_name),
    avatarUrl: row.avatar_url == null ? null : String(row.avatar_url),
    hasPassword: Number(row.has_password) === 1,
    verified,
    telegram: { linked: verified, username: row.telegram_username == null ? null : String(row.telegram_username) },
    recoveryRemaining: Number(row.recovery_remaining),
  };
}

/** Change password — verify the current one, validate + hash the new one. */
export async function changePassword(
  db: DbClient,
  i: { accountId: string; currentPassword: string; newPassword: string; pbkdf2?: Pbkdf2Params },
): Promise<{ ok: boolean; error?: string }> {
  const cred = await db.execute({ sql: "SELECT phc FROM password_credentials WHERE account_id = ?", args: [i.accountId] });
  const row = cred.rows[0];
  if (!row) return { ok: false, error: "no_password" };
  if (!(await verifyPassword(i.currentPassword, String(row.phc)))) return { ok: false, error: "wrong_password" };
  const pw = validatePassword(i.newPassword);
  if (!pw.ok) return { ok: false, error: pw.error };
  const phc = await hashPassword(pw.password, i.pbkdf2 ?? DEFAULT_PBKDF2);
  await db.execute({ sql: "UPDATE password_credentials SET phc = ? WHERE account_id = ?", args: [phc, i.accountId] });
  return { ok: true };
}

/**
 * Replace all recovery codes; returns the new plaintext set ONCE, or null when
 * the account no longer exists (the inserts are conditional on it, inside one
 * write batch, so nothing is written for a deleted account).
 */
export async function regenerateRecoveryCodes(db: DbClient, accountId: string, params?: Pbkdf2Params): Promise<string[] | null> {
  await db.execute({ sql: "DELETE FROM recovery_codes WHERE account_id = ?", args: [accountId] });
  const codes = genRecoveryCodes();
  const exists = accountPresent(accountId);
  const inserts = await Promise.all(
    codes.map(async (code) => ({
      sql: `INSERT INTO recovery_codes (account_id, code_hash) SELECT ?, ? WHERE ${exists.sql}`,
      args: [accountId, await hashPassword(normalizeRecoveryCode(code), params ?? CHEAP_PBKDF2), ...exists.args],
    })),
  );
  const res = await db.batch(inserts, "write");
  if (res.some((r) => (r.rowsAffected ?? 0) !== 1)) return null;
  return codes;
}

/** How many unused recovery codes remain. */
export async function countRecoveryCodes(db: DbClient, accountId: string): Promise<number> {
  const r = await db.execute({ sql: "SELECT COUNT(*) AS n FROM recovery_codes WHERE account_id = ? AND used_at IS NULL", args: [accountId] });
  return Number(r.rows[0]?.n ?? 0);
}

/** The step-up confirmation that authorises ONE deletion: bound to the account, the session, and an expiry. */
export interface DeleteConfirmation {
  tokenHash: string;
  sessionIdHash: string;
  now: number;
}

/** Lifetime of a delete confirmation token, seconds. */
export const DELETE_CONFIRM_TTL = 300;

/**
 * Check the account's current password. "none" = the account has no password credential (Telegram-only).
 * A wrong/missing password costs the same PBKDF2 verify (dummy PHC when absent is unnecessary: this
 * runs only for an already-authenticated session, so there is no account-enumeration surface).
 */
export async function verifyAccountPassword(db: DbClient, accountId: string, password: string): Promise<"ok" | "wrong" | "none"> {
  const cred = await db.execute({ sql: "SELECT phc FROM password_credentials WHERE account_id = ?", args: [accountId] });
  const row = cred.rows[0];
  if (!row) return "none";
  return (await verifyPassword(password, String(row.phc))) ? "ok" : "wrong";
}

/**
 * Store a new single-use delete confirmation (only the SHA-256 of the token) bound to this account + session, and
 * invalidate every earlier unused one for the account. ONE write batch; the insert is guarded on the account
 * existing and the session being live, so nothing is written for a deleted account / revoked session.
 * Returns false when nothing was issued.
 */
export async function issueDeleteConfirmation(
  db: DbClient,
  i: { accountId: string; sessionIdHash: string; tokenHash: string; now: number },
): Promise<boolean> {
  const guard = allOf(accountPresent(i.accountId), sessionLive(i.sessionIdHash, i.accountId, i.now));
  const res = await db.batch(
    [
      { sql: "DELETE FROM account_delete_confirmations WHERE account_id = ? AND used_at IS NULL", args: [i.accountId] },
      guardedInsert(
        "account_delete_confirmations",
        "token_hash, account_id, session_id_hash, created_at, expires_at",
        "?, ?, ?, ?, ?",
        [i.tokenHash, i.accountId, i.sessionIdHash, i.now, i.now + DELETE_CONFIRM_TTL],
        guard,
      ),
    ],
    "write",
  );
  return (res[1]?.rowsAffected ?? 0) === 1;
}

/** Read-only probe (after a failed delete batch): is this confirmation still usable for this account + session? */
export async function deleteConfirmationUsable(db: DbClient, accountId: string, c: DeleteConfirmation): Promise<boolean> {
  const r = await db.execute({
    sql: "SELECT 1 FROM account_delete_confirmations WHERE token_hash = ? AND account_id = ? AND session_id_hash = ? AND used_at IS NULL AND expires_at > ?",
    args: [c.tokenHash, accountId, c.sessionIdHash, c.now],
  });
  return r.rows.length > 0;
}

/**
 * Erase an account and everything it owns, ATOMICALLY: every DELETE runs in ONE
 * `db.batch(..., "write")` transaction (BEGIN IMMEDIATE), so a mid-sequence
 * failure rolls the whole erasure back and a concurrent token issuance is
 * serialized against it. The guarded token inserts (INSERT ... SELECT WHERE
 * EXISTS(code unconsumed / refresh unused)) cannot write from codes / refresh
 * tokens that existed at deletion, because this transaction removes those rows.
 * Fresh credential INSERTs (sessions, oauth_codes, consents, recovery codes, Telegram links, OAuth
 * clients + children, management tokens, access/refresh tokens) are guarded in-statement on the account
 * still existing (see codeguard.ts `accountPresent`), so none can be written after this commits. Owned-client
 * children are deleted via subqueries on `oauth_clients.owner_account_id`, so
 * nothing depends on a prior read. Children first; `oauth_clients` then
 * `accounts` last. `audit_log` rows are intentionally kept (the account.delete row is the LAST
 * statement of the same batch). Table names below are a fixed allow-list (never user input).
 */
export async function deleteAccount(
  db: DbClient,
  accountId: string,
  audit: { ipTrunc: string | null; uaHash: string | null } = { ipTrunc: null, uaHash: null },
  confirm?: DeleteConfirmation,
): Promise<void> {
  const owned = "(SELECT client_id FROM oauth_clients WHERE owner_account_id = ?)";
  const stmts: { sql: string; args: unknown[] }[] = [];
  // Single-use confirmation, consumed atomically INSIDE the batch (the handler ALWAYS passes it): the UPDATE
  // wins only for an unused, unexpired token bound to this account AND this session; the next statement then
  // aborts the whole batch (NOT NULL violation) when it changed nothing. Two racing requests with the same
  // token serialize on the write transaction, so exactly one consumes it.
  if (confirm) {
    stmts.push(
      {
        sql: "UPDATE account_delete_confirmations SET used_at = ? WHERE token_hash = ? AND account_id = ? AND session_id_hash = ? AND used_at IS NULL AND expires_at > ?",
        args: [confirm.now, confirm.tokenHash, accountId, confirm.sessionIdHash, confirm.now],
      },
      { sql: "INSERT INTO audit_log (event) SELECT NULL WHERE changes() = 0", args: [] },
    );
  }
  stmts.push(
    // In-batch guard: an ACTIVE owned client (created after the handler's pre-check) must never be
    // hard-deleted silently. This inserts a row with a NULL (NOT NULL) `event` only when one exists, so
    // the constraint error aborts and rolls back the WHOLE batch. With none it inserts nothing.
    {
      sql: "INSERT INTO audit_log (event) SELECT NULL WHERE EXISTS (SELECT 1 FROM oauth_clients WHERE owner_account_id = ? AND deleted_at IS NULL)",
      args: [accountId],
    },
    { sql: `DELETE FROM oauth_client_secrets WHERE client_id IN ${owned}`, args: [accountId] },
    { sql: `DELETE FROM oauth_client_redirect_uris WHERE client_id IN ${owned}`, args: [accountId] },
    // Owned clients are all soft-deleted here (guard above): every user's codes/tokens/consents for them are dead.
    { sql: `DELETE FROM oauth_codes WHERE client_id IN ${owned}`, args: [accountId] },
    { sql: `DELETE FROM access_tokens WHERE client_id IN ${owned}`, args: [accountId] },
    { sql: `DELETE FROM refresh_tokens WHERE client_id IN ${owned}`, args: [accountId] },
    { sql: `DELETE FROM consents WHERE client_id IN ${owned}`, args: [accountId] },
  );
  const accountKeyed = [
    "recovery_codes", "password_credentials", "telegram_links", "sessions",
    "consents", "access_tokens", "refresh_tokens",
    "oauth_codes", "login_requests", "login_tickets", "account_delete_confirmations",
  ];
  for (const tbl of accountKeyed) {
    stmts.push({ sql: `DELETE FROM ${tbl} WHERE account_id = ?`, args: [accountId] });
  }
  // management_tokens is keyed by owner_account_id (no account_id column).
  stmts.push({ sql: "DELETE FROM management_tokens WHERE owner_account_id = ?", args: [accountId] });
  stmts.push({ sql: "DELETE FROM oauth_clients WHERE owner_account_id = ?", args: [accountId] });
  stmts.push({ sql: "DELETE FROM accounts WHERE id = ?", args: [accountId] });
  // LAST: the audit row commits iff the deletion committed (same columns as recordAudit writes).
  // `changes() = 1` (rows changed by the immediately preceding accounts DELETE) makes a concurrent
  // double submit write no second row: only the batch that actually deleted the account audits it.
  stmts.push({
    sql: "INSERT INTO audit_log (event, account_id, client_id, ip_trunc, ua_hash) SELECT ?, ?, ?, ?, ? WHERE changes() = 1",
    args: ["account.delete", accountId, null, audit.ipTrunc, audit.uaHash],
  });
  await db.batch(stmts, "write");
}

/** Active (not soft-deleted) clients owned by the account; deletion is refused while any exist. */
export async function ownsActiveClients(db: DbClient, accountId: string): Promise<boolean> {
  const r = await db.execute({
    sql: "SELECT client_id FROM oauth_clients WHERE owner_account_id = ? AND deleted_at IS NULL",
    args: [accountId],
  });
  return r.rows.length > 0;
}

export async function accountExists(db: DbClient, accountId: string): Promise<boolean> {
  const r = await db.execute({ sql: "SELECT 1 FROM accounts WHERE id = ?", args: [accountId] });
  return r.rows.length > 0;
}
