// Typed client for the meowsenger BFF worker. All calls are credentialed so the
// __Host-mw_session cookie (on the API host) rides along. Pure logic — the only
// unit-tested frontend code.
import { request, type RequestResult } from "@meowerse/ui";

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

/**
 * GET /api/session as a typed result. A 200 `{authenticated:false}` is the ONLY
 * definitive "signed out"; network/timeout/5xx come back as errors (never as
 * unauthenticated) and a 401 as `unauthorized`, so callers can't mistake an
 * outage for a logout.
 */
export function getSession(base: string): Promise<RequestResult<SessionInfo>> {
  return request<SessionInfo>(`${base}/api/session`);
}
