import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { joinPublic, createOrGetDirect, createGroup, syncLastMessage } from "./chats";
import { leave } from "./members";
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

describe("guarded owner handoff on the real SQL path (M12)", () => {
  /** Run leave(), deleting `vanish` from the chat right after the successor SELECT (a concurrent leave). */
  function racing(db: DbClient, sql: DatabaseSync, vanish: string[]): DbClient {
    let n = 0;
    return {
      ...db,
      async all(q, p) {
        const rows = await db.all(q, p);
        if (q.includes("SELECT user_id, role, joined_at") && n < vanish.length) sql.prepare("DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?").run(String(p?.[0]), vanish[n++]!);
        return rows;
      },
    };
  }
  it("promotes the oldest admin when nothing races", async () => {
    const { db, members, seedChat } = realDb();
    seedChat("c1", [["own", "owner", 1], ["adm", "admin", 2], ["mem", "member", 3]]);
    expect(await leave(db, "c1", "own")).toEqual({ ok: true, transferredTo: "adm" });
    expect(members("c1")).toEqual(["adm:owner", "mem:member"]);
  });
  it("the chosen successor leaves concurrently: another successor is picked, exactly one owner remains", async () => {
    const { db, sql, members, seedChat } = realDb();
    seedChat("c1", [["own", "owner", 1], ["adm", "admin", 2], ["mem", "member", 3]]);
    const r = await leave(racing(db, sql, ["adm"]), "c1", "own");
    expect(r).toEqual({ ok: true, transferredTo: "mem" }); // NOT the vanished "adm"
    expect(members("c1")).toEqual(["mem:owner"]);
  });
  it("the ONLY successor leaves concurrently: the chat is deleted rather than left ownerless", async () => {
    const { db, sql, seedChat } = realDb();
    seedChat("c1", [["own", "owner", 1], ["adm", "admin", 2]]);
    const r = await leave(racing(db, sql, ["adm"]), "c1", "own");
    expect(r).toEqual({ ok: true, deleted: true });
    expect(sql.prepare("SELECT COUNT(*) AS n FROM chats WHERE id = 'c1'").get()).toEqual({ n: 0 });
  });
  it("another owner already exists (a concurrent handoff won): no transferredTo, still one owner", async () => {
    const { db, sql, members, seedChat } = realDb();
    seedChat("c1", [["own", "owner", 1], ["adm", "admin", 2], ["mem", "member", 3]]);
    const stale: DbClient = {
      ...db,
      async all(q, p) {
        const rows = await db.all(q, p);
        if (q.includes("SELECT user_id, role, joined_at")) sql.prepare("UPDATE chat_members SET role = 'owner' WHERE chat_id = 'c1' AND user_id = 'mem'").run(); // rival handoff lands after our read
        return rows;
      },
    };
    const r = await leave(stale, "c1", "own");
    expect(r).toEqual({ ok: true });
    expect(members("c1").filter((m) => m.endsWith(":owner"))).toEqual(["mem:owner"]);
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
