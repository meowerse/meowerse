import { createClient } from "@libsql/client/web";
import type { DbClient, Env } from "./types";

/**
 * The full slice-1 schema (spec §4). Additive `CREATE … IF NOT EXISTS`, so
 * re-running is a no-op. Tables that only get written from later slices
 * (telegram_links, refresh_tokens, login_tickets, …) are created now so the
 * shape is stable and migrations stay strictly additive. Every statement is one
 * `execute` call; ensureSchema runs them once per isolate.
 */
export const SCHEMA: string[] = [
  // --- Identity ---
  `CREATE TABLE IF NOT EXISTS accounts (
    id           TEXT PRIMARY KEY,
    username     TEXT UNIQUE,
    display_name TEXT, avatar_url TEXT,
    verified     INTEGER NOT NULL DEFAULT 0,
    identity_epoch INTEGER NOT NULL DEFAULT 0,
    token_version  INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS password_credentials (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    phc        TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS telegram_links (
    telegram_id       INTEGER PRIMARY KEY,
    account_id        TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
    telegram_username TEXT, display_name TEXT, avatar_url TEXT,
    linked_at TEXT DEFAULT (datetime('now')), updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS recovery_codes (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    used_at    TEXT, PRIMARY KEY (account_id, code_hash)
  )`,
  // --- Sessions ---
  `CREATE TABLE IF NOT EXISTS sessions (
    id_hash    TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    auth_time  INTEGER NOT NULL,
    amr        TEXT,
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen  TEXT NOT NULL DEFAULT (datetime('now')),
    idle_expires_at     INTEGER NOT NULL,
    absolute_expires_at INTEGER NOT NULL,
    revoked_at TEXT
  )`,
  // --- Authorization request object (state preservation) ---
  `CREATE TABLE IF NOT EXISTS login_requests (
    rid            TEXT PRIMARY KEY,
    owner_hash     TEXT NOT NULL,
    client_id      TEXT NOT NULL, redirect_uri TEXT NOT NULL, scope TEXT NOT NULL,
    state TEXT, nonce TEXT, code_challenge TEXT NOT NULL, code_challenge_method TEXT NOT NULL DEFAULT 'S256',
    prompt TEXT, max_age INTEGER, login_hint TEXT,
    account_id TEXT,
    step       TEXT NOT NULL DEFAULT 'awaiting_login',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at INTEGER NOT NULL, consumed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_login_requests_exp ON login_requests(expires_at)`,
  // --- Authorization codes ---
  `CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash  TEXT PRIMARY KEY,
    client_id  TEXT NOT NULL, redirect_uri TEXT NOT NULL, scope TEXT NOT NULL,
    nonce TEXT, code_challenge TEXT NOT NULL, code_challenge_method TEXT NOT NULL,
    account_id TEXT NOT NULL, session_id_hash TEXT NOT NULL, auth_time INTEGER NOT NULL,
    jti_family TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at INTEGER NOT NULL,
    consumed_at TEXT
  )`,
  // --- Token revocation index + refresh (refresh = slice 2) ---
  `CREATE TABLE IF NOT EXISTS access_tokens (
    jti TEXT PRIMARY KEY, account_id TEXT NOT NULL, client_id TEXT NOT NULL,
    scope TEXT NOT NULL, family_id TEXT NOT NULL,
    issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    family_id  TEXT NOT NULL, client_id TEXT NOT NULL, account_id TEXT NOT NULL, scope TEXT NOT NULL,
    prev_id TEXT, used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idle_expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id)`,
  // --- Clients / consent ---
  `CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id    TEXT PRIMARY KEY,
    name         TEXT UNIQUE NOT NULL,
    owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    client_type  TEXT NOT NULL CHECK(client_type IN ('public','confidential')),
    display_name TEXT, logo_url TEXT, homepage_url TEXT, privacy_policy_url TEXT, description TEXT,
    allowed_scopes TEXT NOT NULL,
    allow_offline_access INTEGER NOT NULL DEFAULT 0,
    verified_only INTEGER NOT NULL DEFAULT 0,
    first_party   INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
    rate_limit_per_min INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT, deleted_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_client_redirect_uris (
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    PRIMARY KEY (client_id, redirect_uri)
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_client_secrets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    secret_phc TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), not_after TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS consents (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    client_id  TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    scope_set_max TEXT NOT NULL,
    approved_scope_snapshot TEXT NOT NULL,
    granted_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT,
    PRIMARY KEY (account_id, client_id)
  )`,
  `CREATE TABLE IF NOT EXISTS management_tokens (
    token_hash TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), revoked_at TEXT
  )`,
  // --- Telegram ticket (slice 2) ---
  `CREATE TABLE IF NOT EXISTS login_tickets (
    ticket_id  TEXT PRIMARY KEY, nonce_hash TEXT NOT NULL,
    owner_hash TEXT NOT NULL,
    kind   TEXT NOT NULL CHECK(kind IN ('SIGNIN_OR_SIGNUP','VERIFY_EXISTING','RESET_APPROVAL')),
    status TEXT NOT NULL DEFAULT 'pending',
    account_id TEXT,
    rid TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_status ON login_tickets(status, expires_at)`,
  // --- Abuse counters / audit ---
  `CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL, last_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL DEFAULT (datetime('now')),
    event TEXT NOT NULL, account_id TEXT, client_id TEXT, ip_trunc TEXT, ua_hash TEXT
  )`,
];

/**
 * Idempotent seed (spec §12): a system account + one demo OAuth client so the
 * end-to-end loop is exercisable immediately. `INSERT OR IGNORE` keeps it a
 * no-op on every subsequent isolate. The demo client is third-party
 * (`first_party=0`) so the consent screen is shown — the point of slice 1.
 */
export const SEED: string[] = [
  `INSERT OR IGNORE INTO accounts (id, username, display_name, verified)
     VALUES ('acct_system', 'meowerse', 'Meowerse', 1)`,
  `INSERT OR IGNORE INTO oauth_clients
     (client_id, name, owner_account_id, client_type, display_name, allowed_scopes, verified_only, first_party, status)
     VALUES ('mw_demo', 'meowerse-demo', 'acct_system', 'public', 'Meowerse Demo', '["openid","profile"]', 0, 0, 'active')`,
  `INSERT OR IGNORE INTO oauth_client_redirect_uris (client_id, redirect_uri)
     VALUES ('mw_demo', 'http://localhost:4321/callback')`,
];

/** All migration statements, run in order: DDL then seed. */
export const STATEMENTS: string[] = [...SCHEMA, ...SEED];

/**
 * Dependencies injected into request handlers. Tests pass a fake `getDb` and
 * leave `schemaReady` unset; production uses the real libsql client and caches
 * the migration promise so it runs at most ONCE per isolate.
 */
export interface Deps {
  getDb: () => DbClient;
  schemaReady?: Promise<void>;
  /** Unix-seconds clock; injected in tests for determinism. Defaults to wall time. */
  clock?: () => number;
  /** Outbound fetch (Turnstile siteverify). Injectable so tests never hit the network; defaults to global fetch. */
  fetch?: typeof fetch;
}

/** Build production Deps from env, lazily creating one libsql/web client. */
export function prodDeps(env: Env): Deps {
  let client: DbClient | undefined;
  return {
    getDb() {
      client ??= createClient({
        url: env.DATABASE_URL!,
        authToken: env.DATABASE_AUTH_TOKEN,
      }) as unknown as DbClient;
      return client;
    },
  };
}

/** Run every migration statement once per Deps object (once per isolate). */
export function ensureSchema(deps: Deps): Promise<void> {
  deps.schemaReady ??= (async () => {
    const db = deps.getDb();
    for (const stmt of STATEMENTS) await db.execute(stmt);
  })();
  return deps.schemaReady;
}
