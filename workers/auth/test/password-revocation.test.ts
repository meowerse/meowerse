import { test, expect } from "vitest";
import { handle } from "../src/index";
import { issueSession, lookupSession } from "../src/session";
import { createRefreshToken, rotateRefresh } from "../src/refresh";
import { createClient } from "@libsql/client";
import { SCHEMA, SEED } from "../src/db";
import { genSigningKeys, cookieValue } from "./helpers";
import type { DbClient } from "../src/types";

async function freshDb(): Promise<DbClient> {
  const c = createClient({ url: ":memory:" }) as unknown as DbClient;
  for (const stmt of [...SCHEMA, ...SEED]) await c.execute(stmt);
  return c;
}

test("password change keeps the current session but revokes other sessions and all refresh/access tokens", async () => {
  const store = { db: await freshDb() };
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), STATE_SECRET: "s", ISSUER: "https://iss", WEB_ORIGIN: "https://web", CORS_ORIGINS: "https://web" };
  const deps = { getDb: () => store.db, clock: () => 1000 };
  const su = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "neko_revoke", password: "accttest1234" }) }), env as never, deps as never);
  const csrf = ((await su.json()) as { csrf: string }).csrf;
  const s1 = cookieValue(su.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  const accountId = String((await store.db.execute("SELECT id FROM accounts WHERE username = 'neko_revoke'")).rows[0]!.id);
  const s2 = (await issueSession(store.db, { accountId, amr: "pwd", authTime: 1000, now: 1000 }))!;
  const rt = await createRefreshToken(store.db, { accountId, clientId: "c1", scope: ["openid"], family: "fam1", now: 1000 });
  await store.db.execute({
    sql: "INSERT INTO access_tokens (jti, account_id, client_id, scope, family_id, issued_at, expires_at) VALUES ('j1', ?, 'c1', 'openid', 'fam1', 1000, 99999)",
    args: [accountId],
  });
  expect(await lookupSession(store.db, s2.rawId, 1000)).not.toBeNull();

  const r = await handle(
    new Request("https://iss/api/account/password", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${s1}` }, body: JSON.stringify({ csrf, current_password: "accttest1234", new_password: "newpass123456" }) }),
    env as never,
    deps as never,
  );
  expect(r.status).toBe(200);

  expect(await lookupSession(store.db, s2.rawId, 1000)).toBeNull();
  expect(await lookupSession(store.db, s1, 1000)).not.toBeNull();
  const res = await rotateRefresh(store.db, { token: rt, clientId: "c1", now: 1000 });
  expect(res).toMatchObject({ ok: false, error: "invalid_grant" });
  const at = await store.db.execute({ sql: "SELECT revoked_at FROM access_tokens WHERE jti = 'j1'", args: [] });
  expect(at.rows[0]!.revoked_at).not.toBeNull();
});
