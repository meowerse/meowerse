# infra

Infrastructure as code, organized by provider — each folder owns the right tool
for that service.

```
infra/
  cloudflare/   # Terraform (zone, DNS, Pages, R2) — state in Terraform Cloud
  turso/        # libSQL DB — Platform API bootstrap script
  northflank/   # Go API host — API/GitOps (deploy step)
```

## Why per-provider folders
Only Cloudflare uses Terraform, so `cloudflare/` is the sole TF root (one state,
no cross-state wiring). Turso and Northflank use their own tooling, so they live
as plain folders beside it. Adding a service later = a new folder, no central rewrite.

## Where each secret goes (all in the gitignored `.env`)
| Secret | Used by |
|---|---|
| `CLOUDFLARE_API_TOKEN`, `TF_VAR_cloudflare_*` | `cloudflare/` terraform |
| `TF_TOKEN_app_terraform_io`, `TF_CLOUD_ORGANIZATION`, `TF_WORKSPACE` | terraform remote state |
| `TURSO_API_TOKEN` | `turso/bootstrap.sh` |
| `DATABASE_URL`, `DATABASE_AUTH_TOKEN` | Go api (+ pushed to Northflank) |
| `NORTHFLANK_API_TOKEN` | `northflank/` deploy |
| `PATH_SECRET` | `workers/edge` (wrangler secret) |

See each folder's README for run steps.
