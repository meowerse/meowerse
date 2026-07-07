#!/usr/bin/env bash
# Deploy meowsenger: build the Astro UI, then deploy the ONE Worker that serves
# those static assets + the OIDC BFF on meowsenger.alxnko.eu.org. Source
# ../../.env first. Secret OIDC_CLIENT_SECRET is set once via `wrangler secret put`.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if git status --porcelain -- workers/meowsenger apps/meowsenger-web packages/auth-shared packages/auth-sdk | grep -q .; then
  [ "${ALLOW_DIRTY:-0}" = "1" ] || { echo "ERROR: uncommitted meowsenger changes. commit or ALLOW_DIRTY=1" >&2; exit 1; }
fi
ASTRO_TELEMETRY_DISABLED=1 bun run --filter @meowerse/meowsenger-web build
(cd workers/meowsenger && bunx wrangler deploy)
bash infra/record-deploy.sh meowsenger
