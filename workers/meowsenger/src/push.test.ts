import { describe, it, expect, beforeAll } from "vitest";
import { sendPush, savePushSubscription, deletePushSubscription, pushTargetsForChat } from "./push";
import type { DbClient, Env, Row } from "./types";

let env: Env;

beforeAll(async () => {
  // A real P-256 keypair so vapidAuth can import + sign (Node's Web Crypto).
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const b64url = (u8: Uint8Array) => Buffer.from(u8).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  env = {
    VAPID_PUBLIC_KEY: b64url(pubRaw),
    VAPID_PRIVATE_JWK: JSON.stringify(priv),
    VAPID_SUBJECT: "mailto:x@y.z",
  } as Env;
});

function pushDb() {
  const subs: Array<{ endpoint: string; user_id: string; p256dh: unknown; auth: unknown }> = [];
  const members: Array<{ chat_id: string; user_id: string }> = [];
  const db: DbClient = {
    async all(sql, p = []) {
      if (sql.includes("FROM push_subscriptions ps")) {
        return subs
          .filter((s) => members.some((m) => m.chat_id === p[0] && m.user_id === s.user_id))
          .map((s) => ({ endpoint: s.endpoint, user_id: s.user_id })) as Row[];
      }
      return [];
    },
    async first() { return undefined; },
    async run(sql, p = []) {
      if (sql.includes("INSERT INTO push_subscriptions")) {
        const [endpoint, user_id, p256dh, auth] = p as [string, string, unknown, unknown];
        const i = subs.findIndex((s) => s.endpoint === endpoint);
        if (i >= 0) subs[i] = { endpoint, user_id, p256dh, auth };
        else subs.push({ endpoint, user_id, p256dh, auth });
      } else if (sql.includes("DELETE FROM push_subscriptions WHERE endpoint")) {
        const i = subs.findIndex((s) => s.endpoint === p[0]);
        if (i >= 0) subs.splice(i, 1);
      }
    },
  };
  return { db, subs, members };
}

describe("sendPush", () => {
  it("POSTs a VAPID Authorization header + payloadless body and returns the status", async () => {
    let seen: { url: unknown; init: RequestInit } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => { seen = { url, init }; return { status: 201 } as Response; }) as unknown as typeof fetch;
    const status = await sendPush("https://push.example/abc", env, Date.now(), fetchFn);
    expect(status).toBe(201);
    expect(seen?.url).toBe("https://push.example/abc");
    expect(seen?.init.method).toBe("POST");
    const h = seen?.init.headers as Record<string, string>;
    expect(h.Authorization).toMatch(/^vapid t=[^.]+\.[^.]+\.[^.]+, k=.+/); // header.claims.sig, k=<pub>
    expect(h["Content-Length"]).toBe("0");
  });
  it("returns 0 when VAPID isn't configured", async () => {
    const status = await sendPush("https://push.example/abc", {} as Env, Date.now(), (async () => ({ status: 201 }) as Response) as unknown as typeof fetch);
    expect(status).toBe(0);
  });
  it("returns 0 for a malformed endpoint", async () => {
    expect(await sendPush("not-a-url", env, Date.now(), (async () => ({ status: 201 }) as Response) as unknown as typeof fetch)).toBe(0);
  });
  it("returns 0 on a network error", async () => {
    expect(await sendPush("https://push.example/abc", env, Date.now(), (async () => { throw new Error("net"); }) as unknown as typeof fetch)).toBe(0);
  });
});

describe("savePushSubscription / deletePushSubscription", () => {
  it("upserts by endpoint, then deletes", async () => {
    const { db, subs } = pushDb();
    await savePushSubscription(db, "u1", { endpoint: "e1", p256dh: "k", auth: "a" }, 1);
    expect(subs).toHaveLength(1);
    await savePushSubscription(db, "u2", { endpoint: "e1" }, 2); // same endpoint → update user
    expect(subs).toHaveLength(1);
    expect(subs[0].user_id).toBe("u2");
    await deletePushSubscription(db, "e1");
    expect(subs).toHaveLength(0);
  });
  it("ignores an empty endpoint", async () => {
    const { db, subs } = pushDb();
    await savePushSubscription(db, "u1", { endpoint: "" }, 1);
    expect(subs).toHaveLength(0);
  });
});

describe("pushTargetsForChat", () => {
  it("returns endpoints of chat members, excluding the given user ids", async () => {
    const { db, subs, members } = pushDb();
    members.push({ chat_id: "c1", user_id: "u1" }, { chat_id: "c1", user_id: "u2" }, { chat_id: "c1", user_id: "u3" });
    subs.push(
      { endpoint: "e1", user_id: "u1", p256dh: null, auth: null },
      { endpoint: "e2", user_id: "u2", p256dh: null, auth: null },
      { endpoint: "e3", user_id: "u3", p256dh: null, auth: null },
    );
    // Exclude the sender (u1) + a connected user (u2) → only u3's endpoint.
    expect(await pushTargetsForChat(db, "c1", ["u1", "u2"])).toEqual(["e3"]);
    // No exclusions → all three.
    expect((await pushTargetsForChat(db, "c1", [])).sort()).toEqual(["e1", "e2", "e3"]);
  });
});
