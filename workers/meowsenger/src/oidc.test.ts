import { describe, it, expect } from "vitest";
import { handleLogin, handleCallback } from "./oidc";
import type { AuthClient } from "@meowerse/auth";
import type { DbClient, Row } from "./types";

const fakeAuth = (): AuthClient => ({
  async buildAuthorizationUrl() {
    return { url: "https://auth-api.alxnko.eu.org/authorize?x=1", state: "st", nonce: "no", codeVerifier: "cv" };
  },
  async exchangeCode() { return {}; },
  async refresh() { return {}; },
  async verifyIdToken() { return {}; },
  buildLogoutUrl() { return ""; },
});

describe("handleLogin", () => {
  it("302s to the authorize URL and sets the txn cookie", async () => {
    const res = await handleLogin(fakeAuth());
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/authorize");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("__Host-mw_txn=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });
});

function memDb() {
  const s = new Map<string, Row>(); const u = new Map<string, Row>();
  const db: DbClient = {
    async all() { return []; },
    async first() { return undefined; },
    async run(sql, p = []) {
      if (sql.startsWith("INSERT INTO sessions")) s.set(String(p[0]), { id: p[0] });
      if (sql.startsWith("INSERT INTO users")) u.set(String(p[0]), { id: p[0] });
    },
  };
  return { db, s, u };
}

const authOk = (): AuthClient => ({
  async buildAuthorizationUrl() { return { url: "", state: "st", nonce: "no", codeVerifier: "cv" }; },
  async exchangeCode() { return { access_token: "AT", id_token: "ID", refresh_token: "RT", expires_in: 3600 }; },
  async refresh() { return {}; },
  async verifyIdToken() { return { sub: "u1", verified: true }; },
  buildLogoutUrl() { return ""; },
});

const txnCookie = "__Host-mw_txn=" + encodeURIComponent(JSON.stringify({ state: "st", nonce: "no", codeVerifier: "cv" }));
const cbReq = (qs: string, cookie = txnCookie) =>
  new Request(`https://meowsenger-api.alxnko.eu.org/auth/callback?${qs}`, { headers: { Cookie: cookie } });

const deps = (db: DbClient, auth: AuthClient, userinfo: Row = { sub: "u1", preferred_username: "alex", verified: true }) => ({
  getDb: () => db,
  auth: () => auth,
  fetchFn: (async () => new Response(JSON.stringify(userinfo), { status: 200 })) as unknown as typeof fetch,
  now: () => 1000,
  newId: () => "sess1",
});
const env = { OIDC_ISSUER: "https://auth-api.alxnko.eu.org", WEB_ORIGIN: "https://meowsenger.alxnko.eu.org" } as never;

describe("handleCallback", () => {
  it("exchanges, upserts, creates session, 302s to WEB_ORIGIN/app with session cookie", async () => {
    const { db, s, u } = memDb();
    const res = await handleCallback(cbReq("code=abc&state=st"), env, deps(db, authOk()));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://meowsenger.alxnko.eu.org/app");
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("__Host-mw_session=sess1");
    expect(s.has("sess1")).toBe(true);
    expect(u.has("u1")).toBe(true);
  });
  it("rejects a state mismatch with 400", async () => {
    const { db } = memDb();
    const res = await handleCallback(cbReq("code=abc&state=WRONG"), env, deps(db, authOk()));
    expect(res.status).toBe(400);
  });
  it("rejects a missing txn cookie with 400", async () => {
    const { db } = memDb();
    const res = await handleCallback(cbReq("code=abc&state=st", ""), env, deps(db, authOk()));
    expect(res.status).toBe(400);
  });
  it("returns 400 when the token exchange errors", async () => {
    const { db } = memDb();
    const badAuth = { ...authOk(), async exchangeCode() { return { error: "invalid_grant" }; } } as AuthClient;
    const res = await handleCallback(cbReq("code=abc&state=st"), env, deps(db, badAuth));
    expect(res.status).toBe(400);
  });
  it("returns 400 when the id_token fails verification", async () => {
    const { db } = memDb();
    const badAuth = { ...authOk(), async verifyIdToken() { throw new Error("nonce-mismatch"); } } as AuthClient;
    const res = await handleCallback(cbReq("code=abc&state=st"), env, deps(db, badAuth));
    expect(res.status).toBe(400);
  });
  it("returns 400 on a corrupt txn cookie (bad JSON)", async () => {
    const { db } = memDb();
    const res = await handleCallback(cbReq("code=abc&state=st", "__Host-mw_txn=%7Bnot-json"), env, deps(db, authOk()));
    expect(res.status).toBe(400);
  });
  it("returns 400 when /userinfo is not ok", async () => {
    const { db } = memDb();
    const d = {
      ...deps(db, authOk()),
      fetchFn: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    };
    const res = await handleCallback(cbReq("code=abc&state=st"), env, d);
    expect(res.status).toBe(400);
  });
  it("falls back to claims.verified and null refresh/0 expiry when token+userinfo omit them", async () => {
    const { db, s, u } = memDb();
    // token without refresh_token / expires_in → `?? null` and `?? 0` branches;
    // userinfo without `verified` → `info.verified ?? claims.verified === true`.
    const leanAuth = {
      ...authOk(),
      async exchangeCode() { return { access_token: "AT", id_token: "ID" }; },
    } as AuthClient;
    const d = deps(db, leanAuth, { sub: "u1", preferred_username: "alex" });
    const res = await handleCallback(cbReq("code=abc&state=st"), env, d);
    expect(res.status).toBe(302);
    expect(s.has("sess1")).toBe(true);
    expect(u.has("u1")).toBe(true);
  });
});
