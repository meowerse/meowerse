import { afterEach, test, expect, vi } from "vitest";
import worker, { handle } from "../src/index";
import { internalConfirmString, tgMatchCode } from "@meowerse/auth-shared";

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
type Sent = { method: string; chat_id: number; text: string; message_id?: number; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } };

test("/start <nonce> shows the match code + Yes/Cancel and does NOT confirm", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const res = await handle(req("/tg/pathsec", startUpdate(), hdr), ENV, () => 1000);
  const body = (await res.json()) as Sent;
  expect(fetchMock).toHaveBeenCalledTimes(0);
  expect(body.method).toBe("sendMessage");
  expect(body.chat_id).toBe(42);
  const code = await tgMatchCode("ikey", NONCE);
  expect(body.text).toContain(`Code: ${code}`);
  expect(body.text).toContain("YOU opened");
  expect(body.text).not.toContain("Linked");
  const [yes, no] = body.reply_markup!.inline_keyboard[0]!;
  expect(yes!.callback_data).toBe(`y:${NONCE}`);
  expect(new TextEncoder().encode(yes!.callback_data).length).toBeLessThanOrEqual(64);
  expect(no!.callback_data).toBe("n");
});

test("/start in a chat that is not the user's private chat, or with a malformed nonce, is not prompted", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const group = { message: { text: `/start ${NONCE}`, chat: { id: -100, type: "group" }, from: { id: 42 } } };
  const r1 = (await (await handle(req("/tg/pathsec", group, hdr), ENV)).json()) as Sent;
  expect(r1.reply_markup).toBeUndefined();
  const r2 = (await (await handle(req("/tg/pathsec", startUpdate("short"), hdr), ENV)).json()) as Sent;
  expect(r2.reply_markup).toBeUndefined();
  expect(fetchMock).toHaveBeenCalledTimes(0);
});

test("callback Yes forwards ONE HMAC-signed confirm with the identity from callback_query.from, then edits the message", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const res = await handle(req("/tg/pathsec", cbUpdate(`y:${NONCE}`), hdr), ENV, () => 1000);
  const body = (await res.json()) as Sent;
  expect(body.method).toBe("editMessageText");
  expect(body.chat_id).toBe(42);
  expect(body.message_id).toBe(7);
  expect(body.text).toContain("Linked");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, opts] = fetchMock.mock.calls[0];
  expect(url).toBe("https://auth-api/internal/tg/confirm");
  expect(JSON.parse(opts.body)).toMatchObject({ nonce: NONCE, telegram_id: "42", username: "nekotg", display_name: "Neko", ts: "1000" });
  expect(opts.headers["X-Signature"]).toMatch(/^[0-9a-f]{64}$/);
});

test("callback from a different user than the prompt chat → no confirm", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  // someone else (id 77) taps the button on the prompt that lives in chat 42
  const res = await handle(req("/tg/pathsec", cbUpdate(`y:${NONCE}`, { from: { id: 77, username: "evil" } }), hdr), ENV);
  expect(res.status).toBe(200);
  expect(fetchMock).toHaveBeenCalledTimes(0);
  // prompt message in a non-private chat is also refused
  await handle(req("/tg/pathsec", cbUpdate(`y:${NONCE}`, { message: { message_id: 7, chat: { id: 42, type: "group" } } }), hdr), ENV);
  // missing message (inaccessible) is refused
  await handle(req("/tg/pathsec", cbUpdate(`y:${NONCE}`, { message: undefined }), hdr), ENV);
  expect(fetchMock).toHaveBeenCalledTimes(0);
});

test("callback Cancel → no confirm, message edited", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const body = (await (await handle(req("/tg/pathsec", cbUpdate("n"), hdr), ENV)).json()) as Sent;
  expect(fetchMock).toHaveBeenCalledTimes(0);
  expect(body.method).toBe("editMessageText");
  expect(body.text).toContain("Cancelled");
});

test("malformed callback data fails closed → no confirm", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  for (const data of ["", "y:", "y:short", "x:" + NONCE, NONCE, "y:" + "A".repeat(80), "y:bad nonce!!bad nonce!!", "yes"]) {
    const res = await handle(req("/tg/pathsec", cbUpdate(data), hdr), ENV);
    expect(res.status).toBe(200);
  }
  await handle(req("/tg/pathsec", { callback_query: { id: "x" } }, hdr), ENV);
  expect(fetchMock).toHaveBeenCalledTimes(0);
});

test("callback Yes with upstream failure / network error edits to the expired message", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no", { status: 400 })));
  expect(((await (await handle(req("/tg/pathsec", cbUpdate(`y:${NONCE}`), hdr), ENV, () => 1000)).json()) as Sent).text).toContain("expired");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
  expect(((await (await handle(req("/tg/pathsec", cbUpdate(`y:${NONCE}`), hdr), ENV, () => 1000)).json()) as Sent).text).toContain("expired");
});

test("callback Yes uses the default clock and tolerates sparse 'from' fields", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await handle(req("/tg/pathsec", cbUpdate(`y:${NONCE}`, { from: { id: 42 } }), hdr), ENV);
  const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(sent).toMatchObject({ nonce: NONCE, telegram_id: "42", username: "", display_name: "" });
  expect(typeof Number(sent.ts)).toBe("number");
});

test("a path with no secret segment → 404; empty path → 404", async () => {
  expect((await handle(req("/tg", {}, { "X-Telegram-Bot-Api-Secret-Token": "whsec" }), ENV)).status).toBe(404);
  expect((await handle(req("/", {}, { "X-Telegram-Bot-Api-Secret-Token": "whsec" }), ENV)).status).toBe(404);
});

test("unconfigured (no HMAC key / confirm URL) replies gracefully without crashing", async () => {
  const unconf = { ...ENV, INTERNAL_HMAC_KEY: undefined, AUTH_CONFIRM_URL: undefined };
  const res = await handle(req("/tg/pathsec", startUpdate(), hdr), unconf, () => 1000);
  expect(((await res.json()) as { text: string }).text).toContain("isn’t configured");
  const cb = await handle(req("/tg/pathsec", cbUpdate(`y:${NONCE}`), hdr), unconf, () => 1000);
  expect(((await cb.json()) as Sent).text).toContain("isn’t configured");
});

test("the signature equals HMAC-SHA256 of the shared confirm string", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const update = cbUpdate(`y:${NONCE}`, { from: { id: 42, username: "z", first_name: "A", last_name: "B" } });
  await handle(req("/tg/pathsec", update, hdr), ENV, () => 1234);
  const opts = fetchMock.mock.calls[0][1];
  // recompute the expected HMAC with WebCrypto
  const enc = new TextEncoder();
  const msg = internalConfirmString({ nonce: NONCE, telegramId: "42", username: "z", displayName: "A B", avatarUrl: "", ts: "1234" });
  const k = await crypto.subtle.importKey("raw", enc.encode("ikey"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  expect(opts.headers["X-Signature"]).toBe(hex);
});
