#!/usr/bin/env bash
# Build + deploy the alxnko.dev personal site to Cloudflare Pages (direct upload)
# and record the deployed version.
# Source ../../.env first (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID).
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if git status --porcelain -- apps/alxnko-dev | grep -q .; then
  [ "${ALLOW_DIRTY:-0}" = "1" ] || { echo "ERROR: uncommitted alxnko-dev changes. commit or ALLOW_DIRTY=1" >&2; exit 1; }
fi
ASTRO_TELEMETRY_DISABLED=1 bun run --filter @alxnko/web build
bunx wrangler pages deploy apps/alxnko-dev/dist --project-name alxnko-dev --branch main --commit-hash "$(git rev-parse HEAD)"
echo "Deployed alxnko.dev to Cloudflare Pages"
