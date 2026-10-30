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
    const post = f.mock.calls.find((c) => String(c[0]).endsWith("/api/push/subscribe"))!;
    expect(JSON.parse(String((post[1] as RequestInit).body)).mode).toBe("enable");
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
