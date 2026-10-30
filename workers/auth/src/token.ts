import { TYP, TOKEN_USE, sha256, b64urlEncode, verifyPkceS256 } from "@meowerse/auth-shared";
import { sha256Hex } from "./crypto";
import { randomId } from "./security";
import { revokeFamilyWithRetry } from "./refresh";
import { signJwt } from "./jwt";
import { guardedInsert, type Guard } from "./codeguard";
import type { DbClient } from "./types";
import type { AuthorizeRequest } from "./authorize";

export const CODE_TTL = 60;
export const ACCESS_TTL = 900;
export const ID_TTL = 300;

/** at_hash = base64url(left-128-bits(SHA-256(access_token))) (OIDC Core). */
export async function atHash(accessToken: string): Promise<string> {
  const digest = await sha256(accessToken);
  return b64urlEncode(digest.slice(0, 16));
}

/**
 * Issue a single-use authorization code bound to the request, account, and
 * session. Returns the RAW code (placed in the redirect); only its SHA-256 is
 * stored. `jti_family` ties any derived tokens for replay-driven revocation.
 */
export async function createAuthCode(
  db: DbClient,
  i: { request: AuthorizeRequest; accountId: string; sessionIdHash: string; scope: string[]; authTime: number; now: number },
): Promise<string> {
  const code = "code_" + randomId(32);
  const family = "fam_" + randomId(16);
  await db.execute({
    sql: `INSERT INTO oauth_codes
      (code_hash, client_id, redirect_uri, scope, nonce, code_challenge, code_challenge_method,
       account_id, session_id_hash, auth_time, jti_family, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'S256', ?, ?, ?, ?, ?)`,
    args: [
      await sha256Hex(code),
      i.request.clientId,
      i.request.redirectUri,
      i.scope.join(" "),
      i.request.nonce ?? null,
      i.request.codeChallenge,
      i.accountId,
      i.sessionIdHash,
      i.authTime,
      family,
      i.now + CODE_TTL,
    ],
  });
  return code;
}

export interface ExchangeOk {
  ok: true;
  accountId: string;
  scope: string[];
  nonce: string | null;
  authTime: number;
  family: string;
  /** SHA-256 of the code; the issuing batch consumes the row by this key. */
  codeHash: string;
}
export type ExchangeResult = ExchangeOk | { ok: false; error: string; replay?: boolean; revokeFailed?: boolean; accountId?: string; codeClientId?: string };

/**
 * Validate an authorization code (spec §5, §8, §10/#3). A presentation of an
 * already-consumed code revokes the whole token family and returns
 * invalid_grant. Re-validates client + byte-exact redirect_uri and the PKCE
 * verifier.
 *
 * This does NOT consume the code. Consumption happens in the SAME transaction
 * that inserts the tokens (see `guardedInsert` / `consumeCodeStmt`), so "code
 * consumed" and "its tokens exist" become visible together. Consuming here and
 * inserting later left a window where a replay revoked an empty family and the
 * first request then inserted usable tokens into it.
 */
export async function exchangeCode(
  db: DbClient,
  i: { code: string; verifier: string; clientId: string; redirectUri: string; now: number },
): Promise<ExchangeResult> {
  const codeHash = await sha256Hex(i.code);
  const sel = await db.execute({ sql: "SELECT * FROM oauth_codes WHERE code_hash = ?", args: [codeHash] });
  const row = sel.rows[0];
  if (!row) return { ok: false, error: "invalid_grant" };

  if (row.consumed_at != null) {
    // RFC 6749 §4.1.2: a replayed code revokes every token issued from it, including
    // the offline refresh token, which shares the code's family.
    const ids = { replay: true, accountId: String(row.account_id), codeClientId: String(row.client_id) };
    try {
      await revokeFamilyWithRetry(db, String(row.jti_family));
    } catch {
      // The revoke did not persist: fail closed (the caller still audits, then answers 5xx).
      console.error("family_revoke_failed");
      return { ok: false, error: "server_error", revokeFailed: true, ...ids };
    }
    return { ok: false, error: "invalid_grant", ...ids };
  }
  if (Number(row.expires_at) < i.now) return { ok: false, error: "invalid_grant" };
  if (String(row.client_id) !== i.clientId) return { ok: false, error: "invalid_grant" };
  if (String(row.redirect_uri) !== i.redirectUri) return { ok: false, error: "invalid_grant" };
  if (!(await verifyPkceS256(i.verifier, String(row.code_challenge)))) return { ok: false, error: "invalid_grant" };

  return {
    ok: true,
    accountId: String(row.account_id),
    scope: String(row.scope).split(/\s+/).filter(Boolean),
    nonce: row.nonce == null ? null : String(row.nonce),
    authTime: Number(row.auth_time),
    family: String(row.jti_family),
    codeHash,
  };
}

export interface MintInput {
  accountId: string;
  clientId: string;
  scope: string[];
  nonce: string | null;
  authTime: number;
  verified: boolean;
  issuer: string;
  resourceAud: string;
  signingKey: CryptoKey;
  kid: string;
  family: string;
  now: number;
}

export interface MintedTokens {
  id_token: string;
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  jti: string;
}

/**
 * Mint the id_token (typ:JWT, aud=client) and access_token (typ:at+jwt,
 * aud=fixed resource). The data-bearing claims live in /userinfo, not the
 * id_token. `verified` is stamped only when the `verified` scope was granted.
 */
export async function mintTokens(i: MintInput): Promise<MintedTokens> {
  const jti = "at_" + randomId(16);
  const access = await signJwt(
    { kid: i.kid, typ: TYP.ACCESS },
    {
      iss: i.issuer,
      sub: i.accountId,
      aud: i.resourceAud,
      client_id: i.clientId,
      scope: i.scope.join(" "),
      token_use: TOKEN_USE.ACCESS,
      jti,
      iat: i.now,
      exp: i.now + ACCESS_TTL,
    },
    i.signingKey,
  );
  const idPayload: Record<string, unknown> = {
    iss: i.issuer,
    sub: i.accountId,
    aud: i.clientId,
    azp: i.clientId,
    token_use: TOKEN_USE.ID,
    iat: i.now,
    exp: i.now + ID_TTL,
    auth_time: i.authTime,
    at_hash: await atHash(access),
  };
  if (i.nonce) idPayload.nonce = i.nonce;
  if (i.scope.includes("verified")) idPayload.verified = i.verified;
  const id = await signJwt({ kid: i.kid, typ: TYP.ID }, idPayload, i.signingKey);

  return { id_token: id, access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, scope: i.scope.join(" "), jti };
}

/** The access_token-jti INSERT as a statement (so callers can batch it with the
 *  refresh INSERT in the offline-token pair instead of two round-trips). With
 *  `guard` it is the conditional variant (only if the guard holds). */
export function accessTokenInsert(
  i: { jti: string; accountId: string; clientId: string; scope: string[]; family: string; now: number },
  guard?: Guard,
): { sql: string; args: unknown[] } {
  return guardedInsert(
    "access_tokens",
    "jti, account_id, client_id, scope, family_id, issued_at, expires_at",
    "?, ?, ?, ?, ?, ?, ?",
    [i.jti, i.accountId, i.clientId, i.scope.join(" "), i.family, i.now, i.now + ACCESS_TTL],
    guard,
  );
}

/** Record the access_token jti for introspect/revoke. */
export async function recordAccessToken(
  db: DbClient,
  i: { jti: string; accountId: string; clientId: string; scope: string[]; family: string; now: number },
): Promise<void> {
  await db.execute(accessTokenInsert(i));
}

/** RFC 7009 revoke by jti, scoped to the authenticated client (best-effort, 200). */
export async function revokeAccessToken(db: DbClient, jti: string, clientId: string): Promise<boolean> {
  const res = await db.execute({
    // `revoked_at IS NULL`: keep the first revocation time and report a re-revoke as no change.
    sql: "UPDATE access_tokens SET revoked_at = datetime('now') WHERE jti = ? AND client_id = ? AND revoked_at IS NULL",
    args: [jti, clientId],
  });
  return (res.rowsAffected ?? 0) > 0; // true only if a token matched
}

/** RFC 7662 introspection by jti, scoped to the authenticated client (no cross-client oracle). */
export async function introspect(db: DbClient, jti: string, now: number, clientId: string): Promise<{ active: boolean }> {
  const res = await db.execute({
    sql: "SELECT expires_at, revoked_at FROM access_tokens WHERE jti = ? AND client_id = ?",
    args: [jti, clientId],
  });
  const row = res.rows[0];
  if (!row || row.revoked_at != null || Number(row.expires_at) < now) return { active: false };
  return { active: true };
}
