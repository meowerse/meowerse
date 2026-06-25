/**
 * The fixed v1 OIDC scope catalog. Any scope outside this set is rejected at
 * `/authorize`. `offline_access` is advertised but only minted from slice 2
 * (refresh tokens); it stays in the catalog so the client model and discovery
 * doc are stable.
 */
export const CATALOG = new Set(["openid", "profile", "telegram", "verified", "offline_access"]);

/**
 * Parse a space-delimited scope string into a catalog-filtered, de-duplicated,
 * order-preserving list. Unknown scopes are dropped (not an error here; the
 * caller decides whether a dropped scope is fatal).
 */
export function parseScope(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of raw.trim().split(/\s+/)) {
    if (CATALOG.has(s) && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * The scope a token is actually minted with: the intersection of what the user
 * has ever consented to (`consentMax`), what the client is allowed to request
 * (`clientAllowed`), and what this request asked for (`requested`). Computed
 * LIVE at every mint so a narrowed client policy or revoked consent cannot be
 * elevated by a stale grant (spec §10/#9). Order follows `requested`.
 */
export function effectiveScope(consentMax: string[], clientAllowed: string[], requested: string[]): string[] {
  const allowed = new Set(clientAllowed);
  const max = new Set(consentMax);
  return requested.filter((s) => allowed.has(s) && max.has(s));
}

/** True iff every scope in `sub` is present in `sup`. */
export function isSubset(sub: string[], sup: string[]): boolean {
  const set = new Set(sup);
  return sub.every((s) => set.has(s));
}
