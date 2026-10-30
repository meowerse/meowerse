import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// public/sw-core.js is a classic worker script (importScripts); evaluate it the way a
// worker does, with `self` as the global, and read back self.mwPushCore.
type Store = { get(): Promise<string | null>; set(id: string): Promise<unknown>; clear(): Promise<unknown> };
type Decision = { show: boolean; reason?: string; title?: string; body?: string; chatId?: string };
const sandbox: { self: Record<string, unknown> } = { self: {} };
runInNewContext(readFileSync(new URL("../../public/sw-core.js", import.meta.url), "utf8"), sandbox);
const core = sandbox.self.mwPushCore as {
  decidePush(d: { store: Store; fetchFn: unknown; registration: unknown }): Promise<Decision>;
  handleMessage(data: unknown, store: Store): Promise<boolean>;
};

function memStore(initial: string | null): Store & { value: () => string | null } {
  let v = initial;
  return { get: async () => v, set: async (id) => { v = id; }, clear: async () => { v = null; }, value: () => v };
}
function swReg() {
  const t = { unsubscribed: 0 };
  const sub = { unsubscribe: async () => { t.unsubscribed++; return true; } };
  return { t, registration: { pushManager: { getSubscription: async () => sub } } };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const CHATS = { viewerId: "uA", chats: [{ id: "c1", name: "Secret chat", lastMessage: "private text", unreadCount: 2, lastActivity: 5 }] };

/** fetch stub: session → `session`, chats → `chats`; records the URLs hit. */
function net(session: () => Response | Promise<Response>, chats: () => Response | Promise<Response> = () => json(CHATS)) {
  const urls: string[] = [];
  const fetchFn = vi.fn(async (url: string) => {
    urls.push(url);
    return url === "/api/session" ? session() : chats();
  });
  return { fetchFn, urls };
}
const signedIn = (id: string) => () => json({ authenticated: true, user: { id } });

describe("decidePush — identity gate", () => {
  it("shows the preview only when the signed-in account is the opted-in account", async () => {
    const store = memStore("uA");
    const { t, registration } = swReg();
    const { fetchFn, urls } = net(signedIn("uA"));
    const d = await core.decidePush({ store, fetchFn, registration });
    expect(d).toMatchObject({ show: true, title: "Secret chat", body: "private text", chatId: "c1" });
    expect(urls).toEqual(["/api/session", "/api/chats"]);
    expect(t.unsubscribed).toBe(0);
    expect(store.value()).toBe("uA");
  });
  it("account mismatch (B signed in, A opted in): no preview, /api/chats never fetched, subscription dropped, opt-in cleared", async () => {
    const store = memStore("uA");
    const { t, registration } = swReg();
    const { fetchFn, urls } = net(signedIn("uB"));
    const d = await core.decidePush({ store, fetchFn, registration });
    expect(d.show).toBe(false);
    expect(d.reason).toBe("account_mismatch");
    expect(urls).toEqual(["/api/session"]);
    expect(t.unsubscribed).toBe(1);
    expect(store.value()).toBeNull();
  });
  it("401 / 403 session → no preview, subscription dropped", async () => {
    for (const status of [401, 403]) {
      const store = memStore("uA");
      const { t, registration } = swReg();
      const { fetchFn, urls } = net(() => json({}, status));
      const d = await core.decidePush({ store, fetchFn, registration });
      expect(d.show, String(status)).toBe(false);
      expect(urls).not.toContain("/api/chats");
      expect(t.unsubscribed).toBe(1);
      expect(store.value()).toBeNull();
    }
  });
  it("transient session failures (500 / 503 / 429 / 404) → no preview but the subscription and opt-in are KEPT", async () => {
    for (const status of [500, 503, 429, 404]) {
      const store = memStore("uA");
      const { t, registration } = swReg();
      const { fetchFn, urls } = net(() => json({}, status));
      const d = await core.decidePush({ store, fetchFn, registration });
      expect(d, String(status)).toMatchObject({ show: false, reason: "session_unavailable" });
      expect(urls).toEqual(["/api/session"]);
      expect(t.unsubscribed, String(status)).toBe(0);
      expect(store.value(), String(status)).toBe("uA");
    }
  });
  it("a 200 session with an unreadable body is transient too (kept, nothing shown)", async () => {
    const store = memStore("uA");
    const { t, registration } = swReg();
    const { fetchFn } = net(() => new Response("<html>captive portal</html>", { status: 200 }));
    expect(await core.decidePush({ store, fetchFn, registration })).toMatchObject({ show: false, reason: "session_unreadable" });
    expect(t.unsubscribed).toBe(0);
    expect(store.value()).toBe("uA");
  });
  it("200 session without a user id → dropped", async () => {
    const store = memStore("uA");
    const { t, registration } = swReg();
    const { fetchFn } = net(() => json({ authenticated: true, user: {} }));
    expect(await core.decidePush({ store, fetchFn, registration })).toMatchObject({ show: false, reason: "signed_out" });
    expect(t.unsubscribed).toBe(1);
  });
  it("signed out (authenticated:false) → no preview, subscription dropped", async () => {
    const store = memStore("uA");
    const { t, registration } = swReg();
    const { fetchFn } = net(() => json({ authenticated: false }));
    const d = await core.decidePush({ store, fetchFn, registration });
    expect(d).toMatchObject({ show: false, reason: "signed_out" });
    expect(t.unsubscribed).toBe(1);
  });
  it("network failure on the identity check → no preview, but the subscription is kept (offline blip)", async () => {
    const store = memStore("uA");
    const { t, registration } = swReg();
    const { urls } = net(signedIn("uA"));
    const fetchFn = vi.fn(async () => { throw new TypeError("offline"); });
    const d = await core.decidePush({ store, fetchFn, registration });
    expect(d).toMatchObject({ show: false, reason: "offline" });
    expect(urls).toEqual([]);
    expect(t.unsubscribed).toBe(0);
    expect(store.value()).toBe("uA");
  });
  it("no stored opt-in (never enabled / cleared) → nothing fetched, no preview, subscription dropped", async () => {
    const store = memStore(null);
    const { t, registration } = swReg();
    const { fetchFn } = net(signedIn("uA"));
    const d = await core.decidePush({ store, fetchFn, registration });
    expect(d).toMatchObject({ show: false, reason: "no_opt_in" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(t.unsubscribed).toBe(1);
  });
  it("verified identity but /api/chats fails or is empty → still no (generic) notification", async () => {
    const { registration } = swReg();
    for (const chats of [() => json({}, 500), () => json({ chats: [{ id: "c", unreadCount: 0 }] })]) {
      const d = await core.decidePush({ store: memStore("uA"), fetchFn: net(signedIn("uA"), chats).fetchFn, registration });
      expect(d.show).toBe(false);
    }
    const throwing = vi.fn(async (u: string) => { if (u === "/api/chats") throw new Error("x"); return json({ authenticated: true, user: { id: "uA" } }); });
    expect((await core.decidePush({ store: memStore("uA"), fetchFn: throwing, registration })).show).toBe(false);
  });
  it("account switch between the two requests (session says A, /api/chats answers for B): no preview, purged", async () => {
    const store = memStore("uA");
    const { t, registration } = swReg();
    const { fetchFn, urls } = net(signedIn("uA"), () => json({ ...CHATS, viewerId: "uB" }));
    const d = await core.decidePush({ store, fetchFn, registration });
    expect(d).toMatchObject({ show: false, reason: "account_mismatch" });
    expect(urls).toEqual(["/api/session", "/api/chats"]);
    expect(t.unsubscribed).toBe(1);
    expect(store.value()).toBeNull();
  });
  it("/api/chats without a viewerId → no preview, purged", async () => {
    for (const body of [{ chats: CHATS.chats }, { ...CHATS, viewerId: "" }, { ...CHATS, viewerId: 7 }]) {
      const store = memStore("uA");
      const { t, registration } = swReg();
      const d = await core.decidePush({ store, fetchFn: net(signedIn("uA"), () => json(body)).fetchFn, registration });
      expect(d.show).toBe(false);
      expect(t.unsubscribed).toBe(1);
      expect(store.value()).toBeNull();
    }
  });
  it("opt-in cleared between the two fetches (logout / disable) → no preview", async () => {
    const store = memStore("uA");
    const { registration } = swReg();
    const { fetchFn } = net(signedIn("uA"), () => { void store.clear(); return json(CHATS); });
    const d = await core.decidePush({ store, fetchFn, registration });
    expect(d).toMatchObject({ show: false, reason: "no_opt_in" });
  });
  it("coalesces several unread chats like before", async () => {
    const chats = () => json({ viewerId: "uA", chats: [
      { id: "c1", name: "A", lastMessage: "old", unreadCount: 1, lastActivity: 1 },
      { id: "c2", peerUsername: "bob", lastMessage: "new", unreadCount: 3, lastActivity: 9 },
    ] });
    const d = await core.decidePush({ store: memStore("uA"), fetchFn: net(signedIn("uA"), chats).fetchFn, registration: swReg().registration });
    expect(d).toMatchObject({ show: true, title: "bob", chatId: "c2", body: "new · 4 unread in 2 chats" });
  });
});

describe("handleMessage (opt-in id from the page)", () => {
  it("stores the account id on mw-optin and clears on null", async () => {
    const store = memStore(null);
    expect(await core.handleMessage({ type: "mw-optin", userId: "uA" }, store)).toBe(true);
    expect(store.value()).toBe("uA");
    expect(await core.handleMessage({ type: "mw-optin", userId: null }, store)).toBe(true);
    expect(store.value()).toBeNull();
  });
  it("ignores unrelated or malformed messages", async () => {
    const store = memStore("uA");
    expect(await core.handleMessage({ type: "other" }, store)).toBe(false);
    expect(await core.handleMessage(null, store)).toBe(false);
    expect(store.value()).toBe("uA");
  });
});

describe("service worker caching headers", () => {
  const headers = readFileSync(new URL("../../public/_headers", import.meta.url), "utf8");
  for (const path of ["/sw.js", "/sw-core.js"]) {
    it(`${path} is always revalidated (a stale identity gate must not outlive a deploy)`, () => {
      const block = new RegExp(`^${path.replace(".", "\\.")}\\n((?:[ \\t]+.*\\n?)+)`, "m").exec(headers);
      expect(block, `${path} rule in _headers`).not.toBeNull();
      expect(block![1]).toMatch(/Cache-Control:\s*no-cache\s*$/m);
    });
  }
});
