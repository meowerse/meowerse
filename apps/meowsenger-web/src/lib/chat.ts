// Typed REST + WebSocket helpers for the chat UI. All fetches are credentialed
// so the __Host-mw_session cookie rides along (same-origin worker). This is the
// only unit-tested frontend code (>=90% on src/lib/**); the React islands are
// validated by astro check + build.

/** A chat summary as rendered in the sidebar (mirrors the worker's ChatSummary). */
export interface ChatSummary {
  id: string;
  // 'direct' (a 1:1 DM) or 'group' (a named group chat — Slice 5).
  type: string;
  // The group's display name (null for DMs — those render the peer's name instead).
  name: string | null;
  lastMessage: string | null;
  lastSenderId: string | null;
  lastActivity: number;
  unreadCount: number;
  // Member count for a group (undefined for DMs). Optional so an older list payload
  // without it still parses; the header/drawer prefer the live members fetch.
  memberCount?: number;
  // DM peer identity (null for groups — Slice 5). `peerId` is the other member's
  // user_id — presence/read WS frames key on this, so the UI maps `{userId}`→peer.
  peerId: string | null;
  peerUsername: string | null;
  peerDisplayName: string | null;
  peerAvatarUrl: string | null;
}

/** A group member with identity + role (mirrors the worker's MemberView). */
export interface Member {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  // 'owner' | 'admin' | 'member' — the caller's own role gates the drawer actions.
  role: string;
  joinedAt: number;
}

/** A short quoted snippet of the message a reply points at (mirrors the DO). */
export interface ReplySnippet {
  id: string;
  senderId: string;
  body: string;
}

/** A message on the wire / out of history (mirrors the DO's Wire shape). */
export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  body: string;
  createdAt: number;
  // Slice 4 — reply/edit/delete. `replyToId`+`replyTo` describe the quoted parent;
  // `editedAt` is set once a message was edited; `isDeleted` marks a soft-deleted
  // message (its `body` arrives as "" — the UI renders a "message deleted" placeholder).
  replyToId?: string | null;
  replyTo?: ReplySnippet | null;
  editedAt?: number | null;
  isDeleted?: boolean;
}

/** GET /api/chats — the caller's sidebar list. Empty array on any failure. */
export async function listChats(base: string): Promise<ChatSummary[]> {
  try {
    const r = await fetch(`${base}/api/chats`, { credentials: "include" });
    const d = (await r.json()) as { chats?: ChatSummary[] };
    return d.chats ?? [];
  } catch {
    return [];
  }
}

/** POST /api/chats { username } — open-or-create a DM. Returns the chatId or an error code. */
export async function openDirect(base: string, username: string): Promise<{ chatId?: string; error?: string }> {
  try {
    const r = await fetch(`${base}/api/chats`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
    return (await r.json()) as { chatId?: string; error?: string };
  } catch {
    return { error: "network" };
  }
}

/** GET /api/chats/:id/messages?before= — a history page (ascending), oldest first. */
export async function loadHistory(base: string, chatId: string, before?: string): Promise<Message[]> {
  try {
    const q = before ? `?before=${encodeURIComponent(before)}` : "";
    const r = await fetch(`${base}/api/chats/${encodeURIComponent(chatId)}/messages${q}`, { credentials: "include" });
    const d = (await r.json()) as { messages?: Message[] };
    return d.messages ?? [];
  } catch {
    return [];
  }
}

/**
 * WebSocket URL for a chat on the SAME origin as the API. `base` is "" in prod
 * (UI + BFF are one worker), so fall back to `location.origin`. `http`→`ws` /
 * `https`→`wss` via a single prefix swap.
 */
export function wsUrl(base: string, chatId: string): string {
  const origin = base || (typeof location !== "undefined" ? location.origin : "");
  const wsOrigin = origin.replace(/^http/, "ws");
  return `${wsOrigin}/ws?chat=${encodeURIComponent(chatId)}`;
}

// ---- Slice 5: group creation + member management + metadata ----------------

/**
 * Client-side mirror of `@meowerse/ts-shared`'s `slugify` — the worker normalizes
 * server-side, but the modal/drawer normalize as the user types so the live
 * availability check and the submitted value match what the server will store.
 * Lowercases, collapses non-alphanumeric runs to "-", and trims edge dashes.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * POST /api/chats { type:"group", name, members, visibility?, slug? } — create a
 * named group with the caller as owner. Returns the new chatId or an error code
 * (e.g. name_required / user_not_found / bad_slug / slug_taken).
 */
export async function createGroup(
  base: string,
  input: { name: string; members: string[]; visibility?: string; slug?: string | null },
): Promise<{ chatId?: string; error?: string; username?: string }> {
  try {
    const r = await fetch(`${base}/api/chats`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "group", ...input }),
    });
    return (await r.json()) as { chatId?: string; error?: string; username?: string };
  } catch {
    return { error: "network" };
  }
}

/** GET /api/chats/:id/members — the group roster. Empty array on any failure. */
export async function getMembers(base: string, chatId: string): Promise<Member[]> {
  try {
    const r = await fetch(`${base}/api/chats/${encodeURIComponent(chatId)}/members`, { credentials: "include" });
    const d = (await r.json()) as { members?: Member[] };
    return d.members ?? [];
  } catch {
    return [];
  }
}

/** POST /api/chats/:id/members { username } — add a member (owner/admin). */
export async function addMember(
  base: string,
  chatId: string,
  username: string,
): Promise<{ ok?: boolean; userId?: string; error?: string }> {
  try {
    const r = await fetch(`${base}/api/chats/${encodeURIComponent(chatId)}/members`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.trim() }),
    });
    return (await r.json()) as { ok?: boolean; userId?: string; error?: string };
  } catch {
    return { error: "network" };
  }
}

/** DELETE /api/chats/:id/members/:userId — remove a member (per authz). */
export async function removeMember(
  base: string,
  chatId: string,
  userId: string,
): Promise<{ ok?: boolean; error?: string }> {
  try {
    const r = await fetch(
      `${base}/api/chats/${encodeURIComponent(chatId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE", credentials: "include" },
    );
    return (await r.json()) as { ok?: boolean; error?: string };
  } catch {
    return { error: "network" };
  }
}

/** POST /api/chats/:id/members/:userId/role { role } — promote/demote (owner). */
export async function setMemberRole(
  base: string,
  chatId: string,
  userId: string,
  role: "admin" | "member",
): Promise<{ ok?: boolean; error?: string }> {
  try {
    const r = await fetch(
      `${base}/api/chats/${encodeURIComponent(chatId)}/members/${encodeURIComponent(userId)}/role`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      },
    );
    return (await r.json()) as { ok?: boolean; error?: string };
  } catch {
    return { error: "network" };
  }
}

/** POST /api/chats/:id/leave — the caller leaves (owner-transfer / delete server-side). */
export async function leaveChat(
  base: string,
  chatId: string,
): Promise<{ ok?: boolean; transferredTo?: string | null; deleted?: boolean; error?: string }> {
  try {
    const r = await fetch(`${base}/api/chats/${encodeURIComponent(chatId)}/leave`, {
      method: "POST",
      credentials: "include",
    });
    return (await r.json()) as { ok?: boolean; transferredTo?: string | null; deleted?: boolean; error?: string };
  } catch {
    return { error: "network" };
  }
}

/** PATCH /api/chats/:id { name?, visibility?, slug? } — edit metadata (owner/admin). */
export async function updateChat(
  base: string,
  chatId: string,
  patch: { name?: string; visibility?: string; slug?: string | null },
): Promise<{ ok?: boolean; slug?: string | null; error?: string }> {
  try {
    const r = await fetch(`${base}/api/chats/${encodeURIComponent(chatId)}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return (await r.json()) as { ok?: boolean; slug?: string | null; error?: string };
  } catch {
    return { error: "network" };
  }
}

/** GET /api/slug-available?slug= — is a (normalized) slug free? False on any error. */
export async function slugAvailable(base: string, slug: string): Promise<boolean> {
  try {
    const r = await fetch(`${base}/api/slug-available?slug=${encodeURIComponent(slug)}`, { credentials: "include" });
    const d = (await r.json()) as { available?: boolean };
    return d.available === true;
  } catch {
    return false;
  }
}

/**
 * Resolve a single username → open-or-create a DM, reusing `openDirect`. There is
 * no fuzzy user-search endpoint in v1 (exact username only), so the member picker
 * and Direct tab both resolve exact usernames; this thin alias keeps call sites
 * intention-revealing and gives a single seam if a real search lands later.
 */
export async function searchUsers(base: string, username: string): Promise<{ chatId?: string; error?: string }> {
  return openDirect(base, username);
}
