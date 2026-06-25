# infra/northflank

Hosts the Go API (`apps/api`) on the Northflank Sandbox (always-on free) tier.
Northflank has no first-class Terraform provider; managed via its API / GitOps.

## Planned (deploy step)
- `service.json` — service spec: build from `apps/api/Dockerfile` (context = repo
  root), port 8080, health check `/healthz`.
- `deploy.sh` — calls the Northflank API with `NORTHFLANK_API_TOKEN` to create/update
  the service and push secrets: `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `API_TOKEN`,
  `CORS_ORIGINS=https://meow.alxnko.eu.org`.
- Custom domain `api.meow.alxnko.eu.org` → CNAME to the Northflank service host
  (CNAME created in `../cloudflare/dns.tf`).

## Secrets
- `NORTHFLANK_API_TOKEN` (in `.env`) — used by `deploy.sh` and the GitHub deploy workflow.
