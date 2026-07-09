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
  chatType,
  getPreviewBySlug,
  resolveChat,
  joinPublic,
  requestJoin,
  listRequests,
  approveRequest,
  rejectRequest,
  requestStatusFor,
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
            // Model the lazy has-unread derivation: last_activity > COALESCE(last_read_at, joined_at).
            const lastRead = m.last_read_at ?? m.joined_at ?? 0;
            const unread = Number(c.last_activity) > Number(lastRead) ? 1 : 0;
            return {
              ...c, role: "member", unread_count: unread, last_read_at: m.last_read_at ?? null,
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
      else if (sql.startsWith("INSERT INTO chat_members")) {
        // createOrGetDirect now inserts BOTH members in one multi-row INSERT; params
        // are grouped as (chat_id, user_id, joined_at) per row.
        for (let i = 0; i < p.length; i += 3) members.push({ chat_id: p[i], user_id: p[i + 1], unread_count: 0, last_read_at: null, joined_at: p[i + 2] });
      }
      else if (sql.startsWith("UPDATE chats SET last_message")) { const c = chats.get(String(p[3])); if (c) { c.last_message = p[0]; c.last_sender_id = p[1]; c.last_activity = p[2]; } }
      // markRead: advance last_read_at monotonically for one (chat, user) — the guard
      // (last_read_at IS NULL OR < upTo) means a stale/duplicate read is a no-op.
      else if (sql.startsWith("UPDATE chat_members SET last_read_at")) {
        const m = members.find((x) => x.chat_id === p[1] && x.user_id === p[2]);
        if (m && (m.last_read_at == null || Number(m.last_read_at) < Number(p[3]))) m.last_read_at = p[0];
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
  it("advances last_read_at monotonically for one member only", async () => {
    const { db, members } = memDb();
    const a = await createOrGetDirect(db, "u1", "u2", 1000);
    const u1 = members.find((m) => m.chat_id === a.id && m.user_id === "u1")!;
    const u2 = members.find((m) => m.chat_id === a.id && m.user_id === "u2")!;

    await markRead(db, a.id, "u1", 4200);
    expect(u1.last_read_at).toBe(4200);
    // The other member is untouched.
    expect(u2.last_read_at).toBeNull();

    // A stale (lower) upTo is a no-op — never moves the cursor backwards.
    await markRead(db, a.id, "u1", 3000);
    expect(u1.last_read_at).toBe(4200);
    // A newer upTo advances it.
    await markRead(db, a.id, "u1", 5000);
    expect(u1.last_read_at).toBe(5000);
  });
});
describe("unread (derived, no per-member counter)", () => {
  it("has-unread = last_activity > last_read_at; a send marks the non-reader, reading clears it", async () => {
    const { db } = memDb();
    const a = await createOrGetDirect(db, "u1", "u2", 1000);
    // Fresh DM: last_activity == joined_at → nobody unread.
    expect((await listChats(db, "u2"))[0].unreadCount).toBe(0);
    // A message bumps last_activity → the non-reader (u2) is now unread.
    await mirrorLastMessage(db, a.id, "hi", "u1", 3000);
    expect((await listChats(db, "u2"))[0].unreadCount).toBe(1);
    // u2 reads up to the message → back to read; a later message re-flags it.
    await markRead(db, a.id, "u2", 3000);
    expect((await listChats(db, "u2"))[0].unreadCount).toBe(0);
    await mirrorLastMessage(db, a.id, "again", "u1", 4000);
    expect((await listChats(db, "u2"))[0].unreadCount).toBe(1);
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
  // Slice 7: join_requests rows keyed loosely; UNIQUE(chat_id,user_id) modeled by
  // the find-then-reuse logic in requestJoin (mirrored in the run handler below).
  const joinRequests: Array<{ id: string; chat_id: string; user_id: string; status: string; created_at: number }> = [];
  const db: DbClient = {
    async all(sql, p = []) {
      // Slice 7: owner/admin request inbox (pending only), oldest-first, w/ user.
      if (sql.includes("FROM join_requests j")) {
        return joinRequests
          .filter((j) => j.chat_id === p[0] && j.status === "pending")
          .sort((a, b) => a.created_at - b.created_at)
          .map((j) => {
            const u = users[j.user_id] ?? { username: j.user_id, displayName: null, avatarUrl: null };
            return {
              id: j.id, user_id: j.user_id, status: j.status, created_at: j.created_at,
              username: u.username, display_name: u.displayName, avatar_url: u.avatarUrl,
            };
          });
      }
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
      // resolveChat looks the chat up by id FIRST (before falling back to slug).
      if (sql.includes("SELECT id, type, name, visibility, slug FROM chats WHERE id")) {
        return chats.get(String(p[0]));
      }
      // Slice 6: discovery preview (by slug) + chatType/join lookups (by id).
      // Slice 7 added `slug` to the preview SELECT — match on the common prefix.
      if (sql.includes("SELECT id, type, name, visibility")) {
        return [...chats.values()].find((c) => c.slug === p[0]);
      }
      if (sql.includes("SELECT type FROM chats WHERE id")) {
        return chats.get(String(p[0]));
      }
      if (sql.includes("SELECT visibility FROM chats WHERE id")) {
        return chats.get(String(p[0]));
      }
      // Slice 7: requestJoin reads visibility+slug by id.
      if (sql.includes("SELECT visibility, slug FROM chats WHERE id")) {
        return chats.get(String(p[0]));
      }
      // Folded member-count + caller's-role read (getPreviewBySlug/resolveChat):
      // p[0] = caller (may be null), p[1] = chatId.
      if (sql.includes("AS my_role")) {
        const rows = members.filter((m) => m.chat_id === p[1]);
        const mine = rows.find((m) => m.user_id === p[0]);
        return { n: rows.length, my_role: mine ? mine.role : null };
      }
      if (sql.includes("SELECT COUNT(*) AS n FROM chat_members WHERE chat_id")) {
        return { n: members.filter((m) => m.chat_id === p[0]).length };
      }
      // Slice 7: the caller's own request status (preview → none/pending/…).
      if (sql.includes("SELECT status FROM join_requests WHERE chat_id")) {
        const r = joinRequests.find((j) => j.chat_id === p[0] && j.user_id === p[1]);
        return r ? { status: r.status } : undefined;
      }
      // Slice 7: requestJoin's existing-row lookup by (chat_id,user_id).
      if (sql.includes("SELECT id, status FROM join_requests WHERE chat_id")) {
        const r = joinRequests.find((j) => j.chat_id === p[0] && j.user_id === p[1]);
        return r ? { id: r.id, status: r.status } : undefined;
      }
      // Slice 7: approve reads (user_id,status) by request id + chat id.
      if (sql.includes("SELECT user_id, status FROM join_requests WHERE id")) {
        const r = joinRequests.find((j) => j.id === p[0] && j.chat_id === p[1]);
        return r ? { user_id: r.user_id, status: r.status } : undefined;
      }
      // Slice 7: reject reads status by request id + chat id.
      if (sql.includes("SELECT status FROM join_requests WHERE id")) {
        const r = joinRequests.find((j) => j.id === p[0] && j.chat_id === p[1]);
        return r ? { status: r.status } : undefined;
      }
      return undefined;
    },
    async run(sql, p = []) {
      if (sql.startsWith("INSERT INTO chats")) {
        // createGroup binds `type` + inlines direct_key=NULL, so the bound params are
        // (id, type, name, created_by, created_at, last_activity, visibility, slug).
        chats.set(String(p[0]), {
          id: p[0], type: p[1], name: p[2], created_by: p[3], created_at: p[4],
          last_activity: p[5], direct_key: null, visibility: p[6], slug: p[7] ?? null,
        });
      } else if (sql.startsWith("INSERT INTO chat_members")) {
        // createGroup now inserts the creator ('owner') + every other member
        // ('member') in ONE multi-row INSERT: the FIRST VALUES row is the owner,
        // all following rows are members. joinPublic/approveRequest still insert a
        // single 'member' row. Params are grouped (chat_id, user_id, joined_at).
        for (let i = 0, first = true; i < p.length; i += 3, first = false) {
          const role = first && sql.includes("'owner'") ? "owner" : "member";
          members.push({ chat_id: p[i], user_id: p[i + 1], role, joined_at: p[i + 2] });
        }
      } else if (sql.startsWith("UPDATE chats SET name")) {
        const c = chats.get(String(p[1])); if (c) c.name = p[0];
      } else if (sql.startsWith("UPDATE chats SET visibility")) {
        const c = chats.get(String(p[1])); if (c) c.visibility = p[0];
      } else if (sql.startsWith("UPDATE chats SET slug = NULL")) {
        const c = chats.get(String(p[0])); if (c) c.slug = null;
      } else if (sql.startsWith("UPDATE chats SET slug")) {
        const c = chats.get(String(p[1])); if (c) c.slug = p[0];
      } else if (sql.startsWith("INSERT INTO join_requests")) {
        // (id, chat_id, user_id, status='pending', created_at)
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
  return { db, chats, members, joinRequests };
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

// ---- Slice 6: channels, discovery, open-join ----

describe("createGroup (channel type)", () => {
  it("creates a channel: type='channel', creator=owner", async () => {
    const { db, chats } = groupDb();
    const r = await createGroup(db, { name: "News", creatorId: "o", memberIds: ["m1"], type: "channel" }, 1000) as { id: string };
    expect(chats.get(r.id)!.type).toBe("channel");
    expect(await getRole(db, r.id, "o")).toBe("owner");
    expect(await getRole(db, r.id, "m1")).toBe("member");
  });
  it("defaults to a group when type is omitted or unknown", async () => {
    const { db, chats } = groupDb();
    const a = await createGroup(db, { name: "A", creatorId: "o", memberIds: [] }, 1) as { id: string };
    const b = await createGroup(db, { name: "B", creatorId: "o", memberIds: [], type: "bogus" as never }, 2) as { id: string };
    expect(chats.get(a.id)!.type).toBe("group");
    expect(chats.get(b.id)!.type).toBe("group");
  });
});

describe("chatType", () => {
  it("returns the chat's type, or null for an unknown chat", async () => {
    const { db } = groupDb();
    const ch = await createGroup(db, { name: "C", creatorId: "o", memberIds: [], type: "channel" }, 1) as { id: string };
    const gp = await createGroup(db, { name: "G", creatorId: "o", memberIds: [] }, 2) as { id: string };
    expect(await chatType(db, ch.id)).toBe("channel");
    expect(await chatType(db, gp.id)).toBe("group");
    expect(await chatType(db, "nope")).toBeNull();
  });
});

describe("getPreviewBySlug", () => {
  it("public chat → preview to a non-member (isMember:false, no messages)", async () => {
    const { db } = groupDb();
    const r = await createGroup(db, { name: "Open Room", creatorId: "o", memberIds: ["m1"], visibility: "public", slug: "open-room" }, 1) as { id: string };
    const preview = await getPreviewBySlug(db, "open-room", "stranger");
    expect(preview).toEqual({ id: r.id, type: "group", name: "Open Room", memberCount: 2, visibility: "public", isMember: false });
  });
  it("public channel → preview carries type:'channel'", async () => {
    const { db } = groupDb();
    await createGroup(db, { name: "Broadcast", creatorId: "o", memberIds: [], visibility: "public", slug: "broadcast", type: "channel" }, 1);
    const preview = await getPreviewBySlug(db, "broadcast", "stranger");
    expect(preview).toMatchObject({ type: "channel", visibility: "public", isMember: false });
  });
  it("public chat → member gets isMember:true", async () => {
    const { db } = groupDb();
    await createGroup(db, { name: "Open", creatorId: "o", memberIds: ["m1"], visibility: "public", slug: "open" }, 1);
    expect(await getPreviewBySlug(db, "open", "m1")).toMatchObject({ isMember: true });
  });
  it("private+slug chat → non-member gets a request-access preview (Slice 7)", async () => {
    const { db } = groupDb();
    const r = await createGroup(db, { name: "Secret", creatorId: "o", memberIds: [], slug: "secret" }, 1) as { id: string }; // private default
    // Slice 7: a private chat WITH a slug is "discoverable but gated" — a
    // non-member gets a preview (no bodies) plus canRequest + their request status.
    expect(await getPreviewBySlug(db, "secret", "stranger")).toEqual({
      id: r.id, type: "group", name: "Secret", memberCount: 1,
      visibility: "private", isMember: false, canRequest: true, requestStatus: "none",
    });
    // Anonymous caller (null) also gets the gated preview, status "none".
    expect(await getPreviewBySlug(db, "secret", null)).toMatchObject({ canRequest: true, requestStatus: "none" });
  });
  it("private+slug preview reflects the caller's own pending request status", async () => {
    const { db } = groupDb();
    const r = await createGroup(db, { name: "Secret", creatorId: "o", memberIds: [], slug: "secret" }, 1) as { id: string };
    await requestJoin(db, r.id, "stranger", 100);
    expect(await getPreviewBySlug(db, "secret", "stranger")).toMatchObject({ canRequest: true, requestStatus: "pending" });
  });
  it("private chat → its member still gets a preview (isMember:true, no canRequest)", async () => {
    const { db } = groupDb();
    await createGroup(db, { name: "Secret", creatorId: "o", memberIds: ["m1"], slug: "secret" }, 1);
    expect(await getPreviewBySlug(db, "secret", "m1")).toMatchObject({ visibility: "private", isMember: true });
  });
  it("unknown slug → {error:'private'} (same as private, no existence leak)", async () => {
    const { db } = groupDb();
    expect(await getPreviewBySlug(db, "no-such-slug", "someone")).toEqual({ error: "private" });
  });
  it("malformed slug → {error:'private'}", async () => {
    const { db } = groupDb();
    expect(await getPreviewBySlug(db, "!!", "someone")).toEqual({ error: "private" });
  });
});

describe("resolveChat (deep-link by id-or-slug)", () => {
  it("by id, member → openable payload with slug + visibility + role", async () => {
    const { db } = groupDb();
    const r = await createGroup(db, { name: "Room", creatorId: "o", memberIds: ["m1"], visibility: "public", slug: "room" }, 1) as { id: string };
    expect(await resolveChat(db, r.id, "m1")).toMatchObject({
      id: r.id, type: "group", name: "Room", slug: "room", visibility: "public", isMember: true, role: "member",
    });
  });
  it("by slug, member (owner) → resolves the same chat", async () => {
    const { db } = groupDb();
    const r = await createGroup(db, { name: "Room", creatorId: "o", memberIds: [], slug: "room" }, 1) as { id: string };
    expect(await resolveChat(db, "room", "o")).toMatchObject({ id: r.id, isMember: true, role: "owner" });
  });
  it("public chat, non-member → preview (isMember:false)", async () => {
    const { db } = groupDb();
    const r = await createGroup(db, { name: "Open", creatorId: "o", memberIds: [], visibility: "public", slug: "open" }, 1) as { id: string };
    expect(await resolveChat(db, r.id, "stranger")).toMatchObject({ id: r.id, isMember: false, visibility: "public" });
  });
  it("private+slug chat, non-member → request-access preview", async () => {
    const { db } = groupDb();
    const r = await createGroup(db, { name: "Secret", creatorId: "o", memberIds: [], slug: "secret" }, 1) as { id: string };
    expect(await resolveChat(db, r.id, "stranger")).toMatchObject({ isMember: false, canRequest: true, requestStatus: "none" });
  });
  it("private, NO slug, non-member → null (no existence leak)", async () => {
    const { db } = groupDb();
    const r = await createGroup(db, { name: "Hidden", creatorId: "o", memberIds: [] }, 1) as { id: string };
    expect(await resolveChat(db, r.id, "stranger")).toBeNull();
  });
  it("unknown id/slug → null", async () => {
    const { db } = groupDb();
    expect(await resolveChat(db, "ghost", "someone")).toBeNull();
  });
});

describe("joinPublic", () => {
  it("adds the caller as a member to a public chat", async () => {
    const { db } = groupDb();
    const r = await createGroup(db, { name: "Open", creatorId: "o", memberIds: [], visibility: "public", slug: "open" }, 1) as { id: string };
    expect(await joinPublic(db, r.id, "joiner", 5000)).toEqual({ ok: true, joined: true });
    expect(await getRole(db, r.id, "joiner")).toBe("member");
  });
  it("is idempotent — an already-member returns joined:false", async () => {
    const { db } = groupDb();
    const r = await createGroup(db, { name: "Open", creatorId: "o", memberIds: ["m1"], visibility: "public", slug: "open" }, 1) as { id: string };
    expect(await joinPublic(db, r.id, "m1", 5000)).toEqual({ ok: true, joined: false });
  });
  it("refuses a private chat → must_request (Slice 7 invites)", async () => {
    const { db } = groupDb();
    const r = await createGroup(db, { name: "Secret", creatorId: "o", memberIds: [], slug: "secret" }, 1) as { id: string };
    expect(await joinPublic(db, r.id, "joiner", 5000)).toEqual({ ok: false, error: "must_request" });
    expect(await getRole(db, r.id, "joiner")).toBeNull();
  });
  it("refuses an unknown chat → must_request (no existence leak)", async () => {
    const { db } = groupDb();
    expect(await joinPublic(db, "ghost", "joiner", 5000)).toEqual({ ok: false, error: "must_request" });
  });
});

// ---- Slice 7: join requests ----

describe("requestJoin", () => {
  it("a non-member requests to join a private+slug chat → pending", async () => {
    const { db, joinRequests } = groupDb();
    const r = await createGroup(db, { name: "Gated", creatorId: "o", memberIds: [], slug: "gated" }, 1) as { id: string };
    expect(await requestJoin(db, r.id, "stranger", 100)).toEqual({ ok: true, status: "pending" });
    expect(joinRequests).toHaveLength(1);
    expect(joinRequests[0]).toMatchObject({ chat_id: r.id, user_id: "stranger", status: "pending" });
  });
  it("is idempotent — a second request keeps a single pending row", async () => {
    const { db, joinRequests } = groupDb();
    const r = await createGroup(db, { name: "Gated", creatorId: "o", memberIds: [], slug: "gated" }, 1) as { id: string };
    await requestJoin(db, r.id, "stranger", 100);
    expect(await requestJoin(db, r.id, "stranger", 200)).toEqual({ ok: true, status: "pending" });
    expect(joinRequests).toHaveLength(1);
  });
  it("re-requesting after a rejection re-opens the row as pending", async () => {
    const { db, joinRequests } = groupDb();
    const r = await createGroup(db, { name: "Gated", creatorId: "o", memberIds: [], slug: "gated" }, 1) as { id: string };
    await requestJoin(db, r.id, "stranger", 100);
    await rejectRequest(db, r.id, joinRequests[0].id, "o");
    expect(joinRequests[0].status).toBe("rejected");
    expect(await requestJoin(db, r.id, "stranger", 300)).toEqual({ ok: true, status: "pending" });
    expect(joinRequests).toHaveLength(1);
    expect(joinRequests[0].status).toBe("pending");
  });
  it("an already-member cannot request → already_member", async () => {
    const { db } = groupDb();
    const r = await createGroup(db, { name: "Gated", creatorId: "o", memberIds: ["mem"], slug: "gated" }, 1) as { id: string };
    expect(await requestJoin(db, r.id, "mem", 100)).toEqual({ ok: false, error: "already_member" });
  });
  it("a PUBLIC chat is open-join, not requestable → open_join", async () => {
    const { db } = groupDb();
    const r = await createGroup(db, { name: "Open", creatorId: "o", memberIds: [], visibility: "public", slug: "open" }, 1) as { id: string };
    expect(await requestJoin(db, r.id, "stranger", 100)).toEqual({ ok: false, error: "open_join" });
  });
  it("a private chat with NO slug stays hidden → not_requestable", async () => {
    const { db } = groupDb();
    const r = await createGroup(db, { name: "Hidden", creatorId: "o", memberIds: [] }, 1) as { id: string }; // private, no slug
    expect(await requestJoin(db, r.id, "stranger", 100)).toEqual({ ok: false, error: "not_requestable" });
  });
  it("an unknown chat → not_found", async () => {
    const { db } = groupDb();
    expect(await requestJoin(db, "ghost", "stranger", 100)).toEqual({ ok: false, error: "not_found" });
  });
});

describe("requestStatusFor", () => {
  it("none before requesting, pending after", async () => {
    const { db } = groupDb();
    const r = await createGroup(db, { name: "Gated", creatorId: "o", memberIds: [], slug: "gated" }, 1) as { id: string };
    expect(await requestStatusFor(db, r.id, "stranger")).toBe("none");
    await requestJoin(db, r.id, "stranger", 100);
    expect(await requestStatusFor(db, r.id, "stranger")).toBe("pending");
  });
});

describe("listRequests", () => {
  it("owner/admin sees pending requests with requester identity, oldest-first", async () => {
    const { db } = groupDb({
      s1: { username: "sam", displayName: "Sam", avatarUrl: "https://a/s" },
      s2: { username: "sue", displayName: null, avatarUrl: null },
    });
    const r = await createGroup(db, { name: "Gated", creatorId: "o", memberIds: [], slug: "gated" }, 1) as { id: string };
    await requestJoin(db, r.id, "s1", 100);
    await requestJoin(db, r.id, "s2", 200);
    const res = await listRequests(db, r.id, "o");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.requests).toHaveLength(2);
    expect(res.requests[0]).toMatchObject({ userId: "s1", username: "sam", displayName: "Sam", status: "pending" });
    expect(res.requests[1]).toMatchObject({ userId: "s2", username: "sue" });
  });
  it("only PENDING requests are listed (approved/rejected excluded)", async () => {
    const { db, joinRequests } = groupDb();
    const r = await createGroup(db, { name: "Gated", creatorId: "o", memberIds: [], slug: "gated" }, 1) as { id: string };
    await requestJoin(db, r.id, "s1", 100);
    await requestJoin(db, r.id, "s2", 200);
    await rejectRequest(db, r.id, joinRequests.find((j) => j.user_id === "s1")!.id, "o");
    const res = await listRequests(db, r.id, "o");
    if (!res.ok) return;
    expect(res.requests.map((q) => q.userId)).toEqual(["s2"]);
  });
  it("a plain member CANNOT list → forbidden", async () => {
    const { db } = groupDb();
    const r = await createGroup(db, { name: "Gated", creatorId: "o", memberIds: ["mem"], slug: "gated" }, 1) as { id: string };
    expect(await listRequests(db, r.id, "mem")).toEqual({ ok: false, error: "forbidden" });
  });
  it("a non-member CANNOT list → not_member", async () => {
    const { db } = groupDb();
    const r = await createGroup(db, { name: "Gated", creatorId: "o", memberIds: [], slug: "gated" }, 1) as { id: string };
    expect(await listRequests(db, r.id, "stranger")).toEqual({ ok: false, error: "not_member" });
  });
});

describe("approveRequest", () => {
  it("owner approves → adds the requester as member (exactly once) + marks approved", async () => {
    const { db, joinRequests, members } = groupDb();
    const r = await createGroup(db, { name: "Gated", creatorId: "o", memberIds: [], slug: "gated" }, 1) as { id: string };
    await requestJoin(db, r.id, "stranger", 100);
    const reqId = joinRequests[0].id;
    const res = await approveRequest(db, r.id, reqId, "o", 500);
    expect(res).toEqual({ ok: true, userId: "stranger" });
    expect(await getRole(db, r.id, "stranger")).toBe("member");
    expect(members.filter((m) => m.chat_id === r.id && m.user_id === "stranger")).toHaveLength(1); // exactly once
    expect(joinRequests[0].status).toBe("approved");
  });
  it("approving an already-decided request → request_not_found (can't double-approve)", async () => {
    const { db, joinRequests, members } = groupDb();
    const r = await createGroup(db, { name: "Gated", creatorId: "o", memberIds: [], slug: "gated" }, 1) as { id: string };
    await requestJoin(db, r.id, "stranger", 100);
    const reqId = joinRequests[0].id;
    await approveRequest(db, r.id, reqId, "o", 500);
    // A second approve is a no-op (status no longer pending) → still exactly one member.
    expect(await approveRequest(db, r.id, reqId, "o", 600)).toEqual({ ok: false, error: "request_not_found" });
    expect(members.filter((m) => m.chat_id === r.id && m.user_id === "stranger")).toHaveLength(1);
  });
  it("a plain member CANNOT approve → forbidden", async () => {
    const { db, joinRequests } = groupDb();
    const r = await createGroup(db, { name: "Gated", creatorId: "o", memberIds: ["mem"], slug: "gated" }, 1) as { id: string };
    await requestJoin(db, r.id, "stranger", 100);
    expect(await approveRequest(db, r.id, joinRequests[0].id, "mem", 500)).toEqual({ ok: false, error: "forbidden" });
    expect(await getRole(db, r.id, "stranger")).toBeNull();
  });
  it("an unknown request id → request_not_found", async () => {
    const { db } = groupDb();
    const r = await createGroup(db, { name: "Gated", creatorId: "o", memberIds: [], slug: "gated" }, 1) as { id: string };
    expect(await approveRequest(db, r.id, "no-such", "o", 500)).toEqual({ ok: false, error: "request_not_found" });
  });
});

describe("rejectRequest", () => {
  it("owner rejects → marks rejected, adds NO member", async () => {
    const { db, joinRequests } = groupDb();
    const r = await createGroup(db, { name: "Gated", creatorId: "o", memberIds: [], slug: "gated" }, 1) as { id: string };
    await requestJoin(db, r.id, "stranger", 100);
    expect(await rejectRequest(db, r.id, joinRequests[0].id, "o")).toEqual({ ok: true });
    expect(joinRequests[0].status).toBe("rejected");
    expect(await getRole(db, r.id, "stranger")).toBeNull();
  });
  it("a plain member CANNOT reject → forbidden", async () => {
    const { db, joinRequests } = groupDb();
    const r = await createGroup(db, { name: "Gated", creatorId: "o", memberIds: ["mem"], slug: "gated" }, 1) as { id: string };
    await requestJoin(db, r.id, "stranger", 100);
    expect(await rejectRequest(db, r.id, joinRequests[0].id, "mem")).toEqual({ ok: false, error: "forbidden" });
  });
  it("an unknown request id → request_not_found", async () => {
    const { db } = groupDb();
    const r = await createGroup(db, { name: "Gated", creatorId: "o", memberIds: [], slug: "gated" }, 1) as { id: string };
    expect(await rejectRequest(db, r.id, "no-such", "o")).toEqual({ ok: false, error: "request_not_found" });
  });
});
