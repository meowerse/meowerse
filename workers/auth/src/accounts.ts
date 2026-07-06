import { validatePassword, genRecoveryCodes, normalizeRecoveryCode } from "@meowerse/auth-shared";
import { hashPassword, verifyPassword, DEFAULT_PBKDF2, CHEAP_PBKDF2, type Pbkdf2Params } from "./crypto";
import { randomId } from "./security";
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
  for (const code of codes) {
    const codeHash = await hashPassword(normalizeRecoveryCode(code), opts.recoveryParams ?? CHEAP_PBKDF2);
    await db.execute({
      sql: "INSERT INTO recovery_codes (account_id, code_hash) VALUES (?, ?)",
      args: [accountId, codeHash],
    });
  }
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
export type LoginResult = { ok: true; accountId: string } | { ok: false };

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

  const acc = await db.execute({ sql: "SELECT id FROM accounts WHERE username = ?", args: [username] });
  const arow = acc.rows[0];
  if (!arow) {
    await verifyPassword(input.password, dummy);
    return { ok: false };
  }
  const accountId = String(arow.id);
  const cred = await db.execute({ sql: "SELECT phc FROM password_credentials WHERE account_id = ?", args: [accountId] });
  const crow = cred.rows[0];
  if (!crow) {
    await verifyPassword(input.password, dummy);
    return { ok: false };
  }
  const ok = await verifyPassword(input.password, String(crow.phc));
  return ok ? { ok: true, accountId } : { ok: false };
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

/** Replace all recovery codes; returns the new plaintext set ONCE. */
export async function regenerateRecoveryCodes(db: DbClient, accountId: string, params?: Pbkdf2Params): Promise<string[]> {
  await db.execute({ sql: "DELETE FROM recovery_codes WHERE account_id = ?", args: [accountId] });
  const codes = genRecoveryCodes();
  for (const code of codes) {
    await db.execute({
      sql: "INSERT INTO recovery_codes (account_id, code_hash) VALUES (?, ?)",
      args: [accountId, await hashPassword(normalizeRecoveryCode(code), params ?? CHEAP_PBKDF2)],
    });
  }
  return codes;
}

/** How many unused recovery codes remain. */
export async function countRecoveryCodes(db: DbClient, accountId: string): Promise<number> {
  const r = await db.execute({ sql: "SELECT COUNT(*) AS n FROM recovery_codes WHERE account_id = ? AND used_at IS NULL", args: [accountId] });
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * Erase an account and everything it owns. `DbClient` has no `.batch()` and
 * cross-execute transactions don't hold over Turso HTTP, so we delete
 * sequentially, children first and the `accounts` row LAST — a partial failure
 * leaves the account intact and a retry completes it. Table names below are a
 * fixed allow-list (never user input), so the string interpolation is safe.
 */
export async function deleteAccount(db: DbClient, accountId: string): Promise<void> {
  const owned = await db.execute({ sql: "SELECT client_id FROM oauth_clients WHERE owner_account_id = ?", args: [accountId] });
  for (const row of owned.rows) {
    const cid = String(row.client_id);
    await db.execute({ sql: "DELETE FROM oauth_client_secrets WHERE client_id = ?", args: [cid] });
    await db.execute({ sql: "DELETE FROM oauth_client_redirect_uris WHERE client_id = ?", args: [cid] });
    await db.execute({ sql: "DELETE FROM consents WHERE client_id = ?", args: [cid] });
  }
  const accountKeyed = [
    "recovery_codes", "password_credentials", "telegram_links", "sessions",
    "consents", "access_tokens", "refresh_tokens", "management_tokens",
    "oauth_codes", "login_requests", "login_tickets",
  ];
  for (const tbl of accountKeyed) {
    await db.execute({ sql: `DELETE FROM ${tbl} WHERE account_id = ?`, args: [accountId] });
  }
  await db.execute({ sql: "DELETE FROM oauth_clients WHERE owner_account_id = ?", args: [accountId] });
  await db.execute({ sql: "DELETE FROM accounts WHERE id = ?", args: [accountId] });
}
