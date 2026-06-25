import { b64urlEncode, b64urlDecode } from "@meowerse/auth-shared";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Typed JWT failure so callers can map to the right OAuth error without leaking detail. */
export class JwtError extends Error {}

function b64urlJson(obj: unknown): string {
  return b64urlEncode(enc.encode(JSON.stringify(obj)));
}

/**
 * Sign a compact JWS with ES256. WebCrypto ECDSA P-256 produces the raw r||s
 * (IEEE P1363) signature that JOSE ES256 requires — no DER conversion needed.
 * `alg:ES256` is forced into the header so a caller can never weaken it.
 */
export async function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  signingKey: CryptoKey,
): Promise<string> {
  const signingInput = `${b64urlJson({ ...header, alg: "ES256" })}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, enc.encode(signingInput));
  return `${signingInput}.${b64urlEncode(new Uint8Array(sig))}`;
}

export interface VerifyOpts {
  iss?: string;
  aud?: string;
  now?: number;
  skew?: number;
}
export interface VerifiedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

/**
 * Verify a compact JWS. Pins `alg:ES256` (rejects `none`/RS/HS confusion),
 * resolves the key by `kid` from the supplied JWKS, checks the signature, then
 * validates iss/aud/exp/nbf with ±skew. Throws {@link JwtError} on any failure.
 */
export async function verifyJwt(
  token: string,
  jwks: { keys: JsonWebKey[] },
  opts: VerifyOpts = {},
): Promise<VerifiedJwt> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("malformed");
  const [h, p, s] = parts as [string, string, string];

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(dec.decode(b64urlDecode(h)));
  } catch {
    throw new JwtError("malformed-header");
  }
  if (header.alg !== "ES256") throw new JwtError("alg-not-allowed");

  const jwk = jwks.keys.find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) throw new JwtError("unknown-kid");

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const sig = b64urlDecode(s) as BufferSource;
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, enc.encode(`${h}.${p}`));
  if (!ok) throw new JwtError("bad-signature");

  const payload = JSON.parse(dec.decode(b64urlDecode(p))) as Record<string, unknown>;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const skew = opts.skew ?? 60;
  if (typeof payload.exp === "number" && now > payload.exp + skew) throw new JwtError("expired");
  if (typeof payload.nbf === "number" && now + skew < payload.nbf) throw new JwtError("not-yet-valid");
  if (opts.iss && payload.iss !== opts.iss) throw new JwtError("iss-mismatch");
  if (opts.aud && payload.aud !== opts.aud) throw new JwtError("aud-mismatch");

  return { header, payload };
}
