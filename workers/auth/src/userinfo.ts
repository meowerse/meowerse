import { assertAccessToken } from "@meowerse/auth-shared";
import type { DbClient } from "./types";

export type UserinfoResult = { ok: true; claims: Record<string, unknown> } | { ok: false };

/**
 * Build /userinfo claims (spec §3, §10/#5). The bearer MUST be an access_token
 * (typ:at+jwt + token_use:access + the fixed resource aud) — an id_token-shaped
 * token is rejected here. Claims are filtered by the token's granted scope and
 * `verified` is derived LIVE.
 */
export async function userinfoClaims(
  db: DbClient,
  i: { header: Record<string, unknown>; payload: Record<string, unknown>; resourceAud: string; issuer: string },
): Promise<UserinfoResult> {
  if (!assertAccessToken(i.header, i.payload, i.resourceAud)) return { ok: false };
  const accountId = String(i.payload.sub ?? "");
  if (!accountId) return { ok: false };
  const scope = String(i.payload.scope ?? "").split(/\s+/).filter(Boolean);

  // One round-trip: profile + telegram link + live verified (EXISTS). All read
  // unconditionally — still a single hop — then filtered by granted scope. Was
  // up to 3 sequential hops (account, telegram, deriveVerified).
  const acc = await db.execute({
    sql: `SELECT username, display_name, avatar_url,
                 (SELECT telegram_id FROM telegram_links t WHERE t.account_id = a.id) AS telegram_id,
                 (SELECT telegram_username FROM telegram_links t WHERE t.account_id = a.id) AS telegram_username,
                 EXISTS(SELECT 1 FROM telegram_links t WHERE t.account_id = a.id) AS verified
          FROM accounts a WHERE a.id = ?`,
    args: [accountId],
  });
  const arow = acc.rows[0];
  if (!arow) return { ok: false };

  const claims: Record<string, unknown> = { sub: accountId };
  if (scope.includes("profile")) {
    claims.preferred_username = arow.username;
    claims.name = arow.display_name;
    // Always the CURRENT Telegram photo via our reliable avatar proxy (never the
    // stale `t.me/i/userpic/...` snapshot). Only when the account is TG-linked;
    // otherwise `picture` is omitted. Uses the live issuer so it auto-follows a
    // host change.
    claims.picture = arow.telegram_id != null ? `${i.issuer}/avatar/${accountId}` : null;
  }
  if (scope.includes("telegram") && arow.telegram_id != null) {
    claims.telegram_id = arow.telegram_id;
    claims.telegram_username = arow.telegram_username;
  }
  if (scope.includes("verified")) claims.verified = Number(arow.verified) === 1;
  return { ok: true, claims };
}
