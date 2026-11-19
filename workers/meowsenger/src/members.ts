import type { DbClient } from "./types";
import { getRole, getRoles } from "./chats";
import { getAllowAutoGroupAdd } from "./users";
import { getOrCreateInvite } from "./invites";

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
 *
 * Slice 7 privacy: if the target has opted OUT of auto-group-add
 * (`allow_auto_group_add = 0`), they are NOT added. Instead we ensure the chat has
 * a live invite code and return `{ok:true, invited:true, inviteCode}` — the actor
 * shares that link so the target joins on their own terms. Opted-in targets (the
 * default) are added directly as before.
 */
export async function addMember(
  db: DbClient,
  chatId: string,
  actorId: string,
  targetUserId: string,
  now: number,
): Promise<Result<{ invited?: boolean; inviteCode?: string }>> {
  // One read for both the actor's and the target's role.
  const roles = await getRoles(db, chatId, [actorId, targetUserId]);
  const actorRole = roles.get(actorId) ?? null;
  if (actorRole == null) return { ok: false, error: "not_member" };
  if (actorRole !== "owner" && actorRole !== "admin") return { ok: false, error: "forbidden" };
  const existing = roles.get(targetUserId) ?? null;
  if (existing != null) return { ok: false, error: "already_member" };
  // Respect the target's opt-out: don't force-add — hand the actor an invite link.
  if (!(await getAllowAutoGroupAdd(db, targetUserId))) {
    const inv = await getOrCreateInvite(db, chatId, actorId);
    // The actor is owner/admin here, so getOrCreateInvite can't be forbidden; a
    // missing chat is the only failure, surfaced as-is.
    if (!inv.ok) return { ok: false, error: inv.error };
    return { ok: true, invited: true, inviteCode: inv.code };
  }
  await db.run(
    "INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, unread_count, last_read_at, joined_at) VALUES (?, ?, 'member', 0, NULL, ?)",
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
  // One read for both the actor's and the target's role.
  const roles = await getRoles(db, chatId, [actorId, targetUserId]);
  const actorRole = roles.get(actorId) ?? null;
  if (actorRole == null) return { ok: false, error: "not_member" };
  if (actorRole !== "owner" && actorRole !== "admin") return { ok: false, error: "forbidden" };
  const targetRole = roles.get(targetUserId) ?? null;
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
  // One read for both the actor's and the target's role.
  const roles = await getRoles(db, chatId, [actorId, targetUserId]);
  const actorRole = roles.get(actorId) ?? null;
  if (actorRole == null) return { ok: false, error: "not_member" };
  if (actorRole !== "owner") return { ok: false, error: "forbidden" };
  const targetRole = roles.get(targetUserId) ?? null;
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
  // One read for both the actor's and the target's role.
  const roles = await getRoles(db, chatId, [actorId, targetUserId]);
  const actorRole = roles.get(actorId) ?? null;
  if (actorRole == null) return { ok: false, error: "not_member" };
  if (actorRole !== "owner") return { ok: false, error: "forbidden" };
  const targetRole = roles.get(targetUserId) ?? null;
  if (targetRole == null) return { ok: false, error: "target_not_member" };
  if (targetRole !== "admin") return { ok: false, error: "not_demotable" };
  await db.run("UPDATE chat_members SET role = 'member' WHERE chat_id = ? AND user_id = ?", [chatId, targetUserId]);
  return { ok: true };
}

type Stmt = { sql: string; params: unknown[] };

/**
 * The two ownership-reconciling statements, run AFTER the leaver's row is gone, in the same
 * batch. Both are guarded in SQL so a concurrent leave / second handoff can never leave the
 * chat with two owners:
 *  1. promote the oldest admin (else oldest member; ties by user_id) to owner, but only while
 *     the chat is a non-direct chat that HAS members and has NO owner (direct chats have no
 *     owner by design). The successor is chosen inside the statement, so it is always a member
 *     that still exists at commit time.
 *  2. delete the chat if no member is left.
 * `exceptUserId` is excluded as a successor ('' = nobody).
 */
function reconcileStatements(chatId: string, exceptUserId: string): Stmt[] {
  return [
    {
      sql:
        "UPDATE chat_members SET role = 'owner' WHERE chat_id = ? " +
        "AND user_id = (SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id <> ? ORDER BY role = 'admin' DESC, joined_at ASC, user_id ASC LIMIT 1) " +
        "AND NOT EXISTS (SELECT 1 FROM chat_members WHERE chat_id = ? AND role = 'owner') " +
        "AND EXISTS (SELECT 1 FROM chats WHERE id = ? AND type <> 'direct')",
      params: [chatId, chatId, exceptUserId, chatId, chatId],
    },
    {
      sql: "DELETE FROM chats WHERE id = ? AND type <> 'direct' AND NOT EXISTS (SELECT 1 FROM chat_members WHERE chat_id = ?)",
      params: [chatId, chatId],
    },
  ];
}

/** ONE atomic batch (a plain sequence if the client has no batch). Returns rows changed per statement. */
async function runAtomic(db: DbClient, stmts: Stmt[]): Promise<Array<number | undefined>> {
  if (db.batch) return db.batch(stmts);
  const out: Array<number | undefined> = [];
  for (const st of stmts) out.push(await db.run(st.sql, st.params));
  return out;
}

/**
 * Idempotent ownership repair for a chat: a non-direct chat with members but no owner gets its
 * oldest admin/member promoted; a chat with no members is deleted. Safe to run any number of
 * times (it is what a retried leave runs, so a leave that was interrupted can never strand an
 * ownerless or empty chat). Reports only what THIS call changed.
 */
export async function reconcileOwnership(
  db: DbClient,
  chatId: string,
): Promise<{ transferredTo?: string; deleted?: boolean }> {
  const [promoted, removed] = await runAtomic(db, reconcileStatements(chatId, ""));
  const out: { transferredTo?: string; deleted?: boolean } = {};
  if (promoted !== undefined && promoted > 0) {
    const o = await db.first("SELECT user_id FROM chat_members WHERE chat_id = ? AND role = 'owner' LIMIT 1", [chatId]);
    if (o) out.transferredTo = String(o.user_id);
  }
  if (removed !== undefined && removed > 0) out.deleted = true;
  return out;
}

/**
 * The actor leaves the chat. Anyone may leave. The leaver's row is deleted and ownership is
 * reconciled in ONE atomic batch: if the OWNER leaves, ownership transfers to the oldest
 * remaining admin, else the oldest remaining member; if no one remains, the chat is deleted.
 * Because it is one transaction, a failure part-way leaves the leaver still a member (the
 * retry redoes everything) rather than a deleted leaver and an ownerless/empty chat. The
 * reconcile statements also run for a non-owner leaver (a successor whose role read was stale
 * and who left right after being promoted must not strand the chat). Returns
 * `{ok, transferredTo?, deleted?}` describing what happened (read back after the batch).
 */
export async function leave(
  db: DbClient,
  chatId: string,
  actorId: string,
): Promise<Result<{ transferredTo?: string; deleted?: boolean }>> {
  const actorRole = await getRole(db, chatId, actorId);
  if (actorRole == null) return { ok: false, error: "not_member" };

  const [, promoted, removed] = await runAtomic(db, [
    { sql: "DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?", params: [chatId, actorId] },
    ...reconcileStatements(chatId, actorId),
  ]);

  if (actorRole !== "owner") return { ok: true };
  // Report what THIS batch did (a client that cannot report changes is read back instead).
  if (removed !== undefined && removed > 0) return { ok: true, deleted: true };
  if (promoted === 0 && removed === 0) return { ok: true }; // someone else already owns it
  const owner = await db.first("SELECT user_id FROM chat_members WHERE chat_id = ? AND role = 'owner' LIMIT 1", [chatId]);
  if (owner) return { ok: true, transferredTo: String(owner.user_id) };
  const chat = await db.first("SELECT 1 AS ok FROM chats WHERE id = ?", [chatId]);
  return chat ? { ok: true } : { ok: true, deleted: true };
}
