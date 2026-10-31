/**
 * Meowsenger releases a profile's username (`~<id>`, see workers/meowsenger/src/users.ts)
 * when another account claims it. `~` is never valid in a meowerse username, so it
 * marks a placeholder that must never be shown raw.
 */
export const isReleasedUsername = (username: string | null | undefined): boolean => !!username && username.startsWith("~");

/** The @handle to show, or null when it is a released placeholder (or empty). */
export function shownUsername(username: string | null | undefined): string | null {
  return username && !isReleasedUsername(username) ? username : null;
}

/** Best label for a person: display name, else the real username, else "former user". */
export function shownName(displayName: string | null | undefined, username: string | null | undefined): string {
  return displayName || shownUsername(username) || "former user";
}
