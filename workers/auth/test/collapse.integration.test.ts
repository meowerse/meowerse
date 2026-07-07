import { test, expect } from "vitest";
import { createClient } from "@libsql/client";
import { TYP, TOKEN_USE } from "@meowerse/auth-shared";
import { SCHEMA } from "../src/db";
import { issueSession, whoami, rollIdle, IDLE_TTL } from "../src/session";
import { getAccountInfo, getAccountDetail, loginVerify, deriveVerified } from "../src/accounts";
import { getClient } from "../src/clients";
import { userinfoClaims } from "../src/userinfo";
import { hashPassword, CHEAP_PBKDF2 } from "../src/crypto";
import type { DbClient } from "../src/types";

// These run the ACTUAL collapsed SQL against a real in-memory libSQL/SQLite —
// the pattern-matched memStore fake can't verify that a JOIN / EXISTS / expiry
// predicate is correct, and /api/session gates authentication, so it gets a
// real database. Each test gets a fresh, isolated in-memory DB.
async function freshDb(): Promise<DbClient> {
  const c = createClient({ url: ":memory:" }) as unknown as DbClient;
  for (const stmt of SCHEMA) await c.execute(stmt);
  return c;
}

test("whoami: validates the session and returns profile + live verified in one query", async () => {
  const db = await freshDb();
  await db.execute({ sql: "INSERT INTO accounts (id, username, display_name) VALUES (?, ?, ?)", args: ["acct_1", "alice", "Alice"] });
  const sess = await issueSession(db, { accountId: "acct_1", amr: "pwd", authTime: 1000, now: 1000 });

  // valid session, no telegram link → verified false
  const w1 = await whoami(db, sess.rawId, 1000);
  expect(w1?.username).toBe("alice");
  expect(w1?.displayName).toBe("Alice");
  expect(w1?.verified).toBe(false);
  expect(w1?.idHash).toBe(sess.idHash);

  // link telegram → verified true, and the EXISTS agrees with deriveVerified
  await db.execute({ sql: "INSERT INTO telegram_links (telegram_id, account_id) VALUES (?, ?)", args: [42, "acct_1"] });
  expect((await whoami(db, sess.rawId, 1000))?.verified).toBe(true);
  expect(await deriveVerified(db, "acct_1")).toBe(true);
});

test("whoami: rejects unknown, revoked, and expired sessions", async () => {
  const db = await freshDb();
  await db.execute({ sql: "INSERT INTO accounts (id, username) VALUES (?, ?)", args: ["acct_2", "bob"] });
  const sess = await issueSession(db, { accountId: "acct_2", amr: "pwd", authTime: 1000, now: 1000 });

  expect(await whoami(db, undefined, 1000)).toBeNull();
  expect(await whoami(db, "not-a-real-cookie", 1000)).toBeNull();

  // idle-expired (past the sliding window) → null, then rollIdle revives it
  const past = 1000 + IDLE_TTL + 1;
  expect(await whoami(db, sess.rawId, past)).toBeNull();
  await rollIdle(db, sess.idHash, past);
  expect(await whoami(db, sess.rawId, past)).not.toBeNull();

  // revoked → null
  await db.execute({ sql: "UPDATE sessions SET revoked_at = datetime('now') WHERE id_hash = ?", args: [sess.idHash] });
  expect(await whoami(db, sess.rawId, past)).toBeNull();
});

test("getAccountInfo: folds the password-existence check into one query", async () => {
  const db = await freshDb();
  await db.execute({ sql: "INSERT INTO accounts (id, username, display_name) VALUES (?, ?, ?)", args: ["acct_3", "carol", "Carol"] });

  const noPw = await getAccountInfo(db, "acct_3");
  expect(noPw).toEqual({ username: "carol", displayName: "Carol", avatarUrl: null, hasPassword: false });

  await db.execute({ sql: "INSERT INTO password_credentials (account_id, phc) VALUES (?, ?)", args: ["acct_3", "phc"] });
  expect((await getAccountInfo(db, "acct_3"))?.hasPassword).toBe(true);

  expect(await getAccountInfo(db, "missing")).toBeNull();
});

test("getClient: one query returns the client + its redirect URIs (json_group_array)", async () => {
  const db = await freshDb();
  await db.execute({ sql: "INSERT INTO accounts (id, username) VALUES ('acct_owner', 'owner')" }); // FK target for owner_account_id
  await db.execute({
    sql: `INSERT INTO oauth_clients (client_id, name, owner_account_id, client_type, display_name, allowed_scopes, first_party)
          VALUES ('c1', 'app-one', 'acct_owner', 'public', 'App One', '["openid","profile"]', 0)`,
  });
  await db.execute({ sql: "INSERT INTO oauth_clients (client_id, name, owner_account_id, client_type, allowed_scopes) VALUES ('c2','app-two','acct_owner','public','[]')" });
  for (const uri of ["https://a.example/cb", "https://a.example/cb2"]) {
    await db.execute({ sql: "INSERT INTO oauth_client_redirect_uris (client_id, redirect_uri) VALUES ('c1', ?)", args: [uri] });
  }

  const c1 = await getClient(db, "c1");
  expect(c1?.allowedScopes).toEqual(["openid", "profile"]);
  expect(c1?.redirectUris.sort()).toEqual(["https://a.example/cb", "https://a.example/cb2"]);

  // client with zero redirect URIs → json_group_array yields '[]', parsed to []
  expect((await getClient(db, "c2"))?.redirectUris).toEqual([]);
  expect(await getClient(db, "ghost")).toBeNull();
});

test("loginVerify: one query gets id + phc; correct/wrong/no-credential/unknown all behave", async () => {
  const db = await freshDb();
  const phc = await hashPassword("correct-horse", CHEAP_PBKDF2);
  await db.execute({ sql: "INSERT INTO accounts (id, username) VALUES ('acct_l', 'log_user')" });
  await db.execute({ sql: "INSERT INTO password_credentials (account_id, phc) VALUES ('acct_l', ?)", args: [phc] });

  expect(await loginVerify(db, { username: "log_user", password: "correct-horse" })).toEqual({ ok: true, accountId: "acct_l" });
  expect((await loginVerify(db, { username: "log_user", password: "wrong-pass-here" })).ok).toBe(false);
  expect((await loginVerify(db, { username: "ghost", password: "correct-horse" })).ok).toBe(false); // unknown user
  // account with no password credential → phc null → not ok
  await db.execute({ sql: "INSERT INTO accounts (id, username) VALUES ('acct_np', 'no_pw')" });
  expect((await loginVerify(db, { username: "no_pw", password: "correct-horse" })).ok).toBe(false);
});

test("userinfoClaims: one query yields scope-filtered profile + telegram + live verified", async () => {
  const db = await freshDb();
  await db.execute({ sql: "INSERT INTO accounts (id, username, display_name, avatar_url) VALUES ('acct_u','uni','Uni','http://img')" });
  await db.execute({ sql: "INSERT INTO telegram_links (telegram_id, account_id, telegram_username) VALUES (77, 'acct_u', 'uni_tg')" });
  const base = { header: { typ: TYP.ACCESS }, resourceAud: "https://api.meow", issuer: "https://iss" };
  const payload = (scope: string) => ({ token_use: TOKEN_USE.ACCESS, sub: "acct_u", scope, aud: "https://api.meow" });

  const full = await userinfoClaims(db, { ...base, payload: payload("openid profile telegram verified") });
  expect(full.ok && full.claims).toMatchObject({
    sub: "acct_u",
    preferred_username: "uni",
    telegram_id: 77,
    telegram_username: "uni_tg",
    verified: true,
  });
  // openid only → just sub (no profile/telegram/verified leaked)
  const min = await userinfoClaims(db, { ...base, payload: payload("openid") });
  expect(min.ok && min.claims).toEqual({ sub: "acct_u" });
});

test("getAccountDetail: one query returns profile + password + telegram + verified + recovery count", async () => {
  const db = await freshDb();
  await db.execute({ sql: "INSERT INTO accounts (id, username, display_name) VALUES ('acct_d','deet','Deet')" });
  // no password, no telegram, no recovery codes yet
  expect(await getAccountDetail(db, "acct_d")).toEqual({
    username: "deet",
    displayName: "Deet",
    avatarUrl: null,
    hasPassword: false,
    verified: false,
    telegram: { linked: false, username: null },
    recoveryRemaining: 0,
  });

  await db.execute({ sql: "INSERT INTO password_credentials (account_id, phc) VALUES ('acct_d','x')" });
  await db.execute({ sql: "INSERT INTO telegram_links (telegram_id, account_id, telegram_username) VALUES (88,'acct_d','deet_tg')" });
  await db.execute({ sql: "INSERT INTO recovery_codes (account_id, code_hash) VALUES ('acct_d','h1'),('acct_d','h2')" });
  await db.execute({ sql: "UPDATE recovery_codes SET used_at = datetime('now') WHERE account_id='acct_d' AND code_hash='h1'" });

  const d = await getAccountDetail(db, "acct_d");
  expect(d).toMatchObject({
    hasPassword: true,
    verified: true,
    telegram: { linked: true, username: "deet_tg" },
    recoveryRemaining: 1, // one of two codes used
  });
  expect(await getAccountDetail(db, "missing")).toBeNull();
});

test("null profile fields survive the collapses (all-null account)", async () => {
  const db = await freshDb();
  await db.execute({ sql: "INSERT INTO accounts (id) VALUES ('acct_z')" }); // username/display/avatar all NULL

  expect(await getAccountInfo(db, "acct_z")).toEqual({ username: null, displayName: null, avatarUrl: null, hasPassword: false });
  expect(await getAccountDetail(db, "acct_z")).toEqual({
    username: null,
    displayName: null,
    avatarUrl: null,
    hasPassword: false,
    verified: false,
    telegram: { linked: false, username: null },
    recoveryRemaining: 0,
  });

  const ui = await userinfoClaims(db, {
    header: { typ: TYP.ACCESS },
    payload: { token_use: TOKEN_USE.ACCESS, sub: "acct_z", scope: "openid profile telegram verified", aud: "https://api.meow" },
    resourceAud: "https://api.meow",
    issuer: "https://iss",
  });
  expect(ui.ok && ui.claims).toEqual({ sub: "acct_z", preferred_username: null, name: null, picture: null, verified: false });
});
