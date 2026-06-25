// Generate one ES256 (P-256) signing key as an AUTH_SIGNING_KEYS array entry.
// Usage:  bun workers/auth/scripts/gen-signing-key.mjs [kid]
// Pipe the output into `wrangler secret put AUTH_SIGNING_KEYS` (run in workers/auth).
const kid = process.argv[2] ?? `k${Date.now().toString(36)}`;
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
const publicJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
console.log(JSON.stringify([{ kid, status: "active", privateJwk, publicJwk }]));
