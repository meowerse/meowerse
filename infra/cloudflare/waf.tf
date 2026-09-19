# Edge flood protection for the API Workers.
#
# WHY THIS IS AT THE EDGE, NOT IN THE WORKER: the free plan caps Worker
# invocations at 100k/day ACCOUNT-WIDE and returns 1015 past that. App-level rate
# limiting inside the Worker does NOT help — the request already counted the moment
# the Worker ran. Only a rate-limiting rule (evaluated at the edge, BEFORE the
# Worker) blocks a flood without consuming the quota.
#
# PATH-SCOPED (2026-07): the single free rule now matches only WORKER-INVOKING
# paths, not whole hosts. Static assets (served pre-worker, they never touch the
# quota) are excluded, so the per-IP budget can be tight (30/10s = 3 req/s) without
# tripping on an asset-heavy page load. Server-to-server OIDC (/token, /userinfo,
# /jwks, /.well-known/*) and the /avatar image proxy are ALSO excluded so relying-
# party backends, login spikes, and legit avatar bursts are never blocked — those
# are protected instead by confidential-client auth + edge caching + in-worker
# throttles. 30/10s on worker paths only ≈ 259k/day/IP: a single IP still cannot
# fully drain the account quota alone (a 10s free window can't bound that), but
# combined with edge-cached GETs + the amplifier fixes it removes the cheap levers;
# a distributed L7 flood needs paid Cloudflare (documented limitation).
#
# WHY IT WON'T BREAK APPS THAT USE OUR AUTH: the action is `block` (not a
# challenge) so machine clients + SDKs are never asked to solve a CAPTCHA, and the
# token/jwks/userinfo endpoints the RPs actually call are excluded from the rule.
#
# Free-tier note: the free plan allows ONE rate-limiting rule, per-IP counting, and
# a FIXED 10s period + 10s mitigation timeout. If a future apply balks, tune
# waf_requests_per_10s or set enable_waf = false to skip the rule.

variable "enable_waf" {
  type        = bool
  default     = true
  description = "Create the edge rate-limiting rule that protects the free-tier request quota. Set false if the free-plan apply rejects the ruleset."
}

variable "waf_requests_per_10s" {
  type        = number
  default     = 30
  description = "Per-IP request budget per 10s per colo (fixed 10s window on free) before the edge blocks, on WORKER paths only (assets + server-to-server OIDC excluded). 30 = 3 req/s: generous for a real browser/RP; a flood trips it."
}

locals {
  # The rate-limit matches ONLY worker-invoking, browser/attacker-facing paths per
  # host. Excluded (never rate-limited): all static assets (pre-worker), auth's
  # server-to-server OIDC (/token*, /userinfo, /jwks, /.well-known/*, /mgmt, /internal)
  # and the /avatar proxy. api.meow has no static assets → every path is a worker hit.
  waf_ratelimit_expression = join(" or ", [
    "(http.host in {\"api.meow.alxnko.eu.org\" \"api.meow.alxnko.dev\"})",
    # authbot: the Telegram account-link webhook worker, now in-zone (was *.workers.dev,
    # which bypassed this rule). Pure worker (no assets) → every path is a worker hit.
    "(http.host in {\"authbot.alxnko.eu.org\" \"authbot.alxnko.dev\"})",
    "((http.host in {\"auth.alxnko.eu.org\" \"auth.alxnko.dev\"}) and (starts_with(http.request.uri.path, \"/authorize\") or starts_with(http.request.uri.path, \"/login\") or starts_with(http.request.uri.path, \"/signup\") or starts_with(http.request.uri.path, \"/consent\") or starts_with(http.request.uri.path, \"/tg/\") or starts_with(http.request.uri.path, \"/api/\") or http.request.uri.path in {\"/logout\" \"/session/end\"}))",
    "((http.host in {\"meowsenger.alxnko.eu.org\" \"meowsenger.alxnko.dev\"}) and (starts_with(http.request.uri.path, \"/api/\") or starts_with(http.request.uri.path, \"/auth/\") or http.request.uri.path in {\"/ws\" \"/health\"}))",
  ])
}

resource "cloudflare_ruleset" "api_rate_limit" {
  count   = var.enable_waf ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = "meowerse API flood protection"
  kind    = "zone"
  phase   = "http_ratelimit"

  rules = [{
    ref         = "api_per_ip_flood"
    description = "Per-IP flood block on worker paths (protects the free-tier request quota; assets + server-to-server OIDC excluded)"
    expression  = local.waf_ratelimit_expression
    action      = "block"
    ratelimit = {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 10
      requests_per_period = var.waf_requests_per_10s
      mitigation_timeout  = 10
    }
  }]
}
