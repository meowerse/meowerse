#!/usr/bin/env bash
# Record a deploy: record-deploy.sh <service> [at]
# Stores the service's SOURCE sha (last commit touching its paths) in
# infra/deploy-state.json, so deploy-status can compare deployed-source vs
# current-source. Commit the file for an auditable deploy history.
set -euo pipefail
svc="${1:?service}"; at="${2:-local}"
root="$(cd "$(dirname "$0")/.." && pwd)"
. "$root/infra/services.sh"
sha="$(service_source_sha "$root" "$svc")"
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
