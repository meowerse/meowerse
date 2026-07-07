import { describe, it, expect, vi, afterEach } from "vitest";
import {
  listChats,
  openDirect,
  loadHistory,
  wsUrl,
  slugify,
  createGroup,
  getMembers,
  addMember,
  removeMember,
  setMemberRole,
  leaveChat,
  updateChat,
  slugAvailable,
  searchUsers,
} from "./chat";

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
  it("carries the Slice-4 reply/edit/delete fields through unchanged", async () => {
    const messages = [
      { id: "m2", chatId: "c1", senderId: "u1", body: "yo", createdAt: 2000, replyToId: "m1", replyTo: { id: "m1", senderId: "u2", body: "hi" }, editedAt: 2500, isDeleted: false },
      { id: "m3", chatId: "c1", senderId: "u1", body: "", createdAt: 3000, replyToId: null, replyTo: null, editedAt: null, isDeleted: true },
    ];
    stubFetch({ messages });
    expect(await loadHistory(BASE, "c1")).toEqual(messages);
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

// ---- Slice 5: groups + member management --------------------------------------

describe("slugify", () => {
  it("lowercases + collapses non-alphanumeric runs to a single dash", () => {
    expect(slugify("My Cool Group!!")).toBe("my-cool-group");
  });
  it("trims leading/trailing dashes and handles unicode/symbols", () => {
    expect(slugify("  --Hello__World--  ")).toBe("hello-world");
    expect(slugify("café ☕ time")).toBe("caf-time");
  });
  it("returns empty string when nothing survives", () => {
    expect(slugify("!!!")).toBe("");
  });
});

describe("createGroup", () => {
  it("POSTs a group payload and returns the chatId", async () => {
    const mock = stubFetch({ chatId: "g1", created: true });
    expect(await createGroup(BASE, { name: "team", members: ["bob"], visibility: "public", slug: "team" }))
      .toEqual({ chatId: "g1", created: true });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "group", name: "team", members: ["bob"], visibility: "public", slug: "team" }),
    });
  });
  it("surfaces a server error code (e.g. slug_taken)", async () => {
    stubFetch({ error: "slug_taken" });
    expect(await createGroup(BASE, { name: "t", members: [] })).toEqual({ error: "slug_taken" });
  });
  it("returns {error:'network'} on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await createGroup(BASE, { name: "t", members: [] })).toEqual({ error: "network" });
  });
});

describe("getMembers", () => {
  it("returns the members array", async () => {
    const members = [{ userId: "u1", username: "bob", displayName: "Bob", avatarUrl: null, role: "owner", joinedAt: 1 }];
    const mock = stubFetch({ members });
    expect(await getMembers(BASE, "g1")).toEqual(members);
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/g1/members`, { credentials: "include" });
  });
  it("defaults to [] when the body has no members", async () => {
    stubFetch({});
    expect(await getMembers(BASE, "g1")).toEqual([]);
  });
  it("returns [] on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await getMembers(BASE, "g1")).toEqual([]);
  });
});

describe("addMember", () => {
  it("POSTs the trimmed username and returns the result", async () => {
    const mock = stubFetch({ ok: true, userId: "u2" });
    expect(await addMember(BASE, "g1", "  bob  ")).toEqual({ ok: true, userId: "u2" });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/g1/members`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bob" }),
    });
  });
  it("surfaces a 403 error code (forbidden)", async () => {
    stubFetch({ error: "forbidden" });
    expect(await addMember(BASE, "g1", "bob")).toEqual({ error: "forbidden" });
  });
  it("returns {error:'network'} on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await addMember(BASE, "g1", "bob")).toEqual({ error: "network" });
  });
});

describe("removeMember", () => {
  it("DELETEs the member and returns the result", async () => {
    const mock = stubFetch({ ok: true });
    expect(await removeMember(BASE, "g1", "u2")).toEqual({ ok: true });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/g1/members/u2`, { method: "DELETE", credentials: "include" });
  });
  it("returns {error:'network'} on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await removeMember(BASE, "g1", "u2")).toEqual({ error: "network" });
  });
});

describe("setMemberRole", () => {
  it("POSTs the role and returns the result", async () => {
    const mock = stubFetch({ ok: true });
    expect(await setMemberRole(BASE, "g1", "u2", "admin")).toEqual({ ok: true });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/g1/members/u2/role`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
  });
  it("returns {error:'network'} on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await setMemberRole(BASE, "g1", "u2", "member")).toEqual({ error: "network" });
  });
});

describe("leaveChat", () => {
  it("POSTs leave and returns the transfer/delete result", async () => {
    const mock = stubFetch({ ok: true, transferredTo: "u3", deleted: false });
    expect(await leaveChat(BASE, "g1")).toEqual({ ok: true, transferredTo: "u3", deleted: false });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/g1/leave`, { method: "POST", credentials: "include" });
  });
  it("returns {error:'network'} on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await leaveChat(BASE, "g1")).toEqual({ error: "network" });
  });
});

describe("updateChat", () => {
  it("PATCHes the metadata patch and returns the result", async () => {
    const mock = stubFetch({ ok: true, slug: "team" });
    expect(await updateChat(BASE, "g1", { name: "Team", visibility: "public", slug: "team" }))
      .toEqual({ ok: true, slug: "team" });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/g1`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Team", visibility: "public", slug: "team" }),
    });
  });
  it("returns {error:'network'} on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await updateChat(BASE, "g1", { name: "x" })).toEqual({ error: "network" });
  });
});

describe("slugAvailable", () => {
  it("returns true only when the body says available:true", async () => {
    const mock = stubFetch({ available: true, slug: "team" });
    expect(await slugAvailable(BASE, "team")).toBe(true);
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/slug-available?slug=team`, { credentials: "include" });
  });
  it("returns false when available is false or absent", async () => {
    stubFetch({ available: false });
    expect(await slugAvailable(BASE, "taken")).toBe(false);
    stubFetch({});
    expect(await slugAvailable(BASE, "team")).toBe(false);
  });
  it("returns false on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await slugAvailable(BASE, "team")).toBe(false);
  });
});

describe("searchUsers", () => {
  it("delegates to openDirect (exact-username resolution, v1)", async () => {
    const mock = stubFetch({ chatId: "c9" });
    expect(await searchUsers(BASE, "bob")).toEqual({ chatId: "c9" });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bob" }),
    });
  });
});
