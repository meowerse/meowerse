// Web Push client: register the service worker + (un)subscribe to VAPID push, and
// mirror the subscription to the server. Browser-glue over navigator.serviceWorker /
// PushManager / Notification; the pure key decode is unit-tested below-the-fold.
import { writeOptInIdb } from "./pushOptIn";

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

/** iPhone/iPad (incl. iPadOS desktop-UA). Chrome and Safari on iOS both use WebKit. */
export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1);
}

/** Running as an installed app (Home Screen / standalone display mode). */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  } catch { /* no matchMedia */ }
  return (navigator as unknown as { standalone?: boolean }).standalone === true;
}

/** Last push error code seen this page load (diagnostics only; never an endpoint/id). */
let lastPushError: string | null = null;
export function recordPushError(code: string | null): void { lastPushError = code; }

/** Privacy-safe one-line description of a non-PushError failure: the error `name`
 *  (e.g. AbortError) plus the browser's message only when it is short and generic (no URLs,
 *  so no endpoints/keys/ids). Capped at 120 characters. */
export function describePushFailure(e: unknown): string {
  const name = e && typeof (e as { name?: unknown }).name === "string" ? (e as { name: string }).name.trim() : "";
  const raw = e && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message.trim() : "";
  if (!name || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) return "unknown";
  const message = raw && raw.length <= 80 && !/:\/\/|https?|[A-Za-z0-9_-]{24,}|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(raw) ? raw : "";
  const out = message ? `${name} — ${message}` : name;
  return out.length > 120 ? out.slice(0, 119) + "…" : out;
}

export type PushDiagnostics = { permission: string; serviceWorker: boolean; subscription: boolean; lastError: string | null };

/** Privacy-safe state snapshot for the Settings "details" line: no endpoints, no ids. */
export async function pushDiagnostics(): Promise<PushDiagnostics> {
  const permission = pushPermission();
  let serviceWorker = false;
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    try { serviceWorker = !!(await navigator.serviceWorker.getRegistration())?.active; } catch { /* unavailable */ }
  }
  return { permission, serviceWorker, subscription: await pushSubscribed(), lastError: lastPushError };
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

/** Is this device's push subscription CONFIRMED for `userId` (the server stored it and
 *  the local marker names this account + endpoint)? A bare browser subscription is not
 *  enough: it may belong to another account or never have been registered. */
export async function pushConfirmedFor(userId: string): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    return !!sub && readSynced() === `${userId}|${sub.endpoint}`;
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
// `<userId>|<endpoint>`. It records "this account opted in on this browser". An ABSENT
// or foreign marker means ownership is UNKNOWN: sync then only ever asks the server to
// repair (never create) and drops the local subscription if that is refused.
const SYNC_KEY = "mw_push_synced";
// Endpoints whose server-side removal has not been confirmed yet: `<userId>|<endpoint>`
// entries, newline-separated, at most MAX_PENDING (oldest dropped). The local subscription
// is already gone by then; this lets the same account retry each one.
const PENDING_KEY = "mw_push_pending_unsub";
const MAX_PENDING = 5;
function readKey(k: string): string | null {
  try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; }
}
function writeKey(k: string, v: string | null): void {
  try {
    if (v === null) globalThis.localStorage?.removeItem(k);
    else globalThis.localStorage?.setItem(k, v);
  } catch { /* storage blocked — we just re-sync next time */ }
}
const readPending = (): string[] => (readKey(PENDING_KEY) ?? "").split("\n").filter(Boolean);
function writePending(list: string[]): void {
  writeKey(PENDING_KEY, list.length ? list.slice(-MAX_PENDING).join("\n") : null);
}
const endpointOf = (entry: string) => entry.slice(entry.indexOf("|") + 1);
const readSynced = () => readKey(SYNC_KEY);
const writeSynced = (v: string | null) => writeKey(SYNC_KEY, v);

/** Record which account opted in (id only) for the service worker — or clear it (null).
 *  The worker refuses to show previews unless the signed-in account matches this id, and
 *  purges the subscription when there is no id, so the id is written to the worker's
 *  IndexedDB store DIRECTLY and awaited (idempotent). The postMessage afterwards is only
 *  a notify/fallback (an old worker without a handler, or no IndexedDB, can lose it). */
async function setSwOptIn(userId: string | null): Promise<void> {
  await writeOptInIdb(userId);
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const target = reg?.active ?? navigator.serviceWorker.controller;
    target?.postMessage({ type: "mw-optin", userId });
  } catch { /* the worker also self-purges on an identity mismatch */ }
}

/** POST a subscription to the server. Returns null on success, else an error code.
 *  `mode` "enable" is an explicit user action; "repair" only refreshes an own row (and, with
 *  `previousEndpoint`, moves the caller's own row there after an endpoint rotation). */
async function postSubscription(base: string, sub: PushSubscription, mode: "enable" | "repair", previousEndpoint?: string): Promise<string | null> {
  const json = sub.toJSON();
  let res: Response;
  try {
    res = await fetch(`${base}/api/push/subscribe`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint, keys: json.keys, mode, ...(previousEndpoint ? { previous_endpoint: previousEndpoint } : {}) }),
    });
  } catch {
    return "network";
  }
  if (res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error || `http_${res.status}`;
}

/**
 * EXPLICIT user action only (the Settings toggle tap). Request permission (FIRST, while
 * the click's user activation is still live), register the SW, subscribe with the
 * server's VAPID key, and POST the subscription (mode "enable"). If the server says the
 * endpoint belongs to another account (409 endpoint_owned) the local subscription is
 * dropped and a FRESH one is requested once (a fresh endpoint is never owned).
 * Returns the resulting Notification permission: "granted" ONLY once the server has
 * stored the subscription, "denied"/"default" if the user declined, or "unsupported".
 * Throws PushError when a later step fails — dropping the local subscription so the UI
 * never shows "on" for a subscription the server doesn't have.
 */
export async function enablePush(base: string, userId?: string): Promise<string> {
  if (!pushSupported()) return "unsupported";
  // The opted-in account must be known: the marker + the SW's identity gate key off it.
  if (!userId) throw new PushError("unauthorized");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm;
  const owner = userId;
  await navigator.serviceWorker.register("/sw.js");
  const reg = await navigator.serviceWorker.ready;
  const keyRes = await fetch(`${base}/api/push/key`, { credentials: "include" });
  if (!keyRes.ok) throw new PushError("key");
  const { key } = (await keyRes.json()) as { key?: string };
  if (!key) return "unsupported";
  const subscribeFresh = () =>
    reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) as BufferSource });
  let sub = (await reg.pushManager.getSubscription()) ?? (await subscribeFresh());
  let err = await postSubscription(base, sub, "enable");
  if (err === "endpoint_owned") {
    // This browser still holds another account's subscription: discard it, get our own.
    writeSynced(null);
    await sub.unsubscribe().catch(() => {});
    sub = await subscribeFresh();
    err = await postSubscription(base, sub, "enable");
  }
  if (err) {
    writeSynced(null);
    await sub.unsubscribe().catch(() => {});
    await setSwOptIn(null);
    throw new PushError(err);
  }
  writeSynced(`${owner}|${sub.endpoint}`);
  // An explicit re-enable supersedes any unconfirmed removal of this very endpoint.
  writePending(readPending().filter((e) => endpointOf(e) !== sub.endpoint));
  await setSwOptIn(owner);
  return "granted";
}

/** Owner recorded in the marker ("" when unknown/malformed). */
function markerUser(marker: string): string {
  const i = marker.indexOf("|");
  return i < 0 ? "" : marker.slice(0, i);
}

/** Drop this browser's local push subscription + the marker + the SW's opt-in. No server call. */
export async function clearLocalPush(): Promise<void> {
  writeSynced(null);
  if (!pushSupported()) return;
  await setSwOptIn(null);
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) await sub.unsubscribe().catch(() => {});
  } catch { /* nothing to drop */ }
}

/** Best-effort scoped server removal; true when the server confirmed. */
async function serverUnsubscribe(base: string, endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/push/unsubscribe`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    return res.ok;
  } catch { return false; }
}

/**
 * Self-heal on app load. NEVER creates a server registration: it only asks the server
 * to repair (mode "repair": refresh the keys of an existing row owned by this account)
 * and returns true when that succeeded. Consent integrity: browser permission is not
 * Meowsenger opt-in, and a missing/foreign marker means ownership is unknown.
 *  - marker for ANOTHER account → drop the local subscription (+ marker + SW opt-in).
 *  - no marker / own marker → repair; 404 not_subscribed, 409 endpoint_owned or any
 *    permanent refusal → drop the local subscription so the toggle shows the truth
 *    (the user re-enables by tapping). Transient failures keep it for the next load.
 * Also retries a pending (unconfirmed) server removal left by an interrupted logout.
 */
export async function syncPushSubscription(base: string, userId: string): Promise<boolean> {
  const pendingAll = readPending();
  if (pendingAll.length) {
    // Retry this account's removals; another account's entry is not ours to send (the dead
    // endpoint is pruned server-side on its next 404/410).
    const still: string[] = [];
    for (const entry of pendingAll) {
      if (markerUser(entry) !== userId) continue;
      if (!(await serverUnsubscribe(base, endpointOf(entry)))) still.push(entry);
    }
    writePending(still);
  }
  if (!pushSupported() || Notification.permission !== "granted") return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!sub) return false;
    const marker = `${userId}|${sub.endpoint}`;
    const current = readSynced();
    const drop = async () => {
      writeSynced(null);
      await setSwOptIn(null);
      await sub.unsubscribe().catch(() => {});
    };
    // A removal of THIS endpoint was requested (disable/logout) but not confirmed: the
    // subscription is a revived leftover. Never repair it back to life — drop it locally
    // (the removal retry above already ran / stays pending).
    if (pendingAll.some((entry) => endpointOf(entry) === sub.endpoint)) {
      await drop();
      return false;
    }
    if (current === marker) {
      // Already confirmed: only re-assert the worker's opt-in id (cheap, idempotent).
      await setSwOptIn(userId);
      return false;
    }
    if (current !== null && markerUser(current) !== userId) {
      await drop(); // another account's (or an unknown owner's) subscription on this browser
      return false;
    }
    // Same account, different endpoint → the browser rotated it: ask the server to move our row.
    const previous = current !== null && endpointOf(current) !== sub.endpoint ? endpointOf(current) : undefined;
    const err = await postSubscription(base, sub, "repair", previous);
    if (err) {
      if (err === "not_subscribed" || err === "endpoint_owned" || permanentError(err)) await drop();
      return false;
    }
    writeSynced(marker);
    await setSwOptIn(userId);
    return true;
  } catch {
    return false;
  }
}

/** Is `code` (from postSubscription) a permanent refusal retrying can't fix? */
function permanentError(code: string): boolean {
  if (code === "bad_endpoint" || code === "bad_body") return true;
  const m = /^http_(4\d\d)$/.exec(code);
  return !!m && !["401", "408", "429"].includes(m[1]);
}

/**
 * Opt out / logout. Order matters: the LOCAL side goes first — marker cleared, the
 * service worker's opted-in id cleared, the browser subscription unsubscribed — so a
 * stalled or failed network call can never leave a live local subscription. Only then
 * the server removal (scoped to the signed-in account) is attempted; if it isn't
 * confirmed it is remembered and retried when the same account next loads (and the dead
 * endpoint is pruned server-side on the next 404/410 anyway).
 */
export async function disablePush(base: string, userId?: string): Promise<void> {
  const marker = readSynced();
  writeSynced(null);
  if (!pushSupported()) return;
  // Drop the browser subscription FIRST, so a slow IndexedDB write can never keep it alive
  // past the logout time box; then clear the service worker's opted-in account.
  let endpoint: string | null = null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      endpoint = sub.endpoint;
      await sub.unsubscribe().catch(() => {});
    }
  } catch { /* nothing to drop */ }
  await setSwOptIn(null);
  if (!endpoint) return;
  const owner = userId || (marker ? markerUser(marker) : "");
  const entry = `${owner}|${endpoint}`;
  // Append (never overwrite an earlier unconfirmed removal), then try this one.
  writePending([...readPending().filter((e) => e !== entry), entry]);
  if (await serverUnsubscribe(base, endpoint)) writePending(readPending().filter((e) => e !== entry));
}
