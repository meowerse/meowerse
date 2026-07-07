import type { DbClient, Row } from "./types";
import { getRole } from "./chats";

/**
 * Member management for group chats. EVERY function here re-derives the actor's
 * role from D1 (`getRole`) and enforces the Slice-5 authz table server-side — the
 * client's claimed role is never trusted. Each returns `{ok:true, ...}` on success
 * or `{ok:false, error}` on a denied/invalid action (mapped to 403/404/400 by the
 * route layer).
 *
 * Authz table (owner > admin > member):
 *  - add:     actor ∈ {owner, admin}; new member joins as 'member'.
 *  - remove:  actor ∈ {owner, admin}; cannot remove owner; admin cannot remove
 *             another admin (only owner can).
 *  - promote member→admin / demote admin→member: actor = owner only.
 *  - leave:   anyone; owner leaving transfers ownership (oldest admin → oldest
 *             member) or deletes the chat if they were the last member.
 */

type Ok<T = Record<string, never>> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T = Record<string, never>> = Ok<T> | Err;

/**
 * Add `targetUserId` to `chatId` as a plain member. Actor must be owner/admin.
 * 400 if the target is already a member.
 */
export async function addMember(
  db: DbClient,
  chatId: string,
  actorId: string,
  targetUserId: string,
  now: number,
): Promise<Result> {
  const actorRole = await getRole(db, chatId, actorId);
  if (actorRole == null) return { ok: false, error: "not_member" };
  if (actorRole !== "owner" && actorRole !== "admin") return { ok: false, error: "forbidden" };
  const existing = await getRole(db, chatId, targetUserId);
  if (existing != null) return { ok: false, error: "already_member" };
  await db.run(
    "INSERT INTO chat_members (chat_id, user_id, role, unread_count, last_read_at, joined_at) VALUES (?, ?, 'member', 0, NULL, ?)",
    [chatId, targetUserId, now],
  );
  return { ok: true };
}

/**
 * Remove `targetUserId` from `chatId`. Actor must be owner/admin; the owner can
 * never be removed; an admin cannot remove another admin (only the owner can).
 * A member leaving voluntarily goes through `leave`, not this.
 */
export async function removeMember(
  db: DbClient,
  chatId: string,
  actorId: string,
  targetUserId: string,
): Promise<Result> {
  const actorRole = await getRole(db, chatId, actorId);
  if (actorRole == null) return { ok: false, error: "not_member" };
  if (actorRole !== "owner" && actorRole !== "admin") return { ok: false, error: "forbidden" };
  const targetRole = await getRole(db, chatId, targetUserId);
  if (targetRole == null) return { ok: false, error: "target_not_member" };
  if (targetRole === "owner") return { ok: false, error: "cannot_remove_owner" };
  // Only the owner may remove an admin.
  if (targetRole === "admin" && actorRole !== "owner") return { ok: false, error: "cannot_remove_admin" };
  await db.run("DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?", [chatId, targetUserId]);
  return { ok: true };
}

/** Promote a member→admin. Owner only; target must be an existing member. */
export async function promote(
  db: DbClient,
  chatId: string,
  actorId: string,
  targetUserId: string,
): Promise<Result> {
  const actorRole = await getRole(db, chatId, actorId);
  if (actorRole == null) return { ok: false, error: "not_member" };
  if (actorRole !== "owner") return { ok: false, error: "forbidden" };
  const targetRole = await getRole(db, chatId, targetUserId);
  if (targetRole == null) return { ok: false, error: "target_not_member" };
  if (targetRole !== "member") return { ok: false, error: "not_promotable" };
  await db.run("UPDATE chat_members SET role = 'admin' WHERE chat_id = ? AND user_id = ?", [chatId, targetUserId]);
  return { ok: true };
}

/** Demote an admin→member. Owner only; target must currently be an admin. */
export async function demote(
  db: DbClient,
  chatId: string,
  actorId: string,
  targetUserId: string,
): Promise<Result> {
  const actorRole = await getRole(db, chatId, actorId);
  if (actorRole == null) return { ok: false, error: "not_member" };
  if (actorRole !== "owner") return { ok: false, error: "forbidden" };
  const targetRole = await getRole(db, chatId, targetUserId);
  if (targetRole == null) return { ok: false, error: "target_not_member" };
  if (targetRole !== "admin") return { ok: false, error: "not_demotable" };
  await db.run("UPDATE chat_members SET role = 'member' WHERE chat_id = ? AND user_id = ?", [chatId, targetUserId]);
  return { ok: true };
}

/**
 * The actor leaves the chat. Anyone may leave. If the OWNER leaves, ownership
 * transfers to the oldest remaining admin, else the oldest remaining member; if
 * no one remains (last member), the chat + its membership rows are deleted.
 * Returns `{ok, transferredTo?, deleted?}` describing what happened.
 */
export async function leave(
  db: DbClient,
  chatId: string,
  actorId: string,
): Promise<Result<{ transferredTo?: string; deleted?: boolean }>> {
  const actorRole = await getRole(db, chatId, actorId);
  if (actorRole == null) return { ok: false, error: "not_member" };

  // Remove the leaver first, then reconcile ownership over who remains.
  await db.run("DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?", [chatId, actorId]);

  if (actorRole !== "owner") return { ok: true };

  // Owner left: find a successor among the remaining members. Prefer the oldest
  // admin, else the oldest member (by joined_at, tie-broken by user_id for a
  // deterministic pick).
  const remaining = await db.all(
    "SELECT user_id, role, joined_at FROM chat_members WHERE chat_id = ? ORDER BY joined_at ASC, user_id ASC",
    [chatId],
  );
  if (remaining.length === 0) {
    // Last member left → delete the chat entirely (membership rows already gone).
    await db.run("DELETE FROM chats WHERE id = ?", [chatId]);
    return { ok: true, deleted: true };
  }
  const admins = remaining.filter((r: Row) => String(r.role) === "admin");
  const successor = admins[0] ?? remaining[0];
  const successorId = String(successor.user_id);
  await db.run("UPDATE chat_members SET role = 'owner' WHERE chat_id = ? AND user_id = ?", [chatId, successorId]);
  return { ok: true, transferredTo: successorId };
}
