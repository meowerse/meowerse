import { TYP, TOKEN_USE, sha256, b64urlEncode, verifyPkceS256 } from "@meowerse/auth-shared";
import { sha256Hex } from "./crypto";
import { randomId } from "./security";
import { signJwt } from "./jwt";
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
}
export type ExchangeResult = ExchangeOk | { ok: false; error: string; replay?: boolean };

/**
 * Redeem an authorization code (spec §5, §8, §10/#3). Single-use via a
 * consumed_at marker; a SECOND presentation of an already-consumed code revokes
 * the whole token family and returns invalid_grant. Re-validates client +
 * byte-exact redirect_uri and the PKCE verifier.
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
    await db.execute({
      sql: "UPDATE access_tokens SET revoked_at = datetime('now') WHERE family_id = ?",
      args: [String(row.jti_family)],
    });
    return { ok: false, error: "invalid_grant", replay: true };
  }
  if (Number(row.expires_at) < i.now) return { ok: false, error: "invalid_grant" };
  if (String(row.client_id) !== i.clientId) return { ok: false, error: "invalid_grant" };
  if (String(row.redirect_uri) !== i.redirectUri) return { ok: false, error: "invalid_grant" };
  if (!(await verifyPkceS256(i.verifier, String(row.code_challenge)))) return { ok: false, error: "invalid_grant" };

  const consume = await db.execute({
    sql: "UPDATE oauth_codes SET consumed_at = datetime('now') WHERE code_hash = ? AND consumed_at IS NULL",
    args: [codeHash],
  });
  if ((consume.rowsAffected ?? 0) !== 1) return { ok: false, error: "invalid_grant" }; // lost a concurrent race

  return {
    ok: true,
    accountId: String(row.account_id),
    scope: String(row.scope).split(/\s+/).filter(Boolean),
    nonce: row.nonce == null ? null : String(row.nonce),
    authTime: Number(row.auth_time),
    family: String(row.jti_family),
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

/** Record the access_token jti for introspect/revoke. */
export async function recordAccessToken(
  db: DbClient,
  i: { jti: string; accountId: string; clientId: string; scope: string[]; family: string; now: number },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO access_tokens (jti, account_id, client_id, scope, family_id, issued_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [i.jti, i.accountId, i.clientId, i.scope.join(" "), i.family, i.now, i.now + ACCESS_TTL],
  });
}

/** RFC 7009 revoke by jti (best-effort; always 200 to the caller). */
export async function revokeAccessToken(db: DbClient, jti: string): Promise<void> {
  await db.execute({ sql: "UPDATE access_tokens SET revoked_at = datetime('now') WHERE jti = ?", args: [jti] });
}

/** RFC 7662 introspection by jti. */
export async function introspect(db: DbClient, jti: string, now: number): Promise<{ active: boolean }> {
  const res = await db.execute({
    sql: "SELECT expires_at, revoked_at FROM access_tokens WHERE jti = ?",
    args: [jti],
  });
  const row = res.rows[0];
  if (!row || row.revoked_at != null || Number(row.expires_at) < now) return { active: false };
  return { active: true };
}
