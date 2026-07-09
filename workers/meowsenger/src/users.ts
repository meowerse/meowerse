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

/**
 * Resolve MANY usernames → ids in ONE query (`WHERE username IN (…)`) instead of a
 * per-name round-trip. Returns a Map keyed by the stored username; a requested name
 * with no matching row is simply absent from the map, so the caller can detect the
 * first missing name and surface the same `user_not_found` error as before. An
 * empty `names` array skips the query. Names are matched verbatim (callers already
 * trim), mirroring the single-name lookup.
 */
export async function userIdsByNames(db: DbClient, names: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (names.length === 0) return map;
  const placeholders = names.map(() => "?").join(", ");
  const rows = await db.all(`SELECT id, username FROM users WHERE username IN (${placeholders})`, names);
  for (const r of rows) map.set(String(r.username), String(r.id));
  return map;
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

// ---- Slice 7: privacy — the auto-group-add opt-out ----

/**
 * Whether `userId` may be added to a group directly. Defaults to true — a missing
 * row (shouldn't happen for a signed-in user) is treated as opted-in so member-add
 * never silently breaks. When false, `addMember` returns an invite instead of
 * adding the user.
 */
export async function getAllowAutoGroupAdd(db: DbClient, userId: string): Promise<boolean> {
  const row = await db.first("SELECT allow_auto_group_add FROM users WHERE id = ?", [userId]);
  if (!row) return true;
  return Number(row.allow_auto_group_add ?? 1) === 1;
}

/** Set the caller's auto-group-add preference (1 = allow, 0 = opt out). */
export async function setAllowAutoGroupAdd(db: DbClient, userId: string, allow: boolean): Promise<void> {
  await db.run("UPDATE users SET allow_auto_group_add = ? WHERE id = ?", [allow ? 1 : 0, userId]);
}

/** Stamp a user's `last_seen_at` (ms) — called by the DO when their final live
 *  socket in a room drops, for the DM "last seen …" header. Keeps every `users`
 *  D1 write in this module (the DO orchestrates but never writes user rows inline). */
export async function touchLastSeen(db: DbClient, userId: string, at: number): Promise<void> {
  await db.run("UPDATE users SET last_seen_at = ? WHERE id = ?", [at, userId]);
}
