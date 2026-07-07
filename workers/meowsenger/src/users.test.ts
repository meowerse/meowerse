import { describe, it, expect } from "vitest";
import { upsertUser, getUser, getAllowAutoGroupAdd, setAllowAutoGroupAdd } from "./users";
import type { DbClient, Row } from "./types";

function memDb() {
  const u = new Map<string, Row>();
  const db: DbClient = {
    async all() { return [...u.values()]; },
    async first(sql, p = []) { return sql.includes("FROM users") ? u.get(String(p[0])) : undefined; },
    async run(sql, p = []) {
      if (sql.startsWith("INSERT INTO users")) {
        // Slice 7: fresh rows default allow_auto_group_add = 1 (opted in).
        u.set(String(p[0]), { id: p[0], username: p[1], display_name: p[2], avatar_url: p[3], verified: p[4], updated_at: p[5], allow_auto_group_add: 1 });
      } else if (sql.startsWith("UPDATE users SET allow_auto_group_add")) {
        const row = u.get(String(p[1])); if (row) row.allow_auto_group_add = Number(p[0]);
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
  it("falls back to sub for username when preferred_username is absent", async () => {
    const { db, u } = memDb();
    await upsertUser(db, { sub: "u3" }, now);
    expect(u.get("u3")).toMatchObject({ username: "u3" });
  });
  it("getUser returns the typed row", async () => {
    const { db } = memDb();
    await upsertUser(db, { sub: "u1", preferred_username: "alex", verified: true }, now);
    const got = await getUser(db, "u1");
    expect(got).toEqual({ id: "u1", username: "alex", displayName: null, avatarUrl: null, verified: true });
  });
  it("getUser maps non-null display_name / avatar_url", async () => {
    const { db } = memDb();
    await upsertUser(db, { sub: "u4", preferred_username: "kit", name: "Kit", picture: "http://x/k.png", verified: false }, now);
    const got = await getUser(db, "u4");
    expect(got).toEqual({ id: "u4", username: "kit", displayName: "Kit", avatarUrl: "http://x/k.png", verified: false });
  });
  it("getUser returns null for a missing id", async () => {
    const { db } = memDb();
    expect(await getUser(db, "ghost")).toBeNull();
  });
});

// ---- Slice 7: privacy (auto-group-add opt-out) ----

describe("getAllowAutoGroupAdd / setAllowAutoGroupAdd", () => {
  it("defaults to true for a freshly upserted user", async () => {
    const { db } = memDb();
    await upsertUser(db, { sub: "u1", preferred_username: "alex" }, now);
    expect(await getAllowAutoGroupAdd(db, "u1")).toBe(true);
  });
  it("defaults to true for a missing row (fail-open, never breaks member-add)", async () => {
    const { db } = memDb();
    expect(await getAllowAutoGroupAdd(db, "ghost")).toBe(true);
  });
  it("set false → get returns false; set true → get returns true", async () => {
    const { db } = memDb();
    await upsertUser(db, { sub: "u1", preferred_username: "alex" }, now);
    await setAllowAutoGroupAdd(db, "u1", false);
    expect(await getAllowAutoGroupAdd(db, "u1")).toBe(false);
    await setAllowAutoGroupAdd(db, "u1", true);
    expect(await getAllowAutoGroupAdd(db, "u1")).toBe(true);
  });
});
