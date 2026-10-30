import { test, expect } from "vitest";
import { createClient } from "@libsql/client";
import { SCHEMA, SEED } from "../src/db";
import { handle } from "../src/index";
import { sha256Hex, hashPassword, hmacSha256Hex, CHEAP_PBKDF2 } from "../src/crypto";
import { internalConfirmString } from "../src/telegram";
import { genSigningKeys, cookieValue } from "./helpers";
import type { DbClient } from "../src/types";

// Telegram linking (VERIFY_EXISTING) needs CSRF + server-verified fresh auth, and completing a link is NOT
// authentication: the continuing session keeps the original auth_time/amr. Real in-memory libsql.

const PW = "accttest1234";
const T0 = 100_000;
const STALE = T0 - 301;

const run = (db: DbClient, sql: string, args: unknown[] = []) => db.execute({ sql, args });
const count = async (db: DbClient, sql: string, args: unknown[] = []) =>
  Number((await db.execute({ sql: `SELECT count(*) AS n FROM ${sql}`, args })).rows[0]!.n);

async function setup() {
  const db = createClient({ url: ":memory:" }) as unknown as DbClient;
  for (const stmt of [...SCHEMA, ...SEED]) await db.execute(stmt);
  const keys = await genSigningKeys();
  const env = {
    AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", WEB_ORIGIN: "https://web", CORS_ORIGINS: "https://web",
    BOT_USERNAME: "meow_bot", INTERNAL_HMAC_KEY: "ikey", ACCOUNT_DELETE_ENABLED: "1",
  };
  const deps = { getDb: () => db, clock: () => T0 };
  await run(db, "INSERT INTO accounts (id, username, display_name) VALUES ('a_pw', 'pwuser', 'PW')");
  await run(db, "INSERT INTO password_credentials (account_id, phc) VALUES ('a_pw', ?)", [await hashPassword(PW, CHEAP_PBKDF2)]);
  const addSession = async (raw: string, authTime: number, amr = "pwd") => {
    await run(db, "INSERT INTO sessions (id_hash, account_id, auth_time, amr, csrf_token, idle_expires_at, absolute_expires_at) VALUES (?, 'a_pw', ?, ?, ?, ?, ?)",
      [await sha256Hex(raw), authTime, amr, `csrf_${raw}`, T0 + 1e6, T0 + 1e6]);
    return { raw, csrf: `csrf_${raw}` };
  };
  const post = (path: string, cookie: string, body: Record<string, unknown>) =>
    handle(new Request(`https://iss${path}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) }), env as never, deps as never);
  const linkStart = (s: { raw: string; csrf: string }, extra: Record<string, unknown> = {}, csrf = s.csrf) =>
    post("/tg/start", `__Host-mw_sess=${s.raw}`, { kind: "VERIFY_EXISTING", csrf, ...extra });
  const confirm = async (nonce: string, tgId: string) => {
    const f = { nonce, telegramId: tgId, username: "u", displayName: "U", avatarUrl: "", ts: String(T0) };
    const sig = await hmacSha256Hex("ikey", internalConfirmString(f));
    return handle(new Request("https://iss/internal/tg/confirm", { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": sig },
      body: JSON.stringify({ nonce, telegram_id: tgId, username: "u", display_name: "U", avatar_url: "", ts: String(T0) }) }), env as never, deps as never);
  };
  const status = (ticketId: string, owner: string, sess?: string) =>
    handle(new Request(`https://iss/tg/status?ticket=${ticketId}`, { headers: { Cookie: `__Host-mw_tgown=${owner}${sess ? `; __Host-mw_sess=${sess}` : ""}` } }), env as never, deps as never);
  /** Full link flow from `s`; returns the status response. */
  const link = async (s: { raw: string; csrf: string }, extra: Record<string, unknown> = {}) => {
    const st = await linkStart(s, extra);
    expect(st.status).toBe(200);
    const b = (await st.json()) as { ticketId: string; deepLink: string };
    const owner = cookieValue(st.headers.get("Set-Cookie"), "__Host-mw_tgown")!;
    expect((await confirm(new URL(b.deepLink).searchParams.get("start")!, "555")).status).toBe(200);
    return status(b.ticketId, owner, s.raw);
  };
  return { db, post, addSession, linkStart, link, confirm, status };
}

test("stale session cannot start a link → 401 step_up_required; no ticket written", async () => {
  const f = await setup();
  const s = await f.addSession("raw1", STALE);
  const r = await f.linkStart(s);
  expect(r.status).toBe(401);
  expect(await r.json()).toEqual({ error: "step_up_required", reauth: "password" });
  expect(await count(f.db, "login_tickets")).toBe(0);
});

test("link start requires CSRF (missing / wrong → 403) even for a fresh session", async () => {
  const f = await setup();
  const s = await f.addSession("raw1", T0);
  expect((await f.linkStart(s, {}, "WRONG")).status).toBe(403);
  expect((await f.linkStart(s, {}, "")).status).toBe(403);
  expect(await count(f.db, "login_tickets")).toBe(0);
});

test("fresh session can start a link; stale session with the correct password can too", async () => {
  const f = await setup();
  const fresh = await f.addSession("raw1", T0 - 300);
  expect((await f.linkStart(fresh)).status).toBe(200);
  const stale = await f.addSession("raw2", STALE);
  expect((await f.linkStart(stale, { current_password: PW })).status).toBe(200);
  expect(await count(f.db, "login_tickets WHERE kind = 'VERIFY_EXISTING'")).toBe(2);
});

test("wrong password on link start → 403; the 6th attempt is rate limited (429) even with the right password", async () => {
  const f = await setup();
  const s = await f.addSession("raw1", STALE);
  for (let i = 0; i < 5; i++) expect((await f.linkStart(s, { current_password: `bad-${i}` })).status).toBe(403);
  expect((await f.linkStart(s, { current_password: PW })).status).toBe(429);
  expect(await count(f.db, "login_tickets")).toBe(0);
});

test("link completion does NOT refresh auth_time/amr: the continuing session is still stale, so delete/start needs step-up", async () => {
  const f = await setup();
  const s = await f.addSession("raw1", STALE, "pwd");
  const r = await f.link(s, { current_password: PW });
  const b = (await r.json()) as { ready: boolean; csrf: string };
  expect(b.ready).toBe(true);
  const newRaw = cookieValue(r.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  expect(newRaw).not.toBe(s.raw);
  const row = (await run(f.db, "SELECT auth_time, amr FROM sessions WHERE id_hash = ?", [await sha256Hex(newRaw)])).rows[0]!;
  expect(Number(row.auth_time)).toBe(STALE);
  expect(row.amr).toBe("pwd");
  // old session revoked (rotation)
  expect((await run(f.db, "SELECT revoked_at FROM sessions WHERE id_hash = ?", [await sha256Hex(s.raw)])).rows[0]!.revoked_at).not.toBeNull();
  // the Telegram link exists, but deletion still demands step-up
  expect(await count(f.db, "telegram_links WHERE account_id = 'a_pw'")).toBe(1);
  const del = await f.post("/api/account/delete/start", `__Host-mw_sess=${newRaw}`, { csrf: b.csrf });
  expect(del.status).toBe(401);
  expect(await del.json()).toEqual({ error: "step_up_required", reauth: "password" });
  expect(await count(f.db, "account_delete_confirmations")).toBe(0);
});

test("status without a live session of the ticket's account → 401 and the ticket stays unclaimed", async () => {
  const f = await setup();
  const s = await f.addSession("raw1", T0);
  const st = await f.linkStart(s);
  const b = (await st.json()) as { ticketId: string; deepLink: string };
  const owner = cookieValue(st.headers.get("Set-Cookie"), "__Host-mw_tgown")!;
  await f.confirm(new URL(b.deepLink).searchParams.get("start")!, "555");
  const none = await f.status(b.ticketId, owner);
  expect(none.status).toBe(401);
  expect(none.headers.get("Set-Cookie")).toBeNull();
  expect(await count(f.db, "login_tickets WHERE status = 'consumed'")).toBe(1);
  expect((await (await f.status(b.ticketId, owner, s.raw)).json() as { ready: boolean }).ready).toBe(true);
});

test("/api/account/password: wrong current password is rate limited (shared stepup bucket): 6th attempt → 429", async () => {
  const f = await setup();
  const s = await f.addSession("raw1", T0);
  for (let i = 0; i < 5; i++) {
    const r = await f.post("/api/account/password", `__Host-mw_sess=${s.raw}`, { csrf: s.csrf, current_password: `bad-${i}`, new_password: "newpass123456" });
    expect(r.status).toBe(400);
  }
  const sixth = await f.post("/api/account/password", `__Host-mw_sess=${s.raw}`, { csrf: s.csrf, current_password: PW, new_password: "newpass123456" });
  expect(sixth.status).toBe(429);
});
