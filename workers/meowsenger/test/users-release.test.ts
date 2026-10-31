import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { upsertUser, getUser, userIdsByNames, isReleasedUsername } from "../src/users";
import { createSession, SESSION_COOKIE } from "../src/session";
import { handleCreateChat, handleAddMember } from "../src/chatapi";
import { listMembers } from "../src/chats";
import type { DbClient } from "../src/types";

// Username release (auth is the source of truth: a username belongs to ONE sub).
// Real SQLite with the real Meowsenger D1 schema, real users.ts / chatapi.ts code.

function meowsengerDb(): { db: DbClient; raw: DatabaseSync } {
  const c = new DatabaseSync(":memory:");
  const dir = new URL("../", import.meta.url);
  for (const f of ["schema.sql", "schema-push.sql", "schema-sec1.sql", "schema-slice5.sql", "schema-slice7.sql", "schema-lastseen.sql"]) {
    const sql = readFileSync(new URL(f, dir), "utf8").replace(/--[^\n]*/g, "");
    for (const stmt of sql.split(";").map((x) => x.trim()).filter(Boolean)) {
      try { c.exec(stmt); } catch (e) { if (!/duplicate column/.test(String(e))) throw e; }
    }
  }
  const db: DbClient = {
    all: async (sql, p = []) => c.prepare(sql).all(...(p as never[])) as never,
    first: async (sql, p = []) => c.prepare(sql).get(...(p as never[])) as never,
    run: async (sql, p = []) => { c.prepare(sql).run(...(p as never[])); },
    // D1 batch semantics: one transaction, all-or-nothing.
    batch: async (stmts) => {
      c.exec("BEGIN");
      try {
        const out = stmts.map((s) => Number(c.prepare(s.sql).run(...((s.params ?? []) as never[])).changes));
        c.exec("COMMIT");
        return out;
      } catch (e) { c.exec("ROLLBACK"); throw e; }
    },
  };
  return { db, raw: c };
}

const usernameOf = async (db: DbClient, id: string) => (await getUser(db, id))?.username;
afterEach(() => vi.restoreAllMocks());

describe("upsertUser releases a stale holder of the incoming username", () => {
  it("regression (was KNOWN DEFECT): a new sub reusing a deleted account's username signs in", async () => {
    const { db, raw } = meowsengerDb();
    await upsertUser(db, { sub: "acct_old", preferred_username: "alice", name: "Alice Old", picture: "http://x/a.png" }, 1);
    raw.exec("INSERT INTO chats (id,type,name,created_by,created_at,last_activity) VALUES ('c1','group','g','acct_old',1,1)");
    raw.exec("INSERT INTO chat_members (chat_id,user_id,role,joined_at) VALUES ('c1','acct_old','owner',1)");
    const msgsBefore = JSON.stringify(raw.prepare("SELECT * FROM chats").all());
    const memBefore = JSON.stringify(raw.prepare("SELECT * FROM chat_members").all());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(upsertUser(db, { sub: "acct_new", preferred_username: "alice" }, 2)).resolves.toBeUndefined();

    expect(await usernameOf(db, "acct_new")).toBe("alice");
    expect(await usernameOf(db, "acct_old")).toBe("~acct_old");
    const stale = await getUser(db, "acct_old");
    expect(stale).toMatchObject({ displayName: "Alice Old", avatarUrl: "http://x/a.png" }); // untouched
    expect(JSON.stringify(raw.prepare("SELECT * FROM chats").all())).toBe(msgsBefore);
    expect(JSON.stringify(raw.prepare("SELECT * FROM chat_members").all())).toBe(memBefore);
    expect(log).toHaveBeenCalledWith("user_username_released count=1"); // counts only: no ids / names
  });

  it("does not log or touch anything when the name is free or already ours", async () => {
    const { db } = meowsengerDb();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await upsertUser(db, { sub: "u1", preferred_username: "alice" }, 1);
    await upsertUser(db, { sub: "u1", preferred_username: "alice" }, 2);
    expect(await usernameOf(db, "u1")).toBe("alice");
    expect(log).not.toHaveBeenCalled();
  });

  it("the stale account signing in again gets its (new) username back from the placeholder", async () => {
    const { db } = meowsengerDb();
    await upsertUser(db, { sub: "acct_old", preferred_username: "alice" }, 1);
    await upsertUser(db, { sub: "acct_new", preferred_username: "alice" }, 2);
    expect(await usernameOf(db, "acct_old")).toBe("~acct_old");
    await upsertUser(db, { sub: "acct_old", preferred_username: "alice2" }, 3);
    expect(await usernameOf(db, "acct_old")).toBe("alice2");
    expect(await usernameOf(db, "acct_new")).toBe("alice");
  });

  it("rename swap: A takes B's old name before B has synced its rename; both sign-ins succeed", async () => {
    const { db } = meowsengerDb();
    await upsertUser(db, { sub: "A", preferred_username: "ann" }, 1);
    await upsertUser(db, { sub: "B", preferred_username: "bob" }, 1);
    // In auth: B renamed bob→bobby, then A renamed ann→bob. Meowsenger sees A first.
    await upsertUser(db, { sub: "A", preferred_username: "bob" }, 2);
    expect(await usernameOf(db, "A")).toBe("bob");
    expect(await usernameOf(db, "B")).toBe("~B");
    await upsertUser(db, { sub: "B", preferred_username: "bobby" }, 3);
    expect(await usernameOf(db, "B")).toBe("bobby");
    expect(await usernameOf(db, "A")).toBe("bob");
  });

  it("rename swap in the other order also succeeds", async () => {
    const { db } = meowsengerDb();
    await upsertUser(db, { sub: "A", preferred_username: "ann" }, 1);
    await upsertUser(db, { sub: "B", preferred_username: "bob" }, 1);
    await upsertUser(db, { sub: "B", preferred_username: "bobby" }, 2);
    await upsertUser(db, { sub: "A", preferred_username: "bob" }, 3);
    expect([await usernameOf(db, "A"), await usernameOf(db, "B")]).toEqual(["bob", "bobby"]);
  });

  it("concurrent sign-ins for the same username from different subs: exactly one holds it, no throw, no half-applied batch", async () => {
    const { db, raw } = meowsengerDb();
    await upsertUser(db, { sub: "old", preferred_username: "carol" }, 1);
    const results = await Promise.allSettled([
      upsertUser(db, { sub: "n1", preferred_username: "carol" }, 2),
      upsertUser(db, { sub: "n2", preferred_username: "carol" }, 2),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const holders = raw.prepare("SELECT id FROM users WHERE username = 'carol'").all();
    expect(holders).toHaveLength(1);
    // the other rows were each released (never lost / never duplicated)
    expect(raw.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 3 });
    const names = (raw.prepare("SELECT username FROM users").all() as { username: string }[]).map((r) => r.username).sort();
    expect(names.filter((n) => n === "carol")).toHaveLength(1);
    expect(names.filter(isReleasedUsername)).toHaveLength(2);
  });

  it("retries once when a concurrent batch wins the UNIQUE race; a second UNIQUE failure and other errors propagate", async () => {
    const { db } = meowsengerDb();
    await upsertUser(db, { sub: "old", preferred_username: "dave" }, 1);
    const real = db.batch!.bind(db);
    let calls = 0;
    const racy: DbClient = { ...db, batch: async (s) => { if (calls++ === 0) throw new Error("UNIQUE constraint failed: users.username"); return real(s); } };
    await upsertUser(racy, { sub: "n", preferred_username: "dave" }, 2);
    expect(calls).toBe(2);
    expect(await usernameOf(db, "n")).toBe("dave");

    const always: DbClient = { ...db, batch: async () => { throw new Error("UNIQUE constraint failed: users.username"); } };
    await expect(upsertUser(always, { sub: "z", preferred_username: "dave" }, 3)).rejects.toThrow(/UNIQUE/);
    const boom: DbClient = { ...db, batch: async () => { throw new Error("D1_ERROR: boom"); } };
    await expect(upsertUser(boom, { sub: "z", preferred_username: "x" }, 3)).rejects.toThrow(/boom/);
  });

  it("the batch is atomic: a failing INSERT rolls the release back", async () => {
    const { db } = meowsengerDb();
    await upsertUser(db, { sub: "old", preferred_username: "erin" }, 1);
    // updated_at NOT NULL → INSERT fails after the UPDATE ran in the same batch
    await expect(upsertUser(db, { sub: "n", preferred_username: "erin" }, null as never)).rejects.toThrow();
    expect(await usernameOf(db, "old")).toBe("erin");
  });

  it("requires an atomic batch from the db adapter", async () => {
    const { db } = meowsengerDb();
    await expect(upsertUser({ ...db, batch: undefined }, { sub: "u", preferred_username: "x" }, 1)).rejects.toThrow(/batch/);
  });
});

describe("a released placeholder is unresolvable by username", () => {
  const cors = {};
  async function world() {
    const w = meowsengerDb();
    await upsertUser(w.db, { sub: "acct_old", preferred_username: "alice", name: "Alice Old" }, 1);
    await upsertUser(w.db, { sub: "acct_new", preferred_username: "alice" }, 2);
    await upsertUser(w.db, { sub: "me", preferred_username: "meuser" }, 2);
    await createSession(w.db, { id: "sid", userId: "me", accessExp: 9e12, now: 3 });
    w.raw.exec("INSERT INTO chats (id,type,name,created_by,created_at,last_activity) VALUES ('g1','group','g','me',1,1)");
    w.raw.exec("INSERT INTO chat_members (chat_id,user_id,role,joined_at) VALUES ('g1','me','owner',1)");
    return w;
  }
  const req = (body: unknown) =>
    new Request("https://x/api", { method: "POST", headers: { Cookie: `${SESSION_COOKIE}=sid` }, body: JSON.stringify(body) });

  it("userIdsByNames ignores placeholders and still resolves the real holder", async () => {
    const { db } = await world();
    const m = await userIdsByNames(db, ["~acct_old", "alice"]);
    expect([...m.entries()]).toEqual([["alice", "acct_new"]]);
    expect((await userIdsByNames(db, ["~acct_old"])).size).toBe(0);
  });

  it("DM by exact placeholder: 404 user_not_found; the real name opens a DM with the new holder", async () => {
    const { db, raw } = await world();
    const bad = await handleCreateChat(req({ username: "~acct_old" }), db, 5, cors);
    expect(bad.status).toBe(404);
    expect(await bad.json()).toEqual({ error: "user_not_found" });
    const ok = await handleCreateChat(req({ username: "alice" }), db, 5, cors);
    expect(ok.status).toBe(200);
    const key = (raw.prepare("SELECT direct_key FROM chats WHERE type='direct'").get() as { direct_key: string }).direct_key;
    expect(key).toContain("acct_new");
    expect(key).not.toContain("acct_old");
  });

  it("group/channel create with a placeholder member: 404 user_not_found", async () => {
    const { db } = await world();
    const r = await handleCreateChat(req({ type: "group", name: "g", members: ["~acct_old"] }), db, 5, cors);
    expect(r.status).toBe(404);
    expect((await r.json() as { error: string }).error).toBe("user_not_found");
  });

  it("add-member by placeholder: 404 user_not_found, nobody added", async () => {
    const { db, raw } = await world();
    const r = await handleAddMember(req({ username: "~acct_old" }), db, 5, "g1", cors);
    expect(r.status).toBe(404);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM chat_members WHERE chat_id='g1'").get()).toEqual({ n: 1 });
  });

  it("a stale member's row stays listed (display name kept) but the placeholder is flagged for clients", async () => {
    const { db, raw } = await world();
    raw.exec("INSERT INTO chat_members (chat_id,user_id,role,joined_at) VALUES ('g1','acct_old','member',2)");
    const list = await listMembers(db, "g1");
    const stale = list.find((m) => m.userId === "acct_old")!;
    expect(stale.displayName).toBe("Alice Old");
    expect(isReleasedUsername(stale.username)).toBe(true);
  });

  it("isReleasedUsername: auth-valid names are never placeholders", () => {
    for (const n of ["alice", "a_1", "Z".repeat(32)]) expect(isReleasedUsername(n)).toBe(false);
    expect(isReleasedUsername("~x")).toBe(true);
  });
});

describe("username-less accounts can't have their handle claimed (opus review, critical)", () => {
  it("a Telegram-only account is stored under the unaddressable placeholder, not its bare id", async () => {
    const { db } = meowsengerDb();
    await upsertUser(db, { sub: "acct_victimABC", name: "Victim" }, 1);
    expect(await usernameOf(db, "acct_victimABC")).toBe("~acct_victimABC");
  });
  it("an attacker whose username equals the victim's id gets nothing of the victim's", async () => {
    const { db } = meowsengerDb();
    await upsertUser(db, { sub: "acct_victimABC", name: "Victim" }, 1);
    await upsertUser(db, { sub: "acct_attacker", preferred_username: "acct_victimABC" }, 2);
    expect(await usernameOf(db, "acct_victimABC")).toBe("~acct_victimABC"); // untouched
    expect(await getUser(db, "acct_victimABC")).toMatchObject({ displayName: "Victim" });
  });
  it("a LEGACY row stored as username = its id is never released (the claim fails instead)", async () => {
    const { db, raw } = meowsengerDb();
    raw.exec("INSERT INTO users (id, username, display_name, verified, updated_at) VALUES ('acct_legacyXYZ','acct_legacyXYZ','Legacy',0,1)");
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(upsertUser(db, { sub: "acct_attacker", preferred_username: "acct_legacyXYZ" }, 2)).rejects.toThrow(/UNIQUE/);
    expect(await usernameOf(db, "acct_legacyXYZ")).toBe("acct_legacyXYZ");
  });
  it("the one-shot data fix moves legacy id-named rows to the placeholder and is idempotent", async () => {
    const { db, raw } = meowsengerDb();
    raw.exec("INSERT INTO users (id, username, display_name, verified, updated_at) VALUES ('acct_legacyXYZ','acct_legacyXYZ','Legacy',0,1), ('acct_named','bob','Bob',0,1)");
    const fix = readFileSync(new URL("../schema-username-placeholder.sql", import.meta.url), "utf8").split("\n").filter((l) => !l.startsWith("--")).join("\n");
    raw.exec(fix); raw.exec(fix);
    expect(await usernameOf(db, "acct_legacyXYZ")).toBe("~acct_legacyXYZ");
    expect(await usernameOf(db, "acct_named")).toBe("bob");
  });
});
