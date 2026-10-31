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
 * Prefix of a RELEASED username. meowerse auth only allows `[a-zA-Z0-9_]{3,32}`
 * (workers/auth/src/accounts.ts), so a name starting with `~` can never be a real
 * username, never collides with one, and is never resolvable by username.
 */
export const RELEASED_USERNAME_PREFIX = "~";

/** True for a placeholder left on a profile whose username was handed to another account. */
export function isReleasedUsername(username: string): boolean {
  return username.startsWith(RELEASED_USERNAME_PREFIX);
}

/**
 * Upsert the caller into the messenger's own user directory from OIDC /userinfo
 * claims. Keyed by `sub`; refreshed on every login.
 *
 * Auth is the source of truth: a username belongs to exactly one `sub` at a time, so
 * any OTHER row holding the incoming username is stale (its account was deleted or
 * renamed). Because `users.username` is UNIQUE, that row is first moved to the
 * placeholder `~<its id>` (deterministic, unique, unresolvable); display name, avatar,
 * messages and memberships are untouched. Both statements run in ONE D1 batch
 * (atomic). If the stale account signs in again, its own upsert writes its current
 * username back over the placeholder. A UNIQUE race between two batches is retried
 * once.
 */
export async function upsertUser(db: DbClient, info: UserInfo, now: number): Promise<void> {
  // An account without a username (Telegram-only) is stored under the unaddressable
  // placeholder form, never under its bare id: an id-shaped username could otherwise
  // be registered in auth and claim this row's handle through the release below.
  const claimsName = typeof info.preferred_username === "string" && info.preferred_username.length > 0;
  const username = claimsName ? info.preferred_username! : RELEASED_USERNAME_PREFIX + info.sub;
  const release = {
    // Never release a legacy row whose username is its own id (pre-placeholder data).
    sql: `UPDATE users SET username = '${RELEASED_USERNAME_PREFIX}' || id WHERE username = ? AND id != ? AND username != id`,
    params: [username, info.sub],
  };
  const stmts = [
    // Only a real auth username can be claimed from another row.
    ...(claimsName ? [release] : [{ sql: "SELECT 0 WHERE 0", params: [] }]),
    {
      sql: `INSERT INTO users (id, username, display_name, avatar_url, verified, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       username = excluded.username,
       display_name = excluded.display_name,
       avatar_url = excluded.avatar_url,
       verified = excluded.verified,
       updated_at = excluded.updated_at`,
      params: [info.sub, username, info.name ?? null, info.picture ?? null, info.verified ? 1 : 0, now],
    },
  ];
  const batch = db.batch?.bind(db);
  if (!batch) throw new Error("upsertUser requires an atomic db.batch");
  let changes: number[];
  try {
    changes = await batch(stmts);
  } catch (e) {
    if (!/UNIQUE/i.test(String(e))) throw e;
    changes = await batch(stmts); // lost a race with a concurrent sign-in: re-release, then claim
  }
  const released = changes[0] ?? 0;
  if (released > 0) console.log(`user_username_released count=${released}`);
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
  names = names.filter((n) => !isReleasedUsername(n)); // a released placeholder is never addressable
  if (names.length === 0) return map;
  const placeholders = names.map(() => "?").join(", ");
  const rows = await db.all(`SELECT id, username FROM users WHERE username IN (${placeholders}) AND username NOT LIKE '~%'`, names);
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
