import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { joinPublic, createOrGetDirect, createGroup, syncLastMessage, listChats } from "./chats";
import { leave, reconcileOwnership } from "./members";
import type { DbClient, Row } from "./types";

/**
 * REAL SQL (SQLite, the engine under D1) for the statements whose correctness lives in
 * the SQL itself: INSERT OR IGNORE, the guarded owner handoff, MAX(last_activity) and
 * UNIQUE enforcement. node:sqlite is built into Node (no new dependency); @libsql/client
 * is a devDependency of workers/auth only, not of this package.
 */
function realDb() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const db: DbClient = {
    async all(q, p = []) { return sql.prepare(q).all(...(p as never[])) as Row[]; },
    async first(q, p = []) { return (sql.prepare(q).get(...(p as never[])) as Row | undefined) ?? undefined; },
    async run(q, p = []) { return Number(sql.prepare(q).run(...(p as never[])).changes); },
    async batch(stmts) {
      sql.exec("BEGIN");
      try {
        const out = stmts.map((s) => Number(sql.prepare(s.sql).run(...((s.params ?? []) as never[])).changes));
        sql.exec("COMMIT");
        return out;
      } catch (e) { sql.exec("ROLLBACK"); throw e; }
    },
  };
  const members = (chat: string) => (sql.prepare("SELECT user_id, role FROM chat_members WHERE chat_id = ? ORDER BY user_id").all(chat) as Row[]).map((r) => `${r.user_id}:${r.role}`);
  const seedChat = (id: string, rows: Array<[string, string, number]>, visibility = "private") => {
    sql.prepare("INSERT INTO chats (id, type, name, created_by, created_at, last_activity, visibility) VALUES (?, 'group', 'g', 'x', 1, 1, ?)").run(id, visibility);
    for (const [u, role, joined] of rows) sql.prepare("INSERT INTO chat_members (chat_id, user_id, role, unread_count, last_read_at, joined_at) VALUES (?, ?, ?, 0, NULL, ?)").run(id, u, role, joined);
  };
  return { sql, db, members, seedChat };
}

describe("idempotent membership insert on the real SQL path (M12)", () => {
  it("INSERT OR IGNORE: two racing joins (both reads stale) both succeed with ONE row", async () => {
    const { db, sql, seedChat } = realDb();
    seedChat("c1", [["own", "owner", 1]], "public");
    // Both requests' membership READ predates the other's commit -> both reach the INSERT.
    const stale: DbClient = { ...db, async first(q, p) { return q.includes("SELECT role FROM chat_members") ? undefined : db.first(q, p); } };
    const [a, b] = await Promise.all([joinPublic(stale, "c1", "u1", 2), joinPublic(stale, "c1", "u1", 3)]);
    expect(a).toEqual({ ok: true, joined: true });
    expect(b).toEqual({ ok: true, joined: true });
    expect(sql.prepare("SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = 'c1' AND user_id = 'u1'").get()).toEqual({ n: 1 });
  });
  it("the PRIMARY KEY really rejects a plain duplicate INSERT (so the OR IGNORE is what saves the race)", async () => {
    const { sql, seedChat } = realDb();
    seedChat("c1", [["u1", "member", 1]]);
    expect(() => sql.prepare("INSERT INTO chat_members (chat_id, user_id, role, unread_count, last_read_at, joined_at) VALUES ('c1', 'u1', 'member', 0, NULL, 2)").run()).toThrow(/UNIQUE/);
  });
});

describe("atomic owner leave on the real SQL path (I2)", () => {
  const owners = (sql: DatabaseSync, chat: string) => (sql.prepare("SELECT user_id FROM chat_members WHERE chat_id = ? AND role = 'owner'").all(chat) as Row[]).map((r) => String(r.user_id));
  it("owner leaves with members: handoff to the oldest ADMIN in the same batch", async () => {
    const { db, members, seedChat } = realDb();
    seedChat("c1", [["own", "owner", 1], ["mem", "member", 2], ["adm", "admin", 3]]);
    expect(await leave(db, "c1", "own")).toEqual({ ok: true, transferredTo: "adm" }); // admin beats an older plain member
    expect(members("c1")).toEqual(["adm:owner", "mem:member"]);
  });
  it("no admin: the oldest member (ties by user_id) is promoted", async () => {
    const { db, members, seedChat } = realDb();
    seedChat("c1", [["own", "owner", 1], ["zed", "member", 2], ["abe", "member", 2]]);
    expect(await leave(db, "c1", "own")).toEqual({ ok: true, transferredTo: "abe" });
    expect(members("c1")).toEqual(["abe:owner", "zed:member"]);
  });
  it("the leave is ONE batch: leaver delete + handoff + empty-chat delete, no separate statements", async () => {
    const { db, seedChat } = realDb();
    seedChat("c1", [["own", "owner", 1], ["adm", "admin", 2]]);
    const calls: string[] = [];
    const spy: DbClient = { ...db, async run(q, p) { calls.push("run"); return db.run(q, p); }, async batch(st) { calls.push(`batch:${st.length}`); return db.batch!(st); } };
    await leave(spy, "c1", "own");
    expect(calls).toEqual(["batch:3"]);
  });
  it("owner leaves alone: the chat row is deleted", async () => {
    const { db, sql, seedChat } = realDb();
    seedChat("c1", [["own", "owner", 1]]);
    expect(await leave(db, "c1", "own")).toEqual({ ok: true, deleted: true });
    expect(sql.prepare("SELECT COUNT(*) AS n FROM chats WHERE id = 'c1'").get()).toEqual({ n: 0 });
  });
  it("a failure part-way rolls the WHOLE leave back: the leaver is still a member and the retry completes it", async () => {
    const { db, members, seedChat } = realDb();
    seedChat("c1", [["own", "owner", 1], ["adm", "admin", 2]]);
    const broken: DbClient = { ...db, async batch() { throw new Error("d1 down"); } };
    await expect(leave(broken, "c1", "own")).rejects.toThrow("d1 down");
    expect(members("c1")).toEqual(["adm:admin", "own:owner"]); // nothing half-applied
    expect(await leave(db, "c1", "own")).toEqual({ ok: true, transferredTo: "adm" });
  });
  it("the SUCCESSOR was promoted but leaves on a stale 'admin' read: the next-oldest is promoted, never ownerless", async () => {
    const { db, sql, members, seedChat } = realDb();
    seedChat("c1", [["own", "owner", 1], ["adm", "admin", 2], ["mem", "member", 3]]);
    // adm's role read happens before the owner's leave commits, its batch after.
    const stale: DbClient = { ...db, async first(q, p) { const r = await db.first(q, p); if (q.includes("SELECT role FROM chat_members")) { await leave(db, "c1", "own"); } return r; } };
    expect(await leave(stale, "c1", "adm")).toEqual({ ok: true }); // read 'admin' (stale), by commit time adm was the owner
    expect(members("c1")).toEqual(["mem:owner"]);
    expect(owners(sql, "c1")).toEqual(["mem"]);
  });
  it("owner and the only successor leave concurrently: the chat is deleted, not left ownerless", async () => {
    const { db, sql, seedChat } = realDb();
    seedChat("c1", [["own", "owner", 1], ["adm", "admin", 2]]);
    const stale: DbClient = { ...db, async first(q, p) { const r = await db.first(q, p); if (q.includes("SELECT role FROM chat_members") && p?.[1] === "own") await leave(db, "c1", "adm"); return r; } };
    expect(await leave(stale, "c1", "own")).toEqual({ ok: true, deleted: true });
    expect(sql.prepare("SELECT COUNT(*) AS n FROM chats WHERE id = 'c1'").get()).toEqual({ n: 0 });
  });
  it("another owner already exists: no handoff reported, still exactly one owner", async () => {
    const { db, sql, seedChat } = realDb();
    seedChat("c1", [["own", "owner", 1], ["adm", "admin", 2], ["mem", "member", 3]]);
    sql.prepare("UPDATE chat_members SET role = 'owner' WHERE chat_id = 'c1' AND user_id = 'mem'").run();
    expect(await leave(db, "c1", "own")).toEqual({ ok: true });
    expect(owners(sql, "c1")).toEqual(["mem"]);
  });
  it("direct chats have no owner by design: a leave never promotes anyone", async () => {
    const { db, sql } = realDb();
    const a = await createOrGetDirect(db, "u1", "u2", 1);
    expect(await leave(db, a.id, "u1")).toEqual({ ok: true });
    expect(owners(sql, a.id)).toEqual([]);
  });
});

describe("reconcileOwnership on the real SQL path (I2 retry)", () => {
  const owners = (sql: DatabaseSync, chat: string) => (sql.prepare("SELECT user_id FROM chat_members WHERE chat_id = ? AND role = 'owner'").all(chat) as Row[]).map((r) => String(r.user_id));
  it("leaver row already gone (partial failure): the retry's reconcile promotes the oldest admin", async () => {
    const { db, sql, seedChat } = realDb();
    seedChat("c1", [["own", "owner", 1], ["mem", "member", 2], ["adm", "admin", 3]]);
    sql.prepare("DELETE FROM chat_members WHERE chat_id = 'c1' AND user_id = 'own'").run(); // simulated half-applied leave
    expect(await leave(db, "c1", "own")).toEqual({ ok: false, error: "not_member" });
    expect(await reconcileOwnership(db, "c1")).toEqual({ transferredTo: "adm" });
    expect(owners(sql, "c1")).toEqual(["adm"]);
  });
  it("leaver row gone and nobody left: the empty chat is deleted", async () => {
    const { db, sql, seedChat } = realDb();
    seedChat("c1", [["own", "owner", 1]]);
    sql.prepare("DELETE FROM chat_members WHERE chat_id = 'c1'").run();
    expect(await reconcileOwnership(db, "c1")).toEqual({ deleted: true });
    expect(sql.prepare("SELECT COUNT(*) AS n FROM chats WHERE id = 'c1'").get()).toEqual({ n: 0 });
  });
  it("healthy chat: a no-op, and a second run changes nothing (idempotent)", async () => {
    const { db, members, seedChat } = realDb();
    seedChat("c1", [["own", "owner", 1], ["mem", "member", 2]]);
    expect(await reconcileOwnership(db, "c1")).toEqual({});
    expect(await reconcileOwnership(db, "c1")).toEqual({});
    expect(members("c1")).toEqual(["mem:member", "own:owner"]);
  });
  it("an unknown chat id is a no-op", async () => {
    const { db } = realDb();
    expect(await reconcileOwnership(db, "nope")).toEqual({});
  });
});

describe("chats SQL on the real engine", () => {
  it("syncLastMessage: preview follows the newest live row, last_activity only moves forward", async () => {
    const { db, sql, seedChat } = realDb();
    seedChat("c1", [["u1", "owner", 1]]);
    const get = () => sql.prepare("SELECT last_message AS m, last_sender_id AS s, last_activity AS a FROM chats WHERE id = 'c1'").get();
    await syncLastMessage(db, "c1", "M2", "u2", 50);
    expect(get()).toEqual({ m: "M2", s: "u2", a: 50 });
    await syncLastMessage(db, "c1", "M1", "u1", 20); // newest (M2) deleted: re-point back
    expect(get()).toEqual({ m: "M1", s: "u1", a: 50 });
    await syncLastMessage(db, "c1", null, null, 0); // nothing live left
    expect(get()).toEqual({ m: null, s: null, a: 50 });
  });
  it("createOrGetDirect re-adds only the caller and converges on the UNIQUE direct_key", async () => {
    const { db, sql } = realDb();
    const a = await createOrGetDirect(db, "u1", "u2", 1);
    expect(a.created).toBe(true);
    sql.prepare("DELETE FROM chat_members WHERE chat_id = ? AND user_id = 'u2'").run(a.id);
    const b = await createOrGetDirect(db, "u1", "u2", 2);
    expect(b).toEqual({ id: a.id, created: false });
    expect((sql.prepare("SELECT user_id FROM chat_members WHERE chat_id = ?").all(a.id) as Row[]).map((r) => r.user_id)).toEqual(["u1"]);
    // A racing creator whose read predates the winner's commit: the batch hits UNIQUE(direct_key) and converges.
    let first = true;
    const racy: DbClient = { ...db, async first(q, p) { if (q.includes("direct_key") && first) { first = false; return undefined; } return db.first(q, p); } };
    expect(await createOrGetDirect(racy, "u2", "u1", 3)).toEqual({ id: a.id, created: false });
  });
  it("createGroup: a duplicate slug at insert time rolls the whole batch back and reports slug_taken", async () => {
    const { db, sql } = realDb();
    const ok = await createGroup(db, { name: "g1", creatorId: "u1", memberIds: ["u2"], slug: "taken-slug" }, 1);
    expect("id" in ok).toBe(true);
    // Lose the slug race: availability read says free, but the row now exists.
    const racy: DbClient = { ...db, async first(q, p) { return q.includes("slug") && q.includes("SELECT") ? undefined : db.first(q, p); } };
    const lost = await createGroup(racy, { name: "g2", creatorId: "u3", memberIds: ["u4"], slug: "taken-slug" }, 2);
    expect(lost).toEqual({ error: "slug_taken" });
    expect(sql.prepare("SELECT COUNT(*) AS n FROM chats").get()).toEqual({ n: 1 });
    expect(sql.prepare("SELECT COUNT(*) AS n FROM chat_members WHERE user_id IN ('u3','u4')").get()).toEqual({ n: 0 });
  });
});

describe("listChats myRole (real SQL)", () => {
  it("returns the caller's own membership role per row; a non-member chat is not listed", async () => {
    const { db, seedChat } = realDb();
    seedChat("g1", [["own", "owner", 1], ["adm", "admin", 2], ["mem", "member", 3]]);
    seedChat("g2", [["own", "owner", 1]]);
    const { id: dm } = await createOrGetDirect(db, "mem", "adm", 10);
    const role = async (u: string) => Object.fromEntries((await listChats(db, u)).map((c) => [c.id, c.myRole]));
    expect(await role("own")).toEqual({ g1: "owner", g2: "owner" });
    expect(await role("adm")).toEqual({ g1: "admin", [dm]: "member" });
    expect(await role("mem")).toEqual({ g1: "member", [dm]: "member" });
    expect(await role("stranger")).toEqual({});
  });
});
