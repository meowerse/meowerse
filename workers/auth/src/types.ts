/**
 * Runtime environment bindings. DATABASE_URL, DATABASE_AUTH_TOKEN and
 * AUTH_SIGNING_KEYS are Worker SECRETS (set via `wrangler secret put`); the rest
 * are plain vars with safe defaults baked into wrangler.jsonc.
 */
export interface Env {
  CORS_ORIGINS?: string;
  ISSUER?: string;
  WEB_ORIGIN?: string;
  RESOURCE_AUD?: string;
  DATABASE_URL?: string;
  DATABASE_AUTH_TOKEN?: string;
  AUTH_SIGNING_KEYS?: string;
  STATE_SECRET?: string;
  BOT_USERNAME?: string;
  TELEGRAM_BOT_TOKEN?: string;
  INTERNAL_HMAC_KEY?: string;
  WRITE_BUDGET_PER_MIN?: string;
  SKIP_MIGRATIONS?: string;
  /** Cloudflare Turnstile secret (bot protection on /signup + /login). Unset ⇒ disabled. */
  TURNSTILE_SECRET_KEY?: string;
}

/**
 * Minimal libsql client surface the worker depends on. Declaring our own
 * structural type (instead of importing @libsql/client's) lets tests inject a
 * tiny fake without pulling the real driver into the test runtime. Mirrors
 * workers/api, plus `rowsAffected` for single-use UPDATE/DELETE consume checks.
 */
export interface DbClient {
  execute(stmt: string | { sql: string; args: unknown[] }): Promise<{
    rows: Record<string, unknown>[];
    rowsAffected?: number;
    lastInsertRowid?: bigint | number;
  }>;
}

export interface AccountRow {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  verified: number;
  identity_epoch: number;
  token_version: number;
}

export interface OAuthClientRow {
  client_id: string;
  name: string;
  owner_account_id: string;
  client_type: "public" | "confidential";
  display_name: string | null;
  logo_url: string | null;
  allowed_scopes: string;
  verified_only: number;
  first_party: number;
  status: "active" | "disabled";
}

export interface SessionRow {
  id_hash: string;
  account_id: string;
  auth_time: number;
  amr: string | null;
  csrf_token: string;
  idle_expires_at: number;
  absolute_expires_at: number;
  revoked_at: string | null;
}

export interface ConsentRow {
  account_id: string;
  client_id: string;
  scope_set_max: string;
  approved_scope_snapshot: string;
}

export interface OAuthCodeRow {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  nonce: string | null;
  code_challenge: string;
  code_challenge_method: string;
  account_id: string;
  session_id_hash: string;
  auth_time: number;
  jti_family: string;
  expires_at: number;
}
