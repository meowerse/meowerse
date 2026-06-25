# Zone is read-only here: we manage records/resources under it, not the zone
# itself (avoids any destructive re-create of an existing live zone).
data "cloudflare_zone" "main" {
  zone_id = var.cloudflare_zone_id
}

# Object storage. Gated off: R2 needs a payment method even on the free tier,
# so it stays out of plan/apply until enable_r2 = true (see variables.tf).
resource "cloudflare_r2_bucket" "media" {
  count      = var.enable_r2 ? 1 : 0
  account_id = var.cloudflare_account_id
  name       = var.r2_bucket_name
  location   = "weur"
}

# NOTE: the bot0 worker is intentionally NOT managed here — wrangler owns worker
# code + deploy (see workers/edge/wrangler.jsonc). DNS records + Pages project
# are added in the apps phase when the web app needs a hostname.
