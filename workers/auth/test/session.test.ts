import { test, expect } from "vitest";
import { issueSession, lookupSession, revokeSession, rotateSession, IDLE_TTL } from "../src/session";
import { sha256Hex } from "../src/crypto";
import { routedDb, type Route } from "./helpers";

test("issueSession stores sha256(rawId), never the raw id", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const db = routedDb([], log);
  const s = await issueSession(db, { accountId: "acct_1", amr: "pwd", authTime: 1000, now: 1000 });
  const ins = log.find((c) => c.sql.includes("INSERT INTO sessions"));
  expect(ins?.args[0]).toBe(await sha256Hex(s.rawId));
  expect(ins?.args[0]).not.toBe(s.rawId);
  expect(ins?.args[5]).toBe(1000 + IDLE_TTL);
});

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    account_id: "acct_1",
    auth_time: 1000,
    csrf_token: "csrf123",
    amr: "pwd",
    idle_expires_at: 9_999_999_999,
    absolute_expires_at: 9_999_999_999,
    revoked_at: null,
    ...over,
  };
}

test("lookupSession returns view + rolls idle for a live session", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const db = routedDb([[/SELECT account_id, auth_time/, () => ({ rows: [sessionRow()] })]], log);
  const view = await lookupSession(db, "rawid", 2000);
  expect(view).toEqual({ accountId: "acct_1", authTime: 1000, csrf: "csrf123", amr: "pwd" });
  expect(log.some((c) => c.sql.includes("UPDATE sessions SET last_seen"))).toBe(true);
});

test("lookupSession returns null when absent, revoked, or expired", async () => {
  expect(await lookupSession(routedDb([[/SELECT account_id/, () => ({ rows: [] })]]), "x", 1)).toBeNull();
  expect(
    await lookupSession(routedDb([[/SELECT account_id/, () => ({ rows: [sessionRow({ revoked_at: "2026" })] })]]), "x", 1),
  ).toBeNull();
  expect(
    await lookupSession(routedDb([[/SELECT account_id/, () => ({ rows: [sessionRow({ idle_expires_at: 5 })] })]]), "x", 99),
  ).toBeNull();
  expect(await lookupSession(routedDb([]), undefined, 1)).toBeNull();
});

test("revokeSession sets revoked_at by id hash", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  await revokeSession(routedDb([], log), "rawid");
  const upd = log.find((c) => c.sql.includes("UPDATE sessions SET revoked_at"));
  expect(upd?.args[0]).toBe(await sha256Hex("rawid"));
});

test("rotateSession revokes old and issues new for a live session; null when stale", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const routes: Route[] = [[/SELECT account_id, auth_time/, () => ({ rows: [sessionRow()] })]];
  const rotated = await rotateSession(routedDb(routes, log), "old", { now: 2000 });
  expect(rotated).not.toBeNull();
  expect(log.some((c) => c.sql.includes("UPDATE sessions SET revoked_at"))).toBe(true);
  expect(log.some((c) => c.sql.includes("INSERT INTO sessions"))).toBe(true);

  const stale = await rotateSession(routedDb([[/SELECT account_id/, () => ({ rows: [] })]]), "old", { now: 2000 });
  expect(stale).toBeNull();
});
