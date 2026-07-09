import { test, expect } from "vitest";
import { createClient } from "@libsql/client";
import { SCHEMA } from "../src/db";
import { checkRateLimit } from "../src/ratelimit";
import { routedDb } from "./helpers";
import type { DbClient } from "../src/types";

// The window/reset logic now lives inside the atomic upsert (CASE ... RETURNING),
// so exercise it against a REAL in-memory libSQL — a pattern-matched fake can't
// verify the SQL is correct.
async function freshDb(): Promise<DbClient> {
  const c = createClient({ url: ":memory:" }) as unknown as DbClient;
  for (const stmt of SCHEMA) await c.execute(stmt);
  return c;
}

test("one atomic upsert: first hit allowed, increments within the window, blocks at the limit", async () => {
  const db = await freshDb();
  for (let i = 1; i <= 5; i++) {
    const r = await checkRateLimit(db, "login:abc", { limit: 5, windowSec: 60, now: 1000 });
    expect(r).toEqual({ allowed: true, remaining: 5 - i });
  }
  // 6th within the window → blocked, remaining 0 (and the counter is not read again)
  const over = await checkRateLimit(db, "login:abc", { limit: 5, windowSec: 60, now: 1030 });
  expect(over).toEqual({ allowed: false, remaining: 0 });
});

test("an elapsed window resets the counter to 1", async () => {
  const db = await freshDb();
  for (let i = 0; i < 5; i++) await checkRateLimit(db, "b", { limit: 5, windowSec: 60, now: 1000 });
  expect((await checkRateLimit(db, "b", { limit: 5, windowSec: 60, now: 1030 })).allowed).toBe(false);
  // now-window_start (1000+61 - 1000 = 61) >= 60 → reset
  expect(await checkRateLimit(db, "b", { limit: 5, windowSec: 60, now: 1061 })).toEqual({ allowed: true, remaining: 4 });
});

test("buckets are independent", async () => {
  const db = await freshDb();
  await checkRateLimit(db, "a", { limit: 1, windowSec: 60, now: 1000 });
  expect((await checkRateLimit(db, "a", { limit: 1, windowSec: 60, now: 1000 })).allowed).toBe(false);
  expect((await checkRateLimit(db, "b", { limit: 1, windowSec: 60, now: 1000 })).allowed).toBe(true);
});

test("issues exactly ONE statement (the atomic upsert), no separate SELECT", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const db = routedDb([[/INSERT INTO rate_limits/, () => ({ rows: [{ count: 1 }] })]], log);
  const r = await checkRateLimit(db, "login:abc", { limit: 5, windowSec: 60, now: 1000 });
  expect(r).toEqual({ allowed: true, remaining: 4 });
  expect(log.length).toBe(1);
  expect(log[0]!.sql).toContain("INSERT INTO rate_limits");
  expect(log[0]!.sql).toContain("RETURNING count");
  expect(log.some((c) => c.sql.startsWith("SELECT"))).toBe(false);
});
