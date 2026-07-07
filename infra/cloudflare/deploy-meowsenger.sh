#!/usr/bin/env bash
# Deploy the meowsenger Worker via wrangler + record version. Source ../../.env
# first. Secret OIDC_CLIENT_SECRET is set once via `wrangler secret put`.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if git status --porcelain -- workers/meowsenger packages/auth-shared packages/auth-sdk | grep -q .; then
  [ "${ALLOW_DIRTY:-0}" = "1" ] || { echo "ERROR: uncommitted meowsenger changes. commit or ALLOW_DIRTY=1" >&2; exit 1; }
fi
(cd workers/meowsenger && bunx wrangler deploy)
bash infra/record-deploy.sh meowsenger
