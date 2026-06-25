/**
 * Token-type constants + guards — the single source closing the id_token /
 * access_token confusion class (spec §10/#5). Every verifier MUST route through
 * these so no service can re-open the hole by hand-rolling a check.
 *
 *  - id_token:     header `typ:"JWT"`,    claim `token_use:"id"`,     `aud` = client_id
 *  - access_token: header `typ:"at+jwt"` (RFC 9068), `token_use:"access"`, `aud` = fixed resource
 */
export const TYP = { ID: "JWT", ACCESS: "at+jwt" } as const;
export const TOKEN_USE = { ID: "id", ACCESS: "access" } as const;

/** A token is a usable access_token iff typ + token_use + the fixed resource aud all match. */
export function assertAccessToken(
  header: { typ?: unknown },
  payload: { token_use?: unknown; aud?: unknown },
  resourceAud: string,
): boolean {
  return header.typ === TYP.ACCESS && payload.token_use === TOKEN_USE.ACCESS && payload.aud === resourceAud;
}

/** A token is a usable id_token iff it is NOT an access token shape. */
export function assertIdToken(header: { typ?: unknown }, payload: { token_use?: unknown }): boolean {
  return header.typ === TYP.ID && payload.token_use === TOKEN_USE.ID;
}
