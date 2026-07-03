import { test, expect } from "vitest";
import { handle } from "../src/index";
import { genSigningKeys, memStore, cookieValue } from "./helpers";

async function loggedIn(username: string) {
  const store = memStore();
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", WEB_ORIGIN: "https://web", CORS_ORIGINS: "https://web" };
  const deps = { getDb: () => store.db, clock: () => 1000 };
  const su = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: "accttest1234" }) }), env as never, deps as never);
  const b = (await su.json()) as { csrf: string };
  const sess = cookieValue(su.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  const accountId = store.tables.accounts.find((a) => a.username === username)!.id as string;
  return { store, env, deps, sess, csrf: b.csrf, accountId };
}

function post(env: unknown, deps: unknown, path: string, sess: string, body: unknown) {
  return handle(new Request(`https://iss${path}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${sess}` }, body: JSON.stringify(body) }), env as never, deps as never);
}
function get(env: unknown, deps: unknown, path: string, sess?: string) {
  return handle(new Request(`https://iss${path}`, { headers: sess ? { Cookie: `__Host-mw_sess=${sess}` } : {} }), env as never, deps as never);
}

test("GET /api/account returns profile + verified + telegram + recovery count + csrf", async () => {
  const { env, deps, sess } = await loggedIn("neko_acct");
  const r = await get(env, deps, "/api/account", sess);
  const b = (await r.json()) as Record<string, unknown>;
  expect(r.status).toBe(200);
  expect(b).toMatchObject({ username: "neko_acct", verified: false, hasPassword: true, recoveryRemaining: 8 });
  expect((b.telegram as { linked: boolean }).linked).toBe(false);
  expect(b.csrf).toBeTruthy();
  // no session → 401
  expect((await get(env, deps, "/api/account")).status).toBe(401);
});

test("change password: bad csrf 403, wrong current 400, correct 200; recovery regen returns 8 new codes", async () => {
  const { env, deps, sess, csrf } = await loggedIn("neko_pw");
  expect((await post(env, deps, "/api/account/password", sess, { csrf: "WRONG", current_password: "accttest1234", new_password: "newpass123456" })).status).toBe(403);
  expect((await post(env, deps, "/api/account/password", sess, { csrf, current_password: "nope", new_password: "newpass123456" })).status).toBe(400);
  expect((await post(env, deps, "/api/account/password", sess, { csrf, current_password: "accttest1234", new_password: "newpass123456" })).status).toBe(200);

  const rc = await post(env, deps, "/api/account/recovery-codes", sess, { csrf });
  expect(((await rc.json()) as { recoveryCodes: string[] }).recoveryCodes.length).toBe(8);
});

test("grants: list + revoke; telegram unlink guarded by a password fallback", async () => {
  const { store, env, deps, sess, csrf, accountId } = await loggedIn("neko_grants");
  store.tables.consents.push({ account_id: accountId, client_id: "mw_demo", scope_set_max: '["openid","profile"]', approved_scope_snapshot: '["openid","profile"]' });

  const list = await get(env, deps, "/api/account/grants", sess);
  const grants = ((await list.json()) as { grants: { clientId: string; approvedScopes: string[] }[] }).grants;
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({ clientId: "mw_demo", approvedScopes: ["openid", "profile"] });

  const rev = await post(env, deps, "/api/account/grants/revoke", sess, { csrf, client_id: "mw_demo" });
  expect(rev.status).toBe(200);
  expect(((await (await get(env, deps, "/api/account/grants", sess)).json()) as { grants: unknown[] }).grants).toHaveLength(0);

  // password account → unlink allowed (no telegram present, just clears verified) → 200
  expect((await post(env, deps, "/api/account/telegram/unlink", sess, { csrf })).status).toBe(200);
});

test("telegram-only account cannot unlink Telegram (would lock out) → 409", async () => {
  const store = memStore();
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", CORS_ORIGINS: "https://web" };
  const deps = { getDb: () => store.db, clock: () => 1000 };
  // a telegram-only account (no password) with a session
  store.tables.accounts.push({ id: "acct_tg", username: null, display_name: "Tg", avatar_url: null, verified: 1 });
  store.tables.telegram_links.push({ telegram_id: "5", account_id: "acct_tg", telegram_username: "tg" });
  store.tables.sessions.push({ id_hash: await (await import("../src/crypto")).sha256Hex("sraw"), account_id: "acct_tg", auth_time: 1000, amr: "tg", csrf_token: "csrf9", idle_expires_at: 9e9, absolute_expires_at: 9e9, revoked_at: null });
  const r = await post(env, deps, "/api/account/telegram/unlink", "sraw", { csrf: "csrf9" });
  expect(r.status).toBe(409);
});

test("unknown /api/account sub-path → 404", async () => {
  const { env, deps, sess, csrf } = await loggedIn("neko_404");
  expect((await post(env, deps, "/api/account/bogus", sess, { csrf })).status).toBe(404);
});

test("POST /api/account/delete: bad csrf 403, wrong confirm 400, correct erases + clears cookie + kills session", async () => {
  const { env, deps, sess, csrf } = await loggedIn("neko_del");
  // bad csrf
  expect((await post(env, deps, "/api/account/delete", sess, { csrf: "WRONG", confirm: "neko_del" })).status).toBe(403);
  // wrong confirmation phrase
  expect((await post(env, deps, "/api/account/delete", sess, { csrf, confirm: "nope" })).status).toBe(400);
  // correct
  const ok = await post(env, deps, "/api/account/delete", sess, { csrf, confirm: "neko_del" });
  expect(ok.status).toBe(200);
  expect(ok.headers.get("Set-Cookie")).toContain("mw_sess");
  // session is gone → the same cookie now 401s
  expect((await get(env, deps, "/api/account", sess)).status).toBe(401);
});
