import { CATALOG } from "@meowerse/auth-shared";
import { hashPassword, sha256Hex } from "./crypto";
import { randomId } from "./security";
import { accountPresent, guardedInsert, type Guard, type Stmt } from "./codeguard";
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

/**
 * Names reserved for the first-party apps. The consent screen shows a client's display name, so a third-party
 * client must not be able to present itself as "Meowsenger"/"Meowerse" (phishing the consent grant).
 *
 * Matching rule (isReservedBrand):
 *  0. Format characters (\p{Cf}, except ZWJ/ZWNJ) are rejected outright. The value is NFKD-normalised and its
 *     default-ignorable code points (ZWSP, soft hyphen, ZWJ, ...) are removed BEFORE anything else.
 *  1. Lowercase, then split into tokens at anything that is not a letter, digit, combining mark or one of the
 *     leetspeak symbols (@ $ ! |): spaces, hyphens, dots, underscores separate tokens.
 *  2. Fold each token to a Latin skeleton: NFKD (full-width/compat forms), combining marks dropped, common
 *     Cyrillic/Greek lookalikes and leetspeak digits/symbols (0 1 3 4 5 7 @ $ ! |) mapped to Latin. A token that
 *     is ALSO written with Latin letters has every remaining letter that can pose as a Latin one (any non-ASCII
 *     Latin-script letter such as o-slash/alpha, or Armenian, Cyrillic, Greek, Cherokee, Coptic, Georgian) turned into
 *     a wildcard; a hit may contain at most 2 wildcard positions. Letters of other scripts (CJK, ...) are dropped, so
 *     "Meow<katakana>" is fine. Letters of other scripts in a token with no Latin at all are dropped. Two variants are tried per token: as folded, and with "rn"->"m", "vv"->"w".
 *  3. Concatenate the tokens' skeletons and look for a reserved brand. A hit counts ONLY if it lies inside a
 *     single token ("meowerseapp", "my-meowerse"), or spans several tokens that it covers completely, from the
 *     first token's start to the last token's end ("Meow senger", "sun-meow", "m e o w s e n g e r"). A hit that
 *     starts or ends in the MIDDLE of a token it merely straddles is ignored, so "Meowers Events"
 *     (meowers|events -> "meowerse" straddles "events") and bilingual names like "\u041c\u043e\u0439 Blog" are allowed.
 * Exempt: the system account, accounts listed in BRAND_OWNER_ACCOUNT_IDS, and edits that leave an existing row's
 * name / display name exactly as it already is.
 */
const RESERVED_BRANDS = ["meowsenger", "meowerse", "moonmeow", "sunmeow", "alxnko"];
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x",
  "і": "i", "ј": "j", "ѕ": "s", "ӏ": "l", "ѡ": "w", "ԁ": "d", "ԛ": "q", "ɡ": "g",
  // Greek
  "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "μ": "u", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ω": "w", "ϲ": "c",
  // leetspeak / symbols
  "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i", "|": "l",
};
// Letters that can pose as a Latin letter: any non-ASCII Latin-script letter (o-slash, alpha, l-tilde, ...) and the
// scripts with real lookalikes. CJK, Thai, etc. are NOT here: they are dropped, never wildcarded (no false positives
// for "Meow<katakana>" names).
const LOOKALIKE_LETTER = /^[\p{Script=Latin}\p{Script=Armenian}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Cherokee}\p{Script=Coptic}\p{Script=Georgian}]$/u;
const MAX_WILDCARDS = 2; // wildcard positions allowed inside one brand hit
const BRAND_TOKEN_SPLIT = /[^\p{L}\p{N}\p{M}@$!|]+/u;

/** Latin skeleton of one token; lookalike-script letters (outside a-z) become "?" when Latin letters are present. */
function foldToken(token: string): string {
  let out = "";
  for (const ch of token.normalize("NFKD").replace(/\p{M}/gu, "")) out += CONFUSABLES[ch] ?? ch;
  if (/[a-z]/.test(out)) {
    let w = "";
    for (const ch of out) w += /\p{L}/u.test(ch) && !/[a-z]/.test(ch) && LOOKALIKE_LETTER.test(ch) ? "?" : ch;
    return w.replace(/[^a-z0-9?]/g, "");
  }
  return out.replace(/[^a-z0-9]/g, "");
}

function brandAt(hay: string, at: number, brand: string): boolean {
  let wild = 0;
  for (let k = 0; k < brand.length; k++) {
    const c = hay[at + k];
    if (c === "?") {
      if (++wild > MAX_WILDCARDS) return false;
    } else if (c !== brand[k]) return false;
  }
  return true;
}

function hasBrand(tokens: string[]): boolean {
  const starts = new Set<number>();
  const ends = new Set<number>();
  const owner: number[] = []; // char index -> token index
  let hay = "";
  tokens.forEach((t, ti) => {
    starts.add(hay.length);
    for (let k = 0; k < t.length; k++) owner.push(ti);
    hay += t;
    ends.add(hay.length);
  });
  for (const b of RESERVED_BRANDS) {
    for (let i = 0; i + b.length <= hay.length; i++) {
      if (!brandAt(hay, i, b)) continue;
      const j = i + b.length;
      if (owner[i] === owner[j - 1] || (starts.has(i) && ends.has(j))) return true;
    }
  }
  return false;
}

export function isReservedBrand(value: string | undefined): boolean {
  if (!value) return false;
  // Format characters other than ZWJ/ZWNJ (zero-width space, soft hyphen, bidi marks, ...) have no place in a
  // client name and are used to split a brand into harmless-looking tokens: reject them outright.
  if (/(?![\u200c\u200d])\p{Cf}/u.test(value)) return true;
  // NFKD first (circled/full-width/compat letters -> Latin), then drop invisible default-ignorable code points
  // (ZWSP, soft hyphen, ZWJ, ...) so they cannot split tokens.
  value = value.normalize("NFKD").replace(/\p{Default_Ignorable_Code_Point}/gu, "");
  const tokens = value.toLowerCase().split(BRAND_TOKEN_SPLIT).filter(Boolean).map(foldToken).filter(Boolean);
  if (tokens.length === 0) return false;
  return hasBrand(tokens) || hasBrand(tokens.map((t) => t.replace(/rn/g, "m").replace(/vv/g, "w")));
}
const SYSTEM_OWNER = "acct_system";

/** Parse BRAND_OWNER_ACCOUNT_IDS (comma-separated account ids; empty/unset = none). */
export function brandOwnerIds(raw: string | undefined): ReadonlySet<string> {
  return new Set((raw ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}
export interface BrandOpts {
  /** Extra accounts exempt from the reserved-brand check (besides acct_system). */
  brandOwners?: ReadonlySet<string>;
}
const brandExempt = (ownerId: string, o: BrandOpts) => ownerId === SYSTEM_OWNER || (o.brandOwners?.has(ownerId) ?? false);


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
export async function createClient(db: DbClient, i: CreateClientInput, opts: BrandOpts = {}): Promise<CreateClientResult> {
  if (!NAME_RE.test(i.name)) return { ok: false, error: "invalid_name" };
  if (!brandExempt(i.ownerId, opts) && (isReservedBrand(i.name) || isReservedBrand(i.displayName))) return { ok: false, error: "reserved_name" };
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
  // ONE write transaction: the client row is guarded on its owner still existing, and the redirect
  // URIs / secret are guarded on that client row existing, so a deleted owner leaves nothing behind.
  const clientExists: Guard = { sql: "EXISTS (SELECT 1 FROM oauth_clients WHERE client_id = ?)", args: [clientId] };
  const stmts: Stmt[] = [
    guardedInsert(
      "oauth_clients",
      "client_id, name, owner_account_id, client_type, display_name, allowed_scopes, allow_offline_access, verified_only, first_party, status",
      "?, ?, ?, ?, ?, ?, ?, ?, 0, 'active'",
      [clientId, i.name, i.ownerId, i.clientType, i.displayName ?? i.name, JSON.stringify(scopes), i.allowOfflineAccess ? 1 : 0, i.verifiedOnly ? 1 : 0],
      accountPresent(i.ownerId),
    ),
  ];
  for (const uri of i.redirectUris) {
    stmts.push(guardedInsert("oauth_client_redirect_uris", "client_id, redirect_uri", "?, ?", [clientId, uri], clientExists));
  }
  if (secretPhc) stmts.push(guardedInsert("oauth_client_secrets", "client_id, secret_phc", "?, ?", [clientId, secretPhc], clientExists));
  const res = await db.batch(stmts, "write");
  if ((res[0]?.rowsAffected ?? 0) !== 1) return { ok: false, error: "account_gone" };
  return { ok: true, clientId, clientSecret };
}

export interface ClientSummary {
  clientId: string;
  name: string;
  displayName: string | null;
  clientType: string;
  allowedScopes: string[];
  verifiedOnly: boolean;
  allowOfflineAccess: boolean;
  status: string;
}

/** List a developer's (non-deleted) clients. */
export async function listClients(db: DbClient, ownerId: string): Promise<ClientSummary[]> {
  const r = await db.execute({
    sql: `SELECT client_id, name, display_name, client_type, allowed_scopes, verified_only, allow_offline_access, status
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
    allowOfflineAccess: Number(row.allow_offline_access) === 1,
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
  opts: BrandOpts = {},
): Promise<{ ok: boolean; error?: string }> {
  const own = await db.execute({
    sql: "SELECT 1 FROM oauth_clients WHERE client_id = ? AND owner_account_id = ? AND deleted_at IS NULL",
    args: [i.clientId, ownerId],
  });
  if (!own.rows.length) return { ok: false, error: "not_found" };
  if (!brandExempt(ownerId, opts) && isReservedBrand(i.displayName)) {
    // Re-sending the display name the row ALREADY has is not a new claim to a brand (dashboard edits resend it).
    const same = await db.execute({ sql: "SELECT display_name FROM oauth_clients WHERE client_id = ? AND display_name = ?", args: [i.clientId, i.displayName] });
    if (!same.rows.length) return { ok: false, error: "reserved_name" };
  }
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
  const ins = guardedInsert(
    "oauth_client_secrets",
    "client_id, secret_phc",
    "?, ?",
    [clientId, await hashPassword(secret)],
    { sql: "EXISTS (SELECT 1 FROM oauth_clients c JOIN accounts a ON a.id = c.owner_account_id WHERE c.client_id = ? AND c.owner_account_id = ?)", args: [clientId, ownerId] },
  );
  if ((await db.execute(ins)).rowsAffected !== 1) return { ok: false };
  return { ok: true, clientSecret: secret };
}

/** Mint an owner-scoped management PAT (for the config-as-code provisioner). */
export async function createManagementToken(db: DbClient, ownerId: string, label?: string): Promise<string | null> {
  const token = "mgmt_" + randomId(32);
  const st = guardedInsert("management_tokens", "token_hash, owner_account_id, label", "?, ?, ?", [await sha256Hex(token), ownerId, label ?? null], accountPresent(ownerId));
  const r = await db.execute(st);
  return r.rowsAffected === 1 ? token : null; // null: the owner account no longer exists
}

/** Resolve a management PAT to its owner id, or null if unknown/revoked. */
export async function verifyManagementToken(db: DbClient, token: string): Promise<string | null> {
  if (!token) return null;
  const r = await db.execute({
    sql: `SELECT owner_account_id, revoked_at FROM management_tokens WHERE token_hash = ?
          AND EXISTS (SELECT 1 FROM accounts WHERE id = management_tokens.owner_account_id)`,
    args: [await sha256Hex(token)],
  });
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
  opts: BrandOpts = {},
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
    // createClient applies the brand check to a genuinely new row.
    const created = await createClient(db, { ...i, ownerId }, opts);
    if (!created.ok) return { error: created.error }; // includes account_gone
    return { created: true, unchanged: false, clientId: created.clientId, clientSecret: created.clientSecret };
  }
  if (String(row.owner_account_id) !== ownerId) return { error: "not_owner" };
  // Existing row: its name is by definition unchanged, so only a CHANGED display name is a new brand claim
  // (an exact-name no-op re-provision, e.g. Meowsenger's, must keep working).
  if (!brandExempt(ownerId, opts) && isReservedBrand(i.displayName) && String(row.display_name ?? "") !== i.displayName) return { error: "reserved_name" };
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
