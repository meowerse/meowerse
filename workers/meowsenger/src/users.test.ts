import { describe, it, expect } from "vitest";
import { upsertUser, getUser } from "./users";
import type { DbClient, Row } from "./types";

function memDb() {
  const u = new Map<string, Row>();
  const db: DbClient = {
    async all() { return [...u.values()]; },
    async first(sql, p = []) { return sql.includes("FROM users") ? u.get(String(p[0])) : undefined; },
    async run(sql, p = []) {
      if (sql.startsWith("INSERT INTO users")) {
        u.set(String(p[0]), { id: p[0], username: p[1], display_name: p[2], avatar_url: p[3], verified: p[4], updated_at: p[5] });
      }
    },
  };
  return { db, u };
}
const now = 42;

describe("upsertUser", () => {
  it("inserts a new user from userinfo claims", async () => {
    const { db, u } = memDb();
    await upsertUser(db, { sub: "u1", preferred_username: "alex", name: "Alex", picture: "http://x/a.png", verified: true }, now);
    expect(u.get("u1")).toMatchObject({ username: "alex", display_name: "Alex", avatar_url: "http://x/a.png", verified: 1 });
  });
  it("defaults missing optional claims to null / verified 0", async () => {
    const { db, u } = memDb();
    await upsertUser(db, { sub: "u2", preferred_username: "bob" }, now);
    expect(u.get("u2")).toMatchObject({ display_name: null, avatar_url: null, verified: 0 });
  });
  it("getUser returns the typed row", async () => {
    const { db } = memDb();
    await upsertUser(db, { sub: "u1", preferred_username: "alex", verified: true }, now);
    const got = await getUser(db, "u1");
    expect(got).toEqual({ id: "u1", username: "alex", displayName: null, avatarUrl: null, verified: true });
  });
});
