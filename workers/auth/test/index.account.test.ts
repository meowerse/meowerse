import { test, expect } from "vitest";
import { handle } from "../src/index";
import { genSigningKeys, memStore, cookieValue } from "./helpers";

async function loggedIn(username: string, extraEnv: Record<string, string> = { ACCOUNT_DELETE_ENABLED: "1" }) {
  const store = memStore();
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", WEB_ORIGIN: "https://web", CORS_ORIGINS: "https://web", ...extraEnv };
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
async function startToken(env: unknown, deps: unknown, sess: string, csrf: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await post(env, deps, "/api/account/delete/start", sess, { csrf, ...extra });
  expect(r.status).toBe(200);
  return ((await r.json()) as { confirm_token: string }).confirm_token;
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
  const grants = ((await list.json()) as { grants: { clientId: string; displayName: string | null; approvedScopes: string[] }[] }).grants;
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({ clientId: "mw_demo", displayName: "Meowerse Demo", approvedScopes: ["openid", "profile"] });

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
  // no confirmation token
  expect((await post(env, deps, "/api/account/delete", sess, { csrf, confirm: "neko_del" })).status).toBe(403);
  // correct
  const confirm_token = await startToken(env, deps, sess, csrf);
  const ok = await post(env, deps, "/api/account/delete", sess, { csrf, confirm: "neko_del", confirm_token });
  expect(ok.status).toBe(200);
  expect(ok.headers.get("Set-Cookie")).toContain("mw_sess");
  // session is gone → the same cookie now 401s
  expect((await get(env, deps, "/api/account", sess)).status).toBe(401);
});

test("POST /api/account/delete on a leftover session whose account already vanished → 401 no_session (lookupSession joins accounts)", async () => {
  const { store, env, deps, sess, csrf } = await loggedIn("neko_ghost");
  // drop the account row but keep the session valid
  store.tables.accounts = store.tables.accounts.filter((a) => a.username !== "neko_ghost");
  const r = await post(env, deps, "/api/account/delete", sess, { csrf, confirm: "neko_ghost" });
  expect(r.status).toBe(401);
  expect(await r.json()).toEqual({ error: "no_session" });
});

test("POST /api/account/delete confirms against displayName for a username-less (telegram-only) account", async () => {
  const store = memStore();
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", CORS_ORIGINS: "https://web", ACCOUNT_DELETE_ENABLED: "true" };
  const deps = { getDb: () => store.db, clock: () => 1000 };
  const idHash = await (await import("../src/crypto")).sha256Hex("delraw");
  store.tables.accounts.push({ id: "acct_tgd", username: null, display_name: "TG Del", avatar_url: null, verified: 1 });
  store.tables.telegram_links.push({ telegram_id: "7", account_id: "acct_tgd", telegram_username: "tgd" });
  store.tables.sessions.push({ id_hash: idHash, account_id: "acct_tgd", auth_time: 1000, amr: "tg", csrf_token: "csrfd", idle_expires_at: 9e9, absolute_expires_at: 9e9, revoked_at: null });
  // confirm must equal the displayName (username is null)
  expect((await post(env, deps, "/api/account/delete", "delraw", { csrf: "csrfd", confirm: "wrong" })).status).toBe(400);
  const confirm_token = await startToken(env, deps, "delraw", "csrfd");
  const ok = await post(env, deps, "/api/account/delete", "delraw", { csrf: "csrfd", confirm: "TG Del", confirm_token });
  expect(ok.status).toBe(200);
  expect(store.tables.accounts.some((a) => a.id === "acct_tgd")).toBe(false);
});

test("GET /api/account reports deleteEnabled true only for flag \"1\"/\"true\"", async () => {
  for (const [flag, want] of [["1", true], ["true", true], [undefined, false], ["0", false], ["yes", false], ["", false]] as const) {
    const { env, deps, sess } = await loggedIn(`neko_flag_${want}_${String(flag)}`.replace(/\W/g, "_"), flag === undefined ? {} : { ACCOUNT_DELETE_ENABLED: flag });
    const b = (await (await get(env, deps, "/api/account", sess)).json()) as { deleteEnabled: unknown };
    expect(b.deleteEnabled).toBe(want);
  }
});

test("POST /api/account/delete with the flag off/unset → 503 deletion_unavailable, nothing changes, no audit row", async () => {
  for (const extra of [{}, { ACCOUNT_DELETE_ENABLED: "0" }, { ACCOUNT_DELETE_ENABLED: "off" }]) {
    const { store, env, deps, sess, csrf, accountId } = await loggedIn(`neko_off_${Object.values(extra)[0] ?? "unset"}`, extra);
    const before = JSON.stringify(store.tables);
    const auditBefore = (store.tables.audit_log ?? []).length;
    const confirm = `neko_off_${Object.values(extra)[0] ?? "unset"}`;
    const st = await post(env, deps, "/api/account/delete/start", sess, { csrf, current_password: "accttest1234" });
    expect(st.status).toBe(503);
    expect(await st.json()).toEqual({ error: "deletion_unavailable" });
    const r = await post(env, deps, "/api/account/delete", sess, { csrf, confirm, confirm_token: "x" });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "deletion_unavailable" });
    expect(r.headers.get("Set-Cookie")).toBeNull();
    expect(JSON.stringify(store.tables)).toBe(before);
    expect((store.tables.audit_log ?? []).length).toBe(auditBefore);
    expect(store.tables.accounts.some((a) => a.id === accountId)).toBe(true);
    expect((await get(env, deps, "/api/account", sess)).status).toBe(200); // session survives
  }
});

test("POST /api/account/delete with an active owned client (memStore) → 409 owns_active_clients, account kept", async () => {
  const { store, env, deps, sess, csrf, accountId } = await loggedIn("neko_owner");
  store.tables.oauth_clients.push({ client_id: "cl_own", owner_account_id: accountId, deleted_at: null });
  const confirm_token = await startToken(env, deps, sess, csrf);
  const r = await post(env, deps, "/api/account/delete", sess, { csrf, confirm: "neko_owner", confirm_token });
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: "owns_active_clients" });
  expect(store.tables.accounts.some((a) => a.id === accountId)).toBe(true);
  expect(store.tables.audit_log.some((a) => a.event === "account.delete")).toBe(false);
});
