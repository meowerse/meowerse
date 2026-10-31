import { test, expect, afterAll, vi } from "vitest";
import { createClient } from "@libsql/client";
import { SCHEMA, SEED } from "../src/db";
import { handle } from "../src/index";
import { genSigningKeys, cookieValue } from "./helpers";
import type { DbClient } from "../src/types";

// Every scenario runs many real PBKDF2 (600k) logins; on loaded CI runners one scenario can
// exceed vitest's 5 s default (it did on #94). A longer per-test limit, same assertions.
vi.setConfig({ testTimeout: 60_000 });

// ACCEPTANCE (pre-enable) for self-service account deletion. Production-like: real libSQL (the same engine Turso
// runs), the real `handle` router end to end (signup, login, Telegram widget, authorize, consent, token, userinfo,
// account API), ACCOUNT_DELETE_ENABLED=1 in THIS local env only. Fault injection wraps db.batch.
//
// Default (`bun run test`): local in-memory libSQL, no network, no env. Opt-in remote mode runs the SAME scenarios
// over HTTP against a THROWAWAY libSQL/Turso database through `@libsql/client/web`, exactly as prodDeps (db.ts) does:
//   DELETE_ACCEPTANCE_REMOTE=1 TMP_TURSO_URL=… TMP_TURSO_TOKEN=… vitest run test/delete-acceptance.e2e.test.ts --testTimeout=900000
// Remote mode DROPS EVERY TABLE in that database before each scenario and after the run. Never point it at production.
const REMOTE = process.env.DELETE_ACCEPTANCE_REMOTE === "1";
let remoteClient: DbClient | null = null;

async function listTables(c: DbClient): Promise<string[]> {
  const r = await c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%' AND name NOT LIKE '\\_%' ESCAPE '\\'");
  return r.rows.map((x) => String(x.name));
}
/** Drop every table (children first; retried passes so FK enforcement on the server can't wedge it). */
async function dropAll(c: DbClient): Promise<void> {
  const order = SCHEMA.map((s) => /CREATE TABLE IF NOT EXISTS (\w+)/.exec(s)?.[1]).filter((x): x is string => !!x).reverse();
  for (let pass = 0; pass < 5; pass++) {
    const left = await listTables(c);
    if (left.length === 0) return;
    for (const t of [...order.filter((o) => left.includes(o)), ...left.filter((l) => !order.includes(l))]) {
      try { await c.execute(`DROP TABLE IF EXISTS "${t}"`); } catch { /* retry next pass */ }
    }
  }
  const left = await listTables(c);
  if (left.length) throw new Error(`tables left after drop: ${left.join(",")}`);
}

/** A fresh, schema-applied database: local :memory:, or the remote throwaway DB wiped and re-migrated. */
async function freshRaw(): Promise<DbClient> {
  if (!REMOTE) {
    const raw = createClient({ url: ":memory:" }) as unknown as DbClient;
    for (const s of [...SCHEMA, ...SEED]) await raw.execute(s);
    // Foreign keys OFF by default: the ON DELETE CASCADE clauses must NOT be what cleans up, so every explicit
    // DELETE has to stand on its own. FK_ON=1 re-runs the suite with enforcement on.
    await raw.execute(process.env.FK_ON === "1" ? "PRAGMA foreign_keys = ON" : "PRAGMA foreign_keys = OFF");
    return raw;
  }
  const url = process.env.TMP_TURSO_URL;
  const authToken = process.env.TMP_TURSO_TOKEN;
  if (!url || !authToken) throw new Error("DELETE_ACCEPTANCE_REMOTE=1 needs TMP_TURSO_URL and TMP_TURSO_TOKEN");
  if (!remoteClient) {
    const web = await import("@libsql/client/web"); // the production client (db.ts prodDeps)
    remoteClient = web.createClient({ url, authToken }) as unknown as DbClient;
  }
  await dropAll(remoteClient);
  for (const s of [...SCHEMA, ...SEED]) await remoteClient.execute(s); // as ensureSchema does
  return remoteClient;
}

afterAll(async () => {
  if (!REMOTE || !remoteClient) return;
  console.log("REMOTE foreign_keys", JSON.stringify((await remoteClient.execute("PRAGMA foreign_keys")).rows[0]));
  await dropAll(remoteClient);
  console.log("REMOTE cleanup tables left", (await listTables(remoteClient)).length);
});

const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const REDIRECT = "https://rp.example/cb";
const BOT_TOKEN = "123456:bottoken";
const T0 = 1_000_000;
const enc = new TextEncoder();

type Fault = { kind: "fail_at"; index: number } | { kind: "lost_response"; probeFails?: boolean } | null;

async function stack(opts: { enabled?: boolean } = {}) {
  const raw = await freshRaw();
  // A third-party client that allows offline_access, owned by the system account (like a real RP).
  await raw.execute(`INSERT INTO oauth_clients (client_id, name, owner_account_id, client_type, display_name, allowed_scopes, allow_offline_access, first_party, status)
    VALUES ('rp_off', 'rp-off', 'acct_system', 'public', 'RP', '["openid","profile","offline_access"]', 1, 0, 'active')`);
  await raw.execute({ sql: "INSERT INTO oauth_client_redirect_uris (client_id, redirect_uri) VALUES ('rp_off', ?)", args: [REDIRECT] });

  let clock = T0;
  let fault: Fault = null;
  let probeBroken = false;
  const deleteBatchLens: number[] = [];
  const db: DbClient = {
    execute: async (stmt) => {
      if (probeBroken) throw Object.assign(new Error("fetch failed"), { code: "FETCH_FAILED" });
      return raw.execute(stmt);
    },
    batch: async (stmts, mode) => {
      const isDelete = stmts.some((s) => typeof s !== "string" && /^DELETE FROM accounts WHERE id/.test(s.sql));
      if (!isDelete || !fault) return raw.batch(stmts, mode);
      deleteBatchLens.push(stmts.length);
      const f = fault;
      fault = null;
      if (f.kind === "fail_at") {
        // A transport/server error on statement `index` (not a constraint): everything before it in the txn must roll back.
        const s = [...stmts];
        s[f.index] = { sql: "SELECT * FROM __injected_network_fault", args: [] };
        return raw.batch(s, mode);
      }
      const r = await raw.batch(stmts, mode); // commits
      if (f.probeFails) probeBroken = true;
      throw Object.assign(new Error("fetch failed"), { code: "FETCH_FAILED" }); // response lost after commit
    },
  };
  const keys = await genSigningKeys();
  const env = {
    AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", WEB_ORIGIN: "https://web", CORS_ORIGINS: "https://web",
    STATE_SECRET: "s", TELEGRAM_BOT_TOKEN: BOT_TOKEN, RESOURCE_AUD: "https://api", SKIP_MIGRATIONS: "1",
    ...(opts.enabled === false ? {} : { ACCOUNT_DELETE_ENABLED: "1" }),
  };
  const deps = { getDb: () => db, clock: () => clock };
  const call = async (path: string, init: { sess?: string; cookie?: string; body?: Record<string, string>; bearer?: string } = {}) =>
    handle(
      new Request(`https://iss${path}`, {
        method: init.body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9", "User-Agent": "acceptance",
          ...(init.bearer ? { Authorization: `Bearer ${init.bearer}` } : {}),
          Cookie: [init.sess ? `__Host-mw_sess=${init.sess}` : "", init.cookie ?? ""].filter(Boolean).join("; "),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
      }),
      env as never,
      deps as never,
    );
  const q = async (sql: string, args: unknown[] = []) => (await raw.execute({ sql, args })).rows;
  const n = async (sql: string, args: unknown[] = []) => Number((await q(`SELECT count(*) AS n FROM ${sql}`, args))[0]!.n);

  async function signup(username: string, password = "accttest1234") {
    const r = await call("/signup", { body: { username, password } });
    expect(r.status).toBe(200);
    const sess = cookieValue(r.headers.get("Set-Cookie"), "__Host-mw_sess")!;
    const id = String((await q("SELECT id FROM accounts WHERE username = ?", [username]))[0]!.id);
    return { id, sess, password, username };
  }
  async function login(username: string, password = "accttest1234") {
    const r = await call("/login", { body: { username, password } });
    expect(r.status).toBe(200);
    return cookieValue(r.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  }
  async function tgLogin(tgId: string, first: string) {
    const data: Record<string, string> = { id: tgId, first_name: first, auth_date: String(clock) };
    const dcs = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
    const secret = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(BOT_TOKEN)));
    const k = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const hash = [...new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(dcs)))].map((x) => x.toString(16).padStart(2, "0")).join("");
    const r = await call("/tg/widget", { body: { ...data, hash } });
    expect(r.status).toBe(200);
    const sess = cookieValue(r.headers.get("Set-Cookie"), "__Host-mw_sess")!;
    const id = String((await q("SELECT account_id FROM telegram_links WHERE telegram_id = ?", [tgId]))[0]!.account_id);
    return { id, sess };
  }
  async function csrf(sess: string) {
    const r = await call("/api/account", { sess });
    expect(r.status).toBe(200);
    return ((await r.json()) as { csrf: string }).csrf;
  }
  function authorizeUrl() {
    return "/authorize?" + new URLSearchParams({
      client_id: "rp_off", redirect_uri: REDIRECT, response_type: "code", scope: "openid profile offline_access",
      state: "st", code_challenge: CHALLENGE, code_challenge_method: "S256", nonce: "nn",
    }).toString();
  }
  /** consent (first time) or silent authorize → a fresh authorization code. */
  async function getCode(sess: string): Promise<string> {
    const a = await call(authorizeUrl(), { sess });
    expect(a.status).toBe(302);
    const loc = new URL(a.headers.get("Location")!);
    if (loc.searchParams.get("code")) return loc.searchParams.get("code")!;
    const tkt = cookieValue(a.headers.get("Set-Cookie"), "__Host-mw_tkt")!;
    const c = await call("/consent", { sess, cookie: `__Host-mw_tkt=${tkt}`, body: { decision: "allow", csrf: await csrf(sess) } });
    expect(c.status).toBe(200);
    return new URL(((await c.json()) as { redirect: string }).redirect).searchParams.get("code")!;
  }
  async function exchange(code: string) {
    return call("/token", { body: { grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: "rp_off", redirect_uri: REDIRECT } });
  }
  async function refresh(rt: string) {
    return call("/token", { body: { grant_type: "refresh_token", refresh_token: rt, client_id: "rp_off" } });
  }
  /** Full OAuth seed: consent + access + refresh token, plus one UNUSED code left outstanding. */
  async function seedOAuth(sess: string) {
    const t = await exchange(await getCode(sess));
    expect(t.status).toBe(200);
    const tb = (await t.json()) as { access_token: string; refresh_token: string };
    expect(tb.refresh_token).toBeTruthy();
    const unusedCode = await getCode(sess); // silent: consent exists
    return { access: tb.access_token, refresh: tb.refresh_token, unusedCode };
  }
  async function start(sess: string, password?: string) {
    const r = await call("/api/account/delete/start", { sess, body: { csrf: await csrf(sess), ...(password ? { current_password: password } : {}) } });
    return { status: r.status, body: (await r.json()) as { confirm_token?: string; error?: string; reauth?: string } };
  }
  async function del(sess: string, csrfTok: string, confirm: string, token: string) {
    const r = await call("/api/account/delete", { sess, body: { csrf: csrfTok, confirm, confirm_token: token } });
    return { status: r.status, body: (await r.json()) as { ok?: boolean; error?: string }, setCookie: r.headers.get("Set-Cookie") };
  }

  /** Every table that carries an account reference, discovered from the live schema (not a hand list). */
  async function accountRefColumns(): Promise<{ table: string; col: string }[]> {
    const out: { table: string; col: string }[] = [];
    for (const t of await q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
      for (const c of await q(`PRAGMA table_info(${String(t.name)})`)) {
        if (/account_id$|^user_id$|^sub$/.test(String(c.name))) out.push({ table: String(t.name), col: String(c.name) });
      }
    }
    return out;
  }
  async function footprint(id: string): Promise<Record<string, number>> {
    const f: Record<string, number> = {};
    for (const { table, col } of await accountRefColumns()) f[`${table}.${col}`] = await n(`${table} WHERE ${col} = ?`, [id]);
    f["accounts.id"] = await n("accounts WHERE id = ?", [id]);
    f["rate_limits.bucket"] = await n("rate_limits WHERE bucket LIKE ?", [`%${id}%`]);
    return f;
  }
  /** Whole-DB dump (minus the non-semantic sessions.last_seen keep-alive) for byte-for-byte rollback checks. */
  async function dump(): Promise<string> {
    const parts: string[] = [];
    for (const t of await q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
      const rows = (await q(`SELECT * FROM ${String(t.name)}`)).map((r) => {
        const o = { ...(r as Record<string, unknown>) };
        if (t.name === "sessions") delete o.last_seen;
        return JSON.stringify(o);
      }).sort();
      parts.push(`${String(t.name)}:${rows.join("|")}`);
    }
    return parts.join("\n");
  }

  return {
    raw, call, q, n, signup, login, tgLogin, csrf, seedOAuth, exchange, refresh, start, del, footprint, accountRefColumns, dump,
    setFault: (f: Fault) => { fault = f; }, healProbe: () => { probeBroken = false; }, deleteBatchLens,
    advance: (s: number) => { clock += s; }, now: () => clock,
  };
}

/** Standard world: alice (password, 2 sessions, consent + refresh + access + unused code), bob (bystander, same). */
async function world(opts: { enabled?: boolean } = {}) {
  const s = await stack(opts);
  const alice = await s.signup("alice");
  const alice2 = await s.login("alice");
  const aliceOAuth = await s.seedOAuth(alice.sess);
  const bob = await s.signup("bob");
  const bob2 = await s.login("bob");
  const bobOAuth = await s.seedOAuth(bob.sess);
  return { s, alice, alice2, aliceOAuth, bob, bob2, bobOAuth };
}

async function expectBystanderIntact(s: Awaited<ReturnType<typeof stack>>, bob: { id: string; sess: string }, bob2: string, before: Record<string, number>, bobRefresh: string) {
  expect(await s.footprint(bob.id)).toEqual(before);
  expect((await s.call("/api/account", { sess: bob.sess })).status).toBe(200);
  expect((await s.call("/api/account", { sess: bob2 })).status).toBe(200);
  const r = await s.refresh(bobRefresh);
  expect(r.status).toBe(200);
}

// ------------------------------------------------------------------ inventory

test("INVENTORY: every account-referencing table is emptied for the deleted account except audit_log (kept) and rate_limits stepup (ages out)", async () => {
  const { s, alice, alice2, aliceOAuth, bob, bob2, bobOAuth } = await world();
  // Give alice a stale step-up so a stepup:<id> rate-limit row exists, and a Telegram link + login ticket.
  s.advance(400);
  const st0 = await s.start(alice.sess, "wrong-password-x");
  expect(st0).toMatchObject({ status: 403, body: { error: "wrong_password" } });
  const before = await s.footprint(alice.id);
  const bobBefore = await s.footprint(bob.id);
  console.log("INVENTORY before", JSON.stringify(before));
  const st = await s.start(alice.sess, alice.password);
  expect(st.status).toBe(200);
  const d = await s.del(alice.sess, await s.csrf(alice.sess), "alice", st.body.confirm_token!);
  expect(d.status).toBe(200);
  expect(d.setCookie).toContain("Max-Age=0");
  const after = await s.footprint(alice.id);
  console.log("INVENTORY after", JSON.stringify(after));
  for (const [k, v] of Object.entries(after)) {
    if (k === "audit_log.account_id" || k === "rate_limits.bucket") continue;
    expect([k, v]).toEqual([k, 0]);
  }
  expect(after["rate_limits.bucket"]).toBe(1); // documented: stepup:<id> ages out via housekeeping
  const events = (await s.q("SELECT event, ip_trunc, ua_hash FROM audit_log WHERE account_id = ? ORDER BY id", [alice.id])).map((r) => String(r.event));
  console.log("AUDIT events", JSON.stringify(events));
  expect(events.filter((e) => e === "account.delete")).toHaveLength(1);
  expect(events).toContain("account.delete_stepup_fail");
  // No secret material in audit rows: only fixed columns, truncated IP, UA hash.
  const row = (await s.q("SELECT * FROM audit_log WHERE event = 'account.delete'"))[0]!;
  expect(Object.keys(row).sort()).toEqual(["account_id", "client_id", "event", "id", "ip_trunc", "ts", "ua_hash"]);
  expect(String(row.ip_trunc)).not.toBe("203.0.113.9");
  // Sessions, OAuth grants: both alice sessions dead, refresh/code/access unusable.
  expect((await s.call("/api/account", { sess: alice.sess })).status).toBe(401);
  expect((await s.call("/api/account", { sess: alice2 })).status).toBe(401);
  expect((await s.refresh(aliceOAuth.refresh)).status).toBe(400);
  expect((await s.exchange(aliceOAuth.unusedCode)).status).toBe(400);
  expect((await s.call("/userinfo", { bearer: aliceOAuth.access })).status).toBe(401);
  // username freed (a new signup can take it, gets a NEW id).
  const again = await s.signup("alice");
  expect(again.id).not.toBe(alice.id);
  await expectBystanderIntact(s, bob, bob2, bobBefore, bobOAuth.refresh);
});

// ------------------------------------------------------------------ Telegram-only

test("TELEGRAM-ONLY: stale session needs Telegram re-auth (no password path), fresh Telegram login deletes; link freed", async () => {
  const s = await stack();
  const carol = await s.tgLogin("777", "Carol");
  const bob = await s.signup("bob");
  const bob2 = await s.login("bob");
  const bobOAuth = await s.seedOAuth(bob.sess);
  const carolOAuth = await s.seedOAuth(carol.sess);
  const bobBefore = await s.footprint(bob.id);
  s.advance(400);
  expect(await s.start(carol.sess)).toMatchObject({ status: 401, body: { error: "step_up_required", reauth: "telegram" } });
  expect(await s.start(carol.sess, "anything")).toMatchObject({ status: 401, body: { reauth: "telegram" } }); // a password never substitutes
  const fresh = await s.tgLogin("777", "Carol");
  expect(fresh.id).toBe(carol.id);
  // A token from the fresh session is not usable from the stale one (session binding).
  const st = await s.start(fresh.sess);
  expect(st.status).toBe(200);
  expect((await s.del(carol.sess, await s.csrf(carol.sess), "Carol", st.body.confirm_token!))).toMatchObject({ status: 403, body: { error: "confirm_invalid" } });
  const st2 = await s.start(fresh.sess);
  const d = await s.del(fresh.sess, await s.csrf(fresh.sess), "Carol", st2.body.confirm_token!);
  expect(d.status).toBe(200);
  const after = await s.footprint(carol.id);
  for (const [k, v] of Object.entries(after)) if (k !== "audit_log.account_id") expect([k, v]).toEqual([k, 0]);
  expect(await s.n("telegram_links WHERE telegram_id = 777")).toBe(0);
  expect((await s.call("/api/account", { sess: carol.sess })).status).toBe(401);
  expect((await s.refresh(carolOAuth.refresh)).status).toBe(400);
  expect((await s.exchange(carolOAuth.unusedCode)).status).toBe(400);
  // Same Telegram id signing in again creates a brand-new account (new sub).
  const reborn = await s.tgLogin("777", "Carol");
  expect(reborn.id).not.toBe(carol.id);
  await expectBystanderIntact(s, bob, bob2, bobBefore, bobOAuth.refresh);
});

// ------------------------------------------------------------------ authz / step-up / CSRF / flag

test("AUTHZ: flag off → 503 before any write; bad CSRF; stale password session; rate limit; cross-account token", async () => {
  const off = await world({ enabled: false });
  const d0 = await off.s.dump();
  expect((await off.s.start(off.alice.sess)).status).toBe(503);
  expect((await off.s.del(off.alice.sess, await off.s.csrf(off.alice.sess), "alice", "x")).status).toBe(503);
  expect(await off.s.dump()).toBe(d0);

  const { s, alice, bob } = await world();
  const bad = await s.call("/api/account/delete/start", { sess: alice.sess, body: { csrf: "nope" } });
  expect(bad.status).toBe(403);
  const badDel = await s.call("/api/account/delete", { sess: alice.sess, body: { csrf: "nope", confirm: "alice", confirm_token: "x" } });
  expect(badDel.status).toBe(403);
  expect((await s.call("/api/account/delete/start", { body: { csrf: "x" } })).status).toBe(401);
  // Fresh login (< 5 min) issues without a password.
  expect((await s.start(alice.sess)).status).toBe(200);
  s.advance(301);
  expect(await s.start(alice.sess)).toMatchObject({ status: 401, body: { error: "step_up_required", reauth: "password" } });
  for (let i = 0; i < 5; i++) expect((await s.start(alice.sess, "wrong-" + i)).status).toBe(403);
  expect((await s.start(alice.sess, alice.password)).status).toBe(429); // correct password still throttled
  // Bob's own (fresh-by-password) token can't delete alice, and alice's can't be used from bob's session.
  const bt = await s.start(bob.sess, "accttest1234");
  expect(bt.status).toBe(200);
  expect((await s.del(bob.sess, await s.csrf(bob.sess), "alice", bt.body.confirm_token!))).toMatchObject({ status: 400, body: { error: "confirm_mismatch" } });
  expect(await s.n("accounts WHERE id IN (?, ?)", [alice.id, bob.id])).toBe(2);
});

// ------------------------------------------------------------------ concurrency

test("CONCURRENT double-submit: same token twice in parallel → exactly one deletion, one audit row", async () => {
  const { s, alice, bob, bob2, bobOAuth } = await world();
  const bobBefore = await s.footprint(bob.id);
  const st = await s.start(alice.sess);
  const c = await s.csrf(alice.sess);
  const [a, b] = await Promise.all([s.del(alice.sess, c, "alice", st.body.confirm_token!), s.del(alice.sess, c, "alice", st.body.confirm_token!)]);
  const statuses = [a.status, b.status].sort();
  console.log("DOUBLE-SUBMIT statuses", statuses, a.body, b.body);
  expect(statuses[0]).toBe(200);
  expect([401, 403]).toContain(statuses[1]);
  expect(await s.n("accounts WHERE id = ?", [alice.id])).toBe(0);
  expect(await s.n("audit_log WHERE event = 'account.delete' AND account_id = ?", [alice.id])).toBe(1);
  await expectBystanderIntact(s, bob, bob2, bobBefore, bobOAuth.refresh);
});

test("CONCURRENT two tabs: newer token invalidates the older; two sessions each with own token; parallel start+delete", async () => {
  const { s, alice, alice2 } = await world();
  const tabA = await s.start(alice.sess);
  const tabB = await s.start(alice.sess);
  expect((await s.del(alice.sess, await s.csrf(alice.sess), "alice", tabA.body.confirm_token!))).toMatchObject({ status: 403, body: { error: "confirm_invalid" } });
  expect(await s.n("accounts WHERE id = ?", [alice.id])).toBe(1);
  // Token from session 1 presented with session 2's cookie: bound to the issuing session.
  const t1 = await s.start(alice.sess);
  expect((await s.del(alice2, await s.csrf(alice2), "alice", t1.body.confirm_token!))).toMatchObject({ status: 403, body: { error: "confirm_invalid" } });
  // Parallel: tab 1 submits while tab 2 starts a new confirmation (which invalidates unused ones).
  const t2 = await s.start(alice.sess);
  const [d, st] = await Promise.all([s.del(alice.sess, await s.csrf(alice.sess), "alice", t2.body.confirm_token!), s.start(alice.sess)]);
  console.log("TWO-TABS race", d.status, d.body, st.status, st.body.error ?? "token");
  const exists = await s.n("accounts WHERE id = ?", [alice.id]);
  if (d.status === 200) expect(exists).toBe(0);
  else { expect(d.body.error).toBe("confirm_invalid"); expect(exists).toBe(1); }
  void tabB;
});

test("REPLAY: a used token is dead (sessions gone); an expired token is refused; account stays intact on refusal", async () => {
  const { s, alice, alice2 } = await world();
  const st = await s.start(alice.sess);
  s.advance(301);
  expect((await s.del(alice.sess, await s.csrf(alice.sess), "alice", st.body.confirm_token!))).toMatchObject({ status: 403, body: { error: "confirm_invalid" } });
  expect(await s.n("accounts WHERE id = ?", [alice.id])).toBe(1);
  const st2 = await s.start(alice.sess, alice.password);
  const c = await s.csrf(alice.sess);
  expect((await s.del(alice.sess, c, "alice", st2.body.confirm_token!)).status).toBe(200);
  expect((await s.del(alice.sess, c, "alice", st2.body.confirm_token!))).toMatchObject({ status: 401, body: { error: "no_session" } });
  expect((await s.call("/api/account/delete", { sess: alice2, body: { csrf: c, confirm: "alice", confirm_token: st2.body.confirm_token! } })).status).toBe(401);
  // Username re-registered by someone else: the old token is still useless to them.
  const mallory = await s.signup("alice");
  expect((await s.del(mallory.sess, await s.csrf(mallory.sess), "alice", st2.body.confirm_token!))).toMatchObject({ status: 403, body: { error: "confirm_invalid" } });
});

// ------------------------------------------------------------------ partial failure

test("NETWORK FAULT at EVERY statement of the delete batch → 500, DB byte-identical, same token then succeeds", async () => {
  const { s, alice } = await world();
  // Learn the batch length from a probe run (fault at 0).
  const st = await s.start(alice.sess);
  const c = await s.csrf(alice.sess);
  const base = await s.dump();
  s.setFault({ kind: "fail_at", index: 0 });
  expect((await s.del(alice.sess, c, "alice", st.body.confirm_token!)).status).toBe(500);
  expect(await s.dump()).toBe(base);
  const len = s.deleteBatchLens[0]!;
  console.log("DELETE batch statements", len);
  for (let i = 1; i < len; i++) {
    s.setFault({ kind: "fail_at", index: i });
    const r = await s.del(alice.sess, c, "alice", st.body.confirm_token!);
    expect([i, r.status, r.body.error]).toEqual([i, 500, "server_error"]);
    expect([i, await s.dump()]).toEqual([i, base]);
  }
  expect((await s.del(alice.sess, c, "alice", st.body.confirm_token!)).status).toBe(200);
  expect(await s.n("accounts WHERE id = ?", [alice.id])).toBe(0);
});

test("NETWORK FAULT after commit (lost response) → 200 via probe; with probe also down → 500 but fully deleted, retry sees no_session", async () => {
  const w = await world();
  let st = await w.s.start(w.alice.sess);
  w.s.setFault({ kind: "lost_response" });
  const r = await w.s.del(w.alice.sess, await w.s.csrf(w.alice.sess), "alice", st.body.confirm_token!);
  expect(r.status).toBe(200);
  expect(r.setCookie).toContain("Max-Age=0");
  expect(await w.s.n("accounts WHERE id = ?", [w.alice.id])).toBe(0);

  const w2 = await world();
  st = await w2.s.start(w2.alice.sess);
  const c = await w2.s.csrf(w2.alice.sess);
  w2.s.setFault({ kind: "lost_response", probeFails: true });
  const r2 = await w2.s.del(w2.alice.sess, c, "alice", st.body.confirm_token!);
  expect(r2.status).toBe(500);
  w2.s.healProbe();
  const fp = await w2.s.footprint(w2.alice.id);
  for (const [k, v] of Object.entries(fp)) if (k !== "audit_log.account_id") expect([k, v]).toEqual([k, 0]);
  expect((await w2.s.del(w2.alice.sess, c, "alice", st.body.confirm_token!))).toMatchObject({ status: 401, body: { error: "no_session" } });
});

test("OWNED APPS: an active owned client blocks deletion (409); a soft-deleted one is purged with every user's grants for it", async () => {
  const { s, alice, bob } = await world();
  await s.raw.execute({ sql: "INSERT INTO oauth_clients (client_id, name, owner_account_id, client_type, allowed_scopes, status) VALUES ('alice_app', 'alice-app', ?, 'public', '[\"openid\"]', 'active')", args: [alice.id] });
  await s.raw.execute({ sql: "INSERT INTO consents (account_id, client_id, scope_set_max, approved_scope_snapshot) VALUES (?, 'alice_app', '[\"openid\"]', '[\"openid\"]')", args: [bob.id] });
  const st = await s.start(alice.sess);
  expect((await s.del(alice.sess, await s.csrf(alice.sess), "alice", st.body.confirm_token!))).toMatchObject({ status: 409, body: { error: "owns_active_clients" } });
  await s.raw.execute("UPDATE oauth_clients SET deleted_at = datetime('now') WHERE client_id = 'alice_app'");
  const st2 = await s.start(alice.sess);
  expect((await s.del(alice.sess, await s.csrf(alice.sess), "alice", st2.body.confirm_token!)).status).toBe(200);
  expect(await s.n("oauth_clients WHERE client_id = 'alice_app'")).toBe(0);
  expect(await s.n("consents WHERE client_id = 'alice_app'")).toBe(0);
  expect(await s.n("consents WHERE account_id = ? AND client_id = 'rp_off'", [bob.id])).toBe(1);
});
