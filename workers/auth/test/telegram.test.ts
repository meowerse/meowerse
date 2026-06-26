import { test, expect } from "vitest";
import {
  verifyLoginWidget,
  verifyInternalConfirm,
  internalConfirmString,
  findAccountByTelegram,
  signInOrSignUpTelegram,
  linkTelegramToAccount,
  createTicket,
  findPendingTicketByNonce,
  consumeTicket,
  getTicket,
} from "../src/telegram";
import { hmacSha256Hex } from "../src/crypto";
import { routedDb, type Route } from "./helpers";

const enc = new TextEncoder();
const BOT = "123456:bottoken";

async function signWidget(data: Record<string, string>): Promise<string> {
  const dcs = Object.keys(data).filter((k) => k !== "hash").sort().map((k) => `${k}=${data[k]}`).join("\n");
  const secret = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(BOT)));
  const k = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(dcs)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("verifyLoginWidget accepts a correctly-signed fresh payload, rejects tamper/stale/missing", async () => {
  const data: Record<string, string> = { id: "42", first_name: "Neko", username: "nekotg", auth_date: "1000", photo_url: "http://img/x" };
  data.hash = await signWidget(data);
  const ok = await verifyLoginWidget(data, BOT, 1010);
  expect(ok.ok).toBe(true);
  expect(ok.telegram).toMatchObject({ telegramId: "42", username: "nekotg", displayName: "Neko" });

  expect((await verifyLoginWidget({ ...data, hash: "deadbeef" }, BOT, 1010)).ok).toBe(false); // tamper
  expect((await verifyLoginWidget(data, BOT, 9999)).ok).toBe(false); // stale auth_date
  expect((await verifyLoginWidget({ id: "42", auth_date: "1000" }, BOT, 1010)).ok).toBe(false); // no hash
});

test("verifyLoginWidget on a minimal payload yields null optional fields", async () => {
  const data: Record<string, string> = { id: "5", auth_date: "1000" };
  data.hash = await signWidget(data);
  const r = await verifyLoginWidget(data, BOT, 1000);
  expect(r.ok).toBe(true);
  expect(r.telegram).toEqual({ telegramId: "5", username: null, displayName: null, avatarUrl: null });
});

test("verifyLoginWidget rejects a non-numeric auth_date", async () => {
  const data: Record<string, string> = { id: "1", auth_date: "notanumber" };
  data.hash = await signWidget(data);
  expect((await verifyLoginWidget(data, BOT, 1000)).ok).toBe(false);
});

test("verifyInternalConfirm rejects a missing/non-numeric ts before checking HMAC", async () => {
  expect(await verifyInternalConfirm({ nonce: "n" }, "anything", "k", 1000)).toBe(false);
});

test("verifyInternalConfirm checks HMAC + ts freshness", async () => {
  const body = { nonce: "n", telegram_id: "42", username: "nekotg", display_name: "Neko", avatar_url: "", ts: "1000" };
  const sig = await hmacSha256Hex("ikey", internalConfirmString({ nonce: "n", telegramId: "42", username: "nekotg", displayName: "Neko", avatarUrl: "", ts: "1000" }));
  expect(await verifyInternalConfirm(body, sig, "ikey", 1010)).toBe(true);
  expect(await verifyInternalConfirm(body, "bad", "ikey", 1010)).toBe(false);
  expect(await verifyInternalConfirm(body, sig, "ikey", 99999)).toBe(false); // stale ts
});

test("findAccountByTelegram + signInOrSignUp create vs reuse", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  // existing link
  const existing = routedDb([[/SELECT account_id FROM telegram_links WHERE telegram_id/, () => ({ rows: [{ account_id: "acct_1" }] })]], log);
  expect(await findAccountByTelegram(existing, "42")).toBe("acct_1");
  const reuse = await signInOrSignUpTelegram(existing, { telegramId: "42", username: "u", displayName: "N", avatarUrl: null });
  expect(reuse).toEqual({ accountId: "acct_1", created: false });
  expect(log.some((c) => c.sql.includes("UPDATE telegram_links SET telegram_username"))).toBe(true);

  // no existing → create verified account + link
  const log2: { sql: string; args: unknown[] }[] = [];
  const fresh = routedDb([[/SELECT account_id FROM telegram_links WHERE telegram_id/, () => ({ rows: [] })]], log2);
  const created = await signInOrSignUpTelegram(fresh, { telegramId: "99", username: "x", displayName: "X", avatarUrl: null });
  expect(created.created).toBe(true);
  expect(created.accountId.startsWith("acct_")).toBe(true);
  expect(log2.some((c) => c.sql.includes("INSERT INTO accounts"))).toBe(true);
  expect(log2.some((c) => c.sql.includes("INSERT INTO telegram_links") && c.args[0] === "99")).toBe(true);
});

test("linkTelegramToAccount: new link sets verified, same is idempotent, elsewhere refused", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const none = routedDb([[/SELECT account_id FROM telegram_links/, () => ({ rows: [] })]], log);
  expect(await linkTelegramToAccount(none, "acct_1", { telegramId: "42", username: "u", displayName: "N", avatarUrl: null })).toEqual({ ok: true });
  expect(log.some((c) => c.sql.includes("UPDATE accounts SET verified = 1"))).toBe(true);

  const same = routedDb([[/SELECT account_id FROM telegram_links/, () => ({ rows: [{ account_id: "acct_1" }] })]]);
  expect(await linkTelegramToAccount(same, "acct_1", { telegramId: "42", username: "u", displayName: "N", avatarUrl: null })).toEqual({ ok: true });

  const elsewhere = routedDb([[/SELECT account_id FROM telegram_links/, () => ({ rows: [{ account_id: "acct_other" }] })]]);
  expect(await linkTelegramToAccount(elsewhere, "acct_1", { telegramId: "42", username: "u", displayName: "N", avatarUrl: null })).toEqual({ ok: false, error: "linked_elsewhere" });
});

test("tickets: create, find-pending (status/expiry), consume race, get", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const t = await createTicket(routedDb([], log), { kind: "SIGNIN_OR_SIGNUP", ownerHash: "oh", now: 1000 });
  expect(t.ticketId.startsWith("tkt_")).toBe(true);
  expect(t.nonce.length).toBeGreaterThan(0);

  const pending: Route = [/SELECT \* FROM login_tickets WHERE nonce_hash/, () => ({ rows: [{ ticket_id: "tkt_1", status: "pending", expires_at: 9_999_999_999, kind: "SIGNIN_OR_SIGNUP", account_id: null, rid: null, owner_hash: "oh" }] })];
  expect(await findPendingTicketByNonce(routedDb([pending]), "nonce", 1000)).not.toBeNull();
  expect(await findPendingTicketByNonce(routedDb([[/login_tickets WHERE nonce_hash/, () => ({ rows: [{ status: "consumed", expires_at: 9e9 }] })]]), "n", 1000)).toBeNull();
  expect(await findPendingTicketByNonce(routedDb([[/login_tickets WHERE nonce_hash/, () => ({ rows: [{ status: "pending", expires_at: 5 }] })]]), "n", 1000)).toBeNull();

  expect(await consumeTicket(routedDb([[/UPDATE login_tickets SET status/, () => ({ rows: [], rowsAffected: 1 })]]), "tkt_1", "acct_1")).toBe(true);
  expect(await consumeTicket(routedDb([[/UPDATE login_tickets SET status/, () => ({ rows: [], rowsAffected: 0 })]]), "tkt_1", "acct_1")).toBe(false);

  expect(await getTicket(routedDb([[/SELECT \* FROM login_tickets WHERE ticket_id/, () => ({ rows: [{ ticket_id: "tkt_1", status: "consumed", account_id: "acct_1", owner_hash: "oh", kind: "SIGNIN_OR_SIGNUP", rid: null }] })]]), "tkt_1")).toMatchObject({ status: "consumed" });
  expect(await getTicket(routedDb([]), "missing")).toBeNull();
});
