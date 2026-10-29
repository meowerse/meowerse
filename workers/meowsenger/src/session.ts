import type { DbClient } from "./types";

export const SESSION_COOKIE = "__Host-mw_session";
export const TXN_COOKIE = "__Host-mw_txn";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface Session {
  /** Stored row id: sha256hex(cookie value), never the cookie itself. */
  id: string;
  userId: string;
  accessExp: number;
  createdAt: number;
  expiresAt: number;
}

/** Lowercase hex SHA-256 of the UTF-8 cookie value; what is stored as `sessions.id`. */
export async function sha256hex(v: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Raw cookies are base64url of 32 bytes (43 chars) and can never look like a
// 64-char hex digest, so a hash-shaped cookie is never tried as a legacy raw id
// (otherwise a leaked stored hash could be replayed as a cookie).
const HASH_SHAPE = /^[0-9a-f]{64}$/;

const SELECT_SESSION = `SELECT id, user_id, access_exp, created_at, expires_at FROM sessions WHERE id = ?`;

/** `i.id` is the raw cookie value; only its hash is stored. OAuth tokens are never persisted. */
export async function createSession(
  db: DbClient,
  i: { id: string; userId: string; accessExp: number; now: number },
): Promise<Session> {
  const hash = await sha256hex(i.id);
  const s: Session = {
    id: hash, userId: i.userId, accessExp: i.accessExp, createdAt: i.now, expiresAt: i.now + SESSION_TTL_MS,
  };
  // Opportunistic prune of expired rows (idx_sessions_expires); no cron needed.
  await db.run("DELETE FROM sessions WHERE expires_at < ?", [i.now]);
  await db.run(
    `INSERT INTO sessions (id, user_id, access_token, refresh_token, access_exp, created_at, expires_at)
     VALUES (?, ?, '', NULL, ?, ?, ?)`,
    [s.id, s.userId, s.accessExp, s.createdAt, s.expiresAt],
  );
  return s;
}

function toSession(row: Record<string, unknown>): Session {
  return {
    id: String(row.id), userId: String(row.user_id),
    accessExp: Number(row.access_exp), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
  };
}

export async function getSession(db: DbClient, cookie: string, now: number): Promise<Session | null> {
  if (!cookie) return null;
  const hash = await sha256hex(cookie);
  let row = await db.first(SELECT_SESSION, [hash]);
  if (!row && !HASH_SHAPE.test(cookie)) {
    const legacy = await db.first(SELECT_SESSION, [cookie]);
    if (legacy) {
      if (Number(legacy.expires_at) < now) {
        await db.run("DELETE FROM sessions WHERE id = ?", [cookie]);
        return null;
      }
      // Migrate in place: hash the id and blank any stored tokens. A concurrent
      // first use matches 0 rows here; the re-read by hash covers that.
      await db.run(
        "UPDATE sessions SET id = ?, access_token = '', refresh_token = NULL WHERE id = ?",
        [hash, cookie],
      );
      row = await db.first(SELECT_SESSION, [hash]);
    }
  }
  if (!row) return null;
  if (Number(row.expires_at) < now) {
    await db.run("DELETE FROM sessions WHERE id = ?", [hash]);
    return null;
  }
  return toSession(row);
}

/** Deletes the hashed row and any legacy raw-id row for this cookie. */
export async function deleteSession(db: DbClient, cookie: string): Promise<void> {
  if (!cookie) return;
  const hash = await sha256hex(cookie);
  await db.run("DELETE FROM sessions WHERE id = ?", [hash]);
  if (!HASH_SHAPE.test(cookie)) await db.run("DELETE FROM sessions WHERE id = ?", [cookie]);
}

/** __Host- cookie: httpOnly, Secure, SameSite=Lax, Path=/, no Domain (host-scoped). */
export function sessionCookie(id: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearCookie(name: string): string {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
