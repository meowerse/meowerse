import { b64urlEncode, constantTimeEqual } from "@meowerse/auth-shared";
import type { Env } from "./types";

/** Allowlist used when CORS_ORIGINS is unset. Mirrors workers/api default shape. */
export const DEFAULT_ORIGINS = "https://auth.alxnko.eu.org,http://localhost:4321";

function allowlist(env: Env): string[] {
  const raw = (env.CORS_ORIGINS ?? "").trim() || DEFAULT_ORIGINS;
  return raw.split(",").map((o) => o.trim()).filter(Boolean);
}

/**
 * Credentialed CORS headers. Echoes the exact origin ONLY when allowlisted
 * (never "*"), as required for `credentials: include`. `Vary: Origin` keeps
 * caches correct. Mirrors workers/api.
 */
export function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    Vary: "Origin",
  };
  if (origin && allowlist(env).includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

/** A fresh URL-safe random id of `bytes` entropy (default 256-bit). */
export function randomId(bytes = 32): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * `__Host-`-prefixed cookie (spec §7): forces Secure + Path=/ + no Domain, which
 * blocks sibling-subdomain cookie injection / fixation. Always HttpOnly,
 * SameSite=Lax (so top-level returns from consent/Telegram keep the cookie).
 */
export function hostCookie(name: string, value: string, opts: { maxAge?: number } = {}): string {
  let c = `__Host-${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/`;
  if (opts.maxAge !== undefined) c += `; Max-Age=${opts.maxAge}`;
  return c;
}

/** Expire a `__Host-` cookie. */
export function clearHostCookie(name: string): string {
  return `__Host-${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Parse a `Cookie:` header into a name→value map. */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k) out[k] = part.slice(idx + 1).trim();
  }
  return out;
}

/**
 * Security headers for every capability-bearing response (spec §7, §10/#8):
 * no-referrer (so a `rid`/code never leaks via Referer), no-store, nosniff, and
 * a strict CSP that forbids framing (clickjacking) and foreign form posts.
 */
export function securityHeaders(extraCsp = ""): Record<string, string> {
  const csp = `default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'${extraCsp ? "; " + extraCsp : ""}`;
  return {
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": csp,
  };
}

/** Synchronizer-token CSRF check: non-empty + constant-time equal. */
export function validateCsrf(provided: string, expected: string): boolean {
  return expected.length > 0 && constantTimeEqual(provided, expected);
}

// Characters that enable authority-confusion / smuggling in a redirect_uri:
// backslash (host confusion), whitespace, '#' (fragment), '@' (userinfo).
const ILLEGAL_REDIRECT = /[\\\s#@]/;

/**
 * Hardened redirect_uri validation (spec §8, §10/#1). NO normalization, NO
 * `new URL()` on the default path — the client must send a registered value
 * BYTE-FOR-BYTE. The single parsed exception is an RFC 8252 literal loopback
 * (`127.0.0.1`/`[::1]`, http, registered without a port), where only the port
 * may differ and path+query must be byte-equal.
 */
export function validateRedirectUri(raw: string, registered: string[]): { ok: boolean; reason?: string } {
  if (typeof raw !== "string" || raw === "") return { ok: false, reason: "missing" };
  if (ILLEGAL_REDIRECT.test(raw)) return { ok: false, reason: "illegal-char" };
  if ((raw.match(/\?/g) ?? []).length > 1) return { ok: false, reason: "multi-query" };

  for (const reg of registered) {
    if (isLiteralLoopback(reg)) continue; // handled in the loopback pass
    if (constantTimeEqual(raw, reg)) return { ok: true };
  }
  for (const reg of registered) {
    if (isLiteralLoopback(reg) && loopbackMatch(raw, reg)) return { ok: true };
  }
  return { ok: false, reason: "no-match" };
}

const LOOPBACK_REG = /^http:\/\/(127\.0\.0\.1|\[::1\])(\/[^?#]*)?(\?[^#]*)?$/;

function isLiteralLoopback(reg: string): boolean {
  return LOOPBACK_REG.test(reg);
}

function loopbackMatch(raw: string, reg: string): boolean {
  const m = LOOPBACK_REG.exec(reg);
  if (!m) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:") return false;
  if (u.username !== "" || u.password !== "") return false;
  // WHATWG URL keeps brackets for ipv6 hostnames ("[::1]"), which is exactly
  // the literal captured in m[1], so compare directly.
  if (u.hostname !== m[1]) return false;
  if (u.pathname !== (m[2] ?? "/")) return false;
  if (u.search !== (m[3] ?? "")) return false;
  return true; // only the port is allowed to differ
}
