import type { DbClient, Row } from "./types";

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
