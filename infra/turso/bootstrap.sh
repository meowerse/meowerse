#!/usr/bin/env bash
# Idempotent Turso provisioning via the Platform API (no CLI needed).
# Why not Terraform: the community Turso TF provider lags; the Platform API is
# stable and keeps state out of tfstate. Run once; re-running is safe.
#
# Requires TURSO_API_TOKEN in the environment (source ../../.env first).
# Appends DATABASE_URL + DATABASE_AUTH_TOKEN to ../../.env if missing.
set -euo pipefail

ORG="${TURSO_ORG:-alxnko}"
GROUP="${TURSO_GROUP:-default}"
LOC="${TURSO_LOCATION:-aws-eu-west-1}"   # Ireland — lowest measured latency from here (~125ms)
DB="${TURSO_DB:-meowerse-dev}"
API="https://api.turso.tech/v1/organizations/$ORG"
ENV_FILE="${ENV_FILE:-$(dirname "$0")/../../.env}"

: "${TURSO_API_TOKEN:?set TURSO_API_TOKEN (source your .env)}"
auth=(-H "Authorization: Bearer $TURSO_API_TOKEN" -H "Content-Type: application/json")

# group (ignore "already exists")
curl -s "${auth[@]}" -X POST "$API/groups" -d "{\"name\":\"$GROUP\",\"location\":\"$LOC\"}" >/dev/null || true
# database (ignore "already exists")
curl -s "${auth[@]}" -X POST "$API/databases" -d "{\"name\":\"$DB\",\"group\":\"$GROUP\"}" >/dev/null || true

host=$(curl -s "${auth[@]}" "$API/databases/$DB" \
  | python -c 'import sys,json;d=json.load(sys.stdin);db=d.get("database",d);print(db.get("Hostname") or db.get("hostname",""))')
[ -n "$host" ] || { echo "could not resolve db hostname" >&2; exit 1; }

jwt=$(curl -s "${auth[@]}" -X POST \
  "$API/databases/$DB/auth/tokens?expiration=never&authorization=full-access" \
  | python -c 'import sys,json;print(json.load(sys.stdin).get("jwt",""))')
[ -n "$jwt" ] || { echo "token mint failed" >&2; exit 1; }

grep -q "^DATABASE_URL=" "$ENV_FILE" 2>/dev/null || printf 'DATABASE_URL=libsql://%s\n' "$host" >> "$ENV_FILE"
grep -q "^DATABASE_AUTH_TOKEN=" "$ENV_FILE" 2>/dev/null || printf 'DATABASE_AUTH_TOKEN=%s\n' "$jwt" >> "$ENV_FILE"
echo "Turso ready: libsql://$host  (creds written to $ENV_FILE)"
