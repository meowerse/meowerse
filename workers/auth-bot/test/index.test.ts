import { afterEach, test, expect, vi } from "vitest";
import worker, { handle } from "../src/index";
import { internalConfirmString } from "@meowerse/auth-shared";

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

test("valid /start forwards an HMAC-signed confirm and replies success", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const update = { message: { text: "/start NONCE123", chat: { id: 99 }, from: { id: 42, username: "nekotg", first_name: "Neko" } } };
  const res = await handle(req("/tg/pathsec", update, { "X-Telegram-Bot-Api-Secret-Token": "whsec" }), ENV, () => 1000);
  const body = (await res.json()) as { method: string; chat_id: number; text: string };
  expect(body.method).toBe("sendMessage");
  expect(body.chat_id).toBe(99);
  expect(body.text).toContain("Linked");

  const [url, opts] = fetchMock.mock.calls[0];
  expect(url).toBe("https://auth-api/internal/tg/confirm");
  const sent = JSON.parse(opts.body);
  expect(sent).toMatchObject({ nonce: "NONCE123", telegram_id: "42", username: "nekotg", display_name: "Neko", ts: "1000" });
  expect(opts.headers["X-Signature"]).toMatch(/^[0-9a-f]{64}$/);
});

test("upstream failure replies with the expired-link message", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no", { status: 400 })));
  const update = { message: { text: "/start N", chat: { id: 7 }, from: { id: 1 } } };
  const res = await handle(req("/tg/pathsec", update, { "X-Telegram-Bot-Api-Secret-Token": "whsec" }), ENV, () => 1000);
  expect(((await res.json()) as { text: string }).text).toContain("expired");
});

test("network error is caught and still replies", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
  const update = { message: { text: "/start N", chat: { id: 7 }, from: { id: 1 } } };
  const res = await handle(req("/tg/pathsec", update, { "X-Telegram-Bot-Api-Secret-Token": "whsec" }), ENV, () => 1000);
  expect(((await res.json()) as { text: string }).text).toContain("expired");
});

test("uses the default wall-clock when now is omitted; sparse 'from' fields default to empty", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  // no `now` arg (exercises the default clock), and a message with no `from`
  const update = { message: { text: "/start ONLYNONCE", chat: { id: 3 } } };
  const res = await handle(req("/tg/pathsec", update, { "X-Telegram-Bot-Api-Secret-Token": "whsec" }), ENV);
  expect(((await res.json()) as { text: string }).text).toContain("Linked");
  const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(sent).toMatchObject({ nonce: "ONLYNONCE", telegram_id: "", username: "", display_name: "" });
  expect(typeof Number(sent.ts)).toBe("number");
});

test("a path with no secret segment → 404; empty path → 404", async () => {
  expect((await handle(req("/tg", {}, { "X-Telegram-Bot-Api-Secret-Token": "whsec" }), ENV)).status).toBe(404);
  expect((await handle(req("/", {}, { "X-Telegram-Bot-Api-Secret-Token": "whsec" }), ENV)).status).toBe(404);
});

test("unconfigured (no HMAC key / confirm URL) replies gracefully without crashing", async () => {
  const update = { message: { text: "/start N", chat: { id: 1 }, from: { id: 1 } } };
  const res = await handle(req("/tg/pathsec", update, { "X-Telegram-Bot-Api-Secret-Token": "whsec" }), { ...ENV, INTERNAL_HMAC_KEY: undefined, AUTH_CONFIRM_URL: undefined }, () => 1000);
  expect(((await res.json()) as { text: string }).text).toContain("isn’t configured");
});

test("an update with no message replies with the prompt (no chat id)", async () => {
  const res = await handle(req("/tg/pathsec", {}, { "X-Telegram-Bot-Api-Secret-Token": "whsec" }), ENV);
  const body = (await res.json()) as { method: string; chat_id: number | null; text: string };
  expect(body.method).toBe("sendMessage");
  expect(body.text).toContain("Continue with Telegram");
});

test("non-start text prompts the user; malformed body → ok", async () => {
  const prompt = await handle(req("/tg/pathsec", { message: { text: "hi", chat: { id: 5 } } }, { "X-Telegram-Bot-Api-Secret-Token": "whsec" }), ENV);
  expect(((await prompt.json()) as { text: string }).text).toContain("Continue with Telegram");

  const bad = new Request("https://bot/tg/pathsec", { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "whsec" }, body: "{not json" });
  expect((await handle(bad, ENV)).status).toBe(200);
});

test("the signature equals HMAC-SHA256 of the shared confirm string", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const update = { message: { text: "/start NN", chat: { id: 1 }, from: { id: 8, username: "z", first_name: "A", last_name: "B" } } };
  await handle(req("/tg/pathsec", update, { "X-Telegram-Bot-Api-Secret-Token": "whsec" }), ENV, () => 1234);
  const opts = fetchMock.mock.calls[0][1];
  // recompute the expected HMAC with WebCrypto
  const enc = new TextEncoder();
  const msg = internalConfirmString({ nonce: "NN", telegramId: "8", username: "z", displayName: "A B", avatarUrl: "", ts: "1234" });
  const k = await crypto.subtle.importKey("raw", enc.encode("ikey"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  expect(opts.headers["X-Signature"]).toBe(hex);
});
