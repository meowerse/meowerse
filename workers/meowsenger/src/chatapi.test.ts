import { describe, it, expect } from "vitest";
import { handleListChats, handleCreateChat, handleHistory, callerId } from "./chatapi";
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
