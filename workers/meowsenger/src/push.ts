// Web Push (VAPID) — payloadless "tickle" notifications to offline recipients.
//
// We send NO encrypted payload (avoids the fragile aes128gcm path): the push just
// wakes the recipient's service worker, which — if no app tab is focused — fetches
// /api/chats itself and shows a real notification. So here we only need the VAPID
// JWT auth (ES256), not message encryption.
//
// Keys: VAPID_PUBLIC_KEY (a var — the b64url uncompressed P-256 point, also handed
// to the browser as applicationServerKey) + VAPID_PRIVATE_JWK (a secret — the P-256
// private key as JWK) + VAPID_SUBJECT (a mailto:/https contact, required by the spec).

import type { DbClient, Env, Row } from "./types";

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJson(obj: unknown): string {
  return b64url(enc.encode(JSON.stringify(obj)));
}

/** Build the VAPID Authorization header value for a push endpoint (unified draft
 *  form: `vapid t=<jwt>, k=<publicKey>`). The JWT's `aud` is the endpoint origin. */
async function vapidAuth(endpoint: string, env: Env, now: number): Promise<string | null> {
  const jwkStr = env.VAPID_PRIVATE_JWK;
  const pub = env.VAPID_PUBLIC_KEY;
  const sub = env.VAPID_SUBJECT || "mailto:admin@alxnko.eu.org";
  if (!jwkStr || !pub) return null;
  let origin: string;
  try { origin = new URL(endpoint).origin; } catch { return null; }
  const jwk = JSON.parse(jwkStr) as JsonWebKey;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = b64urlJson({ typ: "JWT", alg: "ES256" });
  const claims = b64urlJson({ aud: origin, exp: Math.floor(now / 1000) + 12 * 3600, sub });
  const signingInput = `${header}.${claims}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput));
  return `vapid t=${signingInput}.${b64url(sig)}, k=${pub}`;
}

/** Deliver one payloadless push. Returns the HTTP status (0 on a network error).
 *  201/2xx = delivered; 404/410 = the subscription is dead (caller should delete). */
export async function sendPush(endpoint: string, env: Env, now: number, fetchFn = fetch): Promise<number> {
  const auth = await vapidAuth(endpoint, env, now);
  if (!auth) return 0;
  try {
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: { Authorization: auth, TTL: "2419200", "Content-Length": "0", Urgency: "normal" },
    });
    return res.status;
  } catch {
    return 0;
  }
}

// ---- D1 storage (push_subscriptions) --------------------------------------------

/** A browser PushSubscription as sent by the client (keys kept for future payloads). */
export interface PushSub {
  endpoint: string;
  p256dh?: string | null;
  auth?: string | null;
}

/** Upsert (by endpoint) the caller's push subscription. */
export async function savePushSubscription(db: DbClient, userId: string, sub: PushSub, now: number): Promise<void> {
  if (!sub.endpoint) return;
  await db.run(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    [sub.endpoint, userId, sub.p256dh ?? null, sub.auth ?? null, now],
  );
}

/** Remove a subscription by endpoint (unsubscribe, or a dead 404/410 endpoint). */
export async function deletePushSubscription(db: DbClient, endpoint: string): Promise<void> {
  await db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
}

/** All push endpoints to notify for a message in `chatId`, EXCLUDING the sender and
 *  anyone currently connected to the room (they get it live over the socket). One
 *  D1 read via a chat_members × push_subscriptions join; the excluded set (the room's
 *  live socket users) is typically tiny, so we filter in memory rather than a big
 *  NOT IN. Returns distinct endpoints. */
export async function pushTargetsForChat(
  db: DbClient,
  chatId: string,
  excludeUserIds: string[],
): Promise<string[]> {
  const excluded = new Set(excludeUserIds);
  const rows = await db.all(
    `SELECT ps.endpoint AS endpoint, ps.user_id AS user_id FROM push_subscriptions ps
     JOIN chat_members cm ON cm.user_id = ps.user_id
     WHERE cm.chat_id = ?`,
    [chatId],
  );
  const out = new Set<string>();
  for (const r of rows as Row[]) {
    if (excluded.has(String(r.user_id))) continue;
    out.add(String(r.endpoint));
  }
  return [...out];
}
