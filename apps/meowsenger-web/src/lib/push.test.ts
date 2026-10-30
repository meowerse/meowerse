import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { pushSupported, pushPermission, pushSubscribed, enablePush, disablePush, urlBase64ToUint8Array, syncPushSubscription, clearLocalPush, PushError } from "./push";

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
afterEach(() => vi.unstubAllGlobals());
const BASE = "https://x";

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
  const reg = {
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
    expect(await enablePush(BASE)).toBe("unsupported");
  });
  it("returns the permission when the user declines", async () => {
    stubEnv({ permission: "default", requestPermission: async () => "denied" });
    expect(await enablePush(BASE)).toBe("denied");
  });
  it("subscribes + POSTs the subscription on grant", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith("/api/push/key")) return new Response(JSON.stringify({ key: "AQID" }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    stubEnv({ permission: "granted", requestPermission: async () => "granted", subscription: null, fetch: fetchMock });
    expect(await enablePush(BASE)).toBe("granted");
    expect(calls.some((u) => u.endsWith("/api/push/subscribe"))).toBe(true);
  });
  it("'unsupported' when the server has no VAPID key", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ key: "" }), { status: 200 }));
    stubEnv({ permission: "granted", requestPermission: async () => "granted", subscription: null, fetch: fetchMock });
    expect(await enablePush(BASE)).toBe("unsupported");
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
    await expect(enablePush(BASE)).rejects.toMatchObject({ code: "unauthorized" });
  });
  it("throws PushError(http_<status>) when the error body isn't JSON", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("/api/push/key") ? new Response(JSON.stringify({ key: "AQID" })) : new Response("nope", { status: 502 }));
    stubEnv({ permission: "granted", fetch: fetchMock });
    await expect(enablePush(BASE)).rejects.toMatchObject({ code: "http_502" });
  });
  it("throws PushError(network) when the subscribe POST can't reach the server", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/push/key")) return new Response(JSON.stringify({ key: "AQID" }));
      throw new TypeError("offline");
    });
    stubEnv({ permission: "granted", fetch: fetchMock });
    await expect(enablePush(BASE)).rejects.toMatchObject({ code: "network" });
  });
  it("throws PushError(key) when the VAPID key fetch fails", async () => {
    stubEnv({ permission: "granted", fetch: vi.fn(async () => new Response("", { status: 500 })) });
    await expect(enablePush(BASE)).rejects.toMatchObject({ code: "key" });
  });
  it("asks for permission BEFORE any await (keeps the click's user activation)", async () => {
    const order: string[] = [];
    stubEnv({ permission: "default", requestPermission: async () => { order.push("ask"); return "granted"; }, fetch: vi.fn(async (url: string) => { order.push(String(url)); return new Response(JSON.stringify({ key: "AQID" })); }) });
    await enablePush(BASE, "u1");
    expect(order[0]).toBe("ask");
  });
  it("writes NO marker when the user is not known yet (sync settles it later)", async () => {
    stubEnv({ permission: "granted", fetch: serverSaying(200) });
    expect(await enablePush(BASE)).toBe("granted");
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
    expect(await enablePush(BASE, "")).toBe("granted");
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
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
    // Only a best-effort unsubscribe — never a subscribe for u2.
    const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(urls).not.toContain(`${BASE}/api/push/subscribe`);
    expect(urls).toEqual([`${BASE}/api/push/unsubscribe`]);
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
  it("re-sends when the SAME user's endpoint rotated", async () => {
    localStorage.setItem("mw_push_synced", "u1|https://jmt1.google.com/fcm/send/old");
    const fetchMock = ok();
    stubEnv({ permission: "granted", subscription: sub, fetch: fetchMock });
    expect(await syncPushSubscription(BASE, "u1")).toBe(true);
    expect(localStorage.getItem("mw_push_synced")).toBe(`u1|${sub.endpoint}`);
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
  it("unsubscribes locally + POSTs unsubscribe", async () => {
    let unsubscribed = false;
    const sub = { endpoint: "https://push/e1", unsubscribe: async () => { unsubscribed = true; return true; } };
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    stubEnv({ subscription: sub, fetch: fetchMock });
    localStorage.setItem("mw_push_synced", "u1|https://push/e1");
    await disablePush(BASE);
    expect(unsubscribed).toBe(true);
    expect(localStorage.getItem("mw_push_synced")).toBeNull();
    expect(fetchMock).toHaveBeenCalled();
  });
  it("no-ops when there's no subscription", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    stubEnv({ subscription: null, fetch: fetchMock });
    await disablePush(BASE);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
