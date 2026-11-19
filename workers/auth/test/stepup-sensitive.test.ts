import { test, expect } from "vitest";
import { createClient } from "@libsql/client";
import { SCHEMA, SEED } from "../src/db";
import { handle } from "../src/index";
import { genSigningKeys, cookieValue } from "./helpers";
import type { DbClient } from "../src/types";

async function setup() {
  const db = createClient({ url: ":memory:" }) as unknown as DbClient;
  for (const stmt of [...SCHEMA, ...SEED]) await db.execute(stmt);
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", WEB_ORIGIN: "https://web", CORS_ORIGINS: "https://web", STATE_SECRET: "s" };
  let t = 1000;
  const deps = { getDb: () => db, clock: () => t };
  const su = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "neko_step", password: "accttest1234" }) }), env as never, deps as never);
  const csrf = ((await su.json()) as { csrf: string }).csrf;
  const sess = cookieValue(su.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  const post = (path: string, extra: Record<string, unknown> = {}) =>
    handle(new Request(`https://iss${path}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${sess}` }, body: JSON.stringify({ csrf, ...extra }) }), env as never, deps as never);
  return { post, db, setNow: (n: number) => (t = n) };
}

test("M5: recovery-code regeneration and telegram unlink need fresh auth (recent login or the current password)", async () => {
  const f = await setup();
  for (const path of ["/api/account/recovery-codes", "/api/account/telegram/unlink"]) {
    // fresh login → allowed without a password
    expect((await f.post(path)).status, `${path} fresh`).toBe(200);
  }
  f.setNow(1000 + 301);
  for (const path of ["/api/account/recovery-codes", "/api/account/telegram/unlink"]) {
    const r = await f.post(path);
    expect(r.status, `${path} stale`).toBe(401);
    expect(await r.json()).toEqual({ error: "step_up_required", reauth: "password" });
    expect((await f.post(path, { current_password: "wrong-password" })).status, `${path} wrong pw`).toBe(403);
    expect((await f.post(path, { current_password: "accttest1234" })).status, `${path} right pw`).toBe(200);
  }
});

test("M5: a stale-session recovery-code request leaves the existing codes untouched", async () => {
  const f = await setup();
  const before = await f.db.execute("SELECT code_hash FROM recovery_codes ORDER BY code_hash");
  f.setNow(1000 + 301);
  expect((await f.post("/api/account/recovery-codes")).status).toBe(401);
  const after = await f.db.execute("SELECT code_hash FROM recovery_codes ORDER BY code_hash");
  expect(after.rows.map((r) => r.code_hash)).toEqual(before.rows.map((r) => r.code_hash));
});
