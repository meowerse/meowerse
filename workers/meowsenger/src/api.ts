import type { DbClient } from "./types";
import { json, readCookies } from "./security";
import { getSession, deleteSession, clearCookie, SESSION_COOKIE } from "./session";
import { getUser } from "./users";

/** GET /api/session — whoami via the BFF cookie. */
export async function handleSession(req: Request, db: DbClient, now: number, cors: Record<string, string>): Promise<Response> {
  const sid = readCookies(req.headers.get("Cookie"))[SESSION_COOKIE];
  const noStore = { "Cache-Control": "no-store" };
  if (!sid) return json({ authenticated: false }, 200, cors, noStore);
  const s = await getSession(db, sid, now);
  if (!s) return json({ authenticated: false }, 200, cors, noStore);
  const user = await getUser(db, s.userId);
  if (!user) return json({ authenticated: false }, 200, cors, noStore);
  return json({ authenticated: true, user }, 200, cors, noStore);
}

/** POST /auth/logout — delete the session server-side + clear the cookie. */
export async function handleLogout(req: Request, db: DbClient, now: number, cors: Record<string, string>): Promise<Response> {
  const sid = readCookies(req.headers.get("Cookie"))[SESSION_COOKIE];
  if (sid) await deleteSession(db, sid);
  return json({ ok: true }, 200, cors, { "Set-Cookie": clearCookie(SESSION_COOKIE) });
}
