# Edge Cache Rules for public, static/near-static GETs.
#
# WHY: a Worker's own Response is NOT written to Cloudflare's edge cache by default —
# Cache-Control only instructs the browser. So every hit to /jwks, discovery,
# /api/push/key, GET /api/meows is a full WORKER INVOCATION even though the payload is
# static/near-static. A zone Cache Rule (free plan) marks these cache-eligible so the
# edge serves a HIT WITHOUT invoking the worker — removing them from the worker-
# invocation attack surface (they no longer count against the 100k/day quota when hot)
# and making them faster.
#
# TTL = respect_origin: each endpoint's own Cache-Control drives the edge TTL (jwks +
# discovery = 1h, /api/meows = 10s, /api/push/key = its own). GET only (writes/POST are
# never cached). SAFETY: /jwks + discovery are served with `Access-Control-Allow-Origin:
# *` (no reflected-Origin, no credentials) by the worker, so a shared cached entry can't
# leak one origin's CORS to another — apply AFTER that auth change is live.

variable "enable_cache_rules" {
  type        = bool
  default     = true
  description = "Create the edge Cache Rule that offloads public GETs from the workers. Set false if a free-plan apply rejects the ruleset."
}

resource "cloudflare_ruleset" "edge_cache" {
  count   = var.enable_cache_rules ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = "meowerse edge cache for public GETs"
  kind    = "zone"
  phase   = "http_request_cache_settings"

  rules = [{
    ref         = "cache_public_gets"
    description = "Edge-cache public static/near-static GETs (jwks, discovery, push key, meows) so they don't invoke the worker"
    expression  = "(http.request.method eq \"GET\") and ((http.host eq \"auth.alxnko.eu.org\" and http.request.uri.path in {\"/jwks\" \"/.well-known/openid-configuration\" \"/.well-known/jwks.json\"}) or (http.host eq \"meowsenger.alxnko.eu.org\" and http.request.uri.path eq \"/api/push/key\") or (http.host eq \"api.meow.alxnko.eu.org\" and http.request.uri.path eq \"/api/meows\"))"
    action      = "set_cache_settings"
    action_parameters = {
      cache = true
      edge_ttl = {
        mode = "respect_origin"
      }
      browser_ttl = {
        mode = "respect_origin"
      }
    }
  }]
}
