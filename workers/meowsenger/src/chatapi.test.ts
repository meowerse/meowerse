import { describe, it, expect } from "vitest";
import {
  handleListChats,
  handleCreateChat,
  handleHistory,
  handleSearch,
  handleForward,
  callerId,
  handleListMembers,
  handleAddMember,
  handleRemoveMember,
  handleSetRole,
  handleLeave,
  handleUpdateChat,
  handleSlugAvailable,
  handleGetBySlug,
  handleJoin,
  handleCreateInvite,
  handleRevokeInvite,
  handleResolveInvite,
  handleAcceptInvite,
  handleRequestJoin,
  handleListRequests,
  handleApproveRequest,
  handleRejectRequest,
  handleGetPrivacy,
  handleSetPrivacy,
  handleDeleteAccount,
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
  it("passes the caller as viewerId so reactions carry `mine`", async () => {
    let seenViewer: string | undefined = "UNSET";
    const { db } = memDb({ session: validSession("u1"), members: [["c1", "u1"]] });
    const env = {
      CONVERSATION: {
        idFromName: (n: string) => n,
        get: () => ({
          historyFor: async (_chatId: string, _before: string | null, viewerId?: string) => {
            seenViewer = viewerId;
            return [];
          },
        }),
      },
    } as unknown as Env;
    await handleHistory(cookieReq("https://x/api/chats/c1/messages", "s1"), env, db, now, "c1", cors);
    expect(seenViewer).toBe("u1");
  });
});

// ---- Slice 9: within-chat search ----

/** Fake CONVERSATION namespace whose `search` records its (query, chatId, viewerId)
 *  and returns a canned page — lets a test assert both the gate and the passthrough. */
function searchEnv(results: unknown[] = []) {
  const calls: Array<{ query: string; chatId?: string; viewerId?: string }> = [];
  const CONVERSATION = {
    idFromName: (name: string) => name,
    get: () => ({
      search: async (query: string, chatId?: string, viewerId?: string) => {
        calls.push({ query, chatId, viewerId });
        return results;
      },
    }),
  };
  return { env: { CONVERSATION } as unknown as Env, calls };
}

describe("handleSearch", () => {
  it("401 unauthorized with no session", async () => {
    const { db } = memDb();
    const { env } = searchEnv();
    const res = await handleSearch(cookieReq("https://x/api/chats/c1/search?q=hi"), env, db, now, "c1", cors);
    expect(res.status).toBe(401);
  });
  it("403 forbidden for a non-member (search never leaks a foreign chat)", async () => {
    const { db } = memDb({ session: validSession("u1") /* no membership seeded */ });
    const { env, calls } = searchEnv();
    const res = await handleSearch(cookieReq("https://x/api/chats/c1/search?q=hi", "s1"), env, db, now, "c1", cors);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    // The DO was never touched.
    expect(calls).toHaveLength(0);
  });
  it("empty/blank q → 200 [] without touching the DO", async () => {
    const { db } = memDb({ session: validSession("u1"), members: [["c1", "u1"]] });
    const { env, calls } = searchEnv([{ id: "m1" }]);
    const res = await handleSearch(cookieReq("https://x/api/chats/c1/search?q=%20%20", "s1"), env, db, now, "c1", cors);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
    expect(calls).toHaveLength(0);
  });
  it("member search → 200 with the DO's results; passes q + caller as viewerId", async () => {
    const canned = [{ id: "m1", chatId: "c1", senderId: "u2", body: "found hello", createdAt: 1000, reactions: [] }];
    const { db } = memDb({ session: validSession("u1"), members: [["c1", "u1"]] });
    const { env, calls } = searchEnv(canned);
    const res = await handleSearch(cookieReq("https://x/api/chats/c1/search?q=hello", "s1"), env, db, now, "c1", cors);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: canned });
    expect(calls).toEqual([{ query: "hello", chatId: "c1", viewerId: "u1" }]);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
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
  chats?: Array<{ id: string; slug?: string | null; type?: string; name?: string | null; visibility?: string; inviteCode?: string | null; inviteEnabled?: number }>;
  // Slice 7: per-user auto-group-add preference (default 1 when absent).
  privacyById?: Record<string, number>;
  // Slice 7: seed join_requests rows.
  joinRequests?: Array<{ id: string; chatId: string; userId: string; status: string; createdAt: number }>;
} = {}) {
  const members: Row[] = (opts.members ?? []).map((m) => ({ chat_id: m.chatId, user_id: m.userId, role: m.role, joined_at: m.joinedAt }));
  const chats = new Map<string, Row>(
    (opts.chats ?? []).map((c) => [
      c.id,
      { id: c.id, slug: c.slug ?? null, type: c.type ?? "group", name: c.name ?? null, visibility: c.visibility ?? "private", invite_code: c.inviteCode ?? null, invite_enabled: c.inviteEnabled ?? 1 },
    ]),
  );
  const joinRequests = (opts.joinRequests ?? []).map((j) => ({ id: j.id, chat_id: j.chatId, user_id: j.userId, status: j.status, created_at: j.createdAt }));
  const db: DbClient = {
    async all(sql, p = []) {
      // Slice 7: owner/admin request inbox (pending only), oldest-first, w/ user.
      if (sql.includes("FROM join_requests j")) {
        return joinRequests
          .filter((j) => j.chat_id === p[0] && j.status === "pending")
          .sort((a, b) => a.created_at - b.created_at)
          .map((j) => {
            const u = opts.usersById?.[j.user_id] ?? { username: j.user_id, displayName: null, avatarUrl: null };
            return { id: j.id, user_id: j.user_id, status: j.status, created_at: j.created_at, username: u.username, display_name: u.displayName, avatar_url: u.avatarUrl };
          });
      }
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
      // Slice 6: discovery preview (by slug) + join visibility check (by id) + count.
      // Slice 7 added `slug` to the preview SELECT — match on the common prefix.
      if (sql.includes("SELECT id, type, name, visibility")) return [...chats.values()].find((c) => c.slug === p[0]);
      if (sql.includes("SELECT visibility, slug FROM chats WHERE id")) return chats.get(String(p[0]));
      if (sql.includes("SELECT visibility FROM chats WHERE id")) return chats.get(String(p[0]));
      if (sql.includes("SELECT COUNT(*) AS n FROM chat_members WHERE chat_id")) return { n: members.filter((m) => m.chat_id === p[0]).length };
      // Slice 7: invite lookups (by id → code/enabled; by code → id/type/name/enabled).
      if (sql.includes("SELECT invite_code, invite_enabled FROM chats WHERE id")) return chats.get(String(p[0]));
      if (sql.includes("SELECT id, type, name, invite_enabled FROM chats WHERE invite_code")) return [...chats.values()].find((c) => c.invite_code === p[0]);
      if (sql.includes("SELECT id, invite_enabled FROM chats WHERE invite_code")) return [...chats.values()].find((c) => c.invite_code === p[0]);
      if (sql.includes("SELECT 1 AS ok FROM chats WHERE id")) return chats.get(String(p[0])) ? { ok: 1 } : undefined;
      // Slice 7: privacy (allow_auto_group_add) by user id.
      if (sql.includes("SELECT allow_auto_group_add FROM users WHERE id")) {
        const v = opts.privacyById?.[String(p[0])];
        return { allow_auto_group_add: v === undefined ? 1 : v };
      }
      // Slice 7: join_requests lookups.
      if (sql.includes("SELECT status FROM join_requests WHERE chat_id")) {
        const r = joinRequests.find((j) => j.chat_id === p[0] && j.user_id === p[1]);
        return r ? { status: r.status } : undefined;
      }
      if (sql.includes("SELECT id, status FROM join_requests WHERE chat_id")) {
        const r = joinRequests.find((j) => j.chat_id === p[0] && j.user_id === p[1]);
        return r ? { id: r.id, status: r.status } : undefined;
      }
      if (sql.includes("SELECT user_id, status FROM join_requests WHERE id")) {
        const r = joinRequests.find((j) => j.id === p[0] && j.chat_id === p[1]);
        return r ? { user_id: r.user_id, status: r.status } : undefined;
      }
      if (sql.includes("SELECT status FROM join_requests WHERE id")) {
        const r = joinRequests.find((j) => j.id === p[0] && j.chat_id === p[1]);
        return r ? { status: r.status } : undefined;
      }
      return undefined;
    },
    async run(sql, p = []) {
      if (sql.startsWith("INSERT INTO chats")) chats.set(String(p[0]), { id: p[0], type: p[1], slug: p[7] ?? null, invite_code: null, invite_enabled: 1 });
      else if (sql.startsWith("INSERT INTO chat_members")) {
        // createGroup inlines the role literal; addMember/approve insert a 'member'.
        const role = sql.includes("'owner'") ? "owner" : "member";
        // createGroup binds joined_at at p[2]; addMember/approve bind it at p[2] too.
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
      } else if (sql.startsWith("UPDATE chats SET invite_code")) {
        // getOrCreateInvite/refreshInvite: (code, chatId)
        const c = chats.get(String(p[1])); if (c) { c.invite_code = p[0]; c.invite_enabled = 1; }
      } else if (sql.startsWith("UPDATE chats SET invite_enabled = 0")) {
        const c = chats.get(String(p[0])); if (c) c.invite_enabled = 0;
      } else if (sql.startsWith("UPDATE users SET allow_auto_group_add")) {
        // (value, userId) — reflect into the privacy map so a later GET sees it.
        (opts.privacyById ??= {})[String(p[1])] = Number(p[0]);
      } else if (sql.startsWith("INSERT INTO join_requests")) {
        joinRequests.push({ id: String(p[0]), chat_id: String(p[1]), user_id: String(p[2]), status: "pending", created_at: Number(p[3]) });
      } else if (sql.startsWith("UPDATE join_requests SET status = 'pending', created_at")) {
        const r = joinRequests.find((j) => j.id === p[1]); if (r) { r.status = "pending"; r.created_at = Number(p[0]); }
      } else if (sql.startsWith("UPDATE join_requests SET status = 'approved'")) {
        const r = joinRequests.find((j) => j.id === p[0]); if (r) r.status = "approved";
      } else if (sql.startsWith("UPDATE join_requests SET status = 'rejected'")) {
        const r = joinRequests.find((j) => j.id === p[0]); if (r) r.status = "rejected";
      }
    },
  };
  return { db, members, chats, joinRequests };
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
  it("creates a CHANNEL (type:'channel') with the caller as owner", async () => {
    const { db, members, chats } = groupApiDb({ session: validSession("u1") });
    const res = await handleCreateChat(
      cookieReq("https://x/api/chats", "s1", { method: "POST", body: JSON.stringify({ type: "channel", name: "Announcements", visibility: "public", slug: "news" }) }),
      db, now, cors,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chatId: string; created: boolean };
    expect(body.created).toBe(true);
    expect(chats.get(body.chatId)?.type).toBe("channel");
    expect(members.find((m) => m.chat_id === body.chatId && m.user_id === "u1")?.role).toBe("owner");
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

// ---- Slice 6: discovery (by-slug) + open-join routes ----

describe("GET /api/chats/by-slug/:slug", () => {
  it("401 with no session", async () => {
    const { db } = groupApiDb({ chats: [{ id: "c1", slug: "open", visibility: "public" }] });
    const res = await handleGetBySlug(cookieReq("https://x/api/chats/by-slug/open"), db, now, "open", cors);
    expect(res.status).toBe(401);
  });
  it("200 preview for a public chat to a non-member (isMember:false)", async () => {
    const { db } = groupApiDb({
      session: validSession("u9"),
      chats: [{ id: "c1", slug: "open", type: "group", name: "Open Room", visibility: "public" }],
      members: [{ chatId: "c1", userId: "owner", role: "owner", joinedAt: 1 }],
    });
    const res = await handleGetBySlug(cookieReq("https://x/api/chats/by-slug/open", "s1"), db, now, "open", cors);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "c1", type: "group", name: "Open Room", memberCount: 1, visibility: "public", isMember: false });
  });
  it("200 preview with isMember:true for a member", async () => {
    const { db } = groupApiDb({
      session: validSession("owner"),
      chats: [{ id: "c1", slug: "open", type: "channel", name: "Ch", visibility: "public" }],
      members: [{ chatId: "c1", userId: "owner", role: "owner", joinedAt: 1 }],
    });
    const res = await handleGetBySlug(cookieReq("https://x/api/chats/by-slug/open", "s1"), db, now, "open", cors);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ type: "channel", isMember: true });
  });
  it("200 request-access preview for a private+slug chat viewed by a non-member (Slice 7)", async () => {
    const { db } = groupApiDb({
      session: validSession("u9"),
      chats: [{ id: "c1", slug: "secret", type: "group", name: "Secret", visibility: "private" }],
      members: [{ chatId: "c1", userId: "owner", role: "owner", joinedAt: 1 }],
    });
    const res = await handleGetBySlug(cookieReq("https://x/api/chats/by-slug/secret", "s1"), db, now, "secret", cors);
    // Slice 7: private+slug is discoverable-but-gated → a preview (no bodies) with
    // canRequest so the UI can offer "request access". NOT a 404 anymore.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "c1", type: "group", name: "Secret", memberCount: 1, visibility: "private", isMember: false, canRequest: true, requestStatus: "none" });
  });
  it("404 private for an unknown slug (indistinguishable from private)", async () => {
    const { db } = groupApiDb({ session: validSession("u1") });
    const res = await handleGetBySlug(cookieReq("https://x/api/chats/by-slug/ghost", "s1"), db, now, "ghost", cors);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "private" });
  });
});

describe("POST /api/chats/:id/join (open-join)", () => {
  it("401 with no session", async () => {
    const { db } = groupApiDb({ chats: [{ id: "c1", visibility: "public" }] });
    const res = await handleJoin(cookieReq("https://x/api/chats/c1/join", undefined, { method: "POST" }), db, now, "c1", cors);
    expect(res.status).toBe(401);
  });
  it("200 joins a public chat (joined:true) + adds the caller as member", async () => {
    const { db, members } = groupApiDb({ session: validSession("u9"), chats: [{ id: "c1", visibility: "public" }] });
    const res = await handleJoin(cookieReq("https://x/api/chats/c1/join", "s1", { method: "POST" }), db, now, "c1", cors);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, joined: true });
    expect(members.find((m) => m.chat_id === "c1" && m.user_id === "u9")?.role).toBe("member");
  });
  it("200 idempotent for an already-member (joined:false)", async () => {
    const { db } = groupApiDb({
      session: validSession("u9"),
      chats: [{ id: "c1", visibility: "public" }],
      members: [{ chatId: "c1", userId: "u9", role: "member", joinedAt: 1 }],
    });
    const res = await handleJoin(cookieReq("https://x/api/chats/c1/join", "s1", { method: "POST" }), db, now, "c1", cors);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, joined: false });
  });
  it("403 must_request for a private chat (invites are Slice 7)", async () => {
    const { db } = groupApiDb({ session: validSession("u9"), chats: [{ id: "c1", visibility: "private" }] });
    const res = await handleJoin(cookieReq("https://x/api/chats/c1/join", "s1", { method: "POST" }), db, now, "c1", cors);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "must_request" });
  });
});

// ---- Slice 7: invite, request, and privacy routes ----

describe("POST /api/chats/:id/invite (create/refresh)", () => {
  it("401 with no session", async () => {
    const { db } = groupApiDb({ chats: [{ id: "g1" }] });
    const res = await handleCreateInvite(cookieReq("https://x/api/chats/g1/invite", undefined, { method: "POST" }), db, now, "g1", cors);
    expect(res.status).toBe(401);
  });
  it("owner creates → 200 with a 12-char code", async () => {
    const { db } = groupApiDb({ session: validSession("own"), chats: [{ id: "g1" }], members: grp("own", "owner") });
    const res = await handleCreateInvite(cookieReq("https://x/api/chats/g1/invite", "s1", { method: "POST" }), db, now, "g1", cors);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body.code).toHaveLength(12);
  });
  it("a plain member CANNOT create → 403 forbidden", async () => {
    const { db } = groupApiDb({ session: validSession("mem"), chats: [{ id: "g1" }], members: grp("mem", "member") });
    const res = await handleCreateInvite(cookieReq("https://x/api/chats/g1/invite", "s1", { method: "POST" }), db, now, "g1", cors);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });
  it("a non-member CANNOT create → 403 not_member", async () => {
    const { db } = groupApiDb({ session: validSession("u9"), chats: [{ id: "g1" }], members: grp("own", "owner") });
    const res = await handleCreateInvite(cookieReq("https://x/api/chats/g1/invite", "s1", { method: "POST" }), db, now, "g1", cors);
    expect(res.status).toBe(403);
  });
  it("{refresh:true} rotates the code → 200 with a NEW code", async () => {
    const { db } = groupApiDb({ session: validSession("own"), chats: [{ id: "g1", inviteCode: "old000000000" }], members: grp("own", "owner") });
    const res = await handleCreateInvite(cookieReq("https://x/api/chats/g1/invite", "s1", { method: "POST", body: JSON.stringify({ refresh: true }) }), db, now, "g1", cors);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { code: string }).code).not.toBe("old000000000");
  });
  it("400 bad_json on an unparseable body", async () => {
    const { db } = groupApiDb({ session: validSession("own"), chats: [{ id: "g1" }], members: grp("own", "owner") });
    const res = await handleCreateInvite(cookieReq("https://x/api/chats/g1/invite", "s1", { method: "POST", body: "{oops" }), db, now, "g1", cors);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_json" });
  });
});

describe("DELETE /api/chats/:id/invite (revoke)", () => {
  it("owner revokes → 200; the code stops resolving", async () => {
    const { db } = groupApiDb({ session: validSession("own"), chats: [{ id: "g1", inviteCode: "live00000000" }], members: grp("own", "owner") });
    const res = await handleRevokeInvite(cookieReq("https://x/api/chats/g1/invite", "s1", { method: "DELETE" }), db, now, "g1", cors);
    expect(res.status).toBe(200);
    // Resolving the now-revoked code → 404 bad_invite.
    const r2 = await handleResolveInvite(cookieReq("https://x/api/invite/live00000000", "s1"), db, now, "live00000000", cors);
    expect(r2.status).toBe(404);
  });
  it("a plain member CANNOT revoke → 403", async () => {
    const { db } = groupApiDb({ session: validSession("mem"), chats: [{ id: "g1", inviteCode: "live00000000" }], members: grp("mem", "member") });
    const res = await handleRevokeInvite(cookieReq("https://x/api/chats/g1/invite", "s1", { method: "DELETE" }), db, now, "g1", cors);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/invite/:code + POST /api/invite/:code/accept", () => {
  it("resolve → 200 preview for a live code", async () => {
    const { db } = groupApiDb({
      session: validSession("u9"),
      chats: [{ id: "g1", type: "group", name: "Room", inviteCode: "code00000000" }],
      members: grp("own", "owner"),
    });
    const res = await handleResolveInvite(cookieReq("https://x/api/invite/code00000000", "s1"), db, now, "code00000000", cors);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chatId: "g1", type: "group", name: "Room", memberCount: 1 });
  });
  it("resolve unknown/revoked → 404 bad_invite", async () => {
    const { db } = groupApiDb({ session: validSession("u9"), chats: [{ id: "g1", inviteCode: "gone00000000", inviteEnabled: 0 }] });
    expect((await handleResolveInvite(cookieReq("https://x/api/invite/gone00000000", "s1"), db, now, "gone00000000", cors)).status).toBe(404);
    expect((await handleResolveInvite(cookieReq("https://x/api/invite/nope00000000", "s1"), db, now, "nope00000000", cors)).status).toBe(404);
  });
  it("accept → 200 joins a PRIVATE chat (bypasses visibility), joined:true", async () => {
    const { db, members } = groupApiDb({
      session: validSession("u9"),
      chats: [{ id: "g1", visibility: "private", inviteCode: "code00000000" }],
      members: grp("own", "owner"),
    });
    const res = await handleAcceptInvite(cookieReq("https://x/api/invite/code00000000/accept", "s1", { method: "POST" }), db, now, "code00000000", cors);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, chatId: "g1", joined: true });
    expect(members.find((m) => m.chat_id === "g1" && m.user_id === "u9")?.role).toBe("member");
  });
  it("accept is idempotent for an already-member → joined:false", async () => {
    const { db } = groupApiDb({
      session: validSession("u9"),
      chats: [{ id: "g1", inviteCode: "code00000000" }],
      members: [{ chatId: "g1", userId: "u9", role: "member", joinedAt: 1 }],
    });
    const res = await handleAcceptInvite(cookieReq("https://x/api/invite/code00000000/accept", "s1", { method: "POST" }), db, now, "code00000000", cors);
    expect(await res.json()).toEqual({ ok: true, chatId: "g1", joined: false });
  });
  it("accept a revoked code → 404 bad_invite (no join)", async () => {
    const { db, members } = groupApiDb({ session: validSession("u9"), chats: [{ id: "g1", inviteCode: "gone00000000", inviteEnabled: 0 }] });
    const res = await handleAcceptInvite(cookieReq("https://x/api/invite/gone00000000/accept", "s1", { method: "POST" }), db, now, "gone00000000", cors);
    expect(res.status).toBe(404);
    expect(members.some((m) => m.user_id === "u9")).toBe(false);
  });
  it("401 with no session on accept", async () => {
    const { db } = groupApiDb({ chats: [{ id: "g1", inviteCode: "code00000000" }] });
    const res = await handleAcceptInvite(cookieReq("https://x/api/invite/code00000000/accept", undefined, { method: "POST" }), db, now, "code00000000", cors);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/chats/:id/request (join request)", () => {
  it("non-member requests a private+slug chat → 200 pending", async () => {
    const { db, joinRequests } = groupApiDb({
      session: validSession("u9"),
      chats: [{ id: "g1", slug: "gated", visibility: "private" }],
      members: grp("own", "owner"),
    });
    const res = await handleRequestJoin(cookieReq("https://x/api/chats/g1/request", "s1", { method: "POST" }), db, now, "g1", cors);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "pending" });
    expect(joinRequests).toHaveLength(1);
  });
  it("400 not_requestable for a private chat with NO slug (hidden)", async () => {
    const { db } = groupApiDb({ session: validSession("u9"), chats: [{ id: "g1", slug: null, visibility: "private" }], members: grp("own", "owner") });
    const res = await handleRequestJoin(cookieReq("https://x/api/chats/g1/request", "s1", { method: "POST" }), db, now, "g1", cors);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "not_requestable" });
  });
  it("400 open_join for a public chat (join directly)", async () => {
    const { db } = groupApiDb({ session: validSession("u9"), chats: [{ id: "g1", slug: "open", visibility: "public" }], members: grp("own", "owner") });
    const res = await handleRequestJoin(cookieReq("https://x/api/chats/g1/request", "s1", { method: "POST" }), db, now, "g1", cors);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "open_join" });
  });
  it("400 already_member when the caller is in", async () => {
    const { db } = groupApiDb({ session: validSession("mem"), chats: [{ id: "g1", slug: "gated", visibility: "private" }], members: [{ chatId: "g1", userId: "mem", role: "member", joinedAt: 1 }] });
    const res = await handleRequestJoin(cookieReq("https://x/api/chats/g1/request", "s1", { method: "POST" }), db, now, "g1", cors);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "already_member" });
  });
});

describe("GET /api/chats/:id/requests + approve/reject", () => {
  const seedGated = () => ({
    chats: [{ id: "g1", slug: "gated", visibility: "private" }],
    joinRequests: [{ id: "r1", chatId: "g1", userId: "req", status: "pending", createdAt: 100 }],
    usersById: { req: { username: "reqy", displayName: "Reqy", avatarUrl: null } },
  });
  it("owner/admin lists pending → 200 with requester identity", async () => {
    const { db } = groupApiDb({ session: validSession("own"), members: grp("own", "owner"), ...seedGated() });
    const res = await handleListRequests(cookieReq("https://x/api/chats/g1/requests", "s1"), db, now, "g1", cors);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requests: Array<{ userId: string; username: string }> };
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({ userId: "req", username: "reqy" });
  });
  it("a plain member CANNOT list → 403 forbidden", async () => {
    const { db } = groupApiDb({ session: validSession("mem"), members: grp("mem", "member"), ...seedGated() });
    const res = await handleListRequests(cookieReq("https://x/api/chats/g1/requests", "s1"), db, now, "g1", cors);
    expect(res.status).toBe(403);
  });
  it("a non-member CANNOT list → 403 not_member", async () => {
    const { db } = groupApiDb({ session: validSession("u9"), members: grp("own", "owner"), ...seedGated() });
    const res = await handleListRequests(cookieReq("https://x/api/chats/g1/requests", "s1"), db, now, "g1", cors);
    expect(res.status).toBe(403);
  });
  it("owner approves → 200; the requester becomes a member exactly once", async () => {
    const { db, members } = groupApiDb({ session: validSession("own"), members: grp("own", "owner"), ...seedGated() });
    const res = await handleApproveRequest(cookieReq("https://x/api/chats/g1/requests/r1/approve", "s1", { method: "POST" }), db, now, "g1", "r1", cors);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, userId: "req" });
    expect(members.filter((m) => m.chat_id === "g1" && m.user_id === "req")).toHaveLength(1);
  });
  it("a plain member CANNOT approve → 403", async () => {
    const { db, members } = groupApiDb({ session: validSession("mem"), members: grp("mem", "member"), ...seedGated() });
    const res = await handleApproveRequest(cookieReq("https://x/api/chats/g1/requests/r1/approve", "s1", { method: "POST" }), db, now, "g1", "r1", cors);
    expect(res.status).toBe(403);
    expect(members.some((m) => m.user_id === "req")).toBe(false);
  });
  it("owner rejects → 200; NO member added", async () => {
    const { db, members, joinRequests } = groupApiDb({ session: validSession("own"), members: grp("own", "owner"), ...seedGated() });
    const res = await handleRejectRequest(cookieReq("https://x/api/chats/g1/requests/r1/reject", "s1", { method: "POST" }), db, now, "g1", "r1", cors);
    expect(res.status).toBe(200);
    expect(members.some((m) => m.user_id === "req")).toBe(false);
    expect(joinRequests[0].status).toBe("rejected");
  });
  it("404 request_not_found for an unknown request id", async () => {
    const { db } = groupApiDb({ session: validSession("own"), members: grp("own", "owner"), ...seedGated() });
    const res = await handleApproveRequest(cookieReq("https://x/api/chats/g1/requests/ghost/approve", "s1", { method: "POST" }), db, now, "g1", "ghost", cors);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/chats/:id/members with an opted-out target (auto-invite)", () => {
  it("owner adds an opted-out user → 200 invited:true + inviteCode, NOT added", async () => {
    const { db, members } = groupApiDb({
      session: validSession("own"),
      usersByName: { shy: "shyId" },
      chats: [{ id: "g1" }],
      members: grp("own", "owner"),
      privacyById: { shyId: 0 },
    });
    const res = await handleAddMember(cookieReq("https://x/api/chats/g1/members", "s1", { method: "POST", body: JSON.stringify({ username: "shy" }) }), db, now, "g1", cors);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; invited?: boolean; inviteCode?: string };
    expect(body.invited).toBe(true);
    expect(body.inviteCode).toHaveLength(12);
    expect(members.some((m) => m.chat_id === "g1" && m.user_id === "shyId")).toBe(false);
  });
  it("owner adds an opted-IN user → 200 added (no invited flag)", async () => {
    const { db, members } = groupApiDb({
      session: validSession("own"),
      usersByName: { willing: "wId" },
      chats: [{ id: "g1" }],
      members: grp("own", "owner"),
    });
    const res = await handleAddMember(cookieReq("https://x/api/chats/g1/members", "s1", { method: "POST", body: JSON.stringify({ username: "willing" }) }), db, now, "g1", cors);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, userId: "wId" });
    expect(members.some((m) => m.chat_id === "g1" && m.user_id === "wId")).toBe(true);
  });
});

describe("GET/POST /api/account/privacy", () => {
  it("GET → 200 default allowAutoGroupAdd:true", async () => {
    const { db } = groupApiDb({ session: validSession("u1") });
    const res = await handleGetPrivacy(cookieReq("https://x/api/account/privacy", "s1"), db, now, cors);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowAutoGroupAdd: true });
  });
  it("401 with no session", async () => {
    const { db } = groupApiDb();
    expect((await handleGetPrivacy(cookieReq("https://x/api/account/privacy"), db, now, cors)).status).toBe(401);
    expect((await handleSetPrivacy(cookieReq("https://x/api/account/privacy", undefined, { method: "POST", body: "{}" }), db, now, cors)).status).toBe(401);
  });
  it("POST sets false → 200; a subsequent GET reflects it", async () => {
    const { db } = groupApiDb({ session: validSession("u1"), privacyById: { u1: 1 } });
    const res = await handleSetPrivacy(cookieReq("https://x/api/account/privacy", "s1", { method: "POST", body: JSON.stringify({ allowAutoGroupAdd: false }) }), db, now, cors);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, allowAutoGroupAdd: false });
    const get = await handleGetPrivacy(cookieReq("https://x/api/account/privacy", "s1"), db, now, cors);
    expect(await get.json()).toEqual({ allowAutoGroupAdd: false });
  });
  it("400 bad_value when allowAutoGroupAdd isn't a boolean", async () => {
    const { db } = groupApiDb({ session: validSession("u1") });
    const res = await handleSetPrivacy(cookieReq("https://x/api/account/privacy", "s1", { method: "POST", body: JSON.stringify({ allowAutoGroupAdd: "yes" }) }), db, now, cors);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_value" });
  });
  it("400 bad_json on an unparseable body", async () => {
    const { db } = groupApiDb({ session: validSession("u1") });
    const res = await handleSetPrivacy(cookieReq("https://x/api/account/privacy", "s1", { method: "POST", body: "{oops" }), db, now, cors);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_json" });
  });
});

// ---- Slice 9: account data deletion ----

/**
 * In-memory DB for account deletion: sessions (auth), chat_members (the caller's
 * chats + the `leave` owner-transfer logic), chats (last-member delete), plus
 * join_requests/sessions/users delete counters. Records what got deleted so a test
 * can assert the child-first erasure order + owned-chat handling.
 */
function accountDb(opts: {
  session?: Row;
  members?: Array<{ chatId: string; userId: string; role: string; joinedAt: number }>;
  chats?: string[];
} = {}) {
  const members: Row[] = (opts.members ?? []).map((m) => ({ chat_id: m.chatId, user_id: m.userId, role: m.role, joined_at: m.joinedAt }));
  const chats = new Set<string>([...(opts.chats ?? []), ...members.map((m) => String(m.chat_id))]);
  const deleted = { joinRequests: 0, sessions: 0, users: [] as string[], chats: [] as string[] };
  const db: DbClient = {
    async all(sql, p = []) {
      // handleDeleteAccount: the caller's chat memberships.
      if (sql.includes("SELECT chat_id FROM chat_members WHERE user_id")) {
        return members.filter((m) => m.user_id === p[0]).map((m) => ({ chat_id: m.chat_id }));
      }
      // leave(): remaining members of a chat, oldest-first.
      if (sql.includes("SELECT user_id, role, joined_at FROM chat_members WHERE chat_id")) {
        return members
          .filter((m) => m.chat_id === p[0])
          .sort((a, b) => Number(a.joined_at) - Number(b.joined_at) || String(a.user_id).localeCompare(String(b.user_id)));
      }
      return [];
    },
    async first(sql, p = []) {
      if (sql.includes("FROM sessions")) return opts.session;
      if (sql.includes("SELECT role FROM chat_members")) return members.find((m) => m.chat_id === p[0] && m.user_id === p[1]);
      return undefined;
    },
    async run(sql, p = []) {
      if (sql.startsWith("DELETE FROM chat_members")) {
        const i = members.findIndex((m) => m.chat_id === p[0] && m.user_id === p[1]);
        if (i >= 0) members.splice(i, 1);
      } else if (sql.startsWith("UPDATE chat_members SET role")) {
        const m = members.find((x) => x.chat_id === p[0] && x.user_id === p[1]);
        if (m) m.role = sql.includes("'owner'") ? "owner" : sql.includes("'admin'") ? "admin" : "member";
      } else if (sql.startsWith("DELETE FROM chats")) {
        chats.delete(String(p[0]));
        deleted.chats.push(String(p[0]));
      } else if (sql.startsWith("DELETE FROM join_requests")) {
        deleted.joinRequests++;
      } else if (sql.startsWith("DELETE FROM sessions")) {
        deleted.sessions++;
      } else if (sql.startsWith("DELETE FROM users")) {
        deleted.users.push(String(p[0]));
      }
    },
  };
  return { db, members, chats, deleted };
}

describe("POST /api/account/delete", () => {
  it("401 unauthorized with no session", async () => {
    const { db } = accountDb();
    const res = await handleDeleteAccount(cookieReq("https://x/api/account/delete", undefined, { method: "POST", body: JSON.stringify({ confirm: true }) }), db, now, cors);
    expect(res.status).toBe(401);
  });
  it("400 confirm_required without a confirm field", async () => {
    const { db, deleted } = accountDb({ session: validSession("u1") });
    const res = await handleDeleteAccount(cookieReq("https://x/api/account/delete", "s1", { method: "POST", body: JSON.stringify({}) }), db, now, cors);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "confirm_required" });
    // Nothing erased when confirmation is missing.
    expect(deleted.users).toHaveLength(0);
    expect(deleted.sessions).toBe(0);
  });
  it("400 confirm_required when confirm is falsy/wrong", async () => {
    const { db } = accountDb({ session: validSession("u1") });
    const res = await handleDeleteAccount(cookieReq("https://x/api/account/delete", "s1", { method: "POST", body: JSON.stringify({ confirm: false }) }), db, now, cors);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "confirm_required" });
  });
  it("400 bad_json on an unparseable body", async () => {
    const { db } = accountDb({ session: validSession("u1") });
    const res = await handleDeleteAccount(cookieReq("https://x/api/account/delete", "s1", { method: "POST", body: "{oops" }), db, now, cors);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_json" });
  });
  it("confirm:true → removes memberships/sessions/user, clears the cookie", async () => {
    const { db, members, deleted } = accountDb({
      session: validSession("u1"),
      members: [
        // A group where u1 is a plain member (someone else owns it) — u1 just leaves.
        { chatId: "g1", userId: "owner", role: "owner", joinedAt: 1 },
        { chatId: "g1", userId: "u1", role: "member", joinedAt: 2 },
      ],
    });
    const res = await handleDeleteAccount(cookieReq("https://x/api/account/delete", "s1", { method: "POST", body: JSON.stringify({ confirm: true }) }), db, now, cors);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // u1's membership is gone; the owner remains.
    expect(members.some((m) => m.user_id === "u1")).toBe(false);
    expect(members.some((m) => m.chat_id === "g1" && m.user_id === "owner")).toBe(true);
    // sessions + users erased; cookie cleared.
    expect(deleted.sessions).toBe(1);
    expect(deleted.users).toEqual(["u1"]);
    expect(deleted.joinRequests).toBe(1);
    expect(res.headers.get("Set-Cookie")).toContain(`${SESSION_COOKIE}=`);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
  it("confirm:'delete' string is also accepted", async () => {
    const { db, deleted } = accountDb({ session: validSession("u1") });
    const res = await handleDeleteAccount(cookieReq("https://x/api/account/delete", "s1", { method: "POST", body: JSON.stringify({ confirm: "delete" }) }), db, now, cors);
    expect(res.status).toBe(200);
    expect(deleted.users).toEqual(["u1"]);
  });
  it("a chat the caller SOLELY owns is deleted (leave's last-member path)", async () => {
    const { db, chats, deleted } = accountDb({
      session: validSession("u1"),
      members: [{ chatId: "solo", userId: "u1", role: "owner", joinedAt: 1 }],
    });
    const res = await handleDeleteAccount(cookieReq("https://x/api/account/delete", "s1", { method: "POST", body: JSON.stringify({ confirm: true }) }), db, now, cors);
    expect(res.status).toBe(200);
    // The sole-owned chat is removed entirely.
    expect(chats.has("solo")).toBe(false);
    expect(deleted.chats).toContain("solo");
  });
  it("owning a chat with other members transfers ownership, not delete", async () => {
    const { db, members, chats } = accountDb({
      session: validSession("u1"),
      members: [
        { chatId: "shared", userId: "u1", role: "owner", joinedAt: 1 },
        { chatId: "shared", userId: "u2", role: "member", joinedAt: 2 },
      ],
    });
    const res = await handleDeleteAccount(cookieReq("https://x/api/account/delete", "s1", { method: "POST", body: JSON.stringify({ confirm: true }) }), db, now, cors);
    expect(res.status).toBe(200);
    // The chat survives; u2 is promoted to owner.
    expect(chats.has("shared")).toBe(true);
    expect(members.find((m) => m.chat_id === "shared" && m.user_id === "u2")?.role).toBe("owner");
    expect(members.some((m) => m.user_id === "u1")).toBe(false);
  });
});

// ---- Slice 8: forward messages into a target chat ----

/**
 * Minimal DB for the forward gate: sessions (auth), chat membership/role
 * (isMember + getRole), and chat type (chatType). `members` is a map of
 * `${chatId}::${userId}` → role; `types` is chatId → 'group'|'channel'|'direct'.
 */
function forwardDb(opts: {
  session?: Row;
  members?: Record<string, string>; // "chat::user" -> role
  types?: Record<string, string>; // chatId -> type
} = {}) {
  const members = opts.members ?? {};
  const types = opts.types ?? {};
  const db: DbClient = {
    async all() {
      return [];
    },
    async first(sql, p = []) {
      if (sql.includes("FROM sessions")) return opts.session;
      // isMember: SELECT 1 AS ok FROM chat_members WHERE chat_id = ? AND user_id = ?
      if (sql.includes("SELECT 1 AS ok FROM chat_members")) {
        return members[`${String(p[0])}::${String(p[1])}`] != null ? { ok: 1 } : undefined;
      }
      // getRole: SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?
      if (sql.includes("SELECT role FROM chat_members")) {
        const role = members[`${String(p[0])}::${String(p[1])}`];
        return role ? { role } : undefined;
      }
      // chatType: SELECT type FROM chats WHERE id = ?
      if (sql.includes("SELECT type FROM chats WHERE id")) {
        const t = types[String(p[0])];
        return t ? { type: t } : undefined;
      }
      return undefined;
    },
    async run() {},
  };
  return db;
}

/**
 * Fake CONVERSATION namespace that records every appendMessage(senderId, body,
 * forwarded) call so a test can assert what was forwarded to which chat.
 */
function forwardEnv() {
  const calls: Array<{ chatId: string; senderId: string; body: string; forwarded: boolean }> = [];
  const CONVERSATION = {
    idFromName: (name: string) => name,
    get: (chatId: string) => ({
      appendMessage: async (senderId: string, body: string, forwarded: boolean) => {
        calls.push({ chatId, senderId, body, forwarded });
        return `msg-${calls.length}`;
      },
    }),
  };
  return { env: { CONVERSATION } as unknown as Env, calls };
}

describe("handleForward", () => {
  it("401 unauthorized with no session", async () => {
    const db = forwardDb();
    const { env } = forwardEnv();
    const res = await handleForward(
      cookieReq("https://x/api/chats/t1/forward", undefined, { method: "POST", body: JSON.stringify({ messages: [{ body: "hi" }] }) }),
      env, db, now, "t1", cors,
    );
    expect(res.status).toBe(401);
  });

  it("member forwards 2 messages into the target → appendMessage called twice with forwarded:true", async () => {
    const db = forwardDb({ session: validSession("u1"), members: { "t1::u1": "member" }, types: { t1: "group" } });
    const { env, calls } = forwardEnv();
    const res = await handleForward(
      cookieReq("https://x/api/chats/t1/forward", "s1", { method: "POST", body: JSON.stringify({ messages: [{ body: "one" }, { body: "two" }] }) }),
      env, db, now, "t1", cors,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ forwarded: 2 });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.chatId === "t1" && c.senderId === "u1" && c.forwarded === true)).toBe(true);
    expect(calls.map((c) => c.body)).toEqual(["one", "two"]);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("non-member forward → 403, nothing appended", async () => {
    const db = forwardDb({ session: validSession("u1"), members: {}, types: { t1: "group" } });
    const { env, calls } = forwardEnv();
    const res = await handleForward(
      cookieReq("https://x/api/chats/t1/forward", "s1", { method: "POST", body: JSON.stringify({ messages: [{ body: "hi" }] }) }),
      env, db, now, "t1", cors,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(calls).toHaveLength(0);
  });

  it("channel non-admin member forward → 403, nothing appended", async () => {
    const db = forwardDb({ session: validSession("u1"), members: { "t1::u1": "member" }, types: { t1: "channel" } });
    const { env, calls } = forwardEnv();
    const res = await handleForward(
      cookieReq("https://x/api/chats/t1/forward", "s1", { method: "POST", body: JSON.stringify({ messages: [{ body: "hi" }] }) }),
      env, db, now, "t1", cors,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(calls).toHaveLength(0);
  });

  it("channel owner/admin forward → 200 (owner/admin may post into a channel)", async () => {
    const db = forwardDb({ session: validSession("u1"), members: { "t1::u1": "admin" }, types: { t1: "channel" } });
    const { env, calls } = forwardEnv();
    const res = await handleForward(
      cookieReq("https://x/api/chats/t1/forward", "s1", { method: "POST", body: JSON.stringify({ messages: [{ body: "announce" }] }) }),
      env, db, now, "t1", cors,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ forwarded: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ chatId: "t1", senderId: "u1", body: "announce", forwarded: true });
  });

  it("400 bad_json on an unparseable body", async () => {
    const db = forwardDb({ session: validSession("u1"), members: { "t1::u1": "member" }, types: { t1: "group" } });
    const { env } = forwardEnv();
    const res = await handleForward(
      cookieReq("https://x/api/chats/t1/forward", "s1", { method: "POST", body: "{oops" }),
      env, db, now, "t1", cors,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_json" });
  });

  it("400 bad_messages when messages isn't an array", async () => {
    const db = forwardDb({ session: validSession("u1"), members: { "t1::u1": "member" }, types: { t1: "group" } });
    const { env } = forwardEnv();
    const res = await handleForward(
      cookieReq("https://x/api/chats/t1/forward", "s1", { method: "POST", body: JSON.stringify({ messages: "nope" }) }),
      env, db, now, "t1", cors,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_messages" });
  });

  it("skips empty/over-long bodies and caps the batch at 20", async () => {
    const db = forwardDb({ session: validSession("u1"), members: { "t1::u1": "member" }, types: { t1: "group" } });
    const { env, calls } = forwardEnv();
    // 25 items: 1 blank (skipped), 1 whitespace (skipped), 1 over-long (skipped),
    // then 22 valid — but the whole array is capped at 20 BEFORE validation, so
    // the first 20 entries are considered and the 3 invalid ones among them drop.
    const messages = [
      { body: "" },
      { body: "   " },
      { body: "x".repeat(4001) },
      ...Array.from({ length: 22 }, (_, i) => ({ body: `m${i}` })),
    ];
    const res = await handleForward(
      cookieReq("https://x/api/chats/t1/forward", "s1", { method: "POST", body: JSON.stringify({ messages }) }),
      env, db, now, "t1", cors,
    );
    expect(res.status).toBe(200);
    // First 20 of the 25 → drop 3 invalid → 17 forwarded.
    expect(await res.json()).toEqual({ forwarded: 17 });
    expect(calls).toHaveLength(17);
    expect(calls.every((c) => c.forwarded === true && c.body.length > 0)).toBe(true);
  });
});
