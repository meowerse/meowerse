/**
 * Runtime environment bindings. DATABASE_URL, DATABASE_AUTH_TOKEN and
 * API_TOKEN are Worker SECRETS (set via `wrangler secret put`), never in
 * wrangler.jsonc. CORS_ORIGINS is a plain var with a safe default.
 */
export interface Env {
  CORS_ORIGINS?: string;
  API_TOKEN?: string;
  DATABASE_URL?: string;
  DATABASE_AUTH_TOKEN?: string;
}

/** A single posted meow. Mirrors the Go struct / TS Meow interface exactly. */
export interface Meow {
  id: number;
  text: string;
  slug: string;
  created_at: string;
}

/**
 * Minimal libsql client surface the handlers depend on. Declaring our own
 * structural type (instead of importing @libsql/client's) lets tests inject a
 * tiny fake without pulling the real driver into the test runtime.
 */
export interface DbClient {
  execute(
    stmt: string | { sql: string; args: unknown[] },
  ): Promise<{ rows: Record<string, unknown>[]; lastInsertRowid?: bigint | number }>;
}
