# Zone is read-only here: we manage records/resources under it, not the zone
# itself (avoids any destructive re-create of an existing live zone).
data "cloudflare_zone" "main" {
  zone_id = var.cloudflare_zone_id
}
