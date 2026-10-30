import { describe, it, expect, beforeAll } from "vitest";
import { sendPush, savePushSubscription, deletePushSubscription, pushTargetsForChat, isAllowedPushEndpoint, pushHostFamily, MAX_PUSH_SUBS_PER_USER } from "./push";
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
  const subs: Array<{ endpoint: string; user_id: string; p256dh: unknown; auth: unknown; created_at?: number }> = [];
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
        const [endpoint, user_id, p256dh, auth, created_at] = p as [string, string, unknown, unknown, number];
        const i = subs.findIndex((s) => s.endpoint === endpoint);
        if (i >= 0) subs[i] = { endpoint, user_id, p256dh, auth, created_at };
        else subs.push({ endpoint, user_id, p256dh, auth, created_at });
      } else if (sql.includes("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?")) {
        const i = subs.findIndex((s) => s.endpoint === p[0] && s.user_id === p[1]);
        if (i >= 0) subs.splice(i, 1);
      } else if (sql.includes("DELETE FROM push_subscriptions WHERE endpoint")) {
        const i = subs.findIndex((s) => s.endpoint === p[0]);
        if (i >= 0) subs.splice(i, 1);
      } else if (sql.includes("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN")) {
        // Keep the newest `limit` rows (created_at DESC, insertion order DESC) of that user.
        const [uid, , limit] = p as [string, string, number];
        const mine = subs.map((s, idx) => ({ s, idx })).filter((x) => x.s.user_id === uid)
          .sort((a, b) => (b.s.created_at ?? 0) - (a.s.created_at ?? 0) || b.idx - a.idx);
        const drop = new Set(mine.slice(limit).map((x) => x.s.endpoint));
        for (let i = subs.length - 1; i >= 0; i--) if (drop.has(subs[i].endpoint)) subs.splice(i, 1);
      }
    },
  };
  return { db, subs, members };
}

describe("isAllowedPushEndpoint", () => {
  it("accepts the known https push-service hosts", () => {
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/xxx")).toBe(true);
    expect(isAllowedPushEndpoint("https://web.push.apple.com/xyz")).toBe(true);
    expect(isAllowedPushEndpoint("https://ab1.notify.windows.com/w/?token=t")).toBe(true);
  });
  it("accepts Chrome's current FCM host (jmt17.google.com) — the endpoint real Chromium returns", () => {
    // Observed 2026-10-30 from pushManager.subscribe() in Chromium 1248 with the prod
    // VAPID key. Rejecting it is why prod push_subscriptions stayed empty.
    expect(isAllowedPushEndpoint("https://jmt17.google.com/fcm/send/er6x8jtPf4c:APA91bH")).toBe(true);
    expect(isAllowedPushEndpoint("https://jmt0.google.com/fcm/send/x")).toBe(true);
  });
  it("rejects an explicit port (SSRF to odd services on a push host)", () => {
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com:8443/fcm/send/abc")).toBe(false);
    expect(isAllowedPushEndpoint("https://jmt17.google.com:4444/fcm/send/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://web.push.apple.com:8080/x")).toBe(false);
  });
  it("rejects other hosts, http, suffix-spoofs, and junk (SSRF guard)", () => {
    expect(isAllowedPushEndpoint("https://attacker.example/internal")).toBe(false);
    expect(isAllowedPushEndpoint("http://fcm.googleapis.com/fcm/send/abc")).toBe(false); // not https
    expect(isAllowedPushEndpoint("https://web.push.apple.com.evil.com/x")).toBe(false); // suffix spoof
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com.evil.com/x")).toBe(false); // exact-host spoof
    expect(isAllowedPushEndpoint("https://jmt17.google.com.evil.com/fcm/send/x")).toBe(false); // jmt suffix spoof
    expect(isAllowedPushEndpoint("https://evil.jmt17.google.com/fcm/send/x")).toBe(false); // jmt prefix spoof
    expect(isAllowedPushEndpoint("https://jmtx.google.com/fcm/send/x")).toBe(false); // not jmt<digits>
    expect(isAllowedPushEndpoint("https://accounts.google.com/x")).toBe(false); // not every google.com host
    expect(isAllowedPushEndpoint("not a url")).toBe(false);
    expect(isAllowedPushEndpoint("")).toBe(false);
  });
});

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

describe("push subscription cap + scoped delete", () => {
  it("keeps at most MAX_PUSH_SUBS_PER_USER rows per user, evicting the oldest", async () => {
    const { db, subs } = pushDb();
    await savePushSubscription(db, "other", { endpoint: "o1" }, 1);
    for (let i = 1; i <= MAX_PUSH_SUBS_PER_USER + 3; i++) await savePushSubscription(db, "u1", { endpoint: `e${i}` }, 100 + i);
    const mine = subs.filter((s) => s.user_id === "u1").map((s) => s.endpoint).sort();
    expect(mine).toHaveLength(MAX_PUSH_SUBS_PER_USER);
    expect(mine).not.toContain("e1");
    expect(mine).not.toContain("e3");
    expect(mine).toContain("e13");
    expect(subs.some((s) => s.endpoint === "o1")).toBe(true); // other users untouched
  });
  it("deletePushSubscription with a userId only deletes that user's row", async () => {
    const { db, subs } = pushDb();
    await savePushSubscription(db, "u1", { endpoint: "e1" }, 1);
    await deletePushSubscription(db, "e1", "u2"); // not the owner
    expect(subs).toHaveLength(1);
    await deletePushSubscription(db, "e1", "u1");
    expect(subs).toHaveLength(0);
  });
});

describe("pushHostFamily (log-safe host classification)", () => {
  it("maps endpoints to a coarse family and never echoes the URL", () => {
    expect(pushHostFamily("https://fcm.googleapis.com/fcm/send/secret")).toBe("fcm");
    expect(pushHostFamily("https://jmt17.google.com/fcm/send/secret")).toBe("jmt");
    expect(pushHostFamily("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe("mozilla");
    expect(pushHostFamily("https://web.push.apple.com/x")).toBe("apple");
    expect(pushHostFamily("https://ab1.notify.windows.com/w")).toBe("wns");
    expect(pushHostFamily("https://elsewhere.example/x")).toBe("other");
    expect(pushHostFamily("garbage")).toBe("other");
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
