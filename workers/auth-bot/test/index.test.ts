import { afterEach, test, expect, vi } from "vitest";
import worker, { handle } from "../src/index";
import { internalConfirmString, internalDescribeString, internalCancelString } from "@meowerse/auth-shared";

afterEach(() => vi.restoreAllMocks());

const ENV = {
  TELEGRAM_BOT_TOKEN: "123:tok",
  TELEGRAM_WEBHOOK_SECRET: "whsec",
  INTERNAL_HMAC_KEY: "ikey",
  PATH_SECRET: "pathsec",
  AUTH_CONFIRM_URL: "https://auth-api/internal/tg/confirm",
};

function req(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://bot${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

test("wrong path secret → 404; wrong header secret → 403; missing secrets → 404/403", async () => {
  expect((await handle(req("/tg/WRONG", {}), ENV)).status).toBe(404);
  expect((await handle(req("/tg/pathsec", {}, { "X-Telegram-Bot-Api-Secret-Token": "nope" }), ENV)).status).toBe(403);
  expect((await handle(req("/tg/pathsec", {}), { ...ENV, PATH_SECRET: undefined })).status).toBe(404);
  expect((await handle(req("/tg/pathsec", {}, { "X-Telegram-Bot-Api-Secret-Token": "whsec" }), { ...ENV, TELEGRAM_WEBHOOK_SECRET: undefined })).status).toBe(403);
});

test("default fetch entrypoint forwards to handle", async () => {
  const r = await worker.fetch(req("/tg/WRONG", {}), ENV);
  expect(r.status).toBe(404);
});

const NONCE = "AbCdEfGhIjKlMnOpQrStUvWx"; // 24 chars, like a real base64url nonce
const hdr = { "X-Telegram-Bot-Api-Secret-Token": "whsec" };
const startUpdate = (nonce = NONCE, id = 42) => ({ message: { text: `/start ${nonce}`, chat: { id, type: "private" }, from: { id, username: "nekotg", first_name: "Neko" } } });
const cbUpdate = (data: string, over: Record<string, unknown> = {}) => ({
  callback_query: { id: "cb1", data, from: { id: 42, username: "nekotg", first_name: "Neko" }, message: { message_id: 7, chat: { id: 42, type: "private" } }, ...over },
});
type Sent = { method: string; chat_id: number; text: string; message_id?: number; callback_query_id?: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } };

const CONFIRM = "https://auth-api/internal/tg/confirm";
const DESCRIBE = "https://auth-api/internal/tg/describe";
const CANCEL = "https://auth-api/internal/tg/cancel";
const jsonRes = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

/** Route the bot's outbound calls to the auth worker; unknown URLs fail the test. */
function authMock(opts: { describe?: unknown; describeStatus?: number; confirm?: unknown; confirmStatus?: number } = {}) {
  const m = vi.fn(async (url: string) => {
    if (url === DESCRIBE) return jsonRes(opts.describe ?? { kind: "signin", country: "DE", browser: "Firefox", os: "Linux", age: 125 }, opts.describeStatus ?? 200);
    if (url === CONFIRM) return jsonRes(opts.confirm ?? { ok: true, code: "12345678" }, opts.confirmStatus ?? 200);
    if (url === CANCEL) return jsonRes({ ok: true });
    throw new Error("unexpected fetch " + url);
  });
  vi.stubGlobal("fetch", m);
  const calls = (u: string) => m.mock.calls.filter((c) => c[0] === u);
  return { m, calls };
}

async function hmac(msg: string, key = "ikey") {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("/start <nonce> asks the auth worker to describe (signed), shows Yes/Cancel and does NOT confirm", async () => {
  const { m, calls } = authMock();
  const res = await handle(req("/tg/pathsec", startUpdate(), hdr), ENV, () => 1000);
  const body = (await res.json()) as Sent;
  expect(calls(CONFIRM)).toHaveLength(0);
  expect(calls(CANCEL)).toHaveLength(0);
  expect(calls(DESCRIBE)).toHaveLength(1);
  const [, opts] = m.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];
  expect(JSON.parse(opts.body)).toEqual({ nonce: NONCE, telegram_id: "42", ts: "1000" }); // the viewing user's id, not anything from the page
  expect(opts.headers["X-Signature"]).toBe(await hmac(internalDescribeString({ nonce: NONCE, telegramId: "42", ts: "1000" })));
  expect(body.method).toBe("sendMessage");
  expect(body.chat_id).toBe(42);
  expect(body.text).toContain("signing in to Meowerse");
  expect(body.text).toContain("DE · Firefox on Linux · started 2 min ago");
  expect(body.text).toContain("one-time code");
  expect(body.text).toContain("auth.alxnko.dev in the browser YOU opened");
  expect(body.text).toContain("Never send it to anyone");
  expect(body.text).not.toContain("Linked");
  const [yes, no] = body.reply_markup!.inline_keyboard[0]!;
  expect(yes!.callback_data).toBe(`y:${NONCE}`);
  expect(no!.callback_data).toBe(`n:${NONCE}`);
  expect(new TextEncoder().encode(yes!.callback_data).length).toBeLessThanOrEqual(64);
});

test("prompt wording follows the ticket kind: link never says 'signing in'", async () => {
  authMock({ describe: { kind: "link", country: "FR", browser: "Chrome", os: "Windows", age: 5 } });
  const link = (await (await handle(req("/tg/pathsec", startUpdate(), hdr), ENV, () => 1000)).json()) as Sent;
  expect(link.text).toContain("link this Telegram account to a Meowerse account");
  expect(link.text).not.toContain("signing in");
  expect(link.text).toContain("just now");
  authMock({ describe: { kind: "signup", country: "", browser: "Safari", os: "iOS", age: 600 } });
  const signup = (await (await handle(req("/tg/pathsec", startUpdate(), hdr), ENV, () => 1000)).json()) as Sent;
  expect(signup.text).toContain("creating a new Meowerse account");
  expect(signup.text).toContain("Safari on iOS · started 10 min ago");
});

test("describe failure / bad kind / unknown ticket → no buttons, no confirm (fail closed)", async () => {
  for (const o of [{ describeStatus: 400, describe: { error: "invalid_ticket" } }, { describeStatus: 404 }, { describe: { kind: "admin" } }, { describe: "x" }]) {
    const { calls } = authMock(o as never);
    const r = (await (await handle(req("/tg/pathsec", startUpdate(), hdr), ENV, () => 1000)).json()) as Sent;
    expect(r.reply_markup).toBeUndefined();
    expect(r.text).toContain("expired");
    expect(calls(CONFIRM)).toHaveLength(0);
  }
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
  expect(((await (await handle(req("/tg/pathsec", startUpdate(), hdr), ENV)).json()) as Sent).reply_markup).toBeUndefined();
  // confirm URL not shaped like …/confirm → cannot derive the describe URL → fail closed
  const { m } = authMock();
  const r = (await (await handle(req("/tg/pathsec", startUpdate(), hdr), { ...ENV, AUTH_CONFIRM_URL: "https://auth-api/odd" })).json()) as Sent;
  expect(r.reply_markup).toBeUndefined();
  expect(m).toHaveBeenCalledTimes(0);
});

test("/start in a group chat, for another user, or with a malformed nonce is not prompted (0 fetches)", async () => {
  const { m } = authMock();
  const group = { message: { text: `/start ${NONCE}`, chat: { id: -100, type: "group" }, from: { id: 42 } } };
  expect(((await (await handle(req("/tg/pathsec", group, hdr), ENV)).json()) as Sent).reply_markup).toBeUndefined();
  const other = { message: { text: `/start ${NONCE}`, chat: { id: 7, type: "private" }, from: { id: 42 } } };
  expect(((await (await handle(req("/tg/pathsec", other, hdr), ENV)).json()) as Sent).reply_markup).toBeUndefined();
  expect(((await (await handle(req("/tg/pathsec", startUpdate("short"), hdr), ENV)).json()) as Sent).reply_markup).toBeUndefined();
  expect(m).toHaveBeenCalledTimes(0);
});

test("callback Yes: ONE signed confirm with identity from callback_query.from; the one-time code is shown in an edit", async () => {
  const { calls } = authMock();
  const res = await handle(req("/tg/pathsec", cbUpdate(`y:${NONCE}`), hdr), ENV, () => 1000);
  const body = (await res.json()) as Sent;
  expect(body.method).toBe("editMessageText");
  expect(body.chat_id).toBe(42);
  expect(body.message_id).toBe(7);
  expect(body.text).toContain("1234 5678");
  expect(body.text).toContain("auth.alxnko.dev in the browser YOU opened");
  expect(body.text).toContain("Never send it to anyone");
  expect(body.text).not.toContain("signed in");
  expect(calls(CONFIRM)).toHaveLength(1);
  expect(calls(DESCRIBE)).toHaveLength(0);
  const [url, opts] = calls(CONFIRM)[0] as unknown as [string, { body: string; headers: Record<string, string> }];
  expect(url).toBe(CONFIRM);
  expect(JSON.parse(opts.body)).toMatchObject({ nonce: NONCE, telegram_id: "42", username: "nekotg", display_name: "Neko", ts: "1000" });
  expect(opts.headers["X-Signature"]).toMatch(/^[0-9a-f]{64}$/);
});

test("callback Yes with no/odd code from the auth worker (legacy worker, expired, used, cancelled) → no code shown", async () => {
  for (const o of [{ confirm: { ok: true } }, { confirm: { ok: true, code: 12345678 } }, { confirm: { ok: true, code: "12ab5678" } }, { confirm: { error: "invalid_ticket" }, confirmStatus: 400 }, { confirm: { error: "already_consumed" }, confirmStatus: 409 }]) {
    authMock(o);
    const body = (await (await handle(req("/tg/pathsec", cbUpdate(`y:${NONCE}`), hdr), ENV, () => 1000)).json()) as Sent;
    expect(body.text).toContain("expired");
    expect(body.text).not.toMatch(/\d{4} \d{4}/);
  }
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
  expect(((await (await handle(req("/tg/pathsec", cbUpdate(`y:${NONCE}`), hdr), ENV, () => 1000)).json()) as Sent).text).toContain("expired");
});

test("callback from a different user than the prompt chat → 0 fetches, answered with a rejection", async () => {
  const { m } = authMock();
  // someone else (id 77) taps the button on the prompt that lives in chat 42
  const res = (await (await handle(req("/tg/pathsec", cbUpdate(`y:${NONCE}`, { from: { id: 77, username: "evil" } }), hdr), ENV)).json()) as Sent;
  expect(res).toMatchObject({ method: "answerCallbackQuery", callback_query_id: "cb1" });
  // prompt message in a non-private chat is also refused; so is a missing (inaccessible) message
  await handle(req("/tg/pathsec", cbUpdate(`y:${NONCE}`, { message: { message_id: 7, chat: { id: 42, type: "group" } } }), hdr), ENV);
  await handle(req("/tg/pathsec", cbUpdate(`y:${NONCE}`, { message: undefined }), hdr), ENV);
  expect(m).toHaveBeenCalledTimes(0);
});

test("callback Cancel → one signed cancel (never a confirm), message edited", async () => {
  const { calls } = authMock();
  const body = (await (await handle(req("/tg/pathsec", cbUpdate(`n:${NONCE}`), hdr), ENV, () => 1000)).json()) as Sent;
  expect(calls(CONFIRM)).toHaveLength(0);
  expect(calls(CANCEL)).toHaveLength(1);
  const [, opts] = calls(CANCEL)[0] as unknown as [string, { body: string; headers: Record<string, string> }];
  expect(JSON.parse(opts.body)).toEqual({ nonce: NONCE, telegram_id: "42", ts: "1000" });
  expect(opts.headers["X-Signature"]).toBe(await hmac(internalCancelString({ nonce: NONCE, telegramId: "42", ts: "1000" })));
  expect(body.method).toBe("editMessageText");
  expect(body.text).toContain("Cancelled");
  // cancel by a different user than the prompt → nothing sent
  const other = authMock();
  await handle(req("/tg/pathsec", cbUpdate(`n:${NONCE}`, { from: { id: 77 } }), hdr), ENV);
  expect(other.m).toHaveBeenCalledTimes(0);
});

test("malformed callback data fails closed → 0 fetches", async () => {
  const { m } = authMock();
  for (const data of ["", "y:", "y:short", "x:" + NONCE, NONCE, "y:" + "A".repeat(80), "y:bad nonce!!bad nonce!!", "yes", "n", "n:short"]) {
    const res = await handle(req("/tg/pathsec", cbUpdate(data), hdr), ENV);
    expect(res.status).toBe(200);
  }
  await handle(req("/tg/pathsec", { callback_query: { id: "x" } }, hdr), ENV);
  expect(m).toHaveBeenCalledTimes(0);
});

test("callback Yes uses the default clock and tolerates sparse 'from' fields", async () => {
  const { calls } = authMock();
  await handle(req("/tg/pathsec", cbUpdate(`y:${NONCE}`, { from: { id: 42 } }), hdr), ENV);
  const sent = JSON.parse((calls(CONFIRM)[0] as unknown as [string, { body: string }])[1].body);
  expect(sent).toMatchObject({ nonce: NONCE, telegram_id: "42", username: "", display_name: "" });
  expect(Number(sent.ts)).toBeGreaterThan(0);
});

test("a path with no secret segment → 404; empty path → 404", async () => {
  expect((await handle(req("/tg", {}, hdr), ENV)).status).toBe(404);
  expect((await handle(req("/", {}, hdr), ENV)).status).toBe(404);
});

test("unconfigured (no HMAC key / confirm URL) replies gracefully without crashing", async () => {
  const { m } = authMock();
  const unconf = { ...ENV, INTERNAL_HMAC_KEY: undefined, AUTH_CONFIRM_URL: undefined };
  const res = await handle(req("/tg/pathsec", startUpdate(), hdr), unconf, () => 1000);
  expect(((await res.json()) as { text: string }).text).toContain("isn’t configured");
  const cb = await handle(req("/tg/pathsec", cbUpdate(`y:${NONCE}`), hdr), unconf, () => 1000);
  expect(((await cb.json()) as Sent).text).toContain("isn’t configured");
  expect(m).toHaveBeenCalledTimes(0);
});

test("an update with no message replies with the prompt (no chat id)", async () => {
  const res = await handle(req("/tg/pathsec", {}, hdr), ENV);
  const body = (await res.json()) as { method: string; chat_id: number | null; text: string };
  expect(body.method).toBe("sendMessage");
  expect(body.text).toContain("Continue with Telegram");
});

test("non-start text prompts the user; malformed body → ok", async () => {
  const prompt = await handle(req("/tg/pathsec", { message: { text: "hi", chat: { id: 5 } } }, hdr), ENV);
  expect(((await prompt.json()) as { text: string }).text).toContain("Continue with Telegram");

  const bad = new Request("https://bot/tg/pathsec", { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "whsec" }, body: "{not json" });
  expect((await handle(bad, ENV)).status).toBe(200);
});

test("the confirm signature equals HMAC-SHA256 of the shared confirm string", async () => {
  const { calls } = authMock();
  await handle(req("/tg/pathsec", cbUpdate(`y:${NONCE}`, { from: { id: 42, username: "z", first_name: "A", last_name: "B" } }), hdr), ENV, () => 1234);
  const opts = (calls(CONFIRM)[0] as unknown as [string, { headers: Record<string, string> }])[1];
  expect(opts.headers["X-Signature"]).toBe(await hmac(internalConfirmString({ nonce: NONCE, telegramId: "42", username: "z", displayName: "A B", avatarUrl: "", ts: "1234" })));
});
