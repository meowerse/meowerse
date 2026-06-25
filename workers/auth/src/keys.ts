/**
 * ES256 signing-key management (spec §3). Private keys live ONLY in the
 * `AUTH_SIGNING_KEYS` wrangler secret — a JSON array of records. We sign with
 * the single `active` key and publish active/next/retiring PUBLIC keys at /jwks
 * so verifiers can follow a rotation without downtime.
 */
export interface SigningKeyRecord {
  kid: string;
  status: "active" | "next" | "retiring";
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

export interface ActiveKey {
  kid: string;
  key: CryptoKey;
}

/** Parse + shape-check the secret. Throws on anything that isn't a JSON array. */
export function parseSigningKeys(json: string): SigningKeyRecord[] {
  const arr = JSON.parse(json);
  if (!Array.isArray(arr)) throw new Error("AUTH_SIGNING_KEYS must be a JSON array");
  return arr as SigningKeyRecord[];
}

/** Import the active private key as a non-extractable signing CryptoKey. */
export async function getActiveKey(keys: SigningKeyRecord[]): Promise<ActiveKey> {
  const rec = keys.find((k) => k.status === "active");
  if (!rec) throw new Error("no active signing key");
  const key = await crypto.subtle.importKey(
    "jwk",
    rec.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return { kid: rec.kid, key };
}

/** Public JWKS for /jwks — active/next/retiring only, private scalar `d` stripped. */
export function buildJwks(keys: SigningKeyRecord[]): { keys: JsonWebKey[] } {
  const published = new Set(["active", "next", "retiring"]);
  const out = keys
    .filter((k) => published.has(k.status))
    .map((k) => {
      const { d, ...pub } = k.publicJwk; // never expose the private scalar
      void d;
      return { ...pub, kid: k.kid, alg: "ES256", use: "sig" } as JsonWebKey;
    });
  return { keys: out };
}
