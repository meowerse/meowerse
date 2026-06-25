import { test, expect } from "vitest";
import { checkRateLimit } from "../src/ratelimit";
import { routedDb, type Route } from "./helpers";

test("first hit in a fresh window is allowed and writes count=1", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const db = routedDb([[/SELECT count, window_start FROM rate_limits/, () => ({ rows: [] })]], log);
  const r = await checkRateLimit(db, "login:abc", { limit: 5, windowSec: 60, now: 1000 });
  expect(r).toEqual({ allowed: true, remaining: 4 });
  const ins = log.find((c) => c.sql.includes("INSERT INTO rate_limits"));
  expect(ins?.args[1]).toBe(1);
});

test("over the limit within the window is blocked, no write", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const routes: Route[] = [[/SELECT count, window_start FROM rate_limits/, () => ({ rows: [{ count: 5, window_start: 1000 }] })]];
  const r = await checkRateLimit(routedDb(routes, log), "login:abc", { limit: 5, windowSec: 60, now: 1030 });
  expect(r).toEqual({ allowed: false, remaining: 0 });
  expect(log.some((c) => c.sql.includes("INSERT INTO rate_limits"))).toBe(false);
});

test("an expired window resets the counter", async () => {
  const routes: Route[] = [[/SELECT count, window_start FROM rate_limits/, () => ({ rows: [{ count: 5, window_start: 1000 }] })]];
  const r = await checkRateLimit(routedDb(routes), "login:abc", { limit: 5, windowSec: 60, now: 2000 });
  expect(r.allowed).toBe(true);
  expect(r.remaining).toBe(4);
});
