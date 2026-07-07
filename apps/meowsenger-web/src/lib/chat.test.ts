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
  createChannel,
  getBySlug,
  joinChat,
  createInvite,
  getInvite,
  refreshInvite,
  revokeInvite,
  getInviteByCode,
  acceptInvite,
  requestJoin,
  getRequests,
  approveRequest,
  rejectRequest,
  getPrivacy,
  setPrivacy,
  forwardMessages,
  searchChat,
  deleteAccount,
  applyReaction,
} from "./chat";
import type { Reaction } from "./chat";

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
  it("carries the Slice-9 reactions array through unchanged", async () => {
    const messages = [
      { id: "m4", chatId: "c1", senderId: "u1", body: "yo", createdAt: 4000, reactions: [{ emoji: "👍", count: 2, mine: true }] },
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

// ---- Slice 6: channels + public discovery + open-join -------------------------

describe("createChannel", () => {
  it("POSTs a channel payload (type:'channel') and returns the chatId", async () => {
    const mock = stubFetch({ chatId: "ch1", created: true });
    expect(await createChannel(BASE, { name: "announce", members: ["bob"], visibility: "public", slug: "announce" }))
      .toEqual({ chatId: "ch1", created: true });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "channel", name: "announce", members: ["bob"], visibility: "public", slug: "announce" }),
    });
  });
  it("omits members when not provided (optional initial roster)", async () => {
    const mock = stubFetch({ chatId: "ch2", created: true });
    expect(await createChannel(BASE, { name: "solo", visibility: "private" })).toEqual({ chatId: "ch2", created: true });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "channel", name: "solo", visibility: "private" }),
    });
  });
  it("surfaces a server error code (e.g. slug_taken)", async () => {
    stubFetch({ error: "slug_taken" });
    expect(await createChannel(BASE, { name: "t" })).toEqual({ error: "slug_taken" });
  });
  it("returns {error:'network'} on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await createChannel(BASE, { name: "t" })).toEqual({ error: "network" });
  });
});

describe("getBySlug", () => {
  it("returns the ChatPreview (encoded slug in the GET path)", async () => {
    const preview = { id: "ch1", type: "channel", name: "announce", memberCount: 12, visibility: "public", isMember: false };
    const mock = stubFetch(preview);
    expect(await getBySlug(BASE, "an nounce")).toEqual(preview);
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/by-slug/an%20nounce`, { credentials: "include" });
  });
  it("passes through a {error:'private'} lock response", async () => {
    stubFetch({ error: "private" });
    expect(await getBySlug(BASE, "secret")).toEqual({ error: "private" });
  });
  it("degrades to {error:'private'} on a network error (safe, no-leak default)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await getBySlug(BASE, "x")).toEqual({ error: "private" });
  });
});

describe("joinChat", () => {
  it("POSTs /join (credentialed, no body) and returns the result", async () => {
    const mock = stubFetch({ ok: true, joined: true });
    expect(await joinChat(BASE, "ch1")).toEqual({ ok: true, joined: true });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/ch1/join`, { method: "POST", credentials: "include" });
  });
  it("surfaces a 403 must_request (private chat)", async () => {
    stubFetch({ error: "must_request" });
    expect(await joinChat(BASE, "ch1")).toEqual({ error: "must_request" });
  });
  it("returns {error:'network'} on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await joinChat(BASE, "ch1")).toEqual({ error: "network" });
  });
});

// ---- Slice 7: invite links, join requests, privacy ----------------------------

describe("createInvite", () => {
  it("POSTs an empty body (get-or-create) and returns the code", async () => {
    const mock = stubFetch({ ok: true, code: "abc123def456" });
    expect(await createInvite(BASE, "g1")).toEqual({ ok: true, code: "abc123def456" });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/g1/invite`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  });
  it("surfaces a 403 forbidden (non-admin)", async () => {
    stubFetch({ error: "forbidden" });
    expect(await createInvite(BASE, "g1")).toEqual({ error: "forbidden" });
  });
  it("returns {error:'network'} on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await createInvite(BASE, "g1")).toEqual({ error: "network" });
  });
});

describe("getInvite", () => {
  it("delegates to createInvite (idempotent get-or-create)", async () => {
    const mock = stubFetch({ ok: true, code: "code000code0" });
    expect(await getInvite(BASE, "g1")).toEqual({ ok: true, code: "code000code0" });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/g1/invite`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  });
});

describe("refreshInvite", () => {
  it("POSTs {refresh:true} and returns the rotated code", async () => {
    const mock = stubFetch({ ok: true, code: "newnewnewnew" });
    expect(await refreshInvite(BASE, "g1")).toEqual({ ok: true, code: "newnewnewnew" });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/g1/invite`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh: true }),
    });
  });
  it("returns {error:'network'} on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await refreshInvite(BASE, "g1")).toEqual({ error: "network" });
  });
});

describe("revokeInvite", () => {
  it("DELETEs the invite and returns ok", async () => {
    const mock = stubFetch({ ok: true });
    expect(await revokeInvite(BASE, "g1")).toEqual({ ok: true });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/g1/invite`, { method: "DELETE", credentials: "include" });
  });
  it("returns {error:'network'} on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await revokeInvite(BASE, "g1")).toEqual({ error: "network" });
  });
});

describe("getInviteByCode", () => {
  it("returns the InvitePreview (encoded code in the GET path)", async () => {
    const preview = { chatId: "g1", type: "group", name: "Team", memberCount: 4 };
    const mock = stubFetch(preview);
    expect(await getInviteByCode(BASE, "co de/1")).toEqual(preview);
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/invite/co%20de%2F1`, { credentials: "include" });
  });
  it("passes through a {error:'bad_invite'} for a dead/unknown code", async () => {
    stubFetch({ error: "bad_invite" });
    expect(await getInviteByCode(BASE, "dead")).toEqual({ error: "bad_invite" });
  });
  it("degrades to {error:'bad_invite'} on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await getInviteByCode(BASE, "x")).toEqual({ error: "bad_invite" });
  });
});

describe("acceptInvite", () => {
  it("POSTs /accept (credentialed, no body) and returns the chatId", async () => {
    const mock = stubFetch({ ok: true, chatId: "g1", joined: true });
    expect(await acceptInvite(BASE, "abc")).toEqual({ ok: true, chatId: "g1", joined: true });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/invite/abc/accept`, { method: "POST", credentials: "include" });
  });
  it("surfaces a bad_invite (dead code)", async () => {
    stubFetch({ error: "bad_invite" });
    expect(await acceptInvite(BASE, "dead")).toEqual({ error: "bad_invite" });
  });
  it("returns {error:'network'} on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await acceptInvite(BASE, "abc")).toEqual({ error: "network" });
  });
});

describe("requestJoin", () => {
  it("POSTs /request (no body) and returns the pending status", async () => {
    const mock = stubFetch({ ok: true, status: "pending" });
    expect(await requestJoin(BASE, "g1")).toEqual({ ok: true, status: "pending" });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/g1/request`, { method: "POST", credentials: "include" });
  });
  it("surfaces already_member / not_requestable error codes", async () => {
    stubFetch({ error: "already_member" });
    expect(await requestJoin(BASE, "g1")).toEqual({ error: "already_member" });
  });
  it("returns {error:'network'} on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await requestJoin(BASE, "g1")).toEqual({ error: "network" });
  });
});

describe("getRequests", () => {
  it("returns the pending requests array", async () => {
    const requests = [
      { id: "r1", userId: "u2", username: "bob", displayName: "Bob", avatarUrl: null, status: "pending", createdAt: 5 },
    ];
    const mock = stubFetch({ requests });
    expect(await getRequests(BASE, "g1")).toEqual(requests);
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/g1/requests`, { credentials: "include" });
  });
  it("defaults to [] when the body has no requests (e.g. a 403 for a non-admin)", async () => {
    stubFetch({ error: "forbidden" });
    expect(await getRequests(BASE, "g1")).toEqual([]);
  });
  it("returns [] on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await getRequests(BASE, "g1")).toEqual([]);
  });
});

describe("approveRequest", () => {
  it("POSTs /approve and returns the added userId", async () => {
    const mock = stubFetch({ ok: true, userId: "u2" });
    expect(await approveRequest(BASE, "g1", "r1")).toEqual({ ok: true, userId: "u2" });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/g1/requests/r1/approve`, { method: "POST", credentials: "include" });
  });
  it("surfaces a request_not_found (already decided)", async () => {
    stubFetch({ error: "request_not_found" });
    expect(await approveRequest(BASE, "g1", "r1")).toEqual({ error: "request_not_found" });
  });
  it("returns {error:'network'} on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await approveRequest(BASE, "g1", "r1")).toEqual({ error: "network" });
  });
});

describe("rejectRequest", () => {
  it("POSTs /reject and returns ok", async () => {
    const mock = stubFetch({ ok: true });
    expect(await rejectRequest(BASE, "g1", "r1")).toEqual({ ok: true });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/g1/requests/r1/reject`, { method: "POST", credentials: "include" });
  });
  it("returns {error:'network'} on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await rejectRequest(BASE, "g1", "r1")).toEqual({ error: "network" });
  });
});

describe("getPrivacy", () => {
  it("returns the allowAutoGroupAdd flag as sent", async () => {
    const mock = stubFetch({ allowAutoGroupAdd: false });
    expect(await getPrivacy(BASE)).toEqual({ allowAutoGroupAdd: false });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/account/privacy`, { credentials: "include" });
  });
  it("defaults to true when the flag is present-and-true", async () => {
    stubFetch({ allowAutoGroupAdd: true });
    expect(await getPrivacy(BASE)).toEqual({ allowAutoGroupAdd: true });
  });
  it("defaults to true when the flag is absent", async () => {
    stubFetch({});
    expect(await getPrivacy(BASE)).toEqual({ allowAutoGroupAdd: true });
  });
  it("defaults to true on a network error (safe default)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await getPrivacy(BASE)).toEqual({ allowAutoGroupAdd: true });
  });
});

describe("setPrivacy", () => {
  it("POSTs the boolean and returns the echoed result", async () => {
    const mock = stubFetch({ ok: true, allowAutoGroupAdd: false });
    expect(await setPrivacy(BASE, false)).toEqual({ ok: true, allowAutoGroupAdd: false });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/account/privacy`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowAutoGroupAdd: false }),
    });
  });
  it("returns {error:'network'} on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await setPrivacy(BASE, true)).toEqual({ error: "network" });
  });
});

// ---- Slice 8: forward messages ------------------------------------------------

describe("forwardMessages", () => {
  it("POSTs {messages:[{body}]} (encoded target id) and returns the count", async () => {
    const mock = stubFetch({ forwarded: 2 });
    expect(await forwardMessages(BASE, "t 1", ["one", "two"])).toEqual({ forwarded: 2 });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/t%201/forward`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ body: "one" }, { body: "two" }] }),
    });
  });
  it("sends an empty messages array when given no bodies", async () => {
    const mock = stubFetch({ forwarded: 0 });
    expect(await forwardMessages(BASE, "t1", [])).toEqual({ forwarded: 0 });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/t1/forward`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
  });
  it("surfaces a 403 error code (forbidden / read_only)", async () => {
    stubFetch({ error: "read_only" });
    expect(await forwardMessages(BASE, "t1", ["hi"])).toEqual({ error: "read_only" });
  });
  it("returns {error:'network'} on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await forwardMessages(BASE, "t1", ["hi"])).toEqual({ error: "network" });
  });
});

// ---- Slice 9: within-chat search + account deletion ---------------------------

describe("searchChat", () => {
  it("GETs the trimmed+encoded query (member-gated) and returns the messages", async () => {
    const messages = [
      { id: "m1", chatId: "c1", senderId: "u2", body: "found hello", createdAt: 1000, reactions: [{ emoji: "👍", count: 1, mine: false }] },
    ];
    const mock = stubFetch({ messages });
    expect(await searchChat(BASE, "c 1", "  hello ")).toEqual(messages);
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/chats/c%201/search?q=hello`, { credentials: "include" });
  });
  it("short-circuits a blank query to [] WITHOUT a request", async () => {
    const mock = stubFetch({ messages: [{ id: "x" }] });
    expect(await searchChat(BASE, "c1", "   ")).toEqual([]);
    expect(mock).not.toHaveBeenCalled();
  });
  it("defaults to [] when the body has no messages", async () => {
    stubFetch({});
    expect(await searchChat(BASE, "c1", "hi")).toEqual([]);
  });
  it("returns [] on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await searchChat(BASE, "c1", "hi")).toEqual([]);
  });
});

describe("deleteAccount", () => {
  it("POSTs {confirm:true} and returns ok", async () => {
    const mock = stubFetch({ ok: true });
    expect(await deleteAccount(BASE)).toEqual({ ok: true });
    expect(mock).toHaveBeenCalledWith(`${BASE}/api/account/delete`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
  });
  it("surfaces a server error code (confirm_required / bad_json)", async () => {
    stubFetch({ error: "confirm_required" });
    expect(await deleteAccount(BASE)).toEqual({ error: "confirm_required" });
  });
  it("returns {error:'network'} on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await deleteAccount(BASE)).toEqual({ error: "network" });
  });
});

describe("applyReaction", () => {
  it("adds a brand-new pill from an empty/undefined list (mine on my own add)", () => {
    expect(applyReaction(undefined, "👍", true, true)).toEqual([{ emoji: "👍", count: 1, mine: true }]);
    expect(applyReaction([], "🎉", true, false)).toEqual([{ emoji: "🎉", count: 1, mine: false }]);
  });
  it("bumps an existing pill's count when a DIFFERENT user adds the same emoji", () => {
    const start: Reaction[] = [{ emoji: "👍", count: 1, mine: true }];
    expect(applyReaction(start, "👍", true, false)).toEqual([{ emoji: "👍", count: 2, mine: true }]);
  });
  it("sets mine=true when I add to a pill others already have", () => {
    const start: Reaction[] = [{ emoji: "❤️", count: 2, mine: false }];
    expect(applyReaction(start, "❤️", true, true)).toEqual([{ emoji: "❤️", count: 3, mine: true }]);
  });
  it("dedupes a redundant add of MY reaction the pill already reflects (broadcast echo)", () => {
    const start: Reaction[] = [{ emoji: "👍", count: 1, mine: true }];
    // Optimistic already set mine:true+count:1; the confirming broadcast is a no-op.
    expect(applyReaction(start, "👍", true, true)).toBe(start);
  });
  it("removes one from a shared pill and clears mine when it was mine", () => {
    const start: Reaction[] = [{ emoji: "😂", count: 3, mine: true }];
    expect(applyReaction(start, "😂", false, true)).toEqual([{ emoji: "😂", count: 2, mine: false }]);
  });
  it("drops the pill entirely when the last reactor removes it", () => {
    const start: Reaction[] = [{ emoji: "😮", count: 1, mine: true }];
    expect(applyReaction(start, "😮", false, true)).toEqual([]);
  });
  it("a foreign remove decrements the count but leaves my mine flag intact", () => {
    const start: Reaction[] = [{ emoji: "🎉", count: 2, mine: true }];
    expect(applyReaction(start, "🎉", false, false)).toEqual([{ emoji: "🎉", count: 1, mine: true }]);
  });
  it("dedupes a redundant remove I already reflected, and no-ops a remove of a missing pill", () => {
    const notMine: Reaction[] = [{ emoji: "👍", count: 1, mine: false }];
    expect(applyReaction(notMine, "👍", false, true)).toBe(notMine); // my remove already reflected
    const other: Reaction[] = [{ emoji: "❤️", count: 1, mine: false }];
    expect(applyReaction(other, "👍", false, false)).toBe(other); // nothing to remove
  });
  it("leaves OTHER pills untouched when toggling one among several", () => {
    const many: Reaction[] = [
      { emoji: "👍", count: 2, mine: false },
      { emoji: "❤️", count: 1, mine: true },
    ];
    // Add to 👍 — ❤️ passes through the map's else-arm unchanged.
    expect(applyReaction(many, "👍", true, true)).toEqual([
      { emoji: "👍", count: 3, mine: true },
      { emoji: "❤️", count: 1, mine: true },
    ]);
    // Remove from 👍 (count>1) — ❤️ again untouched.
    expect(applyReaction(many, "👍", false, false)).toEqual([
      { emoji: "👍", count: 1, mine: false },
      { emoji: "❤️", count: 1, mine: true },
    ]);
  });
});
