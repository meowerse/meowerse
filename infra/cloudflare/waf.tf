# Edge flood protection for the API Workers.
#
# WHY THIS IS AT THE EDGE, NOT IN THE WORKER: the free plan caps Worker
# invocations at 100k/day and returns 1015 past that. App-level rate limiting
# inside the Worker does NOT help — the request already counted the moment the
# Worker ran. Only a rate-limiting rule (evaluated at the edge, BEFORE the
# Worker) blocks a flood without consuming the quota. This is the single most
# important control against "a hacker exhausts my free tier".
#
# WHY IT WON'T BREAK APPS THAT USE OUR AUTH: the threshold is per-IP and very
# generous (600 req/min per IP per colo ≈ 10 req/s sustained). A browser never
# approaches it; a busy relying-party BACKEND calling /token would need to
# sustain >10 req/s from a single IP to be touched. The action is `block` (not a
# challenge) so machine clients + SDKs are never asked to solve a CAPTCHA.
#
# Free-tier note: the free plan allows ONE rate-limiting rule with per-IP
# counting and a 10s or 60s period. If `terraform apply` rejects these values,
# tune requests_per_period / period, or set enable_waf = false to skip it.

variable "enable_waf" {
  type        = bool
  default     = true
  description = "Create the edge rate-limiting rule that protects the free-tier request quota. Set false if the free-plan apply rejects the ruleset."
}

variable "waf_api_hosts" {
  type        = list(string)
  default     = ["auth-api.alxnko.eu.org", "api.meow.alxnko.eu.org"]
  description = "Worker-backed API hostnames to flood-protect. NOT the static UI (auth.alxnko.eu.org) — static assets don't consume the Worker quota."
}

variable "waf_requests_per_minute" {
  type        = number
  default     = 600
  description = "Per-IP request budget per minute per colo before the edge blocks. Generous on purpose: a real client never hits it; a flood does."
}

resource "cloudflare_ruleset" "api_rate_limit" {
  count   = var.enable_waf ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = "meowerse API flood protection"
  kind    = "zone"
  phase   = "http_ratelimit"

  rules = [{
    ref         = "api_per_ip_flood"
    description = "Per-IP flood block on the API Workers (protects the free-tier request quota)"
    expression  = "(http.host in {${join(" ", [for h in var.waf_api_hosts : "\"${h}\""])}})"
    action      = "block"
    ratelimit = {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 60
      requests_per_period = var.waf_requests_per_minute
      mitigation_timeout  = 60
    }
  }]
}
