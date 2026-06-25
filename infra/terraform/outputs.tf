output "zone_name" {
  value       = data.cloudflare_zone.main.name
  description = "Managed zone (alxnko.eu.org)"
}

output "zone_status" {
  value       = data.cloudflare_zone.main.status
  description = "Zone activation status"
}

output "r2_bucket_name" {
  value       = var.enable_r2 ? cloudflare_r2_bucket.media[0].name : null
  description = "R2 bucket name (null until enable_r2 = true)"
}

# Turso outputs (DB_URL, DB_AUTH_TOKEN) are added in the Turso task once the
# database is provisioned; they feed Northflank env via the deploy workflow.
