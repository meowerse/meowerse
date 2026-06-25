#!/usr/bin/env bash
# Deploy the edge worker via wrangler and record the deployed version.
# Reusable by `just deploy-worker` and Terraform.
# Source ../../.env first (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID).
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if git status --porcelain -- workers/edge | grep -q .; then
  [ "${ALLOW_DIRTY:-0}" = "1" ] || { echo "ERROR: uncommitted worker changes. commit or ALLOW_DIRTY=1" >&2; exit 1; }
fi
(cd workers/edge && bunx wrangler deploy --message "$(git rev-parse --short HEAD)")
bash infra/record-deploy.sh worker "$(git rev-parse --short HEAD)"
