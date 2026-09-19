import type { Env } from "./types";
export const DEFAULT_ORIGINS = "https://meowsenger.alxnko.dev,https://meowsenger.alxnko.eu.org,http://localhost:4321";
function allowlist(env: Env): string[] {
  return ((env.CORS_ORIGINS ?? "").trim() || DEFAULT_ORIGINS).split(",").map((o) => o.trim()).filter(Boolean);
}

/**
 * CORS headers for the UI (a different subdomain than this API host). The origin
 * is echoed back ONLY when it is on the allowlist; credentials are allowed, so a
 * "*" origin is never emitted (echoing the exact allowlisted origin is the secure
 * pattern for credentialed CORS). `Vary: Origin` keeps caches correct per-origin.
 *
 * Allow-Headers omits `Authorization` (unlike workers/api): meowsenger auths via
 * the `__Host-mw_session` cookie (sent automatically with credentials), never a
 * Bearer header — no client ever sends Authorization here.
 */
export function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  if (origin && allowlist(env).includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
export function json(body: unknown, status: number, cors: Record<string, string>, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
      ...cors,
      ...extra,
    },
  });
}

// Unambiguous alphabet for human-shareable codes: no 0/O/1/I/l to avoid misreads.
const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

/**
 * A URL-safe random id of `len` chars (default 12) drawn from an unambiguous
 * alphabet, using `crypto.getRandomValues` (CSPRNG). Used for invite codes — a
 * 12-char code over a 31-char alphabet is ~59 bits, ample against guessing.
 */
export function randomId(len = 12): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** Parse a Cookie header into a name→value map (never throws). */
export function readCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
