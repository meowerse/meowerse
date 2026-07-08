import type { DbClient, Env } from "./types";
import type { Conversation } from "./conversation";
import { json, readCookies } from "./security";
import { getSession, SESSION_COOKIE, clearCookie } from "./session";
import {
  createOrGetDirect,
  createGroup,
  listChats,
  listMembers,
  isMember,
  getRole,
  chatType,
  roleAtLeast,
  renameChat,
  setVisibility,
  setSlug,
  slugAvailable,
  normalizeSlug,
  getPreviewBySlug,
  resolveChat,
  joinPublic,
  requestJoin,
  listRequests,
  approveRequest,
  rejectRequest,
} from "./chats";
import { addMember, removeMember, promote, demote, leave } from "./members";
import { getOrCreateInvite, refreshInvite, revokeInvite, resolveInvite, joinByInvite } from "./invites";
import { getAllowAutoGroupAdd, setAllowAutoGroupAdd } from "./users";
import { savePushSubscription, deletePushSubscription, isAllowedPushEndpoint } from "./push";
import { MAX_MESSAGE_BODY as MAX_BODY } from "@meowerse/ts-shared";

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
 * POST /api/chats — create a chat. Three shapes:
 *   - DM:      { username }                → open-or-create a 1:1 with that user.
 *   - group:   { type:"group", name, members:[usernames], visibility?, slug? }
 *              → create a named group with the caller as owner.
 *   - channel: { type:"channel", name, members?, visibility?, slug? }
 *              → create a broadcast channel (owner/admin post; the DO enforces the
 *                read-only rule for members). Same shape as a group otherwise.
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

  if (body.type === "group" || body.type === "channel") return handleCreateGroup(me, db, body, now, cors);

  const uname = (body.username ?? "").trim();
  if (!uname) return json({ error: "username_required" }, 400, cors, { "Cache-Control": "no-store" });
  const otherId = await userIdByName(db, uname);
  if (!otherId) return json({ error: "user_not_found" }, 404, cors, { "Cache-Control": "no-store" });
  if (otherId === me) return json({ error: "cannot_dm_self" }, 400, cors, { "Cache-Control": "no-store" });
  const r = await createOrGetDirect(db, me, otherId, now);
  return json({ chatId: r.id, created: r.created }, 200, cors, { "Cache-Control": "no-store" });
}

/**
 * Group/channel branch of POST /api/chats — resolves member usernames → ids, then
 * createGroup. `body.type` picks 'group' (default) or 'channel'; a channel is a
 * broadcast group (only owner/admin post — DO-enforced), otherwise identical.
 */
async function handleCreateGroup(
  me: string,
  db: DbClient,
  body: { type?: string; name?: string; members?: unknown; visibility?: string; slug?: string },
  now: number,
  cors: Record<string, string>,
): Promise<Response> {
  const name = (body.name ?? "").trim();
  if (!name) return json({ error: "name_required" }, 400, cors, { "Cache-Control": "no-store" });
  const type = body.type === "channel" ? "channel" : "group";
  const usernames = Array.isArray(body.members) ? body.members.map((u) => String(u).trim()).filter(Boolean) : [];
  // Bound the initial roster: each username costs a D1 lookup below, so cap the
  // fan-out (a group can still grow past this via addMember one at a time).
  if (usernames.length > 200) return json({ error: "too_many_members" }, 400, cors, { "Cache-Control": "no-store" });
  const memberIds: string[] = [];
  for (const uname of usernames) {
    const uid = await userIdByName(db, uname);
    if (!uid) return json({ error: "user_not_found", username: uname }, 404, cors, { "Cache-Control": "no-store" });
    memberIds.push(uid);
  }
  const r = await createGroup(db, { name, creatorId: me, memberIds, visibility: body.visibility, slug: body.slug ?? null, type }, now);
  if ("error" in r) return json({ error: r.error }, 400, cors, { "Cache-Control": "no-store" });
  return json({ chatId: r.id, created: true }, 200, cors, { "Cache-Control": "no-store" });
}

/**
 * GET /api/chats/:id/messages — history from the chat's DO (RPC). Three modes,
 * all member-gated: ?around=<msgId> returns a centered window (deep-link jump,
 * + hasOlder/hasNewer/found), ?after=<msgId> pages forward (detached-window
 * loadNewer), else ?before=<id> pages backward (default). Slice 9: the caller is
 * the viewerId so each message's reactions carry `mine`.
 */
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
  const q = new URL(req.url).searchParams;
  const stub = conversation(env).get(conversation(env).idFromName(chatId));
  const around = q.get("around");
  if (around) {
    const r = await stub.historyAround(chatId, around, me);
    return json({ messages: r.messages, hasOlder: r.hasOlder, hasNewer: r.hasNewer, found: r.found }, 200, cors, { "Cache-Control": "no-store" });
  }
  const after = q.get("after");
  if (after) {
    const messages = await stub.historyAfter(chatId, after, me);
    return json({ messages }, 200, cors, { "Cache-Control": "no-store" });
  }
  const messages = await stub.historyFor(chatId, q.get("before"), me);
  return json({ messages }, 200, cors, { "Cache-Control": "no-store" });
}

/**
 * GET /api/chats/:idOrSlug/resolve — resolve a chat by id-or-slug for the signed-in
 * caller, for a shareable deep-link. Member → openable payload; public/private+slug
 * non-member → preview; otherwise 404 (no existence leak). See chats.resolveChat.
 */
export async function handleResolveChat(
  req: Request,
  db: DbClient,
  now: number,
  idOrSlug: string,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, { "Cache-Control": "no-store" });
  const r = await resolveChat(db, idOrSlug, me);
  if (!r) return json({ error: "not_found" }, 404, cors, { "Cache-Control": "no-store" });
  return json(r, 200, cors, { "Cache-Control": "no-store" });
}

// ---- Web Push subscription management --------------------------------------------
// (NS = { "Cache-Control": "no-store" } is declared once, below, and reused here.)

/** GET /api/push/key — the VAPID public key for the browser's applicationServerKey.
 *  Public (no session needed); empty when push isn't configured. */
export function handlePushKey(env: Env, cors: Record<string, string>): Response {
  return json({ key: env.VAPID_PUBLIC_KEY ?? "" }, 200, cors, NS);
}

/** POST /api/push/subscribe — store the caller's browser PushSubscription. */
export async function handlePushSubscribe(req: Request, db: DbClient, now: number, cors: Record<string, string>): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  let body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  try { body = (await req.json()) as typeof body; } catch { return json({ error: "bad_body" }, 400, cors, NS); }
  if (!body.endpoint || typeof body.endpoint !== "string") return json({ error: "bad_body" }, 400, cors, NS);
  // The stored endpoint is later POSTed to by the DO (server-side fetch). Reject
  // anything that isn't a real push-service URL so it can't be used as a blind SSRF
  // / outbound-request amplifier to an attacker-chosen host.
  if (!isAllowedPushEndpoint(body.endpoint)) return json({ error: "bad_endpoint" }, 400, cors, NS);
  await savePushSubscription(db, me, { endpoint: body.endpoint, p256dh: body.keys?.p256dh, auth: body.keys?.auth }, now);
  return json({ ok: true }, 200, cors, NS);
}

/** POST /api/push/unsubscribe — remove a subscription by endpoint (idempotent). */
export async function handlePushUnsubscribe(req: Request, db: DbClient, now: number, cors: Record<string, string>): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  let body: { endpoint?: string };
  try { body = (await req.json()) as typeof body; } catch { return json({ error: "bad_body" }, 400, cors, NS); }
  if (body.endpoint) await deletePushSubscription(db, body.endpoint);
  return json({ ok: true }, 200, cors, NS);
}

/**
 * GET /api/chats/:id/search?q= — within-chat message search (Slice 9). Gated:
 * unauthenticated → 401, non-member → 403 (search never leaks a chat the caller
 * isn't in). An empty/blank `q` short-circuits to `[]` without touching the DO.
 * Otherwise the DO's `search` RPC runs a LIKE-escaped scan of THIS chat's log and
 * returns matching Wires (newest-first, with reactions). Global cross-chat search
 * is `handleGlobalSearch` below — a bounded fan-out across the caller's chats (no
 * D1/FTS mirror; bodies live only in each DO).
 */
export async function handleSearch(
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
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (!q) return json({ messages: [] }, 200, cors, { "Cache-Control": "no-store" });
  const stub = conversation(env).get(conversation(env).idFromName(chatId));
  const messages = await stub.search(q, chatId, me);
  return json({ messages }, 200, cors, { "Cache-Control": "no-store" });
}

/**
 * GET /api/search?q= — GLOBAL search across every chat the caller is a member of.
 * Fans out the within-chat search to each chat's DO (in parallel, capped), merges,
 * and returns the newest matches (each carries its chatId so the UI shows context).
 * Each DO search is already member-scoped by construction (we only query the
 * caller's own chats). No chat-scoped gate needed beyond the membership list.
 */
export async function handleGlobalSearch(
  req: Request,
  env: Env,
  db: DbClient,
  now: number,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, { "Cache-Control": "no-store" });
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (!q) return json({ results: [] }, 200, cors, { "Cache-Control": "no-store" });
  // The caller's chats (cap the fan-out so a huge membership can't blow up — each
  // chat is one DO round-trip). 20 keeps a global search to ≤20 concurrent DO reads.
  const rows = await db.all("SELECT chat_id FROM chat_members WHERE user_id = ? LIMIT 20", [me]);
  const ns = conversation(env);
  const PER_CHAT = 8;
  const lists = await Promise.all(
    rows.map(async (r) => {
      const chatId = String(r.chat_id);
      try { return await ns.get(ns.idFromName(chatId)).search(q, chatId, me, PER_CHAT); }
      catch { return []; }
    }),
  );
  const all = lists.flat();
  all.sort((a, b) => b.createdAt - a.createdAt);
  return json({ results: all.slice(0, 40) }, 200, cors, { "Cache-Control": "no-store" });
}

/**
 * POST /api/chats/:id/forward { messages:[{body}] } — forward up to 20 messages
 * into a TARGET chat. Gated server-side against the TARGET (never the source):
 * the caller must be a member, and if the target is a channel only owner/admin may
 * post (same broadcast rule the DO enforces for live sends). Each body is trimmed
 * + length-checked (1..4000); a bad/empty body is skipped, not fatal. Each kept
 * message is appended via the target DO's `appendMessage` RPC with is_forwarded=1
 * (so it broadcasts to live members + shows the "forwarded" badge). Returns the
 * count actually forwarded.
 */
export async function handleForward(
  req: Request,
  env: Env,
  db: DbClient,
  now: number,
  chatId: string,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, { "Cache-Control": "no-store" });
  // Gate on the TARGET chat: membership first (403 if not a member), then the
  // channel-post rule (a plain member can't post into a channel → 403).
  if (!(await isMember(db, chatId, me))) return json({ error: "forbidden" }, 403, cors, { "Cache-Control": "no-store" });
  if ((await chatType(db, chatId)) === "channel") {
    const role = await getRole(db, chatId, me);
    if (role !== "owner" && role !== "admin") return json({ error: "forbidden" }, 403, cors, { "Cache-Control": "no-store" });
  }
  let body: { messages?: unknown };
  try {
    body = (await req.json()) as { messages?: unknown };
  } catch {
    return json({ error: "bad_json" }, 400, cors, { "Cache-Control": "no-store" });
  }
  if (!Array.isArray(body.messages)) return json({ error: "bad_messages" }, 400, cors, { "Cache-Control": "no-store" });
  // Cap the batch at 20; validate each body (trim, 1..4000) — skip anything empty
  // or over-long rather than fail the whole request.
  const bodies = body.messages
    .slice(0, 20)
    .map((m) => (m && typeof (m as { body?: unknown }).body === "string" ? String((m as { body: string }).body).trim() : ""))
    .filter((b) => b.length > 0 && b.length <= MAX_BODY);
  const ns = conversation(env);
  const stub = ns.get(ns.idFromName(chatId));
  let forwarded = 0;
  try {
    for (const b of bodies) {
      // Pass the real chatId: a target DO with no live socket can't recover it, so
      // without it mirrorLastMessage + pushOffline would silently no-op.
      await stub.appendMessage(chatId, me, b, true);
      forwarded++;
    }
  } catch (e) {
    // The DO throws "rate_limited" once the caller trips the per-user forward flood
    // meter — stop and report partial progress (429). Anything else propagates.
    if (e instanceof Error && e.message.includes("rate_limited")) {
      return json({ error: "rate_limited", forwarded }, 429, cors, { "Cache-Control": "no-store" });
    }
    throw e;
  }
  return json({ forwarded }, 200, cors, { "Cache-Control": "no-store" });
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
  // Slice 7: a target who opted out of auto-add isn't added — the actor gets an
  // invite code to share instead (invited:true). An added target omits both.
  if (r.invited) return json({ ok: true, userId: targetId, invited: true, inviteCode: r.inviteCode }, 200, cors, NS);
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

// ---- Slice 6: public discovery + open-join ----

/**
 * GET /api/chats/by-slug/:slug — resolve a public chat (or one the caller is a
 * member of) to a preview. Auth is required (the discovery pages are behind the
 * BFF), but membership is NOT — a public chat previews to any signed-in user.
 * A private chat (or unknown slug) the caller isn't in → 404 `{error:"private"}`,
 * deliberately indistinguishable from not-found so nothing leaks beyond existence.
 * The preview carries no message content.
 */
export async function handleGetBySlug(
  req: Request,
  db: DbClient,
  now: number,
  slug: string,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  const r = await getPreviewBySlug(db, slug, me);
  if ("error" in r) return json({ error: r.error }, 404, cors, NS);
  return json(r, 200, cors, NS);
}

/**
 * POST /api/chats/:id/join (and its `/subscribe` alias for channels) — open-join
 * a PUBLIC chat as a plain member. Idempotent: an already-member returns 200. A
 * private/unknown chat → 403 `{error:"must_request"}` (invites/requests = Slice 7).
 */
export async function handleJoin(
  req: Request,
  db: DbClient,
  now: number,
  chatId: string,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  const r = await joinPublic(db, chatId, me, now);
  if (!r.ok) return json({ error: r.error }, 403, cors, NS);
  return json({ ok: true, joined: r.joined }, 200, cors, NS);
}

// ---- Slice 7: invite codes, join requests, privacy ----

/**
 * Map an invite/request error to a status. Authz denials (not a member / not an
 * admin) → 403; a missing chat/request → 404; everything else (bad input,
 * already-member, not-requestable, …) → 400.
 */
function statusForInviteError(error: string): number {
  if (error === "not_member" || error === "forbidden") return 403;
  if (error === "not_found" || error === "request_not_found") return 404;
  return 400;
}

/**
 * POST /api/chats/:id/invite — owner/admin get-or-create the chat's invite code.
 * Body `{refresh:true}` rotates it (invalidating the old link). Returns `{code}`.
 */
export async function handleCreateInvite(
  req: Request,
  db: DbClient,
  now: number,
  chatId: string,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  let body: { refresh?: boolean } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text) as { refresh?: boolean };
  } catch {
    return json({ error: "bad_json" }, 400, cors, NS);
  }
  const r = body.refresh ? await refreshInvite(db, chatId, me) : await getOrCreateInvite(db, chatId, me);
  if (!r.ok) return json({ error: r.error }, statusForInviteError(r.error), cors, NS);
  return json({ ok: true, code: r.code }, 200, cors, NS);
}

/** DELETE /api/chats/:id/invite — owner/admin revoke the chat's invite code. */
export async function handleRevokeInvite(
  req: Request,
  db: DbClient,
  now: number,
  chatId: string,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  const r = await revokeInvite(db, chatId, me);
  if (!r.ok) return json({ error: r.error }, statusForInviteError(r.error), cors, NS);
  return json({ ok: true }, 200, cors, NS);
}

/**
 * GET /api/invite/:code — resolve an invite code to a preview (id/type/name/
 * memberCount), no bodies. Unknown or revoked → 404 `{error:"bad_invite"}`,
 * indistinguishable so a revoked link leaks nothing.
 */
export async function handleResolveInvite(
  req: Request,
  db: DbClient,
  now: number,
  code: string,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  const preview = await resolveInvite(db, code);
  if (!preview) return json({ error: "bad_invite" }, 404, cors, NS);
  return json(preview, 200, cors, NS);
}

/**
 * POST /api/invite/:code/accept — join by invite (bypasses visibility). Idempotent;
 * an unknown/revoked code → 404 `{error:"bad_invite"}`.
 */
export async function handleAcceptInvite(
  req: Request,
  db: DbClient,
  now: number,
  code: string,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  const r = await joinByInvite(db, code, me, now);
  if (!r.ok) return json({ error: r.error }, 404, cors, NS);
  return json({ ok: true, chatId: r.chatId, joined: r.joined }, 200, cors, NS);
}

/** POST /api/chats/:id/request — a non-member requests to join a private+slug chat. */
export async function handleRequestJoin(
  req: Request,
  db: DbClient,
  now: number,
  chatId: string,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  const r = await requestJoin(db, chatId, me, now);
  if (!r.ok) return json({ error: r.error }, statusForInviteError(r.error), cors, NS);
  return json({ ok: true, status: r.status }, 200, cors, NS);
}

/** GET /api/chats/:id/requests — owner/admin list pending join requests. */
export async function handleListRequests(
  req: Request,
  db: DbClient,
  now: number,
  chatId: string,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  const r = await listRequests(db, chatId, me);
  if (!r.ok) return json({ error: r.error }, statusForInviteError(r.error), cors, NS);
  return json({ requests: r.requests }, 200, cors, NS);
}

/** POST /api/chats/:id/requests/:rid/approve — owner/admin approve (adds member). */
export async function handleApproveRequest(
  req: Request,
  db: DbClient,
  now: number,
  chatId: string,
  requestId: string,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  const r = await approveRequest(db, chatId, requestId, me, now);
  if (!r.ok) return json({ error: r.error }, statusForInviteError(r.error), cors, NS);
  return json({ ok: true, userId: r.userId }, 200, cors, NS);
}

/** POST /api/chats/:id/requests/:rid/reject — owner/admin reject a request. */
export async function handleRejectRequest(
  req: Request,
  db: DbClient,
  now: number,
  chatId: string,
  requestId: string,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  const r = await rejectRequest(db, chatId, requestId, me);
  if (!r.ok) return json({ error: r.error }, statusForInviteError(r.error), cors, NS);
  return json({ ok: true }, 200, cors, NS);
}

/** GET /api/account/privacy — the caller's auto-group-add preference. */
export async function handleGetPrivacy(
  req: Request,
  db: DbClient,
  now: number,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  return json({ allowAutoGroupAdd: await getAllowAutoGroupAdd(db, me) }, 200, cors, NS);
}

/** POST /api/account/privacy { allowAutoGroupAdd } — set the caller's preference. */
export async function handleSetPrivacy(
  req: Request,
  db: DbClient,
  now: number,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  let body: { allowAutoGroupAdd?: unknown };
  try {
    body = (await req.json()) as { allowAutoGroupAdd?: unknown };
  } catch {
    return json({ error: "bad_json" }, 400, cors, NS);
  }
  if (typeof body.allowAutoGroupAdd !== "boolean") return json({ error: "bad_value" }, 400, cors, NS);
  await setAllowAutoGroupAdd(db, me, body.allowAutoGroupAdd);
  return json({ ok: true, allowAutoGroupAdd: body.allowAutoGroupAdd }, 200, cors, NS);
}

/**
 * POST /api/account/delete — erase the caller's meowsenger-side data (Slice 9).
 * Session-gated (401 without a valid session) and confirm-required: the body must
 * carry `{confirm:true}` (or `{confirm:"delete"}`), else 400 `confirm_required` —
 * so a stray POST can't nuke an account.
 *
 * Erasure is child-first, per the caller only:
 *   1. For every chat they're a member of, run the shared `leave` logic — which
 *      handles owner transfer / last-member chat delete correctly (so a chat they
 *      solely own is deleted, and one they co-own transfers ownership). We snapshot
 *      the membership list first, then leave each (leaving mutates chat_members).
 *   2. Delete any of their `join_requests` (pending/decided).
 *   3. Delete their `sessions` (logs them out everywhere).
 *   4. Delete their `users` row.
 * Then clear the session cookie in the response.
 *
 * NOTE: message bodies persist in each chat's DO SQLite under the raw senderId —
 * the id no longer resolves to a user row, so the UI shows the bare id. That's
 * acceptable for this slice; full per-DO message erasure is a documented follow-up.
 * The auth-side account is separate (auth owns that).
 */
export async function handleDeleteAccount(
  req: Request,
  db: DbClient,
  now: number,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, NS);
  let body: { confirm?: unknown } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text) as { confirm?: unknown };
  } catch {
    return json({ error: "bad_json" }, 400, cors, NS);
  }
  // Require an explicit confirmation — true, or the string "delete".
  if (body.confirm !== true && body.confirm !== "delete") {
    return json({ error: "confirm_required" }, 400, cors, NS);
  }

  // 1. Snapshot the caller's chats, then leave each (leave() reconciles owner
  //    transfer / last-member delete). Snapshot first — leaving mutates the list.
  const chatRows = await db.all("SELECT chat_id FROM chat_members WHERE user_id = ?", [me]);
  for (const row of chatRows) {
    await leave(db, String(row.chat_id), me);
  }
  // 2–4. Remove the caller's remaining D1 footprint, child-first.
  await db.run("DELETE FROM join_requests WHERE user_id = ?", [me]);
  await db.run("DELETE FROM push_subscriptions WHERE user_id = ?", [me]);
  await db.run("DELETE FROM sessions WHERE user_id = ?", [me]);
  await db.run("DELETE FROM users WHERE id = ?", [me]);

  return json({ ok: true }, 200, cors, { ...NS, "Set-Cookie": clearCookie(SESSION_COOKIE) });
}
