import { constantTimeEqual, internalConfirmString, tgMatchCode } from "@meowerse/auth-shared";

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
 * header. On `/start <nonce>` it only shows a match code + Yes/Cancel buttons; on the Yes tap (callback_query) it HMAC-signs the user's identity and forwards it
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

  // Do NOT confirm here: /start alone proves nothing (the deep link can be forwarded to anyone). Ask the
  // user to compare a code with the page THEY opened, and confirm only on the button tap.
  const nonce = m[1]!;
  const code = await tgMatchCode(env.INTERNAL_HMAC_KEY, nonce);
  return new Response(
    JSON.stringify({
      method: "sendMessage",
      chat_id: chatId,
      text:
        `⚠️ Someone is signing in to Meowerse with this Telegram account.\n\nCode: ${code}\n\n` +
        "Only continue if this code matches the one on the page YOU opened. If you didn’t start this, ignore this message or tap Cancel.",
      reply_markup: {
        inline_keyboard: [[
          { text: "Yes, it’s me", callback_data: `${YES}${nonce}` },
          { text: "Cancel", callback_data: NO },
        ]],
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

const YES = "y:";
const NO = "n";
/** Nonces are 24 random bytes base64url (32 chars); callback_data is capped at 64 bytes by Telegram. */
function validNonce(n: string | undefined): n is string {
  return !!n && /^[A-Za-z0-9_-]{16,60}$/.test(n);
}

/** Webhook reply that rewrites the prompt message after the button tap. */
function editReply(chatId: number | undefined, messageId: number | undefined, text: string): Response {
  if (typeof chatId !== "number" || typeof messageId !== "number") return new Response("ok");
  // A webhook response can carry only ONE method, so we edit the prompt (no extra outbound call; the button spinner times out by itself).
  return new Response(JSON.stringify({ method: "editMessageText", chat_id: chatId, message_id: messageId, text }), {
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
    return new Response("ok");
  }
  if (data === NO) return editReply(chatId, messageId, "Cancelled. Nothing was signed in.");
  if (!data.startsWith(YES) || !validNonce(data.slice(YES.length))) return new Response("ok");
  if (!env.INTERNAL_HMAC_KEY || !env.AUTH_CONFIRM_URL) {
    return editReply(chatId, messageId, "⚠️ Telegram linking isn’t configured yet. Please try again later.");
  }

  const from = cb.from ?? {};
  const fields = {
    nonce: data.slice(YES.length),
    telegramId: String(fromId),
    username: from.username ?? "",
    displayName: [from.first_name, from.last_name].filter(Boolean).join(" "),
    avatarUrl: "",
    ts: String(now()),
  };
  const sig = await hmacHex(env.INTERNAL_HMAC_KEY, internalConfirmString(fields));

  let ok = false;
  try {
    const res = await fetch(env.AUTH_CONFIRM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature": sig },
      body: JSON.stringify({
        nonce: fields.nonce,
        telegram_id: fields.telegramId,
        username: fields.username,
        display_name: fields.displayName,
        avatar_url: fields.avatarUrl,
        ts: fields.ts,
      }),
    });
    ok = res.ok;
  } catch {
    ok = false;
  }
  return editReply(chatId, messageId, ok ? "✅ Linked! Return to the page — you’re signed in." : "⚠️ That link expired. Start again from the auth page.");
}

// handle() is internally robust (it guards JSON parse + the outbound fetch and
// never throws on a well-formed Request), so the entrypoint forwards directly.
export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env);
  },
};
