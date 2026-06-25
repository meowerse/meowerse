# meowerse Monorepo — Design Spec

**Date:** 2026-06-25
**Repo:** `alxnko/meowerse`
**Status:** Approved

## Goal

A polyglot monorepo hosting multiple frontends and backends (with room for
microfrontends/microservices), wired to a single shared Terraform layer that
provisions everything on free tiers. Existing Cloudflare domain + JS Worker are
imported into the repo and into Terraform without recreation. Strict test-first
development with a hard 90% coverage gate across every service.

## Stack (final)

| Layer | Choice | Notes |
|---|---|---|
| Frontends | Astro + React islands | zero-JS by default; React for interactive islands |
| Frontend host | Cloudflare Pages | free, unlimited bandwidth, git-integrated build |
| Backends | Go + Fiber, Dockerized | tiny native binary, fasthttp engine |
| Backend host | Northflank Sandbox tier | always-on free compute, no cold starts |
| Edge worker | existing JS Worker (imported) | moved into `workers/edge/`, managed by wrangler + TF |
| Database | Turso (libSQL) | 5–9 GB free, no sleep, embedded replicas for Go |
| Object storage | Cloudflare R2 | 10 GB free, $0 egress, S3 API |
| TF remote state | Cloudflare R2 (S3-compatible backend) | no extra vendor, free |
| Cloudflare provider | v5 | v4 is EOL; v5 is the current rewritten framework |
| JS toolchain | Bun (workspaces + runtime + test) + Turbo | single engine for scripts/tests/topology |
| Go | go.work workspace | multi-module Go |
| CI | GitHub Actions | build, test, 90% coverage gate, terraform plan |
| Tests | Go `testing`+`testify`, Vitest (TS/Astro), `bun test` (worker) | hard 90% gate per service |

### Deliberately rejected / deferred

- **Cloudflare D1** instead of Turso — D1 is more cohesive (one vendor) but Turso
  keeps better Go ergonomics and embedded replicas. Kept Turso.
- **chi/stdlib** instead of Fiber — Fiber kept per user preference.
- **Nx / Moon** instead of Turbo — Turbo chosen to match the `LibMeowsenger` sibling.

## Repository structure

```
meowerse/
├─ apps/
│  ├─ web/                  # Astro + React frontend (Cloudflare Pages)  [reference app]
│  └─ api/                  # Go + Fiber backend (Northflank)            [reference app]
├─ workers/
│  └─ edge/                 # existing JS Worker (imported)
├─ packages/
│  ├─ ts-shared/            # shared TS types/utils (Bun lib)
│  └─ go-shared/            # shared Go module (db, r2, config, middleware)
├─ infra/
│  └─ terraform/
│     ├─ backend.tf         # R2 S3-compatible state backend
│     ├─ providers.tf       # cloudflare v5, turso
│     ├─ cloudflare.tf      # zone (imported), pages, r2, worker (imported), dns
│     ├─ turso.tf           # database + token
│     ├─ variables.tf
│     ├─ outputs.tf         # DB_URL, DB_AUTH_TOKEN, R2 keys (→ Northflank)
│     └─ environments/      # dev.tfvars / prod.tfvars (TF workspaces)
├─ .github/workflows/       # ci.yml, terraform.yml, deploy-northflank.yml
├─ docs/
├─ turbo.json
├─ go.work
├─ package.json             # Bun workspaces root
├─ bunfig.toml
├─ justfile                 # task shortcuts (matches sibling)
├─ .env.example
└─ README.md
```

Adding a microfrontend/microservice later = new dir under `apps/` or `workers/`;
go.work + Bun workspaces + Turbo discover it without central rewiring.

## Build scope (first pass)

Full working reference: one Astro+React frontend and one Go+Fiber backend wired
end-to-end (Turso DB read/write, R2 upload, an auth stub), with real passing
tests and a live deploy proving the whole pipeline. Future apps clone the pattern.

## Terraform organization

- **Single shared root** at `infra/terraform` provisions Cloudflare + Turso.
  Per-environment values via `environments/{dev,prod}.tfvars` and TF workspaces.
- **State in R2** via `backend "s3"` with the R2 S3 endpoint. The state bucket is
  created once by a bootstrap script (Bun/CLI), not by TF itself, to avoid the
  chicken-and-egg of TF needing its own state bucket.
- **Turso caveat:** the Turso TF provider is community-maintained and can lag. Use
  it for db + token; if it breaks, fall back to a `null_resource` invoking the
  Turso CLI. Cloudflare's mature v5 provider stays the anchor.
- **Northflank** has no first-class TF provider. Managed by Northflank GitOps plus
  a `deploy-northflank.yml` Action calling their API. TF outputs (DB_URL, token,
  R2 keys) are pushed to Northflank as secrets by that Action — no manual copy.

## Secrets / API keys

| Key | Source | Destination |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` (all perms) | CF → My Profile → API Tokens | GitHub repo secret + local `.env` |
| `CLOUDFLARE_ACCOUNT_ID` | CF dashboard sidebar | same |
| R2 access key + secret | CF → R2 → Manage API Tokens | GitHub secret + `.env`; Go app via Northflank secret |
| `TURSO_API_TOKEN` | `turso auth token` / dashboard | GitHub secret + `.env` |
| `NORTHFLANK_API_TOKEN` | Northflank → Account → API tokens | GitHub secret only |
| TF outputs (DB_URL, DB_AUTH_TOKEN, R2 creds) | `terraform apply` | auto-pushed to Northflank by Action |

No secret is committed. `.env.example` lists names only; `.env` is gitignored.

## Cloudflare import plan

1. User creates `CLOUDFLARE_API_TOKEN` with all permissions and provides it.
2. Enumerate existing resources (zone/domain, JS Worker, any R2/Pages) via the API.
3. Write matching TF resource blocks, then `terraform import` each so TF adopts
   them without recreating (no downtime, no data loss).
4. Move the Worker's JS source into `workers/edge/`, managed by wrangler + TF.
5. `terraform plan` must show **no destructive changes** before any apply — verified first.

## TDD + CI enforcement (hard gate, 90%)

- Test-first for every feature in the reference apps (failing test → implement → pass).
- **Go:** `go test -cover`, CI fails if any package < 90% (excluding `main`/generated).
- **TS/Astro:** Vitest `coverage.thresholds` 90% (excludes `.astro` layout-only files, configs).
- **Worker:** `bun test` + Vitest workers pool, 90%.
- **Pre-commit:** tests + lint + `terraform fmt`/`validate`.
- **CI matrix:** lint → test + coverage gate → build → `terraform plan` (PRs) → deploy (main only).

## Local dev + deploy flow

- `just dev` → Turbo runs Astro dev + Go hot-reload (air) + worker `wrangler dev`.
- `just test` → all suites + coverage.
- Push to `main` → Actions: test gate → Pages auto-builds web → Northflank rebuilds
  api → wrangler deploys worker → TF plan/apply infra.

## Open items

- Confirm GitHub owner/repo (`alxnko/meowerse` assumed).
- Cloudflare API token to be provided before the import phase.
