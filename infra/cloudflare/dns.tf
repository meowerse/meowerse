# DNS records. Pages/Worker/Northflank deploys are owned by their own tools;
# Terraform owns the DNS that points the custom domains at them.

# Web: meow.alxnko.eu.org -> Cloudflare Pages (proxied; Pages manages the cert).
resource "cloudflare_dns_record" "web" {
  zone_id = var.cloudflare_zone_id
  name    = "meow"
  type    = "CNAME"
  content = "meowerse-web.pages.dev"
  ttl     = 1
  proxied = true
  comment = "Astro web app (Cloudflare Pages: meowerse-web)"
}

# API: api.meow.alxnko.eu.org -> Northflank service.
# DNS-only (proxied=false) so Northflank can validate + issue its own TLS cert.
# Gated until the Northflank host is known (var.northflank_api_host).
resource "cloudflare_dns_record" "api" {
  count   = var.northflank_api_host != "" ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = "api.meow"
  type    = "CNAME"
  content = var.northflank_api_host
  ttl     = 1
  proxied = false
  comment = "Go api (Northflank)"
}
