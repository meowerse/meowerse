import { describe, it, expect } from "vitest";
import { createSession, getSession, deleteSession, sessionCookie, clearCookie, SESSION_COOKIE } from "./session";
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
        t.set(String(p[0]), { id: p[0], user_id: p[1], access_token: p[2], refresh_token: p[3], access_exp: p[4], created_at: p[5], expires_at: p[6] });
      } else if (sql.startsWith("DELETE FROM sessions")) {
        t.delete(String(p[0]));
      }
    },
  };
  return { db, t };
}
const now = 1_000_000;

describe("session store", () => {
  it("creates then reads a session", async () => {
    const { db } = memDb();
    const s = await createSession(db, { id: "sess1", userId: "u1", accessToken: "at", refreshToken: "rt", accessExp: now + 3600_000, now });
    expect(s.id).toBe("sess1");
    const got = await getSession(db, "sess1", now);
    expect(got?.userId).toBe("u1");
  });
  it("returns null for an expired session and deletes it", async () => {
    const { db, t } = memDb();
    await createSession(db, { id: "old", userId: "u1", accessToken: "at", refreshToken: null, accessExp: now, now: now - 8 * 864e5 });
    // expires_at = createdAt + 7d, which is < now
    expect(await getSession(db, "old", now)).toBeNull();
    expect(t.has("old")).toBe(false);
  });
  it("returns null for a missing session", async () => {
    const { db } = memDb();
    expect(await getSession(db, "nope", now)).toBeNull();
  });
  it("deleteSession removes the row", async () => {
    const { db, t } = memDb();
    await createSession(db, { id: "s", userId: "u1", accessToken: "a", refreshToken: null, accessExp: now, now });
    await deleteSession(db, "s");
    expect(t.has("s")).toBe(false);
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
