import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { upsertUser, getUser } from "../src/users";
import { createSession, getSession } from "../src/session";
import type { DbClient } from "../src/types";

// Acceptance evidence for auth self-deletion: what Meowsenger does with a deleted meowerse identity.
// Real SQLite with the real Meowsenger D1 schema (schema*.sql), real users.ts / session.ts code.

async function meowsengerDb(): Promise<DbClient> {
  const c = new DatabaseSync(":memory:");
  const dir = new URL("../", import.meta.url);
  for (const f of ["schema.sql", "schema-push.sql", "schema-sec1.sql", "schema-slice5.sql", "schema-slice7.sql", "schema-lastseen.sql"]) {
    const sql = readFileSync(new URL(f, dir), "utf8").replace(/--[^\n]*/g, "");
    for (const stmt of sql.split(";").map((x) => x.trim()).filter(Boolean)) {
      try { c.exec(stmt); } catch (e) { if (!/duplicate column/.test(String(e))) throw e; } // ALTERs already folded into schema.sql
    }
  }
  return {
    all: async (sql, p = []) => c.prepare(sql).all(...(p as never[])) as never,
    first: async (sql, p = []) => c.prepare(sql).get(...(p as never[])) as never,
    run: async (sql, p = []) => { c.prepare(sql).run(...(p as never[])); },
    // D1 batch semantics (upsertUser needs it since #91): one transaction, all-or-nothing.
    batch: async (stmts) => {
      c.exec("BEGIN");
      try {
        const out = stmts.map((s) => Number(c.prepare(s.sql).run(...((s.params ?? []) as never[])).changes));
        c.exec("COMMIT");
        return out;
      } catch (e) { c.exec("ROLLBACK"); throw e; }
    },
  };
}

test("no automatic link: a Meowsenger session and profile outlive the auth account (nothing calls back to auth)", async () => {
  const db = await meowsengerDb();
  const now = 1_000_000;
  await upsertUser(db, { sub: "acct_old", preferred_username: "alice", name: "Alice" }, now);
  await createSession(db, { id: "cookie-raw", userId: "acct_old", accessExp: now + 900_000, now });
  // The auth account is deleted here; Meowsenger is not told. Six days later the session still resolves.
  const later = now + 6 * 24 * 3600 * 1000;
  expect((await getSession(db, "cookie-raw", later))?.userId).toBe("acct_old");
  expect((await getUser(db, "acct_old"))?.username).toBe("alice");
});

// The username-reuse lockout (formerly a KNOWN DEFECT here) is fixed by #91 and covered by
// test/users-release.test.ts ("regression (was KNOWN DEFECT)…").
