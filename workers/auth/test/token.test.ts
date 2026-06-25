import { test, expect } from "vitest";
import { mintTokens, createAuthCode, exchangeCode, recordAccessToken, revokeAccessToken, introspect, atHash } from "../src/token";
import { verifyJwt } from "../src/jwt";
import { getActiveKey, buildJwks } from "../src/keys";
import { sha256Hex } from "../src/crypto";
import { genSigningKeys, routedDb, type Route } from "./helpers";
import type { AuthorizeRequest } from "../src/authorize";

// RFC 7636 vector
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

async function signing() {
  const keys = await genSigningKeys("k1", "active");
  return { active: await getActiveKey(keys), jwks: buildJwks(keys) };
}

test("mintTokens: access is at+jwt/resource-aud, id is JWT/client-aud with nonce+verified+at_hash", async () => {
  const { active, jwks } = await signing();
  const t = await mintTokens({
    accountId: "acct_1",
    clientId: "mw_demo",
    scope: ["openid", "profile", "verified"],
    nonce: "n1",
    authTime: 1000,
    verified: true,
    issuer: "iss",
    resourceAud: "https://api.meow",
    signingKey: active.key,
    kid: active.kid,
    family: "fam",
    now: 1000,
  });
  const at = await verifyJwt(t.access_token, jwks, { now: 1000 });
  expect(at.header.typ).toBe("at+jwt");
  expect(at.payload.aud).toBe("https://api.meow");
  expect(at.payload.token_use).toBe("access");
  expect(at.payload.scope).toBe("openid profile verified");

  const id = await verifyJwt(t.id_token, jwks, { now: 1000 });
  expect(id.header.typ).toBe("JWT");
  expect(id.payload.aud).toBe("mw_demo");
  expect(id.payload.token_use).toBe("id");
  expect(id.payload.nonce).toBe("n1");
  expect(id.payload.verified).toBe(true);
  expect(id.payload.at_hash).toBe(await atHash(t.access_token));
});

test("mintTokens omits nonce and verified when not applicable", async () => {
  const { active, jwks } = await signing();
  const t = await mintTokens({
    accountId: "acct_1",
    clientId: "mw_demo",
    scope: ["openid", "profile"],
    nonce: null,
    authTime: 1000,
    verified: false,
    issuer: "iss",
    resourceAud: "res",
    signingKey: active.key,
    kid: active.kid,
    family: "fam",
    now: 1000,
  });
  const id = await verifyJwt(t.id_token, jwks, { now: 1000 });
  expect(id.payload.nonce).toBeUndefined();
  expect(id.payload.verified).toBeUndefined();
});

test("createAuthCode stores sha256(code) and returns the raw code", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const request: AuthorizeRequest = {
    clientId: "mw_demo",
    redirectUri: "https://app/cb",
    scope: ["openid"],
    nonce: "n1",
    codeChallenge: CHALLENGE,
  };
  const code = await createAuthCode(routedDb([], log), {
    request,
    accountId: "acct_1",
    sessionIdHash: "sh",
    scope: ["openid", "profile"],
    authTime: 1000,
    now: 1000,
  });
  expect(code.startsWith("code_")).toBe(true);
  const ins = log.find((c) => c.sql.includes("INSERT INTO oauth_codes"));
  expect(ins?.args[0]).toBe(await sha256Hex(code));
});

function codeRow(over: Record<string, unknown> = {}) {
  return {
    code_hash: "h",
    client_id: "mw_demo",
    redirect_uri: "https://app/cb",
    scope: "openid profile",
    nonce: "n1",
    code_challenge: CHALLENGE,
    account_id: "acct_1",
    auth_time: 1000,
    jti_family: "fam",
    expires_at: 9_999_999_999,
    consumed_at: null,
    ...over,
  };
}

test("exchangeCode success consumes once and returns the grant", async () => {
  const routes: Route[] = [
    [/SELECT \* FROM oauth_codes/, () => ({ rows: [codeRow()] })],
    [/UPDATE oauth_codes SET consumed_at/, () => ({ rows: [], rowsAffected: 1 })],
  ];
  const res = await exchangeCode(routedDb(routes), {
    code: "code_x",
    verifier: VERIFIER,
    clientId: "mw_demo",
    redirectUri: "https://app/cb",
    now: 1000,
  });
  expect(res).toMatchObject({ ok: true, accountId: "acct_1", scope: ["openid", "profile"], nonce: "n1", family: "fam" });
});

test("exchangeCode replay revokes the token family and fails", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const routes: Route[] = [[/SELECT \* FROM oauth_codes/, () => ({ rows: [codeRow({ consumed_at: "2026-01-01" })] })]];
  const res = await exchangeCode(routedDb(routes, log), {
    code: "code_x",
    verifier: VERIFIER,
    clientId: "mw_demo",
    redirectUri: "https://app/cb",
    now: 1000,
  });
  expect(res).toMatchObject({ ok: false, error: "invalid_grant", replay: true });
  expect(log.some((c) => c.sql.includes("UPDATE access_tokens SET revoked_at") && c.args[0] === "fam")).toBe(true);
});

test("exchangeCode rejects unknown/expired/client-mismatch/redirect-mismatch/bad-pkce", async () => {
  const mk = (over: Record<string, unknown>): Route[] => [[/SELECT \* FROM oauth_codes/, () => ({ rows: [codeRow(over)] })]];
  const call = (routes: Route[], extra: Partial<{ clientId: string; redirectUri: string; verifier: string }> = {}) =>
    exchangeCode(routedDb(routes), {
      code: "code_x",
      verifier: extra.verifier ?? VERIFIER,
      clientId: extra.clientId ?? "mw_demo",
      redirectUri: extra.redirectUri ?? "https://app/cb",
      now: 1000,
    });

  expect((await call([[/SELECT \* FROM oauth_codes/, () => ({ rows: [] })]])).ok).toBe(false); // unknown
  expect((await call(mk({ expires_at: 5 }))).ok).toBe(false); // expired
  expect((await call(mk({}), { clientId: "other" })).ok).toBe(false); // client mismatch
  expect((await call(mk({}), { redirectUri: "https://app/evil" })).ok).toBe(false); // redirect mismatch
  expect((await call(mk({}), { verifier: "wrong-verifier" })).ok).toBe(false); // pkce mismatch
});

test("record/revoke/introspect access token lifecycle", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  await recordAccessToken(routedDb([], log), {
    jti: "at_1",
    accountId: "a",
    clientId: "c",
    scope: ["openid"],
    family: "fam",
    now: 1000,
  });
  expect(log.some((c) => c.sql.includes("INSERT INTO access_tokens"))).toBe(true);

  await revokeAccessToken(routedDb([], log), "at_1");
  expect(log.some((c) => c.sql.includes("UPDATE access_tokens SET revoked_at"))).toBe(true);

  const active = await introspect(routedDb([[/FROM access_tokens WHERE jti/, () => ({ rows: [{ expires_at: 9_999_999_999, revoked_at: null }] })]]), "at_1", 1000);
  expect(active.active).toBe(true);
  const revoked = await introspect(routedDb([[/FROM access_tokens WHERE jti/, () => ({ rows: [{ expires_at: 9_999_999_999, revoked_at: "2026" }] })]]), "at_1", 1000);
  expect(revoked.active).toBe(false);
  const gone = await introspect(routedDb([[/FROM access_tokens WHERE jti/, () => ({ rows: [] })]]), "at_1", 1000);
  expect(gone.active).toBe(false);
});
