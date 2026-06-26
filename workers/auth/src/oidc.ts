import type { Env } from "./types";

const DEFAULT_ISSUER = "https://auth-api.alxnko.eu.org";

/**
 * OIDC discovery document (spec §3). Advertises ONLY what slice 1 implements:
 * code flow, S256 PKCE, ES256, public subjects, and RFC 9207 `iss` in the
 * authorization response (the SDK's mix-up defense). `offline_access` is
 * advertised but `refresh_token` is deferred to slice 2.
 */
export function discoveryDoc(env: Env): Record<string, unknown> {
  const iss = env.ISSUER ?? DEFAULT_ISSUER;
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/authorize`,
    token_endpoint: `${iss}/token`,
    userinfo_endpoint: `${iss}/userinfo`,
    jwks_uri: `${iss}/jwks`,
    end_session_endpoint: `${iss}/logout`,
    revocation_endpoint: `${iss}/token/revoke`,
    introspection_endpoint: `${iss}/token/introspect`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    id_token_signing_alg_values_supported: ["ES256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    subject_types_supported: ["public"],
    scopes_supported: ["openid", "profile", "telegram", "verified", "offline_access"],
    claims_supported: ["sub", "preferred_username", "name", "picture", "telegram_id", "telegram_username", "verified"],
    prompt_values_supported: ["none", "login", "consent", "select_account"],
    authorization_response_iss_parameter_supported: true,
  };
}
