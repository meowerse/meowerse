terraform {
  required_version = ">= 1.9"

  # ponytail: local state for now (solo dev, no card on file → no R2 yet).
  # Migrate to R2 (S3-compatible) backend once R2 is enabled — swap this block:
  #   backend "s3" { ... R2 endpoint ... }  and run `terraform init -migrate-state`.
  # Until then state lives in infra/terraform/terraform.tfstate (gitignored — BACK IT UP).

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.21"
    }
  }
}
