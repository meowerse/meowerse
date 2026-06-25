import { b64urlEncode, b64urlDecode, constantTimeEqual } from "@meowerse/auth-shared";

const enc = new TextEncoder();

/**
 * PBKDF2 parameters. `iter` is capped at 100k per `deriveBits` call by workerd,
 * so we CHAIN `rounds` calls (each salted, feeding the prior output as the next
 * "password") to reach `rounds × iter` effective iterations within the 10ms CPU
 * wall (spec §7). Default targets OWASP-2025 600k; tests pass tiny params.
 *
 * // ponytail: PBKDF2 chain is native (no wasm). Upgrade path = Argon2id-wasm,
 * // gated on a CPU measurement; rehash-on-login ratchets params up later.
 */
export interface Pbkdf2Params {
  rounds: number;
  iter: number;
}
export const DEFAULT_PBKDF2: Pbkdf2Params = { rounds: 6, iter: 100_000 };
/** Cheap params for high-entropy inputs (recovery codes, secrets) — no stretch needed. */
export const CHEAP_PBKDF2: Pbkdf2Params = { rounds: 1, iter: 10_000 };

async function deriveOnce(passwordBytes: Uint8Array, salt: Uint8Array, iter: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", passwordBytes as BufferSource, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: iter },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Hash a secret into a PHC string `pbkdf2$sha256$<rounds>$<iter>$<salt>$<hash>`. */
export async function hashPassword(password: string, params: Pbkdf2Params = DEFAULT_PBKDF2): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  let acc = enc.encode(password);
  for (let i = 0; i < params.rounds; i++) acc = await deriveOnce(acc, salt, params.iter);
  return `pbkdf2$sha256$${params.rounds}$${params.iter}$${b64urlEncode(salt)}$${b64urlEncode(acc)}`;
}

/** Constant-time verify a secret against a PHC string. Malformed PHC → false (never throws). */
export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const parts = phc.split("$");
  if (parts.length !== 6) return false;
  const [scheme, algo, roundsS, iterS, saltS, hashS] = parts;
  if (scheme !== "pbkdf2" || algo !== "sha256" || !roundsS || !iterS || !saltS || !hashS) return false;
  const rounds = Number(roundsS);
  const iter = Number(iterS);
  if (!Number.isInteger(rounds) || !Number.isInteger(iter) || rounds < 1 || iter < 1) return false;
  let acc = enc.encode(password);
  const salt = b64urlDecode(saltS);
  for (let i = 0; i < rounds; i++) acc = await deriveOnce(acc, salt, iter);
  return constantTimeEqual(b64urlEncode(acc), hashS);
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Hex SHA-256 of a UTF-8 string. Used to store only hashes of opaque ids/codes. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return toHex(new Uint8Array(digest));
}

/** Hex HMAC-SHA256(key, msg). Used to sign the cookie-borne authorize request object. */
export async function hmacSha256Hex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return toHex(new Uint8Array(sig));
}
