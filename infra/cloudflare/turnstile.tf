# Turnstile bot protection for /login + /signup, provisioned end-to-end here.
#
# The widget creation yields BOTH keys. The Cloudflare v5 provider has no
# standalone worker-secret resource, so the secret is pushed with
# `wrangler secret put` via local-exec — the same bash shell-out pattern
# deploy.tf uses (sources .env for CLOUDFLARE_API_TOKEN). The site key is public
# and surfaced as an output the auth-web build reads (PUBLIC_TURNSTILE_SITE_KEY).
#
# Enabling this turns the bot challenge ON for real users on login + signup. The
# machine OIDC endpoints are NEVER gated (workers/auth/src/turnstile.ts), so
# relying-party apps are unaffected.

variable "enable_turnstile" {
  type        = bool
  default     = true
  description = "Provision the Turnstile widget, set the worker secret, and expose the site key — turning bot protection ON for /login + /signup. false destroys the widget and disables it (worker gate becomes a no-op)."
}

resource "cloudflare_turnstile_widget" "auth" {
  count      = var.enable_turnstile ? 1 : 0
  account_id = var.cloudflare_account_id
  name       = "meowerse auth — login + signup"
  domains    = ["auth.alxnko.eu.org"]
  mode       = "managed"
}

# No cloudflare_workers_secret resource exists in provider v5, so push the secret
# with wrangler (matching deploy.tf's local-exec). The secret rides in the
# `environment` map — never the command string — so terraform never prints it.
# Runs only when the widget secret changes (i.e. once, on create).
resource "terraform_data" "turnstile_worker_secret" {
  count            = var.enable_turnstile ? 1 : 0
  triggers_replace = [cloudflare_turnstile_widget.auth[0].secret]

  provisioner "local-exec" {
    working_dir = "${path.module}/../.."
    interpreter = ["bash", "-c"]
    command     = "set -a; source .env; set +a; cd workers/auth && printf '%s' \"$TURNSTILE_SECRET\" | bunx wrangler secret put TURNSTILE_SECRET_KEY"
    environment = {
      TURNSTILE_SECRET = cloudflare_turnstile_widget.auth[0].secret
    }
  }
}

output "turnstile_site_key" {
  description = "Public Turnstile site key — set as PUBLIC_TURNSTILE_SITE_KEY for the auth-web build."
  value       = var.enable_turnstile ? cloudflare_turnstile_widget.auth[0].sitekey : null
}
