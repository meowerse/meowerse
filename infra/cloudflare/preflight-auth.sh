#!/usr/bin/env bash
# Preflight for the auth Worker deploy: STATE_SECRET MUST already exist as a Worker secret (the Worker fails
# closed without it, so deploying first would take the IdP down). Lists secret NAMES only (never values) and
# prints nothing but a verdict. WRANGLER_CMD overrides the command (tests).
set -euo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)/workers/auth"
wrangler_cmd="${WRANGLER_CMD:-bunx wrangler}"
if ! out="$($wrangler_cmd secret list 2>/dev/null)"; then
  echo "ERROR: could not list Worker secrets (wrangler secret list failed); refusing to deploy." >&2
  exit 1
fi
if ! printf '%s' "$out" | grep -Eq '"name"[[:space:]]*:[[:space:]]*"STATE_SECRET"'; then
  echo "ERROR: Worker secret STATE_SECRET is not set. Set it first: (cd workers/auth && bunx wrangler secret put STATE_SECRET)" >&2
  exit 1
fi
echo "preflight ok: STATE_SECRET is set"
