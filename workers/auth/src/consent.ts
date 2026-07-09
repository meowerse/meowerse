import { effectiveScope, isSubset } from "@meowerse/auth-shared";
import type { DbClient } from "./types";

export type ConsentAction = "silent" | "prompt" | "verify_upgrade";

export interface ConsentDecisionInput {
  requested: string[];
  clientAllowed: string[];
  priorConsentScopes: string[] | null; // approved_scope_snapshot, or null if none
  priorMax: string[] | null; // scope_set_max, or null
  prompt?: string;
  verifiedOnly: boolean;
  userVerified: boolean;
  firstParty: boolean;
}

/**
 * Decide whether /authorize can mint silently, must prompt for consent, or must
 * route the user through a Telegram verify-upgrade (spec §5, §10/#9). Scope is
 * always the LIVE intersection — never minted straight from a stored max.
 */
export function consentDecision(i: ConsentDecisionInput): { action: ConsentAction; scope: string[] } {
  const scope = effectiveScope(i.priorMax ?? i.requested, i.clientAllowed, i.requested);
  if (i.verifiedOnly && !i.userVerified) return { action: "verify_upgrade", scope };

  const prompts = (i.prompt ?? "").split(/\s+/).filter(Boolean);
  const forcePrompt = prompts.includes("consent") || prompts.includes("login");
  const coveredByPrior = i.priorConsentScopes != null && isSubset(i.requested, i.priorConsentScopes);

  if (!forcePrompt && (i.firstParty || coveredByPrior)) {
    return { action: "silent", scope: effectiveScope(i.requested, i.clientAllowed, i.requested) };
  }
  return { action: "prompt", scope: effectiveScope(i.requested, i.clientAllowed, i.requested) };
}

export interface ConsentRecord {
  scopeSetMax: string[];
  approvedSnapshot: string[];
}

/** Read a stored consent grant, or null if the user has never consented. */
export async function getConsent(db: DbClient, accountId: string, clientId: string): Promise<ConsentRecord | null> {
  const res = await db.execute({
    sql: "SELECT scope_set_max, approved_scope_snapshot FROM consents WHERE account_id = ? AND client_id = ?",
    args: [accountId, clientId],
  });
  const row = res.rows[0];
  if (!row) return null;
  const parse = (v: unknown): string[] => {
    try {
      const a = JSON.parse(String(v));
      return Array.isArray(a) ? a.map(String) : [];
    } catch {
      return [];
    }
  };
  return { scopeSetMax: parse(row.scope_set_max), approvedSnapshot: parse(row.approved_scope_snapshot) };
}

/**
 * Record an "Allow": widen scope_set_max by the approved scopes (capped to what
 * the client still allows), snapshot exactly what was approved, and return the
 * live effective scope to mint.
 */
export async function grantConsent(
  db: DbClient,
  i: { accountId: string; clientId: string; requested: string[]; clientAllowed: string[]; priorMax: string[] | null },
): Promise<string[]> {
  const newMax = Array.from(new Set([...(i.priorMax ?? []), ...i.requested])).filter((s) => i.clientAllowed.includes(s));
  const scope = effectiveScope(newMax, i.clientAllowed, i.requested);
  await db.execute({
    sql: `INSERT INTO consents (account_id, client_id, scope_set_max, approved_scope_snapshot)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(account_id, client_id) DO UPDATE SET
            scope_set_max = excluded.scope_set_max,
            approved_scope_snapshot = excluded.approved_scope_snapshot,
            updated_at = datetime('now')`,
    args: [i.accountId, i.clientId, JSON.stringify(newMax), JSON.stringify(scope)],
  });
  return scope;
}

export interface Grant {
  clientId: string;
  approvedScopes: string[];
  updatedAt: string | null;
}

/** Apps a user has authorized (their connected-apps list, spec R14). */
export async function listGrants(db: DbClient, accountId: string): Promise<Grant[]> {
  const r = await db.execute({
    sql: "SELECT client_id, approved_scope_snapshot, updated_at FROM consents WHERE account_id = ?",
    args: [accountId],
  });
  return r.rows.map((row) => {
    let approvedScopes: string[] = [];
    try {
      const a = JSON.parse(String(row.approved_scope_snapshot));
      if (Array.isArray(a)) approvedScopes = a.map(String);
    } catch {
      approvedScopes = [];
    }
    return { clientId: String(row.client_id), approvedScopes, updatedAt: row.updated_at == null ? null : String(row.updated_at) };
  });
}

/** Revoke a user's grant to an app: drop consent + kill that app's live tokens for this user. */
export async function revokeGrant(db: DbClient, accountId: string, clientId: string): Promise<void> {
  // Three independent writes known up front (not a CAS) → ONE batch round-trip.
  await db.batch([
    { sql: "DELETE FROM consents WHERE account_id = ? AND client_id = ?", args: [accountId, clientId] },
    { sql: "UPDATE access_tokens SET revoked_at = datetime('now') WHERE account_id = ? AND client_id = ?", args: [accountId, clientId] },
    {
      sql: "UPDATE refresh_tokens SET used_at = datetime('now') WHERE account_id = ? AND client_id = ? AND used_at IS NULL",
      args: [accountId, clientId],
    },
  ]);
}
