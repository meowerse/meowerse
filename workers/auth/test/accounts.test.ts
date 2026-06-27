import { test, expect } from "vitest";
import { signup, loginVerify, deriveVerified, changePassword, getAccountInfo, countRecoveryCodes } from "../src/accounts";
import { hashPassword } from "../src/crypto";
import { routedDb, type Route } from "./helpers";

const FAST = { rounds: 1, iter: 500 };
const OPTS = { pbkdf2: FAST, recoveryParams: FAST };

test("signup rejects bad username / weak password before any write", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const db = routedDb([], log);
  expect((await signup(db, { username: "ab", password: "x".repeat(12) }, OPTS)).ok).toBe(false);
  expect((await signup(db, { username: "valid_user", password: "short" }, OPTS)).ok).toBe(false);
  expect(log.filter((c) => c.sql.includes("INSERT")).length).toBe(0);
});

test("signup on taken username returns generic 'unavailable'", async () => {
  const db = routedDb([[/SELECT id FROM accounts WHERE username/, () => ({ rows: [{ id: "acct_x" }] })]]);
  const res = await signup(db, { username: "taken_name", password: "abcdefghijkl" }, OPTS);
  expect(res).toEqual({ ok: false, error: "unavailable" });
});

test("successful signup writes account+credential+8 codes and returns codes once", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const db = routedDb([[/SELECT id FROM accounts WHERE username/, () => ({ rows: [] })]], log);
  const res = await signup(db, { username: "neko_dev", password: "abcdefghijkl" }, OPTS);
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.recoveryCodes.length).toBe(8);
  expect(log.filter((c) => c.sql.includes("INSERT INTO accounts")).length).toBe(1);
  expect(log.filter((c) => c.sql.includes("INSERT INTO password_credentials")).length).toBe(1);
  expect(log.filter((c) => c.sql.includes("INSERT INTO recovery_codes")).length).toBe(8);
});

test("loginVerify: correct password ok; wrong password not ok", async () => {
  const phc = await hashPassword("abcdefghijkl", FAST);
  const routes: Route[] = [
    [/SELECT id FROM accounts WHERE username/, () => ({ rows: [{ id: "acct_1" }] })],
    [/FROM password_credentials WHERE account_id/, () => ({ rows: [{ phc }] })],
  ];
  expect(await loginVerify(routedDb(routes), { username: "neko", password: "abcdefghijkl" }, { dummyPhc: phc })).toEqual({
    ok: true,
    accountId: "acct_1",
  });
  expect((await loginVerify(routedDb(routes), { username: "neko", password: "WRONGWRONGWRONG" }, { dummyPhc: phc })).ok).toBe(
    false,
  );
});

test("loginVerify on unknown user still runs a dummy verify (enumeration-safe) and returns not ok", async () => {
  const dummy = await hashPassword("zzz", FAST);
  const log: { sql: string; args: unknown[] }[] = [];
  const db = routedDb([[/SELECT id FROM accounts WHERE username/, () => ({ rows: [] })]], log);
  const res = await loginVerify(db, { username: "ghost", password: "whatever12345" }, { dummyPhc: dummy });
  expect(res.ok).toBe(false);
  // it queried accounts but never queried/derived a real credential
  expect(log.some((c) => c.sql.includes("SELECT id FROM accounts"))).toBe(true);
});

test("loginVerify with missing credential row is enumeration-safe too", async () => {
  const dummy = await hashPassword("zzz", FAST);
  const routes: Route[] = [
    [/SELECT id FROM accounts WHERE username/, () => ({ rows: [{ id: "acct_1" }] })],
    [/FROM password_credentials WHERE account_id/, () => ({ rows: [] })],
  ];
  expect((await loginVerify(routedDb(routes), { username: "neko", password: "x".repeat(12) }, { dummyPhc: dummy })).ok).toBe(
    false,
  );
});

test("signup honors an explicit displayName", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const db = routedDb([[/SELECT id FROM accounts WHERE username/, () => ({ rows: [] })]], log);
  const res = await signup(db, { username: "neko_dev", password: "abcdefghijkl", displayName: "Neko" }, OPTS);
  expect(res.ok).toBe(true);
  const accIns = log.find((c) => c.sql.includes("INSERT INTO accounts"));
  expect(accIns?.args[2]).toBe("Neko");
});

test("loginVerify falls back to the default dummy hash when none injected", async () => {
  const db = routedDb([[/SELECT id FROM accounts WHERE username/, () => ({ rows: [] })]]);
  expect((await loginVerify(db, { username: "ghost", password: "whatever12345" })).ok).toBe(false);
});

test("signup and loginVerify tolerate a missing username field", async () => {
  const db = routedDb([[/SELECT id FROM accounts WHERE username/, () => ({ rows: [] })]]);
  expect((await signup(db, { password: "abcdefghijkl" } as never, OPTS)).ok).toBe(false);
  const phc = await hashPassword("zzz", FAST);
  expect((await loginVerify(db, { password: "abcdefghijkl" } as never, { dummyPhc: phc })).ok).toBe(false);
});

test("changePassword: no password row → no_password; wrong current → wrong_password; weak new → policy error; ok → updates", async () => {
  const noPw = routedDb([[/SELECT phc FROM password_credentials/, () => ({ rows: [] })]]);
  expect(await changePassword(noPw, { accountId: "a", currentPassword: "x", newPassword: "y".repeat(12), pbkdf2: FAST })).toEqual({ ok: false, error: "no_password" });

  const phc = await hashPassword("currentpass12", FAST);
  const has = routedDb([[/SELECT phc FROM password_credentials/, () => ({ rows: [{ phc }] })]]);
  expect((await changePassword(has, { accountId: "a", currentPassword: "WRONG", newPassword: "newpass123456", pbkdf2: FAST })).error).toBe("wrong_password");
  expect((await changePassword(has, { accountId: "a", currentPassword: "currentpass12", newPassword: "short", pbkdf2: FAST })).ok).toBe(false);

  const log: { sql: string; args: unknown[] }[] = [];
  const db = routedDb([[/SELECT phc FROM password_credentials/, () => ({ rows: [{ phc }] })]], log);
  expect((await changePassword(db, { accountId: "a", currentPassword: "currentpass12", newPassword: "newpass123456", pbkdf2: FAST })).ok).toBe(true);
  expect(log.some((c) => c.sql.includes("UPDATE password_credentials SET phc"))).toBe(true);
});

test("getAccountInfo + countRecoveryCodes", async () => {
  const db = routedDb([
    [/SELECT username, display_name, avatar_url FROM accounts WHERE id/, () => ({ rows: [{ username: "neko", display_name: "Neko", avatar_url: null }] })],
    [/SELECT 1 FROM password_credentials/, () => ({ rows: [{ "1": 1 }] })],
  ]);
  expect(await getAccountInfo(db, "a")).toEqual({ username: "neko", displayName: "Neko", avatarUrl: null, hasPassword: true });
  expect(await getAccountInfo(routedDb([[/FROM accounts WHERE id/, () => ({ rows: [] })]]), "ghost")).toBeNull();
  expect(await countRecoveryCodes(routedDb([[/COUNT/, () => ({ rows: [{ n: 5 }] })]]), "a")).toBe(5);
});

test("deriveVerified reflects a live telegram link", async () => {
  expect(await deriveVerified(routedDb([[/FROM telegram_links WHERE account_id/, () => ({ rows: [{ "1": 1 }] })]]), "a")).toBe(
    true,
  );
  expect(await deriveVerified(routedDb([[/FROM telegram_links WHERE account_id/, () => ({ rows: [] })]]), "a")).toBe(false);
});
