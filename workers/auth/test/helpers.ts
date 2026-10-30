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
  const execute: DbClient["execute"] = async (stmt) => {
    const sql = typeof stmt === "string" ? stmt : stmt.sql;
    const args = typeof stmt === "string" ? [] : stmt.args;
    log.push({ sql, args });
    for (const [re, fn] of routes) {
      if (re.test(sql)) return fn(args) ?? { rows: [] };
    }
    // An unrouted INSERT is treated as a write that landed (guarded inserts report rowsAffected = 1).
    return /^\s*INSERT/i.test(sql) ? { rows: [], rowsAffected: 1 } : { rows: [] };
  };
  // batch = sequential execute (each statement is still logged + routed), so
  // tests that assert on the per-statement log keep working with batched writes.
  return { execute, batch: async (stmts) => Promise.all(stmts.map((s) => execute(s))) };
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
    audit_log: [],
    account_delete_confirmations: [],
  };
  // Conditional INSERT ... SELECT ... WHERE EXISTS(unspent credential): last arg is its hash.
  // Token inserts carry a second layer (account still exists): args end [..., credentialHash, accountId].
  const guardOk = (sql: string, a: unknown[]): boolean => {
    let last = a[a.length - 1];
    if (/FROM accounts WHERE id = \?\)/.test(sql)) {
      if (!t.accounts.some((r) => r.id === last)) return false;
      last = a[a.length - 2];
    }
    if (/FROM oauth_codes WHERE code_hash = \? AND consumed_at IS NULL\)/.test(sql))
      return t.oauth_codes.some((r) => r.code_hash === last && r.consumed_at == null);
    if (/FROM refresh_tokens WHERE token_hash = \? AND used_at IS NULL\)/.test(sql))
      return t.refresh_tokens.some((r) => r.token_hash === last && r.used_at == null);
    return true;
  };
  let lastConfirmChanges = 0; // emulates changes() after the delete-confirmation consume UPDATE
  let lastAccountChanges = 0; // emulates changes() after `DELETE FROM accounts`
  // Only valid because deleteAccount puts the audit insert IMMEDIATELY after that delete; it is not reset by other writes.
  const exec: DbClient["execute"] = async (stmt) => {
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
      if (/SELECT c\.client_id, c\.approved_scope_snapshot, c\.updated_at, o\.display_name FROM consents c/.test(sql))
        return { rows: t.consents.filter((r) => r.account_id === a[0]).map((r) => ({ client_id: r.client_id, approved_scope_snapshot: r.approved_scope_snapshot, updated_at: null, display_name: t.oauth_clients.find((o) => o.client_id === r.client_id)?.display_name ?? null })) };
      if (/DELETE FROM consents WHERE account_id/.test(sql)) {
        const before = t.consents.length;
        t.consents = t.consents.filter((r) => !(r.account_id === a[0] && r.client_id === a[1]));
        return { rows: [], rowsAffected: before - t.consents.length };
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
      if (/^SELECT client_id FROM oauth_clients WHERE owner_account_id = \? AND deleted_at IS NULL/.test(sql))
        return { rows: t.oauth_clients.filter((r) => r.owner_account_id === a[0] && r.deleted_at == null).map((r) => ({ client_id: r.client_id })) };
      if (/^SELECT 1 FROM accounts WHERE id = \?/.test(sql)) return { rows: t.accounts.filter((r) => r.id === a[0]).map(() => ({ "1": 1 })) };
      // --- account-delete step-up confirmations ---
      if (/^INSERT INTO account_delete_confirmations/.test(sql)) {
        const [tokenHash, accountId, sessHash, createdAt, expiresAt] = a;
        if (!t.accounts.some((r) => r.id === accountId) || !t.sessions.some((r) => r.id_hash === sessHash && r.account_id === accountId && r.revoked_at == null))
          return { rows: [], rowsAffected: 0 };
        t.account_delete_confirmations.push({ token_hash: tokenHash, account_id: accountId, session_id_hash: sessHash, created_at: createdAt, expires_at: expiresAt, used_at: null });
        return { rows: [], rowsAffected: 1 };
      }
      if (/^DELETE FROM account_delete_confirmations WHERE account_id = \? AND used_at IS NULL/.test(sql)) {
        t.account_delete_confirmations = t.account_delete_confirmations.filter((r) => !(r.account_id === a[0] && r.used_at == null));
        return { rows: [] };
      }
      if (/^DELETE FROM account_delete_confirmations WHERE account_id = \?/.test(sql)) {
        t.account_delete_confirmations = t.account_delete_confirmations.filter((r) => r.account_id !== a[0]);
        return { rows: [] };
      }
      if (/^UPDATE account_delete_confirmations SET used_at/.test(sql)) {
        const [usedAt, tokenHash, accountId, sessHash, nowTs] = a;
        const row = t.account_delete_confirmations.find((r) => r.token_hash === tokenHash && r.account_id === accountId && r.session_id_hash === sessHash && r.used_at == null && Number(r.expires_at) > Number(nowTs));
        if (row) row.used_at = usedAt;
        lastConfirmChanges = row ? 1 : 0;
        return { rows: [], rowsAffected: lastConfirmChanges };
      }
      if (/^INSERT INTO audit_log \(event\) SELECT NULL WHERE changes\(\) = 0/.test(sql)) {
        if (lastConfirmChanges === 0) throw Object.assign(new Error("NOT NULL constraint failed: audit_log.event"), { code: "SQLITE_CONSTRAINT_NOTNULL" });
        return { rows: [], rowsAffected: 0 };
      }
      if (/^SELECT 1 FROM account_delete_confirmations WHERE token_hash/.test(sql)) {
        return { rows: t.account_delete_confirmations.filter((r) => r.token_hash === a[0] && r.account_id === a[1] && r.session_id_hash === a[2] && r.used_at == null && Number(r.expires_at) > Number(a[3])).map(() => ({ "1": 1 })) };
      }
      // Simulates deleteAccount's guard statement (a NOT NULL violation on real SQLite) iff an active owned client exists.
      if (/^INSERT INTO audit_log \(event\) SELECT NULL WHERE EXISTS/.test(sql)) {
        if (t.oauth_clients.some((r) => r.owner_account_id === a[0] && r.deleted_at == null)) throw new Error("NOT NULL constraint failed: audit_log.event");
        return { rows: [], rowsAffected: 0 };
      }
      if (/^INSERT INTO audit_log .* WHERE changes\(\) = 1/.test(sql)) {
        if (lastAccountChanges !== 1) return { rows: [], rowsAffected: 0 };
        t.audit_log.push({ id: t.audit_log.length + 1, event: a[0], account_id: a[1], client_id: a[2], ip_trunc: a[3], ua_hash: a[4] });
        return { rows: [], rowsAffected: 1 };
      }
      if (/DELETE FROM accounts WHERE id/.test(sql)) {
        lastAccountChanges = t.accounts.filter((r) => r.id === a[0]).length;
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
      // getClient is collapsed: the client row carries redirect_uris as a JSON
      // array (json_group_array). authenticateClient reads the same row + ignores it.
      if (/FROM oauth_clients WHERE client_id/.test(sql))
        return {
          rows: t.oauth_clients
            .filter((r) => r.client_id === a[0])
            .map((r) => ({
              ...r,
              redirect_uris: JSON.stringify(
                t.oauth_client_redirect_uris.filter((x) => x.client_id === r.client_id).map((x) => x.redirect_uri),
              ),
            })),
        };
      if (/FROM oauth_client_redirect_uris WHERE client_id/.test(sql))
        return { rows: t.oauth_client_redirect_uris.filter((r) => r.client_id === a[0]).map((r) => ({ redirect_uri: r.redirect_uri })) };
      if (/FROM oauth_client_secrets WHERE client_id/.test(sql))
        return { rows: t.oauth_client_secrets.filter((r) => r.client_id === a[0]).map((r) => ({ secret_phc: r.secret_phc })) };
      if (/INSERT INTO oauth_client_secrets/.test(sql)) {
        t.oauth_client_secrets.push({ client_id: a[0], secret_phc: a[1] });
        return { rows: [] };
      }

      // --- accounts / credentials ---
      // loginVerify — collapsed: account id + its password hash (null if missing).
      if (/FROM accounts a WHERE a.username/.test(sql)) {
        const acct = t.accounts.find((r) => r.username === a[0]);
        if (!acct) return { rows: [] };
        const pw = t.password_credentials.find((r) => r.account_id === acct.id);
        return { rows: [{ id: acct.id, phc: pw ? pw.phc : null }] };
      }
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
      // getAccountInfo — collapsed: profile + EXISTS(password) in one query.
      // args: a[0] = EXISTS subquery account_id, a[1] = WHERE id (both accountId).
      if (/SELECT username, display_name, avatar_url, EXISTS.*FROM accounts WHERE id/.test(sql)) {
        const acct = t.accounts.find((r) => r.id === a[1]);
        if (!acct) return { rows: [] };
        const has_password = t.password_credentials.some((r) => r.account_id === a[0]) ? 1 : 0;
        return { rows: [{ username: acct.username, display_name: acct.display_name, avatar_url: acct.avatar_url, has_password }] };
      }
      // userinfoClaims — collapsed: profile + telegram (id+username) + live verified.
      if (/AS telegram_id/.test(sql)) {
        const acct = t.accounts.find((r) => r.id === a[0]);
        if (!acct) return { rows: [] };
        const tg = t.telegram_links.find((r) => r.account_id === acct.id);
        return {
          rows: [
            {
              username: acct.username,
              display_name: acct.display_name,
              avatar_url: acct.avatar_url,
              telegram_id: tg ? tg.telegram_id : null,
              telegram_username: tg ? tg.telegram_username : null,
              verified: tg ? 1 : 0,
            },
          ],
        };
      }
      // getAccountDetail — collapsed: profile + password + telegram + verified + recovery count.
      if (/AS recovery_remaining/.test(sql)) {
        const acct = t.accounts.find((r) => r.id === a[0]);
        if (!acct) return { rows: [] };
        const tg = t.telegram_links.find((r) => r.account_id === acct.id);
        return {
          rows: [
            {
              username: acct.username,
              display_name: acct.display_name,
              avatar_url: acct.avatar_url,
              has_password: t.password_credentials.some((r) => r.account_id === acct.id) ? 1 : 0,
              telegram_username: tg ? tg.telegram_username : null,
              verified: tg ? 1 : 0,
              recovery_remaining: t.recovery_codes.filter((r) => r.account_id === acct.id && r.used_at == null).length,
            },
          ],
        };
      }
      // plain profile read — non-collapsed shape (kept for any remaining caller).
      if (/SELECT username, display_name, avatar_url FROM accounts WHERE id/.test(sql))
        return { rows: t.accounts.filter((r) => r.id === a[0]).map((r) => ({ username: r.username, display_name: r.display_name, avatar_url: r.avatar_url })) };
      if (/INSERT INTO password_credentials/.test(sql)) {
        t.password_credentials.push({ account_id: a[0], phc: a[1] });
        return { rows: [] };
      }
      if (/FROM password_credentials WHERE account_id/.test(sql))
        return { rows: t.password_credentials.filter((r) => r.account_id === a[0]).map((r) => ({ phc: r.phc })) };
      if (/INSERT INTO recovery_codes .* SELECT .* WHERE EXISTS \(SELECT 1 FROM accounts WHERE id = \?\)/.test(sql)) {
        // conditional on the account existing (a[2] = account id)
        if (!t.accounts.some((r) => r.id === a[2])) return { rows: [], rowsAffected: 0 };
        t.recovery_codes.push({ account_id: a[0], code_hash: a[1] });
        return { rows: [], rowsAffected: 1 };
      }
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
      if (/INSERT INTO telegram_links .* SELECT .* WHERE EXISTS \(SELECT 1 FROM accounts WHERE id = \?\)/.test(sql)) {
        // link-to-existing: conditional on the account existing (a[5] = account id)
        if (!t.accounts.some((r) => r.id === a[5])) return { rows: [], rowsAffected: 0 };
        t.telegram_links.push({ telegram_id: a[0], account_id: a[1], telegram_username: a[2], display_name: a[3], avatar_url: a[4] });
        return { rows: [], rowsAffected: 1 };
      }
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
      if (/UPDATE login_tickets SET status = 'consumed' WHERE ticket_id = \? AND status = 'claimed'/.test(sql)) {
        const row = t.login_tickets.find((r) => r.ticket_id === a[0] && r.status === "claimed");
        if (row) row.status = "consumed";
        return { rows: [], rowsAffected: row ? 1 : 0 };
      }
      if (/UPDATE login_tickets SET status = 'claimed'/.test(sql)) {
        const row = t.login_tickets.find((r) => r.ticket_id === a[0] && r.status === "consumed" && Number(r.expires_at) >= Number(a[1]));
        if (row) row.status = "claimed";
        return { rows: [], rowsAffected: row ? 1 : 0 };
      }
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
        // conditional on the account existing (a[7] = account id)
        if (!t.accounts.some((r) => r.id === a[7])) return { rows: [], rowsAffected: 0 };
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
        return { rows: [], rowsAffected: 1 };
      }
      // whoami — one-query session validation + profile + LIVE verified.
      // args: a[0] = id_hash, a[1] = now (idle), a[2] = now (absolute).
      if (/FROM sessions s JOIN accounts a/.test(sql)) {
        const s = t.sessions.find(
          (r) =>
            r.id_hash === a[0] &&
            r.revoked_at == null &&
            Number(r.idle_expires_at) > Number(a[1]) &&
            Number(r.absolute_expires_at) > Number(a[2]),
        );
        if (!s) return { rows: [] };
        const acct = t.accounts.find((r) => r.id === s.account_id);
        if (!acct) return { rows: [] };
        const verified = t.telegram_links.some((r) => r.account_id === s.account_id) ? 1 : 0;
        return { rows: [{ username: acct.username, display_name: acct.display_name, verified }] };
      }
      // lookupSession: a leftover session whose account is gone is treated as absent.
      if (/FROM sessions WHERE id_hash/.test(sql))
        return { rows: t.sessions.filter((r) => r.id_hash === a[0] && t.accounts.some((x) => x.id === r.account_id)) };
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
        // conditional on the account existing (a[4] = account id)
        if (!t.accounts.some((r) => r.id === a[4])) return { rows: [], rowsAffected: 0 };
        const existing = t.consents.find((r) => r.account_id === a[0] && r.client_id === a[1]);
        if (existing) {
          existing.scope_set_max = a[2];
          existing.approved_scope_snapshot = a[3];
        } else {
          t.consents.push({ account_id: a[0], client_id: a[1], scope_set_max: a[2], approved_scope_snapshot: a[3] });
        }
        return { rows: [], rowsAffected: 1 };
      }

      // --- codes ---
      if (/INSERT INTO oauth_codes/.test(sql)) {
        // conditional on the session being live with its account existing: args end [idHash, accountId, now, now]
        const [sh, acct, nowT] = [a[11], a[12], Number(a[13])];
        const live = t.sessions.some(
          (r) =>
            r.id_hash === sh && r.account_id === acct && r.revoked_at == null &&
            Number(r.idle_expires_at) >= nowT && Number(r.absolute_expires_at) >= nowT &&
            t.accounts.some((x) => x.id === acct),
        );
        if (!live) return { rows: [], rowsAffected: 0 };
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
        return { rows: [], rowsAffected: 1 };
      }
      if (/SELECT \* FROM oauth_codes WHERE code_hash/.test(sql))
        return { rows: t.oauth_codes.filter((r) => r.code_hash === a[0]) };
      if (/UPDATE oauth_codes SET consumed_at/.test(sql)) {
        const row = t.oauth_codes.find((r) => r.code_hash === a[0] && r.consumed_at == null);
        if (row) row.consumed_at = "consumed";
        return { rows: [], rowsAffected: row ? 1 : 0 };
      }

      // --- in-batch conditional family revoke (mintResponse): like real SQLite, only applies when
      //     this request's own guarded access insert did NOT happen (a[1] = its jti). Must precede
      //     the generic routes below, which would otherwise swallow/over-apply it.
      if (/^UPDATE (refresh|access)_tokens SET .* WHERE family_id = \? .*NOT EXISTS \(SELECT 1 FROM access_tokens WHERE jti = \?\)/.test(sql)) {
        const lost = !t.access_tokens.some((r) => r.jti === a[1]);
        let n = 0;
        if (lost) {
          if (/^UPDATE refresh_tokens/.test(sql)) {
            for (const r of t.refresh_tokens) if (r.family_id === a[0] && r.used_at == null) (r.used_at = "used", n++);
          } else {
            for (const r of t.access_tokens) if (r.family_id === a[0] && r.revoked_at == null) (r.revoked_at = "revoked", n++);
          }
        }
        return { rows: [], rowsAffected: n };
      }

      // --- access tokens ---
      if (/INSERT INTO access_tokens/.test(sql)) {
        if (!guardOk(sql, a)) return { rows: [], rowsAffected: 0 };
        t.access_tokens.push({ jti: a[0], account_id: a[1], client_id: a[2], scope: a[3], family_id: a[4], issued_at: a[5], expires_at: a[6], revoked_at: null });
        return { rows: [], rowsAffected: 1 };
      }
      if (/UPDATE access_tokens SET revoked_at .* WHERE family_id/.test(sql)) {
        for (const r of t.access_tokens) if (r.family_id === a[0]) r.revoked_at = "revoked";
        return { rows: [] };
      }
      if (/UPDATE access_tokens SET revoked_at .* WHERE jti/.test(sql)) {
        const r = t.access_tokens.find((x) => x.jti === a[0] && x.client_id === a[1] && x.revoked_at == null);
        if (r) r.revoked_at = "revoked";
        return { rows: [], rowsAffected: r ? 1 : 0 };
      }
      if (/FROM access_tokens WHERE jti/.test(sql))
        return { rows: t.access_tokens.filter((r) => r.jti === a[0]).map((r) => ({ expires_at: r.expires_at, revoked_at: r.revoked_at })) };

      // --- refresh tokens ---
      if (/INSERT INTO refresh_tokens/.test(sql)) {
        if (!guardOk(sql, a)) return { rows: [], rowsAffected: 0 };
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
        return { rows: [], rowsAffected: 1 };
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

      // --- audit log (SEC-2) ---
      if (/INSERT INTO audit_log/.test(sql)) {
        const id = t.audit_log.length + 1;
        t.audit_log.push({ id, event: a[0], account_id: a[1], client_id: a[2], ip_trunc: a[3], ua_hash: a[4] });
        return { rows: [], rowsAffected: 1, lastInsertRowid: id };
      }

      // --- rate limits ---
      // Atomic upsert with RETURNING count. The `1` (count) in VALUES is a literal,
      // so the bound args are:
      //   [bucket, now, now,  now, windowSec,  now, windowSec, now,  now]
      //    0=bkt   1    2     3    4=win        5    6=win      7     8
      // new bucket → count 1; within window → count+1; window elapsed → reset to 1.
      if (/INSERT INTO rate_limits/.test(sql)) {
        const bucket = a[0];
        const now = Number(a[3]);
        const windowSec = Number(a[4]);
        const existing = t.rate_limits.find((r) => r.bucket === bucket);
        if (!existing) {
          t.rate_limits.push({ bucket, count: 1, window_start: now, last_at: now });
          return { rows: [{ count: 1 }] };
        }
        const inWindow = now - Number(existing.window_start) < windowSec;
        existing.count = inWindow ? Number(existing.count) + 1 : 1;
        existing.window_start = inWindow ? existing.window_start : now;
        existing.last_at = now;
        return { rows: [{ count: existing.count }] };
      }

      return { rows: [] };
  };
  // Sequential, stops at the first error. Does NOT roll back earlier statements (unlike real libsql
  // batch("write")); tests needing atomicity use a real in-memory libsql instead.
  const seqBatch: DbClient["batch"] = async (stmts) => {
    const out = [];
    for (const s of stmts) out.push(await exec(s));
    return out;
  };
  const db: DbClient = { execute: exec, batch: seqBatch };
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

/** Real-DB helper: a live session row (createAuthCode requires its session to be live). Idempotent. */
export async function seedLiveSession(db: DbClient, idHash: string, accountId: string, now: number): Promise<void> {
  await db.execute({
    sql: `INSERT OR IGNORE INTO sessions (id_hash, account_id, auth_time, amr, csrf_token, idle_expires_at, absolute_expires_at)
          VALUES (?, ?, ?, 'pwd', 'csrf', ?, ?)`,
    args: [idHash, accountId, now, now + 100_000, now + 100_000],
  });
}
