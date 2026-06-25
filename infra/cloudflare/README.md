# infra/cloudflare — Terraform

The single Terraform root (Cloudflare is the only provider managed by TF).
State lives in Terraform Cloud (HCP), workspace execution mode = Local.

## Files
- `versions.tf` — TF + provider versions, `cloud {}` backend
- `providers.tf` — Cloudflare provider (token from env)
- `variables.tf` — inputs + `enable_r2` gate
- `zone.tf` — zone data source (read-only)
- `r2.tf` — R2 bucket, gated behind `enable_r2`
- `outputs.tf` — zone + r2 outputs
- `pages.tf`, `dns.tf` — added at the deploy step (need real Pages/Northflank hostnames)

## Not managed here
- **Worker `bot0`** — owned by wrangler (`workers/edge/`), not TF, to avoid state
  churn on every code byte.
- **Turso / Northflank** — own tooling, see `../turso` and `../northflank`.

## Run
```bash
set -a; source ../../.env; set +a            # CF token, TFC token, org, workspace
export TF_VAR_cloudflare_account_id="$CLOUDFLARE_ACCOUNT_ID"
export TF_VAR_cloudflare_zone_id="$CLOUDFLARE_ZONE_ID"
terraform init      # state in TFC (org/workspace from env)
terraform plan
terraform apply
```

## Enabling R2 later
1. Add a payment method + enable R2 in the Cloudflare dashboard.
2. `terraform apply -var enable_r2=true`.
3. (Optional) migrate TF state from TFC to R2's S3-compatible backend.
