# DNS records owned by Terraform. Note: api.meow.alxnko.eu.org is NOT here —
# it's a Cloudflare Worker custom domain (workers/api/wrangler.jsonc), so wrangler
# provisions that DNS + cert automatically.

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

# Auth UI: auth.alxnko.eu.org -> Cloudflare Pages. The auth API
# (auth-api.alxnko.eu.org) is NOT here — it's a Worker custom domain
# (workers/auth/wrangler.jsonc), provisioned by wrangler like api.meow.
resource "cloudflare_dns_record" "auth_web" {
  zone_id = var.cloudflare_zone_id
  name    = "auth"
  type    = "CNAME"
  content = "meowerse-auth-web.pages.dev"
  ttl     = 1
  proxied = true
  comment = "Auth UI (Cloudflare Pages: meowerse-auth-web)"
}
