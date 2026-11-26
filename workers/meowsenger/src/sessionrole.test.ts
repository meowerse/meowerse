import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getRole, getSessionAndRole } from "./chats";
import { getSession, sha256hex } from "./session";
import { handleListMembers } from "./chatapi";
import type { DbClient, Row } from "./types";

/** Real SQLite (the D1 engine) with a per-statement log, so round trips are countable. */
function realDb() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const log: Array<{ sql: string; params: unknown[] }> = [];
  const db: DbClient = {
    async all(q, p = []) { log.push({ sql: q, params: p }); return sql.prepare(q).all(...(p as never[])) as Row[]; },
    async first(q, p = []) { log.push({ sql: q, params: p }); return (sql.prepare(q).get(...(p as never[])) as Row | undefined) ?? undefined; },
    async run(q, p = []) { log.push({ sql: q, params: p }); return Number(sql.prepare(q).run(...(p as never[])).changes); },
  };
  return { sql, db, log };
}

const NOW = 1_000_000;
const COOKIE = "rawcookievalue_base64url_shaped-0123456789ab"; // not 64-hex
type SessionKind = "valid" | "expired" | "missing" | "legacy" | "legacyExpired" | "hashShapedUnknown";
type MemberKind = "owner" | "admin" | "member" | "unknownRole" | "nonMember" | "left" | "chatMissing";

async function seed(sessionKind: SessionKind, memberKind: MemberKind) {
  const h = realDb();
  const hash = await sha256hex(COOKIE);
  const addSession = (id: string, exp: number) =>
    h.sql.prepare("INSERT INTO sessions (id, user_id, access_token, refresh_token, access_exp, created_at, expires_at) VALUES (?, 'u1', 'AT', 'RT', 1, 1, ?)").run(id, exp);
  if (sessionKind === "valid") addSession(hash, NOW + 1000);
  if (sessionKind === "expired") addSession(hash, NOW - 1);
  if (sessionKind === "legacy") addSession(COOKIE, NOW + 1000);
  if (sessionKind === "legacyExpired") addSession(COOKIE, NOW - 1);
  if (memberKind !== "chatMissing") {
    h.sql.prepare("INSERT INTO chats (id, type, name, created_by, created_at, last_activity) VALUES ('c1', 'group', 'g', 'x', 1, 1)").run();
    h.sql.prepare("INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES ('c1', 'other', 'owner', 1)").run();
    const role = { owner: "owner", admin: "admin", member: "member", unknownRole: "wizard" }[memberKind as string];
    if (role) h.sql.prepare("INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES ('c1', 'u1', ?, 2)").run(role);
    // "left": u1 was a member of ANOTHER chat only; its row for c1 is gone.
    if (memberKind === "left") h.sql.prepare("INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES ('c0', 'u1', 'member', 2)").run();
  }
  return h;
}
const cookieFor = (k: SessionKind) => (k === "hashShapedUnknown" ? "a".repeat(64) : COOKIE);
const sessionRows = (h: ReturnType<typeof realDb>) => h.sql.prepare("SELECT id, user_id, access_token, refresh_token, expires_at FROM sessions ORDER BY id").all();

const SESSIONS: SessionKind[] = ["valid", "expired", "missing", "legacy", "legacyExpired", "hashShapedUnknown"];
const MEMBERS: MemberKind[] = ["owner", "admin", "member", "unknownRole", "nonMember", "left", "chatMissing"];

describe("getSessionAndRole is identical to the two-step getSession+getRole (real SQL)", () => {
  for (const sk of SESSIONS) for (const mk of MEMBERS) {
    it(`${sk} x ${mk}: same session, same role, same resulting sessions table`, async () => {
      const a = await seed(sk, mk);
      const b = await seed(sk, mk);
      const oldSession = await getSession(a.db, cookieFor(sk), NOW);
      const oldRole = oldSession ? await getRole(a.db, "c1", oldSession.userId) : null;
      const neu = await getSessionAndRole(b.db, cookieFor(sk), "c1", NOW);
      expect(neu.session).toEqual(oldSession);
      expect(neu.role).toEqual(oldRole);
      expect(sessionRows(b)).toEqual(sessionRows(a)); // migration / expiry-delete side effects unchanged
    });
  }

  it("expired or absent session never yields a role (401 side stays clean even for a real member)", async () => {
    for (const sk of ["expired", "missing", "legacyExpired", "hashShapedUnknown"] as SessionKind[]) {
      const h = await seed(sk, "owner");
      expect(await getSessionAndRole(h.db, cookieFor(sk), "c1", NOW)).toEqual({ session: null, role: null });
    }
  });
  it("an unknown stored role clamps to member; owner/admin pass through", async () => {
    expect((await getSessionAndRole((await seed("valid", "unknownRole")).db, COOKIE, "c1", NOW)).role).toBe("member");
    expect((await getSessionAndRole((await seed("valid", "admin")).db, COOKIE, "c1", NOW)).role).toBe("admin");
  });
  it("non-member and missing chat are indistinguishable (role null, valid session)", async () => {
    const a = await getSessionAndRole((await seed("valid", "nonMember")).db, COOKIE, "c1", NOW);
    const b = await getSessionAndRole((await seed("valid", "chatMissing")).db, COOKIE, "c1", NOW);
    expect(a).toEqual(b);
    expect(a.role).toBeNull();
    expect(a.session?.userId).toBe("u1");
  });
  it("a cookie that is the legacy raw id is migrated in place (hashed, tokens blanked) via the slow path", async () => {
    const h = await seed("legacy", "member");
    const r = await getSessionAndRole(h.db, COOKIE, "c1", NOW);
    expect(r.role).toBe("member");
    const hash = await sha256hex(COOKIE);
    expect(sessionRows(h)).toEqual([{ id: hash, user_id: "u1", access_token: "", refresh_token: null, expires_at: NOW + 1000 }]);
  });
  it("a stored hash replayed as a cookie is never matched as a legacy raw id", async () => {
    const h = await seed("valid", "member");
    const hash = await sha256hex(COOKIE);
    expect((await getSessionAndRole(h.db, hash, "c1", NOW)).session).toBeNull();
  });
  it("binds chat id and session hash as parameters (hostile ids stay data)", async () => {
    const h = await seed("valid", "member");
    const evil = "c1' OR '1'='1";
    const r = await getSessionAndRole(h.db, COOKIE, evil, NOW);
    expect(r.role).toBeNull();
    const q = h.log[0]!;
    expect(q.sql).not.toContain(evil);
    expect(q.params).toEqual([evil, await sha256hex(COOKIE)]);
  });
});

describe("D1 round trips per gate", () => {
  const count = (h: ReturnType<typeof realDb>) => h.log.length;
  it("valid session + member: ONE statement combined vs TWO two-step; the fast path performs no write", async () => {
    const a = await seed("valid", "member");
    const s = await getSession(a.db, COOKIE, NOW);
    await getRole(a.db, "c1", s!.userId);
    const b = await seed("valid", "member");
    await getSessionAndRole(b.db, COOKIE, "c1", NOW);
    expect([count(a), count(b)]).toEqual([2, 1]);
    expect(b.log.every((l) => /^\s*SELECT/i.test(l.sql))).toBe(true);
  });
  it("valid session + non-member: still ONE statement", async () => {
    const b = await seed("valid", "nonMember");
    await getSessionAndRole(b.db, COOKIE, "c1", NOW);
    expect(count(b)).toBe(1);
  });
  it("slow paths only add the combined probe on top of the old cost (expired: probe + old 3; legacy: probe + old path)", async () => {
    const e = await seed("expired", "member");
    await getSessionAndRole(e.db, COOKIE, "c1", NOW);
    const eo = await seed("expired", "member");
    await getSession(eo.db, COOKIE, NOW);
    expect(count(e)).toBe(count(eo) + 1);
  });
});

describe("handler gates over the combined query (real SQL)", () => {
  const req = (cookie?: string) => new Request("https://x/api/chats/c1/members", { headers: cookie ? { Cookie: `__Host-mw_session=${cookie}` } : {} });
  const call = async (sk: SessionKind, mk: MemberKind) => (await handleListMembers(req(cookieFor(sk)), (await seed(sk, mk)).db, NOW, "c1", {})).status;
  it("expired / missing session => 401 even for a real member; non-member and missing chat => 403; member => 200", async () => {
    expect(await call("expired", "owner")).toBe(401);
    expect(await call("missing", "owner")).toBe(401);
    expect(await call("legacyExpired", "owner")).toBe(401);
    expect(await call("valid", "nonMember")).toBe(403);
    expect(await call("valid", "chatMissing")).toBe(403);
    expect(await call("valid", "member")).toBe(200);
    expect(await call("legacy", "member")).toBe(200);
  });
});
