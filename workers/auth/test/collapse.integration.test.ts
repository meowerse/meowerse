import { test, expect } from "vitest";
import { createClient } from "@libsql/client";
import { SCHEMA } from "../src/db";
import { issueSession, whoami, rollIdle, IDLE_TTL } from "../src/session";
import { getAccountInfo, deriveVerified } from "../src/accounts";
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
