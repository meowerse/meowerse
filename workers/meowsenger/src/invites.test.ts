import { describe, it, expect } from "vitest";
import { getOrCreateInvite, refreshInvite, revokeInvite, resolveInvite, joinByInvite } from "./invites";
import { getRole } from "./chats";
import type { DbClient, Row } from "./types";

/**
 * In-memory DB modeling `chats` (id/type/name/invite_code/invite_enabled) +
 * `chat_members` (role), enough for the invite lifecycle + join-by-code.
 */
function inviteDb(seed: {
  chats?: Array<{ id: string; type?: string; name?: string | null; inviteCode?: string | null; inviteEnabled?: number }>;
  members?: Array<{ chatId: string; userId: string; role: string }>;
} = {}) {
  const chats = new Map<string, Row>(
    (seed.chats ?? []).map((c) => [
      c.id,
      { id: c.id, type: c.type ?? "group", name: c.name ?? null, invite_code: c.inviteCode ?? null, invite_enabled: c.inviteEnabled ?? 1 },
    ]),
  );
  const members: Row[] = (seed.members ?? []).map((m) => ({ chat_id: m.chatId, user_id: m.userId, role: m.role }));
  const db: DbClient = {
    async all() {
      return [];
    },
    async first(sql, p = []) {
      if (sql.includes("SELECT role FROM chat_members")) return members.find((m) => m.chat_id === p[0] && m.user_id === p[1]);
      if (sql.includes("SELECT invite_code, invite_enabled FROM chats WHERE id")) return chats.get(String(p[0]));
      if (sql.includes("SELECT 1 AS ok FROM chats WHERE id")) return chats.get(String(p[0])) ? { ok: 1 } : undefined;
      if (sql.includes("SELECT id, type, name, invite_enabled FROM chats WHERE invite_code")) return [...chats.values()].find((c) => c.invite_code === p[0]);
      if (sql.includes("SELECT id, invite_enabled FROM chats WHERE invite_code")) return [...chats.values()].find((c) => c.invite_code === p[0]);
      if (sql.includes("SELECT COUNT(*) AS n FROM chat_members WHERE chat_id")) return { n: members.filter((m) => m.chat_id === p[0]).length };
      return undefined;
    },
    async run(sql, p = []) {
      if (sql.startsWith("UPDATE chats SET invite_code")) {
        const c = chats.get(String(p[1])); if (c) { c.invite_code = p[0]; c.invite_enabled = 1; }
      } else if (sql.startsWith("UPDATE chats SET invite_enabled = 0")) {
        const c = chats.get(String(p[0])); if (c) c.invite_enabled = 0;
      } else if (sql.startsWith("INSERT INTO chat_members")) {
        members.push({ chat_id: p[0], user_id: p[1], role: "member" });
      }
    },
  };
  return { db, chats, members };
}

const owned = () => ({ chats: [{ id: "g1", type: "group", name: "Room" }], members: [{ chatId: "g1", userId: "own", role: "owner" }, { chatId: "g1", userId: "adm", role: "admin" }, { chatId: "g1", userId: "mem", role: "member" }] });

describe("getOrCreateInvite", () => {
  it("owner mints a 12-char code, then returns the SAME code (idempotent)", async () => {
    const { db, chats } = inviteDb(owned());
    const a = await getOrCreateInvite(db, "g1", "own");
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.code).toHaveLength(12);
    expect(chats.get("g1")!.invite_code).toBe(a.code);
    const b = await getOrCreateInvite(db, "g1", "own");
    expect(b).toEqual(a); // same code, not rotated
  });
  it("admin can create too", async () => {
    const { db } = inviteDb(owned());
    expect((await getOrCreateInvite(db, "g1", "adm")).ok).toBe(true);
  });
  it("a plain member CANNOT create → forbidden", async () => {
    const { db } = inviteDb(owned());
    expect(await getOrCreateInvite(db, "g1", "mem")).toEqual({ ok: false, error: "forbidden" });
  });
  it("a non-member CANNOT create → not_member", async () => {
    const { db } = inviteDb(owned());
    expect(await getOrCreateInvite(db, "g1", "stranger")).toEqual({ ok: false, error: "not_member" });
  });
  it("create against a missing chat row (actor somehow owner) → not_found", async () => {
    const { db } = inviteDb({ members: [{ chatId: "g1", userId: "own", role: "owner" }] });
    expect(await getOrCreateInvite(db, "g1", "own")).toEqual({ ok: false, error: "not_found" });
  });
  it("re-creating after a revoke mints a fresh, enabled code", async () => {
    const { db, chats } = inviteDb({ chats: [{ id: "g1", inviteCode: "oldcode00000", inviteEnabled: 0 }], members: [{ chatId: "g1", userId: "own", role: "owner" }] });
    const r = await getOrCreateInvite(db, "g1", "own");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code).not.toBe("oldcode00000");
    expect(chats.get("g1")!.invite_enabled).toBe(1);
  });
});

describe("refreshInvite", () => {
  it("owner rotates → a NEW code, invalidating the old link", async () => {
    const { db } = inviteDb({ chats: [{ id: "g1", inviteCode: "first0000000" }], members: [{ chatId: "g1", userId: "own", role: "owner" }] });
    const r = await refreshInvite(db, "g1", "own");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code).not.toBe("first0000000");
    // The old code no longer resolves.
    expect(await resolveInvite(db, "first0000000")).toBeNull();
    expect(await resolveInvite(db, r.code)).not.toBeNull();
  });
  it("a plain member CANNOT refresh → forbidden", async () => {
    const { db } = inviteDb(owned());
    expect(await refreshInvite(db, "g1", "mem")).toEqual({ ok: false, error: "forbidden" });
  });
  it("a non-member CANNOT refresh → not_member", async () => {
    const { db } = inviteDb(owned());
    expect(await refreshInvite(db, "g1", "stranger")).toEqual({ ok: false, error: "not_member" });
  });
  it("refresh of an unknown chat (actor somehow owner) → not_found", async () => {
    // Model an orphaned owner row whose chat row is gone (defensive not_found).
    const { db } = inviteDb({ members: [{ chatId: "g1", userId: "own", role: "owner" }] });
    expect(await refreshInvite(db, "g1", "own")).toEqual({ ok: false, error: "not_found" });
  });
});

describe("revokeInvite", () => {
  it("owner revokes → the code stops resolving", async () => {
    const { db } = inviteDb({ chats: [{ id: "g1", inviteCode: "live00000000" }], members: [{ chatId: "g1", userId: "own", role: "owner" }] });
    expect(await revokeInvite(db, "g1", "own")).toEqual({ ok: true });
    expect(await resolveInvite(db, "live00000000")).toBeNull();
  });
  it("a plain member CANNOT revoke → forbidden", async () => {
    const { db } = inviteDb({ chats: [{ id: "g1", inviteCode: "live00000000" }], members: [{ chatId: "g1", userId: "mem", role: "member" }] });
    expect(await revokeInvite(db, "g1", "mem")).toEqual({ ok: false, error: "forbidden" });
  });
  it("a non-member CANNOT revoke → not_member", async () => {
    const { db } = inviteDb({ chats: [{ id: "g1", inviteCode: "live00000000" }] });
    expect(await revokeInvite(db, "g1", "stranger")).toEqual({ ok: false, error: "not_member" });
  });
  it("revoke of an unknown chat (actor somehow owner) → not_found", async () => {
    const { db } = inviteDb({ members: [{ chatId: "g1", userId: "own", role: "owner" }] });
    expect(await revokeInvite(db, "g1", "own")).toEqual({ ok: false, error: "not_found" });
  });
});

describe("resolveInvite", () => {
  it("returns a preview (id/type/name/memberCount) for a live code", async () => {
    const { db } = inviteDb({ chats: [{ id: "g1", type: "channel", name: "News", inviteCode: "code00000000" }], members: [{ chatId: "g1", userId: "own", role: "owner" }, { chatId: "g1", userId: "x", role: "member" }] });
    expect(await resolveInvite(db, "code00000000")).toEqual({ chatId: "g1", type: "channel", name: "News", memberCount: 2 });
  });
  it("returns null for an unknown code", async () => {
    const { db } = inviteDb(owned());
    expect(await resolveInvite(db, "nope00000000")).toBeNull();
  });
  it("returns null for a revoked code (indistinguishable from unknown)", async () => {
    const { db } = inviteDb({ chats: [{ id: "g1", inviteCode: "gone00000000", inviteEnabled: 0 }] });
    expect(await resolveInvite(db, "gone00000000")).toBeNull();
  });
  it("returns null for a blank code", async () => {
    const { db } = inviteDb(owned());
    expect(await resolveInvite(db, "  ")).toBeNull();
  });
});

describe("joinByInvite", () => {
  it("adds the caller as a member, BYPASSING private visibility", async () => {
    const { db } = inviteDb({ chats: [{ id: "g1", inviteCode: "join00000000" }], members: [{ chatId: "g1", userId: "own", role: "owner" }] });
    const r = await joinByInvite(db, "join00000000", "newbie", 5000);
    expect(r).toEqual({ ok: true, chatId: "g1", joined: true });
    expect(await getRole(db, "g1", "newbie")).toBe("member");
  });
  it("is idempotent — an already-member returns joined:false", async () => {
    const { db } = inviteDb({ chats: [{ id: "g1", inviteCode: "join00000000" }], members: [{ chatId: "g1", userId: "mem", role: "member" }] });
    expect(await joinByInvite(db, "join00000000", "mem", 5000)).toEqual({ ok: true, chatId: "g1", joined: false });
  });
  it("a revoked code fails → bad_invite (no join)", async () => {
    const { db } = inviteDb({ chats: [{ id: "g1", inviteCode: "gone00000000", inviteEnabled: 0 }] });
    expect(await joinByInvite(db, "gone00000000", "newbie", 5000)).toEqual({ ok: false, error: "bad_invite" });
    expect(await getRole(db, "g1", "newbie")).toBeNull();
  });
  it("an unknown code fails → bad_invite", async () => {
    const { db } = inviteDb(owned());
    expect(await joinByInvite(db, "ghost0000000", "newbie", 5000)).toEqual({ ok: false, error: "bad_invite" });
  });
  it("a blank code fails → bad_invite", async () => {
    const { db } = inviteDb(owned());
    expect(await joinByInvite(db, "", "newbie", 5000)).toEqual({ ok: false, error: "bad_invite" });
  });
});
