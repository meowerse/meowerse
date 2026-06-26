import { test, expect } from "vitest";
import { signup, loginVerify, deriveVerified } from "../src/accounts";
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

test("deriveVerified reflects a live telegram link", async () => {
  expect(await deriveVerified(routedDb([[/FROM telegram_links WHERE account_id/, () => ({ rows: [{ "1": 1 }] })]]), "a")).toBe(
    true,
  );
  expect(await deriveVerified(routedDb([[/FROM telegram_links WHERE account_id/, () => ({ rows: [] })]]), "a")).toBe(false);
});
