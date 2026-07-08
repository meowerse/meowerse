# meowerse task layer

set shell := ["bash", "-uc"]

# List all available recipes.
default:
    @just --list

# Install JS workspace dependencies.
install:
    bun install

# Run all tests with coverage gates (JS/TS workspaces via Turbo).
test: test-js

# Run JS workspace tests via Turbo.
test-js:
    bun run test

# Run all linters (JS/TS workspaces via Turbo).
lint: lint-js

# Lint the JS workspace via Turbo.
lint-js:
    bun run lint

# Build the JS workspace via Turbo.
build:
    bun run build

# Show deploy status per service: deployed SHA vs source SHA (+ dirty flag).
deploy-status:
    bash infra/deploy-status.sh

# Deploy the api (Cloudflare Worker) via wrangler + record version.
deploy-api:
    bash -c 'set -a; source .env; set +a; bash infra/cloudflare/deploy-api.sh'

# Deploy the web app to Cloudflare Pages (direct upload) + record version.
deploy-web:
    bash -c 'set -a; source .env; set +a; bash infra/cloudflare/deploy-web.sh'

# Deploy the edge worker via wrangler + record version.
deploy-worker:
    bash -c 'set -a; source .env; set +a; bash infra/cloudflare/deploy-worker.sh'

# Deploy auth (one Worker: builds the UI + serves assets + OIDC IdP) + record version.
deploy-auth:
    bash -c 'set -a; source .env; set +a; bash infra/cloudflare/deploy-auth.sh'

# Deploy meowsenger (one Worker: builds the UI + serves assets + BFF) + record version.
deploy-meowsenger:
    bash -c 'set -a; source .env; set +a; bash infra/cloudflare/deploy-meowsenger.sh'

# Deploy everything changed via Terraform (infra + apps). `tf apply` UX.
deploy-all:
    bash -c 'cd infra/cloudflare && set -a; source ../../.env; set +a; export TF_VAR_cloudflare_account_id="$CLOUDFLARE_ACCOUNT_ID" TF_VAR_cloudflare_zone_id="$CLOUDFLARE_ZONE_ID"; terraform apply'
