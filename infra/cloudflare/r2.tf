# Object storage. Gated off: R2 needs a payment method even on the free tier,
# so it stays out of plan/apply until enable_r2 = true (see variables.tf).
resource "cloudflare_r2_bucket" "media" {
  count      = var.enable_r2 ? 1 : 0
  account_id = var.cloudflare_account_id
  name       = var.r2_bucket_name
  location   = "weur"
}
