import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { pushSupported, pushPermission, pushSubscribed, enablePush, disablePush, urlBase64ToUint8Array, syncPushSubscription, clearLocalPush, PushError, describePushFailure } from "./push";

/** A fresh in-memory localStorage per test (the unit env is plain Node). */
function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}
beforeEach(() => vi.stubGlobal("localStorage", memStorage()));

/** Minimal IndexedDB double: databases keyed by name, each store a Map. Enough for the
 *  page writer (src/lib/pushOptIn.ts) AND the worker's real makeIdbStore (public/sw-core.js). */
function fakeIdb(o: { failTx?: boolean } = {}) {
  const dbs = new Map<string, Map<string, Map<string, unknown>>>();
  const opens: string[] = [];
  const idb = {
    open(name: string, _v: number) {
      opens.push(name);
      const r: Record<string, unknown> = {};
      setTimeout(() => {
        const created = !dbs.has(name);
        if (created) dbs.set(name, new Map());
        const stores = dbs.get(name)!;
        r.result = {
          createObjectStore: (s: string) => stores.set(s, new Map()),
          close: () => {},
          transaction: (s: string) => {
            const t: Record<string, unknown> = {};
            const st = stores.get(s);
            if (!st) throw new Error("NotFoundError");
            t.objectStore = () => ({
              put: (v: unknown, k: string) => { st.set(k, v); return {}; },
              delete: (k: string) => { st.delete(k); return {}; },
              get: (k: string) => { const q: Record<string, unknown> = {}; q.result = st.get(k); return q; },
            });
            setTimeout(() => { if (o.failTx) (t.onerror as () => void)?.(); else (t.oncomplete as () => void)?.(); }, 0);
            return t;
          },
        };
        if (created) (r.onupgradeneeded as () => void)?.();
        (r.onsuccess as () => void)?.();
      }, 0);
      return r;
    },
  };
  return { idb, dbs, opens, value: () => dbs.get("mw-push")?.get("kv")?.get("optedInUser") ?? null };
}
// public/sw-core.js is the reader of that store; load its real IDB store implementation.
const swSandbox: { self: Record<string, unknown> } = { self: {} };
runInNewContext(readFileSync(new URL("../../public/sw-core.js", import.meta.url), "utf8"), swSandbox);
const swCore = swSandbox.self.mwPushCore as { makeIdbStore(idb: unknown): { get(): Promise<string | null>; set(i: string): Promise<unknown>; clear(): Promise<unknown> } };
afterEach(() => vi.unstubAllGlobals());
const BASE = "https://x";

/** Messages posted to the service worker (opt-in set/clear) by the code under test. */
const swMessages: unknown[] = [];

/** Stub navigator.serviceWorker / window / Notification / fetch for a supported browser. */
function stubEnv(o: {
  permission?: string;
  requestPermission?: () => Promise<string>;
  subscription?: unknown;
  getRegistration?: () => Promise<unknown>;
  fetch?: unknown;
} = {}) {
  const Notification = { permission: o.permission ?? "default", requestPermission: o.requestPermission ?? (async () => o.permission ?? "granted") };
  const defaultSub = {
    endpoint: "https://push/e1",
    toJSON: () => ({ endpoint: "https://push/e1", keys: { p256dh: "k", auth: "a" } }),
    unsubscribe: async () => true,
  };
  swMessages.length = 0;
  const reg = {
    active: { postMessage: (m: unknown) => void swMessages.push(m) },
    pushManager: {
      getSubscription: async () => o.subscription ?? null,
      subscribe: async () => o.subscription ?? defaultSub,
    },
  };
  const navigator = {
    serviceWorker: {
      register: async () => reg,
      ready: Promise.resolve(reg),
      getRegistration: o.getRegistration ?? (async () => reg),
    },
  };
  vi.stubGlobal("navigator", navigator);
  vi.stubGlobal("window", { PushManager: function () {}, Notification });
  vi.stubGlobal("Notification", Notification);
  if (o.fetch) vi.stubGlobal("fetch", o.fetch);
}

describe("urlBase64ToUint8Array", () => {
  it("decodes base64url (padding-tolerant) to bytes", () => {
    expect(Array.from(urlBase64ToUint8Array("AQID"))).toEqual([1, 2, 3]); // "AQID" → [1,2,3]
  });
});

describe("pushSupported / pushPermission", () => {
  it("false + 'unsupported' when the APIs are missing", () => {
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("window", undefined);
    expect(pushSupported()).toBe(false);
    expect(pushPermission()).toBe("unsupported");
  });
  it("true + Notification.permission when supported", () => {
    stubEnv({ permission: "granted" });
    expect(pushSupported()).toBe(true);
    expect(pushPermission()).toBe("granted");
  });
});

describe("pushSubscribed", () => {
  it("false when unsupported", async () => {
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("window", undefined);
    expect(await pushSubscribed()).toBe(false);
  });
  it("true when a subscription exists", async () => {
    stubEnv({ subscription: { endpoint: "e" } });
    expect(await pushSubscribed()).toBe(true);
  });
  it("false when there's no registration", async () => {
    stubEnv({ getRegistration: async () => null });
    expect(await pushSubscribed()).toBe(false);
  });
});

describe("enablePush", () => {
  it("'unsupported' when the browser can't", async () => {
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("window", undefined);
    expect(await enablePush(BASE, "u1")).toBe("unsupported");
  });
  it("returns the permission when the user declines", async () => {
    stubEnv({ permission: "default", requestPermission: async () => "denied" });
    expect(await enablePush(BASE, "u1")).toBe("denied");
  });
  it("subscribes + POSTs the subscription on grant", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith("/api/push/key")) return new Response(JSON.stringify({ key: "AQID" }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    stubEnv({ permission: "granted", requestPermission: async () => "granted", subscription: null, fetch: fetchMock });
    expect(await enablePush(BASE, "u1")).toBe("granted");
    expect(calls.some((u) => u.endsWith("/api/push/subscribe"))).toBe(true);
  });
  it("'unsupported' when the server has no VAPID key", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ key: "" }), { status: 200 }));
    stubEnv({ permission: "granted", requestPermission: async () => "granted", subscription: null, fetch: fetchMock });
    expect(await enablePush(BASE, "u1")).toBe("unsupported");
  });
});

describe("enablePush — failures are never silent", () => {
  /** fetch mock: VAPID key OK, subscribe answers with `status` + `{error}`. */
  function serverSaying(status: number, error?: string) {
    return vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/push/key")) return new Response(JSON.stringify({ key: "AQID" }), { status: 200 });
      return new Response(JSON.stringify(error ? { error } : { ok: true }), { status });
    });
  }
  it("throws PushError(bad_endpoint) + drops the local subscription when the server rejects it", async () => {
    // The prod bug: the server 400'd Chrome's jmt17.google.com endpoint, the client
    // ignored the status, returned "granted" and the toggle showed "on" — 0 rows stored.
    let unsubscribed = false;
    const sub = {
      endpoint: "https://jmt17.google.com/fcm/send/x",
      toJSON: () => ({ endpoint: "https://jmt17.google.com/fcm/send/x", keys: { p256dh: "k", auth: "a" } }),
      unsubscribe: async () => { unsubscribed = true; return true; },
    };
    stubEnv({ permission: "granted", subscription: sub, fetch: serverSaying(400, "bad_endpoint") });
    const err = await enablePush(BASE, "u1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PushError);
    expect((err as PushError).code).toBe("bad_endpoint");
    expect(unsubscribed).toBe(true);
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
  });
  it("throws PushError(unauthorized) on a 401", async () => {
    stubEnv({ permission: "granted", fetch: serverSaying(401, "unauthorized") });
    await expect(enablePush(BASE, "u1")).rejects.toMatchObject({ code: "unauthorized" });
  });
  it("throws PushError(http_<status>) when the error body isn't JSON", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("/api/push/key") ? new Response(JSON.stringify({ key: "AQID" })) : new Response("nope", { status: 502 }));
    stubEnv({ permission: "granted", fetch: fetchMock });
    await expect(enablePush(BASE, "u1")).rejects.toMatchObject({ code: "http_502" });
  });
  it("throws PushError(network) when the subscribe POST can't reach the server", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/push/key")) return new Response(JSON.stringify({ key: "AQID" }));
      throw new TypeError("offline");
    });
    stubEnv({ permission: "granted", fetch: fetchMock });
    await expect(enablePush(BASE, "u1")).rejects.toMatchObject({ code: "network" });
  });
  it("throws PushError(key) when the VAPID key fetch fails", async () => {
    stubEnv({ permission: "granted", fetch: vi.fn(async () => new Response("", { status: 500 })) });
    await expect(enablePush(BASE, "u1")).rejects.toMatchObject({ code: "key" });
  });
  it("asks for permission BEFORE any await (keeps the click's user activation)", async () => {
    const order: string[] = [];
    stubEnv({ permission: "default", requestPermission: async () => { order.push("ask"); return "granted"; }, fetch: vi.fn(async (url: string) => { order.push(String(url)); return new Response(JSON.stringify({ key: "AQID" })); }) });
    await enablePush(BASE, "u1");
    expect(order[0]).toBe("ask");
  });
  it("refuses without a known account: no prompt, no subscribe, no marker", async () => {
    const requestPermission = vi.fn(async () => "granted");
    const fetchMock = serverSaying(200);
    stubEnv({ permission: "default", requestPermission, fetch: fetchMock });
    await expect(enablePush(BASE, "")).rejects.toMatchObject({ code: "unauthorized" });
    await expect(enablePush(BASE, undefined)).rejects.toMatchObject({ code: "unauthorized" });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
  });
  it("tells the service worker which account opted in (id only)", async () => {
    stubEnv({ permission: "granted", fetch: serverSaying(200) });
    await enablePush(BASE, "u1");
    expect(swMessages).toEqual([{ type: "mw-optin", userId: "u1" }]);
  });
  it("sends mode 'enable' (explicit tap)", async () => {
    const f = serverSaying(200);
    stubEnv({ permission: "granted", fetch: f });
    await enablePush(BASE, "u1");
    const post = (f.mock.calls as unknown as Array<[string, RequestInit]>).find((c) => String(c[0]).endsWith("/api/push/subscribe"))!;
    expect(JSON.parse(String(post[1].body)).mode).toBe("enable");
  });
  it("records the server-confirmed (user, endpoint) on success", async () => {
    stubEnv({ permission: "granted", fetch: serverSaying(200) });
    expect(await enablePush(BASE, "u1")).toBe("granted");
    expect(localStorage.getItem("mw_push_synced")).toBe("u1|https://push/e1");
  });
});

describe("syncPushSubscription (self-heal on app load)", () => {
  const sub = {
    endpoint: "https://jmt17.google.com/fcm/send/x",
    toJSON: () => ({ endpoint: "https://jmt17.google.com/fcm/send/x", keys: { p256dh: "k", auth: "a" } }),
    unsubscribe: async () => true,
  };
  const ok = () => vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  it("re-sends a local subscription the server never confirmed, then remembers it", async () => {
    const fetchMock = ok();
    stubEnv({ permission: "granted", subscription: sub, fetch: fetchMock });
    expect(await syncPushSubscription(BASE, "u1")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`${BASE}/api/push/subscribe`);
    // Load-time sync may ONLY repair — never an "enable" (which could insert a row).
    expect(JSON.parse(String(((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body)).mode).toBe("repair");
    // Second load: already confirmed → no D1 write.
    expect(await syncPushSubscription(BASE, "u1")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  /** A subscription whose local unsubscribe is observable. */
  function trackedSub() {
    const t = { unsubscribed: false };
    return { t, s: { ...sub, unsubscribe: async () => { t.unsubscribed = true; return true; } } };
  }
  it("does NOT re-send when a different account signs in (no cross-account rebinding)", async () => {
    localStorage.setItem("mw_push_synced", `u1|${sub.endpoint}`);
    const fetchMock = ok();
    const { t, s } = trackedSub();
    stubEnv({ permission: "granted", subscription: s, fetch: fetchMock });
    expect(await syncPushSubscription(BASE, "u2")).toBe(false);
    expect(t.unsubscribed).toBe(true);
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
    // No server call at all for u2 (the old account's row is theirs to remove), and the SW opt-in is cleared.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(swMessages).toEqual([{ type: "mw-optin", userId: null }]);
  });
  it("treats an empty-user marker as an unknown owner (no rebinding)", async () => {
    localStorage.setItem("mw_push_synced", `|${sub.endpoint}`);
    const fetchMock = ok();
    const { t, s } = trackedSub();
    stubEnv({ permission: "granted", subscription: s, fetch: fetchMock });
    expect(await syncPushSubscription(BASE, "u1")).toBe(false);
    expect(t.unsubscribed).toBe(true);
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
    expect(fetchMock.mock.calls.map((c) => String((c as unknown[])[0]))).not.toContain(`${BASE}/api/push/subscribe`);
  });
  it("no marker = unknown ownership: repair only; a 409 (owned by another account) drops the local subscription and changes nothing on the server", async () => {
    const serverRows: string[] = ["uOther|" + sub.endpoint];
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).mode).toBe("repair");
      return new Response(JSON.stringify({ error: "endpoint_owned" }), { status: 409 });
    });
    const { t, s } = trackedSub();
    stubEnv({ permission: "granted", subscription: s, fetch: fetchMock });
    expect(localStorage.getItem("mw_push_synced")).toBeNull(); // storage cleared
    expect(await syncPushSubscription(BASE, "u1")).toBe(false);
    expect(t.unsubscribed).toBe(true);
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // one repair attempt, nothing else (no enable, no unsubscribe)
    expect(serverRows).toEqual(["uOther|" + sub.endpoint]);
    expect(swMessages).toContainEqual({ type: "mw-optin", userId: null });
  });
  it("no marker + the server has no row for this account (404 not_subscribed) → local subscription dropped, never created", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "not_subscribed" }), { status: 404 }));
    const { t, s } = trackedSub();
    stubEnv({ permission: "granted", subscription: s, fetch: fetchMock });
    expect(await syncPushSubscription(BASE, "u1")).toBe(false);
    expect(t.unsubscribed).toBe(true);
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("endpoint rotated (same user): repair carries previous_endpoint from the marker, then the marker follows", async () => {
    localStorage.setItem("mw_push_synced", "u1|https://jmt1.google.com/fcm/send/old");
    const fetchMock = ok();
    stubEnv({ permission: "granted", subscription: sub, fetch: fetchMock });
    expect(await syncPushSubscription(BASE, "u1")).toBe(true);
    const body = JSON.parse(String(((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body));
    expect(body).toMatchObject({ mode: "repair", endpoint: sub.endpoint, previous_endpoint: "https://jmt1.google.com/fcm/send/old" });
    expect(localStorage.getItem("mw_push_synced")).toBe(`u1|${sub.endpoint}`);
  });
  it("no marker (unknown ownership) sends NO previous_endpoint", async () => {
    const fetchMock = ok();
    stubEnv({ permission: "granted", subscription: sub, fetch: fetchMock });
    await syncPushSubscription(BASE, "u1");
    expect(JSON.parse(String(((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body))).not.toHaveProperty("previous_endpoint");
  });
  it("rotation the server refuses (404: no own row at the previous endpoint) drops the local subscription", async () => {
    localStorage.setItem("mw_push_synced", "u1|https://jmt1.google.com/fcm/send/old");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "not_subscribed" }), { status: 404 }));
    const { t, s } = trackedSub();
    stubEnv({ permission: "granted", subscription: s, fetch: fetchMock });
    expect(await syncPushSubscription(BASE, "u1")).toBe(false);
    expect(t.unsubscribed).toBe(true);
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
  });
  it("a pending removal of the SAME endpoint is never repaired back to life: dropped locally, removal retried", async () => {
    localStorage.setItem("mw_push_pending_unsub", `u1|${sub.endpoint}`);
    const calls: string[] = [];
    const fetchMock = vi.fn(async (u: string) => { calls.push(String(u)); return new Response("{}", { status: 200 }); });
    const { t, s } = trackedSub();
    stubEnv({ permission: "granted", subscription: s, fetch: fetchMock });
    expect(await syncPushSubscription(BASE, "u1")).toBe(false);
    expect(calls).toEqual([`${BASE}/api/push/unsubscribe`]); // the retry; NO subscribe/repair
    expect(t.unsubscribed).toBe(true);
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
    expect(localStorage.getItem("mw_push_pending_unsub")).toBeNull();
    expect(swMessages).toContainEqual({ type: "mw-optin", userId: null });
  });
  it("same pending-removal guard when the retry fails (entry kept for the next load)", async () => {
    localStorage.setItem("mw_push_pending_unsub", `u1|${sub.endpoint}`);
    const fetchMock = vi.fn(async () => { throw new TypeError("offline"); });
    const { t, s } = trackedSub();
    stubEnv({ permission: "granted", subscription: s, fetch: fetchMock });
    expect(await syncPushSubscription(BASE, "u1")).toBe(false);
    expect(t.unsubscribed).toBe(true);
    expect(localStorage.getItem("mw_push_pending_unsub")).toBe(`u1|${sub.endpoint}`);
  });
  it("a pending removal for a DIFFERENT endpoint does not block repair", async () => {
    localStorage.setItem("mw_push_pending_unsub", "u1|https://push/other");
    stubEnv({ permission: "granted", subscription: sub, fetch: ok() });
    expect(await syncPushSubscription(BASE, "u1")).toBe(true);
  });
  it("drops the local subscription + marker when the server permanently refuses it", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "bad_endpoint" }), { status: 400 }));
    const { t, s } = trackedSub();
    stubEnv({ permission: "granted", subscription: s, fetch: fetchMock });
    expect(await syncPushSubscription(BASE, "u1")).toBe(false);
    expect(t.unsubscribed).toBe(true);
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
  });
  it("keeps the local subscription on a transient failure (retries next load)", async () => {
    const fetchMock = vi.fn(async () => new Response("x", { status: 503 }));
    const { t, s } = trackedSub();
    stubEnv({ permission: "granted", subscription: s, fetch: fetchMock });
    expect(await syncPushSubscription(BASE, "u1")).toBe(false);
    expect(t.unsubscribed).toBe(false);
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
  });
  it("still syncs when storage is blocked (just can't remember it)", async () => {
    const boom = () => { throw new Error("SecurityError"); };
    vi.stubGlobal("localStorage", { getItem: boom, setItem: boom, removeItem: boom, clear: boom });
    const fetchMock = ok();
    stubEnv({ permission: "granted", subscription: sub, fetch: fetchMock });
    expect(await syncPushSubscription(BASE, "u1")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("never prompts or posts without granted permission / a subscription", async () => {
    const fetchMock = ok();
    const requestPermission = vi.fn(async () => "granted");
    stubEnv({ permission: "default", requestPermission, subscription: sub, fetch: fetchMock });
    expect(await syncPushSubscription(BASE, "u1")).toBe(false);
    stubEnv({ permission: "granted", subscription: null, fetch: fetchMock });
    expect(await syncPushSubscription(BASE, "u1")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });
});

describe("clearLocalPush", () => {
  it("unsubscribes locally + clears the marker without any server call", async () => {
    let unsubscribed = false;
    const sub = { endpoint: "https://push/e1", unsubscribe: async () => { unsubscribed = true; return true; } };
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    stubEnv({ subscription: sub, fetch: fetchMock });
    localStorage.setItem("mw_push_synced", "u1|https://push/e1");
    await clearLocalPush();
    expect(unsubscribed).toBe(true);
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("disablePush", () => {
  it("unsubscribes locally, clears marker + SW opt-in, then POSTs the scoped unsubscribe", async () => {
    let unsubscribed = false;
    const sub = { endpoint: "https://push/e1", unsubscribe: async () => { unsubscribed = true; return true; } };
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    stubEnv({ subscription: sub, fetch: fetchMock });
    localStorage.setItem("mw_push_synced", "u1|https://push/e1");
    await disablePush(BASE, "u1");
    expect(unsubscribed).toBe(true);
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
    expect(localStorage.getItem("mw_push_pending_unsub")).toBeNull();
    expect(swMessages).toEqual([{ type: "mw-optin", userId: null }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("a stalled (never-resolving) server call never leaves the local subscription active", async () => {
    let unsubscribed = false;
    const sub = { endpoint: "https://push/e1", unsubscribe: async () => { unsubscribed = true; return true; } };
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    stubEnv({ subscription: sub, fetch: fetchMock });
    localStorage.setItem("mw_push_synced", "u1|https://push/e1");
    void disablePush(BASE, "u1"); // never settles
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Local side is fully done BEFORE/while the server call hangs.
    expect(unsubscribed).toBe(true);
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
    expect(swMessages).toEqual([{ type: "mw-optin", userId: null }]);
    expect(localStorage.getItem("mw_push_pending_unsub")).toBe("u1|https://push/e1"); // retry later
  });
  it("the local side is done before the server call is even issued", async () => {
    const order: string[] = [];
    const sub = { endpoint: "https://push/e1", unsubscribe: async () => { order.push("local-unsub"); return true; } };
    stubEnv({ subscription: sub, fetch: vi.fn(async () => { order.push("server"); return new Response("{}"); }) });
    await disablePush(BASE, "u1");
    expect(order).toEqual(["local-unsub", "server"]);
  });
  it("a failed server call is remembered and retried by the same account on next load", async () => {
    const sub = { endpoint: "https://push/e1", unsubscribe: async () => true };
    stubEnv({ subscription: sub, fetch: vi.fn(async () => { throw new TypeError("offline"); }) });
    localStorage.setItem("mw_push_synced", "u1|https://push/e1");
    await disablePush(BASE, "u1");
    expect(localStorage.getItem("mw_push_pending_unsub")).toBe("u1|https://push/e1");
    const retry = vi.fn(async () => new Response("{}", { status: 200 }));
    stubEnv({ subscription: null, permission: "granted", fetch: retry });
    await syncPushSubscription(BASE, "u1");
    expect(retry).toHaveBeenCalledTimes(1);
    expect(String((retry.mock.calls[0] as unknown[])[0])).toBe(`${BASE}/api/push/unsubscribe`);
    expect(localStorage.getItem("mw_push_pending_unsub")).toBeNull();
  });
  it("another account never sends the previous account's pending removal", async () => {
    localStorage.setItem("mw_push_pending_unsub", "u1|https://push/e1");
    const f = vi.fn(async () => new Response("{}"));
    stubEnv({ subscription: null, permission: "granted", fetch: f });
    await syncPushSubscription(BASE, "u2");
    expect(f).not.toHaveBeenCalled();
    expect(localStorage.getItem("mw_push_pending_unsub")).toBeNull();
  });
  it("with no subscription it only clears marker + SW opt-in (no server call)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    stubEnv({ subscription: null, fetch: fetchMock });
    localStorage.setItem("mw_push_synced", "u1|https://push/e1");
    await disablePush(BASE, "u1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
    expect(swMessages).toEqual([{ type: "mw-optin", userId: null }]);
  });
});

// ---- two accounts, one browser, against a fake server with real ownership rules -------
describe("two accounts on one browser", () => {
  function world() {
    const rows = new Map<string, string>(); // endpoint → owner
    let me = "uA";
    let net = true; // false → every request fails
    let n = 0;
    let local: { endpoint: string } | null = null;
    const server = vi.fn(async (url: string, init?: RequestInit) => {
      if (!net) throw new TypeError("offline");
      const u = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (u.endsWith("/api/push/key")) return new Response(JSON.stringify({ key: "AQID" }));
      if (u.endsWith("/api/push/subscribe")) {
        const owner = rows.get(body.endpoint);
        if (owner !== undefined && owner !== me) return new Response(JSON.stringify({ error: "endpoint_owned" }), { status: 409 });
        if (owner === undefined && body.mode === "repair") return new Response(JSON.stringify({ error: "not_subscribed" }), { status: 404 });
        rows.set(body.endpoint, me);
        return new Response(JSON.stringify({ ok: true }));
      }
      if (u.endsWith("/api/push/unsubscribe")) {
        if (rows.get(body.endpoint) === me) rows.delete(body.endpoint);
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response("{}", { status: 404 });
    });
    const mkSub = (endpoint: string) => ({
      endpoint,
      toJSON: () => ({ endpoint, keys: { p256dh: "k", auth: "a" } }),
      unsubscribe: async () => { if (local?.endpoint === endpoint) local = null; return true; },
    });
    const reg = {
      active: { postMessage: (m: unknown) => void swMessages.push(m) },
      pushManager: {
        getSubscription: async () => local,
        subscribe: async () => (local = mkSub(`https://push/fresh${++n}`)),
      },
    };
    const Notification = { permission: "granted", requestPermission: async () => "granted" };
    vi.stubGlobal("navigator", { serviceWorker: { register: async () => reg, ready: Promise.resolve(reg), getRegistration: async () => reg } });
    vi.stubGlobal("window", { PushManager: function () {}, Notification });
    vi.stubGlobal("Notification", Notification);
    vi.stubGlobal("fetch", server);
    swMessages.length = 0;
    return {
      rows, server,
      login: (u: string) => { me = u; },
      setNet: (v: boolean) => { net = v; },
      local: () => local,
      seedLocal: (e: string) => { local = mkSub(e); },
    };
  }

  it("A enables; A's logout fails on the network; B signs in: no row for B, B's toggle is off, A's old endpoint is dead locally", async () => {
    const w = world();
    expect(await enablePush(BASE, "uA")).toBe("granted");
    const aEndpoint = w.local()!.endpoint;
    expect(w.rows.get(aEndpoint)).toBe("uA");
    w.setNet(false);
    await disablePush(BASE, "uA"); // interrupted logout: server call fails
    expect(w.local()).toBeNull(); // local subscription removed regardless
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
    w.setNet(true);
    w.login("uB");
    expect(await syncPushSubscription(BASE, "uB")).toBe(false);
    expect([...w.rows.entries()].filter(([, o]) => o === "uB")).toEqual([]); // nothing for B
    expect(w.rows.get(aEndpoint)).toBe("uA"); // A's row untouched by B (pruned later on 404/410)
    expect(await pushSubscribed()).toBe(false); // B's toggle shows off
  });
  it("A enables, the page is closed before logout finishes, B logs in: A's subscription is dropped, never rebound to B", async () => {
    const w = world();
    await enablePush(BASE, "uA");
    const aEndpoint = w.local()!.endpoint;
    w.login("uB");
    expect(await syncPushSubscription(BASE, "uB")).toBe(false);
    expect(w.local()).toBeNull();
    expect(w.rows.get(aEndpoint)).toBe("uA");
    expect([...w.rows.values()]).not.toContain("uB");
  });
  it("B taps enable while the browser still holds A's subscription: 409 → fresh endpoint owned by B", async () => {
    const w = world();
    await enablePush(BASE, "uA");
    const aEndpoint = w.local()!.endpoint;
    w.login("uB");
    expect(await enablePush(BASE, "uB")).toBe("granted");
    const bEndpoint = w.local()!.endpoint;
    expect(bEndpoint).not.toBe(aEndpoint);
    expect(w.rows.get(bEndpoint)).toBe("uB");
    expect(w.rows.get(aEndpoint)).toBe("uA"); // A keeps their (now dead) row, untransferred
    expect(localStorage.getItem("mw_push_synced")).toBe(`uB|${bEndpoint}`);
  });
  it("B's explicit enable fails again after the fresh attempt → error surfaced, nothing left locally", async () => {
    const w = world();
    w.seedLocal("https://push/owned");
    w.rows.set("https://push/owned", "uA");
    w.rows.set("https://push/fresh1", "uA"); // the fresh endpoint also (impossibly) owned → still refused
    w.login("uB");
    await expect(enablePush(BASE, "uB")).rejects.toMatchObject({ code: "endpoint_owned" });
    expect(w.local()).toBeNull();
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
    expect([...w.rows.values()]).not.toContain("uB");
  });
  it("permission granted + an old subscription but no opt-in marker (storage cleared) never creates a server row", async () => {
    const w = world();
    w.seedLocal("https://push/orphan");
    w.login("uB");
    expect(await syncPushSubscription(BASE, "uB")).toBe(false);
    expect(w.rows.size).toBe(0);
    expect(w.local()).toBeNull();
  });
});

describe("push.ts edge paths", () => {
  it("pushSubscribed is false when the registration lookup throws", async () => {
    stubEnv({ getRegistration: async () => { throw new Error("boom"); } });
    expect(await pushSubscribed()).toBe(false);
  });
  it("disablePush / clearLocalPush survive a throwing registration lookup and still clear the marker", async () => {
    stubEnv({ getRegistration: async () => { throw new Error("boom"); } });
    localStorage.setItem("mw_push_synced", "u1|e");
    await disablePush(BASE, "u1");
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
    localStorage.setItem("mw_push_synced", "u1|e");
    await clearLocalPush();
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
  });
  it("disablePush is a no-op when unsupported (marker still cleared)", async () => {
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("window", undefined);
    localStorage.setItem("mw_push_synced", "u1|e");
    await disablePush(BASE, "u1");
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
  });
  it("disablePush derives the pending owner from the marker when no userId is passed", async () => {
    const sub = { endpoint: "https://push/e1", unsubscribe: async () => true };
    stubEnv({ subscription: sub, fetch: vi.fn(async () => { throw new TypeError("offline"); }) });
    localStorage.setItem("mw_push_synced", "u7|https://push/e1");
    await disablePush(BASE);
    expect(localStorage.getItem("mw_push_pending_unsub")).toBe("u7|https://push/e1");
  });
  it("opt-in falls back to the page's controller when no registration is active", async () => {
    const posted: unknown[] = [];
    stubEnv({ permission: "granted", fetch: vi.fn(async (u: string) => String(u).endsWith("/key") ? new Response(JSON.stringify({ key: "AQID" })) : new Response("{}")) });
    const nav = (globalThis as unknown as { navigator: { serviceWorker: { getRegistration: () => Promise<unknown>; controller?: unknown } } }).navigator;
    nav.serviceWorker.getRegistration = async () => ({ active: null, pushManager: { getSubscription: async () => null } });
    nav.serviceWorker.controller = { postMessage: (m: unknown) => void posted.push(m) };
    await clearLocalPush();
    expect(posted).toEqual([{ type: "mw-optin", userId: null }]);
  });
  it("sync drops the local subscription on a permanent refusal and keeps it on a 408/429", async () => {
    for (const [status, dropped] of [[400, true], [408, false], [429, false], [404, true]] as const) {
      let unsub = false;
      const sub = { endpoint: "https://push/e1", toJSON: () => ({ keys: {} }), unsubscribe: async () => { unsub = true; return true; } };
      stubEnv({ permission: "granted", subscription: sub, fetch: vi.fn(async () => new Response("x", { status })) });
      await syncPushSubscription(BASE, "u1");
      expect(unsub, String(status)).toBe(dropped);
    }
  });
});

describe("disablePush keeps several pending removals (max 5)", () => {
  const entries = () => (localStorage.getItem("mw_push_pending_unsub") ?? "").split("\n").filter(Boolean);
  it("a second failed logout does not overwrite the first pending removal; the same account retries both", async () => {
    const down = vi.fn(async () => { throw new TypeError("offline"); });
    stubEnv({ subscription: { endpoint: "https://push/e1", unsubscribe: async () => true }, fetch: down });
    await disablePush(BASE, "u1");
    stubEnv({ subscription: { endpoint: "https://push/e2", unsubscribe: async () => true }, fetch: down });
    await disablePush(BASE, "u1");
    expect(entries()).toEqual(["u1|https://push/e1", "u1|https://push/e2"]);
    const sent: string[] = [];
    const retry = vi.fn(async (_u: string, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body)).endpoint); return new Response("{}", { status: 200 }); });
    stubEnv({ subscription: null, permission: "granted", fetch: retry });
    await syncPushSubscription(BASE, "u1");
    expect(sent).toEqual(["https://push/e1", "https://push/e2"]);
    expect(entries()).toEqual([]);
  });
  it("only the unconfirmed ones stay; entries of another account are dropped; the list is capped at 5 (newest kept)", async () => {
    localStorage.setItem("mw_push_pending_unsub", ["u1|https://push/a", "u2|https://push/b", "u1|https://push/c"].join("\n"));
    const f = vi.fn(async (_u: string, init?: RequestInit) =>
      JSON.parse(String(init?.body)).endpoint === "https://push/c" ? new Response("x", { status: 503 }) : new Response("{}", { status: 200 }));
    stubEnv({ subscription: null, permission: "granted", fetch: f });
    await syncPushSubscription(BASE, "u1");
    expect(entries()).toEqual(["u1|https://push/c"]);
    localStorage.setItem("mw_push_pending_unsub", Array.from({ length: 5 }, (_, i) => `u1|https://push/p${i}`).join("\n"));
    stubEnv({ subscription: { endpoint: "https://push/new", unsubscribe: async () => true }, fetch: vi.fn(async () => { throw new TypeError("x"); }) });
    await disablePush(BASE, "u1");
    expect(entries()).toEqual([...Array.from({ length: 4 }, (_, i) => `u1|https://push/p${i + 1}`), "u1|https://push/new"]);
  });
  it("enabling again supersedes an unconfirmed removal of the same endpoint", async () => {
    localStorage.setItem("mw_push_pending_unsub", "u1|https://push/e1");
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("/api/push/key") ? new Response(JSON.stringify({ key: "AQID" }), { status: 200 }) : new Response("{}", { status: 200 }));
    stubEnv({ permission: "granted", subscription: null, fetch: fetchMock });
    expect(await enablePush(BASE, "u1")).toBe("granted");
    expect(entries()).toEqual([]);
  });
});

describe("opt-in id is written to IndexedDB directly (not only posted)", () => {
  const sub = { endpoint: "https://push/e1", toJSON: () => ({ endpoint: "https://push/e1", keys: { p256dh: "k", auth: "a" } }), unsubscribe: async () => true };
  const okFetch = () => vi.fn(async (url: string) =>
    String(url).endsWith("/api/push/key") ? new Response(JSON.stringify({ key: "AQID" }), { status: 200 }) : new Response("{}", { status: 200 }));

  it("enable writes the id the worker's real store reads — even when postMessage can't reach any worker", async () => {
    const f = fakeIdb();
    vi.stubGlobal("indexedDB", f.idb);
    stubEnv({ permission: "granted", subscription: sub, fetch: okFetch() });
    // No active worker and no controller: the message is lost.
    vi.stubGlobal("navigator", { serviceWorker: { register: async () => ({}), ready: Promise.resolve({ pushManager: { getSubscription: async () => sub, subscribe: async () => sub } }), getRegistration: async () => ({ pushManager: {} }), controller: null } });
    expect(await enablePush(BASE, "u1")).toBe("granted");
    expect(f.value()).toBe("u1");
    expect(await swCore.makeIdbStore(f.idb).get()).toBe("u1"); // same DB/store/key as the SW reads
  });
  it("every load whose marker matches re-asserts the id (repairs a lost/never-delivered write)", async () => {
    const f = fakeIdb();
    vi.stubGlobal("indexedDB", f.idb);
    localStorage.setItem("mw_push_synced", "u1|https://push/e1");
    const fetchMock = okFetch();
    stubEnv({ permission: "granted", subscription: sub, fetch: fetchMock });
    expect(f.value()).toBeNull();
    expect(await syncPushSubscription(BASE, "u1")).toBe(false); // nothing to repair on the server
    expect(fetchMock).not.toHaveBeenCalled();
    expect(f.value()).toBe("u1");
  });
  it("repair success also writes it", async () => {
    const f = fakeIdb();
    vi.stubGlobal("indexedDB", f.idb);
    stubEnv({ permission: "granted", subscription: sub, fetch: okFetch() });
    expect(await syncPushSubscription(BASE, "u1")).toBe(true);
    expect(f.value()).toBe("u1");
  });
  it("disable, clearLocalPush and a foreign-account drop clear it directly", async () => {
    for (const act of [
      () => disablePush(BASE, "u1"),
      () => clearLocalPush(),
      () => { localStorage.setItem("mw_push_synced", "uOther|https://push/e1"); return syncPushSubscription(BASE, "u1"); },
    ]) {
      const f = fakeIdb();
      vi.stubGlobal("indexedDB", f.idb);
      await swCore.makeIdbStore(f.idb).set("u1");
      stubEnv({ permission: "granted", subscription: sub, fetch: okFetch() });
      await act();
      expect(f.value()).toBeNull();
    }
  });
  it("a failing / missing IndexedDB never breaks the flow (postMessage fallback still fires)", async () => {
    vi.stubGlobal("indexedDB", fakeIdb({ failTx: true }).idb);
    stubEnv({ permission: "granted", subscription: sub, fetch: okFetch() });
    expect(await enablePush(BASE, "u1")).toBe("granted");
    expect(swMessages).toContainEqual({ type: "mw-optin", userId: "u1" });
    vi.stubGlobal("indexedDB", { open: () => { throw new Error("blocked"); } });
    expect(await syncPushSubscription(BASE, "u2")).toBe(false);
    vi.stubGlobal("indexedDB", { open: () => { const r: Record<string, unknown> = {}; setTimeout(() => (r.onerror as () => void)?.(), 0); return r; } });
    stubEnv({ permission: "granted", subscription: sub, fetch: okFetch() });
    expect(await enablePush(BASE, "u1")).toBe("granted");
    // open ok, but the store is missing (transaction throws synchronously)
    vi.stubGlobal("indexedDB", { open: () => { const r: Record<string, unknown> = {}; setTimeout(() => { r.result = { close() {}, transaction() { throw new Error("NotFoundError"); } }; (r.onsuccess as () => void)?.(); }, 0); return r; } });
    expect(await enablePush(BASE, "u1")).toBe("granted");
  });
});

describe("describePushFailure", () => {
  it("drops a browser message carrying a UUID or a 24+ char token", () => {
    expect(describePushFailure(new DOMException("bad sub 123e4567-e89b-12d3-a456-426614174000", "InvalidStateError"))).toBe("InvalidStateError");
    expect(describePushFailure(new DOMException("key AbCdEfGhIjKlMnOpQrStUvWxYz", "InvalidAccessError"))).toBe("InvalidAccessError");
  });
  it("names DOMExceptions with a short generic message", () => {
    expect(describePushFailure(new DOMException("Registration failed - push service error", "AbortError")))
      .toBe("AbortError — Registration failed - push service error");
  });
  it("drops messages with URLs or long tokens, caps at 120, and maps non-errors to unknown", () => {
    expect(describePushFailure(new DOMException("failed at https://fcm.googleapis.com/x/abc", "AbortError"))).toBe("AbortError");
    expect(describePushFailure(Object.assign(new Error("x".repeat(200)), { name: "N".repeat(64) })).length).toBeLessThanOrEqual(120);
    expect(describePushFailure("boom")).toBe("unknown");
    expect(describePushFailure(null)).toBe("unknown");
  });
});
