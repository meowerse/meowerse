import { test, expect } from "vitest";
import { createClient } from "@libsql/client";
import { SCHEMA, SEED } from "../src/db";
import { handle } from "../src/index";
import { signRequest } from "../src/authorize";
import { sha256Hex, hmacSha256Hex } from "../src/crypto";
import { internalConfirmString } from "../src/telegram";
import { genSigningKeys, cookieValue } from "./helpers";
import type { DbClient } from "../src/types";

// A re-authentication demand (prompt=login / max_age) is stamped on the request ticket as `m` (= demand time).
// A session whose auth_time is older than `m` (beyond a 5 s clock-skew slack) must never mint a code.

const T0 = 100_000;
const REDIRECT = "http://localhost:4321/callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const count = async (db: DbClient, sql: string) => Number((await db.execute(`SELECT count(*) AS n FROM ${sql}`)).rows[0]!.n);

async function setup() {
  const db = createClient({ url: ":memory:" }) as unknown as DbClient;
  for (const stmt of [...SCHEMA, ...SEED]) await db.execute(stmt);
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), STATE_SECRET: "s", ISSUER: "https://iss", WEB_ORIGIN: "https://web", CORS_ORIGINS: "https://web", BOT_USERNAME: "meow_bot", INTERNAL_HMAC_KEY: "ikey" };
  const deps = { getDb: () => db, clock: () => T0 };
  await db.execute("INSERT INTO accounts (id, username, display_name) VALUES ('a_pw', 'pwuser', 'PW')");
  const addSession = async (raw: string, authTime: number) => {
    await db.execute({ sql: "INSERT INTO sessions (id_hash, account_id, auth_time, amr, csrf_token, idle_expires_at, absolute_expires_at) VALUES (?, 'a_pw', ?, 'pwd', ?, ?, ?)", args: [await sha256Hex(raw), authTime, `csrf_${raw}`, T0 + 1e6, T0 + 1e6] });
    return { raw, csrf: `csrf_${raw}` };
  };
  // ticket demanding re-auth as of T0
  const tkt = await signRequest({ r: { clientId: "mw_demo", redirectUri: REDIRECT, scope: ["openid"], codeChallenge: CHALLENGE, codeChallengeMethod: "S256", state: "s", nonce: "n" } as never, o: "o", exp: T0 + 600, m: T0 }, "s");
  const get = (path: string, cookie: string) => handle(new Request(`https://iss${path}`, { headers: { Cookie: cookie } }), env as never, deps as never);
  const post = (path: string, cookie: string, body: unknown) =>
    handle(new Request(`https://iss${path}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) }), env as never, deps as never);
  return { db, env, deps, addSession, tkt, get, post };
}

// Telegram VERIFY_EXISTING link flow; returns the /tg/status JSON.
async function linkStatus(f: Awaited<ReturnType<typeof setup>>, s: { raw: string; csrf: string }) {
  const st = await f.post("/tg/start", `__Host-mw_sess=${s.raw}`, { kind: "VERIFY_EXISTING", csrf: s.csrf });
  expect(st.status).toBe(200);
  const b = (await st.json()) as { ticketId: string; deepLink: string };
  const owner = cookieValue(st.headers.get("Set-Cookie"), "__Host-mw_tgown")!;
  const nonce = new URL(b.deepLink).searchParams.get("start")!;
  const fields = { nonce, telegramId: "555", username: "u", displayName: "U", avatarUrl: "", ts: String(T0) };
  const sig = await hmacSha256Hex("ikey", internalConfirmString(fields));
  const c = await handle(new Request("https://iss/internal/tg/confirm", { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": sig }, body: JSON.stringify({ nonce, telegram_id: "555", username: "u", display_name: "U", avatar_url: "", ts: String(T0) }) }), f.env as never, f.deps as never);
  expect(c.status).toBe(200);
  const { code } = (await c.json()) as { code: string };
  const cookie = `__Host-mw_tgown=${owner}; __Host-mw_sess=${s.raw}`;
  expect((await f.post("/tg/verify", cookie, { ticket: b.ticketId, code })).status).toBe(200);
  const r = await f.get(`/tg/status?ticket=${b.ticketId}`, `${cookie}; __Host-mw_tkt=${f.tkt}`);
  return (await r.json()) as { ready: boolean; next?: { action: string } };
}

test("(b) Telegram link path: an OLD session cannot mint a code when the ticket demanded re-auth", async () => {
  const f = await setup();
  const s = await f.addSession("old", T0 - 200); // far older than the demand
  const r = await linkStatus(f, s);
  expect(r.ready).toBe(true);
  expect(r.next?.action).toBe("done");
  expect(await count(f.db, "oauth_codes")).toBe(0);
});

test("(b) control: a session at/after the demand continues past 'done' on the link path", async () => {
  const f = await setup();
  const s = await f.addSession("fresh", T0);
  const r = await linkStatus(f, s);
  expect(r.next?.action).not.toBe("done");
});

test("(e) /authorize/pending: 5 s of slack is accepted, 6 s older is login_required; far-older sessions stay blocked", async () => {
  const f = await setup();
  const edge = await f.addSession("edge", T0 - 5);
  expect((await f.get("/authorize/pending", `__Host-mw_sess=${edge.raw}; __Host-mw_tkt=${f.tkt}`)).status).toBe(200);
  const over = await f.addSession("over", T0 - 6);
  const ro = await f.get("/authorize/pending", `__Host-mw_sess=${over.raw}; __Host-mw_tkt=${f.tkt}`);
  expect(ro.status).toBe(401);
  expect(((await ro.json()) as { error: string }).error).toBe("login_required");
  const old = await f.addSession("old", T0 - 4000);
  expect((await f.get("/authorize/pending", `__Host-mw_sess=${old.raw}; __Host-mw_tkt=${f.tkt}`)).status).toBe(401);
});

test("(e) /consent: same 5 s boundary; the far-older bypass is refused and mints no code", async () => {
  const f = await setup();
  const edge = await f.addSession("edge", T0 - 5);
  const ok = await f.post("/consent", `__Host-mw_sess=${edge.raw}; __Host-mw_tkt=${f.tkt}`, { decision: "allow", csrf: edge.csrf });
  expect(ok.status).toBe(200);
  const over = await f.addSession("over", T0 - 6);
  const no = await f.post("/consent", `__Host-mw_sess=${over.raw}; __Host-mw_tkt=${f.tkt}`, { decision: "allow", csrf: over.csrf });
  expect(no.status).toBe(401);
  const old = await f.addSession("old", T0 - 4000);
  expect((await f.post("/consent", `__Host-mw_sess=${old.raw}; __Host-mw_tkt=${f.tkt}`, { decision: "allow", csrf: old.csrf })).status).toBe(401);
  expect(await count(f.db, "oauth_codes")).toBe(1); // only the edge (within slack) one
});
