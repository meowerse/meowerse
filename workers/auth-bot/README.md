# meowerse-auth-bot

Telegram webhook worker for "Continue with Telegram". See `wrangler.jsonc` for secrets and routing.

## Flow (two-step, code-confirmed)

1. `/start <nonce>`: the bot asks the auth worker (`/internal/tg/describe`, HMAC-signed) what the ticket is and shows
   the user an honest prompt (sign in / create account / link, plus country, browser and age) with Yes / Cancel.
   It confirms nothing.
2. **Yes** -> signed `/internal/tg/confirm`: the auth worker returns a one-time code, which the bot shows in Telegram.
   **Cancel** -> signed `/internal/tg/cancel` (burns the ticket).
3. Only the browser that started the ticket can complete it, by typing the code on auth.alxnko.dev (`/tg/verify`).

## Rollout order (the bot is live)

1. Apply the one-shot `login_ticket_ctx` table (see the PROD ONE-SHOT comment in `workers/auth/src/db.ts`).
2. Deploy the **auth worker** and **auth-web**. From this moment the old bot's immediate-confirm can no longer
   sign anyone in (it never shows a code), so Telegram login is briefly broken until step 4: that is intended.
3. `ops/webhook.sh info`; if it says FIX NEEDED, run `ops/webhook.sh set` (the new bot needs `callback_query` updates).
4. Deploy the **bot** (no new secrets/vars; it derives the describe/cancel URLs from `AUTH_CONFIRM_URL`).

Deploying the bot before the auth worker is safe (describe 404s, the bot fails closed with "link expired") but
Telegram login is down until the auth worker ships.
