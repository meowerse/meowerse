#!/usr/bin/env bash
# Local build-and-deploy for the Go api — no GitHub required.
# Builds the Docker image, pushes to GHCR, and creates/updates the Northflank
# deployment service (pulls the public GHCR image). Run when Docker is up.
#
# Requires (source ../../.env first): NORTHFLANK_API_TOKEN, DATABASE_URL,
# DATABASE_AUTH_TOKEN, API_TOKEN, CORS_ORIGINS, and a GHCR login token
# (GHCR_TOKEN = a GitHub PAT with write:packages, or `gh auth token`).
set -euo pipefail

PROJECT="${NF_PROJECT:-alxnko}"
SERVICE="${NF_SERVICE:-meowerse-api}"
PLAN="${NF_PLAN:-nf-compute-20}"          # free Sandbox tier
GHCR_OWNER="${GHCR_OWNER:-meowerse}"   # image namespace (org or user)
GHCR_USER="${GHCR_USER:-alxnko}"        # github login used for docker login
IMAGE="ghcr.io/${GHCR_OWNER}/meowerse-api"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TAG="$(git -C "$ROOT" rev-parse --short HEAD)"
# Dirty guard: refuse to deploy uncommitted api source unless ALLOW_DIRTY=1.
if git -C "$ROOT" status --porcelain -- apps/api packages/go-shared go.work | grep -q .; then
  [ "${ALLOW_DIRTY:-0}" = "1" ] || { echo "ERROR: uncommitted api changes. commit first or set ALLOW_DIRTY=1." >&2; exit 1; }
  TAG="${TAG}-dirty"
fi
NF="https://api.northflank.com/v1"
auth=(-H "Authorization: Bearer ${NORTHFLANK_API_TOKEN:?set NORTHFLANK_API_TOKEN}" -H "Content-Type: application/json")

# 1. build (context = repo root so go.work + go-shared resolve)
docker build -f "$ROOT/apps/api/Dockerfile" -t "$IMAGE:$TAG" -t "$IMAGE:latest" "$ROOT"

# 2. push to GHCR (public package)
echo "${GHCR_TOKEN:?set GHCR_TOKEN (gh auth token)}" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
docker push "$IMAGE:$TAG"
docker push "$IMAGE:latest"

# 3. runtime env (secrets) — Turso + auth + CORS
runtime=$(python - <<PY
import json,os
print(json.dumps({
  "DATABASE_URL": os.environ["DATABASE_URL"],
  "DATABASE_AUTH_TOKEN": os.environ["DATABASE_AUTH_TOKEN"],
  "API_TOKEN": os.environ["API_TOKEN"],
  "CORS_ORIGINS": os.environ.get("CORS_ORIGINS","https://meow.alxnko.eu.org,http://localhost:4321"),
  "PORT": "8080",
}))
PY
)

body=$(python - "$SERVICE" "$PLAN" "$IMAGE:$TAG" "$runtime" <<'PY'
import json,sys
name,plan,image,runtime=sys.argv[1:5]
print(json.dumps({
  "name": name,
  "billing": {"deploymentPlan": plan},
  "deployment": {"type":"deployment","instances":1,"external":{"imagePath":image,"credentials":None}},
  "ports": [{"name":"http","internalPort":8080,"public":True,"protocol":"HTTP"}],
  "runtimeEnvironment": json.loads(runtime),
}))
PY
)

# 4. create if absent, else update image + env
if curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "$NF/projects/$PROJECT/services/$SERVICE" | grep -q 200; then
  echo "updating existing service $SERVICE -> $IMAGE:$TAG"
  curl -s "${auth[@]}" -X PATCH "$NF/projects/$PROJECT/services/$SERVICE/deployment" \
    -d "{\"external\":{\"imagePath\":\"$IMAGE:$TAG\",\"credentials\":null},\"runtimeEnvironment\":$runtime}" >/dev/null
else
  echo "creating service $SERVICE"
  curl -s "${auth[@]}" -X POST "$NF/projects/$PROJECT/services" -d "$body" \
    | python -c 'import sys,json;d=json.load(sys.stdin);print("created:",d.get("data",{}).get("id") or d.get("error"))'
fi
# 5. record what we deployed (version tracking)
"$ROOT/infra/record-deploy.sh" api "$TAG"
echo "done. set custom domain api.meow.alxnko.eu.org in Northflank, then CNAME it in Cloudflare."
