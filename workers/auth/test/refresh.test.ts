import { test, expect } from "vitest";
import { createRefreshToken, rotateRefresh, revokeFamily, REFRESH_IDLE_TTL } from "../src/refresh";
import { sha256Hex } from "../src/crypto";
import { routedDb, type Route } from "./helpers";

test("createRefreshToken stores sha256(token), returns rt_ prefixed raw token", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const tok = await createRefreshToken(routedDb([], log), { accountId: "a", clientId: "c", scope: ["openid"], family: "fam", now: 1000 });
  expect(tok.startsWith("rt_")).toBe(true);
  const ins = log.find((x) => x.sql.includes("INSERT INTO refresh_tokens"));
  expect(ins?.args[0]).toBe(await sha256Hex(tok));
  expect(ins?.args[6]).toBe(1000 + REFRESH_IDLE_TTL); // idle expiry
});

function rtRow(over: Record<string, unknown> = {}) {
  return {
    family_id: "fam",
    client_id: "c",
    account_id: "a",
    scope: "openid offline_access",
    used_at: null,
    idle_expires_at: 9_999_999_999,
    absolute_expires_at: 9_999_999_999,
    ...over,
  };
}

test("rotateRefresh consumes once and issues a new token in the same family", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const routes: Route[] = [
    [/SELECT \* FROM refresh_tokens WHERE token_hash/, () => ({ rows: [rtRow()] })],
    [/UPDATE refresh_tokens SET used_at .* WHERE token_hash/, () => ({ rows: [], rowsAffected: 1 })],
  ];
  const res = await rotateRefresh(routedDb(routes, log), { token: "rt_x", clientId: "c", now: 1000 });
  expect(res).toMatchObject({ ok: true, accountId: "a", family: "fam", scope: ["openid", "offline_access"] });
  if (!res.ok) return;
  expect(res.newRefresh.startsWith("rt_")).toBe(true);
});

test("rotateRefresh detects reuse and revokes the family", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const routes: Route[] = [[/SELECT \* FROM refresh_tokens WHERE token_hash/, () => ({ rows: [rtRow({ used_at: "2026-01-01" })] })]];
  const res = await rotateRefresh(routedDb(routes, log), { token: "rt_x", clientId: "c", now: 1000 });
  expect(res).toMatchObject({ ok: false, error: "invalid_grant", reuse: true });
  expect(log.some((x) => x.sql.includes("UPDATE refresh_tokens SET used_at") && x.sql.includes("family_id"))).toBe(true);
  expect(log.some((x) => x.sql.includes("UPDATE access_tokens SET revoked_at") && x.sql.includes("family_id"))).toBe(true);
});

test("rotateRefresh rejects unknown, expired, client-mismatch, and lost races", async () => {
  expect((await rotateRefresh(routedDb([[/SELECT \* FROM refresh_tokens/, () => ({ rows: [] })]]), { token: "x", clientId: "c", now: 1000 })).ok).toBe(false);
  expect((await rotateRefresh(routedDb([[/SELECT \* FROM refresh_tokens/, () => ({ rows: [rtRow({ idle_expires_at: 5 })] })]]), { token: "x", clientId: "c", now: 1000 })).ok).toBe(false);
  expect((await rotateRefresh(routedDb([[/SELECT \* FROM refresh_tokens/, () => ({ rows: [rtRow({ client_id: "other" })] })]]), { token: "x", clientId: "c", now: 1000 })).ok).toBe(false);
  const raced: Route[] = [
    [/SELECT \* FROM refresh_tokens/, () => ({ rows: [rtRow()] })],
    [/UPDATE refresh_tokens SET used_at .* WHERE token_hash/, () => ({ rows: [], rowsAffected: 0 })],
  ];
  expect((await rotateRefresh(routedDb(raced), { token: "x", clientId: "c", now: 1000 })).ok).toBe(false);
});

test("revokeFamily revokes refresh rows and access tokens", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  await revokeFamily(routedDb([], log), "fam");
  expect(log.filter((x) => x.sql.includes("family_id")).length).toBe(2);
});
