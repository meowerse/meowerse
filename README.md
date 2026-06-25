# meowerse

A polyglot monorepo: Astro/React frontends, Go/Fiber backends, a Cloudflare edge worker, shared Terraform, free-tier first.

## Prerequisites

- [Bun](https://bun.sh) 1.3+
- [Go](https://go.dev) 1.26+
- [just](https://github.com/casey/just)
- [pre-commit](https://pre-commit.com) (optional, for git hooks)

## Commands

```bash
just install   # install JS workspace dependencies
just test      # run all tests (JS + Go) with the 90% coverage gate
just lint      # run all linters (JS + Go)
just build     # build the JS workspace
```

Run `just` (or `just default`) to list every available recipe.

## Layout

```
apps/              Astro/React frontend applications
workers/           Cloudflare edge workers
packages/          Shared libraries (ts-shared, go-shared, ...)
infra/terraform/   Shared infrastructure as code
docs/superpowers/  Project documentation
```
