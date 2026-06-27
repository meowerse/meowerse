#!/usr/bin/env bash
# Build + deploy the auth UI (Astro) as a Cloudflare Worker with static assets
# (apps/auth-web/wrangler.jsonc) on auth.alxnko.eu.org, and record the version.
# Uses the Worker deploy path (reliable) rather than Pages direct-upload.
# Reusable by `just deploy-auth-web` and Terraform. Source ../../.env first.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if git status --porcelain -- apps/auth-web | grep -q .; then
  [ "${ALLOW_DIRTY:-0}" = "1" ] || { echo "ERROR: uncommitted auth-web changes. commit or ALLOW_DIRTY=1" >&2; exit 1; }
fi
ASTRO_TELEMETRY_DISABLED=1 bun run --filter @meowerse/auth-web build
(cd apps/auth-web && bunx wrangler deploy)
bash infra/record-deploy.sh auth-web
