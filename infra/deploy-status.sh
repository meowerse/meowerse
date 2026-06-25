#!/usr/bin/env bash
# Show, per service: last-deployed SHA vs latest source SHA → up-to-date /
# NEEDS DEPLOY / never-deployed, plus a dirty flag for uncommitted source.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
state="$root/infra/deploy-state.json"
[ -f "$state" ] || echo '{}' > "$state"

# service : source paths that, when changed, require a redeploy
declare -A PATHS=(
  [api]="apps/api packages/go-shared go.work"
  [web]="apps/web packages/ts-shared"
  [worker]="workers/edge"
)

printf '%-8s %-12s %-12s %-6s %s\n' SERVICE DEPLOYED SOURCE DIRTY STATUS
for svc in api web worker; do
  paths="${PATHS[$svc]}"
  src="$(git -C "$root" log -1 --format=%h -- $paths 2>/dev/null || echo none)"
  dep="$(python -c 'import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],{}).get("sha","none"))' "$state" "$svc")"
  dirty=no
  git -C "$root" status --porcelain -- $paths | grep -q . && dirty=YES
  # strip any -dirty suffix when comparing to a clean source sha
  depclean="${dep%-dirty}"
  if [ "$dep" = none ]; then status="never deployed"
  elif [ "$depclean" = "$src" ] && [ "$dirty" = no ]; then status="up-to-date"
  else status="NEEDS DEPLOY"; fi
  printf '%-8s %-12s %-12s %-6s %s\n' "$svc" "$dep" "$src" "$dirty" "$status"
done
