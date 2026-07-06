import { verifyPassword } from "./crypto";
import type { DbClient } from "./types";

/**
 * Authenticate a client at the token/revoke/introspect endpoints (RFC 6749 §2.3,
 * RFC 9700). Public clients carry no secret (PKCE is their proof). Confidential
 * clients MUST present a secret matching a stored (non-expired) PBKDF2 hash —
 * constant-time via verifyPassword. Returns invalid_client on any mismatch.
 */
export async function authenticateClient(
  db: DbClient,
  clientId: string,
  clientSecret: string | undefined,
): Promise<{ ok: boolean; clientType?: string; error?: string }> {
  if (!clientId) return { ok: false, error: "invalid_client" };
  const c = await db.execute({
    sql: "SELECT client_type, status FROM oauth_clients WHERE client_id = ? AND deleted_at IS NULL",
    args: [clientId],
  });
  const row = c.rows[0];
  if (!row || String(row.status) !== "active") return { ok: false, error: "invalid_client" };
  const clientType = String(row.client_type);
  if (clientType === "public") return { ok: true, clientType };
  if (!clientSecret) return { ok: false, error: "invalid_client" };
  const secs = await db.execute({
    sql: "SELECT secret_phc FROM oauth_client_secrets WHERE client_id = ? AND (not_after IS NULL OR not_after > datetime('now'))",
    args: [clientId],
  });
  for (const s of secs.rows) {
    if (await verifyPassword(clientSecret, String(s.secret_phc))) return { ok: true, clientType };
  }
  return { ok: false, error: "invalid_client" };
}

/** A client plus its registered redirect URIs and parsed allowed scopes. */
export interface LoadedClient {
  clientId: string;
  status: string;
  clientType: string;
  displayName: string | null;
  logoUrl: string | null;
  allowedScopes: string[];
  allowOfflineAccess: boolean;
  verifiedOnly: boolean;
  firstParty: boolean;
  redirectUris: string[];
}

/** Load a client by id (spec §8). Returns null for unknown ids. */
export async function getClient(db: DbClient, clientId: string): Promise<LoadedClient | null> {
  if (!clientId) return null;
  // One round-trip: the client row + its redirect URIs as a JSON array
  // (json_group_array over zero rows yields '[]'). Was 2 sequential hops.
  const c = await db.execute({
    sql: `SELECT client_id, status, client_type, display_name, logo_url, allowed_scopes, allow_offline_access, verified_only, first_party,
                 (SELECT json_group_array(redirect_uri) FROM oauth_client_redirect_uris WHERE client_id = ?) AS redirect_uris
          FROM oauth_clients WHERE client_id = ?`,
    args: [clientId, clientId],
  });
  const row = c.rows[0];
  if (!row) return null;
  const parseArr = (v: unknown): string[] => {
    try {
      const p = JSON.parse(String(v ?? "[]"));
      return Array.isArray(p) ? p.map(String) : [];
    } catch {
      return [];
    }
  };
  return {
    clientId: String(row.client_id),
    status: String(row.status),
    clientType: String(row.client_type),
    displayName: row.display_name == null ? null : String(row.display_name),
    logoUrl: row.logo_url == null ? null : String(row.logo_url),
    allowedScopes: parseArr(row.allowed_scopes),
    allowOfflineAccess: Number(row.allow_offline_access) === 1,
    verifiedOnly: Number(row.verified_only) === 1,
    firstParty: Number(row.first_party) === 1,
    redirectUris: parseArr(row.redirect_uris),
  };
}
