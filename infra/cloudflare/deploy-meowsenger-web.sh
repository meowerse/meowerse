#!/usr/bin/env bash
# Build + deploy the meowsenger UI (Astro) as a Worker with static assets. Source
# ../../.env first.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if git status --porcelain -- apps/meowsenger-web | grep -q .; then
  [ "${ALLOW_DIRTY:-0}" = "1" ] || { echo "ERROR: uncommitted meowsenger-web changes. commit or ALLOW_DIRTY=1" >&2; exit 1; }
fi
ASTRO_TELEMETRY_DISABLED=1 bun run --filter @meowerse/meowsenger-web build
(cd apps/meowsenger-web && bunx wrangler deploy)
bash infra/record-deploy.sh meowsenger-web
