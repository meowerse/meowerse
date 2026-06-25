import { test, expect } from "vitest";
import { handle } from "../src/index";
import { verifyJwt } from "../src/jwt";
import { buildJwks } from "../src/keys";
import { genSigningKeys, memStore, cookieValue } from "./helpers";

// RFC 7636 PKCE vector
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const REDIRECT = "http://localhost:4321/callback";

async function fixture() {
  const { db } = memStore();
  const keys = await genSigningKeys("k1", "active");
  const env = {
    AUTH_SIGNING_KEYS: JSON.stringify(keys),
    ISSUER: "https://iss",
    WEB_ORIGIN: "https://web",
    RESOURCE_AUD: "https://api.meow",
    STATE_SECRET: "state-secret",
    CORS_ORIGINS: "https://web",
  };
  const deps = { getDb: () => db, clock: () => 1000 };
  return { env, deps, jwks: buildJwks(keys) };
}

function authorizeUrl() {
  const q = new URLSearchParams({
    client_id: "mw_demo",
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "openid profile",
    state: "xyz",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    nonce: "nnn",
  });
  return `https://iss/authorize?${q.toString()}`;
}

test("full loop: signup → authorize → consent → token → userinfo, then replay fails", async () => {
  const { env, deps, jwks } = await fixture();

  // 1. logged-out /authorize stashes the request and sends to the login UI
  const r1 = await handle(new Request(authorizeUrl()), env, deps);
  expect(r1.status).toBe(302);
  expect(r1.headers.get("Location")).toBe("https://web/login");
  expect(r1.headers.get("Referrer-Policy")).toBe("no-referrer");
  const tkt = cookieValue(r1.headers.get("Set-Cookie"), "__Host-mw_tkt");
  expect(tkt).toBeTruthy();

  // 2. signup carrying the tkt → account+session, next=consent, recovery codes once
  const r2 = await handle(
    new Request("https://iss/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `__Host-mw_tkt=${tkt}` },
      body: JSON.stringify({ username: "neko_dev", password: "abcdefghijkl" }),
    }),
    env,
    deps,
  );
  const b2 = (await r2.json()) as Record<string, unknown>;
  expect(r2.status).toBe(200);
  expect((b2.recoveryCodes as string[]).length).toBe(8);
  expect((b2.next as { action: string }).action).toBe("consent");
  const sess = cookieValue(r2.headers.get("Set-Cookie"), "__Host-mw_sess");
  const csrf = b2.csrf as string;

  // 3. consent allow → redirect URL with code+state+iss
  const r3 = await handle(
    new Request("https://iss/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${sess}; __Host-mw_tkt=${tkt}` },
      body: JSON.stringify({ decision: "allow", csrf }),
    }),
    env,
    deps,
  );
  const b3 = (await r3.json()) as { redirect: string };
  expect(r3.status).toBe(200);
  const loc = new URL(b3.redirect);
  expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
  expect(loc.searchParams.get("state")).toBe("xyz");
  expect(loc.searchParams.get("iss")).toBe("https://iss");
  const code = loc.searchParams.get("code")!;
  expect(code).toBeTruthy();

  // 4. token exchange
  const r4 = await handle(
    new Request("https://iss/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: "mw_demo", redirect_uri: REDIRECT }),
    }),
    env,
    deps,
  );
  const b4 = (await r4.json()) as Record<string, string>;
  expect(r4.status).toBe(200);
  expect(r4.headers.get("Cache-Control")).toContain("no-store");
  expect(b4.token_type).toBe("Bearer");
  expect(b4.scope).toBe("openid profile");

  const id = await verifyJwt(b4.id_token, jwks, { iss: "https://iss", aud: "mw_demo", now: 1000 });
  expect(String(id.payload.sub)).toMatch(/^acct_/);
  expect(id.payload.nonce).toBe("nnn");
  expect(id.header.typ).toBe("JWT");

  // 5. userinfo with the access_token
  const r5 = await handle(
    new Request("https://iss/userinfo", { headers: { Authorization: `Bearer ${b4.access_token}` } }),
    env,
    deps,
  );
  const b5 = (await r5.json()) as Record<string, unknown>;
  expect(r5.status).toBe(200);
  expect(b5.sub).toBe(id.payload.sub);
  expect(b5.preferred_username).toBe("neko_dev");

  // 6. replay the code → invalid_grant
  const r6 = await handle(
    new Request("https://iss/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: "mw_demo", redirect_uri: REDIRECT }),
    }),
    env,
    deps,
  );
  expect(r6.status).toBe(400);
  expect(((await r6.json()) as { error: string }).error).toBe("invalid_grant");
});

test("an id_token presented at /userinfo is rejected (typ guard, end to end)", async () => {
  const { env, deps } = await fixture();
  // Drive the loop quickly to obtain an id_token, then present it at /userinfo.
  const r1 = await handle(new Request(authorizeUrl()), env, deps);
  const tkt = cookieValue(r1.headers.get("Set-Cookie"), "__Host-mw_tkt")!;
  const r2 = await handle(
    new Request("https://iss/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `__Host-mw_tkt=${tkt}` },
      body: JSON.stringify({ username: "neko_two", password: "abcdefghijkl" }),
    }),
    env,
    deps,
  );
  const b2 = (await r2.json()) as { csrf: string };
  const sess = cookieValue(r2.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  const r3 = await handle(
    new Request("https://iss/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${sess}; __Host-mw_tkt=${tkt}` },
      body: JSON.stringify({ decision: "allow", csrf: b2.csrf }),
    }),
    env,
    deps,
  );
  const code = new URL(((await r3.json()) as { redirect: string }).redirect).searchParams.get("code")!;
  const r4 = await handle(
    new Request("https://iss/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: "mw_demo", redirect_uri: REDIRECT }),
    }),
    env,
    deps,
  );
  const idToken = ((await r4.json()) as { id_token: string }).id_token;

  const bad = await handle(new Request("https://iss/userinfo", { headers: { Authorization: `Bearer ${idToken}` } }), env, deps);
  expect(bad.status).toBe(401);
});
