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

export function postConsent(base: string, decision: "allow" | "deny", csrf: string): Promise<{ redirect?: string; error?: string }> {
  return postJson(`${base}/consent`, { decision, csrf });
}

export async function getPending(base: string): Promise<PendingResponse> {
  const res = await fetch(`${base}/authorize/pending`, { credentials: "include" });
  return (await res.json()) as PendingResponse;
}

/** Where the browser should go for a given post-auth `next` step (pure, testable). */
export function nextLocation(next: NextStep | undefined): string {
  if (!next) return "/account";
  if (next.action === "redirect" && next.url) return next.url;
  if (next.action === "consent") return "/consent";
  if (next.action === "verify_required") return "/verify";
  return "/account";
}
