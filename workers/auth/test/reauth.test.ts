import { test, expect } from "vitest";
import { createClient } from "@libsql/client";
import { SCHEMA, SEED } from "../src/db";
import { handle } from "../src/index";
import { verifyJwt } from "../src/jwt";
import { buildJwks } from "../src/keys";
import { genSigningKeys, cookieValue } from "./helpers";
import type { DbClient } from "../src/types";

const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const REDIRECT = "http://localhost:4321/callback";

async function setup() {
  const db = createClient({ url: ":memory:" }) as unknown as DbClient;
  for (const stmt of [...SCHEMA, ...SEED]) await db.execute(stmt);
  await db.execute(`UPDATE oauth_clients SET allowed_scopes = '["openid","profile","offline_access"]', allow_offline_access = 1 WHERE client_id = 'mw_demo'`);
  const keys = await genSigningKeys("k1", "active");
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", WEB_ORIGIN: "https://web", RESOURCE_AUD: "https://api.meow", STATE_SECRET: "state-secret", CORS_ORIGINS: "https://web" };
  let t = 1000;
  const deps = { getDb: () => db, clock: () => t };
  return { db, env, deps, jwks: buildJwks(keys), setNow: (n: number) => (t = n) };
}
const authorizeUrl = (extra: Record<string, string> = {}) =>
  "https://iss/authorize?" + new URLSearchParams({ client_id: "mw_demo", redirect_uri: REDIRECT, response_type: "code", scope: "openid profile offline_access", state: "s", code_challenge: CHALLENGE, code_challenge_method: "S256", ...extra }).toString();
const tokenReq = (body: unknown) => new Request("https://iss/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function firstLogin(f: Awaited<ReturnType<typeof setup>>) {
  const r1 = await handle(new Request(authorizeUrl()), f.env as never, f.deps as never);
  const tkt = cookieValue(r1.headers.get("Set-Cookie"), "__Host-mw_tkt")!;
  const r2 = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_tkt=${tkt}` }, body: JSON.stringify({ username: "neko_reauth", password: "abcdefghijkl" }) }), f.env as never, f.deps as never);
  const sess = cookieValue(r2.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  const csrf = ((await r2.json()) as { csrf: string }).csrf;
  const r3 = await handle(new Request("https://iss/consent", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${sess}; __Host-mw_tkt=${tkt}` }, body: JSON.stringify({ decision: "allow", csrf }) }), f.env as never, f.deps as never);
  const code = new URL(((await r3.json()) as { redirect: string }).redirect).searchParams.get("code")!;
  return { sess, code };
}

test("max_age / prompt=login with a live session route to /login; prompt=none answers login_required; a satisfied max_age stays silent", async () => {
  const f = await setup();
  const { sess } = await firstLogin(f);
  f.setNow(5000); // session auth_time is 1000 → 4000 s old
  const get = (extra: Record<string, string>) => handle(new Request(authorizeUrl(extra), { headers: { Cookie: `__Host-mw_sess=${sess}` } }), f.env as never, f.deps as never);

  for (const extra of [{ max_age: "0" }, { max_age: "100" }, { prompt: "login" }]) {
    const r = await get(extra);
    expect(r.status, JSON.stringify(extra)).toBe(302);
    expect(r.headers.get("Location")).toBe("https://web/login");
    expect(cookieValue(r.headers.get("Set-Cookie"), "__Host-mw_tkt")).toBeTruthy(); // original request preserved
  }
  const none = await get({ max_age: "100", prompt: "none" });
  expect(new URL(none.headers.get("Location")!).searchParams.get("error")).toBe("login_required");

  const ok = await get({ max_age: "100000" });
  expect(ok.status).toBe(302);
  expect(new URL(ok.headers.get("Location")!).searchParams.get("code")).toBeTruthy();
});

test("a refresh-grant id_token reports the original login time as auth_time, not the refresh time", async () => {
  const f = await setup();
  const { code } = await firstLogin(f);
  const r4 = await handle(tokenReq({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: "mw_demo", redirect_uri: REDIRECT }), f.env as never, f.deps as never);
  const b4 = (await r4.json()) as Record<string, string>;
  expect(r4.status).toBe(200);
  expect(b4.refresh_token).toBeTruthy();
  const id1 = await verifyJwt(b4.id_token, f.jwks, { iss: "https://iss", aud: "mw_demo", now: 1000 });
  expect(id1.payload.auth_time).toBe(1000);

  f.setNow(9000);
  const r5 = await handle(tokenReq({ grant_type: "refresh_token", refresh_token: b4.refresh_token, client_id: "mw_demo" }), f.env as never, f.deps as never);
  const b5 = (await r5.json()) as Record<string, string>;
  expect(r5.status).toBe(200);
  const id2 = await verifyJwt(b5.id_token, f.jwks, { iss: "https://iss", aud: "mw_demo", now: 9000 });
  expect(id2.payload.auth_time).toBe(1000);

  // …and it survives a second rotation
  f.setNow(12000);
  const r6 = await handle(tokenReq({ grant_type: "refresh_token", refresh_token: b5.refresh_token, client_id: "mw_demo" }), f.env as never, f.deps as never);
  const id3 = await verifyJwt(((await r6.json()) as Record<string, string>).id_token, f.jwks, { iss: "https://iss", aud: "mw_demo", now: 12000 });
  expect(id3.payload.auth_time).toBe(1000);
});
