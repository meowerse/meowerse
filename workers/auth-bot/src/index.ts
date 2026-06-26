import { constantTimeEqual, internalConfirmString } from "@meowerse/auth-shared";

export interface Env {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  INTERNAL_HMAC_KEY?: string;
  PATH_SECRET?: string;
  AUTH_CONFIRM_URL?: string;
}

interface TgUpdate {
  message?: {
    text?: string;
    chat?: { id?: number };
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
 * header. On `/start <nonce>` it HMAC-signs the user's identity and forwards it
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
  const msg = update.message;
  const chatId = msg?.chat?.id;
  const m = /^\/start\s+(\S+)/.exec(msg?.text ?? "");
  if (!m) return reply(chatId, "Open the Meowerse auth page and tap “Continue with Telegram”.");
  if (!env.INTERNAL_HMAC_KEY || !env.AUTH_CONFIRM_URL) {
    return reply(chatId, "⚠️ Telegram linking isn’t configured yet. Please try again later.");
  }

  const from = msg?.from ?? {};
  const fields = {
    nonce: m[1] ?? "",
    telegramId: String(from.id ?? ""),
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
  return reply(chatId, ok ? "✅ Linked! Return to the page — you’re signed in." : "⚠️ That link expired. Start again from the auth page.");
}

// handle() is internally robust (it guards JSON parse + the outbound fetch and
// never throws on a well-formed Request), so the entrypoint forwards directly.
export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env);
  },
};
