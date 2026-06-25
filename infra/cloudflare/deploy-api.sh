#!/usr/bin/env bash
# Deploy the api (Cloudflare Worker) via wrangler and record the version.
# Reusable by `just deploy-api` and Terraform. Source ../../.env first
# (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID). Worker secrets
# (DATABASE_URL, DATABASE_AUTH_TOKEN, API_TOKEN) are set once via
# `wrangler secret put` — see workers/api/README.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if git status --porcelain -- workers/api packages/ts-shared | grep -q .; then
  [ "${ALLOW_DIRTY:-0}" = "1" ] || { echo "ERROR: uncommitted api changes. commit or ALLOW_DIRTY=1" >&2; exit 1; }
fi
(cd workers/api && bunx wrangler deploy)
bash infra/record-deploy.sh api
