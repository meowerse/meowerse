# infra/turso

Turso (libSQL) is provisioned via the Platform API, not Terraform (the community
TF provider lags; the API is stable and keeps DB creds out of tfstate).

- `bootstrap.sh` — idempotent: creates group + database + a full-access token,
  writes `DATABASE_URL` + `DATABASE_AUTH_TOKEN` to the repo `.env`.

## Current
- org `alxnko`, group `default`, db `meowerse-dev`
- location **aws-eu-west-1 (Ireland)** — chosen by measured latency (~125ms),
  not geography (Mumbai was ~213ms).

## Run
```bash
set -a; source ../../.env; set +a   # needs TURSO_API_TOKEN
./bootstrap.sh
```
