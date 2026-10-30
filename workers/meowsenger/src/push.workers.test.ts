import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { d1Client } from "./db";
import { savePushSubscription, deleteDeadPushSubscription } from "./push";

// Real D1 (workerd/miniflare SQLite): the ownership guard must hold under concurrency.
const DB = (env as unknown as { DB: D1Database }).DB;
const db = d1Client(DB);
const EP = "https://fcm.googleapis.com/fcm/send/race";

beforeAll(async () => {
  await DB.exec("CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, p256dh TEXT, auth TEXT, created_at INTEGER NOT NULL)");
});
beforeEach(async () => { await DB.exec("DELETE FROM push_subscriptions"); });

const owners = async (ep = EP) => (await db.all("SELECT user_id FROM push_subscriptions WHERE endpoint = ?", [ep])).map((r) => String(r.user_id));

describe("push_subscriptions on real D1", () => {
  it("two accounts registering the same endpoint concurrently → exactly one owner, the other is refused", async () => {
    for (let round = 0; round < 25; round++) {
      await DB.exec("DELETE FROM push_subscriptions");
      const [a, b] = await Promise.all([
        savePushSubscription(db, "uA", { endpoint: EP, p256dh: "A" }, 1),
        savePushSubscription(db, "uB", { endpoint: EP, p256dh: "B" }, 1),
      ]);
      expect([a, b].sort()).toEqual(["ok", "owned"]);
      const o = await owners();
      expect(o).toHaveLength(1);
      expect(o[0]).toBe(a === "ok" ? "uA" : "uB");
    }
  });
  it("a later registration by another account never transfers an existing row", async () => {
    expect(await savePushSubscription(db, "uA", { endpoint: EP, p256dh: "A" }, 1)).toBe("ok");
    expect(await savePushSubscription(db, "uB", { endpoint: EP, p256dh: "B" }, 2)).toBe("owned");
    expect(await savePushSubscription(db, "uB", { endpoint: EP, p256dh: "B" }, 3, "repair")).toBe("owned");
    const row = await db.first("SELECT user_id, p256dh, created_at FROM push_subscriptions WHERE endpoint = ?", [EP]);
    expect(row).toMatchObject({ user_id: "uA", p256dh: "A", created_at: 1 });
  });
  it("repair never inserts; late dead-endpoint cleanup keeps a fresher registration", async () => {
    expect(await savePushSubscription(db, "uA", { endpoint: EP }, 1, "repair")).toBe("not_subscribed");
    expect(await owners()).toEqual([]);
    await savePushSubscription(db, "uA", { endpoint: EP, p256dh: "old" }, 100);
    await savePushSubscription(db, "uA", { endpoint: EP, p256dh: "fresh" }, 250, "repair");
    await deleteDeadPushSubscription(db, EP, "uA", 200);
    expect(await owners()).toEqual(["uA"]);
    await deleteDeadPushSubscription(db, EP, "uA", 300);
    expect(await owners()).toEqual([]);
  });
  it("rotation (previousEndpoint) atomically moves the caller's own row; never another user's; never onto an existing endpoint", async () => {
    const OLD = "https://fcm.googleapis.com/fcm/send/old";
    const rows = async () => (await db.all("SELECT endpoint, user_id, p256dh FROM push_subscriptions ORDER BY endpoint", [])).map((r) => `${r.user_id}|${r.endpoint}|${r.p256dh}`);
    // own row moves
    await savePushSubscription(db, "uA", { endpoint: OLD, p256dh: "old" }, 1);
    expect(await savePushSubscription(db, "uA", { endpoint: EP, p256dh: "new" }, 2, "repair", OLD)).toBe("ok");
    expect(await rows()).toEqual([`uA|${EP}|new`]);
    // another user's previous row is never touched
    await DB.exec("DELETE FROM push_subscriptions");
    await savePushSubscription(db, "uB", { endpoint: OLD, p256dh: "B" }, 1);
    expect(await savePushSubscription(db, "uA", { endpoint: EP, p256dh: "A" }, 2, "repair", OLD)).toBe("not_subscribed");
    expect(await rows()).toEqual([`uB|${OLD}|B`]);
    // an existing row at the new endpoint is never overwritten
    await DB.exec("DELETE FROM push_subscriptions");
    await savePushSubscription(db, "uA", { endpoint: OLD, p256dh: "A-old" }, 3);
    await savePushSubscription(db, "uB", { endpoint: EP, p256dh: "B-new" }, 4);
    expect(await savePushSubscription(db, "uA", { endpoint: EP, p256dh: "A" }, 5, "repair", OLD)).toBe("owned");
    expect(await rows()).toEqual([`uB|${EP}|B-new`, `uA|${OLD}|A-old`].sort());
  });
});
