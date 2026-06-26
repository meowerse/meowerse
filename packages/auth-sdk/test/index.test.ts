import { test, expect } from "bun:test";
import { b64urlEncode, verifyPkceS256 } from "@meowerse/auth-shared";
import { createAuthClient, defineAuthClient, provision, IdTokenError } from "../src/index";

const enc = new TextEncoder();

async function makeKey() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return { kp, jwks: { keys: [{ ...pub, kid: "k1", alg: "ES256", use: "sig" }] } };
}

async function signIdToken(kp: CryptoKeyPair, payload: Record<string, unknown>, alg = "ES256", kid = "k1") {
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg, kid })));
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const input = `${header}.${body}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, enc.encode(input)));
  return `${input}.${b64urlEncode(sig)}`;
}

function jwksFetch(jwks: unknown): typeof fetch {
  return (async (url: string) => {
    if (String(url).endsWith("/jwks")) return new Response(JSON.stringify(jwks));
    return new Response("{}");
  }) as unknown as typeof fetch;
}

test("buildAuthorizationUrl issues PKCE + state + nonce; challenge matches verifier", async () => {
  const client = createAuthClient({ issuer: "https://iss/", clientId: "mw_demo", redirectUri: "https://app/cb" });
  const txn = await client.buildAuthorizationUrl({ scope: "openid profile telegram", prompt: "consent" });
  const u = new URL(txn.url);
  expect(u.origin + u.pathname).toBe("https://iss/authorize");
  expect(u.searchParams.get("client_id")).toBe("mw_demo");
  expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  expect(u.searchParams.get("state")).toBe(txn.state);
  expect(u.searchParams.get("prompt")).toBe("consent");
  expect(await verifyPkceS256(txn.codeVerifier, u.searchParams.get("code_challenge")!)).toBe(true);
});

test("exchangeCode + refresh POST form bodies; client_secret only when confidential", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const f = (async (url: string, init: RequestInit) => {
    captured = { url, init };
    return new Response(JSON.stringify({ access_token: "at", id_token: "id", token_type: "Bearer", refresh_token: "rt" }));
  }) as unknown as typeof fetch;

  const pub = createAuthClient({ issuer: "https://iss", clientId: "mw_demo", redirectUri: "https://app/cb", fetch: f });
  await pub.exchangeCode({ code: "c", codeVerifier: "v" });
  expect(captured!.url).toBe("https://iss/token");
  expect(String(captured!.init.body)).toContain("grant_type=authorization_code");
  expect(String(captured!.init.body)).not.toContain("client_secret");

  const conf = createAuthClient({ issuer: "https://iss", clientId: "mw_demo", clientSecret: "mws_s", redirectUri: "https://app/cb", fetch: f });
  const r = await conf.refresh("rt1");
  expect(r.refresh_token).toBe("rt");
  expect(String(captured!.init.body)).toContain("grant_type=refresh_token");
  expect(String(captured!.init.body)).toContain("client_secret=mws_s");
});

test("verifyIdToken validates signature/iss/aud/nonce/exp/alg", async () => {
  const { kp, jwks } = await makeKey();
  const client = createAuthClient({ issuer: "https://iss", clientId: "mw_demo", redirectUri: "https://app/cb", fetch: jwksFetch(jwks) });

  const good = await signIdToken(kp, { iss: "https://iss", aud: "mw_demo", sub: "u1", nonce: "n1", exp: 9_999_999_999 });
  expect((await client.verifyIdToken(good, { nonce: "n1", now: 1000 })).sub).toBe("u1");

  await expect(client.verifyIdToken(good, { nonce: "WRONG", now: 1000 })).rejects.toBeInstanceOf(IdTokenError);

  const badAud = await signIdToken(kp, { iss: "https://iss", aud: "other", exp: 9_999_999_999 });
  await expect(client.verifyIdToken(badAud, { now: 1000 })).rejects.toThrow("aud");

  const badIss = await signIdToken(kp, { iss: "evil", aud: "mw_demo", exp: 9_999_999_999 });
  await expect(client.verifyIdToken(badIss, { now: 1000 })).rejects.toThrow("iss");

  const expired = await signIdToken(kp, { iss: "https://iss", aud: "mw_demo", exp: 500 });
  await expect(client.verifyIdToken(expired, { now: 100000 })).rejects.toThrow("expired");

  const none = `${b64urlEncode(enc.encode(JSON.stringify({ alg: "none", kid: "k1" })))}.${b64urlEncode(enc.encode(JSON.stringify({})))}.`;
  await expect(client.verifyIdToken(none, { now: 1000 })).rejects.toThrow("alg");

  await expect(client.verifyIdToken("a.b", { now: 1000 })).rejects.toThrow("malformed");
});

test("verifyIdToken rejects an unknown kid and a tampered signature", async () => {
  const { kp, jwks } = await makeKey();
  const client = createAuthClient({ issuer: "https://iss", clientId: "mw_demo", redirectUri: "https://app/cb", fetch: jwksFetch(jwks) });
  const wrongKid = await signIdToken(kp, { iss: "https://iss", aud: "mw_demo", exp: 9_999_999_999 }, "ES256", "nope");
  await expect(client.verifyIdToken(wrongKid, { now: 1000 })).rejects.toThrow("kid");

  const tok = await signIdToken(kp, { iss: "https://iss", aud: "mw_demo", exp: 9_999_999_999 });
  const [h, p, s] = tok.split(".");
  const tampered = `${h}.${p}.${s![0] === "A" ? "B" : "A"}${s!.slice(1)}`;
  await expect(client.verifyIdToken(tampered, { now: 1000 })).rejects.toThrow("signature");
});

test("buildLogoutUrl carries id_token_hint + post_logout_redirect_uri", () => {
  const client = createAuthClient({ issuer: "https://iss", clientId: "mw_demo", redirectUri: "https://app/cb" });
  expect(client.buildLogoutUrl()).toBe("https://iss/logout");
  const u = new URL(client.buildLogoutUrl({ idTokenHint: "idt", postLogoutRedirectUri: "https://app/bye" }));
  expect(u.searchParams.get("id_token_hint")).toBe("idt");
  expect(u.searchParams.get("post_logout_redirect_uri")).toBe("https://app/bye");
});

test("config-as-code: defineAuthClient + provision PUTs to the management API", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const f = (async (url: string, init: RequestInit) => {
    captured = { url, init };
    return new Response(JSON.stringify({ created: true, clientId: "mw_x" }));
  }) as unknown as typeof fetch;
  const manifest = defineAuthClient({ name: "my-app", displayName: "My App", redirectUris: ["https://app/cb"], scopes: ["openid", "profile"], verifiedOnly: true });
  const r = await provision(manifest, { issuer: "https://iss/", managementToken: "mgmt_t", fetch: f });
  expect(r.created).toBe(true);
  expect(captured!.url).toBe("https://iss/mgmt/v1/clients");
  expect((captured!.init.headers as Record<string, string>).Authorization).toBe("Bearer mgmt_t");
  const body = JSON.parse(String(captured!.init.body));
  expect(body).toMatchObject({ name: "my-app", redirect_uris: "https://app/cb", scopes: "openid profile", verified_only: "true" });
});
