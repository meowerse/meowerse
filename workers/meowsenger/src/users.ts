import type { DbClient } from "./types";

export interface UserInfo {
  sub: string;
  preferred_username?: string;
  name?: string;
  picture?: string;
  verified?: boolean;
}

export interface User {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  verified: boolean;
}

/**
 * Upsert the caller into the messenger's own user directory from OIDC /userinfo
 * claims. Keyed by `sub`; refreshed on every login. ON CONFLICT keeps the row
 * current without a second round-trip.
 */
export async function upsertUser(db: DbClient, info: UserInfo, now: number): Promise<void> {
  await db.run(
    `INSERT INTO users (id, username, display_name, avatar_url, verified, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       username = excluded.username,
       display_name = excluded.display_name,
       avatar_url = excluded.avatar_url,
       verified = excluded.verified,
       updated_at = excluded.updated_at`,
    [info.sub, info.preferred_username ?? info.sub, info.name ?? null, info.picture ?? null, info.verified ? 1 : 0, now],
  );
}

export async function getUser(db: DbClient, id: string): Promise<User | null> {
  const row = await db.first(
    "SELECT id, username, display_name, avatar_url, verified FROM users WHERE id = ?",
    [id],
  );
  if (!row) return null;
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: row.display_name == null ? null : String(row.display_name),
    avatarUrl: row.avatar_url == null ? null : String(row.avatar_url),
    verified: Number(row.verified) === 1,
  };
}
