import type { DbClient } from "./types";
import { getRole } from "./chats";
import { randomId } from "./security";

/**
 * Slice 7 — invite codes. One active code per chat, stored on `chats.invite_code`
 * with an `invite_enabled` flag (1 = live, 0 = revoked). A code lets anyone who
 * holds it JOIN the chat directly, BYPASSING the visibility gate — so:
 *   - create/refresh/revoke are owner/admin only (re-derived via `getRole`, never
 *     trusted from the client);
 *   - `resolveInvite`/`joinByInvite` succeed ONLY for a code that both matches a
 *     chat AND has `invite_enabled = 1` — a revoked (or unknown) code fails
 *     identically, leaking nothing about the chat.
 *
 * Each fn returns `{ok:true, ...}` or `{ok:false, error}` (mapped to HTTP by the
 * route layer). `resolveInvite` returns a preview or null.
 */

type InviteView = { chatId: string; type: string; name: string | null; memberCount: number };

/** Count members of a chat (invite previews expose only the count, never bodies). */
async function memberCount(db: DbClient, chatId: string): Promise<number> {
  const r = await db.first("SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?", [chatId]);
  return Number(r?.n ?? 0);
}

/**
 * Return the chat's live invite code, creating one if none exists (or if the
 * existing code was revoked — a create re-enables with a fresh code). Owner/admin
 * only. Idempotent for an already-enabled code: returns the same code.
 */
export async function getOrCreateInvite(
  db: DbClient,
  chatId: string,
  actorId: string,
): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  const role = await getRole(db, chatId, actorId);
  if (role == null) return { ok: false, error: "not_member" };
  if (role !== "owner" && role !== "admin") return { ok: false, error: "forbidden" };
  const row = await db.first("SELECT invite_code, invite_enabled FROM chats WHERE id = ?", [chatId]);
  if (!row) return { ok: false, error: "not_found" };
  const existing = row.invite_code == null ? null : String(row.invite_code);
  const enabled = Number(row.invite_enabled ?? 0) === 1;
  if (existing && enabled) return { ok: true, code: existing };
  const code = randomId(12);
  await db.run("UPDATE chats SET invite_code = ?, invite_enabled = 1 WHERE id = ?", [code, chatId]);
  return { ok: true, code };
}

/**
 * Rotate the invite code: mint a NEW one, invalidating the old (any previously
 * shared link stops working). Owner/admin only.
 */
export async function refreshInvite(
  db: DbClient,
  chatId: string,
  actorId: string,
): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  const role = await getRole(db, chatId, actorId);
  if (role == null) return { ok: false, error: "not_member" };
  if (role !== "owner" && role !== "admin") return { ok: false, error: "forbidden" };
  const exists = await db.first("SELECT 1 AS ok FROM chats WHERE id = ?", [chatId]);
  if (!exists) return { ok: false, error: "not_found" };
  const code = randomId(12);
  await db.run("UPDATE chats SET invite_code = ?, invite_enabled = 1 WHERE id = ?", [code, chatId]);
  return { ok: true, code };
}

/**
 * Revoke the current invite: flip `invite_enabled` to 0 so the code stops
 * resolving. Owner/admin only. Idempotent (revoking with no code is a no-op ok).
 */
export async function revokeInvite(
  db: DbClient,
  chatId: string,
  actorId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const role = await getRole(db, chatId, actorId);
  if (role == null) return { ok: false, error: "not_member" };
  if (role !== "owner" && role !== "admin") return { ok: false, error: "forbidden" };
  const exists = await db.first("SELECT 1 AS ok FROM chats WHERE id = ?", [chatId]);
  if (!exists) return { ok: false, error: "not_found" };
  await db.run("UPDATE chats SET invite_enabled = 0 WHERE id = ?", [chatId]);
  return { ok: true };
}

/**
 * Resolve a code to a public-safe preview (id/type/name/memberCount) — no bodies,
 * no membership. Returns null for an unknown OR revoked code (indistinguishable,
 * so a revoked link can't be told apart from a bogus one). Anyone signed in may
 * resolve a code they hold; the preview reveals only what the code already grants.
 */
export async function resolveInvite(db: DbClient, code: string): Promise<InviteView | null> {
  const c = (code ?? "").trim();
  if (!c) return null;
  const row = await db.first(
    "SELECT id, type, name, invite_enabled FROM chats WHERE invite_code = ?",
    [c],
  );
  if (!row || Number(row.invite_enabled ?? 0) !== 1) return null;
  const id = String(row.id);
  return { chatId: id, type: String(row.type), name: row.name == null ? null : String(row.name), memberCount: await memberCount(db, id) };
}

/**
 * Join by invite code: add the caller as a plain `member`, BYPASSING visibility.
 * Idempotent — an already-member returns `{ok:true, joined:false}`. An unknown or
 * revoked code → `{ok:false, error:"bad_invite"}`. This is the ONLY path that lets
 * a non-member into a private chat without an owner/admin acting.
 */
export async function joinByInvite(
  db: DbClient,
  code: string,
  userId: string,
  now: number,
): Promise<{ ok: true; chatId: string; joined: boolean } | { ok: false; error: string }> {
  const c = (code ?? "").trim();
  if (!c) return { ok: false, error: "bad_invite" };
  const row = await db.first("SELECT id, invite_enabled FROM chats WHERE invite_code = ?", [c]);
  if (!row || Number(row.invite_enabled ?? 0) !== 1) return { ok: false, error: "bad_invite" };
  const chatId = String(row.id);
  if ((await getRole(db, chatId, userId)) != null) return { ok: true, chatId, joined: false };
  await db.run(
    "INSERT INTO chat_members (chat_id, user_id, role, unread_count, last_read_at, joined_at) VALUES (?, ?, 'member', 0, NULL, ?)",
    [chatId, userId, now],
  );
  return { ok: true, chatId, joined: true };
}
