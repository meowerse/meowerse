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
  unreadCount: number;
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
  for (const uid of [me, other]) {
    await db.run(
      "INSERT INTO chat_members (chat_id, user_id, role, unread_count, last_read_at, joined_at) VALUES (?, ?, 'member', 0, NULL, ?)",
      [id, uid, now],
    );
  }
  return { id, created: true };
}

/** Off-critical-path mirror from the DO after a send, so the sidebar shows a preview. */
export async function mirrorLastMessage(
  db: DbClient, chatId: string, body: string, senderId: string, now: number,
): Promise<void> {
  await db.run(
    "UPDATE chats SET last_message = ?, last_sender_id = ?, last_activity = ? WHERE id = ?",
    [body.slice(0, 140), senderId, now, chatId],
  );
  await db.run(
    "UPDATE chat_members SET unread_count = unread_count + 1 WHERE chat_id = ? AND user_id <> ?",
    [chatId, senderId],
  );
}

/** Mark a chat read up to a timestamp for one member: clear unread + set last_read_at. */
export async function markRead(db: DbClient, chatId: string, userId: string, upTo: number): Promise<void> {
  await db.run(
    "UPDATE chat_members SET unread_count = 0, last_read_at = ? WHERE chat_id = ? AND user_id = ?",
    [upTo, chatId, userId],
  );
}

export async function listChats(db: DbClient, userId: string): Promise<ChatSummary[]> {
  // For DMs, LEFT JOIN the OTHER member (chat_members om where om.user_id <> me)
  // and their user row so the sidebar shows the peer's name + avatar. For groups
  // there is more than one "other" member — the peer columns stay null (Slice 5
  // renders groups by their own name), so the join is scoped to type = 'direct'.
  const rows = await db.all(
    `SELECT c.id, c.type, c.name, c.last_message, c.last_sender_id, c.last_activity, m.unread_count,
            om.user_id AS peer_id,
            pu.username AS peer_username, pu.display_name AS peer_display_name, pu.avatar_url AS peer_avatar_url
     FROM chat_members m
     JOIN chats c ON c.id = m.chat_id
     LEFT JOIN chat_members om ON om.chat_id = c.id AND om.user_id <> m.user_id AND c.type = 'direct'
     LEFT JOIN users pu ON pu.id = om.user_id
     WHERE m.user_id = ? ORDER BY c.last_activity DESC`,
    [userId],
  );
  return rows.map((r: Row) => ({
    id: String(r.id), type: String(r.type), name: r.name == null ? null : String(r.name),
    lastMessage: r.last_message == null ? null : String(r.last_message),
    lastSenderId: r.last_sender_id == null ? null : String(r.last_sender_id),
    lastActivity: Number(r.last_activity), unreadCount: Number(r.unread_count ?? 0),
    peerId: r.peer_id == null ? null : String(r.peer_id),
    peerUsername: r.peer_username == null ? null : String(r.peer_username),
    peerDisplayName: r.peer_display_name == null ? null : String(r.peer_display_name),
    peerAvatarUrl: r.peer_avatar_url == null ? null : String(r.peer_avatar_url),
  }));
}

/** Is `userId` a member of `chatId`? (gate for /ws + history) */
export async function isMember(db: DbClient, chatId: string, userId: string): Promise<boolean> {
  const r = await db.first("SELECT 1 AS ok FROM chat_members WHERE chat_id = ? AND user_id = ?", [chatId, userId]);
  return !!r;
}

// ---- Slice 5: groups, roles, member views, metadata ----

/** The caller's role in a chat, or null if not a member. Authoritative — every
 *  mutation gates on this, never on a client-sent role. */
export async function getRole(db: DbClient, chatId: string, userId: string): Promise<Role | null> {
  const r = await db.first("SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?", [chatId, userId]);
  if (!r) return null;
  const role = String(r.role);
  return role === "owner" || role === "admin" || role === "member" ? role : "member";
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
  await db.run(
    "INSERT INTO chat_members (chat_id, user_id, role, unread_count, last_read_at, joined_at) VALUES (?, ?, 'owner', 0, NULL, ?)",
    [id, input.creatorId, now],
  );
  // Distinct members other than the creator, added as plain members.
  const others = [...new Set(input.memberIds)].filter((uid) => uid !== input.creatorId);
  for (const uid of others) {
    await db.run(
      "INSERT INTO chat_members (chat_id, user_id, role, unread_count, last_read_at, joined_at) VALUES (?, ?, 'member', 0, NULL, ?)",
      [id, uid, now],
    );
  }
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
 *  (discovery must never leak the log). `isMember` reflects the *caller*. */
export interface ChatPreview {
  id: string;
  type: string;
  name: string | null;
  memberCount: number;
  visibility: string;
  isMember: boolean;
}

/**
 * Resolve a chat by slug for discovery (Slice 6). Returns:
 *  - `{ error: "private" }` when the slug resolves to nothing OR to a non-public
 *    chat the caller isn't a member of. The two cases are deliberately
 *    indistinguishable — a non-member must not learn a private chat exists, nor
 *    anything beyond its existence. NEVER leaks messages or membership.
 *  - a `ChatPreview` otherwise: public chats (to anyone) and any chat the caller
 *    is already a member of (so members can deep-link into a since-privated chat).
 *
 * `callerId` is the viewer (null = anonymous). The preview carries only
 * public-safe fields — id/type/name/memberCount/visibility/isMember, no bodies.
 */
export async function getPreviewBySlug(
  db: DbClient,
  slug: string,
  callerId: string | null,
): Promise<ChatPreview | { error: "private" }> {
  const normalized = normalizeSlug(slug);
  if (!normalized) return { error: "private" };
  const row = await db.first(
    "SELECT id, type, name, visibility FROM chats WHERE slug = ?",
    [normalized],
  );
  if (!row) return { error: "private" };
  const id = String(row.id);
  const visibility = String(row.visibility);
  const isMember = callerId != null && (await getRole(db, id, callerId)) != null;
  // Private chats only reveal a preview to their own members — everyone else gets
  // the same opaque "private" as a non-existent slug (no existence/membership leak).
  if (visibility !== "public" && !isMember) return { error: "private" };
  const countRow = await db.first(
    "SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?",
    [id],
  );
  return {
    id,
    type: String(row.type),
    name: row.name == null ? null : String(row.name),
    memberCount: Number(countRow?.n ?? 0),
    visibility,
    isMember,
  };
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
