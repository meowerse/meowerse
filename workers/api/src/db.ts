import { createClient } from "@libsql/client/web";
import type { DbClient, Env } from "./types";

/**
 * CREATE TABLE statement. Identical columns/shape to the Go api
 * (apps/api/internal/meow/sqlite_store.go) so both backends speak the same DB.
 */
export const SCHEMA = `CREATE TABLE IF NOT EXISTS meows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

/**
 * Dependencies injected into the request handler. Tests pass a fake `getDb` and
 * leave `schemaReady` unset; production uses the real libsql client and caches
 * the migration promise on a module-level Deps object so the migration runs at
 * most ONCE per isolate (not per request) — important for CPU/quota budget.
 */
export interface Deps {
  getDb: () => DbClient;
  schemaReady?: Promise<void>;
}

/** Build the production Deps from env, lazily creating one libsql/web client. */
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

/**
 * Ensure the schema exists, running the migration at most once per Deps object
 * (i.e. once per isolate) by memoizing the promise. Concurrent requests during
 * cold start share the single in-flight promise.
 */
export function ensureSchema(deps: Deps): Promise<void> {
  deps.schemaReady ??= deps.getDb().execute(SCHEMA).then(() => undefined);
  return deps.schemaReady;
}
