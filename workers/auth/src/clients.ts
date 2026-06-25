import type { DbClient } from "./types";

/** A client plus its registered redirect URIs and parsed allowed scopes. */
export interface LoadedClient {
  clientId: string;
  status: string;
  clientType: string;
  displayName: string | null;
  logoUrl: string | null;
  allowedScopes: string[];
  verifiedOnly: boolean;
  firstParty: boolean;
  redirectUris: string[];
}

/** Load a client by id (spec §8). Returns null for unknown ids. */
export async function getClient(db: DbClient, clientId: string): Promise<LoadedClient | null> {
  if (!clientId) return null;
  const c = await db.execute({
    sql: `SELECT client_id, status, client_type, display_name, logo_url, allowed_scopes, verified_only, first_party
          FROM oauth_clients WHERE client_id = ?`,
    args: [clientId],
  });
  const row = c.rows[0];
  if (!row) return null;
  const r = await db.execute({
    sql: "SELECT redirect_uri FROM oauth_client_redirect_uris WHERE client_id = ?",
    args: [clientId],
  });
  let allowedScopes: string[] = [];
  try {
    const parsed = JSON.parse(String(row.allowed_scopes));
    if (Array.isArray(parsed)) allowedScopes = parsed.map((s) => String(s));
  } catch {
    allowedScopes = [];
  }
  return {
    clientId: String(row.client_id),
    status: String(row.status),
    clientType: String(row.client_type),
    displayName: row.display_name == null ? null : String(row.display_name),
    logoUrl: row.logo_url == null ? null : String(row.logo_url),
    allowedScopes,
    verifiedOnly: Number(row.verified_only) === 1,
    firstParty: Number(row.first_party) === 1,
    redirectUris: r.rows.map((x) => String(x.redirect_uri)),
  };
}
