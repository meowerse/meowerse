// Typed client for the Meowerse auth worker. All calls are credentialed
// (cookies travel to auth-api over the shared registrable domain). Pure logic —
// the only unit-tested part of the frontend.

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

export function postSignup(base: string, username: string, password: string): Promise<AuthResponse> {
  return postJson<AuthResponse>(`${base}/signup`, { username, password });
}

export function postLogin(base: string, username: string, password: string): Promise<AuthResponse> {
  return postJson<AuthResponse>(`${base}/login`, { username, password });
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

export async function tgStart(base: string, kind?: "VERIFY_EXISTING"): Promise<{ ticketId?: string; deepLink?: string; error?: string }> {
  const res = await fetch(`${base}/tg/start`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(kind ? { kind } : {}) });
  return (await res.json()) as { ticketId?: string; deepLink?: string; error?: string };
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
  error?: string;
}
export interface Grant {
  clientId: string;
  approvedScopes: string[];
  updatedAt: string | null;
}

export async function getAccount(base: string): Promise<AccountInfo> {
  return (await fetch(`${base}/api/account`, { credentials: "include" })).json() as Promise<AccountInfo>;
}
export function postAccountPassword(base: string, csrf: string, current: string, next: string): Promise<{ ok?: boolean; error?: string }> {
  return postJson(`${base}/api/account/password`, { csrf, current_password: current, new_password: next });
}
export async function getGrants(base: string): Promise<{ grants?: Grant[]; error?: string }> {
  return (await fetch(`${base}/api/account/grants`, { credentials: "include" })).json() as Promise<{ grants?: Grant[]; error?: string }>;
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

export async function tgStatus(base: string, ticketId: string): Promise<{ ready: boolean; next?: NextStep }> {
  const res = await fetch(`${base}/tg/status?ticket=${encodeURIComponent(ticketId)}`, { credentials: "include" });
  return (await res.json()) as { ready: boolean; next?: NextStep };
}

export async function listClients(base: string): Promise<{ clients?: ClientSummary[]; csrf?: string; error?: string }> {
  const res = await fetch(`${base}/api/dev/clients`, { credentials: "include" });
  return (await res.json()) as { clients?: ClientSummary[]; csrf?: string; error?: string };
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
