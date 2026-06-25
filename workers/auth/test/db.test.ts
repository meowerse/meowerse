import { test, expect } from "vitest";
import { ensureSchema, prodDeps, STATEMENTS, type Deps } from "../src/db";
import type { DbClient } from "../src/types";

function fakeDb(calls: string[]): DbClient {
  return {
    execute: async (s) => {
      calls.push(typeof s === "string" ? s : s.sql);
      return { rows: [] };
    },
  };
}

test("ensureSchema runs every statement once, memoized across concurrent calls", async () => {
  const calls: string[] = [];
  const deps: Deps = { getDb: () => fakeDb(calls) };
  await Promise.all([ensureSchema(deps), ensureSchema(deps)]);
  expect(calls.length).toBe(STATEMENTS.length);
  expect(calls.some((s) => s.includes("CREATE TABLE IF NOT EXISTS accounts"))).toBe(true);
  expect(calls.some((s) => s.includes("INSERT OR IGNORE INTO oauth_clients"))).toBe(true);
});

test("ensureSchema does not re-run after it resolves", async () => {
  let n = 0;
  const deps: Deps = { getDb: () => ({ execute: async () => ((n++), { rows: [] }) }) };
  await ensureSchema(deps);
  const after = n;
  await ensureSchema(deps);
  expect(n).toBe(after);
});

test("prodDeps memoizes a single libsql client", () => {
  const deps = prodDeps({ DATABASE_URL: "libsql://test.turso.io", DATABASE_AUTH_TOKEN: "t" });
  const a = deps.getDb();
  const b = deps.getDb();
  expect(a).toBe(b);
});
