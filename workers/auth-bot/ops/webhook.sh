#!/usr/bin/env bash
# Inspect / (re)point the Telegram webhook for the auth bot. No secrets live in this repo:
# everything comes from the environment (export them in your shell; never paste them into a file here).
#
#   TELEGRAM_BOT_TOKEN        bot token from @BotFather
#   TELEGRAM_WEBHOOK_SECRET   the same value as the worker's TELEGRAM_WEBHOOK_SECRET   (set only)
#   PATH_SECRET               the same value as the worker's PATH_SECRET                (set only)
#   BOT_HOST                  default authbot.alxnko.dev                                (set only)
#
#   ./webhook.sh info   # getWebhookInfo: check `allowed_updates` includes "callback_query" (empty list = all, also fine)
#   ./webhook.sh set    # setWebhook with allowed_updates=["message","callback_query"]
set -euo pipefail
: "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN}"
api="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"
case "${1:-}" in
  info)
    # Prints only the non-secret fields (the URL contains PATH_SECRET, so it is redacted).
    curl -fsS "$api/getWebhookInfo" | python3 -c '
import json, sys
r = json.load(sys.stdin)["result"]
r["url"] = "<redacted>" if r.get("url") else ""
print(json.dumps(r, indent=2))
ua = r.get("allowed_updates")
print("OK: callback_query delivered" if (not ua or "callback_query" in ua) else "FIX NEEDED: run `webhook.sh set` before deploying the bot")'
    ;;
  set)
    : "${TELEGRAM_WEBHOOK_SECRET:?}" "${PATH_SECRET:?}"
    host="${BOT_HOST:-authbot.alxnko.dev}"
    curl -fsS "$api/setWebhook" \
      --data-urlencode "url=https://${host}/tg/${PATH_SECRET}" \
      --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
      --data-urlencode 'allowed_updates=["message","callback_query"]' | python3 -c 'import json,sys; r=json.load(sys.stdin); print({"ok": r.get("ok"), "description": r.get("description")})'
    ;;
  *) echo "usage: $0 info|set" >&2; exit 2 ;;
esac
