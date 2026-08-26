# meowerse

Astro/React frontends + Cloudflare Workers (TypeScript), shared packages, Terraform/Turso infra — free-tier first.

## Prerequisites

- [Bun](https://bun.sh) 1.3+
- [just](https://github.com/casey/just)
- [pre-commit](https://pre-commit.com) (optional, for git hooks)
- Wrangler via `bunx` (no global install needed)

## Commands

```bash
just install        # bun install (workspaces)
just test           # turbo run test (vitest --coverage per workspace)
just lint           # turbo run lint (astro check / tsc --noEmit / wrangler dry-run)
just build          # turbo run build
just deploy-status  # deployed SHA vs source SHA per service
just deploy-api / deploy-web / deploy-worker / deploy-auth / deploy-meowsenger
just deploy-all     # terraform apply (infra/cloudflare)
```

Run `just` (or `just --list`) to list every available recipe. CI (`.github/workflows/ci.yml`) runs `just lint` + `just test` on pull requests.

## Layout

```
apps/            Astro/React frontends
  web/           marketing/landing (@meowerse/web)
  auth-web/      Auth UI — bundled into workers/auth at deploy
  meowsenger-web/ Chat UI — bundled into workers/meowsenger at deploy
  api/           legacy stub (empty, kept for history)
workers/         Cloudflare Workers (TypeScript + wrangler)
  api/           meows API (Turso/libSQL, Cache API, batch)
  auth/          OIDC IdP + serves apps/auth-web assets
  meowsenger/    BFF + serves apps/meowsenger-web assets (D1 + Durable Objects)
  edge/          edge worker (PATH_SECRET)
  auth-bot/      Telegram bot worker
packages/        Shared libraries
  ts-shared/     slugify etc. (bun test)
  auth-shared/   PKCE / telegram / scopes / password-policy
  auth-sdk/      @meowerse/auth client SDK
  ui/            design tokens + React components
  go-shared/     legacy (Go slug, no longer built)
infra/
  cloudflare/    Terraform (zone, DNS, R2, Turnstile, deploys) — state in Terraform Cloud
  turso/         libSQL bootstrap script
docs/superpowers/ Plans + specs
```

## Workspaces

`package.json` workspaces: `apps/*`, `packages/*`, `workers/*`. `turbo.json` defines `build` (depends on `^build`, outputs `dist/**`), `test`, `lint`.

See `infra/README.md` for secrets/env — all in gitignored `.env` / `wrangler secret put` (never committed).
