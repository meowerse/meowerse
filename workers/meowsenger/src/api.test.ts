import { describe, it, expect } from "vitest";
import { handleSession, handleLogout } from "./api";
import type { DbClient, Row } from "./types";
import { SESSION_COOKIE } from "./session";

function memDb(session?: Row, user?: Row) {
  const del: string[] = [];
  const db: DbClient = {
    async all() { return []; },
    async first(sql, p = []) {
      if (sql.includes("FROM sessions")) return session;
      if (sql.includes("FROM users")) return user;
      return undefined;
    },
    async run(sql, p = []) { if (sql.startsWith("DELETE FROM sessions")) del.push(String(p[0])); },
  };
  return { db, del };
}
const cors = {};
const now = 5_000;
const cookieReq = (v?: string) =>
  new Request("https://x/api/session", { headers: v ? { Cookie: `${SESSION_COOKIE}=${v}` } : {} });

describe("handleSession", () => {
  it("returns authenticated:false with no cookie", async () => {
    const { db } = memDb();
    const res = await handleSession(cookieReq(), db, now, cors);
    expect(await res.json()).toEqual({ authenticated: false });
  });
  it("returns the user for a valid session", async () => {
    const session = { id: "s1", user_id: "u1", access_token: "a", refresh_token: null, access_exp: now, created_at: now, expires_at: now + 1e9 };
    const user = { id: "u1", username: "alex", display_name: "Alex", avatar_url: null, verified: 1 };
    const { db } = memDb(session, user);
    const res = await handleSession(cookieReq("s1"), db, now, cors);
    expect(await res.json()).toEqual({ authenticated: true, user: { id: "u1", username: "alex", displayName: "Alex", avatarUrl: null, verified: true } });
  });
});

describe("handleLogout", () => {
  it("deletes the session and clears the cookie", async () => {
    const session = { id: "s1", user_id: "u1", access_token: "a", refresh_token: null, access_exp: now, created_at: now, expires_at: now + 1e9 };
    const { db, del } = memDb(session);
    const res = await handleLogout(new Request("https://x/auth/logout", { method: "POST", headers: { Cookie: `${SESSION_COOKIE}=s1` } }), db, now, cors);
    expect(res.status).toBe(200);
    expect(del).toContain("s1");
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
  it("is a no-op 200 with no cookie", async () => {
    const { db } = memDb();
    const res = await handleLogout(new Request("https://x/auth/logout", { method: "POST" }), db, now, cors);
    expect(res.status).toBe(200);
  });
});
