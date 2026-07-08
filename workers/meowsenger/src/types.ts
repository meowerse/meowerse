export interface Env {
  DB: D1Database;                 // D1 binding (wrangler.jsonc)
  CONVERSATION?: DurableObjectNamespace; // one Conversation DO per chat (Slice 2)
  ASSETS?: Fetcher;               // static-assets binding (serves the Astro UI)
  OIDC_ISSUER?: string;           // https://auth.alxnko.eu.org
  OIDC_CLIENT_ID?: string;        // from provision (public)
  OIDC_CLIENT_SECRET?: string;    // from provision (secret)
  OIDC_REDIRECT_URI?: string;     // https://meowsenger.alxnko.eu.org/auth/callback
  WEB_ORIGIN?: string;            // https://meowsenger.alxnko.eu.org
  CORS_ORIGINS?: string;          // allowlist incl. the UI origin + localhost
  // Web Push (VAPID). PUBLIC key is a var (also served to the browser as the
  // applicationServerKey); PRIVATE key (JWK) is a secret; SUBJECT is a mailto/https.
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
  VAPID_SUBJECT?: string;
}

export type Row = Record<string, unknown>;
export interface DbClient {
  all(sql: string, params?: unknown[]): Promise<Row[]>;
  first(sql: string, params?: unknown[]): Promise<Row | undefined>;
  run(sql: string, params?: unknown[]): Promise<void>;
}
