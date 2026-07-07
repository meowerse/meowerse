import { describe, it, expect } from "vitest";
import {
  createOrGetDirect,
  listChats,
  mirrorLastMessage,
  markRead,
  directKey,
  createGroup,
  getRole,
  listMembers,
  renameChat,
  setVisibility,
  setSlug,
  slugAvailable,
  normalizeSlug,
  roleAtLeast,
} from "./chats";
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
              peer_id: peer?.user_id ?? null,
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
    expect(forAlice[0].peerId).toBe("u2");
    expect(forAlice[0].peerUsername).toBe("bob");
    expect(forAlice[0].peerDisplayName).toBe("Bob");
    expect(forAlice[0].peerAvatarUrl).toBeNull();
    // From bob's side the peer is alice — order-independent.
    const forBob = await listChats(db, "u2");
    expect(forBob[0].peerId).toBe("u1");
    expect(forBob[0].peerUsername).toBe("alice");
    expect(forBob[0].peerAvatarUrl).toBe("https://a/1");
  });
});

// ---- Slice 5: groups, roles, slug/metadata ----

/**
 * Richer in-memory DB modeling `chats` (incl. visibility/slug), `chat_members`
 * (role/joined_at), and `users` (for the listMembers JOIN) — enough for the
 * group/role/slug helpers.
 */
function groupDb(users: Record<string, { username: string; displayName: string | null; avatarUrl: string | null }> = {}) {
  const chats = new Map<string, Row>();
  const members: Row[] = [];
  const db: DbClient = {
    async all(sql, p = []) {
      if (sql.includes("JOIN users u ON u.id = m.user_id")) {
        return members
          .filter((m) => m.chat_id === p[0])
          .sort((a, b) => Number(a.joined_at) - Number(b.joined_at))
          .map((m) => {
            const u = users[String(m.user_id)] ?? { username: String(m.user_id), displayName: null, avatarUrl: null };
            return {
              user_id: m.user_id,
              role: m.role,
              joined_at: m.joined_at,
              username: u.username,
              display_name: u.displayName,
              avatar_url: u.avatarUrl,
            };
          });
      }
      return [];
    },
    async first(sql, p = []) {
      if (sql.includes("SELECT role FROM chat_members")) {
        return members.find((m) => m.chat_id === p[0] && m.user_id === p[1]);
      }
      if (sql.includes("SELECT 1 AS ok FROM chats WHERE slug")) {
        return [...chats.values()].some((c) => c.slug === p[0]) ? { ok: 1 } : undefined;
      }
      if (sql.includes("SELECT id FROM chats WHERE slug")) {
        return [...chats.values()].find((c) => c.slug === p[0]);
      }
      return undefined;
    },
    async run(sql, p = []) {
      if (sql.startsWith("INSERT INTO chats")) {
        // createGroup inlines type='group' + direct_key=NULL, so the bound params are
        // (id, name, created_by, created_at, last_activity, visibility, slug).
        chats.set(String(p[0]), {
          id: p[0], type: "group", name: p[1], created_by: p[2], created_at: p[3],
          last_activity: p[4], direct_key: null, visibility: p[5], slug: p[6] ?? null,
        });
      } else if (sql.startsWith("INSERT INTO chat_members")) {
        // createGroup inlines the role literal ('owner' | 'member'); params are
        // (chat_id, user_id, joined_at).
        const role = sql.includes("'owner'") ? "owner" : "member";
        members.push({ chat_id: p[0], user_id: p[1], role, joined_at: p[2] });
      } else if (sql.startsWith("UPDATE chats SET name")) {
        const c = chats.get(String(p[1])); if (c) c.name = p[0];
      } else if (sql.startsWith("UPDATE chats SET visibility")) {
        const c = chats.get(String(p[1])); if (c) c.visibility = p[0];
      } else if (sql.startsWith("UPDATE chats SET slug = NULL")) {
        const c = chats.get(String(p[0])); if (c) c.slug = null;
      } else if (sql.startsWith("UPDATE chats SET slug")) {
        const c = chats.get(String(p[1])); if (c) c.slug = p[0];
      }
    },
  };
  return { db, chats, members };
}

describe("createGroup", () => {
  it("creates a group: creator=owner, others=member, defaults private/no-slug", async () => {
    const { db, chats, members } = groupDb();
    const r = await createGroup(db, { name: "  My Room ", creatorId: "owner", memberIds: ["m1", "m2"] }, 1000);
    expect("id" in r).toBe(true);
    const id = (r as { id: string }).id;
    const c = chats.get(id)!;
    expect(c.type).toBe("group");
    expect(c.name).toBe("My Room"); // trimmed
    expect(c.visibility).toBe("private");
    expect(c.slug).toBeNull();
    expect(await getRole(db, id, "owner")).toBe("owner");
    expect(await getRole(db, id, "m1")).toBe("member");
    expect(await getRole(db, id, "m2")).toBe("member");
    expect(members.filter((m) => m.chat_id === id)).toHaveLength(3);
  });
  it("dedups the member list and never re-adds the creator", async () => {
    const { db, members } = groupDb();
    const r = await createGroup(db, { name: "R", creatorId: "owner", memberIds: ["owner", "m1", "m1"] }, 1) as { id: string };
    expect(members.filter((m) => m.chat_id === r.id)).toHaveLength(2); // owner + m1
    expect(await getRole(db, r.id, "owner")).toBe("owner");
  });
  it("rejects a blank name", async () => {
    const { db } = groupDb();
    expect(await createGroup(db, { name: "   ", creatorId: "owner", memberIds: [] }, 1)).toEqual({ error: "name_required" });
  });
  it("stores a valid slug + public visibility", async () => {
    const { db, chats } = groupDb();
    const r = await createGroup(db, { name: "R", creatorId: "o", memberIds: [], visibility: "public", slug: "My Cool-Room" }, 1) as { id: string };
    expect(chats.get(r.id)!.visibility).toBe("public");
    expect(chats.get(r.id)!.slug).toBe("my-cool-room"); // slugified
  });
  it("rejects an invalid slug (too short after normalize)", async () => {
    const { db } = groupDb();
    expect(await createGroup(db, { name: "R", creatorId: "o", memberIds: [], slug: "!!" }, 1)).toEqual({ error: "bad_slug" });
  });
  it("rejects a slug already taken", async () => {
    const { db } = groupDb();
    await createGroup(db, { name: "First", creatorId: "o", memberIds: [], slug: "taken-slug" }, 1);
    expect(await createGroup(db, { name: "Second", creatorId: "o2", memberIds: [], slug: "taken-slug" }, 2)).toEqual({ error: "slug_taken" });
  });
});

describe("listMembers", () => {
  it("returns members oldest-first with user identity + role", async () => {
    const { db } = groupDb({
      o: { username: "owner", displayName: "Owner", avatarUrl: "https://a/o" },
      m1: { username: "m1", displayName: null, avatarUrl: null },
    });
    const r = await createGroup(db, { name: "R", creatorId: "o", memberIds: ["m1"] }, 1000) as { id: string };
    const list = await listMembers(db, r.id);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ userId: "o", username: "owner", displayName: "Owner", avatarUrl: "https://a/o", role: "owner", joinedAt: 1000 });
    expect(list[1]).toMatchObject({ userId: "m1", username: "m1", displayName: null, avatarUrl: null, role: "member" });
  });
});

describe("getRole", () => {
  it("returns null for a non-member", async () => {
    const { db } = groupDb();
    const r = await createGroup(db, { name: "R", creatorId: "o", memberIds: [] }, 1) as { id: string };
    expect(await getRole(db, r.id, "stranger")).toBeNull();
  });
});

describe("roleAtLeast", () => {
  it("ranks owner > admin > member and rejects unknown/null", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("admin", "admin")).toBe(true);
    expect(roleAtLeast("member", "admin")).toBe(false);
    expect(roleAtLeast("member", "member")).toBe(true);
    expect(roleAtLeast(null, "member")).toBe(false);
    expect(roleAtLeast("bogus", "member")).toBe(false);
  });
});

describe("normalizeSlug", () => {
  it("normalizes then validates ^[a-z0-9-]{3,32}$", () => {
    expect(normalizeSlug("Hello World")).toBe("hello-world");
    expect(normalizeSlug("  Trim--Me  ")).toBe("trim-me");
    expect(normalizeSlug("ab")).toBeNull(); // too short
    expect(normalizeSlug("!!")).toBeNull(); // empty after slugify
    expect(normalizeSlug("a".repeat(40))).toBeNull(); // too long
  });
});

describe("slugAvailable", () => {
  it("false for empty, true for a free slug, false once taken", async () => {
    const { db } = groupDb();
    expect(await slugAvailable(db, "")).toBe(false);
    expect(await slugAvailable(db, "free-slug")).toBe(true);
    await createGroup(db, { name: "R", creatorId: "o", memberIds: [], slug: "free-slug" }, 1);
    expect(await slugAvailable(db, "free-slug")).toBe(false);
  });
});

describe("setSlug", () => {
  it("sets, rejects taken (by another chat), allows idempotent re-set, and clears", async () => {
    const { db, chats } = groupDb();
    const a = await createGroup(db, { name: "A", creatorId: "o", memberIds: [] }, 1) as { id: string };
    const b = await createGroup(db, { name: "B", creatorId: "o2", memberIds: [], slug: "b-slug" }, 2) as { id: string };

    // Set a fresh slug on A.
    expect(await setSlug(db, a.id, "a-slug")).toEqual({ ok: true, slug: "a-slug" });
    expect(chats.get(a.id)!.slug).toBe("a-slug");
    // Re-setting A to its own slug is idempotent-ok.
    expect(await setSlug(db, a.id, "a-slug")).toEqual({ ok: true, slug: "a-slug" });
    // A cannot take B's slug.
    expect(await setSlug(db, a.id, "b-slug")).toEqual({ ok: false, error: "slug_taken" });
    // Invalid slug rejected.
    expect(await setSlug(db, a.id, "!!")).toEqual({ ok: false, error: "bad_slug" });
    // Clearing.
    expect(await setSlug(db, a.id, null)).toEqual({ ok: true, slug: null });
    expect(chats.get(a.id)!.slug).toBeNull();
    expect(await setSlug(db, a.id, "   ")).toEqual({ ok: true, slug: null });
  });
});

describe("renameChat / setVisibility", () => {
  it("renames and toggles visibility (clamps unknown to private)", async () => {
    const { db, chats } = groupDb();
    const r = await createGroup(db, { name: "Old", creatorId: "o", memberIds: [] }, 1) as { id: string };
    await renameChat(db, r.id, "  New Name ");
    expect(chats.get(r.id)!.name).toBe("New Name");
    await setVisibility(db, r.id, "public");
    expect(chats.get(r.id)!.visibility).toBe("public");
    await setVisibility(db, r.id, "garbage");
    expect(chats.get(r.id)!.visibility).toBe("private");
  });
});
