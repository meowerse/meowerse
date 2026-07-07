# @meowerse/auth-worker — "Auth with Meowerse" OIDC identity provider

A standards OAuth 2.0 / OpenID Connect authorization server on Cloudflare
Workers + Turso. Mirrors `workers/api` (thin DI router, `ensureSchema`
memoization, `constantTimeEqual`, exact-origin credentialed CORS). Free-tier.

Issuer + UI: `https://auth.alxnko.eu.org` — ONE Worker serves the Astro UI (static
assets) AND all OIDC/API routes ([apps/auth-web](../../apps/auth-web) is folded in via
the `ASSETS` binding). Design spec:
[docs/superpowers/specs/2026-06-25-meowerse-auth-design.md](../../docs/superpowers/specs/2026-06-25-meowerse-auth-design.md).

## Endpoints (slice 1)

| Method | Path | Purpose |
|---|---|---|
| GET | `/.well-known/openid-configuration` | discovery (edge-cached) |
| GET | `/jwks` | ES256 public keys (edge-cached) |
| GET/POST | `/authorize` | state-preserving authorization request |
| GET | `/authorize/pending` | pending request, for the consent UI |
| POST | `/signup` · `/login` · `/consent` | account + consent flow (JSON) |
| POST | `/token` | `authorization_code` + PKCE exchange |
| GET/POST | `/userinfo` | scoped claims (access_token only) |
| GET | `/logout` | server-side session revoke |
| POST | `/token/revoke` · `/token/introspect` | RFC 7009 / 7662 |

## Secrets (set once, never committed)

```bash
cd workers/auth
bun scripts/gen-signing-key.mjs | bunx wrangler secret put AUTH_SIGNING_KEYS
bunx wrangler secret put STATE_SECRET        # any long random string
bunx wrangler secret put DATABASE_URL        # same Turso DB as workers/api
bunx wrangler secret put DATABASE_AUTH_TOKEN
```

Local dev: copy `.dev.vars.example` → `.dev.vars` (gitignored) and fill in.

## Develop

```bash
bun run test     # vitest, 90% coverage gate
bun run dev      # wrangler dev
bun run deploy   # wrangler deploy (or `just deploy-auth` from the repo root)
```
