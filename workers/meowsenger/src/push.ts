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

/** Hostnames (exact or dot-suffix) of the real browser push services. A stored
 *  endpoint is later POSTed to by the server, so anything outside this set is a
 *  potential SSRF target and is rejected at subscribe time. */
const PUSH_HOSTS = [
  "fcm.googleapis.com", // Chrome / Chromium (exact)
  ".push.services.mozilla.com", // Firefox
  ".push.apple.com", // Safari / iOS web push
  ".notify.windows.com", // Edge / Windows (WNS)
];

/** Chrome's current FCM web-push host: `pushManager.subscribe()` in Chromium now
 *  returns `https://jmt17.google.com/fcm/send/…` instead of fcm.googleapis.com.
 *  Matched by a full anchored pattern (jmt + digits), NOT a `.google.com` suffix, so
 *  arbitrary google.com hosts still can't be registered as POST targets. */
const PUSH_HOST_PATTERNS = [/^jmt\d+\.google\.com$/];

/**
 * Is `endpoint` a well-formed https URL on a known push-service host? Guards the
 * subscribe path so an authenticated user can't register an arbitrary URL that the
 * DO would then POST to on every message (blind SSRF / outbound amplifier). The
 * suffix check (`.push.apple.com`) can't be spoofed by `…push.apple.com.evil.com`
 * (that ends in `.evil.com`), and the exact FCM host avoids a bare-suffix bypass.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false; // no credentials in the URL
  if (url.port !== "") return false; // real push services use 443; no custom ports (SSRF to odd services)
  const host = url.hostname.toLowerCase();
  return (
    PUSH_HOSTS.some((h) => (h.startsWith(".") ? host.endsWith(h) : host === h)) ||
    PUSH_HOST_PATTERNS.some((re) => re.test(host))
  );
}

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
/** Import the VAPID signing key once, so a fan-out to many targets doesn't re-import
 *  it per target. Returns null when VAPID isn't configured / the JWK is unusable. */
export async function importVapidKey(env: Env): Promise<CryptoKey | null> {
  if (!env.VAPID_PRIVATE_JWK) return null;
  try {
    const jwk = JSON.parse(env.VAPID_PRIVATE_JWK) as JsonWebKey;
    return await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch {
    return null;
  }
}

async function vapidAuth(endpoint: string, env: Env, now: number, preKey?: CryptoKey | null): Promise<string | null> {
  const pub = env.VAPID_PUBLIC_KEY;
  const sub = env.VAPID_SUBJECT || "mailto:security@alxnko.dev";
  if (!env.VAPID_PRIVATE_JWK || !pub) return null;
  let origin: string;
  try { origin = new URL(endpoint).origin; } catch { return null; }
  const key = preKey ?? (await importVapidKey(env));
  if (!key) return null;
  const header = b64urlJson({ typ: "JWT", alg: "ES256" });
  const claims = b64urlJson({ aud: origin, exp: Math.floor(now / 1000) + 12 * 3600, sub });
  const signingInput = `${header}.${claims}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput));
  return `vapid t=${signingInput}.${b64url(sig)}, k=${pub}`;
}

/** Deliver one payloadless push. Returns the HTTP status (0 on a network error).
 *  201/2xx = delivered; 404/410 = the subscription is dead (caller should delete). */
export async function sendPush(endpoint: string, env: Env, now: number, fetchFn = fetch, key?: CryptoKey | null): Promise<number> {
  // Defense in depth: re-validate right before the request, whatever is in D1.
  if (!isAllowedPushEndpoint(endpoint)) return 0;
  const auth = await vapidAuth(endpoint, env, now, key);
  if (!auth) return 0;
  try {
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: { Authorization: auth, TTL: "2419200", "Content-Length": "0", Urgency: "normal" },
      redirect: "manual", // never follow a redirect off the allow-listed host
    });
    // A 3xx (or an opaque redirect) is a failure: it was not followed and nothing was delivered.
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) return 0;
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

/** Max push subscriptions kept per user (oldest evicted on insert). */
export const MAX_PUSH_SUBS_PER_USER = 10;

/** Coarse push-service family of an endpoint, for delivery logs. NEVER log the URL
 *  itself (it is a bearer capability for the user's device). */
export function pushHostFamily(endpoint: string): string {
  let host: string;
  try { host = new URL(endpoint).hostname.toLowerCase(); } catch { return "other"; }
  if (host === "fcm.googleapis.com") return "fcm";
  if (/^jmt\d+\.google\.com$/.test(host)) return "jmt";
  if (host.endsWith(".push.services.mozilla.com")) return "mozilla";
  if (host.endsWith(".push.apple.com")) return "apple";
  if (host.endsWith(".notify.windows.com")) return "wns";
  return "other";
}

export type SaveResult = "ok" | "owned" | "not_subscribed";

/** Register / refresh the caller's push subscription WITHOUT ever changing ownership.
 *  - mode "enable" (explicit user tap): insert, or refresh the keys of the caller's own
 *    row. An endpoint already owned by another account is left untouched → "owned".
 *  - mode "repair" (load-time sync): ONLY refreshes the keys of the caller's existing
 *    row; never inserts → "not_subscribed" when there is none, "owned" when another
 *    account holds it. A repair may carry `previousEndpoint` (rotation, see above).
 *  The ownership guard is in the SQL (`WHERE user_id = excluded.user_id`), so a race
 *  can't transfer a row; the follow-up read only classifies the outcome. Then the user
 *  is trimmed to the newest MAX_PUSH_SUBS_PER_USER rows. */
export async function savePushSubscription(
  db: DbClient, userId: string, sub: PushSub, now: number, mode: "enable" | "repair" = "enable",
  previousEndpoint?: string,
): Promise<SaveResult> {
  if (!sub.endpoint) return "not_subscribed";
  if (mode === "repair") {
    // Endpoint rotation: atomically MOVE the caller's OWN row from `previousEndpoint` to
    // the new endpoint. One statement, so it can't touch another user's row (user_id
    // guard), never inserts (needs the prior own row), and never overwrites an existing
    // row at the new endpoint (NOT EXISTS). Anything refused falls through to the plain
    // repair below, which classifies the outcome.
    if (previousEndpoint && previousEndpoint !== sub.endpoint) {
      await db.run(
        `UPDATE push_subscriptions SET endpoint = ?, p256dh = ?, auth = ?, created_at = ?
         WHERE endpoint = ? AND user_id = ?
           AND NOT EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = ?)`,
        [sub.endpoint, sub.p256dh ?? null, sub.auth ?? null, now, previousEndpoint, userId, sub.endpoint],
      );
    }
    await db.run(
      "UPDATE push_subscriptions SET p256dh = ?, auth = ?, created_at = ? WHERE endpoint = ? AND user_id = ?",
      [sub.p256dh ?? null, sub.auth ?? null, now, sub.endpoint, userId],
    );
  } else {
    await db.run(
      `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at
       WHERE push_subscriptions.user_id = excluded.user_id`,
      [sub.endpoint, userId, sub.p256dh ?? null, sub.auth ?? null, now],
    );
  }
  const row = await db.first("SELECT user_id FROM push_subscriptions WHERE endpoint = ?", [sub.endpoint]);
  if (!row) return "not_subscribed";
  if (String(row.user_id) !== userId) return "owned";
  await db.run(
    `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN (
       SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    [userId, userId, MAX_PUSH_SUBS_PER_USER],
  );
  return "ok";
}

/** Remove a subscription by endpoint (a dead 404/410 endpoint). When `userId` is
 *  given the delete is scoped to that owner (user unsubscribe: never touches another
 *  user's row). */
export async function deletePushSubscription(db: DbClient, endpoint: string, userId?: string): Promise<void> {
  if (userId === undefined) await db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
  else await db.run("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?", [endpoint, userId]);
}

/** Prune a dead (404/410) endpoint after a send that STARTED at `sentAt`. Scoped to the
 *  exact row the send targeted (endpoint AND the user it was sent for) and only if it was
 *  not (re)registered since the send began (`created_at < sentAt`): a fresh registration
 *  of the same endpoint made while the send was in flight must survive. */
export async function deleteDeadPushSubscription(db: DbClient, endpoint: string, userId: string, sentAt: number): Promise<void> {
  await db.run("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ? AND created_at < ?", [endpoint, userId, sentAt]);
}

/** All push endpoints to notify for a message in `chatId`, EXCLUDING the sender and
 *  anyone currently connected to the room (they get it live over the socket). One
 *  D1 read via a chat_members × push_subscriptions join; the excluded set (the room's
 *  live socket users) is typically tiny, so we filter in memory rather than a big
 *  NOT IN. Returns distinct endpoints with the owning user. */
export async function pushTargetsForChat(
  db: DbClient,
  chatId: string,
  excludeUserIds: string[],
): Promise<Array<{ endpoint: string; userId: string }>> {
  const excluded = new Set(excludeUserIds);
  const rows = await db.all(
    `SELECT ps.endpoint AS endpoint, ps.user_id AS user_id FROM push_subscriptions ps
     JOIN chat_members cm ON cm.user_id = ps.user_id
     WHERE cm.chat_id = ?`,
    [chatId],
  );
  const out = new Map<string, string>(); // endpoint → owner (endpoint is the primary key)
  for (const r of rows as Row[]) {
    if (excluded.has(String(r.user_id))) continue;
    out.set(String(r.endpoint), String(r.user_id));
  }
  return [...out].map(([endpoint, userId]) => ({ endpoint, userId }));
}
