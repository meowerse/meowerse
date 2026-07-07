import { describe, it, expect } from "vitest";
import { addMember, removeMember, promote, demote, leave } from "./members";
import { getRole, listMembers } from "./chats";
import type { DbClient, Row } from "./types";

/**
 * In-memory DB modeling `chat_members` (+ enough of `chats`/`users`) for the
 * members/roles logic. Members are kept as an ordered array so `joined_at ASC`
 * ordering (owner-transfer successor pick) is faithful.
 */
function memDb(seed: {
  members?: Array<{ chatId: string; userId: string; role: string; joinedAt: number }>;
  // Slice 7: per-user auto-group-add preference (default 1 when absent), and the
  // chat's invite_code/enabled (so the auto-invite path in addMember can mint one).
  privacyById?: Record<string, number>;
  chatMeta?: Record<string, { inviteCode?: string | null; inviteEnabled?: number }>;
} = {}) {
  const members: Row[] = (seed.members ?? []).map((m) => ({
    chat_id: m.chatId,
    user_id: m.userId,
    role: m.role,
    joined_at: m.joinedAt,
  }));
  const chats = new Set<string>(members.map((m) => String(m.chat_id)));
  const privacy = { ...(seed.privacyById ?? {}) };
  const meta: Record<string, { invite_code: string | null; invite_enabled: number }> = {};
  for (const [id, m] of Object.entries(seed.chatMeta ?? {})) meta[id] = { invite_code: m.inviteCode ?? null, invite_enabled: m.inviteEnabled ?? 1 };
  const metaFor = (id: string) => (meta[id] ??= { invite_code: null, invite_enabled: 1 });
  const db: DbClient = {
    async all(sql, p = []) {
      // Owner-transfer: remaining members ordered oldest-first.
      if (sql.includes("SELECT user_id, role, joined_at FROM chat_members WHERE chat_id")) {
        return members
          .filter((m) => m.chat_id === p[0])
          .sort((a, b) => Number(a.joined_at) - Number(b.joined_at) || String(a.user_id).localeCompare(String(b.user_id)));
      }
      // listMembers JOIN — not exercised here (covered in chats.test.ts).
      return [];
    },
    async first(sql, p = []) {
      if (sql.includes("SELECT role FROM chat_members")) {
        return members.find((m) => m.chat_id === p[0] && m.user_id === p[1]);
      }
      // Slice 7: privacy preference + invite lookups used by addMember's opt-out path.
      if (sql.includes("SELECT allow_auto_group_add FROM users WHERE id")) {
        const v = privacy[String(p[0])];
        return { allow_auto_group_add: v === undefined ? 1 : v };
      }
      if (sql.includes("SELECT invite_code, invite_enabled FROM chats WHERE id")) {
        return chats.has(String(p[0])) ? metaFor(String(p[0])) : undefined;
      }
      return undefined;
    },
    async run(sql, p = []) {
      if (sql.startsWith("INSERT INTO chat_members")) {
        members.push({ chat_id: p[0], user_id: p[1], role: p[2], joined_at: p[5] });
      } else if (sql.startsWith("DELETE FROM chat_members")) {
        const i = members.findIndex((m) => m.chat_id === p[0] && m.user_id === p[1]);
        if (i >= 0) members.splice(i, 1);
      } else if (sql.startsWith("UPDATE chat_members SET role")) {
        const role = sql.includes("'admin'") ? "admin" : sql.includes("'owner'") ? "owner" : "member";
        const m = members.find((x) => x.chat_id === p[0] && x.user_id === p[1]);
        if (m) m.role = role;
      } else if (sql.startsWith("UPDATE chats SET invite_code")) {
        const c = metaFor(String(p[1])); c.invite_code = String(p[0]); c.invite_enabled = 1;
      } else if (sql.startsWith("DELETE FROM chats")) {
        chats.delete(String(p[0]));
      }
    },
  };
  return { db, members, chats, meta };
}

const G = "g1";

describe("addMember", () => {
  it("owner adds a new member as 'member'", async () => {
    const { db } = memDb({ members: [{ chatId: G, userId: "owner", role: "owner", joinedAt: 1 }] });
    const r = await addMember(db, G, "owner", "new", 100);
    expect(r).toEqual({ ok: true });
    expect(await getRole(db, G, "new")).toBe("member");
  });
  it("admin can add", async () => {
    const { db } = memDb({
      members: [
        { chatId: G, userId: "owner", role: "owner", joinedAt: 1 },
        { chatId: G, userId: "adm", role: "admin", joinedAt: 2 },
      ],
    });
    expect((await addMember(db, G, "adm", "new", 100)).ok).toBe(true);
  });
  it("a plain member cannot add → forbidden", async () => {
    const { db } = memDb({
      members: [
        { chatId: G, userId: "owner", role: "owner", joinedAt: 1 },
        { chatId: G, userId: "mem", role: "member", joinedAt: 2 },
      ],
    });
    expect(await addMember(db, G, "mem", "new", 100)).toEqual({ ok: false, error: "forbidden" });
  });
  it("a non-member cannot add → not_member", async () => {
    const { db } = memDb({ members: [{ chatId: G, userId: "owner", role: "owner", joinedAt: 1 }] });
    expect(await addMember(db, G, "stranger", "new", 100)).toEqual({ ok: false, error: "not_member" });
  });
  it("adding an existing member → already_member", async () => {
    const { db } = memDb({
      members: [
        { chatId: G, userId: "owner", role: "owner", joinedAt: 1 },
        { chatId: G, userId: "mem", role: "member", joinedAt: 2 },
      ],
    });
    expect(await addMember(db, G, "owner", "mem", 100)).toEqual({ ok: false, error: "already_member" });
  });

  // ---- Slice 7: auto-invite when the target opted out of auto-group-add ----
  it("target opted OUT → NOT added; returns invited:true + a fresh invite code", async () => {
    const { db, members } = memDb({
      members: [{ chatId: G, userId: "owner", role: "owner", joinedAt: 1 }],
      privacyById: { shy: 0 },
    });
    const r = await addMember(db, G, "owner", "shy", 100);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.invited).toBe(true);
    expect(r.inviteCode).toHaveLength(12);
    // The opted-out user is NOT a member.
    expect(await getRole(db, G, "shy")).toBeNull();
    expect(members.some((m) => m.chat_id === G && m.user_id === "shy")).toBe(false);
  });
  it("target opted out but a code already exists → reuses that code (invited:true)", async () => {
    const { db } = memDb({
      members: [{ chatId: G, userId: "owner", role: "owner", joinedAt: 1 }],
      privacyById: { shy: 0 },
      chatMeta: { [G]: { inviteCode: "existing0000", inviteEnabled: 1 } },
    });
    const r = await addMember(db, G, "owner", "shy", 100);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r).toMatchObject({ ok: true, invited: true, inviteCode: "existing0000" });
  });
  it("target opted IN (default) → added directly, no invite", async () => {
    const { db } = memDb({ members: [{ chatId: G, userId: "owner", role: "owner", joinedAt: 1 }] });
    const r = await addMember(db, G, "owner", "willing", 100);
    expect(r).toEqual({ ok: true }); // no invited/inviteCode fields
    expect(await getRole(db, G, "willing")).toBe("member");
  });
  it("target explicitly opted in (=1) → added directly", async () => {
    const { db } = memDb({ members: [{ chatId: G, userId: "owner", role: "owner", joinedAt: 1 }], privacyById: { willing: 1 } });
    expect((await addMember(db, G, "owner", "willing", 100)).ok).toBe(true);
    expect(await getRole(db, G, "willing")).toBe("member");
  });
  it("the opt-out check happens AFTER authz — a non-admin still gets forbidden, no invite", async () => {
    const { db } = memDb({
      members: [
        { chatId: G, userId: "owner", role: "owner", joinedAt: 1 },
        { chatId: G, userId: "mem", role: "member", joinedAt: 2 },
      ],
      privacyById: { shy: 0 },
    });
    expect(await addMember(db, G, "mem", "shy", 100)).toEqual({ ok: false, error: "forbidden" });
  });
});

describe("removeMember", () => {
  const base = () => ({
    members: [
      { chatId: G, userId: "owner", role: "owner", joinedAt: 1 },
      { chatId: G, userId: "adm", role: "admin", joinedAt: 2 },
      { chatId: G, userId: "adm2", role: "admin", joinedAt: 3 },
      { chatId: G, userId: "mem", role: "member", joinedAt: 4 },
    ],
  });
  it("owner removes a member", async () => {
    const { db } = memDb(base());
    expect((await removeMember(db, G, "owner", "mem")).ok).toBe(true);
    expect(await getRole(db, G, "mem")).toBeNull();
  });
  it("admin removes a member", async () => {
    const { db } = memDb(base());
    expect((await removeMember(db, G, "adm", "mem")).ok).toBe(true);
  });
  it("nobody can remove the owner", async () => {
    const { db } = memDb(base());
    expect(await removeMember(db, G, "adm", "owner")).toEqual({ ok: false, error: "cannot_remove_owner" });
    // Owner still present.
    expect(await getRole(db, G, "owner")).toBe("owner");
  });
  it("an admin cannot remove another admin (only owner can)", async () => {
    const { db } = memDb(base());
    expect(await removeMember(db, G, "adm", "adm2")).toEqual({ ok: false, error: "cannot_remove_admin" });
    expect(await getRole(db, G, "adm2")).toBe("admin");
  });
  it("the owner CAN remove an admin", async () => {
    const { db } = memDb(base());
    expect((await removeMember(db, G, "owner", "adm")).ok).toBe(true);
    expect(await getRole(db, G, "adm")).toBeNull();
  });
  it("a member cannot remove anyone → forbidden", async () => {
    const { db } = memDb(base());
    expect(await removeMember(db, G, "mem", "adm")).toEqual({ ok: false, error: "forbidden" });
  });
  it("a non-member cannot remove → not_member", async () => {
    const { db } = memDb(base());
    expect(await removeMember(db, G, "stranger", "mem")).toEqual({ ok: false, error: "not_member" });
  });
  it("removing a non-member target → target_not_member", async () => {
    const { db } = memDb(base());
    expect(await removeMember(db, G, "owner", "ghost")).toEqual({ ok: false, error: "target_not_member" });
  });
});

describe("promote / demote (owner-only)", () => {
  const base = () => ({
    members: [
      { chatId: G, userId: "owner", role: "owner", joinedAt: 1 },
      { chatId: G, userId: "adm", role: "admin", joinedAt: 2 },
      { chatId: G, userId: "mem", role: "member", joinedAt: 3 },
    ],
  });
  it("owner promotes a member → admin", async () => {
    const { db } = memDb(base());
    expect((await promote(db, G, "owner", "mem")).ok).toBe(true);
    expect(await getRole(db, G, "mem")).toBe("admin");
  });
  it("an admin CANNOT promote → forbidden", async () => {
    const { db } = memDb(base());
    expect(await promote(db, G, "adm", "mem")).toEqual({ ok: false, error: "forbidden" });
    expect(await getRole(db, G, "mem")).toBe("member");
  });
  it("a member CANNOT promote → forbidden", async () => {
    const { db } = memDb(base());
    expect(await promote(db, G, "mem", "mem")).toEqual({ ok: false, error: "forbidden" });
  });
  it("promoting a non-member is not_member (already caught before target)", async () => {
    const { db } = memDb(base());
    expect(await promote(db, G, "owner", "ghost")).toEqual({ ok: false, error: "target_not_member" });
  });
  it("promoting an existing admin → not_promotable", async () => {
    const { db } = memDb(base());
    expect(await promote(db, G, "owner", "adm")).toEqual({ ok: false, error: "not_promotable" });
  });
  it("owner demotes an admin → member", async () => {
    const { db } = memDb(base());
    expect((await demote(db, G, "owner", "adm")).ok).toBe(true);
    expect(await getRole(db, G, "adm")).toBe("member");
  });
  it("an admin CANNOT demote → forbidden", async () => {
    const { db } = memDb(base());
    expect(await demote(db, G, "adm", "adm")).toEqual({ ok: false, error: "forbidden" });
  });
  it("demoting a plain member → not_demotable", async () => {
    const { db } = memDb(base());
    expect(await demote(db, G, "owner", "mem")).toEqual({ ok: false, error: "not_demotable" });
  });
  it("demoting a non-member target → target_not_member", async () => {
    const { db } = memDb(base());
    expect(await demote(db, G, "owner", "ghost")).toEqual({ ok: false, error: "target_not_member" });
  });
});

describe("leave", () => {
  it("a member leaves — just removed, no transfer", async () => {
    const { db } = memDb({
      members: [
        { chatId: G, userId: "owner", role: "owner", joinedAt: 1 },
        { chatId: G, userId: "mem", role: "member", joinedAt: 2 },
      ],
    });
    expect(await leave(db, G, "mem")).toEqual({ ok: true });
    expect(await getRole(db, G, "mem")).toBeNull();
    expect(await getRole(db, G, "owner")).toBe("owner");
  });
  it("a non-member leaving → not_member", async () => {
    const { db } = memDb({ members: [{ chatId: G, userId: "owner", role: "owner", joinedAt: 1 }] });
    expect(await leave(db, G, "stranger")).toEqual({ ok: false, error: "not_member" });
  });
  it("owner leaves → ownership transfers to the OLDEST admin", async () => {
    const { db } = memDb({
      members: [
        { chatId: G, userId: "owner", role: "owner", joinedAt: 1 },
        { chatId: G, userId: "mem", role: "member", joinedAt: 2 },
        { chatId: G, userId: "adminOld", role: "admin", joinedAt: 3 },
        { chatId: G, userId: "adminNew", role: "admin", joinedAt: 4 },
      ],
    });
    const r = await leave(db, G, "owner");
    expect(r).toEqual({ ok: true, transferredTo: "adminOld" });
    expect(await getRole(db, G, "adminOld")).toBe("owner");
    expect(await getRole(db, G, "adminNew")).toBe("admin");
    expect(await getRole(db, G, "owner")).toBeNull();
  });
  it("owner leaves with no admins → transfers to the OLDEST member", async () => {
    const { db } = memDb({
      members: [
        { chatId: G, userId: "owner", role: "owner", joinedAt: 1 },
        { chatId: G, userId: "memNew", role: "member", joinedAt: 3 },
        { chatId: G, userId: "memOld", role: "member", joinedAt: 2 },
      ],
    });
    const r = await leave(db, G, "owner");
    expect(r).toEqual({ ok: true, transferredTo: "memOld" });
    expect(await getRole(db, G, "memOld")).toBe("owner");
  });
  it("last member (the owner) leaves → chat deleted", async () => {
    const { db, chats } = memDb({ members: [{ chatId: G, userId: "owner", role: "owner", joinedAt: 1 }] });
    const r = await leave(db, G, "owner");
    expect(r).toEqual({ ok: true, deleted: true });
    expect(chats.has(G)).toBe(false);
    expect(await getRole(db, G, "owner")).toBeNull();
  });
});
