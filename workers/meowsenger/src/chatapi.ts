import type { DbClient, Env } from "./types";
import type { Conversation } from "./conversation";
import { json, readCookies } from "./security";
import { getSession, SESSION_COOKIE } from "./session";
import { createOrGetDirect, listChats, isMember } from "./chats";

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

/** POST /api/chats { username } — open-or-create a DM with that user. */
export async function handleCreateChat(
  req: Request,
  db: DbClient,
  now: number,
  cors: Record<string, string>,
): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors, { "Cache-Control": "no-store" });
  let body: { username?: string };
  try {
    body = (await req.json()) as { username?: string };
  } catch {
    return json({ error: "bad_json" }, 400, cors, { "Cache-Control": "no-store" });
  }
  const uname = (body.username ?? "").trim();
  if (!uname) return json({ error: "username_required" }, 400, cors, { "Cache-Control": "no-store" });
  const other = await db.first("SELECT id FROM users WHERE username = ?", [uname]);
  if (!other) return json({ error: "user_not_found" }, 404, cors, { "Cache-Control": "no-store" });
  if (String(other.id) === me) return json({ error: "cannot_dm_self" }, 400, cors, { "Cache-Control": "no-store" });
  const r = await createOrGetDirect(db, me, String(other.id), now);
  return json({ chatId: r.id, created: r.created }, 200, cors, { "Cache-Control": "no-store" });
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
