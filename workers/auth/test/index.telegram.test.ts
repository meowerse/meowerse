import { test, expect } from "vitest";
import { handle } from "../src/index";
import { hmacSha256Hex, sha256Hex } from "../src/crypto";
import { internalConfirmString } from "../src/telegram";
import { genSigningKeys, memStore, cookieValue } from "./helpers";

const enc = new TextEncoder();
const BOT_TOKEN = "123456:bottoken";

async function fixture() {
  const { db } = memStore();
  const keys = await genSigningKeys();
  const env = {
    AUTH_SIGNING_KEYS: JSON.stringify(keys),
    ISSUER: "https://iss",
    WEB_ORIGIN: "https://web",
    RESOURCE_AUD: "https://api.meow",
    STATE_SECRET: "s",
    CORS_ORIGINS: "https://web",
    BOT_USERNAME: "meow_bot",
    INTERNAL_HMAC_KEY: "ikey",
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  };
  return { env, deps: { getDb: () => db, clock: () => 1000 } };
}

async function signWidget(data: Record<string, string>): Promise<string> {
  const dcs = Object.keys(data).filter((k) => k !== "hash").sort().map((k) => `${k}=${data[k]}`).join("\n");
  const secret = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(BOT_TOKEN)));
  const k = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(dcs)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("deep-link: start → HMAC bot confirm → owner-bound status issues a session", async () => {
  const { env, deps } = await fixture();
  const start = await handle(new Request("https://iss/tg/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), env as never, deps as never);
  const sb = (await start.json()) as { ticketId: string; deepLink: string };
  const owner = cookieValue(start.headers.get("Set-Cookie"), "__Host-mw_tgown")!;
  const nonce = new URL(sb.deepLink).searchParams.get("start")!;
  expect(sb.ticketId).toMatch(/^tkt_/);
  expect(sb.deepLink.startsWith("https://t.me/meow_bot?start=")).toBe(true);

  const body = { nonce, telegram_id: "42", username: "nekotg", display_name: "Neko", avatar_url: "", ts: "1000" };
  const sig = await hmacSha256Hex("ikey", internalConfirmString({ nonce, telegramId: "42", username: "nekotg", displayName: "Neko", avatarUrl: "", ts: "1000" }));

  // forged signature rejected
  const forged = await handle(new Request("https://iss/internal/tg/confirm", { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": "bad" }, body: JSON.stringify(body) }), env as never, deps as never);
  expect(forged.status).toBe(401);

  const confirm = await handle(new Request("https://iss/internal/tg/confirm", { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": sig }, body: JSON.stringify(body) }), env as never, deps as never);
  expect(confirm.status).toBe(200);

  // wrong owner → not ready (ticket_id alone grants nothing)
  const bad = await handle(new Request(`https://iss/tg/status?ticket=${sb.ticketId}`, { headers: { Cookie: "__Host-mw_tgown=wrong" } }), env as never, deps as never);
  expect(((await bad.json()) as { ready: boolean }).ready).toBe(false);

  // correct owner → ready + session
  const status = await handle(new Request(`https://iss/tg/status?ticket=${sb.ticketId}`, { headers: { Cookie: `__Host-mw_tgown=${owner}` } }), env as never, deps as never);
  const stb = (await status.json()) as { ready: boolean; next: { action: string } };
  expect(stb.ready).toBe(true);
  expect(cookieValue(status.headers.get("Set-Cookie"), "__Host-mw_sess")).toBeTruthy();
});

async function startVerify(env: unknown, deps: unknown, sess: string) {
  const start = await handle(new Request("https://iss/tg/start", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${sess}` }, body: JSON.stringify({ kind: "VERIFY_EXISTING" }) }), env as never, deps as never);
  const sb = (await start.json()) as { ticketId: string; deepLink: string };
  return { ticketId: sb.ticketId, nonce: new URL(sb.deepLink).searchParams.get("start")!, owner: cookieValue(start.headers.get("Set-Cookie"), "__Host-mw_tgown")! };
}
async function confirm(env: unknown, deps: unknown, nonce: string, tgId: string) {
  const body = { nonce, telegram_id: tgId, username: "u", display_name: "U", avatar_url: "", ts: "1000" };
  const sig = await hmacSha256Hex("ikey", internalConfirmString({ nonce, telegramId: tgId, username: "u", displayName: "U", avatarUrl: "", ts: "1000" }));
  return handle(new Request("https://iss/internal/tg/confirm", { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": sig }, body: JSON.stringify(body) }), env as never, deps as never);
}

test("verify-existing links Telegram to a logged-in account; a second account → linked_elsewhere (409)", async () => {
  const { env, deps } = await fixture();
  // account A (password) + session
  const suA = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "neko_ve", password: "abcdefghijkl" }) }), env as never, deps as never);
  const sessA = cookieValue(suA.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  const vA = await startVerify(env, deps, sessA);
  expect((await confirm(env, deps, vA.nonce, "55")).status).toBe(200);
  const stA = await handle(new Request(`https://iss/tg/status?ticket=${vA.ticketId}`, { headers: { Cookie: `__Host-mw_tgown=${vA.owner}; __Host-mw_sess=${sessA}` } }), env as never, deps as never);
  expect(((await stA.json()) as { ready: boolean }).ready).toBe(true);

  // account B tries to claim the SAME telegram id → linked_elsewhere
  const suB = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "neko_ve2", password: "abcdefghijkl" }) }), env as never, deps as never);
  const sessB = cookieValue(suB.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  const vB = await startVerify(env, deps, sessB);
  expect((await confirm(env, deps, vB.nonce, "55")).status).toBe(409);
});

test("internal confirm with an unknown nonce → 400", async () => {
  const { env, deps } = await fixture();
  const body = { nonce: "ghost", telegram_id: "1", username: "", display_name: "", avatar_url: "", ts: "1000" };
  const sig = await hmacSha256Hex("ikey", internalConfirmString({ nonce: "ghost", telegramId: "1", username: "", displayName: "", avatarUrl: "", ts: "1000" }));
  const r = await handle(new Request("https://iss/internal/tg/confirm", { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": sig }, body: JSON.stringify(body) }), env as never, deps as never);
  expect(r.status).toBe(400);
});

test("tg/start is IP-rate-limited (429)", async () => {
  const store = memStore();
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", BOT_USERNAME: "meow_bot", CORS_ORIGINS: "https://web" };
  const deps = { getDb: () => store.db, clock: () => 1000 };
  store.tables.rate_limits.push({ bucket: "tgstart:" + (await sha256Hex("|tgstart")), count: 30, window_start: 1000 });
  const r = await handle(new Request("https://iss/tg/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), env as never, deps as never);
  expect(r.status).toBe(429);
});

test("tg/start VERIFY_EXISTING without a session → 401", async () => {
  const { env, deps } = await fixture();
  const r = await handle(new Request("https://iss/tg/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "VERIFY_EXISTING" }) }), env as never, deps as never);
  expect(r.status).toBe(401);
});

test("widget sign-in issues a session; bad hash → 401; unconfigured → 503", async () => {
  const { env, deps } = await fixture();
  const data: Record<string, string> = { id: "77", first_name: "Tg", username: "tguser", auth_date: "1000" };
  data.hash = await signWidget(data);
  const ok = await handle(new Request("https://iss/tg/widget", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }), env as never, deps as never);
  expect(ok.status).toBe(200);
  expect(cookieValue(ok.headers.get("Set-Cookie"), "__Host-mw_sess")).toBeTruthy();

  const bad = await handle(new Request("https://iss/tg/widget", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...data, hash: "bad" }) }), env as never, deps as never);
  expect(bad.status).toBe(401);

  const noBot = await handle(new Request("https://iss/tg/widget", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }), { ...env, TELEGRAM_BOT_TOKEN: undefined } as never, deps as never);
  expect(noBot.status).toBe(503);
});
