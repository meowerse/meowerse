# Supplied via environment: TF_VAR_cloudflare_account_id, TF_VAR_cloudflare_zone_id
# (sourced from the gitignored .env). CLOUDFLARE_API_TOKEN is read by the provider.

variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID"
}

variable "cloudflare_zone_id" {
  type        = string
  description = "Zone ID for alxnko.eu.org"
}

variable "enable_r2" {
  type        = bool
  default     = false
  description = "R2 needs a payment method even on the free tier. Keep false until enabled in the dashboard; true brings R2 into plan/apply."
}

variable "r2_bucket_name" {
  type        = string
  default     = "meowerse-media"
  description = "R2 bucket for object storage (only created when enable_r2 = true)."
}

variable "deploy_apps" {
  type        = bool
  default     = true
  description = <<-EOT
    When true, `terraform apply` also deploys app/worker code whose source
    changed since the last apply (via terraform_data + local-exec calling the
    deploy scripts). Requires local tooling: docker (api), bun + wrangler
    (web/worker), and a populated .env. Set false for infra-only applies
    (e.g. `terraform apply -var deploy_apps=false` to just change DNS/R2).
  EOT
}

