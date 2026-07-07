import { describe, it, expect } from "vitest";
import { createOrGetDirect, listChats, mirrorLastMessage, markRead, directKey } from "./chats";
import type { DbClient, Row } from "./types";

function memDb(users: Record<string, { username: string; displayName: string | null; avatarUrl: string | null }> = {}) {
  const chats = new Map<string, Row>(); const members: Row[] = [];
  const db: DbClient = {
    async all(sql, p = []) {
      // Model the sidebar JOIN: for each of `me`'s memberships, find the OTHER
      // direct member and their user row (peer identity). Group peer cols = null.
      if (sql.includes("FROM chat_members m")) {
        const me = String(p[0]);
        return members
          .filter((m) => m.user_id === me)
          .map((m) => {
            const c = chats.get(String(m.chat_id))!;
            const peer = c.type === "direct"
              ? members.find((o) => o.chat_id === m.chat_id && o.user_id !== me)
              : undefined;
            const pu = peer ? users[String(peer.user_id)] : undefined;
            return {
              ...c, role: "member", unread_count: 0, last_read_at: null,
              peer_username: pu?.username ?? null,
              peer_display_name: pu?.displayName ?? null,
              peer_avatar_url: pu?.avatarUrl ?? null,
            };
          });
      }
      return [];
    },
    async first(sql, p = []) {
      if (sql.includes("direct_key")) return [...chats.values()].find(c => c.direct_key === p[0]);
      if (sql.includes("FROM chats WHERE id")) return chats.get(String(p[0]));
      return undefined;
    },
    async run(sql, p = []) {
      if (sql.startsWith("INSERT INTO chats")) chats.set(String(p[0]), { id: p[0], type: "direct", name: null, created_by: p[1], created_at: p[2], last_activity: p[3], last_message: null, last_sender_id: null, direct_key: p[4] });
      else if (sql.startsWith("INSERT INTO chat_members")) members.push({ chat_id: p[0], user_id: p[1], unread_count: 0, last_read_at: null });
      else if (sql.startsWith("UPDATE chats SET last_message")) { const c = chats.get(String(p[3])); if (c) { c.last_message = p[0]; c.last_sender_id = p[1]; c.last_activity = p[2]; } }
      // markRead: clear unread + advance last_read_at for one (chat, user).
      else if (sql.startsWith("UPDATE chat_members SET unread_count = 0, last_read_at")) {
        const m = members.find((x) => x.chat_id === p[1] && x.user_id === p[2]);
        if (m) { m.unread_count = 0; m.last_read_at = p[0]; }
      }
    },
  };
  return { db, chats, members };
}

describe("directKey", () => {
  it("is order-independent", () => {
    expect(directKey("b", "a")).toBe(directKey("a", "b"));
    expect(directKey("a", "b")).toBe("a:b");
  });
});
describe("createOrGetDirect", () => {
  it("creates a DM with both members + dedups on second call", async () => {
    const { db, chats, members } = memDb();
    const a = await createOrGetDirect(db, "u1", "u2", 1000);
    expect(a.created).toBe(true);
    expect(chats.size).toBe(1);
    expect(members.filter(m => m.chat_id === a.id)).toHaveLength(2);
    const b = await createOrGetDirect(db, "u2", "u1", 2000);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
  });
});
describe("mirrorLastMessage", () => {
  it("updates last_message/last_sender/last_activity", async () => {
    const { db, chats } = memDb();
    const a = await createOrGetDirect(db, "u1", "u2", 1000);
    await mirrorLastMessage(db, a.id, "hi", "u1", 3000);
    expect(chats.get(a.id)?.last_message).toBe("hi");
  });
});
describe("markRead", () => {
  it("clears unread and advances last_read_at for one member only", async () => {
    const { db, members } = memDb();
    const a = await createOrGetDirect(db, "u1", "u2", 1000);
    // Simulate u1 having accrued unread.
    const u1 = members.find((m) => m.chat_id === a.id && m.user_id === "u1")!;
    const u2 = members.find((m) => m.chat_id === a.id && m.user_id === "u2")!;
    u1.unread_count = 5;

    await markRead(db, a.id, "u1", 4200);

    expect(u1.unread_count).toBe(0);
    expect(u1.last_read_at).toBe(4200);
    // The other member is untouched.
    expect(u2.unread_count).toBe(0);
    expect(u2.last_read_at).toBeNull();
  });
});
describe("listChats", () => {
  it("returns the user's chats", async () => {
    const { db } = memDb();
    await createOrGetDirect(db, "u1", "u2", 1000);
    const rows = await listChats(db, "u1");
    expect(rows.length).toBe(1);
  });
  it("includes the DM peer's identity (the OTHER member), from each side", async () => {
    const { db } = memDb({
      u1: { username: "alice", displayName: "Alice", avatarUrl: "https://a/1" },
      u2: { username: "bob", displayName: "Bob", avatarUrl: null },
    });
    await createOrGetDirect(db, "u1", "u2", 1000);
    const forAlice = await listChats(db, "u1");
    expect(forAlice[0].peerUsername).toBe("bob");
    expect(forAlice[0].peerDisplayName).toBe("Bob");
    expect(forAlice[0].peerAvatarUrl).toBeNull();
    // From bob's side the peer is alice — order-independent.
    const forBob = await listChats(db, "u2");
    expect(forBob[0].peerUsername).toBe("alice");
    expect(forBob[0].peerAvatarUrl).toBe("https://a/1");
  });
});
