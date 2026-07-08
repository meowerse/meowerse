import { describe, it, expect, vi, afterEach } from "vitest";
import { pushSupported, pushPermission, pushSubscribed, enablePush, disablePush, urlBase64ToUint8Array } from "./push";

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

describe("disablePush", () => {
  it("unsubscribes locally + POSTs unsubscribe", async () => {
    let unsubscribed = false;
    const sub = { endpoint: "https://push/e1", unsubscribe: async () => { unsubscribed = true; return true; } };
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    stubEnv({ subscription: sub, fetch: fetchMock });
    await disablePush(BASE);
    expect(unsubscribed).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });
  it("no-ops when there's no subscription", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    stubEnv({ subscription: null, fetch: fetchMock });
    await disablePush(BASE);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
