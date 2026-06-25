terraform {
  required_version = ">= 1.9"

  # Remote state in Terraform Cloud (HCP) — free, no card, with locking.
  # org via TF_CLOUD_ORGANIZATION, workspace via TF_WORKSPACE (env, never committed).
  # Workspace execution mode = Local: plans run here with local .env secrets;
  # TFC only stores state + locks.
  cloud {}

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.21"
    }
    external = {
      source  = "hashicorp/external"
      version = "~> 2.3"
    }
  }
}
