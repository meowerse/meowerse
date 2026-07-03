import type { SigningKeyRecord } from "../src/keys";
import type { DbClient } from "../src/types";

type Row = Record<string, unknown>;
type DbResult = { rows: Row[]; rowsAffected?: number; lastInsertRowid?: number };
export type Route = [RegExp, (args: unknown[]) => DbResult | void];

/**
 * A statement-routed fake DbClient. Each route is [pattern, handler]; the first
 * pattern that matches the SQL wins, and the handler returns rows (or void →
 * empty). Every call is appended to `log` so tests can assert what ran. Keeps
 * DB-dependent unit tests declarative without a real Turso.
 */
export function routedDb(routes: Route[], log: { sql: string; args: unknown[] }[] = []): DbClient {
  return {
    execute: async (stmt) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      const args = typeof stmt === "string" ? [] : stmt.args;
      log.push({ sql, args });
      for (const [re, fn] of routes) {
        if (re.test(sql)) return fn(args) ?? { rows: [] };
      }
      return { rows: [] };
    },
  };
}

/** Pull a cookie value out of a Set-Cookie header (test helper). */
export function cookieValue(setCookie: string | null, name: string): string | undefined {
  if (!setCookie) return undefined;
  const m = new RegExp(`${name}=([^;]*)`).exec(setCookie);
  return m ? m[1] : undefined;
}

/**
 * A small STATEFUL in-memory DbClient covering exactly the statements this
 * worker emits — enough to drive the full signup→authorize→consent→token→
 * userinfo loop end-to-end without a real Turso. Handlers are written against
 * the worker's own SQL, so they track the real column order.
 */
export function memStore(): { db: DbClient; tables: Record<string, Row[]> } {
  const t: Record<string, Row[]> = {
    accounts: [],
    password_credentials: [],
    recovery_codes: [],
    telegram_links: [],
    sessions: [],
    oauth_codes: [],
    access_tokens: [],
    refresh_tokens: [],
    oauth_clients: [],
    oauth_client_redirect_uris: [],
    oauth_client_secrets: [],
    consents: [],
    rate_limits: [],
    login_tickets: [],
  };
  const db: DbClient = {
    execute: async (stmt) => {
      const raw = typeof stmt === "string" ? stmt : stmt.sql;
      const a = typeof stmt === "string" ? [] : stmt.args;
      const sql = raw.replace(/\s+/g, " ").trim();

      if (/^CREATE /i.test(sql)) return { rows: [] };

      // --- account self-service (specific patterns first so they win) ---
      if (/UPDATE password_credentials SET phc/.test(sql)) {
        const row = t.password_credentials.find((r) => r.account_id === a[1]);
        if (row) row.phc = a[0];
        return { rows: [] };
      }
      if (/DELETE FROM recovery_codes WHERE account_id/.test(sql)) {
        t.recovery_codes = t.recovery_codes.filter((r) => r.account_id !== a[0]);
        return { rows: [] };
      }
      if (/SELECT COUNT\(\*\) AS n FROM recovery_codes/.test(sql))
        return { rows: [{ n: t.recovery_codes.filter((r) => r.account_id === a[0] && r.used_at == null).length }] };
      if (/SELECT client_id, approved_scope_snapshot, updated_at FROM consents WHERE account_id/.test(sql))
        return { rows: t.consents.filter((r) => r.account_id === a[0]).map((r) => ({ client_id: r.client_id, approved_scope_snapshot: r.approved_scope_snapshot, updated_at: null })) };
      if (/DELETE FROM consents WHERE account_id/.test(sql)) {
        t.consents = t.consents.filter((r) => !(r.account_id === a[0] && r.client_id === a[1]));
        return { rows: [] };
      }
      if (/UPDATE access_tokens SET revoked_at .* WHERE account_id/.test(sql)) {
        for (const r of t.access_tokens) if (r.account_id === a[0] && r.client_id === a[1]) r.revoked_at = "revoked";
        return { rows: [] };
      }
      if (/UPDATE refresh_tokens SET used_at .* WHERE account_id/.test(sql)) {
        for (const r of t.refresh_tokens) if (r.account_id === a[0] && r.client_id === a[1]) r.used_at = "used";
        return { rows: [] };
      }
      if (/DELETE FROM telegram_links WHERE account_id/.test(sql)) {
        t.telegram_links = t.telegram_links.filter((r) => r.account_id !== a[0]);
        return { rows: [] };
      }
      if (/DELETE FROM sessions WHERE account_id/.test(sql)) {
        t.sessions = t.sessions.filter((r) => r.account_id !== a[0]);
        return { rows: [] };
      }
      if (/DELETE FROM accounts WHERE id/.test(sql)) {
        t.accounts = t.accounts.filter((r) => r.id !== a[0]);
        return { rows: [] };
      }
      if (/UPDATE accounts SET verified = 0/.test(sql)) {
        const row = t.accounts.find((r) => r.id === a[0]);
        if (row) row.verified = 0;
        return { rows: [] };
      }

      // --- seed (INSERT OR IGNORE) ---
      if (/INSERT OR IGNORE INTO accounts/.test(sql)) {
        if (!t.accounts.some((r) => r.id === "acct_system"))
          t.accounts.push({ id: "acct_system", username: "meowerse", display_name: "Meowerse", avatar_url: null, verified: 1 });
        return { rows: [] };
      }
      if (/INSERT OR IGNORE INTO oauth_clients/.test(sql)) {
        if (!t.oauth_clients.some((r) => r.client_id === "mw_demo"))
          t.oauth_clients.push({
            client_id: "mw_demo",
            status: "active",
            client_type: "public",
            display_name: "Meowerse Demo",
            logo_url: null,
            allowed_scopes: '["openid","profile"]',
            verified_only: 0,
            first_party: 0,
          });
        return { rows: [] };
      }
      if (/INSERT OR IGNORE INTO oauth_client_redirect_uris/.test(sql)) {
        if (!t.oauth_client_redirect_uris.some((r) => r.redirect_uri === "http://localhost:4321/callback"))
          t.oauth_client_redirect_uris.push({ client_id: "mw_demo", redirect_uri: "http://localhost:4321/callback" });
        return { rows: [] };
      }

      // --- clients ---
      if (/FROM oauth_clients WHERE client_id/.test(sql))
        return { rows: t.oauth_clients.filter((r) => r.client_id === a[0]) };
      if (/FROM oauth_client_redirect_uris WHERE client_id/.test(sql))
        return { rows: t.oauth_client_redirect_uris.filter((r) => r.client_id === a[0]).map((r) => ({ redirect_uri: r.redirect_uri })) };
      if (/FROM oauth_client_secrets WHERE client_id/.test(sql))
        return { rows: t.oauth_client_secrets.filter((r) => r.client_id === a[0]).map((r) => ({ secret_phc: r.secret_phc })) };
      if (/INSERT INTO oauth_client_secrets/.test(sql)) {
        t.oauth_client_secrets.push({ client_id: a[0], secret_phc: a[1] });
        return { rows: [] };
      }

      // --- accounts / credentials ---
      if (/SELECT id FROM accounts WHERE username/.test(sql))
        return { rows: t.accounts.filter((r) => r.username === a[0]).map((r) => ({ id: r.id })) };
      // telegram-shaped insert: (id, username=NULL, display_name, avatar_url, verified=1)
      if (/INSERT INTO accounts \(id, username, display_name, avatar_url, verified\)/.test(sql)) {
        t.accounts.push({ id: a[0], username: null, display_name: a[1], avatar_url: a[2], verified: 1 });
        return { rows: [] };
      }
      if (/INSERT INTO accounts/.test(sql)) {
        t.accounts.push({ id: a[0], username: a[1], display_name: a[2], avatar_url: null, verified: 0 });
        return { rows: [] };
      }
      if (/UPDATE accounts SET verified = 1 WHERE id/.test(sql)) {
        const row = t.accounts.find((r) => r.id === a[0]);
        if (row) row.verified = 1;
        return { rows: [] };
      }
      if (/SELECT username, display_name, avatar_url FROM accounts WHERE id/.test(sql))
        return { rows: t.accounts.filter((r) => r.id === a[0]).map((r) => ({ username: r.username, display_name: r.display_name, avatar_url: r.avatar_url })) };
      if (/INSERT INTO password_credentials/.test(sql)) {
        t.password_credentials.push({ account_id: a[0], phc: a[1] });
        return { rows: [] };
      }
      if (/FROM password_credentials WHERE account_id/.test(sql))
        return { rows: t.password_credentials.filter((r) => r.account_id === a[0]).map((r) => ({ phc: r.phc })) };
      if (/INSERT INTO recovery_codes/.test(sql)) {
        t.recovery_codes.push({ account_id: a[0], code_hash: a[1] });
        return { rows: [] };
      }

      // --- telegram ---
      if (/SELECT account_id FROM telegram_links WHERE telegram_id/.test(sql))
        return { rows: t.telegram_links.filter((r) => r.telegram_id === a[0]).map((r) => ({ account_id: r.account_id })) };
      if (/telegram_id, telegram_username FROM telegram_links/.test(sql))
        return { rows: t.telegram_links.filter((r) => r.account_id === a[0]).map((r) => ({ telegram_id: r.telegram_id, telegram_username: r.telegram_username })) };
      if (/FROM telegram_links WHERE account_id/.test(sql))
        return { rows: t.telegram_links.filter((r) => r.account_id === a[0]) };
      if (/INSERT INTO telegram_links/.test(sql)) {
        t.telegram_links.push({ telegram_id: a[0], account_id: a[1], telegram_username: a[2], display_name: a[3], avatar_url: a[4] });
        return { rows: [] };
      }
      if (/UPDATE telegram_links SET telegram_username/.test(sql)) {
        const row = t.telegram_links.find((r) => r.telegram_id === a[3]);
        if (row) row.telegram_username = a[0];
        return { rows: [] };
      }

      // --- login tickets ---
      if (/INSERT INTO login_tickets/.test(sql)) {
        t.login_tickets.push({ ticket_id: a[0], nonce_hash: a[1], owner_hash: a[2], kind: a[3], account_id: a[4], rid: a[5], status: "pending", expires_at: a[6] });
        return { rows: [] };
      }
      if (/SELECT \* FROM login_tickets WHERE nonce_hash/.test(sql))
        return { rows: t.login_tickets.filter((r) => r.nonce_hash === a[0]) };
      if (/SELECT \* FROM login_tickets WHERE ticket_id/.test(sql))
        return { rows: t.login_tickets.filter((r) => r.ticket_id === a[0]) };
      if (/UPDATE login_tickets SET status = 'consumed'/.test(sql)) {
        const row = t.login_tickets.find((r) => r.ticket_id === a[1] && r.status === "pending");
        if (row) {
          row.status = "consumed";
          row.account_id = a[0];
        }
        return { rows: [], rowsAffected: row ? 1 : 0 };
      }

      // --- sessions ---
      if (/INSERT INTO sessions/.test(sql)) {
        t.sessions.push({
          id_hash: a[0],
          account_id: a[1],
          auth_time: a[2],
          amr: a[3],
          csrf_token: a[4],
          idle_expires_at: a[5],
          absolute_expires_at: a[6],
          revoked_at: null,
        });
        return { rows: [] };
      }
      if (/FROM sessions WHERE id_hash/.test(sql))
        return { rows: t.sessions.filter((r) => r.id_hash === a[0]) };
      if (/UPDATE sessions SET last_seen/.test(sql)) {
        const row = t.sessions.find((r) => r.id_hash === a[1]);
        if (row) row.idle_expires_at = a[0];
        return { rows: [], rowsAffected: row ? 1 : 0 };
      }
      if (/UPDATE sessions SET revoked_at/.test(sql)) {
        const row = t.sessions.find((r) => r.id_hash === a[0]);
        if (row) row.revoked_at = "revoked";
        return { rows: [], rowsAffected: row ? 1 : 0 };
      }

      // --- consent ---
      if (/FROM consents WHERE account_id/.test(sql))
        return { rows: t.consents.filter((r) => r.account_id === a[0] && r.client_id === a[1]) };
      if (/INSERT INTO consents/.test(sql)) {
        const existing = t.consents.find((r) => r.account_id === a[0] && r.client_id === a[1]);
        if (existing) {
          existing.scope_set_max = a[2];
          existing.approved_scope_snapshot = a[3];
        } else {
          t.consents.push({ account_id: a[0], client_id: a[1], scope_set_max: a[2], approved_scope_snapshot: a[3] });
        }
        return { rows: [] };
      }

      // --- codes ---
      if (/INSERT INTO oauth_codes/.test(sql)) {
        t.oauth_codes.push({
          code_hash: a[0],
          client_id: a[1],
          redirect_uri: a[2],
          scope: a[3],
          nonce: a[4],
          code_challenge: a[5],
          account_id: a[6],
          session_id_hash: a[7],
          auth_time: a[8],
          jti_family: a[9],
          expires_at: a[10],
          consumed_at: null,
        });
        return { rows: [] };
      }
      if (/SELECT \* FROM oauth_codes WHERE code_hash/.test(sql))
        return { rows: t.oauth_codes.filter((r) => r.code_hash === a[0]) };
      if (/UPDATE oauth_codes SET consumed_at/.test(sql)) {
        const row = t.oauth_codes.find((r) => r.code_hash === a[0] && r.consumed_at == null);
        if (row) row.consumed_at = "consumed";
        return { rows: [], rowsAffected: row ? 1 : 0 };
      }

      // --- access tokens ---
      if (/INSERT INTO access_tokens/.test(sql)) {
        t.access_tokens.push({ jti: a[0], account_id: a[1], client_id: a[2], scope: a[3], family_id: a[4], issued_at: a[5], expires_at: a[6], revoked_at: null });
        return { rows: [] };
      }
      if (/UPDATE access_tokens SET revoked_at .* WHERE family_id/.test(sql)) {
        for (const r of t.access_tokens) if (r.family_id === a[0]) r.revoked_at = "revoked";
        return { rows: [] };
      }
      if (/UPDATE access_tokens SET revoked_at .* WHERE jti/.test(sql)) {
        const r = t.access_tokens.find((x) => x.jti === a[0]);
        if (r) r.revoked_at = "revoked";
        return { rows: [] };
      }
      if (/FROM access_tokens WHERE jti/.test(sql))
        return { rows: t.access_tokens.filter((r) => r.jti === a[0]).map((r) => ({ expires_at: r.expires_at, revoked_at: r.revoked_at })) };

      // --- refresh tokens ---
      if (/INSERT INTO refresh_tokens/.test(sql)) {
        t.refresh_tokens.push({
          token_hash: a[0],
          family_id: a[1],
          client_id: a[2],
          account_id: a[3],
          scope: a[4],
          prev_id: a[5],
          used_at: null,
          idle_expires_at: a[6],
          absolute_expires_at: a[7],
        });
        return { rows: [] };
      }
      if (/SELECT \* FROM refresh_tokens WHERE token_hash/.test(sql))
        return { rows: t.refresh_tokens.filter((r) => r.token_hash === a[0]) };
      if (/UPDATE refresh_tokens SET used_at .* WHERE token_hash/.test(sql)) {
        const row = t.refresh_tokens.find((r) => r.token_hash === a[0] && r.used_at == null);
        if (row) row.used_at = "used";
        return { rows: [], rowsAffected: row ? 1 : 0 };
      }
      if (/UPDATE refresh_tokens SET used_at .* WHERE family_id/.test(sql)) {
        for (const r of t.refresh_tokens) if (r.family_id === a[0] && r.used_at == null) r.used_at = "used";
        return { rows: [] };
      }

      // --- rate limits ---
      if (/FROM rate_limits WHERE bucket/.test(sql))
        return { rows: t.rate_limits.filter((r) => r.bucket === a[0]).map((r) => ({ count: r.count, window_start: r.window_start })) };
      if (/INSERT INTO rate_limits/.test(sql)) {
        const existing = t.rate_limits.find((r) => r.bucket === a[0]);
        if (existing) {
          existing.count = a[1];
          existing.window_start = a[2];
        } else {
          t.rate_limits.push({ bucket: a[0], count: a[1], window_start: a[2] });
        }
        return { rows: [] };
      }

      return { rows: [] };
    },
  };
  return { db, tables: t };
}

/** Generate a real P-256 keypair and wrap it as AUTH_SIGNING_KEYS records (test-only). */
export async function genSigningKeys(kid = "k1", status: SigningKeyRecord["status"] = "active"): Promise<SigningKeyRecord[]> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return [{ kid, status, privateJwk, publicJwk }];
}
