import { describe, it, expect } from "vitest";
import { createOrGetDirect, listChats, mirrorLastMessage, directKey } from "./chats";
import type { DbClient, Row } from "./types";

function memDb() {
  const chats = new Map<string, Row>(); const members: Row[] = [];
  const db: DbClient = {
    async all(sql, p = []) {
      if (sql.includes("FROM chat_members m")) return chats.size ? [...chats.values()].map(c => ({ ...c, role: "member", unread_count: 0, last_read_at: null })) : [];
      return [];
    },
    async first(sql, p = []) {
      if (sql.includes("direct_key")) return [...chats.values()].find(c => c.direct_key === p[0]);
      if (sql.includes("FROM chats WHERE id")) return chats.get(String(p[0]));
      return undefined;
    },
    async run(sql, p = []) {
      if (sql.startsWith("INSERT INTO chats")) chats.set(String(p[0]), { id: p[0], type: "direct", name: null, created_by: p[1], created_at: p[2], last_activity: p[3], last_message: null, last_sender_id: null, direct_key: p[4] });
      else if (sql.startsWith("INSERT INTO chat_members")) members.push({ chat_id: p[0], user_id: p[1] });
      else if (sql.startsWith("UPDATE chats SET last_message")) { const c = chats.get(String(p[3])); if (c) { c.last_message = p[0]; c.last_sender_id = p[1]; c.last_activity = p[2]; } }
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
describe("listChats", () => {
  it("returns the user's chats", async () => {
    const { db } = memDb();
    await createOrGetDirect(db, "u1", "u2", 1000);
    const rows = await listChats(db, "u1");
    expect(rows.length).toBe(1);
  });
});
