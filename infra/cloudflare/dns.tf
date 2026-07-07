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

# Auth (auth.alxnko.eu.org) is NOT here — it's ONE Cloudflare Worker custom
# domain (workers/auth serves the OIDC IdP API plus the static UI via Workers
# static-assets), so wrangler provisions its DNS + certs automatically, like
# api.meow.
