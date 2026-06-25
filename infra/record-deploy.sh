#!/usr/bin/env bash
# Record a deploy: record-deploy.sh <service> <sha-tag>
# Updates infra/deploy-state.json with {service: {sha, at}}. Commit it for an
# auditable deploy history. `at` is passed in (CI) or "local".
set -euo pipefail
svc="${1:?service}"; sha="${2:?sha}"; at="${3:-local}"
root="$(cd "$(dirname "$0")/.." && pwd)"
f="$root/infra/deploy-state.json"
[ -f "$f" ] || echo '{}' > "$f"
python - "$f" "$svc" "$sha" "$at" <<'PY'
import json,sys
f,svc,sha,at=sys.argv[1:5]
d=json.load(open(f))
d[svc]={"sha":sha,"at":at}
json.dump(d,open(f,"w"),indent=2,sort_keys=True)
open(f,"a").write("\n")
PY
echo "recorded $svc=$sha"
