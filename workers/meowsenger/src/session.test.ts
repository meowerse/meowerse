import { describe, it, expect } from "vitest";
import { createSession, getSession, deleteSession, sessionCookie, clearCookie, sha256hex, SESSION_COOKIE } from "./session";
import type { DbClient, Row } from "./types";

function memDb() {
  const t = new Map<string, Row>();
  const db: DbClient = {
    async all() { return [...t.values()]; },
    async first(sql, p = []) {
      if (sql.startsWith("SELECT") && sql.includes("FROM sessions")) return t.get(String(p[0]));
      return undefined;
    },
    async run(sql, p = []) {
      if (sql.startsWith("INSERT INTO sessions")) {
        // tokens are literals in the SQL: access_token '' and refresh_token NULL
        expect(sql).toContain("'', NULL");
        t.set(String(p[0]), { id: p[0], user_id: p[1], access_token: "", refresh_token: null, access_exp: p[2], created_at: p[3], expires_at: p[4] });
      } else if (sql.startsWith("DELETE FROM sessions WHERE expires_at")) {
        for (const [k, r] of t) if (Number(r.expires_at) < Number(p[0])) t.delete(k);
      } else if (sql.startsWith("DELETE FROM sessions WHERE id")) {
        t.delete(String(p[0]));
      } else if (sql.startsWith("UPDATE sessions SET id")) {
        const r = t.get(String(p[1]));
        if (r) { t.delete(String(p[1])); t.set(String(p[0]), { ...r, id: p[0], access_token: "", refresh_token: null }); }
      }
    },
  };
  return { db, t };
}
const now = 1_000_000;
const legacyRow = (id: string, expires: number): Row => ({
  id, user_id: "u1", access_token: "AT", refresh_token: "RT", access_exp: now, created_at: now - 1000, expires_at: expires,
});

describe("session store", () => {
  it("stores sha256hex(cookie) as the id, never the cookie, and reads back by cookie", async () => {
    const { db, t } = memDb();
    const s = await createSession(db, { id: "sess1", userId: "u1", accessExp: now + 3600_000, now });
    const hash = await sha256hex("sess1");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.id).toBe(hash);
    expect([...t.keys()]).toEqual([hash]);
    expect(t.has("sess1")).toBe(false);
    const got = await getSession(db, "sess1", now);
    expect(got?.userId).toBe("u1");
    expect(got?.id).toBe(hash);
  });
  it("known vector: sha256hex('abc')", async () => {
    expect(await sha256hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("persists no tokens", async () => {
    const { db, t } = memDb();
    await createSession(db, { id: "sess1", userId: "u1", accessExp: now, now });
    const row = [...t.values()][0];
    expect(row.access_token).toBe("");
    expect(row.refresh_token).toBeNull();
  });
  it("legacy raw-id row works once, then is stored hashed with tokens blanked", async () => {
    const { db, t } = memDb();
    t.set("legacyCookie", legacyRow("legacyCookie", now + 5000));
    const hash = await sha256hex("legacyCookie");
    const got = await getSession(db, "legacyCookie", now);
    expect(got?.userId).toBe("u1");
    expect(got?.id).toBe(hash);
    expect(t.has("legacyCookie")).toBe(false);
    const row = t.get(hash)!;
    expect(row.access_token).toBe("");
    expect(row.refresh_token).toBeNull();
    // second use goes through the hashed path
    expect((await getSession(db, "legacyCookie", now))?.userId).toBe("u1");
  });
  it("concurrent first use of a legacy cookie does not throw", async () => {
    const { db, t } = memDb();
    t.set("legacyCookie", legacyRow("legacyCookie", now + 5000));
    const [a, b] = await Promise.all([getSession(db, "legacyCookie", now), getSession(db, "legacyCookie", now)]);
    expect(a?.userId).toBe("u1");
    expect(b?.userId).toBe("u1");
    expect(t.size).toBe(1);
  });
  it("an expired legacy row is deleted and returns null", async () => {
    const { db, t } = memDb();
    t.set("legacyOld", legacyRow("legacyOld", now - 1));
    expect(await getSession(db, "legacyOld", now)).toBeNull();
    expect(t.size).toBe(0);
  });
  it("returns null for an expired hashed session and deletes it", async () => {
    const { db, t } = memDb();
    await createSession(db, { id: "old", userId: "u1", accessExp: now, now: now - 8 * 864e5 });
    // expires_at = createdAt + 7d, which is < now; the create-time prune ran at its own `now`
    expect(t.size).toBe(1);
    expect(await getSession(db, "old", now)).toBeNull();
    expect(t.size).toBe(0);
  });
  it("returns null for empty and unknown cookies (empty never queries)", async () => {
    const { db } = memDb();
    let queries = 0;
    const spy: DbClient = { ...db, async first(sql, p) { queries++; return db.first(sql, p); } };
    expect(await getSession(spy, "", now)).toBeNull();
    expect(queries).toBe(0);
    expect(await getSession(spy, "nope", now)).toBeNull();
  });
  it("a stored hash presented as the cookie is not accepted (not as legacy raw id)", async () => {
    const { db } = memDb();
    const s = await createSession(db, { id: "sess1", userId: "u1", accessExp: now, now });
    expect(await getSession(db, s.id, now)).toBeNull();
  });
  it("a hash-shaped legacy raw row is never matched by raw lookup", async () => {
    const { db, t } = memDb();
    const fake = "a".repeat(64);
    t.set(fake, legacyRow(fake, now + 5000));
    expect(await getSession(db, fake, now)).toBeNull();
    expect(t.has(fake)).toBe(true);
  });
  it("deleteSession removes a hashed session", async () => {
    const { db, t } = memDb();
    await createSession(db, { id: "s", userId: "u1", accessExp: now, now });
    await deleteSession(db, "s");
    expect(t.size).toBe(0);
    expect(await getSession(db, "s", now)).toBeNull();
  });
  it("deleteSession removes a legacy raw-id session", async () => {
    const { db, t } = memDb();
    t.set("legacyCookie", legacyRow("legacyCookie", now + 5000));
    await deleteSession(db, "legacyCookie");
    expect(t.size).toBe(0);
  });
  it("createSession prunes only expired rows", async () => {
    const { db, t } = memDb();
    t.set("expired", legacyRow("expired", now - 1));
    t.set("live", legacyRow("live", now + 1));
    await createSession(db, { id: "new", userId: "u2", accessExp: now, now });
    expect(t.has("expired")).toBe(false);
    expect(t.has("live")).toBe(true);
    expect(t.has(await sha256hex("new"))).toBe(true);
  });
  it("sessionCookie is __Host-, httpOnly, Secure, SameSite=Lax", () => {
    const c = sessionCookie("abc");
    expect(c).toContain(`${SESSION_COOKIE}=abc`);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
  });
  it("clearCookie expires the cookie", () => {
    expect(clearCookie(SESSION_COOKIE)).toContain("Max-Age=0");
  });
});
