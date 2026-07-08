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

/**
 * Register the SW, request permission, subscribe with the server's VAPID key, and
 * POST the subscription. Returns the resulting Notification permission: "granted" on
 * success, "denied"/"default" if the user declined, or "unsupported".
 */
export async function enablePush(base: string): Promise<string> {
  if (!pushSupported()) return "unsupported";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm;
  await navigator.serviceWorker.register("/sw.js");
  const reg = await navigator.serviceWorker.ready;
  const keyRes = await fetch(`${base}/api/push/key`, { credentials: "include" });
  const { key } = (await keyRes.json()) as { key?: string };
  if (!key) return "unsupported";
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) as BufferSource }));
  const json = sub.toJSON();
  await fetch(`${base}/api/push/subscribe`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint, keys: json.keys }),
  });
  return "granted";
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
}
