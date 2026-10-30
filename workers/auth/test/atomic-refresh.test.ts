import { test, expect } from "vitest";
import { createClient } from "@libsql/client";
import { SCHEMA, SEED } from "../src/db";
import { handle } from "../src/index";
import { createAuthCode } from "../src/token";
import { sha256Hex } from "../src/crypto";
import { genSigningKeys, seedLiveSession } from "./helpers";
import type { DbClient } from "../src/types";

const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const REDIRECT = "http://localhost:4321/callback";
const NOW = 1000;

const n = async (db: DbClient, sql: string, args: unknown[] = []) => Number((await db.execute({ sql: `SELECT count(*) AS n FROM ${sql}`, args })).rows[0]!.n);

async function fixture(wrap?: (db: DbClient) => DbClient, ctx?: { waitUntil: (p: Promise<unknown>) => void }) {
  const real = createClient({ url: ":memory:" }) as unknown as DbClient;
  for (const stmt of [...SCHEMA, ...SEED]) await real.execute(stmt);
  const db = wrap ? wrap(real) : real;
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", WEB_ORIGIN: "https://web", RESOURCE_AUD: "https://api.meow", STATE_SECRET: "s", CORS_ORIGINS: "https://web" };
  const deps = { getDb: () => db, clock: () => NOW, ctx };
  const post = (body: Record<string, string>) =>
    handle(new Request("https://iss/token", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.5" }, body: JSON.stringify(body) }), env as never, deps as never);
  const refresh = (rt: string) => post({ grant_type: "refresh_token", refresh_token: rt, client_id: "mw_demo" });
  // Issue an initial offline token pair through the real code exchange (through `db`, i.e. unwrapped real calls).
  async function initial() {
    const scope = ["openid", "offline_access"];
    await seedLiveSession(real, "sh", "acct_system", NOW);
    const code = (await createAuthCode(real, { request: { clientId: "mw_demo", redirectUri: REDIRECT, scope, nonce: "n", codeChallenge: CHALLENGE }, accountId: "acct_system", sessionIdHash: "sh", scope, authTime: NOW, now: NOW }))!;
    const r = await post({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: "mw_demo", redirect_uri: REDIRECT });
    expect(r.status).toBe(200);
    const rt = ((await r.json()) as { refresh_token: string }).refresh_token;
    const family = String((await real.execute({ sql: "SELECT family_id FROM refresh_tokens WHERE token_hash = ?", args: [await sha256Hex(rt)] })).rows[0]!.family_id);
    return { rt, family };
  }
  return { real, refresh, initial };
}
const usableAccess = (db: DbClient, f: string) => n(db, "access_tokens WHERE family_id = ? AND revoked_at IS NULL", [f]);
const usableRefresh = (db: DbClient, f: string) => n(db, "refresh_tokens WHERE family_id = ? AND used_at IS NULL", [f]);
const firstSql = (s: string | { sql: string }) => (typeof s === "string" ? s : s.sql);

test("(R-D) normal rotation: old spent, new usable in same family, absolute deadline kept, write mode", async () => {
  const modes: unknown[] = [];
  const f = await fixture((db) => ({ execute: (s) => db.execute(s), batch: (s, m) => (modes.push(m), db.batch(s, m)) }));
  const { rt, family } = await f.initial();
  modes.length = 0;
  const abs = (await f.real.execute({ sql: "SELECT absolute_expires_at a FROM refresh_tokens WHERE family_id = ?", args: [family] })).rows[0]!.a;
  const r = await f.refresh(rt);
  expect(r.status).toBe(200);
  expect(r.headers.get("Cache-Control")).toBe("no-store");
  const body = (await r.json()) as { refresh_token: string; access_token: string; id_token: string };
  expect(body.access_token && body.id_token && body.refresh_token).toBeTruthy();
  expect(modes).toEqual(["write"]);
  expect(await n(f.real, "refresh_tokens WHERE family_id = ?", [family])).toBe(2);
  expect(await usableRefresh(f.real, family)).toBe(1);
  expect(await usableAccess(f.real, family)).toBe(2);
  const kid = (await f.real.execute({ sql: "SELECT absolute_expires_at a, prev_id p FROM refresh_tokens WHERE token_hash = ?", args: [await sha256Hex(body.refresh_token)] })).rows[0]!;
  expect(kid.a).toBe(abs);
  expect(kid.p).toBe(await sha256Hex(rt));
  expect((await f.refresh(body.refresh_token)).status).toBe(200); // chain continues
  expect(await n(f.real, "audit_log")).toBe(0);
});

test("(R-A) reuse lands between rotation validation and the rotation batch: no usable token survives, one audit row", async () => {
  let inner: (() => Promise<Response>) | undefined;
  let r2: Response | undefined;
  let armed = false;
  const f = await fixture((db) => ({
    execute: (s) => db.execute(s),
    batch: async (stmts, mode) => {
      if (armed && /INSERT INTO access_tokens/.test(firstSql(stmts[0]!))) {
        armed = false;
        r2 = await inner!();
      }
      return db.batch(stmts, mode);
    },
  }));
  const { rt, family } = await f.initial();
  // request 1 rotates; request 2 (the SAME old token) completes in the middle -> it wins the batch
  inner = () => f.refresh(rt);
  armed = true;
  const r1 = await f.refresh(rt);
  expect(r2!.status).toBe(200);
  const rt2 = ((await r2!.json()) as { refresh_token: string }).refresh_token;
  expect(r1.status).toBe(400);
  expect(await r1.json()).toEqual({ error: "invalid_grant" });
  expect(await usableRefresh(f.real, family)).toBe(0);
  expect(await usableAccess(f.real, family)).toBe(0);
  const rr = await f.refresh(rt2);
  expect(rr.status).toBe(400);
  expect(await rr.json()).toEqual({ error: "invalid_grant" });
  // the follow-up refresh with the dead token is itself a reuse -> second audit row; the race produced exactly one before it
  expect(await n(f.real, "audit_log WHERE event = 'token.reuse_detected' AND client_id = 'mw_demo' AND account_id = 'acct_system'")).toBe(2);
});

test("(R-A') exactly one token.reuse_detected row from the race itself", async () => {
  let inner: (() => Promise<Response>) | undefined;
  let armed = false;
  const f = await fixture((db) => ({
    execute: (s) => db.execute(s),
    batch: async (stmts, mode) => {
      if (armed && /INSERT INTO access_tokens/.test(firstSql(stmts[0]!))) {
        armed = false;
        await inner!();
      }
      return db.batch(stmts, mode);
    },
  }));
  const { rt } = await f.initial();
  inner = () => f.refresh(rt);
  armed = true;
  await f.refresh(rt);
  expect(await n(f.real, "audit_log WHERE event = 'token.reuse_detected'")).toBe(1);
});

test("(R-B) two concurrent rotations of the same token: exactly one wins, loser revokes the family", async () => {
  const f = await fixture();
  const { rt, family } = await f.initial();
  const [a, b] = await Promise.all([f.refresh(rt), f.refresh(rt)]);
  const statuses = [a.status, b.status].sort();
  expect(statuses).toEqual([200, 400]);
  expect(await usableRefresh(f.real, family)).toBe(0);
  expect(await usableAccess(f.real, family)).toBe(0);
  expect(await n(f.real, "audit_log WHERE event = 'token.reuse_detected'")).toBe(1);
});

test("(R-C) failure INSIDE the rotation transaction: nothing issued, old token still unused and retryable", async () => {
  const f = await fixture();
  const { rt, family } = await f.initial();
  await f.real.execute("CREATE TRIGGER boom BEFORE INSERT ON refresh_tokens BEGIN SELECT RAISE(ABORT, 'boom'); END");
  const before = await n(f.real, "access_tokens WHERE family_id = ?", [family]);
  const r = await f.refresh(rt);
  expect(r.status).toBe(500);
  expect(await r.json()).toEqual({ error: "server_error" });
  expect(await n(f.real, "access_tokens WHERE family_id = ?", [family])).toBe(before);
  expect(await n(f.real, "refresh_tokens WHERE family_id = ?", [family])).toBe(1);
  expect(await usableRefresh(f.real, family)).toBe(1);
  expect(await n(f.real, "audit_log")).toBe(0);
  await f.real.execute("DROP TRIGGER boom");
  expect((await f.refresh(rt)).status).toBe(200);
});

test("(R-C2) batch throws before reaching the DB: 500, old token untouched", async () => {
  let boom = false;
  const f = await fixture((db) => ({
    execute: (s) => db.execute(s),
    batch: async (s, m) => {
      if (boom && /INSERT INTO access_tokens/.test(firstSql(s[0]!))) throw new Error("down");
      return db.batch(s, m);
    },
  }));
  const { rt, family } = await f.initial();
  boom = true;
  expect((await f.refresh(rt)).status).toBe(500);
  expect(await usableRefresh(f.real, family)).toBe(1);
});

test("(R-E) loser's family revoke is part of its own transaction: survives a failing follow-up revokeFamily", async () => {
  let inner: (() => Promise<Response>) | undefined;
  let armed = false;
  let failRevoke = false;
  const f = await fixture((db) => ({
    execute: (s) => db.execute(s),
    batch: async (stmts, mode) => {
      const sql = firstSql(stmts[0]!);
      if (armed && /INSERT INTO access_tokens/.test(sql)) {
        armed = false;
        await inner!(); // winner commits first
        failRevoke = true;
      }
      // the follow-up revokeFamily (2 stmts, first is the family refresh UPDATE) fails transiently
      if (failRevoke && stmts.length === 2 && /UPDATE refresh_tokens SET used_at/.test(sql)) throw new Error("transient");
      return db.batch(stmts, mode);
    },
  }));
  const { rt, family } = await f.initial();
  inner = () => f.refresh(rt);
  armed = true;
  const r = await f.refresh(rt);
  expect(r.status).toBe(400); // the in-batch revoke already committed: still invalid_grant, not 500
  expect(await r.json()).toEqual({ error: "invalid_grant" });
  expect(await usableRefresh(f.real, family)).toBe(0);
  expect(await usableAccess(f.real, family)).toBe(0);
  expect(await n(f.real, "audit_log WHERE event = 'token.reuse_detected'")).toBe(1);
});

/** Fail the first `times` standalone revokeFamily batches (2 stmts, first = family refresh UPDATE). */
const failRevokes = (times: number) => {
  const st = { left: times, calls: 0 };
  const wrap = (db: DbClient): DbClient => ({
    execute: (s) => db.execute(s),
    batch: async (stmts, mode) => {
      if (stmts.length === 2 && /UPDATE refresh_tokens SET used_at/.test(firstSql(stmts[0]!))) {
        st.calls++;
        if (st.left > 0) {
          st.left--;
          throw new Error("transient");
        }
      }
      return db.batch(stmts, mode);
    },
  });
  return { st, wrap };
};

test("(R-F) sequential reuse: revokeFamily fails twice then succeeds -> family revoked, 400, one audit row", async () => {
  const fr = failRevokes(2);
  const f = await fixture(fr.wrap);
  const { rt, family } = await f.initial();
  expect((await f.refresh(rt)).status).toBe(200); // rotate; rt is now spent
  const r = await f.refresh(rt); // reuse
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: "invalid_grant" });
  expect(fr.st.calls).toBe(3);
  expect(await usableRefresh(f.real, family)).toBe(0);
  expect(await usableAccess(f.real, family)).toBe(0);
  expect(await n(f.real, "audit_log WHERE event = 'token.reuse_detected'")).toBe(1);
});

test("(R-G) sequential reuse: revokeFamily fails 3 times -> 500 fail-closed, audit row still written", async () => {
  const fr = failRevokes(3);
  const f = await fixture(fr.wrap);
  const { rt } = await f.initial();
  expect((await f.refresh(rt)).status).toBe(200);
  const r = await f.refresh(rt);
  expect(r.status).toBe(500);
  expect(await r.json()).toEqual({ error: "server_error" });
  expect(fr.st.calls).toBe(3);
  expect(await n(f.real, "audit_log WHERE event = 'token.reuse_detected'")).toBe(1);
});

test("(R-H) sequential reuse: in-request revokes all fail, background retry revokes once the DB recovers", async () => {
  const fr = failRevokes(3);
  const pending: Promise<unknown>[] = [];
  const f = await fixture(fr.wrap, { waitUntil: (p) => pending.push(p) });
  const { rt } = await f.initial();
  const rotated = await f.refresh(rt);
  expect(rotated.status).toBe(200);
  const successor = ((await rotated.json()) as { refresh_token: string }).refresh_token;
  const r = await f.refresh(rt);
  expect(r.status).toBe(500);
  await Promise.all(pending);
  expect(fr.st.calls).toBe(4); // 3 in-request failures + 1 successful background attempt
  expect((await f.refresh(successor)).status).toBe(400);
  expect(await n(f.real, "audit_log WHERE event = 'token.reuse_detected'")).toBeGreaterThanOrEqual(1);
});
