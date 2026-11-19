import { test, expect } from "vitest";
import { handle } from "../src/index";
import { hmacSha256Hex } from "../src/crypto";
import { internalDescribeString, internalCancelString } from "@meowerse/auth-shared";
import { coarseUserAgent, generateTgCode, normaliseTgCode, tgCodeHash } from "../src/telegram";
import { genSigningKeys, memStore, cookieValue, botConfirm, tgVerify } from "./helpers";

// Telegram deep-link sign-in needs a SECOND factor: the bot's "Yes" only issues a one-time code (hash stored); the
// session/link is written only when the ticket-owning browser submits that code at /tg/verify.

const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";

async function fixture(clock = { t: 1000 }) {
  const store = memStore();
  const env = {
    AUTH_SIGNING_KEYS: JSON.stringify(await genSigningKeys()), ISSUER: "https://iss", WEB_ORIGIN: "https://web", RESOURCE_AUD: "https://api.meow",
    STATE_SECRET: "s", CORS_ORIGINS: "https://web", BOT_USERNAME: "meow_bot", INTERNAL_HMAC_KEY: "ikey", TELEGRAM_BOT_TOKEN: "1:t",
  };
  const deps = { getDb: () => store.db, clock: () => clock.t };
  const call = (path: string, init: RequestInit = {}) => handle(new Request(`https://iss${path}`, init), env as never, deps as never);
  const start = async (extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const r = await call("/tg/start", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA, "CF-IPCountry": "DE", ...headers }, body: JSON.stringify(extra) });
    const b = (await r.json()) as { ticketId: string; deepLink: string };
    return { ticketId: b.ticketId, nonce: new URL(b.deepLink).searchParams.get("start")!, owner: cookieValue(r.headers.get("Set-Cookie"), "__Host-mw_tgown")! };
  };
  const status = (t: { ticketId: string }, owner: string) => call(`/tg/status?ticket=${t.ticketId}`, { headers: { Cookie: `__Host-mw_tgown=${owner}` } });
  const ready = async (t: { ticketId: string }, owner: string) => ((await (await status(t, owner)).json()) as { ready: boolean }).ready;
  const signed = async (path: "describe" | "cancel", f: { nonce: string; tgId: string; ts?: string }, sigOverride?: string) => {
    const ts = f.ts ?? String(clock.t);
    const str = (path === "describe" ? internalDescribeString : internalCancelString)({ nonce: f.nonce, telegramId: f.tgId, ts });
    const sig = sigOverride ?? (await hmacSha256Hex("ikey", str));
    return call(`/internal/tg/${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": sig }, body: JSON.stringify({ nonce: f.nonce, telegram_id: f.tgId, ts }) });
  };
  const ticketRow = (id: string) => store.tables.login_tickets.find((r) => r.ticket_id === id)!;
  const ctxRow = (id: string) => store.tables.login_ticket_ctx.find((r) => r.ticket_id === id)!;
  const events = () => store.tables.audit_log.map((r) => r.event);
  const verify = (t: { ticketId: string }, code: string, owner: string) => tgVerify(handle, env, deps, { ticketId: t.ticketId, code, owner });
  const bot = (nonce: string, tgId = "42") => botConfirm(handle, env, deps, { nonce, tgId, ts: String(clock.t) });
  return { store, env, deps, call, start, status, ready, signed, ticketRow, ctxRow, events, verify, bot, clock };
}

test("code is stored ONLY hashed (keyed, bound to the ticket) and never returned to the browser", async () => {
  const f = await fixture();
  const t = await f.start();
  const { code } = await f.bot(t.nonce);
  expect(code).toMatch(/^\d{8}$/);
  const ctx = f.ctxRow(t.ticketId);
  expect(ctx.code_hash).toBe(await tgCodeHash("ikey", t.ticketId, code!));
  expect(JSON.stringify(f.store.tables)).not.toContain(code!);
  const st = await (await f.status(t, t.owner)).text();
  expect(st).not.toContain(code!);
});

test("bot confirmation alone never signs anyone in (legacy immediate-finalize is dead); the code finalizes", async () => {
  const f = await fixture();
  const t = await f.start();
  const accountsBefore = f.store.tables.accounts.length; // seeded system account
  const { res, code } = await f.bot(t.nonce);
  expect(res.status).toBe(200);
  expect(await f.ready(t, t.owner)).toBe(false);
  expect(f.store.tables.sessions).toHaveLength(0);
  expect(f.store.tables.telegram_links).toHaveLength(0); // nothing written to accounts/links before the code
  expect(f.store.tables.accounts).toHaveLength(accountsBefore);
  expect((await f.verify(t, code!, t.owner)).status).toBe(200);
  expect(await f.ready(t, t.owner)).toBe(true);
  expect(f.store.tables.telegram_links).toHaveLength(1);
});

test("a second confirm for the same ticket is rejected (one code per ticket); replay after finalize is rejected", async () => {
  const f = await fixture();
  const t = await f.start();
  const first = await f.bot(t.nonce, "42");
  expect((await f.bot(t.nonce, "43")).res.status).toBe(409); // another Telegram user cannot overwrite the issued code/identity
  expect((await f.verify(t, first.code!, t.owner)).status).toBe(200);
  expect((await f.bot(t.nonce, "42")).res.status).toBe(400); // replay once the ticket is consumed
  expect(f.store.tables.telegram_links).toHaveLength(1);
  expect(String(f.store.tables.telegram_links[0]!.telegram_id)).toBe("42");
});

test("wrong code does not finalize; the right code still works afterwards", async () => {
  const f = await fixture();
  const t = await f.start();
  const { code } = await f.bot(t.nonce);
  const wrong = code === "00000000" ? "11111111" : "00000000";
  const r = await f.verify(t, wrong, t.owner);
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: "wrong_code", attemptsLeft: 4 });
  expect(await f.ready(t, t.owner)).toBe(false);
  expect(f.ticketRow(t.ticketId).status).toBe("pending");
  expect((await f.verify(t, "not-a-code", t.owner)).status).toBe(400); // malformed counts as an attempt
  expect((await f.verify(t, code!, t.owner)).status).toBe(200);
  expect(await f.ready(t, t.owner)).toBe(true);
});

test("the 5th wrong code burns the ticket (audit event); even the correct code is then rejected", async () => {
  const f = await fixture();
  const t = await f.start();
  const { code } = await f.bot(t.nonce);
  const wrong = code === "00000000" ? "11111111" : "00000000";
  for (let i = 0; i < 4; i++) expect((await f.verify(t, wrong, t.owner)).status).toBe(400);
  const fifth = await f.verify(t, wrong, t.owner);
  expect(fifth.status).toBe(429);
  expect(f.ticketRow(t.ticketId).status).toBe("burned");
  expect(f.events()).toContain("telegram.ticket_burned");
  expect(f.ctxRow(t.ticketId).tg_id).toBeNull(); // identity dropped
  expect((await f.verify(t, code!, t.owner)).status).toBe(400);
  expect(await f.ready(t, t.owner)).toBe(false);
  expect(f.store.tables.sessions).toHaveLength(0);
  expect(f.store.tables.telegram_links).toHaveLength(0);
});

test("only 5 comparisons are ever made, even with the right code after exhaustion (budget is atomic)", async () => {
  const f = await fixture();
  const t = await f.start();
  const { code } = await f.bot(t.nonce);
  f.ctxRow(t.ticketId).attempts = 5; // budget spent
  const r = await f.verify(t, code!, t.owner);
  expect(r.status).toBe(429);
  expect(f.ticketRow(t.ticketId).status).toBe("burned");
});

test("a browser that does not own the ticket can never complete it (and cannot burn it)", async () => {
  const f = await fixture();
  const t = await f.start();
  const { code } = await f.bot(t.nonce);
  const attacker = await f.start(); // the victim-side/other browser has its own cookie
  for (const owner of [attacker.owner, "", "garbage"]) {
    const r = await f.verify(t, code!, owner);
    expect(r.status).toBe(403);
  }
  // no cookie at all
  const nocookie = await f.call("/tg/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket: t.ticketId, code }) });
  expect(nocookie.status).toBe(403);
  // wrong-code spam by a non-owner does not spend the owner's attempts
  for (let i = 0; i < 8; i++) await f.verify(t, "00000000", attacker.owner);
  expect(f.ctxRow(t.ticketId).attempts).toBe(0);
  expect(f.ticketRow(t.ticketId).status).toBe("pending");
  expect(await f.ready(t, attacker.owner)).toBe(false);
  expect((await f.verify(t, code!, t.owner)).status).toBe(200); // owner still completes
});

test("verify before the Telegram confirmation, after expiry, or for an unknown ticket is rejected", async () => {
  const f = await fixture();
  const t = await f.start();
  expect((await f.verify(t, "12345678", t.owner)).status).toBe(409); // not confirmed in Telegram yet
  expect((await f.verify({ ticketId: "tkt_nope" }, "12345678", t.owner)).status).toBe(403);
  const { code } = await f.bot(t.nonce);
  f.clock.t += 301;
  expect((await f.verify(t, code!, t.owner)).status).toBe(400);
  expect(await f.ready(t, t.owner)).toBe(false);
});

test("describe: bad signature / stale ts / wrong action signature are rejected", async () => {
  const f = await fixture();
  const t = await f.start();
  expect((await f.signed("describe", { nonce: t.nonce, tgId: "42" }, "bad")).status).toBe(401);
  expect((await f.signed("describe", { nonce: t.nonce, tgId: "42", ts: String(f.clock.t - 500) })).status).toBe(401);
  // a cancel signature cannot be replayed as a describe (domain separation)
  const cancelSig = await hmacSha256Hex("ikey", internalCancelString({ nonce: t.nonce, telegramId: "42", ts: String(f.clock.t) }));
  expect((await f.signed("describe", { nonce: t.nonce, tgId: "42" }, cancelSig)).status).toBe(401);
  // and the signature is bound to the telegram id
  const forThem = await hmacSha256Hex("ikey", internalDescribeString({ nonce: t.nonce, telegramId: "1", ts: String(f.clock.t) }));
  expect((await f.signed("describe", { nonce: t.nonce, tgId: "2" }, forThem)).status).toBe(401);
  expect((await f.signed("describe", { nonce: "ghost", tgId: "42" })).status).toBe(400);
});

test("describe returns kind (signup / signin / link) + coarse context only", async () => {
  const f = await fixture();
  const t = await f.start();
  f.clock.t += 90;
  const r = await f.signed("describe", { nonce: t.nonce, tgId: "42" });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ kind: "signup", country: "DE", browser: "Firefox", os: "Linux", age: 90 });
  // an already-linked Telegram id is a sign-in
  const t0 = await f.start();
  const { code } = await f.bot(t0.nonce, "42");
  await f.verify(t0, code!, t0.owner);
  const t2 = await f.start();
  expect(((await (await f.signed("describe", { nonce: t2.nonce, tgId: "42" })).json()) as { kind: string }).kind).toBe("signin");
  // a link ticket says link
  const su = await f.call("/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "neko_desc", password: "abcdefghijkl" }) });
  const csrf = ((await su.json()) as { csrf: string }).csrf;
  const sess = cookieValue(su.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  const lt = await f.start({ kind: "VERIFY_EXISTING", csrf }, { Cookie: `__Host-mw_sess=${sess}` });
  expect(((await (await f.signed("describe", { nonce: lt.nonce, tgId: "999" })).json()) as { kind: string }).kind).toBe("link");
  // no raw UA / IP is stored on the context row
  expect(JSON.stringify(f.ctxRow(t.ticketId))).not.toContain("Mozilla");
});

test("describe is refused once a code has been issued (one confirmation per ticket)", async () => {
  const f = await fixture();
  const t = await f.start();
  await f.bot(t.nonce);
  expect((await f.signed("describe", { nonce: t.nonce, tgId: "42" })).status).toBe(400);
});

test("cancel: bad signature rejected; a signed cancel burns the ticket (audit) so confirm/verify can never complete it", async () => {
  const f = await fixture();
  const t = await f.start();
  expect((await f.signed("cancel", { nonce: t.nonce, tgId: "42" }, "bad")).status).toBe(401);
  expect(f.ticketRow(t.ticketId).status).toBe("pending");
  expect((await f.signed("cancel", { nonce: t.nonce, tgId: "42" })).status).toBe(200);
  expect(f.ticketRow(t.ticketId).status).toBe("burned");
  expect(f.events()).toContain("telegram.ticket_cancelled");
  expect((await f.bot(t.nonce)).res.status).toBe(400);
  expect(await f.ready(t, t.owner)).toBe(false);
  expect(f.store.tables.sessions).toHaveLength(0);
  // a cancel after the code was issued also burns it: the code no longer works
  const t2 = await f.start();
  const { code } = await f.bot(t2.nonce);
  expect((await f.signed("cancel", { nonce: t2.nonce, tgId: "42" })).status).toBe(200);
  expect((await f.verify(t2, code!, t2.owner)).status).toBe(400);
});

test("confirm still requires a valid signature and ts window", async () => {
  const f = await fixture();
  const t = await f.start();
  expect((await botConfirm(handle, f.env, f.deps, { nonce: t.nonce, tgId: "42", ts: String(f.clock.t - 500) })).res.status).toBe(401);
  const forged = await f.call("/internal/tg/confirm", { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": "bad" }, body: JSON.stringify({ nonce: t.nonce, telegram_id: "42", ts: String(f.clock.t) }) });
  expect(forged.status).toBe(401);
});

test("code helpers: 8 digits from the CSPRNG, normalisation, coarse UA", () => {
  const codes = new Set(Array.from({ length: 50 }, generateTgCode));
  for (const c of codes) expect(c).toMatch(/^\d{8}$/);
  expect(codes.size).toBeGreaterThan(45);
  expect(normaliseTgCode("1234 5678")).toBe("12345678");
  expect(normaliseTgCode("1234-5678")).toBe("12345678");
  expect(normaliseTgCode("1234567")).toBeNull();
  expect(normaliseTgCode("1234567a")).toBeNull();
  expect(coarseUserAgent(UA)).toEqual({ browser: "Firefox", os: "Linux" });
  expect(coarseUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17 Mobile Safari/604")).toEqual({ browser: "Safari", os: "iOS" });
  expect(coarseUserAgent(null)).toEqual({ browser: "an unknown browser", os: "an unknown OS" });
});
