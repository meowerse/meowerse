/**
 * URL-safe base64 (RFC 4648 §5), padding stripped — the encoding OAuth/OIDC use
 * for PKCE challenges, JWT segments, and opaque ids. Pure; works in `workerd`
 * and `bun` (both provide `btoa`/`atob`).
 */
export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Inverse of {@link b64urlEncode}; re-pads before decoding. */
export function b64urlDecode(s: string): Uint8Array {
  const padLen = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Length-aware constant-time string compare. Loops the longer string so runtime
 * does not depend on the first differing byte, and folds the length mismatch
 * into the result (no early return) — avoids leaking a secret or its length via
 * timing. Mirrors `workers/api/src/security.ts`.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
