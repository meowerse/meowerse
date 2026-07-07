import { describe, it, expect } from "vitest";
import {
  handleListChats,
  handleCreateChat,
  handleHistory,
  callerId,
  handleListMembers,
  handleAddMember,
  handleRemoveMember,
  handleSetRole,
  handleLeave,
  handleUpdateChat,
  handleSlugAvailable,
} from "./chatapi";
import type { DbClient, Env, Row } from "./types";
import { SESSION_COOKIE } from "./session";

const now = 5_000;
const cors = {};

/**
 * In-memory DbClient covering the queries the chat handlers touch: sessions
 * (auth), users (username→id lookup), chats/chat_members (create/dedup/list/
 * membership). Same style as api.test.ts / chats.test.ts.
 */
function memDb(opts: { session?: Row; usersByName?: Record<string, string>; members?: Array<[string, string]> } = {}) {
  const chats = new Map<string, Row>();
  const membersDelta: Array<{ chat_id: string; user_id: string }> = [];
  const members = new Set<string>((opts.members ?? []).map(([c, u]) => `${c}::${u}`));
  const db: DbClient = {
    async all(sql) {
      if (sql.includes("FROM chat_members m")) {
        return [...chats.values()].map((c) => ({ ...c, unread_count: 0 }));
      }
      return [];
    },
    async first(sql, p = []) {
      if (sql.includes("FROM sessions")) return opts.session;
      if (sql.includes("FROM users WHERE username")) {
        const id = opts.usersByName?.[String(p[0])];
        return id ? { id } : undefined;
      }
      if (sql.includes("FROM chat_members WHERE chat_id")) {
        return members.has(`${String(p[0])}::${String(p[1])}`) ? { ok: 1 } : undefined;
      }
      if (sql.includes("direct_key")) {
        return [...chats.values()].find((c) => c.direct_key === p[0]);
      }
      return undefined;
    },
    async run(sql, p = []) {
      if (sql.startsWith("INSERT INTO chats")) {
        chats.set(String(p[0]), { id: p[0], type: p[1], direct_key: p[4], last_activity: p[3] });
      } else if (sql.startsWith("INSERT INTO chat_members")) {
        membersDelta.push({ chat_id: String(p[0]), user_id: String(p[1]) });
        members.add(`${String(p[0])}::${String(p[1])}`);
      }
    },
  };
  return { db, chats, membersDelta };
}

const validSession = (userId: string): Row => ({
  id: "s1",
  user_id: userId,
  access_token: "a",
  refresh_token: null,
  access_exp: now,
  created_at: now,
  expires_at: now + 1e9,
});

const cookieReq = (url: string, sid?: string, init: RequestInit = {}) =>
  new Request(url, { ...init, headers: { ...(sid ? { Cookie: `${SESSION_COOKIE}=${sid}` } : {}), ...(init.headers ?? {}) } });

// Fake CONVERSATION namespace: idFromName is identity, get() returns a stub whose
// historyFor returns a canned page. Cast to Env's untyped namespace shape.
function fakeEnv(history: unknown[] = []): Env {
  const stub = { historyFor: async () => history };
  const CONVERSATION = {
    idFromName: (name: string) => name,
    get: () => stub,
  };
  return { CONVERSATION } as unknown as Env;
}

describe("callerId", () => {
  it("returns null with no cookie", async () => {
    const { db } = memDb();
    expect(await callerId(new Request("https://x/api/chats"), db, now)).toBeNull();
  });
  it("returns null when the session is missing/invalid", async () => {
    const { db } = memDb();
    expect(await callerId(cookieReq("https://x/api/chats", "stale"), db, now)).toBeNull();
  });
  it("returns the userId for a valid session", async () => {
    const { db } = memDb({ session: validSession("u1") });
    expect(await callerId(cookieReq("https://x/api/chats", "s1"), db, now)).toBe("u1");
  });
});

describe("handleListChats", () => {
  it("401 unauthorized with no session", async () => {
    const { db } = memDb();
    const res = await handleListChats(cookieReq("https://x/api/chats"), db, now, cors);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
  it("lists the caller's chats", async () => {
    const { db } = memDb({ session: validSession("u1") });
    // Seed one chat via createOrGetDirect through the create handler is overkill;
    // instead exercise list directly with a chat present.
    await db.run(
      "INSERT INTO chats (id, type, name, created_by, created_at, last_activity, direct_key) VALUES (?, 'direct', NULL, ?, ?, ?, ?)",
      ["c1", "u1", now, now, "u1:u2"],
    );
    const res = await handleListChats(cookieReq("https://x/api/chats", "s1"), db, now, cors);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chats: Array<{ id: string }> };
    expect(body.chats).toHaveLength(1);
    expect(body.chats[0].id).toBe("c1");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("handleCreateChat", () => {
  it("401 unauthorized with no session", async () => {
    const { db } = memDb();
    const res = await handleCreateChat(
      cookieReq("https://x/api/chats", undefined, { method: "POST", body: JSON.stringify({ username: "bob" }) }),
      db,
      now,
      cors,
    );
    expect(res.status).toBe(401);
  });
  it("400 bad_json on unparseable body", async () => {
    const { db } = memDb({ session: validSession("u1") });
    const res = await handleCreateChat(
      cookieReq("https://x/api/chats", "s1", { method: "POST", body: "{not json" }),
      db,
      now,
      cors,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_json" });
  });
  it("400 username_required when username is blank", async () => {
    const { db } = memDb({ session: validSession("u1") });
    const res = await handleCreateChat(
      cookieReq("https://x/api/chats", "s1", { method: "POST", body: JSON.stringify({ username: "  " }) }),
      db,
      now,
      cors,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "username_required" });
  });
  it("404 user_not_found for an unknown username", async () => {
    const { db } = memDb({ session: validSession("u1"), usersByName: {} });
    const res = await handleCreateChat(
      cookieReq("https://x/api/chats", "s1", { method: "POST", body: JSON.stringify({ username: "ghost" }) }),
      db,
      now,
      cors,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "user_not_found" });
  });
  it("400 cannot_dm_self when targeting yourself", async () => {
    const { db } = memDb({ session: validSession("u1"), usersByName: { me: "u1" } });
    const res = await handleCreateChat(
      cookieReq("https://x/api/chats", "s1", { method: "POST", body: JSON.stringify({ username: "me" }) }),
      db,
      now,
      cors,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "cannot_dm_self" });
  });
  it("creates a DM, then dedups on the second call", async () => {
    const { db, chats } = memDb({ session: validSession("u1"), usersByName: { bob: "u2" } });
    const first = await handleCreateChat(
      cookieReq("https://x/api/chats", "s1", { method: "POST", body: JSON.stringify({ username: "bob" }) }),
      db,
      now,
      cors,
    );
    expect(first.status).toBe(200);
    const a = (await first.json()) as { chatId: string; created: boolean };
    expect(a.created).toBe(true);
    expect(chats.size).toBe(1);

    const second = await handleCreateChat(
      cookieReq("https://x/api/chats", "s1", { method: "POST", body: JSON.stringify({ username: "bob" }) }),
      db,
      now,
      cors,
    );
    const b = (await second.json()) as { chatId: string; created: boolean };
    expect(b.created).toBe(false);
    expect(b.chatId).toBe(a.chatId);
    expect(chats.size).toBe(1);
  });
});

describe("handleHistory", () => {
  it("401 unauthorized with no session", async () => {
    const { db } = memDb();
    const res = await handleHistory(cookieReq("https://x/api/chats/c1/messages"), fakeEnv(), db, now, "c1", cors);
    expect(res.status).toBe(401);
  });
  it("403 forbidden for a non-member", async () => {
    const { db } = memDb({ session: validSession("u1") /* no membership seeded */ });
    const res = await handleHistory(cookieReq("https://x/api/chats/c1/messages", "s1"), fakeEnv(), db, now, "c1", cors);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });
  it("returns the DO's history for a member", async () => {
    const canned = [{ id: "m1", chatId: "c1", senderId: "u1", body: "hi", createdAt: 1000 }];
    const { db } = memDb({ session: validSession("u1"), members: [["c1", "u1"]] });
    const res = await handleHistory(cookieReq("https://x/api/chats/c1/messages", "s1"), fakeEnv(canned), db, now, "c1", cors);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: canned });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
  it("passes the ?before cursor through to the DO", async () => {
    let seenBefore: string | null = "UNSET";
    const { db } = memDb({ session: validSession("u1"), members: [["c1", "u1"]] });
    const env = {
      CONVERSATION: {
        idFromName: (n: string) => n,
        get: () => ({
          historyFor: async (_chatId: string, before: string | null) => {
            seenBefore = before;
            return [];
          },
        }),
      },
    } as unknown as Env;
    await handleHistory(cookieReq("https://x/api/chats/c1/messages?before=m9", "s1"), env, db, now, "c1", cors);
    expect(seenBefore).toBe("m9");
  });
});

// ---- Slice 5: group + member management routes ----

/**
 * Richer in-memory DB for the Slice-5 handlers: sessions (auth), users
 * (username↔id + JOIN identity), chats (visibility/slug), chat_members (roles).
 */
function groupApiDb(opts: {
  session?: Row;
  usersByName?: Record<string, string>;
  usersById?: Record<string, { username: string; displayName: string | null; avatarUrl: string | null }>;
  members?: Array<{ chatId: string; userId: string; role: string; joinedAt: number }>;
  chats?: Array<{ id: string; slug?: string | null }>;
} = {}) {
  const members: Row[] = (opts.members ?? []).map((m) => ({ chat_id: m.chatId, user_id: m.userId, role: m.role, joined_at: m.joinedAt }));
  const chats = new Map<string, Row>((opts.chats ?? []).map((c) => [c.id, { id: c.id, slug: c.slug ?? null }]));
  const db: DbClient = {
    async all(sql, p = []) {
      if (sql.includes("JOIN users u ON u.id = m.user_id")) {
        return members
          .filter((m) => m.chat_id === p[0])
          .sort((a, b) => Number(a.joined_at) - Number(b.joined_at))
          .map((m) => {
            const u = opts.usersById?.[String(m.user_id)] ?? { username: String(m.user_id), displayName: null, avatarUrl: null };
            return { user_id: m.user_id, role: m.role, joined_at: m.joined_at, username: u.username, display_name: u.displayName, avatar_url: u.avatarUrl };
          });
      }
      if (sql.includes("SELECT user_id, role, joined_at FROM chat_members WHERE chat_id")) {
        return members.filter((m) => m.chat_id === p[0]).sort((a, b) => Number(a.joined_at) - Number(b.joined_at));
      }
      return [];
    },
    async first(sql, p = []) {
      if (sql.includes("FROM sessions")) return opts.session;
      if (sql.includes("FROM users WHERE username")) {
        const id = opts.usersByName?.[String(p[0])];
        return id ? { id } : undefined;
      }
      if (sql.includes("SELECT role FROM chat_members")) return members.find((m) => m.chat_id === p[0] && m.user_id === p[1]);
      if (sql.includes("SELECT 1 AS ok FROM chats WHERE slug")) return [...chats.values()].some((c) => c.slug === p[0]) ? { ok: 1 } : undefined;
      if (sql.includes("SELECT id FROM chats WHERE slug")) return [...chats.values()].find((c) => c.slug === p[0]);
      return undefined;
    },
    async run(sql, p = []) {
      if (sql.startsWith("INSERT INTO chats")) chats.set(String(p[0]), { id: p[0], slug: p[6] ?? null });
      else if (sql.startsWith("INSERT INTO chat_members")) {
        const role = sql.includes("'owner'") ? "owner" : "member";
        members.push({ chat_id: p[0], user_id: p[1], role, joined_at: p[2] });
      } else if (sql.startsWith("DELETE FROM chat_members")) {
        const i = members.findIndex((m) => m.chat_id === p[0] && m.user_id === p[1]);
        if (i >= 0) members.splice(i, 1);
      } else if (sql.startsWith("UPDATE chat_members SET role")) {
        const role = sql.includes("'admin'") ? "admin" : sql.includes("'owner'") ? "owner" : "member";
        const m = members.find((x) => x.chat_id === p[0] && x.user_id === p[1]);
        if (m) m.role = role;
      } else if (sql.startsWith("UPDATE chats SET slug")) {
        const c = chats.get(String(p[1])); if (c) c.slug = p[0];
      }
    },
  };
  return { db, members, chats };
}

const grp = (userId: string, role: string) => [{ chatId: "g1", userId, role, joinedAt: 1 }];

describe("POST /api/chats (group branch)", () => {
  it("creates a group with the caller as owner", async () => {
    const { db, members } = groupApiDb({ session: validSession("u1"), usersByName: { bob: "u2", carol: "u3" } });
    const res = await handleCreateChat(
      cookieReq("https://x/api/chats", "s1", { method: "POST", body: JSON.stringify({ type: "group", name: "Squad", members: ["bob", "carol"] }) }),
      db, now, cors,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chatId: string; created: boolean };
    expect(body.created).toBe(true);
    const mine = members.filter((m) => m.chat_id === body.chatId);
    expect(mine).toHaveLength(3);
    expect(mine.find((m) => m.user_id === "u1")?.role).toBe("owner");
  });
  it("400 name_required for a group with a blank name", async () => {
    const { db } = groupApiDb({ session: validSession("u1") });
    const res = await handleCreateChat(
      cookieReq("https://x/api/chats", "s1", { method: "POST", body: JSON.stringify({ type: "group", name: "  " }) }),
      db, now, cors,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "name_required" });
  });
  it("404 user_not_found when a member username is unknown", async () => {
    const { db } = groupApiDb({ session: validSession("u1"), usersByName: {} });
    const res = await handleCreateChat(
      cookieReq("https://x/api/chats", "s1", { method: "POST", body: JSON.stringify({ type: "group", name: "R", members: ["ghost"] }) }),
      db, now, cors,
    );
    expect(res.status).toBe(404);
  });
  it("400 slug_taken when the slug is already used", async () => {
    const { db } = groupApiDb({ session: validSession("u1"), chats: [{ id: "old", slug: "taken" }] });
    const res = await handleCreateChat(
      cookieReq("https://x/api/chats", "s1", { method: "POST", body: JSON.stringify({ type: "group", name: "R", members: [], slug: "taken" }) }),
      db, now, cors,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "slug_taken" });
  });
});

describe("GET /api/chats/:id/members", () => {
  it("401 with no session", async () => {
    const { db } = groupApiDb();
    const res = await handleListMembers(cookieReq("https://x/api/chats/g1/members"), db, now, "g1", cors);
    expect(res.status).toBe(401);
  });
  it("403 for a non-member", async () => {
    const { db } = groupApiDb({ session: validSession("u9"), members: grp("u1", "owner") });
    const res = await handleListMembers(cookieReq("https://x/api/chats/g1/members", "s1"), db, now, "g1", cors);
    expect(res.status).toBe(403);
  });
  it("200 with the roster for a member", async () => {
    const { db } = groupApiDb({
      session: validSession("u1"),
      members: grp("u1", "owner"),
      usersById: { u1: { username: "alice", displayName: "Alice", avatarUrl: null } },
    });
    const res = await handleListMembers(cookieReq("https://x/api/chats/g1/members", "s1"), db, now, "g1", cors);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<{ userId: string; role: string }> };
    expect(body.members[0]).toMatchObject({ userId: "u1", role: "owner" });
  });
});

describe("POST /api/chats/:id/members (add)", () => {
  it("owner adds a member → 200", async () => {
    const { db } = groupApiDb({ session: validSession("u1"), usersByName: { bob: "u2" }, members: grp("u1", "owner") });
    const res = await handleAddMember(cookieReq("https://x/api/chats/g1/members", "s1", { method: "POST", body: JSON.stringify({ username: "bob" }) }), db, now, "g1", cors);
    expect(res.status).toBe(200);
  });
  it("a plain member adding → 403 forbidden", async () => {
    const { db } = groupApiDb({ session: validSession("u2"), usersByName: { carol: "u3" }, members: [{ chatId: "g1", userId: "u1", role: "owner", joinedAt: 1 }, { chatId: "g1", userId: "u2", role: "member", joinedAt: 2 }] });
    const res = await handleAddMember(cookieReq("https://x/api/chats/g1/members", "s1", { method: "POST", body: JSON.stringify({ username: "carol" }) }), db, now, "g1", cors);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });
  it("a non-member adding → 403 not_member", async () => {
    const { db } = groupApiDb({ session: validSession("u9"), usersByName: { carol: "u3" }, members: grp("u1", "owner") });
    const res = await handleAddMember(cookieReq("https://x/api/chats/g1/members", "s1", { method: "POST", body: JSON.stringify({ username: "carol" }) }), db, now, "g1", cors);
    expect(res.status).toBe(403);
  });
  it("404 when the username is unknown", async () => {
    const { db } = groupApiDb({ session: validSession("u1"), usersByName: {}, members: grp("u1", "owner") });
    const res = await handleAddMember(cookieReq("https://x/api/chats/g1/members", "s1", { method: "POST", body: JSON.stringify({ username: "ghost" }) }), db, now, "g1", cors);
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/chats/:id/members/:userId (remove)", () => {
  const seed = () => ({
    session: validSession("adm"),
    members: [
      { chatId: "g1", userId: "own", role: "owner", joinedAt: 1 },
      { chatId: "g1", userId: "adm", role: "admin", joinedAt: 2 },
      { chatId: "g1", userId: "adm2", role: "admin", joinedAt: 3 },
      { chatId: "g1", userId: "mem", role: "member", joinedAt: 4 },
    ],
  });
  it("admin removes a member → 200", async () => {
    const { db } = groupApiDb(seed());
    const res = await handleRemoveMember(cookieReq("https://x/api/chats/g1/members/mem", "s1", { method: "DELETE" }), db, now, "g1", "mem", cors);
    expect(res.status).toBe(200);
  });
  it("admin removing the OWNER → 403 cannot_remove_owner", async () => {
    const { db } = groupApiDb(seed());
    const res = await handleRemoveMember(cookieReq("https://x/api/chats/g1/members/own", "s1", { method: "DELETE" }), db, now, "g1", "own", cors);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cannot_remove_owner" });
  });
  it("admin removing ANOTHER admin → 403 cannot_remove_admin", async () => {
    const { db } = groupApiDb(seed());
    const res = await handleRemoveMember(cookieReq("https://x/api/chats/g1/members/adm2", "s1", { method: "DELETE" }), db, now, "g1", "adm2", cors);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cannot_remove_admin" });
  });
  it("removing a non-member target → 404", async () => {
    const { db } = groupApiDb(seed());
    const res = await handleRemoveMember(cookieReq("https://x/api/chats/g1/members/ghost", "s1", { method: "DELETE" }), db, now, "g1", "ghost", cors);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/chats/:id/members/:userId/role (promote/demote)", () => {
  const seed = () => ({
    session: validSession("own"),
    members: [
      { chatId: "g1", userId: "own", role: "owner", joinedAt: 1 },
      { chatId: "g1", userId: "adm", role: "admin", joinedAt: 2 },
      { chatId: "g1", userId: "mem", role: "member", joinedAt: 3 },
    ],
  });
  it("owner promotes a member → 200", async () => {
    const { db } = groupApiDb(seed());
    const res = await handleSetRole(cookieReq("https://x/api/chats/g1/members/mem/role", "s1", { method: "POST", body: JSON.stringify({ role: "admin" }) }), db, now, "g1", "mem", cors);
    expect(res.status).toBe(200);
  });
  it("owner demotes an admin → 200", async () => {
    const { db } = groupApiDb(seed());
    const res = await handleSetRole(cookieReq("https://x/api/chats/g1/members/adm/role", "s1", { method: "POST", body: JSON.stringify({ role: "member" }) }), db, now, "g1", "adm", cors);
    expect(res.status).toBe(200);
  });
  it("an admin (non-owner) promoting → 403 forbidden", async () => {
    const s = seed();
    const { db } = groupApiDb({ ...s, session: validSession("adm") });
    const res = await handleSetRole(cookieReq("https://x/api/chats/g1/members/mem/role", "s1", { method: "POST", body: JSON.stringify({ role: "admin" }) }), db, now, "g1", "mem", cors);
    expect(res.status).toBe(403);
  });
  it("400 for a bad role value", async () => {
    const { db } = groupApiDb(seed());
    const res = await handleSetRole(cookieReq("https://x/api/chats/g1/members/mem/role", "s1", { method: "POST", body: JSON.stringify({ role: "king" }) }), db, now, "g1", "mem", cors);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_role" });
  });
});

describe("POST /api/chats/:id/leave", () => {
  it("a member leaves → 200 ok", async () => {
    const { db } = groupApiDb({ session: validSession("mem"), members: [{ chatId: "g1", userId: "own", role: "owner", joinedAt: 1 }, { chatId: "g1", userId: "mem", role: "member", joinedAt: 2 }] });
    const res = await handleLeave(cookieReq("https://x/api/chats/g1/leave", "s1", { method: "POST" }), db, now, "g1", cors);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deleted: false });
  });
  it("owner leaves → 200 with transferredTo", async () => {
    const { db } = groupApiDb({ session: validSession("own"), members: [{ chatId: "g1", userId: "own", role: "owner", joinedAt: 1 }, { chatId: "g1", userId: "adm", role: "admin", joinedAt: 2 }] });
    const res = await handleLeave(cookieReq("https://x/api/chats/g1/leave", "s1", { method: "POST" }), db, now, "g1", cors);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, transferredTo: "adm" });
  });
  it("a non-member leaving → 403 not_member", async () => {
    const { db } = groupApiDb({ session: validSession("u9"), members: grp("own", "owner") });
    const res = await handleLeave(cookieReq("https://x/api/chats/g1/leave", "s1", { method: "POST" }), db, now, "g1", cors);
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/chats/:id", () => {
  it("owner/admin can rename → 200", async () => {
    const { db } = groupApiDb({ session: validSession("adm"), members: grp("adm", "admin") });
    const res = await handleUpdateChat(cookieReq("https://x/api/chats/g1", "s1", { method: "PATCH", body: JSON.stringify({ name: "Renamed" }) }), db, now, "g1", cors);
    expect(res.status).toBe(200);
  });
  it("a plain member editing → 403", async () => {
    const { db } = groupApiDb({ session: validSession("mem"), members: grp("mem", "member") });
    const res = await handleUpdateChat(cookieReq("https://x/api/chats/g1", "s1", { method: "PATCH", body: JSON.stringify({ name: "Nope" }) }), db, now, "g1", cors);
    expect(res.status).toBe(403);
  });
  it("a non-member editing → 403", async () => {
    const { db } = groupApiDb({ session: validSession("u9"), members: grp("own", "owner") });
    const res = await handleUpdateChat(cookieReq("https://x/api/chats/g1", "s1", { method: "PATCH", body: JSON.stringify({ name: "Nope" }) }), db, now, "g1", cors);
    expect(res.status).toBe(403);
  });
  it("400 bad_visibility for an invalid value", async () => {
    const { db } = groupApiDb({ session: validSession("own"), members: grp("own", "owner") });
    const res = await handleUpdateChat(cookieReq("https://x/api/chats/g1", "s1", { method: "PATCH", body: JSON.stringify({ visibility: "secret" }) }), db, now, "g1", cors);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_visibility" });
  });
  it("400 slug_taken when the slug belongs to another chat", async () => {
    const { db } = groupApiDb({ session: validSession("own"), members: grp("own", "owner"), chats: [{ id: "other", slug: "used" }, { id: "g1", slug: null }] });
    const res = await handleUpdateChat(cookieReq("https://x/api/chats/g1", "s1", { method: "PATCH", body: JSON.stringify({ slug: "used" }) }), db, now, "g1", cors);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "slug_taken" });
  });
  it("200 sets a valid slug (normalized in the response)", async () => {
    const { db } = groupApiDb({ session: validSession("own"), members: grp("own", "owner"), chats: [{ id: "g1", slug: null }] });
    const res = await handleUpdateChat(cookieReq("https://x/api/chats/g1", "s1", { method: "PATCH", body: JSON.stringify({ slug: "My Room" }) }), db, now, "g1", cors);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, slug: "my-room" });
  });
});

describe("GET /api/slug-available", () => {
  it("401 with no session", async () => {
    const { db } = groupApiDb();
    const res = await handleSlugAvailable(cookieReq("https://x/api/slug-available?slug=abc"), db, now, cors);
    expect(res.status).toBe(401);
  });
  it("400 for a malformed slug", async () => {
    const { db } = groupApiDb({ session: validSession("u1") });
    const res = await handleSlugAvailable(cookieReq("https://x/api/slug-available?slug=!!", "s1"), db, now, cors);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_slug", available: false });
  });
  it("200 available:true for a free slug", async () => {
    const { db } = groupApiDb({ session: validSession("u1") });
    const res = await handleSlugAvailable(cookieReq("https://x/api/slug-available?slug=Free Room", "s1"), db, now, cors);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ available: true, slug: "free-room" });
  });
  it("200 available:false once taken", async () => {
    const { db } = groupApiDb({ session: validSession("u1"), chats: [{ id: "x", slug: "taken-one" }] });
    const res = await handleSlugAvailable(cookieReq("https://x/api/slug-available?slug=taken-one", "s1"), db, now, cors);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ available: false });
  });
});
