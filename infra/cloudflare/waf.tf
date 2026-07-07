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
# generous (100 req / 10s per IP per colo ≈ 10 req/s sustained). A browser never
# approaches it; a busy relying-party BACKEND calling /token would need to
# sustain >10 req/s from a single IP to be touched. The action is `block` (not a
# challenge) so machine clients + SDKs are never asked to solve a CAPTCHA.
#
# Free-tier note: the free plan allows ONE rate-limiting rule, per-IP counting,
# and a FIXED 10s period + 10s mitigation timeout (a 60s period is rejected).
# If a future apply still balks, tune waf_requests_per_10s or set
# enable_waf = false to skip the rule.

variable "enable_waf" {
  type        = bool
  default     = true
  description = "Create the edge rate-limiting rule that protects the free-tier request quota. Set false if the free-plan apply rejects the ruleset."
}

variable "waf_api_hosts" {
  type        = list(string)
  default     = ["auth-api.alxnko.eu.org", "api.meow.alxnko.eu.org", "meowsenger-api.alxnko.eu.org"]
  description = "Worker-backed API hostnames to flood-protect. NOT the static UI (auth.alxnko.eu.org) — static assets don't consume the Worker quota."
}

# The FREE plan only permits a 10-second rate-limit period and a mitigation
# timeout equal to the period (confirmed at apply: "not entitled to use the
# period 60, can only use a period among [10]"). 100 req / 10s ≈ 10 req/s
# sustained per IP per colo — same effective rate a 600/min rule would give, and
# a real browser or RP backend never approaches it; a flood does.
variable "waf_requests_per_10s" {
  type        = number
  default     = 100
  description = "Per-IP request budget per 10s per colo before the edge blocks (free plan is fixed to a 10s window)."
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
      period              = 10
      requests_per_period = var.waf_requests_per_10s
      mitigation_timeout  = 10
    }
  }]
}
