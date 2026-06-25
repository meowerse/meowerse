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
