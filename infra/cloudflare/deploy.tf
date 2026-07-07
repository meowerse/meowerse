# App/worker deploys orchestrated by Terraform.
#
# Terraform has no Northflank/wrangler providers, so this is the documented
# escape hatch: one terraform_data per service whose triggers_replace = a
# per-service source hash. When a service's source changes, its trigger changes,
# Terraform replaces the resource, and the local-exec provisioner runs that
# service's deploy script (the SAME scripts `just deploy-*` uses — DRY).
# Unchanged services keep their trigger and are NOT redeployed.
#
# To deploy a NEW app/worker, add ONE entry to local.services below (paths it
# depends on + its deploy script). Everything else is automatic.
#
# Caveat: imperative work inside declarative TF — a failed deploy fails the
# apply, with no rollback beyond redeploying a previous commit. Set
# var.deploy_apps = false for infra-only applies.

locals {
  services = {
    api = {
      paths  = "workers/api packages/ts-shared"
      script = "infra/cloudflare/deploy-api.sh"
    }
    web = {
      paths  = "apps/web packages/ts-shared"
      script = "infra/cloudflare/deploy-web.sh"
    }
    worker = {
      paths  = "workers/edge"
      script = "infra/cloudflare/deploy-worker.sh"
    }
    auth = {
      # one Worker: builds the Astro UI + serves it (static assets) alongside the OIDC IdP
      paths  = "workers/auth apps/auth-web packages/auth-shared"
      script = "infra/cloudflare/deploy-auth.sh"
    }
    meowsenger = {
      # one Worker: builds the Astro UI + serves it (static assets) alongside the BFF
      paths  = "workers/meowsenger apps/meowsenger-web packages/auth-shared packages/auth-sdk"
      script = "infra/cloudflare/deploy-meowsenger.sh"
    }
  }
}

# Per-service source hash (only evaluated when deploy_apps = true).
data "external" "version" {
  for_each = var.deploy_apps ? local.services : {}
  program  = ["bash", "${path.module}/../version-hash.sh"]
  query    = { paths = each.value.paths }
}

resource "terraform_data" "deploy" {
  for_each         = var.deploy_apps ? local.services : {}
  triggers_replace = data.external.version[each.key].result.hash

  provisioner "local-exec" {
    working_dir = "${path.module}/../.."
    interpreter = ["bash", "-c"]
    command     = "set -a; source .env; set +a; bash ${each.value.script}"
  }
}
