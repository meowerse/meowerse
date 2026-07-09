#!/usr/bin/env bash
# Build + deploy the Astro web app to Cloudflare Pages (direct upload) and
# record the deployed version. Reusable by `just deploy-web` and Terraform.
# Source ../../.env first (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID).
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if git status --porcelain -- apps/web packages/ts-shared | grep -q .; then
  [ "${ALLOW_DIRTY:-0}" = "1" ] || { echo "ERROR: uncommitted web changes. commit or ALLOW_DIRTY=1" >&2; exit 1; }
fi
ASTRO_TELEMETRY_DISABLED=1 bun run --filter @meowerse/web build
# --branch main is REQUIRED: the Pages project's PRODUCTION branch is "main", but this
# repo's default branch is "master". Without --branch, wrangler infers the branch from
# git ("master") and creates a PREVIEW deploy — production (meow.alxnko.eu.org) never
# updates. Pinning --branch main makes every deploy land on production.
bunx wrangler pages deploy apps/web/dist --project-name meowerse-web --branch main --commit-hash "$(git rev-parse HEAD)"
bash infra/record-deploy.sh web
