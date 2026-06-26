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

test("falls back to the default issuer when env unset", () => {
  expect(discoveryDoc({}).issuer).toBe("https://auth-api.alxnko.eu.org");
});
