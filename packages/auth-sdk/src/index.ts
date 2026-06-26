import { b64urlEncode, b64urlDecode, sha256 } from "@meowerse/auth-shared";

/**
 * `@meowerse/auth` — the relying-party SDK for "Auth with Meowerse" (spec §9).
 * Lets any meowerse project add login with a few lines: build the authorize URL
 * (PKCE + state + nonce), exchange the code, verify the id_token against JWKS,
 * and refresh. Pure WebCrypto + an injectable `fetch` — runs in Workers, Node,
 * and the browser. The mix-up defense (RFC 9207 `iss`) and `nonce` check are
 * mandatory in the verify path.
 */
export interface AuthClientConfig {
  issuer: string; // e.g. https://auth-api.alxnko.eu.org
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  fetch?: typeof fetch;
}

export interface TokenResponse {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
  error?: string;
}

export interface AuthTransaction {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function randomUrlId(bytes = 32): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export class IdTokenError extends Error {}

export interface AuthClient {
  buildAuthorizationUrl(opts?: { scope?: string; prompt?: string }): Promise<AuthTransaction>;
  exchangeCode(opts: { code: string; codeVerifier: string }): Promise<TokenResponse>;
  refresh(refreshToken: string): Promise<TokenResponse>;
  verifyIdToken(idToken: string, opts?: { nonce?: string; now?: number }): Promise<Record<string, unknown>>;
  buildLogoutUrl(opts?: { idTokenHint?: string; postLogoutRedirectUri?: string }): string;
}

export function createAuthClient(config: AuthClientConfig): AuthClient {
  const doFetch = config.fetch ?? fetch;
  const issuer = config.issuer.replace(/\/$/, "");
  let jwksCache: { keys: JsonWebKey[] } | null = null;

  async function postToken(body: Record<string, string>): Promise<TokenResponse> {
    const res = await doFetch(`${issuer}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    return (await res.json()) as TokenResponse;
  }

  return {
    async buildAuthorizationUrl(opts = {}) {
      const codeVerifier = randomUrlId(32);
      const challenge = b64urlEncode(await sha256(codeVerifier));
      const state = randomUrlId(16);
      const nonce = randomUrlId(16);
      const u = new URL(`${issuer}/authorize`);
      const set = (k: string, v: string) => u.searchParams.set(k, v);
      set("response_type", "code");
      set("client_id", config.clientId);
      set("redirect_uri", config.redirectUri);
      set("scope", opts.scope ?? "openid profile");
      set("state", state);
      set("nonce", nonce);
      set("code_challenge", challenge);
      set("code_challenge_method", "S256");
      if (opts.prompt) set("prompt", opts.prompt);
      return { url: u.toString(), state, nonce, codeVerifier };
    },

    exchangeCode(opts) {
      return postToken({
        grant_type: "authorization_code",
        code: opts.code,
        code_verifier: opts.codeVerifier,
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
      });
    },

    refresh(refreshToken) {
      return postToken({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.clientId,
        ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
      });
    },

    async verifyIdToken(idToken, opts = {}) {
      if (!jwksCache) jwksCache = (await (await doFetch(`${issuer}/jwks`)).json()) as { keys: JsonWebKey[] };
      return verifyEs256(idToken, jwksCache, { iss: issuer, aud: config.clientId, nonce: opts.nonce, now: opts.now });
    },

    buildLogoutUrl(opts = {}) {
      const u = new URL(`${issuer}/logout`);
      if (opts.idTokenHint) u.searchParams.set("id_token_hint", opts.idTokenHint);
      if (opts.postLogoutRedirectUri) u.searchParams.set("post_logout_redirect_uri", opts.postLogoutRedirectUri);
      return u.toString();
    },
  };
}

async function verifyEs256(
  token: string,
  jwks: { keys: JsonWebKey[] },
  opts: { iss: string; aud: string; nonce?: string; now?: number },
): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new IdTokenError("malformed");
  const [h, p, s] = parts as [string, string, string];
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(dec.decode(b64urlDecode(h)));
  } catch {
    throw new IdTokenError("malformed-header");
  }
  if (header.alg !== "ES256") throw new IdTokenError("alg-not-allowed");
  const jwk = jwks.keys.find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) throw new IdTokenError("unknown-kid");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64urlDecode(s) as BufferSource, enc.encode(`${h}.${p}`));
  if (!ok) throw new IdTokenError("bad-signature");
  const payload = JSON.parse(dec.decode(b64urlDecode(p))) as Record<string, unknown>;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && now > payload.exp + 60) throw new IdTokenError("expired");
  if (payload.iss !== opts.iss) throw new IdTokenError("iss-mismatch");
  if (payload.aud !== opts.aud) throw new IdTokenError("aud-mismatch");
  if (opts.nonce !== undefined && payload.nonce !== opts.nonce) throw new IdTokenError("nonce-mismatch");
  return payload;
}

/**
 * Config-as-code IaC (spec §9): declare a client in `auth.config.ts` and apply
 * it with {@link provision} (idempotent upsert via the Management API), so a new
 * project wires up auth without clicking the dashboard.
 */
export interface AuthClientManifest {
  name: string;
  displayName?: string;
  clientType?: "public" | "confidential";
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
  scopes?: string[];
  verifiedOnly?: boolean;
  allowOfflineAccess?: boolean;
}

export function defineAuthClient(m: AuthClientManifest): AuthClientManifest {
  return m;
}

export interface ProvisionResult {
  created?: boolean;
  unchanged?: boolean;
  clientId?: string;
  clientSecret?: string;
  error?: string;
}

export async function provision(
  m: AuthClientManifest,
  opts: { issuer: string; managementToken: string; fetch?: typeof fetch },
): Promise<ProvisionResult> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${opts.issuer.replace(/\/$/, "")}/mgmt/v1/clients`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.managementToken}` },
    body: JSON.stringify({
      name: m.name,
      display_name: m.displayName,
      client_type: m.clientType ?? "public",
      redirect_uris: m.redirectUris.join(" "),
      scopes: (m.scopes ?? []).join(" "),
      verified_only: m.verifiedOnly ? "true" : "false",
      offline: m.allowOfflineAccess ? "true" : "false",
    }),
  });
  return (await res.json()) as ProvisionResult;
}
