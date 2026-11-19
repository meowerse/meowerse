import { test, expect } from "vitest";
import { handle, rlKey } from "../src/index";
import { hmacSha256Hex, sha256Hex } from "../src/crypto";
import { internalConfirmString } from "../src/telegram";
import { genSigningKeys, memStore, cookieValue, botConfirm, tgVerify } from "./helpers";

const enc = new TextEncoder();
const BOT_TOKEN = "123456:bottoken";

async function fixture() {
  const { db, tables } = memStore();
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
  return { env, deps: { getDb: () => db, clock: () => 1000 }, tables };
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
  const { code } = (await confirm.json()) as { code: string };
  expect(code).toMatch(/^\d{8}$/);

  // THE FIX: a bot confirmation alone finalizes nothing — even the owning browser is not signed in without the code
  const early = await handle(new Request(`https://iss/tg/status?ticket=${sb.ticketId}`, { headers: { Cookie: `__Host-mw_tgown=${owner}` } }), env as never, deps as never);
  expect(((await early.json()) as { ready: boolean }).ready).toBe(false);
  expect((await tgVerify(handle, env, deps, { ticketId: sb.ticketId, code, owner })).status).toBe(200);

  // wrong owner → not ready (ticket_id alone grants nothing)
  const bad = await handle(new Request(`https://iss/tg/status?ticket=${sb.ticketId}`, { headers: { Cookie: "__Host-mw_tgown=wrong" } }), env as never, deps as never);
  expect(((await bad.json()) as { ready: boolean }).ready).toBe(false);

  // correct owner → ready + session
  const status = await handle(new Request(`https://iss/tg/status?ticket=${sb.ticketId}`, { headers: { Cookie: `__Host-mw_tgown=${owner}` } }), env as never, deps as never);
  const stb = (await status.json()) as { ready: boolean; next: { action: string } };
  expect(stb.ready).toBe(true);
  expect(cookieValue(status.headers.get("Set-Cookie"), "__Host-mw_sess")).toBeTruthy();
});

async function startVerify(env: unknown, deps: unknown, sess: string, csrf: string) {
  const start = await handle(new Request("https://iss/tg/start", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_sess=${sess}` }, body: JSON.stringify({ kind: "VERIFY_EXISTING", csrf }) }), env as never, deps as never);
  const sb = (await start.json()) as { ticketId: string; deepLink: string };
  return { ticketId: sb.ticketId, nonce: new URL(sb.deepLink).searchParams.get("start")!, owner: cookieValue(start.headers.get("Set-Cookie"), "__Host-mw_tgown")! };
}
/** Bot Yes + owning browser submits the code; returns the verify response (or the failed confirm). */
async function confirm(env: unknown, deps: unknown, t: { ticketId: string; nonce: string; owner: string }, tgId: string, sess?: string) {
  const { res, code } = await botConfirm(handle, env, deps, { nonce: t.nonce, tgId });
  if (!code) return res;
  return tgVerify(handle, env, deps, { ticketId: t.ticketId, code, owner: t.owner, sess });
}

test("verify-existing links Telegram to a logged-in account; a second account → linked_elsewhere (409)", async () => {
  const { env, deps } = await fixture();
  // account A (password) + session
  const suA = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "neko_ve", password: "abcdefghijkl" }) }), env as never, deps as never);
  const csrfA = ((await suA.json()) as { csrf: string }).csrf;
  const sessA = cookieValue(suA.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  const vA = await startVerify(env, deps, sessA, csrfA);
  expect((await confirm(env, deps, vA, "55", sessA)).status).toBe(200);
  const stA = await handle(new Request(`https://iss/tg/status?ticket=${vA.ticketId}`, { headers: { Cookie: `__Host-mw_tgown=${vA.owner}; __Host-mw_sess=${sessA}` } }), env as never, deps as never);
  expect(((await stA.json()) as { ready: boolean }).ready).toBe(true);

  // account B tries to claim the SAME telegram id → linked_elsewhere
  const suB = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "neko_ve2", password: "abcdefghijkl" }) }), env as never, deps as never);
  const csrfB = ((await suB.json()) as { csrf: string }).csrf;
  const sessB = cookieValue(suB.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  const vB = await startVerify(env, deps, sessB, csrfB);
  expect((await confirm(env, deps, vB, "55", sessB)).status).toBe(409);
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
  store.tables.rate_limits.push({ bucket: "tgstart:" + (await rlKey(env as never, new Request("https://iss/"), "tgstart")), count: 30, window_start: 1000 });
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

// ---- single-use tickets: a consumed ticket yields at most ONE session, and only while fresh ----
async function confirmedTicket(clock: { t: number }) {
  const store = memStore();
  const keys = await genSigningKeys();
  const env = {
    AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", WEB_ORIGIN: "https://web", RESOURCE_AUD: "https://api.meow",
    STATE_SECRET: "s", CORS_ORIGINS: "https://web", BOT_USERNAME: "meow_bot", INTERNAL_HMAC_KEY: "ikey", TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  };
  const deps = { getDb: () => store.db, clock: () => clock.t };
  const start = await handle(new Request("https://iss/tg/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), env as never, deps as never);
  const sb = (await start.json()) as { ticketId: string; deepLink: string };
  const owner = cookieValue(start.headers.get("Set-Cookie"), "__Host-mw_tgown")!;
  const nonce = new URL(sb.deepLink).searchParams.get("start")!;
  const ts = String(clock.t);
  const body = { nonce, telegram_id: "77", username: "once", display_name: "Once", avatar_url: "", ts };
  const sig = await hmacSha256Hex("ikey", internalConfirmString({ nonce, telegramId: "77", username: "once", displayName: "Once", avatarUrl: "", ts }));
  const c = await handle(new Request("https://iss/internal/tg/confirm", { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": sig }, body: JSON.stringify(body) }), env as never, deps as never);
  expect(c.status).toBe(200);
  const v = await tgVerify(handle, env, deps, { ticketId: sb.ticketId, code: ((await c.json()) as { code: string }).code, owner });
  expect(v.status).toBe(200);
  const poll = () => handle(new Request(`https://iss/tg/status?ticket=${sb.ticketId}`, { headers: { Cookie: `__Host-mw_tgown=${owner}` } }), env as never, deps as never);
  const sessionCount = () => (store.tables.sessions as unknown[]).length;
  const ticketStatus = () => (store.tables.login_tickets as { ticket_id: string; status: string }[]).find((r) => r.ticket_id === sb.ticketId)!.status;
  return { poll, sessionCount, ticketStatus, store };
}

test("a consumed ticket yields exactly one session; later polls are 'not ready' and mint nothing", async () => {
  const clock = { t: 1000 };
  const t = await confirmedTicket(clock);
  const first = await t.poll();
  expect(((await first.json()) as { ready: boolean }).ready).toBe(true);
  expect(cookieValue(first.headers.get("Set-Cookie"), "__Host-mw_sess")).toBeTruthy();
  expect(t.ticketStatus()).toBe("claimed");
  const sessions = t.sessionCount();
  for (let i = 0; i < 3; i++) {
    const again = await t.poll();
    expect(((await again.json()) as { ready: boolean }).ready).toBe(false);
    expect(again.headers.get("Set-Cookie")).toBeNull();
  }
  expect(t.sessionCount()).toBe(sessions);
});

test("concurrent polls on one consumed ticket: exactly one wins", async () => {
  const t = await confirmedTicket({ t: 1000 });
  const before = t.sessionCount();
  const results = await Promise.all([t.poll(), t.poll(), t.poll()]);
  const ready = await Promise.all(results.map(async (r) => ((await r.json()) as { ready: boolean }).ready));
  expect(ready.filter(Boolean)).toHaveLength(1);
  expect(t.sessionCount()).toBe(before + 1);
});

test("a consumed ticket is claimable within the 60s grace after expiry, not after", async () => {
  const late = { t: 1000 };
  const ok = await confirmedTicket(late);
  late.t = 1000 + 300 + 60; // expires_at (1000+TTL 300) + grace 60: still claimable
  expect(((await (await ok.poll()).json()) as { ready: boolean }).ready).toBe(true);

  const tooLate = { t: 1000 };
  const no = await confirmedTicket(tooLate);
  const before = no.sessionCount();
  tooLate.t = 1000 + 300 + 61;
  const r = await no.poll();
  expect(((await r.json()) as { ready: boolean }).ready).toBe(false);
  expect(r.headers.get("Set-Cookie")).toBeNull();
  expect(no.sessionCount()).toBe(before);
  expect(no.ticketStatus()).toBe("consumed");
});

test("a failure after the claim releases it, so the next poll still signs the user in", async () => {
  const t = await confirmedTicket({ t: 1000 });
  const real = t.store.db.execute.bind(t.store.db);
  let failOnce = true;
  t.store.db.execute = (async (q: { sql: string }) => {
    if (failOnce && /INSERT INTO sessions/.test(q.sql)) { failOnce = false; throw new Error("transient"); }
    return real(q as never);
  }) as typeof t.store.db.execute;
  const first = await t.poll().catch(() => null);
  if (first) expect(first.status).toBeGreaterThanOrEqual(500);
  expect(t.ticketStatus()).toBe("consumed"); // released, not stranded
  const retry = await t.poll();
  expect(((await retry.json()) as { ready: boolean }).ready).toBe(true);
  expect(t.ticketStatus()).toBe("claimed");
});



type Row = Record<string, unknown>;
async function accountWithSession(env: unknown, deps: unknown, username: string) {
  const su = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: "abcdefghijkl" }) }), env as never, deps as never);
  const csrf = ((await su.json()) as { csrf: string }).csrf;
  return { csrf, sess: cookieValue(su.headers.get("Set-Cookie"), "__Host-mw_sess")! };
}
const ctxRow = (tables: Record<string, Row[]>, id: string) => tables.login_ticket_ctx.find((r) => r.ticket_id === id)!;
const ticketRow = (tables: Record<string, Row[]>, id: string) => tables.login_tickets.find((r) => r.ticket_id === id)!;

test("link ticket: a revoked session cannot complete the link and no attempt is spent (401 no_session)", async () => {
  const { env, deps, tables } = await fixture();
  const a = await accountWithSession(env, deps, "neko_rev");
  const v = await startVerify(env, deps, a.sess, a.csrf);
  const { code } = await botConfirm(handle, env, deps, { nonce: v.nonce, tgId: "88" });
  expect(code).toBeTruthy();
  (tables.sessions as Row[]).length = 0; // owner revoked every session
  const r = await tgVerify(handle, env, deps, { ticketId: v.ticketId, code: code!, owner: v.owner, sess: a.sess });
  expect(r.status).toBe(401);
  expect(((await r.json()) as { error: string }).error).toBe("no_session");
  // and with no session cookie at all
  expect((await tgVerify(handle, env, deps, { ticketId: v.ticketId, code: code!, owner: v.owner })).status).toBe(401);
  expect((tables.telegram_links as Row[]).length).toBe(0);
  expect(Number(ctxRow(tables, v.ticketId).attempts)).toBe(0);
  expect(ticketRow(tables, v.ticketId).status).toBe("pending");
});

test("link ticket: a session of a DIFFERENT account cannot complete it", async () => {
  const { env, deps, tables } = await fixture();
  const a = await accountWithSession(env, deps, "neko_a1");
  const b = await accountWithSession(env, deps, "neko_b1");
  const v = await startVerify(env, deps, a.sess, a.csrf);
  const { code } = await botConfirm(handle, env, deps, { nonce: v.nonce, tgId: "89" });
  const r = await tgVerify(handle, env, deps, { ticketId: v.ticketId, code: code!, owner: v.owner, sess: b.sess });
  expect(r.status).toBe(401);
  expect((tables.telegram_links as Row[]).length).toBe(0);
});

test("final errors after a CORRECT code burn the ticket (retry is 'expired', attempts untouched beyond the one spent)", async () => {
  const { env, deps, tables } = await fixture();
  const a = await accountWithSession(env, deps, "neko_fe1");
  const b = await accountWithSession(env, deps, "neko_fe2");
  const vA = await startVerify(env, deps, a.sess, a.csrf);
  expect((await confirm(env, deps, vA, "56", a.sess)).status).toBe(200);
  const vB = await startVerify(env, deps, b.sess, b.csrf);
  const { code } = await botConfirm(handle, env, deps, { nonce: vB.nonce, tgId: "56" });
  const r = await tgVerify(handle, env, deps, { ticketId: vB.ticketId, code: code!, owner: vB.owner, sess: b.sess });
  expect(r.status).toBe(409);
  expect(((await r.json()) as { error: string }).error).toBe("linked_elsewhere");
  expect(ticketRow(tables, vB.ticketId).status).toBe("burned");
  const again = await tgVerify(handle, env, deps, { ticketId: vB.ticketId, code: code!, owner: vB.owner, sess: b.sess });
  expect(((await again.json()) as { error: string }).error).toBe("expired");
  expect(Number(ctxRow(tables, vB.ticketId).attempts)).toBe(1);
  expect(tables.audit_log.some((x) => x.event === "telegram.ticket_burned")).toBe(false);
});

test("cancel works after Yes (awaiting-code state): the code no longer completes the ticket", async () => {
  const { env, deps, tables } = await fixture();
  const start = await handle(new Request("https://iss/tg/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), env as never, deps as never);
  const sb = (await start.json()) as { ticketId: string; deepLink: string };
  const owner = cookieValue(start.headers.get("Set-Cookie"), "__Host-mw_tgown")!;
  const nonce = new URL(sb.deepLink).searchParams.get("start")!;
  const { code } = await botConfirm(handle, env, deps, { nonce, tgId: "90" });
  expect(code).toBeTruthy();
  const { internalCancelString } = await import("@meowerse/auth-shared");
  const sig = await hmacSha256Hex("ikey", internalCancelString({ nonce, telegramId: "90", ts: "1000" }));
  const c = await handle(new Request("https://iss/internal/tg/cancel", { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": sig }, body: JSON.stringify({ nonce, telegram_id: "90", ts: "1000" }) }), env as never, deps as never);
  expect(c.status).toBe(200);
  expect(ticketRow(tables, sb.ticketId).status).toBe("burned");
  const r = await tgVerify(handle, env, deps, { ticketId: sb.ticketId, code: code!, owner });
  expect(r.status).toBe(400);
  expect((tables.sessions as Row[]).length).toBe(0);
});

test("10 parallel wrong codes spend exactly 5 attempts and burn the ticket", async () => {
  const { env, deps, tables } = await fixture();
  const start = await handle(new Request("https://iss/tg/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), env as never, deps as never);
  const sb = (await start.json()) as { ticketId: string; deepLink: string };
  const owner = cookieValue(start.headers.get("Set-Cookie"), "__Host-mw_tgown")!;
  const { code } = await botConfirm(handle, env, deps, { nonce: new URL(sb.deepLink).searchParams.get("start")!, tgId: "91" });
  const wrong = code === "00000000" ? "11111111" : "00000000";
  const rs = await Promise.all(Array.from({ length: 10 }, () => tgVerify(handle, env, deps, { ticketId: sb.ticketId, code: wrong, owner })));
  expect(rs.every((r) => r.status === 400 || r.status === 429)).toBe(true);
  expect(Number(ctxRow(tables, sb.ticketId).attempts)).toBe(5);
  expect(ticketRow(tables, sb.ticketId).status).toBe("burned");
  // even the right code is now refused
  expect((await tgVerify(handle, env, deps, { ticketId: sb.ticketId, code: code!, owner })).status).toBe(400);
  expect((tables.sessions as Row[]).length).toBe(0);
});

test("tg/verify is IP-rate-limited (429)", async () => {
  const { env, deps, tables } = await fixture();
  (tables.rate_limits as Row[]).push({ bucket: "tgverify:" + (await rlKey(env as never, new Request("https://iss/"), "tgverify")), count: 30, window_start: 1000 });
  const r = await tgVerify(handle, env, deps, { ticketId: "tkt_x", code: "12345678", owner: "o" });
  expect(r.status).toBe(429);
});

async function verifyWithOrigin(origin: string | undefined) {
  const { env, deps } = await fixture();
  const start = await handle(new Request("https://iss/tg/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), env as never, deps as never);
  const sb = (await start.json()) as { ticketId: string; deepLink: string };
  const owner = cookieValue(start.headers.get("Set-Cookie"), "__Host-mw_tgown")!;
  const { code } = await botConfirm(handle, env, deps, { nonce: new URL(sb.deepLink).searchParams.get("start")!, tgId: "92" });
  const post = (o?: string) => handle(new Request("https://iss/tg/verify", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `__Host-mw_tgown=${owner}`, ...(o !== undefined ? { Origin: o } : {}) }, body: JSON.stringify({ ticket: sb.ticketId, code }) }), env as never, deps as never);
  const first = await post(origin);
  return { first, post };
}

test("tg/verify Origin policy: foreign and literal 'null' → 403 bad_origin (ticket untouched); allowlisted and absent → 200", async () => {
  for (const bad of ["https://evil.example", "null"]) {
    const { first, post } = await verifyWithOrigin(bad);
    expect(first.status).toBe(403);
    expect(((await first.json()) as { error: string }).error).toBe("bad_origin");
    expect((await post("https://web")).status).toBe(200); // the refusal spent nothing; the real origin still completes
  }
  expect((await verifyWithOrigin("https://web")).first.status).toBe(200);
  expect((await verifyWithOrigin(undefined)).first.status).toBe(200);
});

async function botCancel(env: unknown, deps: unknown, nonce: string, tgId: string) {
  const { internalCancelString } = await import("@meowerse/auth-shared");
  const sig = await hmacSha256Hex("ikey", internalCancelString({ nonce, telegramId: tgId, ts: "1000" }));
  return handle(new Request("https://iss/internal/tg/cancel", { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": sig }, body: JSON.stringify({ nonce, telegram_id: tgId, ts: "1000" }) }), env as never, deps as never);
}

test("cancel of an already-completed ticket → 409 already_used (not ok); unknown nonce → 400 invalid_ticket", async () => {
  const { env, deps, tables } = await fixture();
  const start = await handle(new Request("https://iss/tg/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), env as never, deps as never);
  const sb = (await start.json()) as { ticketId: string; deepLink: string };
  const owner = cookieValue(start.headers.get("Set-Cookie"), "__Host-mw_tgown")!;
  const nonce = new URL(sb.deepLink).searchParams.get("start")!;
  const { code } = await botConfirm(handle, env, deps, { nonce, tgId: "93" });
  expect((await tgVerify(handle, env, deps, { ticketId: sb.ticketId, code: code!, owner })).status).toBe(200);
  const c = await botCancel(env, deps, nonce, "93");
  expect(c.status).toBe(409);
  expect(((await c.json()) as { error: string }).error).toBe("already_used");
  expect(ticketRow(tables, sb.ticketId).status).toBe("consumed");
  // a different Telegram user learns nothing about the completed ticket
  const stranger = await botCancel(env, deps, nonce, "9999");
  expect(stranger.status).toBe(400);
  expect(((await stranger.json()) as { error: string }).error).toBe("invalid_ticket");
  const u = await botCancel(env, deps, "nope-nonce", "93");
  expect(u.status).toBe(400);
  expect(((await u.json()) as { error: string }).error).toBe("invalid_ticket");
});

test("cancel after Yes is bound to the confirming Telegram user", async () => {
  const { env, deps, tables } = await fixture();
  const start = await handle(new Request("https://iss/tg/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), env as never, deps as never);
  const sb = (await start.json()) as { ticketId: string; deepLink: string };
  const nonce = new URL(sb.deepLink).searchParams.get("start")!;
  await botConfirm(handle, env, deps, { nonce, tgId: "94" });
  const other = await botCancel(env, deps, nonce, "95");
  expect(other.status).toBe(400);
  expect(((await other.json()) as { error: string }).error).toBe("invalid_ticket");
  expect(ticketRow(tables, sb.ticketId).status).toBe("pending");
  expect(ctxRow(tables, sb.ticketId).tg_id).toBe("94"); // the refused cancel left the confirmer's identity intact
  expect((await botCancel(env, deps, nonce, "94")).status).toBe(200);
  expect(ticketRow(tables, sb.ticketId).status).toBe("burned");
});

test("cancel racing a completion: ticket consumed between lookup and burn → 409 already_used, never ok, no audit", async () => {
  const { env, deps, tables } = await fixture();
  const start = await handle(new Request("https://iss/tg/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), env as never, deps as never);
  const sb = (await start.json()) as { ticketId: string; deepLink: string };
  const owner = cookieValue(start.headers.get("Set-Cookie"), "__Host-mw_tgown")!;
  const nonce = new URL(sb.deepLink).searchParams.get("start")!;
  const { code } = await botConfirm(handle, env, deps, { nonce, tgId: "96" });
  const db = deps.getDb();
  const real = db.execute.bind(db);
  let injected = false;
  db.execute = (async (q: { sql: string }) => {
    if (!injected && /UPDATE login_tickets SET status = 'burned'/.test(q.sql)) {
      injected = true;
      db.execute = real; // the completion happens right before the burn statement runs
      expect((await tgVerify(handle, env, deps, { ticketId: sb.ticketId, code: code!, owner })).status).toBe(200);
    }
    return real(q as never);
  }) as typeof db.execute;
  const c = await botCancel(env, deps, nonce, "96");
  expect(injected).toBe(true);
  expect(c.status).toBe(409);
  expect(((await c.json()) as { error: string }).error).toBe("already_used");
  expect(ticketRow(tables, sb.ticketId).status).toBe("consumed");
  expect(tables.audit_log.some((x) => x.event === "telegram.ticket_cancelled")).toBe(false);
});

test("cancel by another Telegram user racing the confirm is refused atomically (guard inside the burn)", async () => {
  const { env, deps, tables } = await fixture();
  const start = await handle(new Request("https://iss/tg/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), env as never, deps as never);
  const sb = (await start.json()) as { ticketId: string; deepLink: string };
  const nonce = new URL(sb.deepLink).searchParams.get("start")!;
  const db = deps.getDb();
  const real = db.execute.bind(db);
  // the ticket has no code at lookup time; the confirm lands just before the burn, so only the SQL guard can stop the stranger
  db.execute = (async (q: { sql: string }) => {
    if (/UPDATE login_tickets SET status = 'burned'/.test(q.sql)) {
      db.execute = real;
      await botConfirm(handle, env, deps, { nonce, tgId: "97" });
    }
    return real(q as never);
  }) as typeof db.execute;
  const c = await botCancel(env, deps, nonce, "98");
  expect(c.status).toBe(400);
  expect(ticketRow(tables, sb.ticketId).status).toBe("pending");
  expect(ctxRow(tables, sb.ticketId).tg_id).toBe("97");
});
