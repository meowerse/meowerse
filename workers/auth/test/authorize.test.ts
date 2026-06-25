import { test, expect } from "vitest";
import { validateAuthorizeParams, parseAuthorizeQuery, signRequest, verifyRequest } from "../src/authorize";
import type { AuthorizeParams } from "../src/authorize";
import type { LoadedClient } from "../src/clients";

const client: LoadedClient = {
  clientId: "mw_demo",
  status: "active",
  clientType: "public",
  displayName: "Demo",
  logoUrl: null,
  allowedScopes: ["openid", "profile", "telegram", "verified"],
  verifiedOnly: false,
  firstParty: false,
  redirectUris: ["https://app.example.com/cb"],
};

function params(over: Partial<AuthorizeParams> = {}): AuthorizeParams {
  return {
    client_id: "mw_demo",
    redirect_uri: "https://app.example.com/cb",
    response_type: "code",
    scope: "openid profile",
    state: "st",
    nonce: "no",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    ...over,
  };
}

test("unknown/inactive client and bad redirect are FATAL (never redirect)", () => {
  expect(validateAuthorizeParams(params(), null)).toEqual({ kind: "fatal", reason: "unknown_client" });
  expect(validateAuthorizeParams(params(), { ...client, status: "disabled" }).kind).toBe("fatal");
  expect(validateAuthorizeParams(params({ redirect_uri: "https://evil.com/cb" }), client)).toEqual({
    kind: "fatal",
    reason: "bad_redirect_uri",
  });
});

test("post-redirect-trust errors come back as redirect_error with state", () => {
  expect(validateAuthorizeParams(params({ response_type: "token" }), client)).toMatchObject({
    kind: "redirect_error",
    error: "unsupported_response_type",
    state: "st",
  });
  expect(validateAuthorizeParams(params({ code_challenge: "" }), client)).toMatchObject({ error: "invalid_request" });
  expect(validateAuthorizeParams(params({ code_challenge_method: "plain" }), client)).toMatchObject({ error: "invalid_request" });
  expect(validateAuthorizeParams(params({ prompt: "none login" }), client)).toMatchObject({ error: "invalid_request" });
  expect(validateAuthorizeParams(params({ scope: "profile" }), client)).toMatchObject({ error: "invalid_scope" });
  expect(validateAuthorizeParams(params({ scope: "openid admin" }), client)).toMatchObject({ error: "invalid_scope" });
  expect(validateAuthorizeParams(params({ max_age: "-5" }), client)).toMatchObject({ error: "invalid_request" });
});

test("valid request parses scope and carries pkce/nonce/state", () => {
  const r = validateAuthorizeParams(params({ scope: "openid profile telegram", max_age: "300", prompt: "consent" }), client);
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") return;
  expect(r.request.scope).toEqual(["openid", "profile", "telegram"]);
  expect(r.request.maxAge).toBe(300);
  expect(r.request.codeChallenge).toBe(params().code_challenge);
  expect(r.request.prompt).toBe("consent");
});

test("parseAuthorizeQuery pulls all params from the URL", () => {
  const url = new URL("https://x/authorize?client_id=c&redirect_uri=r&response_type=code&scope=openid&code_challenge=ch&code_challenge_method=S256&state=s");
  const p = parseAuthorizeQuery(url);
  expect(p.client_id).toBe("c");
  expect(p.state).toBe("s");
  expect(p.prompt).toBeUndefined();
});

test("signed request object round-trips; tamper/expiry/garbage rejected", async () => {
  const secret = "state-secret";
  const env = {
    r: validateAuthorizeParams(params(), client),
    o: "owner-secret",
    exp: 2000,
  } as never;
  const ok = validateAuthorizeParams(params(), client);
  if (ok.kind !== "ok") throw new Error("setup");
  const token = await signRequest({ r: ok.request, o: "owner", exp: 2000 }, secret);
  expect(await verifyRequest(token, secret, 1000)).toMatchObject({ o: "owner" });
  expect(await verifyRequest(token, secret, 3000)).toBeNull(); // expired
  expect(await verifyRequest(token + "x", secret, 1000)).toBeNull(); // tampered mac
  expect(await verifyRequest(token, "wrong-secret", 1000)).toBeNull();
  expect(await verifyRequest("nodot", secret, 1000)).toBeNull();
  void env;
});
