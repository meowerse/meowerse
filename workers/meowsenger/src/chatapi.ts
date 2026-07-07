import type { DbClient, Env } from "./types";
import type { Conversation } from "./conversation";
import { json, readCookies } from "./security";
import { getSession, SESSION_COOKIE } from "./session";
import {
  createOrGetDirect,
  createGroup,
  listChats,
  listMembers,
  isMember,
  getRole,
  roleAtLeast,
  renameChat,
  setVisibility,
  setSlug,
  slugAvailable,
  normalizeSlug,
} from "./chats";
import { addMember, removeMember, promote, demote, leave } from "./members";

/** Look up a user id by username, or null. */
async function userIdByName(db: DbClient, username: string): Promise<string | null> {
  const r = await db.first("SELECT id FROM users WHERE username = ?", [username.trim()]);
  return r ? String(r.id) : null;
}

/**
 * Typed view of the CONVERSATION namespace. `Env.CONVERSATION` is declared as an
 * untyped `DurableObjectNamespace` (so `types.ts` never imports the DO value and
 * drags `cloudflare:workers` into the node graph). Here we narrow it to a stub
 * that exposes the DO's RPC surface (`historyFor`) — `Conversation` is a TYPE-only
 * import, so the node-pool tests never load the workerd module.
 */
type ConversationNamespace = DurableObjectNamespace<Conversation>;
function conversation(env: Env): ConversationNamespace {
  return env.CONVERSATION as unknown as ConversationNamespace;
}

/** Resolve the caller's userId from the BFF session cookie, or null. */
export async function callerId(req: Request, db: DbClient, now: number): Promise<string | null> {
  const sid = readCookies(req.headers.get("Cookie"))[SESSION_COOKIE];
  if (!sid) return null;
  const s = await getSession(db, sid, now);
  return s?.userId ?? null;
}

/** GET /api/chats — the caller's sidebar list. */
export async function handleListChats(
  req: Request,
  db: DbClient,
  now: number,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, { "Cache-Control": "no-store" });
  return json({ chats: await listChats(db, me) }, 200, cors, { "Cache-Control": "no-store" });
}

/**
 * POST /api/chats — create a chat. Two shapes:
 *   - DM:    { username }               → open-or-create a 1:1 with that user.
 *   - group: { type:"group", name, members:[usernames], visibility?, slug? }
 *            → create a named group with the caller as owner.
 */
export async function handleCreateChat(
  req: Request,
  db: DbClient,
  now: number,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, { "Cache-Control": "no-store" });
  let body: { type?: string; username?: string; name?: string; members?: unknown; visibility?: string; slug?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "bad_json" }, 400, cors, { "Cache-Control": "no-store" });
  }

  if (body.type === "group") return handleCreateGroup(me, db, body, now, cors);

  const uname = (body.username ?? "").trim();
  if (!uname) return json({ error: "username_required" }, 400, cors, { "Cache-Control": "no-store" });
  const otherId = await userIdByName(db, uname);
  if (!otherId) return json({ error: "user_not_found" }, 404, cors, { "Cache-Control": "no-store" });
  if (otherId === me) return json({ error: "cannot_dm_self" }, 400, cors, { "Cache-Control": "no-store" });
  const r = await createOrGetDirect(db, me, otherId, now);
  return json({ chatId: r.id, created: r.created }, 200, cors, { "Cache-Control": "no-store" });
}

/** Group branch of POST /api/chats — resolves member usernames → ids, then createGroup. */
async function handleCreateGroup(
  me: string,
  db: DbClient,
  body: { name?: string; members?: unknown; visibility?: string; slug?: string },
  now: number,
  cors: Record<string, string>,
): Promise<Response> {
  const name = (body.name ?? "").trim();
  if (!name) return json({ error: "name_required" }, 400, cors, { "Cache-Control": "no-store" });
  const usernames = Array.isArray(body.members) ? body.members.map((u) => String(u).trim()).filter(Boolean) : [];
  const memberIds: string[] = [];
  for (const uname of usernames) {
    const uid = await userIdByName(db, uname);
    if (!uid) return json({ error: "user_not_found", username: uname }, 404, cors, { "Cache-Control": "no-store" });
    memberIds.push(uid);
  }
  const r = await createGroup(db, { name, creatorId: me, memberIds, visibility: body.visibility, slug: body.slug ?? null }, now);
  if ("error" in r) return json({ error: r.error }, 400, cors, { "Cache-Control": "no-store" });
  return json({ chatId: r.id, created: true }, 200, cors, { "Cache-Control": "no-store" });
}

/** GET /api/chats/:id/messages?before=<id> — history from the chat's DO (RPC). */
export async function handleHistory(
  req: Request,
  env: Env,
  db: DbClient,
  now: number,
  chatId: string,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, { "Cache-Control": "no-store" });
  if (!(await isMember(db, chatId, me))) return json({ error: "forbidden" }, 403, cors, { "Cache-Control": "no-store" });
  const before = new URL(req.url).searchParams.get("before");
  const stub = conversation(env).get(conversation(env).idFromName(chatId));
  const messages = await stub.historyFor(chatId, before);
  return json({ messages }, 200, cors, { "Cache-Control": "no-store" });
}

// ---- Slice 5: member management + chat metadata routes ----

const NS = { "Cache-Control": "no-store" };

/**
 * Map a members.ts error code to an HTTP status. Missing-target / not-member of
 * the target → 404; authorization denials → 403; everything else (bad input,
 * already-member, not-promotable, …) → 400.
 */
function statusForMemberError(error: string): number {
  if (error === "target_not_member") return 404;
  if (error === "not_member" || error === "forbidden" || error === "cannot_remove_owner" || error === "cannot_remove_admin") {
    return 403;
  }
  return 400;
}

/** GET /api/chats/:id/members — members-only view of the roster. */
export async function handleListMembers(
  req: Request,
  db: DbClient,
  now: number,
  chatId: string,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  if ((await getRole(db, chatId, me)) == null) return json({ error: "forbidden" }, 403, cors, NS);
  return json({ members: await listMembers(db, chatId) }, 200, cors, NS);
}

/** POST /api/chats/:id/members { username } — owner/admin adds a member. */
export async function handleAddMember(
  req: Request,
  db: DbClient,
  now: number,
  chatId: string,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  let body: { username?: string };
  try {
    body = (await req.json()) as { username?: string };
  } catch {
    return json({ error: "bad_json" }, 400, cors, NS);
  }
  const uname = (body.username ?? "").trim();
  if (!uname) return json({ error: "username_required" }, 400, cors, NS);
  const targetId = await userIdByName(db, uname);
  if (!targetId) return json({ error: "user_not_found" }, 404, cors, NS);
  const r = await addMember(db, chatId, me, targetId, now);
  if (!r.ok) return json({ error: r.error }, statusForMemberError(r.error), cors, NS);
  return json({ ok: true, userId: targetId }, 200, cors, NS);
}

/** DELETE /api/chats/:id/members/:userId — owner/admin removes a member. */
export async function handleRemoveMember(
  req: Request,
  db: DbClient,
  now: number,
  chatId: string,
  targetUserId: string,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  const r = await removeMember(db, chatId, me, targetUserId);
  if (!r.ok) return json({ error: r.error }, statusForMemberError(r.error), cors, NS);
  return json({ ok: true }, 200, cors, NS);
}

/** POST /api/chats/:id/members/:userId/role { role } — owner promotes/demotes. */
export async function handleSetRole(
  req: Request,
  db: DbClient,
  now: number,
  chatId: string,
  targetUserId: string,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  let body: { role?: string };
  try {
    body = (await req.json()) as { role?: string };
  } catch {
    return json({ error: "bad_json" }, 400, cors, NS);
  }
  const role = (body.role ?? "").trim();
  if (role !== "admin" && role !== "member") return json({ error: "bad_role" }, 400, cors, NS);
  const r = role === "admin" ? await promote(db, chatId, me, targetUserId) : await demote(db, chatId, me, targetUserId);
  if (!r.ok) return json({ error: r.error }, statusForMemberError(r.error), cors, NS);
  return json({ ok: true }, 200, cors, NS);
}

/** POST /api/chats/:id/leave — the caller leaves (owner-transfer / last-member-delete). */
export async function handleLeave(
  req: Request,
  db: DbClient,
  now: number,
  chatId: string,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  const r = await leave(db, chatId, me);
  if (!r.ok) return json({ error: r.error }, statusForMemberError(r.error), cors, NS);
  return json({ ok: true, transferredTo: r.transferredTo ?? null, deleted: r.deleted ?? false }, 200, cors, NS);
}

/** PATCH /api/chats/:id { name?, visibility?, slug? } — owner/admin edits metadata. */
export async function handleUpdateChat(
  req: Request,
  db: DbClient,
  now: number,
  chatId: string,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  const role = await getRole(db, chatId, me);
  if (role == null) return json({ error: "forbidden" }, 403, cors, NS);
  if (!roleAtLeast(role, "admin")) return json({ error: "forbidden" }, 403, cors, NS);
  let body: { name?: string; visibility?: string; slug?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "bad_json" }, 400, cors, NS);
  }
  if (typeof body.name === "string") {
    if (!body.name.trim()) return json({ error: "name_required" }, 400, cors, NS);
    await renameChat(db, chatId, body.name);
  }
  if (typeof body.visibility === "string") {
    if (body.visibility !== "public" && body.visibility !== "private") {
      return json({ error: "bad_visibility" }, 400, cors, NS);
    }
    await setVisibility(db, chatId, body.visibility);
  }
  let slug: string | null | undefined;
  if (body.slug !== undefined) {
    const r = await setSlug(db, chatId, body.slug);
    if (!r.ok) return json({ error: r.error }, 400, cors, NS);
    slug = r.slug;
  }
  return json({ ok: true, ...(slug !== undefined ? { slug } : {}) }, 200, cors, NS);
}

/** GET /api/slug-available?slug= — is a (normalized) slug free? Bad format → 400. */
export async function handleSlugAvailable(
  req: Request,
  db: DbClient,
  now: number,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  const raw = new URL(req.url).searchParams.get("slug") ?? "";
  const normalized = normalizeSlug(raw);
  if (!normalized) return json({ error: "bad_slug", available: false }, 400, cors, NS);
  return json({ available: await slugAvailable(db, normalized), slug: normalized }, 200, cors, NS);
}
