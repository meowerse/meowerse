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

# Auth UI (auth.alxnko.eu.org) and auth API (auth-api.alxnko.eu.org) are NOT
# here — both are Cloudflare Worker custom domains (apps/auth-web/wrangler.jsonc
# serves the static site via Workers static-assets; workers/auth is the API), so
# wrangler provisions their DNS + certs automatically, like api.meow.
