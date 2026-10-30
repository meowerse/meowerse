import { test, expect } from "vitest";
import { createClient } from "@libsql/client";
import { SCHEMA, SEED } from "../src/db";
import { handle } from "../src/index";
import { createAuthCode, accessTokenInsert, consumeCodeStmt } from "../src/token";
import { refreshTokenInsert } from "../src/refresh";
import { sha256Hex } from "../src/crypto";
import { genSigningKeys } from "./helpers";
import type { DbClient } from "../src/types";

// RFC 7636 vector
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const REDIRECT = "http://localhost:4321/callback";
const NOW = 1000;

async function freshDb(): Promise<DbClient> {
  const c = createClient({ url: ":memory:" }) as unknown as DbClient;
  for (const stmt of [...SCHEMA, ...SEED]) await c.execute(stmt);
  return c;
}
const n = async (db: DbClient, sql: string, args: unknown[] = []) => Number((await db.execute({ sql: `SELECT count(*) AS n FROM ${sql}`, args })).rows[0]!.n);

async function issueCode(db: DbClient, scope: string[]) {
  const code = await createAuthCode(db, {
    request: { clientId: "mw_demo", redirectUri: REDIRECT, scope, nonce: "n", codeChallenge: CHALLENGE },
    accountId: "acct_system",
    sessionIdHash: "sh",
    scope,
    authTime: NOW,
    now: NOW,
  });
  const hash = await sha256Hex(code);
  const family = String((await db.execute({ sql: "SELECT jti_family FROM oauth_codes WHERE code_hash = ?", args: [hash] })).rows[0]!.jti_family);
  return { code, hash, family };
}

// ------------------------------------------------------------ SQL semantics (real libSQL)

async function issuingBatch(db: DbClient, hash: string, family: string) {
  const base = { accountId: "acct_system", clientId: "mw_demo", scope: ["openid", "offline_access"], family, now: NOW };
  const { stmt } = await refreshTokenInsert(base, hash);
  return db.batch([accessTokenInsert({ ...base, jti: "at_x" }, hash), stmt, consumeCodeStmt(hash)], "write");
}

test("SQL: unconsumed code -> batch inserts access + refresh and consumes (rowsAffected 1)", async () => {
  const db = await freshDb();
  const { hash, family } = await issueCode(db, ["openid", "offline_access"]);
  const res = await issuingBatch(db, hash, family);
  expect(res[2]!.rowsAffected).toBe(1);
  expect(await n(db, "access_tokens WHERE family_id = ?", [family])).toBe(1);
  expect(await n(db, "refresh_tokens WHERE family_id = ?", [family])).toBe(1);
  expect(await n(db, "oauth_codes WHERE code_hash = ? AND consumed_at IS NOT NULL", [hash])).toBe(1);
});

test("SQL: already-consumed code -> batch inserts nothing, UPDATE rowsAffected 0", async () => {
  const db = await freshDb();
  const { hash, family } = await issueCode(db, ["openid", "offline_access"]);
  await db.execute(consumeCodeStmt(hash));
  const res = await issuingBatch(db, hash, family);
  expect(res[0]!.rowsAffected).toBe(0);
  expect(res[1]!.rowsAffected).toBe(0);
  expect(res[2]!.rowsAffected).toBe(0);
  expect(await n(db, "access_tokens")).toBe(0);
  expect(await n(db, "refresh_tokens")).toBe(0);
});

test("SQL: unknown code hash -> nothing inserted", async () => {
  const db = await freshDb();
  const res = await issuingBatch(db, "nope", "fam_x");
  expect(res.map((r) => r.rowsAffected)).toEqual([0, 0, 0]);
  expect(await n(db, "access_tokens")).toBe(0);
});

// ------------------------------------------------------------ handler-level races

async function fixture(wrap?: (db: DbClient) => DbClient) {
  const real = await freshDb();
  const db = wrap ? wrap(real) : real;
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", WEB_ORIGIN: "https://web", RESOURCE_AUD: "https://api.meow", STATE_SECRET: "s", CORS_ORIGINS: "https://web" };
  const deps = { getDb: () => db, clock: () => NOW };
  const post = (body: Record<string, string>) =>
    handle(new Request("https://iss/token", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.5" }, body: JSON.stringify(body) }), env as never, deps as never);
  const exchange = (code: string) => post({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: "mw_demo", redirect_uri: REDIRECT });
  const refresh = (rt: string) => post({ grant_type: "refresh_token", refresh_token: rt, client_id: "mw_demo" });
  return { real, db, exchange, refresh };
}
const usableAccess = (db: DbClient, family: string) => n(db, "access_tokens WHERE family_id = ? AND revoked_at IS NULL", [family]);
const usableRefresh = (db: DbClient, family: string) => n(db, "refresh_tokens WHERE family_id = ? AND used_at IS NULL", [family]);

test("(A) replay lands between validation and the issuing batch: no usable token survives, one audit row", async () => {
  let inner: (() => Promise<Response>) | undefined;
  let r2: Response | undefined;
  let fired = false;
  const f = await fixture((db) => ({
    execute: (s) => db.execute(s),
    batch: async (stmts, mode) => {
      const first = typeof stmts[0] === "string" ? stmts[0] : stmts[0]!.sql;
      if (!fired && /INSERT INTO access_tokens/.test(first)) {
        fired = true;
        r2 = await inner!(); // request 2 runs to completion while request 1 is between validation and its batch
      }
      return db.batch(stmts, mode);
    },
  }));
  const { code, family } = await issueCode(f.real, ["openid", "offline_access"]);
  inner = () => f.exchange(code);
  const r1 = await f.exchange(code);

  // request 2 won the batch and got tokens; request 1 is the loser
  expect(r2!.status).toBe(200);
  const rt2 = ((await r2!.json()) as { refresh_token: string }).refresh_token;
  expect(r1.status).toBe(400);
  expect(await r1.json()).toEqual({ error: "invalid_grant" });

  expect(await usableAccess(f.real, family)).toBe(0);
  expect(await usableRefresh(f.real, family)).toBe(0);
  expect(await n(f.real, "access_tokens WHERE family_id = ?", [family])).toBe(1); // only the winner's, now revoked
  const rr = await f.refresh(rt2);
  expect(rr.status).toBe(400);
  expect(await rr.json()).toEqual({ error: "invalid_grant" });
  expect(await n(f.real, "audit_log WHERE event = 'token.code_replay' AND client_id = 'mw_demo' AND account_id = 'acct_system'")).toBe(1);
});

test("(B) replay after full completion: access + refresh revoked, audit row", async () => {
  const f = await fixture();
  const { code, family } = await issueCode(f.real, ["openid", "offline_access"]);
  const r1 = await f.exchange(code);
  expect(r1.status).toBe(200);
  const rt = ((await r1.json()) as { refresh_token: string }).refresh_token;
  expect(await usableAccess(f.real, family)).toBe(1);
  const r2 = await f.exchange(code);
  expect(r2.status).toBe(400);
  expect(await usableAccess(f.real, family)).toBe(0);
  expect(await usableRefresh(f.real, family)).toBe(0);
  expect((await f.refresh(rt)).status).toBe(400);
  expect(await n(f.real, "audit_log WHERE event = 'token.code_replay'")).toBe(1);
});

test("(C) issuing batch throws: code stays unconsumed, nothing issued, 500 server_error", async () => {
  let boom = true;
  const f = await fixture((db) => ({
    execute: (s) => db.execute(s),
    batch: async (stmts, mode) => {
      const first = typeof stmts[0] === "string" ? stmts[0] : stmts[0]!.sql;
      if (boom && /INSERT INTO access_tokens/.test(first)) throw new Error("turso down");
      return db.batch(stmts, mode);
    },
  }));
  const { code, hash, family } = await issueCode(f.real, ["openid", "offline_access"]);
  const r = await f.exchange(code);
  expect(r.status).toBe(500);
  expect(await r.json()).toEqual({ error: "server_error" });
  expect(r.headers.get("Cache-Control")).toBe("no-store");
  expect(await n(f.real, "oauth_codes WHERE code_hash = ? AND consumed_at IS NULL", [hash])).toBe(1);
  expect(await n(f.real, "access_tokens")).toBe(0);
  expect(await n(f.real, "refresh_tokens")).toBe(0);
  expect(await n(f.real, "audit_log")).toBe(0);
  // the client may retry the same (unconsumed) code
  boom = false;
  expect((await f.exchange(code)).status).toBe(200);
  expect(await usableAccess(f.real, family)).toBe(1);
});

test("(D) normal exchange: tokens usable, code consumed once, batch uses write mode", async () => {
  const modes: unknown[] = [];
  const f = await fixture((db) => ({ execute: (s) => db.execute(s), batch: (s, m) => (modes.push(m), db.batch(s, m)) }));
  const { code, hash, family } = await issueCode(f.real, ["openid", "offline_access"]);
  const r = await f.exchange(code);
  expect(r.status).toBe(200);
  expect(r.headers.get("Cache-Control")).toBe("no-store");
  const body = (await r.json()) as { access_token: string; id_token: string; refresh_token: string; token_type: string };
  expect(body.token_type).toBe("Bearer");
  expect(body.id_token).toBeTruthy();
  expect(modes).toEqual(["write"]);
  expect(await usableAccess(f.real, family)).toBe(1);
  expect(await usableRefresh(f.real, family)).toBe(1);
  expect(await n(f.real, "oauth_codes WHERE code_hash = ? AND consumed_at IS NOT NULL", [hash])).toBe(1);
  expect(await n(f.real, "audit_log")).toBe(0);
  expect((await f.refresh(body.refresh_token)).status).toBe(200); // refresh grant unchanged
});

test("(D2) online scope: no refresh token, still atomic", async () => {
  const f = await fixture();
  const { code, family } = await issueCode(f.real, ["openid"]);
  const r = await f.exchange(code);
  expect(r.status).toBe(200);
  expect(((await r.json()) as { refresh_token?: string }).refresh_token).toBeUndefined();
  expect(await usableAccess(f.real, family)).toBe(1);
  expect(await n(f.real, "refresh_tokens")).toBe(0);
});
