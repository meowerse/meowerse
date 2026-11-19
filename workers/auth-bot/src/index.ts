import { constantTimeEqual, internalConfirmString, internalDescribeString, internalCancelString } from "@meowerse/auth-shared";

export interface Env {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  INTERNAL_HMAC_KEY?: string;
  PATH_SECRET?: string;
  AUTH_CONFIRM_URL?: string;
}

interface TgUpdate {
  callback_query?: {
    id?: string;
    data?: string;
    from?: { id?: number; username?: string; first_name?: string; last_name?: string };
    message?: { message_id?: number; chat?: { id?: number; type?: string } };
  };
  message?: {
    text?: string;
    chat?: { id?: number; type?: string };
    from?: { id?: number; username?: string; first_name?: string; last_name?: string };
  };
}

const enc = new TextEncoder();

async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
  let s = "";
  for (const b of sig) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Reply by returning a Telegram method in the webhook body — no extra outbound call (free-tier friendly). */
function reply(chatId: number | undefined, text: string): Response {
  return new Response(JSON.stringify({ method: "sendMessage", chat_id: chatId, text }), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Telegram webhook handler (spec §6). Two constant-time gates: the PATH_SECRET in
 * the URL (`/tg/<secret>`) and Telegram's `X-Telegram-Bot-Api-Secret-Token`
 * header. On `/start <nonce>` it only asks the auth worker to describe the ticket and shows Yes/Cancel; on the Yes tap (callback_query) it HMAC-signs the user's identity and forwards it
 * to the auth worker's internal confirm endpoint, then tells the user the result.
 * `now` is injectable for deterministic tests.
 */
export async function handle(req: Request, env: Env, now: () => number = () => Math.floor(Date.now() / 1000)): Promise<Response> {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  if (parts[0] !== "tg" || !env.PATH_SECRET || !constantTimeEqual(parts[1] ?? "", env.PATH_SECRET)) {
    return new Response("not found", { status: 404 });
  }
  if (!env.TELEGRAM_WEBHOOK_SECRET || !constantTimeEqual(req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "", env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response("forbidden", { status: 403 });
  }

  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return new Response("ok");
  }
  if (update.callback_query) return handleCallback(update.callback_query, env, now);
  const msg = update.message;
  const chatId = msg?.chat?.id;
  const m = /^\/start\s+(\S+)/.exec(msg?.text ?? "");
  if (!m) return reply(chatId, "Open the Meowerse auth page and tap “Continue with Telegram”.");
  if (!env.INTERNAL_HMAC_KEY || !env.AUTH_CONFIRM_URL) {
    return reply(chatId, "⚠️ Telegram linking isn’t configured yet. Please try again later.");
  }
  // Only a private chat with the user themself may be prompted (the prompt is bound to this user).
  const fromId = msg?.from?.id;
  if (typeof chatId !== "number" || typeof fromId !== "number" || chatId !== fromId || !validNonce(m[1])) {
    return reply(chatId, "Open the Meowerse auth page and tap “Continue with Telegram”.");
  }

  // /start alone proves nothing (the deep link can be forwarded to anyone), so it never confirms. Ask the auth
  // worker what this ticket really is (signed, fail closed), show the user honestly, and wait for the Yes tap.
  const nonce = m[1]!;
  const d = await describe(env, nonce, String(fromId), now);
  if (!d) return reply(chatId, "⚠️ That link expired or is no longer valid. Start again from the auth page.");
  const what =
    d.kind === "link"
      ? "Someone wants to link this Telegram account to a Meowerse account."
      : d.kind === "signup"
        ? "Someone is creating a new Meowerse account using this Telegram account."
        : "Someone is signing in to Meowerse with this Telegram account.";
  const where = [d.country, d.browser && d.os ? `${d.browser} on ${d.os}` : "", d.age !== undefined ? `started ${ago(d.age)}` : ""].filter(Boolean).join(" · ");
  return new Response(
    JSON.stringify({
      method: "sendMessage",
      chat_id: chatId,
      text:
        `⚠️ ${what}\n\n${where}\n\n` +
        "If that is you, tap “Yes, it’s me”: you will receive a one-time code. Only enter it on auth.alxnko.dev in the browser YOU opened. Never send it to anyone. " +
        "If you didn’t start this, tap Cancel or ignore this message.",
      reply_markup: {
        inline_keyboard: [[
          { text: "Yes, it’s me", callback_data: `${YES}${nonce}` },
          { text: "Cancel", callback_data: `${NO}${nonce}` },
        ]],
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

const YES = "y:";
const NO = "n:";
/** Nonces are 24 random bytes base64url (32 chars); callback_data is capped at 64 bytes by Telegram. */
function validNonce(n: string | undefined): n is string {
  return !!n && /^[A-Za-z0-9_-]{16,60}$/.test(n);
}

function ago(sec: number): string {
  if (!Number.isFinite(sec) || sec < 60) return "just now";
  return `${Math.floor(sec / 60)} min ago`;
}

/** The auth worker's internal endpoints sit next to the confirm URL (…/internal/tg/{confirm,describe,cancel}). */
function internalUrl(env: Env, action: "describe" | "cancel"): string | null {
  const u = env.AUTH_CONFIRM_URL ?? "";
  return u.endsWith("/confirm") ? `${u.slice(0, -"/confirm".length)}/${action}` : null;
}

async function signedPost(url: string, key: string, signedString: string, body: Record<string, string>): Promise<Response | null> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature": await hmacHex(key, signedString) },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

const short = (v: unknown): string => (typeof v === "string" ? v.slice(0, 40) : "");

async function describe(env: Env, nonce: string, telegramId: string, now: () => number): Promise<{ kind: string; country: string; browser: string; os: string; age?: number } | null> {
  const url = internalUrl(env, "describe");
  if (!url || !env.INTERNAL_HMAC_KEY) return null;
  const ts = String(now());
  const res = await signedPost(url, env.INTERNAL_HMAC_KEY, internalDescribeString({ nonce, telegramId, ts }), { nonce, telegram_id: telegramId, ts });
  if (!res || !res.ok) return null;
  try {
    const j = (await res.json()) as Record<string, unknown>;
    if (j.kind !== "signin" && j.kind !== "signup" && j.kind !== "link") return null;
    return { kind: j.kind, country: short(j.country), browser: short(j.browser), os: short(j.os), age: typeof j.age === "number" ? j.age : undefined };
  } catch {
    return null;
  }
}

/** Webhook reply that rewrites the prompt message after a button tap. */
function editReply(chatId: number | undefined, messageId: number | undefined, text: string, replyMarkup?: unknown): Response {
  if (typeof chatId !== "number" || typeof messageId !== "number") return new Response("ok");
  // A webhook response can carry only ONE method, so we edit the prompt (no extra outbound call; the button spinner times out by itself).
  return new Response(JSON.stringify({ method: "editMessageText", chat_id: chatId, message_id: messageId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }), {
    headers: { "Content-Type": "application/json" },
  });
}

/** Short feedback for a REJECTED tap (the single webhook method is spent on the answer; nothing is edited or confirmed). */
function rejectTap(queryId: string | undefined, text: string): Response {
  if (!queryId) return new Response("ok");
  return new Response(JSON.stringify({ method: "answerCallbackQuery", callback_query_id: queryId, text, show_alert: true }), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleCallback(cb: NonNullable<TgUpdate["callback_query"]>, env: Env, now: () => number): Promise<Response> {
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const fromId = cb.from?.id;
  const data = cb.data ?? "";
  // Fail closed: the tapper must be the user the prompt was sent to (private chat id === user id), and the data well-formed.
  if (typeof fromId !== "number" || typeof chatId !== "number" || chatId !== fromId || cb.message?.chat?.type !== "private") {
    return rejectTap(cb.id, "This button isn’t for you.");
  }
  const isYes = data.startsWith(YES);
  const isNo = data.startsWith(NO);
  const nonce = data.slice(2);
  if ((!isYes && !isNo) || !validNonce(nonce)) return rejectTap(cb.id, "That action isn’t valid.");
  if (!env.INTERNAL_HMAC_KEY || !env.AUTH_CONFIRM_URL) {
    return editReply(chatId, messageId, "⚠️ Telegram linking isn’t configured yet. Please try again later.");
  }

  if (isNo) {
    const url = internalUrl(env, "cancel");
    const ts = String(now());
    const res = url ? await signedPost(url, env.INTERNAL_HMAC_KEY, internalCancelString({ nonce, telegramId: String(fromId), ts }), { nonce, telegram_id: String(fromId), ts }) : null;
    // Only reassure when the server really burned the ticket; otherwise the request may already have been used.
    if (res?.ok) return editReply(chatId, messageId, "Cancelled. Nothing was signed in or linked.");
    let used = false;
    try {
      used = ((await res?.json()) as { error?: unknown } | undefined)?.error === "already_used";
    } catch {
      used = false;
    }
    return editReply(
      chatId,
      messageId,
      used
        ? "⚠️ This request was already completed, so it could NOT be cancelled. If it wasn’t you, open auth.alxnko.dev → security now, sign out other sessions and unlink Telegram."
        : "This request already finished or expired. If it wasn’t you, open auth.alxnko.dev → security, sign out other sessions and unlink Telegram.",
    );
  }

  const from = cb.from ?? {};
  const fields = {
    nonce,
    telegramId: String(fromId),
    username: from.username ?? "",
    displayName: [from.first_name, from.last_name].filter(Boolean).join(" "),
    avatarUrl: "",
    ts: String(now()),
  };
  // The auth worker does NOT finalize on this call: it returns a one-time code that only the browser which started
  // the ticket can use. If it returns none (old worker, expired/used/cancelled ticket) we fail closed.
  const res = await signedPost(env.AUTH_CONFIRM_URL, env.INTERNAL_HMAC_KEY, internalConfirmString(fields), {
    nonce: fields.nonce,
    telegram_id: fields.telegramId,
    username: fields.username,
    display_name: fields.displayName,
    avatar_url: fields.avatarUrl,
    ts: fields.ts,
  });
  let code = "";
  if (res?.ok) {
    try {
      const c = ((await res.json()) as { code?: unknown }).code;
      if (typeof c === "string" && /^\d{8}$/.test(c)) code = c;
    } catch {
      code = "";
    }
  }
  if (!code) return editReply(chatId, messageId, "⚠️ That link expired. Start again from the auth page.");
  return editReply(
    chatId,
    messageId,
    `Your one-time code: ${code.slice(0, 4)} ${code.slice(4)}\n\nEnter it on auth.alxnko.dev in the browser YOU opened. Never send it to anyone — nobody legitimate will ask for it. It expires in a few minutes.`,
    // Keep a way out after "Yes": the owner can still burn the ticket from the code message (same n:<nonce> callback).
    { inline_keyboard: [[{ text: "That wasn’t me — cancel", callback_data: `${NO}${nonce}` }]] },
  );
}

// handle() is internally robust (it guards JSON parse + the outbound fetch and
// never throws on a well-formed Request), so the entrypoint forwards directly.
export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env);
  },
};
