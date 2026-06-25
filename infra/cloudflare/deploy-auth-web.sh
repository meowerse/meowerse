#!/usr/bin/env bash
# Build + deploy the auth UI (Astro) to Cloudflare Pages and record the version.
# Reusable by `just deploy-auth-web` and Terraform. Source ../../.env first.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if git status --porcelain -- apps/auth-web | grep -q .; then
  [ "${ALLOW_DIRTY:-0}" = "1" ] || { echo "ERROR: uncommitted auth-web changes. commit or ALLOW_DIRTY=1" >&2; exit 1; }
fi
ASTRO_TELEMETRY_DISABLED=1 bun run --filter @meowerse/auth-web build
bunx wrangler pages deploy apps/auth-web/dist --project-name meowerse-auth-web --commit-hash "$(git rev-parse HEAD)"
bash infra/record-deploy.sh auth-web
