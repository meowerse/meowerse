import { describe, it, expect } from "vitest";
import { joinPublic, approveRequest } from "./chats";
import { joinByInvite } from "./invites";
import { addMember, leave } from "./members";
import type { DbClient, Row } from "./types";

/**
 * A racy D1 stand-in: every membership READ is stale (the other request has not
 * committed yet) but the PRIMARY KEY (chat_id, user_id) is enforced on write, exactly
 * like D1. A plain INSERT of an existing member throws UNIQUE; INSERT OR IGNORE is a no-op.
 */
function racyDb(opts: { actor?: string } = {}) {
  const members = new Set<string>(); // "chat::user"
  const log: string[] = [];
  const db: DbClient = {
    async all(sql) { return sql.includes("user_id, role FROM chat_members") && opts.actor ? ([{ user_id: opts.actor, role: "owner" }] as Row[]) : []; },
    async first(sql, p = []) {
      if (sql.includes("SELECT visibility FROM chats")) return { visibility: "public" };
      if (sql.includes("SELECT id, invite_enabled FROM chats")) return { id: "c1", invite_enabled: 1 };
      if (sql.includes("SELECT user_id, status FROM join_requests")) return { user_id: "target", status: "pending" };
      if (sql.includes("SELECT role FROM chat_members")) return p[1] === opts.actor ? { role: "owner" } : undefined; // stale for everyone else
      return undefined;
    },
    async run(sql, p = []) {
      log.push(sql);
      if (/^INSERT (OR IGNORE )?INTO chat_members/.test(sql)) {
        const k = `${p[0]}::${p[1]}`;
        if (members.has(k)) { if (sql.startsWith("INSERT OR IGNORE")) return; throw new Error("UNIQUE constraint failed: chat_members.chat_id, chat_members.user_id"); }
        members.add(k);
      }
    },
  };
  return { db, members, log };
}

describe("membership inserts are idempotent under a race (M12)", () => {
  it("joinPublic: two concurrent joins both succeed with one row", async () => {
    const { db, members } = racyDb();
    await expect(Promise.all([joinPublic(db, "c1", "u1", 1), joinPublic(db, "c1", "u1", 2)])).resolves.toBeTruthy();
    expect(members.size).toBe(1);
  });
  it("joinByInvite: two concurrent accepts both succeed with one row", async () => {
    const { db, members } = racyDb();
    await expect(Promise.all([joinByInvite(db, "code", "u1", 1), joinByInvite(db, "code", "u1", 2)])).resolves.toBeTruthy();
    expect(members.size).toBe(1);
  });
  it("approveRequest: a double approval does not throw", async () => {
    const { db, members } = racyDb({ actor: "own" });
    await expect(Promise.all([approveRequest(db, "c1", "r1", "own", 1), approveRequest(db, "c1", "r1", "own", 2)])).resolves.toBeTruthy();
    expect(members.size).toBe(1);
  });
  it("addMember: a racing duplicate add does not throw", async () => {
    const { db, members } = racyDb({ actor: "own" });
    await expect(Promise.all([addMember(db, "c1", "own", "t", 1), addMember(db, "c1", "own", "t", 2)])).resolves.toBeTruthy();
    expect(members.size).toBe(1);
  });
});

describe("leave owner handoff is guarded (M12)", () => {
  it("promotes the successor only while the chat has no owner", async () => {
    const stmts: Array<{ sql: string; p: unknown[] }> = [];
    const db: DbClient = {
      async all(sql) { return sql.includes("SELECT user_id, role, joined_at") ? ([{ user_id: "b", role: "member", joined_at: 2 }] as Row[]) : []; },
      async first() { return { role: "owner" }; },
      async run(sql, p = []) { stmts.push({ sql, p }); },
    };
    const r = await leave(db, "c1", "a");
    expect(r).toEqual({ ok: true, transferredTo: "b" });
    const up = stmts.find((s) => s.sql.startsWith("UPDATE chat_members SET role = 'owner'"))!;
    expect(up.sql).toContain("NOT EXISTS (SELECT 1 FROM chat_members WHERE chat_id = ? AND role = 'owner')");
    expect(up.p).toEqual(["c1", "b", "c1"]);
  });
});
