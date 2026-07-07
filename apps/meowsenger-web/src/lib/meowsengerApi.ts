// Typed client for the meowsenger BFF worker. All calls are credentialed so the
// __Host-mw_session cookie (on the API host) rides along. Pure logic — the only
// unit-tested frontend code.
export interface SessionUser {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  verified: boolean;
}
export interface SessionInfo {
  authenticated: boolean;
  user?: SessionUser;
}

export function loginUrl(base: string): string { return `${base}/auth/login`; }
export function logoutUrl(base: string): string { return `${base}/auth/logout`; }

export async function getSession(base: string): Promise<SessionInfo> {
  try {
    const res = await fetch(`${base}/api/session`, { credentials: "include" });
    return (await res.json()) as SessionInfo;
  } catch {
    return { authenticated: false };
  }
}
