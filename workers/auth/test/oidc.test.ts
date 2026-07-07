import { test, expect } from "vitest";
import { discoveryDoc } from "../src/oidc";

test("discovery advertises exactly the implemented surface", () => {
  const d = discoveryDoc({ ISSUER: "https://auth-api.example" });
  expect(d.issuer).toBe("https://auth-api.example");
  expect(d.authorization_endpoint).toBe("https://auth-api.example/authorize");
  expect(d.jwks_uri).toBe("https://auth-api.example/jwks");
  expect(d.response_types_supported).toEqual(["code"]);
  expect(d.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  expect(d.code_challenge_methods_supported).toEqual(["S256"]);
  expect(d.id_token_signing_alg_values_supported).toEqual(["ES256"]);
  expect(d.subject_types_supported).toEqual(["public"]);
  expect(d.authorization_response_iss_parameter_supported).toBe(true);
});

test("discovery advertises logout, revoke/introspect auth, and the docs link", () => {
  const d = discoveryDoc({ ISSUER: "https://auth-api.example", WEB_ORIGIN: "https://auth.example" });
  expect(d.end_session_endpoint).toBe("https://auth-api.example/logout");
  expect(d.revocation_endpoint).toBe("https://auth-api.example/token/revoke");
  expect(d.introspection_endpoint).toBe("https://auth-api.example/token/introspect");
  expect(d.revocation_endpoint_auth_methods_supported).toEqual(["client_secret_basic", "client_secret_post"]);
  expect(d.introspection_endpoint_auth_methods_supported).toEqual(["client_secret_basic", "client_secret_post"]);
  expect(d.response_modes_supported).toEqual(["query"]);
  expect(d.service_documentation).toBe("https://auth.example/docs");
});

test("falls back to the default issuer + docs link when env unset", () => {
  const d = discoveryDoc({});
  expect(d.issuer).toBe("https://auth.alxnko.eu.org");
  expect(d.service_documentation).toBe("https://auth.alxnko.eu.org/docs");
});
