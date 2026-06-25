import { assertAccessToken } from "@meowerse/auth-shared";
import { deriveVerified } from "./accounts";
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
  i: { header: Record<string, unknown>; payload: Record<string, unknown>; resourceAud: string },
): Promise<UserinfoResult> {
  if (!assertAccessToken(i.header, i.payload, i.resourceAud)) return { ok: false };
  const accountId = String(i.payload.sub ?? "");
  if (!accountId) return { ok: false };
  const scope = String(i.payload.scope ?? "").split(/\s+/).filter(Boolean);

  const acc = await db.execute({
    sql: "SELECT username, display_name, avatar_url FROM accounts WHERE id = ?",
    args: [accountId],
  });
  const arow = acc.rows[0];
  if (!arow) return { ok: false };

  const claims: Record<string, unknown> = { sub: accountId };
  if (scope.includes("profile")) {
    claims.preferred_username = arow.username;
    claims.name = arow.display_name;
    claims.picture = arow.avatar_url;
  }
  if (scope.includes("telegram")) {
    const tg = await db.execute({
      sql: "SELECT telegram_id, telegram_username FROM telegram_links WHERE account_id = ?",
      args: [accountId],
    });
    const trow = tg.rows[0];
    if (trow) {
      claims.telegram_id = trow.telegram_id;
      claims.telegram_username = trow.telegram_username;
    }
  }
  if (scope.includes("verified")) claims.verified = await deriveVerified(db, accountId);
  return { ok: true, claims };
}
