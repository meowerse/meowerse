import type { Env } from "./types";

/**
 * Cloudflare Turnstile server-side verification (bot protection) for the
 * HUMAN-facing endpoints only — POST /signup and POST /login. It is NEVER
 * applied to the machine OIDC endpoints (/authorize, /token, /userinfo, /jwks,
 * /.well-known, introspect/revoke, /mgmt): relying-party apps call those
 * programmatically and cannot solve a challenge, so gating them would break
 * every integration.
 *
 * Enforcement is CONFIG-GATED on TURNSTILE_SECRET_KEY:
 *   - unset  → disabled, requests pass unchanged (nothing to break before keys exist)
 *   - set    → a valid `cf-turnstile-response` token is required
 *
 * `fetchFn` is injectable so tests never hit the network.
 */
export async function verifyTurnstile(
  token: string,
  secret: string,
  remoteIp: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);
    const res = await fetchFn("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const j = (await res.json()) as { success?: boolean };
    return j.success === true;
  } catch {
    return false;
  }
}

/** True when the request may proceed: Turnstile disabled, or a valid token. */
export async function turnstileGate(
  env: Env,
  params: Record<string, string>,
  remoteIp: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true; // not configured → no-op
  return verifyTurnstile(params["cf-turnstile-response"] ?? "", env.TURNSTILE_SECRET_KEY, remoteIp, fetchFn);
}
