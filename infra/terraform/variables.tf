# Supplied via environment: TF_VAR_cloudflare_account_id, TF_VAR_cloudflare_zone_id
# (sourced from the gitignored .env — never committed).
# CLOUDFLARE_API_TOKEN is read directly by the provider from the environment.

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
  description = "R2 requires a payment method even on the free tier. Keep false until enabled in the dashboard; flipping to true brings R2 resources into plan/apply."
}

variable "r2_bucket_name" {
  type        = string
  default     = "meowerse-media"
  description = "R2 bucket for object storage (only created when enable_r2 = true)."
}
