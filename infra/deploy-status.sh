#!/usr/bin/env bash
# Per service: last-deployed source SHA vs current source SHA → up-to-date /
# NEEDS DEPLOY / never-deployed, plus a dirty flag for uncommitted source.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
. "$root/infra/services.sh"
state="$root/infra/deploy-state.json"
[ -f "$state" ] || echo '{}' > "$state"

printf '%-8s %-10s %-10s %-6s %s\n' SERVICE DEPLOYED SOURCE DIRTY STATUS
for svc in api web worker; do
  src="$(service_source_sha "$root" "$svc")"
  dirty="$(service_dirty "$root" "$svc")"
  dep="$(python -c 'import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],{}).get("sha","none"))' "$state" "$svc")"
  if [ "$dep" = none ]; then status="never deployed"
  elif [ "$dep" = "$src" ] && [ "$dirty" = no ]; then status="up-to-date"
  else status="NEEDS DEPLOY"; fi
  printf '%-8s %-10s %-10s %-6s %s\n' "$svc" "$dep" "$src" "$dirty" "$status"
done
