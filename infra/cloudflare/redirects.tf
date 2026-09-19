# Cloudflare Single Redirects (http_request_dynamic_redirect)
#
# Edge 308 Permanent Redirect from *.alxnko.eu.org to *.alxnko.dev preserving
# path and query string. Evaluated at Cloudflare Anycast edge before Workers run,
# saving 100% of Worker quota and responding with sub-5ms latency.

resource "cloudflare_ruleset" "redirect_eu_org_to_dev" {
  zone_id     = var.cloudflare_zone_id
  name        = "Redirect alxnko.eu.org to alxnko.dev"
  description = "301 Permanent Redirect *.alxnko.eu.org to *.alxnko.dev preserving path and query"
  kind        = "zone"
  phase       = "http_request_dynamic_redirect"

  rules = [
    {
      ref         = "redirect_apex_to_dev"
      description = "Redirect apex/web to alxnko.dev"
      expression  = "http.host in {\"alxnko.eu.org\" \"www.alxnko.eu.org\" \"meow.alxnko.eu.org\"}"
      action      = "redirect"
      action_parameters = {
        from_value = {
          status_code = 301
          target_url = {
            expression = "concat(\"https://alxnko.dev\", http.request.uri.path)"
          }
          preserve_query_string = true
        }
      }
      enabled = true
    },
    {
      ref         = "redirect_auth_to_dev"
      description = "Redirect auth to auth.alxnko.dev"
      expression  = "http.host == \"auth.alxnko.eu.org\""
      action      = "redirect"
      action_parameters = {
        from_value = {
          status_code = 301
          target_url = {
            expression = "concat(\"https://auth.alxnko.dev\", http.request.uri.path)"
          }
          preserve_query_string = true
        }
      }
      enabled = true
    },
    {
      ref         = "redirect_meowsenger_to_dev"
      description = "Redirect meowsenger to meowsenger.alxnko.dev"
      expression  = "http.host == \"meowsenger.alxnko.eu.org\""
      action      = "redirect"
      action_parameters = {
        from_value = {
          status_code = 301
          target_url = {
            expression = "concat(\"https://meowsenger.alxnko.dev\", http.request.uri.path)"
          }
          preserve_query_string = true
        }
      }
      enabled = true
    },
    {
      ref         = "redirect_api_to_dev"
      description = "Redirect api.meow to api.meow.alxnko.dev"
      expression  = "http.host == \"api.meow.alxnko.eu.org\""
      action      = "redirect"
      action_parameters = {
        from_value = {
          status_code = 301
          target_url = {
            expression = "concat(\"https://api.meow.alxnko.dev\", http.request.uri.path)"
          }
          preserve_query_string = true
        }
      }
      enabled = true
    },
    {
      ref         = "redirect_authbot_to_dev"
      description = "Redirect authbot to authbot.alxnko.dev"
      expression  = "http.host == \"authbot.alxnko.eu.org\""
      action      = "redirect"
      action_parameters = {
        from_value = {
          status_code = 301
          target_url = {
            expression = "concat(\"https://authbot.alxnko.dev\", http.request.uri.path)"
          }
          preserve_query_string = true
        }
      }
      enabled = true
    }
  ]
}
