import { parseScope, constantTimeEqual, b64urlEncode, b64urlDecode } from "@meowerse/auth-shared";
import { hmacSha256Hex } from "./crypto";
import { validateRedirectUri } from "./security";
import type { LoadedClient } from "./clients";

export interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  scope: string;
  state?: string;
  nonce?: string;
  code_challenge: string;
  code_challenge_method: string;
  prompt?: string;
  max_age?: string;
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  scope: string[];
  state?: string;
  nonce?: string;
  codeChallenge: string;
  prompt?: string;
  maxAge?: number;
}

export type ValidateResult =
  | { kind: "fatal"; reason: string } // render on-site error; NEVER redirect
  | { kind: "redirect_error"; error: string; state?: string } // redirect with error+state+iss
  | { kind: "ok"; request: AuthorizeRequest };

/** Parse the /authorize query string into a typed param bag. */
export function parseAuthorizeQuery(url: URL): AuthorizeParams {
  const sp = url.searchParams;
  const get = (k: string) => sp.get(k) ?? "";
  const opt = (k: string) => sp.get(k) ?? undefined;
  return {
    client_id: get("client_id"),
    redirect_uri: get("redirect_uri"),
    response_type: get("response_type"),
    scope: get("scope"),
    state: opt("state"),
    nonce: opt("nonce"),
    code_challenge: get("code_challenge"),
    code_challenge_method: get("code_challenge_method"),
    prompt: opt("prompt"),
    max_age: opt("max_age"),
  };
}

const VALID_PROMPTS = new Set(["none", "login", "consent", "select_account"]);

/**
 * Validate the authorize request in the spec-mandated order (§5): client →
 * byte-exact redirect_uri (both FATAL, on-site error) → response_type / PKCE /
 * scope / prompt / max_age (redirect with error). No DB write happens here.
 */
export function validateAuthorizeParams(p: AuthorizeParams, client: LoadedClient | null): ValidateResult {
  if (!client || client.status !== "active") return { kind: "fatal", reason: "unknown_client" };
  if (!validateRedirectUri(p.redirect_uri, client.redirectUris).ok) return { kind: "fatal", reason: "bad_redirect_uri" };

  const state = p.state;
  if (p.response_type !== "code") return { kind: "redirect_error", error: "unsupported_response_type", state };
  if (p.code_challenge === "" || p.code_challenge_method !== "S256") {
    return { kind: "redirect_error", error: "invalid_request", state };
  }
  if (p.prompt !== undefined) {
    const prompts = p.prompt.split(/\s+/).filter(Boolean);
    const allValid = prompts.every((x) => VALID_PROMPTS.has(x));
    const noneWithOthers = prompts.includes("none") && prompts.length > 1;
    if (!allValid || noneWithOthers) return { kind: "redirect_error", error: "invalid_request", state };
  }
  // Reject the RAW tokens against the client allowlist — an unknown scope like
  // "admin" must error, not be silently dropped (spec §8, §10/#9).
  const rawScopes = p.scope.trim().split(/\s+/).filter(Boolean);
  const allowed = new Set(client.allowedScopes);
  if (rawScopes.length === 0 || !rawScopes.includes("openid") || !rawScopes.every((s) => allowed.has(s))) {
    return { kind: "redirect_error", error: "invalid_scope", state };
  }
  const requested = parseScope(p.scope);

  let maxAge: number | undefined;
  if (p.max_age !== undefined && p.max_age !== "") {
    const n = Number(p.max_age);
    if (!Number.isInteger(n) || n < 0) return { kind: "redirect_error", error: "invalid_request", state };
    maxAge = n;
  }

  return {
    kind: "ok",
    request: {
      clientId: client.clientId,
      redirectUri: p.redirect_uri,
      scope: requested,
      state,
      nonce: p.nonce,
      codeChallenge: p.code_challenge,
      prompt: p.prompt,
      maxAge,
    },
  };
}

/**
 * The signed, single-use authorize request object carried in __Host-mw_tkt
 * across the login/consent detour (spec §5). HMAC keeps the browser from
 * tampering; the cookie (not the URL) keeps it off the wire/logs. `o` is a
 * per-browser binding secret (reserved for the full owner-rebind in slice 2,
 * when the external Telegram bounce makes it load-bearing).
 *
 * // ponytail: slice-1 anti-fixation rests on __Host- cookie + HMAC + single-use
 * // code + CSRF on consent. Full session owner-rebind lands with the bot flow.
 */
export interface RequestEnvelope {
  r: AuthorizeRequest;
  o: string;
  exp: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function signRequest(env: RequestEnvelope, secret: string): Promise<string> {
  const body = b64urlEncode(encoder.encode(JSON.stringify(env)));
  const mac = await hmacSha256Hex(secret, body);
  return `${body}.${mac}`;
}

export async function verifyRequest(token: string, secret: string, now: number): Promise<RequestEnvelope | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = await hmacSha256Hex(secret, body);
  if (!constantTimeEqual(mac, expected)) return null;
  let env: RequestEnvelope;
  try {
    env = JSON.parse(decoder.decode(b64urlDecode(body))) as RequestEnvelope;
  } catch {
    return null;
  }
  if (typeof env.exp !== "number" || now > env.exp) return null;
  return env;
}
