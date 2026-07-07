# auth consolidation — one Worker on auth.alxnko.eu.org (UI + OIDC), issuer cutover — plan

> subagent-driven. Mirrors the already-shipped meowsenger single-host consolidation. Gates green;
> commit; no push (part of the single end deploy). Safe because meowsenger is the ONLY OIDC client.

**Goal:** merge `apps/auth-web` (Astro UI) into `workers/auth` (the OIDC worker) so ONE Worker on
`auth.alxnko.eu.org` serves the static UI **and** all OIDC/API routes. Change the issuer to
`https://auth.alxnko.eu.org`, retire `auth-api.alxnko.eu.org`, re-point meowsenger. No backend URL
shown; discovery/jwks same-origin with the UI.

**Why safe:** meowsenger is the only client; its `OIDC_ISSUER` + a re-provision are the only external
touch. (User confirmed 2026-07-07.)

---

## Routing model (the one tricky part — page vs API path overlaps)
Workers Static Assets serves a matching asset BEFORE the worker runs; non-asset paths hit the worker.
The auth UI pages are GET-only HTML at `/login /signup /consent /verify /account /dashboard
/developers /docs /about /privacy /terms /` (+ `/404`, `/error`). The OIDC/API surface is:
`POST /login`, `POST /signup`, `POST /consent`, `GET /authorize`, `POST /token`, `GET /userinfo`,
`GET /jwks`, `GET /.well-known/openid-configuration`, `POST /token/revoke|introspect`, `GET /logout`,
`/api/*`, `/mgmt/*`, `/tg/*`, `GET /avatar/:id`, `GET /authorize/pending`.
**Dispatch works naturally:** GET page paths (`/login`, `/consent`, …) match a built asset → served
as HTML without the worker; `POST /login` etc. don't match an asset (assets are GET) → worker. The
machine GETs (`/authorize`, `/userinfo`, `/jwks`, `/.well-known/*`, `/logout`, `/authorize/pending`)
have NO page asset at those paths → worker. `/api|/mgmt|/tg|/avatar` → worker.
**Verify there is NO GET page asset whose path equals a GET API route** (e.g. no `/authorize` or
`/userinfo` page). Astro pages are only the list above — none collide. Confirm at build.

Worker `handle()`: keep the existing API routing; at the end, for an unmatched request, serve
`env.ASSETS.fetch(req)` (Astro 404 page) instead of the JSON 404 — same pattern as meowsenger's
`workers/meowsenger/src/index.ts`.

---

## Group A — merge + issuer + routing

**Files:** `workers/auth/{wrangler.jsonc, src/index.ts, src/types.ts}`, `apps/auth-web/*`, infra.

1. **wrangler.jsonc (`workers/auth`):** add `"assets": { "directory": "../../apps/auth-web/dist", "binding": "ASSETS" }`; change the route to `auth.alxnko.eu.org` (custom_domain); change the `ISSUER` var to `https://auth.alxnko.eu.org`; update `WEB_ORIGIN` if it points at itself; keep all existing secrets/vars. (Ensure `main` stays.)
2. **`src/index.ts`:** add `ASSETS?: Fetcher` to `Env`; at the end of `handle()`, `if (env.ASSETS) return env.ASSETS.fetch(req)` before the JSON 404 (so page paths + the 404 page render). Nothing else in routing changes — the API routes already match first.
3. **CORS/CSP:** the auth UI + API are now same-origin, so the auth-web `public/_headers` CSP `connect-src` becomes `'self'` (drop the auth-api host). Keep the Turnstile/challenges.cloudflare.com allowances. The worker's CORS allowlist should include `https://auth.alxnko.eu.org` (same-origin calls need no CORS, but the account/dashboard fetches used credentialed CORS — now same-origin, harmless).
4. **auth-web build:** `apps/auth-web` stays an Astro static build (no own wrangler deploy). Its `PUBLIC_AUTH_API_URL` (the base the UI calls) becomes `""` (same-origin) — update Layout/lib defaults so the UI calls relative `/login`, `/api/*`, etc. Remove `apps/auth-web/wrangler.jsonc` (folded into the auth worker).
5. **Issuer references:** anything hardcoding `auth-api.alxnko.eu.org` in auth code/tests → `auth.alxnko.eu.org` (grep). The `ISSUER` var drives discovery/jwks/token `iss`/userinfo `picture` — all auto-follow.

Commit: `refactor(auth): consolidate UI + OIDC into one worker on auth.alxnko.eu.org; issuer → auth.alxnko.eu.org`.

## Group B — infra wiring + meowsenger re-point

1. **infra:** `deploy-auth.sh` builds auth-web then deploys the auth worker (like `deploy-meowsenger.sh`); drop `deploy-auth-web.sh`; `services.sh` merge `auth` = `workers/auth apps/auth-web packages/auth-shared`; remove `auth-web`; `deploy.tf` merge to one `auth` entry; `justfile` drop `deploy-auth-web`; `waf.tf` — `auth.alxnko.eu.org` (the combined host; the API routes need protection); `deploy.yml` merge the two steps.
2. **meowsenger re-point:** `workers/meowsenger/wrangler.jsonc` `OIDC_ISSUER` + `OIDC_REDIRECT_URI` stay (redirect is on meowsenger's host, unchanged) but `OIDC_ISSUER` → `https://auth.alxnko.eu.org`. meowsenger's CSP `img-src` already allows both `auth-api` + `auth` hosts (Slice 3). Re-provision is NOT required (client record is issuer-agnostic; redirect_uris unchanged) — but a re-provision at deploy is harmless/idempotent.

Commit: `chore(infra): auth single-service wiring; meowsenger OIDC_ISSUER → auth.alxnko.eu.org`.

## Deploy (part of the single end cutover — see finalize)
1. Build auth-web + deploy the auth worker to `auth.alxnko.eu.org` (delete the old `auth-web` worker first to free the domain, like meowsenger's cutover). This also moves the auth worker off `auth-api`.
2. Retire `auth-api.alxnko.eu.org`.
3. Redeploy meowsenger with `OIDC_ISSUER=https://auth.alxnko.eu.org`.
4. WAF apply. Verify: auth UI at auth.alxnko.eu.org, discovery at `auth.alxnko.eu.org/.well-known/openid-configuration` (iss=auth.alxnko.eu.org), meowsenger login round-trip against the new issuer.

## Gates
`bun run --filter @meowerse/auth-worker test` + `... lint`, `@meowerse/auth-web` build + check green. The 280+ auth tests must pass (update any `auth-api` host assertions to `auth`).
