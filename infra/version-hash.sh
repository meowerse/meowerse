#!/usr/bin/env bash
# Terraform `external` data source program (one call per service).
# Reads {"paths": "<space-separated paths>"} on stdin, emits {"hash":"<sha>:<diffhash>"}.
# The hash changes when that service's committed source OR uncommitted diff
# changes, so a terraform_data trigger fires exactly when a redeploy is needed.
# git-based → respects .gitignore (skips node_modules/dist).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
paths="$(python -c 'import json,sys;print(json.load(sys.stdin)["paths"])')"
committed="$(git -C "$root" log -1 --format=%H -- $paths 2>/dev/null || echo none)"
dirty="$(git -C "$root" diff HEAD -- $paths 2>/dev/null | git hash-object --stdin 2>/dev/null || echo clean)"
printf '{"hash":"%s:%s"}\n' "$committed" "$dirty"
