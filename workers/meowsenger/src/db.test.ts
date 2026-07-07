import { describe, it, expect } from "vitest";
import { d1Client } from "./db";

function fakeD1() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...p: unknown[]) { bound = p; return stmt; },
        async all() { calls.push({ sql, params: bound }); return { results: [{ id: "u1" }] }; },
        async first() { calls.push({ sql, params: bound }); return { id: "u1" }; },
        async run() { calls.push({ sql, params: bound }); return { success: true }; },
      };
      return stmt;
    },
  };
  return { db, calls };
}

describe("d1Client", () => {
  it("all() returns results[] and binds params", async () => {
    const { db, calls } = fakeD1();
    const rows = await d1Client(db as never).all("SELECT * FROM users WHERE id = ?", ["u1"]);
    expect(rows).toEqual([{ id: "u1" }]);
    expect(calls[0]).toEqual({ sql: "SELECT * FROM users WHERE id = ?", params: ["u1"] });
  });
  it("first() returns the row or undefined", async () => {
    const { db } = fakeD1();
    expect(await d1Client(db as never).first("SELECT 1")).toEqual({ id: "u1" });
  });
  it("run() executes without returning rows", async () => {
    const { db, calls } = fakeD1();
    await d1Client(db as never).run("INSERT INTO users (id) VALUES (?)", ["u1"]);
    expect(calls[0]?.params).toEqual(["u1"]);
  });
  it("all() falls back to [] when D1 returns no results field", async () => {
    // Exercises the `res.results ?? []` nullish fallback + default params = [].
    const db = { prepare: () => ({ bind: () => ({ async all() { return {}; } }) }) };
    expect(await d1Client(db as never).all("SELECT 1")).toEqual([]);
  });
  it("first() returns undefined when D1 yields null", async () => {
    // Exercises the `?? undefined` fallback + default params = [].
    const db = { prepare: () => ({ bind: () => ({ async first() { return null; } }) }) };
    expect(await d1Client(db as never).first("SELECT 1")).toBeUndefined();
  });
});
