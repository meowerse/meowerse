// Web Push client: register the service worker + (un)subscribe to VAPID push, and
// mirror the subscription to the server. Browser-glue over navigator.serviceWorker /
// PushManager / Notification; the pure key decode is unit-tested below-the-fold.

/** True when this browser can do Web Push (SW + PushManager + Notification). */
export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Current Notification permission, or "unsupported" when Web Push isn't available. */
export function pushPermission(): string {
  return pushSupported() ? Notification.permission : "unsupported";
}

/** Decode a base64url VAPID public key to the Uint8Array applicationServerKey wants. */
export function urlBase64ToUint8Array(b64: string): Uint8Array {
  const padding = "=".repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Is there an active push subscription right now? */
export async function pushSubscribed(): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return false;
    return !!(await reg.pushManager.getSubscription());
  } catch {
    return false;
  }
}

/** A push step failed after permission was granted (key fetch, subscribe, or the
 *  server refusing the subscription). `code` is the server's error code when known. */
export class PushError extends Error {
  constructor(public readonly code: string) {
    super(`push_${code}`);
    this.name = "PushError";
  }
}

// localStorage marker of the last subscription the SERVER confirmed, as
// `<userId>|<endpoint>`. Lets syncPushSubscription re-send a subscription the server
// never stored (or one bound to another account on this browser) without writing to
// D1 on every page load.
const SYNC_KEY = "mw_push_synced";
function readSynced(): string | null {
  try { return globalThis.localStorage?.getItem(SYNC_KEY) ?? null; } catch { return null; }
}
function writeSynced(v: string | null): void {
  try {
    if (v === null) globalThis.localStorage?.removeItem(SYNC_KEY);
    else globalThis.localStorage?.setItem(SYNC_KEY, v);
  } catch { /* storage blocked — we just re-sync next time */ }
}

/** POST a subscription to the server. Returns null on success, else an error code. */
async function postSubscription(base: string, sub: PushSubscription): Promise<string | null> {
  const json = sub.toJSON();
  let res: Response;
  try {
    res = await fetch(`${base}/api/push/subscribe`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint, keys: json.keys }),
    });
  } catch {
    return "network";
  }
  if (res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error || `http_${res.status}`;
}

/**
 * Request permission (FIRST, while the click's user activation is still live),
 * register the SW, subscribe with the server's VAPID key, and POST the subscription.
 * Returns the resulting Notification permission: "granted" ONLY once the server has
 * stored the subscription, "denied"/"default" if the user declined, or "unsupported".
 * Throws PushError when a later step fails — and in that case drops the local
 * subscription so the UI never shows "on" for a subscription the server doesn't have.
 */
export async function enablePush(base: string, userId?: string): Promise<string> {
  if (!pushSupported()) return "unsupported";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm;
  await navigator.serviceWorker.register("/sw.js");
  const reg = await navigator.serviceWorker.ready;
  const keyRes = await fetch(`${base}/api/push/key`, { credentials: "include" });
  if (!keyRes.ok) throw new PushError("key");
  const { key } = (await keyRes.json()) as { key?: string };
  if (!key) return "unsupported";
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) as BufferSource }));
  const err = await postSubscription(base, sub);
  if (err) {
    writeSynced(null);
    await sub.unsubscribe().catch(() => {});
    throw new PushError(err);
  }
  // Never record an unknown owner: sync settles the marker once the user is known.
  writeSynced(userId ? `${userId}|${sub.endpoint}` : null);
  return "granted";
}

/** Owner recorded in the marker ("" when unknown/malformed). */
function markerUser(marker: string): string {
  const i = marker.indexOf("|");
  return i < 0 ? "" : marker.slice(0, i);
}

/** Is `code` (from postSubscription) a permanent refusal retrying can't fix? */
function permanentError(code: string): boolean {
  if (code === "bad_endpoint" || code === "bad_body") return true;
  const m = /^http_(4\d\d)$/.exec(code);
  return !!m && !["401", "408", "429"].includes(m[1]);
}

/** Drop this browser's local push subscription + the marker. No server call. */
export async function clearLocalPush(): Promise<void> {
  writeSynced(null);
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) await sub.unsubscribe().catch(() => {});
  } catch { /* nothing to drop */ }
}

/**
 * Self-heal on app load: if permission is granted and this browser holds a push
 * subscription the server hasn't confirmed for `userId`, (re)send it. Covers a
 * subscription created while the server was rejecting it and a rotated endpoint.
 * Never prompts; one D1 write per new (user, endpoint) pair. Returns true when a
 * sync POST succeeded.
 *
 * Privacy: a subscription last confirmed for a DIFFERENT (or unknown/empty) owner is
 * never re-sent for the current user — the server upsert would rebind the device to
 * them without consent. It is dropped locally instead; the new user opts in by hand.
 * A permanent server refusal also drops it, so Settings shows the truth.
 */
export async function syncPushSubscription(base: string, userId: string): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!sub) return false;
    const marker = `${userId}|${sub.endpoint}`;
    const current = readSynced();
    if (current === marker) return false;
    if (current !== null && markerUser(current) !== userId) {
      // Another account's (or an unknown owner's) subscription on this browser.
      writeSynced(null);
      await sub.unsubscribe().catch(() => {});
      await fetch(`${base}/api/push/unsubscribe`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      return false;
    }
    const err = await postSubscription(base, sub);
    if (err) {
      if (permanentError(err)) {
        writeSynced(null);
        await sub.unsubscribe().catch(() => {});
      }
      return false;
    }
    writeSynced(marker);
    return true;
  } catch {
    return false;
  }
}

/** Unsubscribe locally + tell the server to drop the endpoint. */
export async function disablePush(base: string): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return;
  await fetch(`${base}/api/push/unsubscribe`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
  writeSynced(null);
}
