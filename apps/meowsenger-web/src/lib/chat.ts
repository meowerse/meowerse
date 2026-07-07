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

/**
 * The public preview of a discoverable chat (mirrors the worker's `ChatPreview`).
 * Carries NO message content — discovery must never leak the log. `isMember`
 * reflects the *caller*. Returned by GET /api/chats/by-slug/:slug for public chats
 * (to anyone signed in) or any chat the caller is already a member of.
 */
export interface ChatPreview {
  id: string;
  // 'direct' | 'group' | 'channel'.
  type: string;
  name: string | null;
  memberCount: number;
  visibility: string;
  isMember: boolean;
  // Slice 7 — for a private+slug chat viewed by a non-member: the server marks it
  // "discoverable but gated" so the UI can offer "request access". `requestStatus`
  // is the caller's own standing (none|pending|approved|rejected). Public chats and
  // members omit both.
  canRequest?: boolean;
  requestStatus?: RequestStatus;
}

/** The caller's own join-request status for a chat (mirrors the worker). */
export type RequestStatus = "none" | "pending" | "approved" | "rejected";

/**
 * The public-safe preview of an invite code (mirrors the worker's `InviteView`).
 * Carries NO bodies/membership — a code only reveals what it already grants. A
 * 12-char code lets its holder JOIN directly, bypassing the visibility gate.
 */
export interface InvitePreview {
  chatId: string;
  // 'direct' | 'group' | 'channel'.
  type: string;
  name: string | null;
  memberCount: number;
}

/**
 * A pending join request as surfaced to owner/admin (mirrors the worker's
 * `JoinRequestView`) — the requester's identity + when they asked. `id` is the
 * request id (used in the approve/reject routes), distinct from `userId`.
 */
export interface JoinRequest {
  id: string;
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: string;
  createdAt: number;
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

/**
 * An aggregated emoji reaction on a message (mirrors the DO's `ReactionAgg`):
 * the emoji, how many users reacted with it, and whether the *viewer* is one of
 * them (`mine`). History/search/message rows carry a `reactions` array; the UI
 * renders one pill per entry and highlights `mine` ones. (Slice 9.)
 */
export interface Reaction {
  emoji: string;
  count: number;
  mine: boolean;
}

/**
 * Apply a single reaction toggle to a message's aggregated `reactions` array
 * (Slice 9). `on:true` adds the (viewer/other, emoji) pair, `on:false` removes it;
 * the count moves by one and a pill that falls to zero is dropped. `isMine` flips
 * the pill's `mine` flag only when the toggling user is the viewer.
 *
 * This is the ONE reducer used by BOTH the optimistic own-toggle AND the incoming
 * `reaction` broadcast — so the server echo that merely confirms our own optimistic
 * toggle is a no-op. Dedupe is by userId+emoji: for the viewer we key on the pill's
 * current `mine` (already on → skip the add; already off → skip the remove). Pure —
 * returns a fresh array and never mutates the input.
 */
export function applyReaction(
  reactions: Reaction[] | undefined,
  emoji: string,
  on: boolean,
  isMine: boolean,
): Reaction[] {
  const list = reactions ?? [];
  const existing = list.find((r) => r.emoji === emoji);
  if (on) {
    if (existing) {
      if (isMine && existing.mine) return list; // our add already reflected — dedupe
      return list.map((r) =>
        r.emoji === emoji ? { ...r, count: r.count + 1, mine: r.mine || isMine } : r,
      );
    }
    return [...list, { emoji, count: 1, mine: isMine }];
  }
  if (!existing) return list;
  if (isMine && !existing.mine) return list; // our remove already reflected — dedupe
  const nextCount = existing.count - 1;
  if (nextCount <= 0) return list.filter((r) => r.emoji !== emoji);
  return list.map((r) =>
    r.emoji === emoji ? { ...r, count: nextCount, mine: isMine ? false : r.mine } : r,
  );
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
  // Slice 8 — set when this message was created by a forward (POST .../forward).
  // The UI renders a small "forwarded" tag; the body/quoted-reply are unaffected.
  isForwarded?: boolean;
  // Slice 9 — aggregated emoji reactions on this message (present on history/
  // search rows; omitted on the live send/forward wire, which carries none yet).
  // The UI renders reaction pills below the bubble; `reaction` frames mutate it.
  reactions?: Reaction[];
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

/**
 * POST /api/chats { type:"channel", name, members?, visibility?, slug? } — create a
 * broadcast channel with the caller as owner. A channel is a group where only
 * owner/admin post (the DO enforces the read-only rule for `member`); it's created
 * exactly like a group otherwise. Returns the new chatId or an error code.
 */
export async function createChannel(
  base: string,
  input: { name: string; members?: string[]; visibility?: string; slug?: string | null },
): Promise<{ chatId?: string; error?: string; username?: string }> {
  try {
    const r = await fetch(`${base}/api/chats`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "channel", ...input }),
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

/**
 * POST /api/chats/:id/members { username } — add a member (owner/admin). Slice 7:
 * if the target opted out of direct adds (`allow_auto_group_add=0`) they are NOT
 * added — the server returns `{ok:true, invited:true, inviteCode}` so the actor can
 * share the invite link instead. A normal add omits both fields.
 */
export async function addMember(
  base: string,
  chatId: string,
  username: string,
): Promise<{ ok?: boolean; userId?: string; invited?: boolean; inviteCode?: string; error?: string }> {
  try {
    const r = await fetch(`${base}/api/chats/${encodeURIComponent(chatId)}/members`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.trim() }),
    });
    return (await r.json()) as { ok?: boolean; userId?: string; invited?: boolean; inviteCode?: string; error?: string };
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

// ---- Slice 6: public discovery + open-join ---------------------------------

/**
 * GET /api/chats/by-slug/:slug — resolve a chat for discovery. Returns a
 * `ChatPreview` for a public chat (to any signed-in caller) or any chat the caller
 * is a member of; `{error:"private"}` for a private-non-member or unknown slug
 * (the two are deliberately indistinguishable — no existence leak). Any network
 * failure also degrades to `{error:"private"}` (the safe, no-leak default) — the
 * lock card is shown rather than a spurious preview. The preview carries no messages.
 */
export async function getBySlug(base: string, slug: string): Promise<ChatPreview | { error: string }> {
  try {
    const r = await fetch(`${base}/api/chats/by-slug/${encodeURIComponent(slug)}`, { credentials: "include" });
    const d = (await r.json()) as ChatPreview | { error?: string };
    if ("error" in d && d.error) return { error: d.error };
    return d as ChatPreview;
  } catch {
    return { error: "private" };
  }
}

/**
 * POST /api/chats/:id/join — open-join a PUBLIC chat as a plain member. Idempotent
 * (an already-member returns ok). A private/unknown chat is refused with
 * `{error:"must_request"}` (403). The `/subscribe` alias (channels) is the same
 * server operation; the UI calls `/join` for both and just labels the button.
 */
export async function joinChat(
  base: string,
  chatId: string,
): Promise<{ ok?: boolean; joined?: boolean; error?: string }> {
  try {
    const r = await fetch(`${base}/api/chats/${encodeURIComponent(chatId)}/join`, {
      method: "POST",
      credentials: "include",
    });
    return (await r.json()) as { ok?: boolean; joined?: boolean; error?: string };
  } catch {
    return { error: "network" };
  }
}

// ---- Slice 7: invite links, join requests, privacy -------------------------

/**
 * POST /api/chats/:id/invite — owner/admin get-or-create the chat's invite code
 * (idempotent: an already-live code is returned unchanged). Returns `{code}` or an
 * error code (forbidden / not_member). Creating on demand seeds the invite section.
 */
export async function createInvite(
  base: string,
  chatId: string,
): Promise<{ ok?: boolean; code?: string; error?: string }> {
  try {
    const r = await fetch(`${base}/api/chats/${encodeURIComponent(chatId)}/invite`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    return (await r.json()) as { ok?: boolean; code?: string; error?: string };
  } catch {
    return { error: "network" };
  }
}

/**
 * `getInvite` is `createInvite` — the server's get-or-create is idempotent, so
 * there's no separate read endpoint; the drawer calls this to surface the current
 * link (creating one on first open). A thin alias keeps call sites intention-revealing.
 */
export async function getInvite(
  base: string,
  chatId: string,
): Promise<{ ok?: boolean; code?: string; error?: string }> {
  return createInvite(base, chatId);
}

/**
 * POST /api/chats/:id/invite {refresh:true} — rotate the invite code (owner/admin).
 * The old link stops resolving; a fresh `{code}` is returned.
 */
export async function refreshInvite(
  base: string,
  chatId: string,
): Promise<{ ok?: boolean; code?: string; error?: string }> {
  try {
    const r = await fetch(`${base}/api/chats/${encodeURIComponent(chatId)}/invite`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh: true }),
    });
    return (await r.json()) as { ok?: boolean; code?: string; error?: string };
  } catch {
    return { error: "network" };
  }
}

/** DELETE /api/chats/:id/invite — revoke the invite code (owner/admin). */
export async function revokeInvite(
  base: string,
  chatId: string,
): Promise<{ ok?: boolean; error?: string }> {
  try {
    const r = await fetch(`${base}/api/chats/${encodeURIComponent(chatId)}/invite`, {
      method: "DELETE",
      credentials: "include",
    });
    return (await r.json()) as { ok?: boolean; error?: string };
  } catch {
    return { error: "network" };
  }
}

/**
 * GET /api/invite/:code — resolve a code to an `InvitePreview` (no bodies). An
 * unknown or revoked code → `{error:"bad_invite"}` (indistinguishable, so a dead
 * link leaks nothing). Any network failure degrades to `{error:"bad_invite"}`.
 */
export async function getInviteByCode(
  base: string,
  code: string,
): Promise<InvitePreview | { error: string }> {
  try {
    const r = await fetch(`${base}/api/invite/${encodeURIComponent(code)}`, { credentials: "include" });
    const d = (await r.json()) as InvitePreview | { error?: string };
    if ("error" in d && d.error) return { error: d.error };
    return d as InvitePreview;
  } catch {
    return { error: "bad_invite" };
  }
}

/**
 * POST /api/invite/:code/accept — join by invite (bypasses the visibility gate).
 * Idempotent (an already-member returns ok). Returns `{chatId}` to open, or an
 * error code (bad_invite) for a dead/unknown code.
 */
export async function acceptInvite(
  base: string,
  code: string,
): Promise<{ ok?: boolean; chatId?: string; joined?: boolean; error?: string }> {
  try {
    const r = await fetch(`${base}/api/invite/${encodeURIComponent(code)}/accept`, {
      method: "POST",
      credentials: "include",
    });
    return (await r.json()) as { ok?: boolean; chatId?: string; joined?: boolean; error?: string };
  } catch {
    return { error: "network" };
  }
}

/**
 * POST /api/chats/:id/request — request to join a private+slug ("discoverable but
 * gated") chat. Idempotent — an existing pending row is reused. Returns
 * `{status:"pending"}` or an error code (already_member / open_join / not_requestable).
 */
export async function requestJoin(
  base: string,
  chatId: string,
): Promise<{ ok?: boolean; status?: string; error?: string }> {
  try {
    const r = await fetch(`${base}/api/chats/${encodeURIComponent(chatId)}/request`, {
      method: "POST",
      credentials: "include",
    });
    return (await r.json()) as { ok?: boolean; status?: string; error?: string };
  } catch {
    return { error: "network" };
  }
}

/** GET /api/chats/:id/requests — owner/admin list pending join requests. Empty on error. */
export async function getRequests(base: string, chatId: string): Promise<JoinRequest[]> {
  try {
    const r = await fetch(`${base}/api/chats/${encodeURIComponent(chatId)}/requests`, { credentials: "include" });
    const d = (await r.json()) as { requests?: JoinRequest[] };
    return d.requests ?? [];
  } catch {
    return [];
  }
}

/** POST /api/chats/:id/requests/:rid/approve — owner/admin approve (adds the requester). */
export async function approveRequest(
  base: string,
  chatId: string,
  requestId: string,
): Promise<{ ok?: boolean; userId?: string; error?: string }> {
  try {
    const r = await fetch(
      `${base}/api/chats/${encodeURIComponent(chatId)}/requests/${encodeURIComponent(requestId)}/approve`,
      { method: "POST", credentials: "include" },
    );
    return (await r.json()) as { ok?: boolean; userId?: string; error?: string };
  } catch {
    return { error: "network" };
  }
}

/** POST /api/chats/:id/requests/:rid/reject — owner/admin reject a pending request. */
export async function rejectRequest(
  base: string,
  chatId: string,
  requestId: string,
): Promise<{ ok?: boolean; error?: string }> {
  try {
    const r = await fetch(
      `${base}/api/chats/${encodeURIComponent(chatId)}/requests/${encodeURIComponent(requestId)}/reject`,
      { method: "POST", credentials: "include" },
    );
    return (await r.json()) as { ok?: boolean; error?: string };
  } catch {
    return { error: "network" };
  }
}

/**
 * GET /api/account/privacy — the caller's `allowAutoGroupAdd` preference (whether
 * others can add them to groups directly). Defaults to `true` on any failure — the
 * safe, non-surprising default (matches the server column default).
 */
export async function getPrivacy(base: string): Promise<{ allowAutoGroupAdd: boolean }> {
  try {
    const r = await fetch(`${base}/api/account/privacy`, { credentials: "include" });
    const d = (await r.json()) as { allowAutoGroupAdd?: boolean };
    return { allowAutoGroupAdd: d.allowAutoGroupAdd !== false };
  } catch {
    return { allowAutoGroupAdd: true };
  }
}

/** POST /api/account/privacy { allowAutoGroupAdd } — set the caller's preference. */
export async function setPrivacy(
  base: string,
  allow: boolean,
): Promise<{ ok?: boolean; allowAutoGroupAdd?: boolean; error?: string }> {
  try {
    const r = await fetch(`${base}/api/account/privacy`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowAutoGroupAdd: allow }),
    });
    return (await r.json()) as { ok?: boolean; allowAutoGroupAdd?: boolean; error?: string };
  } catch {
    return { error: "network" };
  }
}

// ---- Slice 8: forward messages ---------------------------------------------

/**
 * POST /api/chats/:id/forward { messages:[{body}] } — forward one or more message
 * bodies into a target chat. The caller must be a member of the target (a channel
 * additionally requires owner/admin — the server enforces both and answers 403).
 * Each forwarded message is appended with `is_forwarded=1` so it carries the
 * "forwarded" badge and broadcasts to live members. Returns `{forwarded:count}`
 * (blank/over-long bodies are skipped server-side; the batch is capped at 20), or
 * an error code (bad_json / bad_messages / forbidden / read_only). Network failure
 * degrades to `{error:"network"}`.
 */
export async function forwardMessages(
  base: string,
  targetId: string,
  bodies: string[],
): Promise<{ forwarded?: number; error?: string }> {
  try {
    const r = await fetch(`${base}/api/chats/${encodeURIComponent(targetId)}/forward`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: bodies.map((body) => ({ body })) }),
    });
    return (await r.json()) as { forwarded?: number; error?: string };
  } catch {
    return { error: "network" };
  }
}

// ---- Slice 9: within-chat search + account deletion ------------------------

/**
 * GET /api/chats/:id/search?q= — within-chat message search (member-gated,
 * server-side — plaintext bodies make it possible). Returns the matching
 * messages newest-first (each a full `Message` with `reactions`), or [] for a
 * blank query, a non-member (403), or any failure. `q` is trimmed here so a
 * whitespace-only search short-circuits to [] without a request.
 */
export async function searchChat(base: string, chatId: string, q: string): Promise<Message[]> {
  const query = q.trim();
  if (!query) return [];
  try {
    const r = await fetch(
      `${base}/api/chats/${encodeURIComponent(chatId)}/search?q=${encodeURIComponent(query)}`,
      { credentials: "include" },
    );
    const d = (await r.json()) as { messages?: Message[] };
    return d.messages ?? [];
  } catch {
    return [];
  }
}

/**
 * POST /api/account/delete { confirm:true } — erase the caller's meowsenger data
 * (memberships/join-requests/sessions/user + owned-chat handling) and clear the
 * session cookie. This is meowsenger-side deletion only — the auth account is
 * separate. Returns `{ok:true}` on success or an error code (confirm_required /
 * bad_json). Network failure degrades to `{error:"network"}`.
 */
export async function deleteAccount(base: string): Promise<{ ok?: boolean; error?: string }> {
  try {
    const r = await fetch(`${base}/api/account/delete`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    return (await r.json()) as { ok?: boolean; error?: string };
  } catch {
    return { error: "network" };
  }
}
