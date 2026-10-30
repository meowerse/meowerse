// Typed client for the Meowerse auth worker. All calls are credentialed and
// same-origin (the UI + OIDC/API are one Worker; `base` is "" → relative paths).
// Pure logic — the only unit-tested part of the frontend.

export interface NextStep {
  action: "done" | "redirect" | "consent" | "verify_required";
  url?: string;
  client?: { name: string; logo: string | null };
  scope?: string[];
}

export interface AuthResponse {
  ok?: boolean;
  csrf?: string;
  next?: NextStep;
  recoveryCodes?: string[];
  error?: string;
}

export interface PendingResponse {
  client?: { name: string; logo: string | null };
  scope?: string[];
  csrf?: string;
  error?: string;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

// The optional Turnstile token rides along as `cf-turnstile-response`;
// JSON.stringify drops it when undefined, so callers without Turnstile are unaffected.
export function postSignup(base: string, username: string, password: string, turnstileToken?: string): Promise<AuthResponse> {
  return postJson<AuthResponse>(`${base}/signup`, { username, password, "cf-turnstile-response": turnstileToken });
}

export function postLogin(base: string, username: string, password: string, turnstileToken?: string): Promise<AuthResponse> {
  return postJson<AuthResponse>(`${base}/login`, { username, password, "cf-turnstile-response": turnstileToken });
}

export function postConsent(base: string, decision: "allow" | "deny", csrf: string, scopes?: string[]): Promise<{ redirect?: string; error?: string }> {
  return postJson(`${base}/consent`, { decision, csrf, scopes: scopes ? scopes.join(" ") : undefined });
}

export async function getPending(base: string): Promise<PendingResponse> {
  const res = await fetch(`${base}/authorize/pending`, { credentials: "include" });
  return (await res.json()) as PendingResponse;
}

export interface ClientSummary {
  clientId: string;
  name: string;
  displayName: string | null;
  clientType: string;
  allowedScopes: string[];
  verifiedOnly: boolean;
  status: string;
}

export async function tgStart(
  base: string,
  kind?: "VERIFY_EXISTING",
  auth?: { csrf: string; currentPassword?: string },
): Promise<{ ticketId?: string; deepLink?: string; error?: string; reauth?: string }> {
  // VERIFY_EXISTING (linking) requires the session CSRF token and fresh authentication (recent login or current password).
  const body = kind ? { kind, ...(auth ? { csrf: auth.csrf, ...(auth.currentPassword ? { current_password: auth.currentPassword } : {}) } : {}) } : {};
  const res = await fetch(`${base}/tg/start`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return (await res.json()) as { ticketId?: string; deepLink?: string; error?: string; reauth?: string };
}

// --- account self-service ---
export interface AccountInfo {
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  verified: boolean;
  hasPassword: boolean;
  telegram: { linked: boolean; username: string | null };
  recoveryRemaining: number;
  csrf: string;
  deleteEnabled?: boolean;
  error?: string;
}
export interface Grant {
  clientId: string;
  /** App display name from the server (null → show the client id only). Optional for older servers. */
  displayName?: string | null;
  approvedScopes: string[];
  updatedAt: string | null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  if (res.status === 401) return { error: "no_session" } as T;
  if (!res.ok) return { error: "http" } as T;
  return (await res.json()) as T;
}

export function getAccount(base: string): Promise<AccountInfo> {
  return getJson<AccountInfo>(`${base}/api/account`);
}
export function postAccountPassword(base: string, csrf: string, current: string, next: string): Promise<{ ok?: boolean; error?: string }> {
  return postJson(`${base}/api/account/password`, { csrf, current_password: current, new_password: next });
}
export function getGrants(base: string): Promise<{ grants?: Grant[]; error?: string }> {
  return getJson(`${base}/api/account/grants`);
}
/** Step 1 of account deletion: prove fresh authentication (recent login, or the current password) and get a single-use token. */
export function startAccountDelete(
  base: string,
  csrf: string,
  currentPassword?: string,
): Promise<{ confirm_token?: string; expires_in?: number; error?: string; reauth?: "password" | "telegram" }> {
  return postJson(`${base}/api/account/delete/start`, { csrf, ...(currentPassword ? { current_password: currentPassword } : {}) });
}
/** Step 2: delete, presenting the typed username and the token from {@link startAccountDelete}. */
export function deleteAccount(base: string, csrf: string, confirm: string, confirmToken: string): Promise<{ ok?: boolean; error?: string }> {
  return postJson(`${base}/api/account/delete`, { csrf, confirm, confirm_token: confirmToken });
}
export function revokeGrant(base: string, csrf: string, clientId: string): Promise<{ ok?: boolean; error?: string }> {
  return postJson(`${base}/api/account/grants/revoke`, { csrf, client_id: clientId });
}
export function unlinkTelegram(base: string, csrf: string): Promise<{ ok?: boolean; error?: string }> {
  return postJson(`${base}/api/account/telegram/unlink`, { csrf });
}
export function regenerateRecoveryCodes(base: string, csrf: string): Promise<{ recoveryCodes?: string[]; error?: string }> {
  return postJson(`${base}/api/account/recovery-codes`, { csrf });
}

// --- developer dashboard (mutations) ---
export function deleteClient(base: string, csrf: string, clientId: string): Promise<{ ok?: boolean; error?: string }> {
  return postJson(`${base}/api/dev/clients/delete`, { csrf, client_id: clientId });
}
export function rotateClientSecret(base: string, csrf: string, clientId: string): Promise<{ ok?: boolean; clientSecret?: string; error?: string }> {
  return postJson(`${base}/api/dev/clients/rotate-secret`, { csrf, client_id: clientId });
}
export function postManagementToken(base: string, csrf: string): Promise<{ token?: string; error?: string }> {
  return postJson(`${base}/api/dev/tokens`, { csrf });
}

export async function tgStatus(base: string, ticketId: string): Promise<{ ready: boolean; next?: NextStep; error?: string }> {
  const res = await fetch(`${base}/tg/status?ticket=${encodeURIComponent(ticketId)}`, { credentials: "include" });
  return (await res.json()) as { ready: boolean; next?: NextStep; error?: string };
}

export function listClients(base: string): Promise<{ clients?: ClientSummary[]; csrf?: string; error?: string }> {
  return getJson(`${base}/api/dev/clients`);
}

export async function createClient(
  base: string,
  body: { csrf: string; name: string; display_name?: string; client_type: string; redirect_uris: string; scopes: string; verified_only?: string },
): Promise<{ ok?: boolean; clientId?: string; clientSecret?: string; error?: string }> {
  const res = await fetch(`${base}/api/dev/clients`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return (await res.json()) as { ok?: boolean; clientId?: string; clientSecret?: string; error?: string };
}

/** Where the browser should go for a given post-auth `next` step (pure, testable). */
export function nextLocation(next: NextStep | undefined): string {
  if (!next) return "/account";
  if (next.action === "redirect" && next.url) return next.url;
  if (next.action === "consent") return "/consent";
  if (next.action === "verify_required") return "/verify";
  return "/account";
}

/** The only `reauth` purpose the sign-in pages honour (allowlist: anything else is ignored, so no open redirect). */
export const REAUTH_DELETE = "delete";

/** True when `search` (a location.search string) asks to resume the account-deletion dialog after re-authenticating. */
export function wantsDeleteReauth(search: string): boolean {
  return new URLSearchParams(search).get("reauth") === REAUTH_DELETE;
}

/**
 * Where to go after signing in. Normally {@link nextLocation}; but a sign-in started from the delete dialog
 * (`?reauth=delete`) that would land on /account returns there with the same marker so the dialog reopens.
 * Never builds a location from user input: only the fixed same-origin path below.
 */
export function postAuthLocation(next: NextStep | undefined, search: string): string {
  const loc = nextLocation(next);
  return loc === "/account" && wantsDeleteReauth(search) ? `/account?reauth=${REAUTH_DELETE}` : loc;
}
