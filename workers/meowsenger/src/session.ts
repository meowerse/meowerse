import type { DbClient } from "./types";

export const SESSION_COOKIE = "__Host-mw_session";
export const TXN_COOKIE = "__Host-mw_txn";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface Session {
  id: string;
  userId: string;
  accessToken: string;
  refreshToken: string | null;
  accessExp: number;
  createdAt: number;
  expiresAt: number;
}

export async function createSession(
  db: DbClient,
  i: { id: string; userId: string; accessToken: string; refreshToken: string | null; accessExp: number; now: number },
): Promise<Session> {
  const s: Session = {
    id: i.id, userId: i.userId, accessToken: i.accessToken, refreshToken: i.refreshToken,
    accessExp: i.accessExp, createdAt: i.now, expiresAt: i.now + SESSION_TTL_MS,
  };
  await db.run(
    `INSERT INTO sessions (id, user_id, access_token, refresh_token, access_exp, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [s.id, s.userId, s.accessToken, s.refreshToken, s.accessExp, s.createdAt, s.expiresAt],
  );
  return s;
}

export async function getSession(db: DbClient, id: string, now: number): Promise<Session | null> {
  const row = await db.first(
    `SELECT id, user_id, access_token, refresh_token, access_exp, created_at, expires_at
     FROM sessions WHERE id = ?`,
    [id],
  );
  if (!row) return null;
  if (Number(row.expires_at) < now) {
    await deleteSession(db, id);
    return null;
  }
  return {
    id: String(row.id), userId: String(row.user_id), accessToken: String(row.access_token),
    refreshToken: row.refresh_token == null ? null : String(row.refresh_token),
    accessExp: Number(row.access_exp), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
  };
}

export async function deleteSession(db: DbClient, id: string): Promise<void> {
  await db.run("DELETE FROM sessions WHERE id = ?", [id]);
}

/** __Host- cookie: httpOnly, Secure, SameSite=Lax, Path=/, no Domain (host-scoped). */
export function sessionCookie(id: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearCookie(name: string): string {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
