#!/usr/bin/env bash
# Deploy auth: build the Astro UI, then deploy the ONE Worker that serves those
# static assets + the OIDC identity provider on auth.alxnko.eu.org. Source
# ../../.env first (CLOUDFLARE_*). Worker secrets (DATABASE_URL,
# DATABASE_AUTH_TOKEN, AUTH_SIGNING_KEYS, STATE_SECRET) are set once via
# `wrangler secret put` — see workers/auth/README.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if git status --porcelain -- workers/auth apps/auth-web packages/auth-shared | grep -q .; then
  [ "${ALLOW_DIRTY:-0}" = "1" ] || { echo "ERROR: uncommitted auth changes. commit or ALLOW_DIRTY=1" >&2; exit 1; }
fi
ASTRO_TELEMETRY_DISABLED=1 bun run --filter @meowerse/auth-web build
(cd workers/auth && bunx wrangler deploy)
bash infra/record-deploy.sh auth
