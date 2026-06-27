import { CATALOG } from "@meowerse/auth-shared";
import { hashPassword, sha256Hex } from "./crypto";
import { randomId } from "./security";
import type { DbClient } from "./types";

const CLIENT_TYPES = new Set(["public", "confidential"]);
const NAME_RE = /^[a-z0-9][a-z0-9-]{2,39}$/; // stable key for IaC upsert

/** A registerable redirect_uri: https anywhere, or http only for literal loopback. No fragment/wildcard. */
export function isRegisterableRedirect(uri: string): boolean {
  if (typeof uri !== "string" || uri.includes("#") || uri.includes("*") || /\s/.test(uri)) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "[::1]")) return true;
  return false;
}

function normalizeScopes(scopes: string[]): string[] {
  const out = scopes.filter((s) => CATALOG.has(s));
  if (!out.includes("openid")) out.unshift("openid");
  return [...new Set(out)];
}

export interface CreateClientInput {
  ownerId: string;
  name: string;
  displayName?: string;
  clientType: string;
  redirectUris: string[];
  allowedScopes: string[];
  verifiedOnly?: boolean;
  allowOfflineAccess?: boolean;
}
export type CreateClientResult = { ok: true; clientId: string; clientSecret?: string } | { ok: false; error: string };

/** Register a new OAuth client owned by a developer (spec §8). Confidential clients get a one-time secret. */
export async function createClient(db: DbClient, i: CreateClientInput): Promise<CreateClientResult> {
  if (!NAME_RE.test(i.name)) return { ok: false, error: "invalid_name" };
  if (!CLIENT_TYPES.has(i.clientType)) return { ok: false, error: "invalid_client_type" };
  if (!Array.isArray(i.redirectUris) || i.redirectUris.length === 0) return { ok: false, error: "redirect_uri_required" };
  for (const uri of i.redirectUris) if (!isRegisterableRedirect(uri)) return { ok: false, error: "invalid_redirect_uri" };
  const scopes = normalizeScopes(i.allowedScopes ?? []);

  const exists = await db.execute({ sql: "SELECT 1 FROM oauth_clients WHERE name = ?", args: [i.name] });
  if (exists.rows.length) return { ok: false, error: "name_taken" };

  const clientId = "mw_" + randomId(16);
  let clientSecret: string | undefined;
  let secretPhc: string | undefined;
  if (i.clientType === "confidential") {
    clientSecret = "mws_" + randomId(32);
    secretPhc = await hashPassword(clientSecret);
  }
  await db.execute({
    sql: `INSERT INTO oauth_clients (client_id, name, owner_account_id, client_type, display_name, allowed_scopes, allow_offline_access, verified_only, first_party, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'active')`,
    args: [clientId, i.name, i.ownerId, i.clientType, i.displayName ?? i.name, JSON.stringify(scopes), i.allowOfflineAccess ? 1 : 0, i.verifiedOnly ? 1 : 0],
  });
  for (const uri of i.redirectUris) {
    await db.execute({ sql: "INSERT INTO oauth_client_redirect_uris (client_id, redirect_uri) VALUES (?, ?)", args: [clientId, uri] });
  }
  if (secretPhc) await db.execute({ sql: "INSERT INTO oauth_client_secrets (client_id, secret_phc) VALUES (?, ?)", args: [clientId, secretPhc] });
  return { ok: true, clientId, clientSecret };
}

export interface ClientSummary {
  clientId: string;
  name: string;
  displayName: string | null;
  clientType: string;
  allowedScopes: string[];
  verifiedOnly: boolean;
  status: string;
}

/** List a developer's (non-deleted) clients. */
export async function listClients(db: DbClient, ownerId: string): Promise<ClientSummary[]> {
  const r = await db.execute({
    sql: `SELECT client_id, name, display_name, client_type, allowed_scopes, verified_only, status
          FROM oauth_clients WHERE owner_account_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
    args: [ownerId],
  });
  return r.rows.map((row) => ({
    clientId: String(row.client_id),
    name: String(row.name),
    displayName: row.display_name == null ? null : String(row.display_name),
    clientType: String(row.client_type),
    allowedScopes: safeArray(row.allowed_scopes),
    verifiedOnly: Number(row.verified_only) === 1,
    status: String(row.status),
  }));
}

function safeArray(v: unknown): string[] {
  try {
    const a = JSON.parse(String(v));
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

/** Soft-delete a client (owner-scoped) and cascade-revoke its grants. Returns false if not owned/found. */
export async function deleteClient(db: DbClient, ownerId: string, clientId: string): Promise<boolean> {
  const upd = await db.execute({
    sql: "UPDATE oauth_clients SET status = 'disabled', deleted_at = datetime('now') WHERE client_id = ? AND owner_account_id = ? AND deleted_at IS NULL",
    args: [clientId, ownerId],
  });
  if ((upd.rowsAffected ?? 0) !== 1) return false;
  await db.execute({ sql: "DELETE FROM consents WHERE client_id = ?", args: [clientId] });
  await db.execute({ sql: "UPDATE access_tokens SET revoked_at = datetime('now') WHERE client_id = ?", args: [clientId] });
  return true;
}

/** Edit an existing owned client: redirect URIs, scopes, verified-only, display name (spec R15). */
export async function updateClient(
  db: DbClient,
  ownerId: string,
  i: { clientId: string; redirectUris?: string[]; allowedScopes?: string[]; verifiedOnly?: boolean; allowOfflineAccess?: boolean; displayName?: string },
): Promise<{ ok: boolean; error?: string }> {
  const own = await db.execute({
    sql: "SELECT 1 FROM oauth_clients WHERE client_id = ? AND owner_account_id = ? AND deleted_at IS NULL",
    args: [i.clientId, ownerId],
  });
  if (!own.rows.length) return { ok: false, error: "not_found" };
  if (i.redirectUris) {
    if (i.redirectUris.length === 0) return { ok: false, error: "redirect_uri_required" };
    for (const u of i.redirectUris) if (!isRegisterableRedirect(u)) return { ok: false, error: "invalid_redirect_uri" };
  }
  const scopes = i.allowedScopes ? normalizeScopes(i.allowedScopes) : undefined;
  await db.execute({
    sql: `UPDATE oauth_clients SET
            allowed_scopes = COALESCE(?, allowed_scopes),
            verified_only = COALESCE(?, verified_only),
            allow_offline_access = COALESCE(?, allow_offline_access),
            display_name = COALESCE(?, display_name),
            updated_at = datetime('now')
          WHERE client_id = ? AND owner_account_id = ?`,
    args: [
      scopes ? JSON.stringify(scopes) : null,
      i.verifiedOnly === undefined ? null : i.verifiedOnly ? 1 : 0,
      i.allowOfflineAccess === undefined ? null : i.allowOfflineAccess ? 1 : 0,
      i.displayName ?? null,
      i.clientId,
      ownerId,
    ],
  });
  if (i.redirectUris) {
    await db.execute({ sql: "DELETE FROM oauth_client_redirect_uris WHERE client_id = ?", args: [i.clientId] });
    for (const u of i.redirectUris) {
      await db.execute({ sql: "INSERT INTO oauth_client_redirect_uris (client_id, redirect_uri) VALUES (?, ?)", args: [i.clientId, u] });
    }
  }
  return { ok: true };
}

/** Rotate a confidential client's secret (owner-scoped). Returns the new one-time secret. */
export async function rotateSecret(db: DbClient, ownerId: string, clientId: string): Promise<{ ok: boolean; clientSecret?: string }> {
  const r = await db.execute({
    sql: "SELECT client_type FROM oauth_clients WHERE client_id = ? AND owner_account_id = ? AND deleted_at IS NULL",
    args: [clientId, ownerId],
  });
  const row = r.rows[0];
  if (!row || String(row.client_type) !== "confidential") return { ok: false };
  const secret = "mws_" + randomId(32);
  await db.execute({ sql: "INSERT INTO oauth_client_secrets (client_id, secret_phc) VALUES (?, ?)", args: [clientId, await hashPassword(secret)] });
  return { ok: true, clientSecret: secret };
}

/** Mint an owner-scoped management PAT (for the config-as-code provisioner). */
export async function createManagementToken(db: DbClient, ownerId: string, label?: string): Promise<string> {
  const token = "mgmt_" + randomId(32);
  await db.execute({
    sql: "INSERT INTO management_tokens (token_hash, owner_account_id, label) VALUES (?, ?, ?)",
    args: [await sha256Hex(token), ownerId, label ?? null],
  });
  return token;
}

/** Resolve a management PAT to its owner id, or null if unknown/revoked. */
export async function verifyManagementToken(db: DbClient, token: string): Promise<string | null> {
  if (!token) return null;
  const r = await db.execute({ sql: "SELECT owner_account_id, revoked_at FROM management_tokens WHERE token_hash = ?", args: [await sha256Hex(token)] });
  const row = r.rows[0];
  if (!row || row.revoked_at != null) return null;
  return String(row.owner_account_id);
}

/**
 * Idempotent upsert-by-name for the config-as-code provisioner (spec §9). Creates
 * the client if `name` is new (returning the one-time secret for confidential),
 * else updates redirect URIs + scopes + flags in place and reports `unchanged`.
 */
export async function upsertClientByName(
  db: DbClient,
  ownerId: string,
  i: Omit<CreateClientInput, "ownerId">,
): Promise<{ created: boolean; unchanged: boolean; clientId: string; clientSecret?: string } | { error: string }> {
  if (!NAME_RE.test(i.name)) return { error: "invalid_name" };
  for (const uri of i.redirectUris ?? []) if (!isRegisterableRedirect(uri)) return { error: "invalid_redirect_uri" };
  const scopes = normalizeScopes(i.allowedScopes ?? []);

  const existing = await db.execute({
    sql: "SELECT client_id, owner_account_id, allowed_scopes, verified_only, allow_offline_access, display_name FROM oauth_clients WHERE name = ? AND deleted_at IS NULL",
    args: [i.name],
  });
  const row = existing.rows[0];
  if (!row) {
    const created = await createClient(db, { ...i, ownerId });
    if (!created.ok) return { error: created.error };
    return { created: true, unchanged: false, clientId: created.clientId, clientSecret: created.clientSecret };
  }
  if (String(row.owner_account_id) !== ownerId) return { error: "not_owner" };
  const clientId = String(row.client_id);

  const current = await db.execute({ sql: "SELECT redirect_uri FROM oauth_client_redirect_uris WHERE client_id = ?", args: [clientId] });
  const curUris = current.rows.map((x) => String(x.redirect_uri)).sort();
  const wantUris = [...(i.redirectUris ?? [])].sort();
  const sameUris = curUris.length === wantUris.length && curUris.every((u, idx) => u === wantUris[idx]);
  const sameScopes = JSON.stringify(safeArray(row.allowed_scopes)) === JSON.stringify(scopes);
  const sameFlags =
    Number(row.verified_only) === (i.verifiedOnly ? 1 : 0) &&
    Number(row.allow_offline_access) === (i.allowOfflineAccess ? 1 : 0) &&
    String(row.display_name ?? "") === (i.displayName ?? i.name);
  if (sameUris && sameScopes && sameFlags) return { created: false, unchanged: true, clientId };

  await db.execute({
    sql: "UPDATE oauth_clients SET allowed_scopes = ?, verified_only = ?, allow_offline_access = ?, display_name = ?, updated_at = datetime('now') WHERE client_id = ?",
    args: [JSON.stringify(scopes), i.verifiedOnly ? 1 : 0, i.allowOfflineAccess ? 1 : 0, i.displayName ?? i.name, clientId],
  });
  await db.execute({ sql: "DELETE FROM oauth_client_redirect_uris WHERE client_id = ?", args: [clientId] });
  for (const uri of i.redirectUris ?? []) {
    await db.execute({ sql: "INSERT INTO oauth_client_redirect_uris (client_id, redirect_uri) VALUES (?, ?)", args: [clientId, uri] });
  }
  return { created: false, unchanged: false, clientId };
}
