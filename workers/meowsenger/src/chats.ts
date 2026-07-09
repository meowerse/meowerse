import { slugify } from "@meowerse/ts-shared";
import type { DbClient, Row } from "./types";

/** A chat member as surfaced to the member drawer (JOIN chat_members × users). */
export interface MemberView {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: string;
  joinedAt: number;
}

/** Roles in strength order — index = rank, so `owner` > `admin` > `member`. */
export type Role = "owner" | "admin" | "member";
const ROLE_RANK: Record<string, number> = { owner: 2, admin: 1, member: 0 };
/** True iff `role` is at least `min` in the rank order (unknown roles → false). */
export function roleAtLeast(role: string | null | undefined, min: Role): boolean {
  if (role == null) return false;
  const r = ROLE_RANK[role];
  return r != null && r >= ROLE_RANK[min];
}

/** Slug format shared by validation + availability checks. */
export const SLUG_RE = /^[a-z0-9-]{3,32}$/;

export interface ChatSummary {
  id: string; type: string; name: string | null;
  lastMessage: string | null; lastSenderId: string | null; lastActivity: number;
  // Has-unread flag (0/1), derived lazily from last_activity vs the member's
  // last_read_at — NOT an exact count (that cost O(members) writes/message). The
  // sidebar renders it as a dot, not a number.
  unreadCount: number;
  // Slug (groups/channels only) + visibility, so the client can build a shareable
  // link (slug preferred, else id) without a round-trip. `peerLastSeenAt` is the DM
  // peer's last-connected ms (null if never / group) for the "last seen …" header.
  slug: string | null; visibility: string; peerLastSeenAt: number | null;
  // For a DM ('direct'), the OTHER member's identity so the sidebar can render a
  // name + avatar without a second round-trip. Null for groups (Slice 5).
  // `peerId` is the other member's user_id — the key presence/read frames use, so
  // the UI can map a `{userId}` frame back to this chat's peer.
  peerId: string | null;
  peerUsername: string | null;
  peerDisplayName: string | null;
  peerAvatarUrl: string | null;
}

/** Order-independent key for a 1:1 DM, so A+B and B+A resolve to one chat. */
export function directKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export async function createOrGetDirect(
  db: DbClient, me: string, other: string, now: number,
): Promise<{ id: string; created: boolean }> {
  const key = directKey(me, other);
  const existing = await db.first("SELECT id FROM chats WHERE direct_key = ?", [key]);
  if (existing) return { id: String(existing.id), created: false };
  const id = crypto.randomUUID();
  await db.run(
    "INSERT INTO chats (id, type, name, created_by, created_at, last_activity, direct_key) VALUES (?, 'direct', NULL, ?, ?, ?, ?)",
    [id, me, now, now, key],
  );
  // Both members in ONE multi-row INSERT (one D1 PRIMARY write instead of two).
  await db.run(
    "INSERT INTO chat_members (chat_id, user_id, role, unread_count, last_read_at, joined_at) VALUES (?, ?, 'member', 0, NULL, ?), (?, ?, 'member', 0, NULL, ?)",
    [id, me, now, id, other, now],
  );
  return { id, created: true };
}

/**
 * Off-critical-path mirror from the DO after a send, so the sidebar shows a preview.
 * ONE D1 row write (the chat's preview + last_activity). Deliberately does NOT bump
 * a per-member unread counter: that was O(members) writes per message and a single
 * busy group could exhaust the free-tier D1 write budget. "Has unread" is instead
 * derived lazily in `listChats` (last_activity > the member's last_read_at), which
 * costs zero extra writes — see the CASE in the sidebar query.
 */
export async function mirrorLastMessage(
  db: DbClient, chatId: string, body: string, senderId: string, now: number,
): Promise<void> {
  await db.run(
    "UPDATE chats SET last_message = ?, last_sender_id = ?, last_activity = ? WHERE id = ?",
    [body.slice(0, 140), senderId, now, chatId],
  );
}

/**
 * Mark a chat read up to a timestamp for one member by advancing `last_read_at`.
 * MONOTONIC + guarded: the WHERE only matches when this moves the cursor FORWARD
 * (or it was null), so a stale/duplicate `read` is a no-op — no wasted D1 write, and
 * a late-arriving lower `upTo` can't un-read the chat. Unread is derived from this
 * vs `last_activity` in `listChats` (see mirrorLastMessage).
 */
export async function markRead(db: DbClient, chatId: string, userId: string, upTo: number): Promise<void> {
  await db.run(
    "UPDATE chat_members SET last_read_at = ? WHERE chat_id = ? AND user_id = ? AND (last_read_at IS NULL OR last_read_at < ?)",
    [upTo, chatId, userId, upTo],
  );
}

export async function listChats(db: DbClient, userId: string): Promise<ChatSummary[]> {
  // For DMs, LEFT JOIN the OTHER member (chat_members om where om.user_id <> me)
  // and their user row so the sidebar shows the peer's name + avatar. For groups
  // there is more than one "other" member — the peer columns stay null (Slice 5
  // renders groups by their own name), so the join is scoped to type = 'direct'.
  const rows = await db.all(
    `SELECT c.id, c.type, c.name, c.slug, c.visibility, c.last_message, c.last_sender_id, c.last_activity,
            CASE WHEN c.last_activity > COALESCE(m.last_read_at, m.joined_at) THEN 1 ELSE 0 END AS unread_count,
            om.user_id AS peer_id,
            pu.username AS peer_username, pu.display_name AS peer_display_name, pu.avatar_url AS peer_avatar_url,
            pu.last_seen_at AS peer_last_seen_at
     FROM chat_members m
     JOIN chats c ON c.id = m.chat_id
     LEFT JOIN chat_members om ON om.chat_id = c.id AND om.user_id <> m.user_id AND c.type = 'direct'
     LEFT JOIN users pu ON pu.id = om.user_id
     WHERE m.user_id = ? ORDER BY c.last_activity DESC`,
    [userId],
  );
  return rows.map((r: Row) => ({
    id: String(r.id), type: String(r.type), name: r.name == null ? null : String(r.name),
    slug: r.slug == null ? null : String(r.slug),
    visibility: r.visibility == null ? "private" : String(r.visibility),
    lastMessage: r.last_message == null ? null : String(r.last_message),
    lastSenderId: r.last_sender_id == null ? null : String(r.last_sender_id),
    lastActivity: Number(r.last_activity), unreadCount: Number(r.unread_count ?? 0),
    peerId: r.peer_id == null ? null : String(r.peer_id),
    peerUsername: r.peer_username == null ? null : String(r.peer_username),
    peerDisplayName: r.peer_display_name == null ? null : String(r.peer_display_name),
    peerAvatarUrl: r.peer_avatar_url == null ? null : String(r.peer_avatar_url),
    peerLastSeenAt: r.peer_last_seen_at == null ? null : Number(r.peer_last_seen_at),
  }));
}

/** Is `userId` a member of `chatId`? (gate for /ws + history) */
export async function isMember(db: DbClient, chatId: string, userId: string): Promise<boolean> {
  const r = await db.first("SELECT 1 AS ok FROM chat_members WHERE chat_id = ? AND user_id = ?", [chatId, userId]);
  return !!r;
}

// ---- Slice 5: groups, roles, member views, metadata ----

/** Normalize a raw stored role value to a `Role`, or null when absent. An
 *  unrecognized non-null role clamps to `member` (the least-privileged), so an
 *  unexpected DB value can never grant elevated access. Shared by getRole/getRoles
 *  and the folded membership reads so they all agree on the mapping. */
function normalizeRole(raw: unknown): Role | null {
  if (raw == null) return null;
  const role = String(raw);
  return role === "owner" || role === "admin" || role === "member" ? role : "member";
}

/** The caller's role in a chat, or null if not a member. Authoritative — every
 *  mutation gates on this, never on a client-sent role. */
export async function getRole(db: DbClient, chatId: string, userId: string): Promise<Role | null> {
  const r = await db.first("SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?", [chatId, userId]);
  return r ? normalizeRole(r.role) : null;
}

/**
 * Resolve MULTIPLE users' roles in one chat with a SINGLE read (one `IN (…)`
 * query instead of N `getRole` round-trips). Returns a Map keyed by user id;
 * absent users (non-members) are simply not in the map, so `map.get(id) ?? null`
 * is the exact getRole-equivalent for each. Same per-user normalization as
 * getRole (unknown role → `member`). An empty `userIds` skips the query.
 */
export async function getRoles(db: DbClient, chatId: string, userIds: string[]): Promise<Map<string, Role>> {
  const map = new Map<string, Role>();
  if (userIds.length === 0) return map;
  const placeholders = userIds.map(() => "?").join(", ");
  const rows = await db.all(
    `SELECT user_id, role FROM chat_members WHERE chat_id = ? AND user_id IN (${placeholders})`,
    [chatId, ...userIds],
  );
  for (const r of rows) {
    const role = normalizeRole(r.role);
    if (role != null) map.set(String(r.user_id), role);
  }
  return map;
}

/** A chat's `type` ('direct'|'group'|'channel'), or null if the chat is unknown.
 *  The router reads this to forward `?type=` to the DO so the channel posting rule
 *  can be enforced there (Slice 6). */
export async function chatType(db: DbClient, chatId: string): Promise<string | null> {
  const r = await db.first("SELECT type FROM chats WHERE id = ?", [chatId]);
  return r ? String(r.type) : null;
}

/** Is a slug free? (nothing else already claims it). Empty/undefined → false. */
export async function slugAvailable(db: DbClient, slug: string): Promise<boolean> {
  if (!slug) return false;
  const r = await db.first("SELECT 1 AS ok FROM chats WHERE slug = ?", [slug]);
  return !r;
}

/** Normalize a slug via the shared slugify, then validate the format. Returns the
 *  normalized slug on success or null if it doesn't fit `^[a-z0-9-]{3,32}$`. */
export function normalizeSlug(raw: string): string | null {
  const s = slugify(raw);
  return SLUG_RE.test(s) ? s : null;
}

export interface CreateGroupInput {
  name: string;
  creatorId: string;
  memberIds: string[];
  visibility?: string;
  slug?: string | null;
  /** 'group' (default) or 'channel'. A channel is a broadcast group where only
   *  owner/admin may post (enforced in the DO); everything else — roles, members,
   *  visibility, slug, discovery, join — is shared with groups. */
  type?: "group" | "channel";
}

/**
 * Create a named group OR channel chat: the creator becomes `owner`, every other
 * member is added as `member`. `input.type` selects 'group' (default) or
 * 'channel' — the only difference at the data layer is the stored `type`; the
 * broadcast/read-only posting rule for channels is enforced in the DO. Slug (if
 * given) is normalized + uniqueness-checked. Returns the new chat id, or
 * `{error}` on bad input (invalid/taken slug).
 */
export async function createGroup(
  db: DbClient,
  input: CreateGroupInput,
  now: number,
): Promise<{ id: string } | { error: string }> {
  const name = input.name.trim();
  if (!name) return { error: "name_required" };
  const visibility = input.visibility === "public" ? "public" : "private";
  const type = input.type === "channel" ? "channel" : "group";

  let slug: string | null = null;
  if (input.slug != null && String(input.slug).trim() !== "") {
    const normalized = normalizeSlug(String(input.slug));
    if (!normalized) return { error: "bad_slug" };
    if (!(await slugAvailable(db, normalized))) return { error: "slug_taken" };
    slug = normalized;
  }

  const id = crypto.randomUUID();
  await db.run(
    "INSERT INTO chats (id, type, name, created_by, created_at, last_activity, direct_key, visibility, slug) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
    [id, type, name, input.creatorId, now, now, visibility, slug],
  );
  // Distinct members other than the creator, added as plain members.
  const others = [...new Set(input.memberIds)].filter((uid) => uid !== input.creatorId);
  // ONE multi-row INSERT: the creator as 'owner' plus every other member as
  // 'member' (a single D1 PRIMARY write instead of 1 + N sequential writes).
  const valueRows = ["(?, ?, 'owner', 0, NULL, ?)"];
  const args: unknown[] = [id, input.creatorId, now];
  for (const uid of others) {
    valueRows.push("(?, ?, 'member', 0, NULL, ?)");
    args.push(id, uid, now);
  }
  await db.run(
    `INSERT INTO chat_members (chat_id, user_id, role, unread_count, last_read_at, joined_at) VALUES ${valueRows.join(", ")}`,
    args,
  );
  return { id };
}

/** Members of a chat with their user identity, oldest-joined first. */
export async function listMembers(db: DbClient, chatId: string): Promise<MemberView[]> {
  const rows = await db.all(
    `SELECT m.user_id, m.role, m.joined_at,
            u.username, u.display_name, u.avatar_url
     FROM chat_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.chat_id = ? ORDER BY m.joined_at ASC`,
    [chatId],
  );
  return rows.map((r: Row) => ({
    userId: String(r.user_id),
    username: String(r.username),
    displayName: r.display_name == null ? null : String(r.display_name),
    avatarUrl: r.avatar_url == null ? null : String(r.avatar_url),
    role: String(r.role),
    joinedAt: Number(r.joined_at),
  }));
}

/** Rename a chat (authz enforced by the caller). */
export async function renameChat(db: DbClient, chatId: string, name: string): Promise<void> {
  await db.run("UPDATE chats SET name = ? WHERE id = ?", [name.trim(), chatId]);
}

/** Set a chat's visibility ('public'|'private'; anything else clamps to private). */
export async function setVisibility(db: DbClient, chatId: string, visibility: string): Promise<void> {
  const v = visibility === "public" ? "public" : "private";
  await db.run("UPDATE chats SET visibility = ? WHERE id = ?", [v, chatId]);
}

/**
 * Set (or clear) a chat's slug. `null`/empty clears it. A non-empty value is
 * normalized + validated + uniqueness-checked. Returns `{ok:true, slug}` or
 * `{ok:false, error}` — never throws on bad input.
 */
export async function setSlug(
  db: DbClient,
  chatId: string,
  raw: string | null,
): Promise<{ ok: true; slug: string | null } | { ok: false; error: string }> {
  if (raw == null || String(raw).trim() === "") {
    await db.run("UPDATE chats SET slug = NULL WHERE id = ?", [chatId]);
    return { ok: true, slug: null };
  }
  const normalized = normalizeSlug(String(raw));
  if (!normalized) return { ok: false, error: "bad_slug" };
  // Free, or already owned by THIS chat (idempotent re-set).
  const holder = await db.first("SELECT id FROM chats WHERE slug = ?", [normalized]);
  if (holder && String(holder.id) !== chatId) return { ok: false, error: "slug_taken" };
  await db.run("UPDATE chats SET slug = ? WHERE id = ?", [normalized, chatId]);
  return { ok: true, slug: normalized };
}

// ---- Slice 6: public discovery + open-join ----

/** The public preview of a discoverable chat — deliberately NO message content
 *  (discovery must never leak the log). `isMember` reflects the *caller*.
 *  Slice 7: for a private-but-discoverable chat (private + slug) shown to a
 *  non-member, `canRequest:true` + the caller's `requestStatus` drive the
 *  "request access"/"requested" UI. Public chats and members omit these. */
export interface ChatPreview {
  id: string;
  type: string;
  name: string | null;
  memberCount: number;
  visibility: string;
  isMember: boolean;
  canRequest?: boolean;
  requestStatus?: RequestStatus;
}

/**
 * Resolve a chat by slug for discovery (Slice 6/7). Returns:
 *  - a `ChatPreview` for: public chats (to anyone); any chat the caller is already
 *    a member of; AND (Slice 7) a private chat that HAS a slug viewed by a
 *    non-member — that chat is "discoverable but gated", so the preview carries
 *    `canRequest:true` + the caller's `requestStatus` for the request-access UI.
 *  - `{ error: "private" }` for everything else: an unknown slug, OR a private
 *    chat WITHOUT a slug (fully hidden). These are deliberately indistinguishable
 *    so a non-member can't tell a hidden chat apart from a non-existent one.
 *    NEVER leaks messages.
 *
 * Note: a private chat only reaches this function when it HAS a slug (the lookup
 * is by slug), so the discoverable-but-gated branch always applies to a private
 * non-member here — private-no-slug chats are unreachable by slug and stay hidden.
 *
 * `callerId` is the viewer (null = anonymous). The preview carries only
 * public-safe fields — id/type/name/memberCount/visibility/isMember (+ optional
 * canRequest/requestStatus), no bodies.
 */
export async function getPreviewBySlug(
  db: DbClient,
  slug: string,
  callerId: string | null,
): Promise<ChatPreview | { error: "private" }> {
  const normalized = normalizeSlug(slug);
  if (!normalized) return { error: "private" };
  const row = await db.first(
    "SELECT id, type, name, visibility, slug FROM chats WHERE slug = ?",
    [normalized],
  );
  if (!row) return { error: "private" };
  const id = String(row.id);
  const visibility = String(row.visibility);
  // ONE read for BOTH the member count and the caller's own role (folded via a
  // conditional MAX) instead of a separate getRole + COUNT. `my_role` is NULL for a
  // null caller (NULL never matches user_id) or a non-member → isMember false.
  const countRow = await db.first(
    "SELECT COUNT(*) AS n, MAX(CASE WHEN user_id = ? THEN role END) AS my_role FROM chat_members WHERE chat_id = ?",
    [callerId, id],
  );
  const isMember = callerId != null && normalizeRole(countRow?.my_role) != null;
  const base: ChatPreview = {
    id,
    type: String(row.type),
    name: row.name == null ? null : String(row.name),
    memberCount: Number(countRow?.n ?? 0),
    visibility,
    isMember,
  };
  if (visibility === "public" || isMember) return base;
  // Private + slug, non-member: discoverable but gated → allow a join request.
  // (A private-no-slug chat can't be resolved by slug, so it never reaches here.)
  const requestStatus = callerId == null ? "none" : await requestStatusFor(db, id, callerId);
  return { ...base, canRequest: true, requestStatus };
}

/**
 * Resolve a chat by id OR slug for a signed-in user, for a shareable deep-link
 * (`GET /api/chats/:idOrSlug/resolve`). Same access rules as getPreviewBySlug but
 * keyed by either identifier, and it also returns `slug`/`role` so the client can
 * decide whether to open the chat directly or route to the /join preview:
 *  - member → openable payload (isMember:true) → client opens /app?chat=<id>.
 *  - non-member + public → preview (open-join).
 *  - non-member + private + slug → preview + canRequest/requestStatus (request flow).
 *  - non-member + private + no slug, OR unknown id/slug → null (404, no leak).
 */
export async function resolveChat(
  db: DbClient,
  idOrSlug: string,
  userId: string,
): Promise<(ChatPreview & { slug: string | null; role: Role | null }) | null> {
  let row = await db.first("SELECT id, type, name, visibility, slug FROM chats WHERE id = ?", [idOrSlug]);
  if (!row) {
    const normalized = normalizeSlug(idOrSlug);
    if (normalized) row = await db.first("SELECT id, type, name, visibility, slug FROM chats WHERE slug = ?", [normalized]);
  }
  if (!row) return null;
  const id = String(row.id);
  const visibility = String(row.visibility);
  const slug = row.slug == null ? null : String(row.slug);
  // ONE read for BOTH member count and the caller's role (folded conditional MAX)
  // instead of getRole + a separate COUNT. Same null/normalization as getRole.
  const countRow = await db.first(
    "SELECT COUNT(*) AS n, MAX(CASE WHEN user_id = ? THEN role END) AS my_role FROM chat_members WHERE chat_id = ?",
    [userId, id],
  );
  const role = normalizeRole(countRow?.my_role);
  const isMember = role != null;
  const base = {
    id, type: String(row.type), name: row.name == null ? null : String(row.name),
    memberCount: Number(countRow?.n ?? 0), visibility, isMember, slug, role,
  };
  if (isMember || visibility === "public") return base;
  if (slug) {
    const requestStatus = await requestStatusFor(db, id, userId);
    return { ...base, canRequest: true, requestStatus };
  }
  return null; // private, no slug, non-member → hidden (no existence leak)
}

/**
 * Open-join (Slice 6): add the caller to a PUBLIC chat as a plain `member`.
 * Idempotent — an already-member returns `{ ok: true, joined: false }`. A private
 * or unknown chat is refused with `{ ok: false, error: "must_request" }` (403 at
 * the route) — invites/join-requests are Slice 7. `subscribe` (channels) is the
 * same operation. Returns `{ ok: true, joined }` on success.
 */
export async function joinPublic(
  db: DbClient,
  chatId: string,
  userId: string,
  now: number,
): Promise<{ ok: true; joined: boolean } | { ok: false; error: "must_request" }> {
  const chat = await db.first("SELECT visibility FROM chats WHERE id = ?", [chatId]);
  // Unknown or non-public → refuse identically (don't leak which). Slice 7 turns
  // this into a join-request; for now a private chat can only be joined by invite.
  if (!chat || String(chat.visibility) !== "public") return { ok: false, error: "must_request" };
  if ((await getRole(db, chatId, userId)) != null) return { ok: true, joined: false };
  await db.run(
    "INSERT INTO chat_members (chat_id, user_id, role, unread_count, last_read_at, joined_at) VALUES (?, ?, 'member', 0, NULL, ?)",
    [chatId, userId, now],
  );
  return { ok: true, joined: true };
}

// ---- Slice 7: join requests (private + slug = "discoverable but gated") ----

/** A pending/decided join request as surfaced to owner/admin (JOIN with users). */
export interface JoinRequestView {
  id: string;
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: string;
  createdAt: number;
}

/** The caller's own request status for a chat: never requested → "none". */
export type RequestStatus = "none" | "pending" | "approved" | "rejected";

/** The caller's request status for a chat (for the preview "request access" UI). */
export async function requestStatusFor(db: DbClient, chatId: string, userId: string): Promise<RequestStatus> {
  const r = await db.first("SELECT status FROM join_requests WHERE chat_id = ? AND user_id = ?", [chatId, userId]);
  if (!r) return "none";
  const s = String(r.status);
  return s === "pending" || s === "approved" || s === "rejected" ? s : "none";
}

/**
 * A non-member asks to join a PRIVATE-but-discoverable chat (private + slug). A
 * public chat is open-join (use `joinPublic`); a private chat with NO slug stays
 * fully hidden and cannot be requested. Creates/reuses one pending row per (chat,
 * user) — idempotent. Errors:
 *   - `not_found`     — unknown chat.
 *   - `already_member`— the caller is already in.
 *   - `open_join`     — the chat is public (join directly, don't request).
 *   - `not_requestable` — private but has no slug (not discoverable).
 * Re-requesting after a rejection re-opens the row as pending.
 */
export async function requestJoin(
  db: DbClient,
  chatId: string,
  userId: string,
  now: number,
): Promise<{ ok: true; status: "pending" } | { ok: false; error: string }> {
  const chat = await db.first("SELECT visibility, slug FROM chats WHERE id = ?", [chatId]);
  if (!chat) return { ok: false, error: "not_found" };
  if ((await getRole(db, chatId, userId)) != null) return { ok: false, error: "already_member" };
  if (String(chat.visibility) === "public") return { ok: false, error: "open_join" };
  // Private + slug = discoverable and gated; private + no slug = fully hidden.
  if (chat.slug == null || String(chat.slug) === "") return { ok: false, error: "not_requestable" };
  const existing = await db.first("SELECT id, status FROM join_requests WHERE chat_id = ? AND user_id = ?", [chatId, userId]);
  if (existing) {
    // Reuse the row; if it was decided (approved/rejected) re-open it as pending.
    if (String(existing.status) !== "pending") {
      await db.run("UPDATE join_requests SET status = 'pending', created_at = ? WHERE id = ?", [now, String(existing.id)]);
    }
    return { ok: true, status: "pending" };
  }
  await db.run(
    "INSERT INTO join_requests (id, chat_id, user_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
    [crypto.randomUUID(), chatId, userId, now],
  );
  return { ok: true, status: "pending" };
}

/** Owner/admin: list the chat's PENDING join requests with requester identity. */
export async function listRequests(
  db: DbClient,
  chatId: string,
  actorId: string,
): Promise<{ ok: true; requests: JoinRequestView[] } | { ok: false; error: string }> {
  const role = await getRole(db, chatId, actorId);
  if (role == null) return { ok: false, error: "not_member" };
  if (role !== "owner" && role !== "admin") return { ok: false, error: "forbidden" };
  const rows = await db.all(
    `SELECT j.id, j.user_id, j.status, j.created_at,
            u.username, u.display_name, u.avatar_url
     FROM join_requests j
     JOIN users u ON u.id = j.user_id
     WHERE j.chat_id = ? AND j.status = 'pending'
     ORDER BY j.created_at ASC`,
    [chatId],
  );
  return {
    ok: true,
    requests: rows.map((r: Row) => ({
      id: String(r.id),
      userId: String(r.user_id),
      username: String(r.username),
      displayName: r.display_name == null ? null : String(r.display_name),
      avatarUrl: r.avatar_url == null ? null : String(r.avatar_url),
      status: String(r.status),
      createdAt: Number(r.created_at),
    })),
  };
}

/**
 * Owner/admin approve a pending request: add the requester as a plain member
 * (exactly once — idempotent if they somehow already joined) and mark the request
 * 'approved'. Errors: `not_member`/`forbidden` (authz), `request_not_found` (bad
 * id or already decided).
 */
export async function approveRequest(
  db: DbClient,
  chatId: string,
  requestId: string,
  actorId: string,
  now: number,
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const role = await getRole(db, chatId, actorId);
  if (role == null) return { ok: false, error: "not_member" };
  if (role !== "owner" && role !== "admin") return { ok: false, error: "forbidden" };
  const req = await db.first(
    "SELECT user_id, status FROM join_requests WHERE id = ? AND chat_id = ?",
    [requestId, chatId],
  );
  if (!req || String(req.status) !== "pending") return { ok: false, error: "request_not_found" };
  const targetId = String(req.user_id);
  // Add exactly once — skip the INSERT if they're already a member (idempotent).
  if ((await getRole(db, chatId, targetId)) == null) {
    await db.run(
      "INSERT INTO chat_members (chat_id, user_id, role, unread_count, last_read_at, joined_at) VALUES (?, ?, 'member', 0, NULL, ?)",
      [chatId, targetId, now],
    );
  }
  await db.run("UPDATE join_requests SET status = 'approved' WHERE id = ?", [requestId]);
  return { ok: true, userId: targetId };
}

/** Owner/admin reject a pending request: mark it 'rejected' (no member added). */
export async function rejectRequest(
  db: DbClient,
  chatId: string,
  requestId: string,
  actorId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const role = await getRole(db, chatId, actorId);
  if (role == null) return { ok: false, error: "not_member" };
  if (role !== "owner" && role !== "admin") return { ok: false, error: "forbidden" };
  const req = await db.first(
    "SELECT status FROM join_requests WHERE id = ? AND chat_id = ?",
    [requestId, chatId],
  );
  if (!req || String(req.status) !== "pending") return { ok: false, error: "request_not_found" };
  await db.run("UPDATE join_requests SET status = 'rejected' WHERE id = ?", [requestId]);
  return { ok: true };
}
