import { b64urlEncode, constantTimeEqual } from "./base64url";

/** SHA-256 of a UTF-8 string, as raw bytes. */
export async function sha256(input: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

/**
 * RFC 7636 PKCE S256 verification: the presented `verifier` is valid iff
 * BASE64URL(SHA256(verifier)) === the stored `challenge`. Constant-time compare
 * so a near-miss challenge can't be brute-forced by timing.
 */
export async function verifyPkceS256(verifier: string, challenge: string): Promise<boolean> {
  const computed = b64urlEncode(await sha256(verifier));
  return constantTimeEqual(computed, challenge);
}
