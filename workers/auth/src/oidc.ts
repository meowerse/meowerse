import type { Env } from "./types";

const DEFAULT_ISSUER = "https://auth.alxnko.eu.org";
const DEFAULT_WEB_ORIGIN = "https://auth.alxnko.eu.org";

/**
 * OIDC discovery document (spec §3). Advertises exactly the implemented surface:
 * authorization-code flow with S256 PKCE, ES256-signed tokens, public subjects,
 * RFC 9207 `iss` in the authorization response (the SDK's mix-up defense),
 * the refresh-token grant (rotation + reuse detection), RP-initiated logout
 * with a `post_logout_redirect_uri` return, and RFC 7009/7662 revoke +
 * introspect (confidential-client only). `service_documentation` points at the
 * integration guide so a generic OIDC client finds everything from one URL.
 */
export function discoveryDoc(env: Env): Record<string, unknown> {
  const iss = env.ISSUER ?? DEFAULT_ISSUER;
  const web = env.WEB_ORIGIN ?? DEFAULT_WEB_ORIGIN;
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/authorize`,
    token_endpoint: `${iss}/token`,
    userinfo_endpoint: `${iss}/userinfo`,
    jwks_uri: `${iss}/jwks`,
    end_session_endpoint: `${iss}/logout`,
    revocation_endpoint: `${iss}/token/revoke`,
    introspection_endpoint: `${iss}/token/introspect`,
    service_documentation: `${web}/docs`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    id_token_signing_alg_values_supported: ["ES256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    revocation_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    introspection_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    subject_types_supported: ["public"],
    scopes_supported: ["openid", "profile", "telegram", "verified", "offline_access"],
    claims_supported: ["sub", "preferred_username", "name", "picture", "telegram_id", "telegram_username", "verified"],
    prompt_values_supported: ["none", "login", "consent", "select_account"],
    authorization_response_iss_parameter_supported: true,
  };
}
