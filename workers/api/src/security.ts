import type { Env } from "./types";

/** Allowlist used when CORS_ORIGINS is unset, mirroring the Go api default. */
export const DEFAULT_ORIGINS = "https://meow.alxnko.eu.org,http://localhost:4321";

function allowlist(env: Env): string[] {
  const raw = (env.CORS_ORIGINS ?? "").trim() || DEFAULT_ORIGINS;
  return raw.split(",").map((o) => o.trim()).filter(Boolean);
}

/**
 * Build CORS response headers for a request `origin`. The origin is echoed back
 * ONLY when it is on the allowlist; credentials are allowed, so a "*" origin is
 * never emitted (echoing the exact origin is the secure pattern for credentialed
 * CORS). `Vary: Origin` keeps caches correct across origins.
 */
export function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    Vary: "Origin",
  };
  if (origin && allowlist(env).includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/**
 * Length-aware constant-time string comparison. Loops over the longer string so
 * runtime does not depend on where the first differing byte is, and folds a
 * length mismatch into the result rather than returning early — this avoids
 * leaking the token (or its length) via timing.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Enforce "Authorization: Bearer <API_TOKEN>" using a constant-time compare.
 * Returns false (never throws) when the header is missing/wrong or when the
 * server has no API_TOKEN configured.
 */
export function requireAuth(req: Request, env: Env): boolean {
  if (!env.API_TOKEN) return false;
  const header = req.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return constantTimeEqual(token, env.API_TOKEN);
}
