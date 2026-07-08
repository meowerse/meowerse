# infra

Infrastructure as code, organized by provider — each folder owns the right tool
for that service.

```
infra/
  cloudflare/   # Terraform (zone, DNS, Pages, R2) — state in Terraform Cloud
  turso/        # libSQL DB — Platform API bootstrap script
```

## Why per-provider folders
Only Cloudflare uses Terraform, so `cloudflare/` is the sole TF root (one state,
no cross-state wiring). Turso uses its own tooling, so it lives as a plain folder
beside it. Adding a service later = a new folder, no central rewrite.

## Where each secret goes (all in the gitignored `.env`)
| Secret | Used by |
|---|---|
| `CLOUDFLARE_API_TOKEN`, `TF_VAR_cloudflare_*` | `cloudflare/` terraform |
| `TF_TOKEN_app_terraform_io`, `TF_CLOUD_ORGANIZATION`, `TF_WORKSPACE` | terraform remote state |
| `TURSO_API_TOKEN` | `turso/bootstrap.sh` |
| `DATABASE_URL`, `DATABASE_AUTH_TOKEN` | the api Worker (`workers/api`) — libSQL/Turso |
| `PATH_SECRET` | `workers/edge` (wrangler secret) |

See each folder's README for run steps.
