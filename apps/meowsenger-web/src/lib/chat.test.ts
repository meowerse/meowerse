import { describe, it, expect, vi, afterEach } from "vitest";
import { listChats, openDirect, loadHistory, wsUrl } from "./chat";

const BASE = "https://meowsenger.alxnko.eu.org";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown) {
  const mock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("listChats", () => {
  it("returns the chats array (credentialed GET /api/chats)", async () => {
    const chats = [{ id: "c1", type: "direct", name: null, lastMessage: "hi", lastSenderId: "u2", lastActivity: 1, unreadCount: 0, peerId: "u2", peerUsername: "bob", peerDisplayName: "Bob", peerAvatarUrl: null }];
    const mock = stubFetch({ chats });
    expect(await listChats(BASE)).toEqual(chats);
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats`, { credentials: "include" });
  });
  it("defaults to [] when the body has no chats", async () => {
    stubFetch({});
    expect(await listChats(BASE)).toEqual([]);
  });
  it("returns [] on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await listChats(BASE)).toEqual([]);
  });
});

describe("openDirect", () => {
  it("POSTs the username and returns the parsed result", async () => {
    const mock = stubFetch({ chatId: "c9", created: true });
    expect(await openDirect(BASE, "bob")).toEqual({ chatId: "c9", created: true });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bob" }),
    });
  });
  it("returns {error:'network'} on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await openDirect(BASE, "bob")).toEqual({ error: "network" });
  });
});

describe("loadHistory", () => {
  it("returns the messages array (no cursor)", async () => {
    const messages = [{ id: "m1", chatId: "c1", senderId: "u1", body: "hi", createdAt: 1000 }];
    const mock = stubFetch({ messages });
    expect(await loadHistory(BASE, "c1")).toEqual(messages);
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/c1/messages`, { credentials: "include" });
  });
  it("passes the ?before cursor through (encoded)", async () => {
    const mock = stubFetch({ messages: [] });
    await loadHistory(BASE, "c1", "m 9");
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/c1/messages?before=m%209`, { credentials: "include" });
  });
  it("defaults to [] when the body has no messages", async () => {
    stubFetch({});
    expect(await loadHistory(BASE, "c1")).toEqual([]);
  });
  it("returns [] on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await loadHistory(BASE, "c1")).toEqual([]);
  });
});

describe("wsUrl", () => {
  it("swaps https→wss and appends the chat query", () => {
    expect(wsUrl("https://x", "c")).toBe("wss://x/ws?chat=c");
  });
  it("swaps http→ws", () => {
    expect(wsUrl("http://localhost:4321", "c1")).toBe("ws://localhost:4321/ws?chat=c1");
  });
  it("encodes the chatId", () => {
    expect(wsUrl("https://x", "a b")).toBe("wss://x/ws?chat=a%20b");
  });
  it("falls back to location.origin when base is empty", () => {
    vi.stubGlobal("location", { origin: "https://same.example" } as Location);
    expect(wsUrl("", "c")).toBe("wss://same.example/ws?chat=c");
  });
  it("degrades to a relative-ish url when base is empty AND there is no location (SSR)", () => {
    vi.stubGlobal("location", undefined);
    // No origin to swap → the ws?chat= tail is produced without a host prefix.
    expect(wsUrl("", "c")).toBe("/ws?chat=c");
  });
});
