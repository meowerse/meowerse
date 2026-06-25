# @meowerse/api-worker

The deployed meowerse backend: a small, dependency-light Cloudflare Worker that
replaces the Go Fiber api at deploy time. The Go `apps/api` stays in the repo for
a future container host and is untouched.

Built to maximize the Cloudflare free tier (100k req/day, 10ms CPU/req):

- No HTTP framework — a tiny hand-rolled router keeps the hot path under the CPU
  budget.
- `GET /api/meows` is **public** and edge-cached via the Cache API
  (`Cache-Control: public, max-age=10`), so request bursts are served from the
  edge and Turso reads stay low.
- `POST /api/batch` lets a client perform up to 25 creates in **one** request —
  the key optimization against the daily request quota.
- The Turso schema migration runs at most **once per isolate** (memoized
  promise), not per request.

## Routes (under `/api`)

| Method | Path         | Auth | Notes |
| ------ | ------------ | ---- | ----- |
| GET    | `/api/meows` | no   | List, newest first. Edge-cached 10s. |
| POST   | `/api/meows` | yes  | `{text}` → 201 + row. Validates trim/non-empty/≤280; slug via `@meowerse/ts-shared`. |
| POST   | `/api/batch` | yes  | `{ops:[{op:"create",text}]}`, ≤25 ops → `{results:[{status,...}]}`. |
| *      | other        | —    | 404 JSON. OPTIONS → 204 preflight. |

Every successful write (`POST /api/meows`, `POST /api/batch`) purges the cached
list entry so a create-then-reload sees the new row. Cloudflare's cache is
per-colo, so the purge is colo-local: the writer's colo is strongly consistent,
other colos refresh within the 10s TTL (globally eventually-consistent in ≤10s).
The purge is best-effort (errors ignored — staleness self-heals at TTL).

## Security

- **CORS**: strict allowlist from `CORS_ORIGINS` (default
  `https://meow.alxnko.eu.org,http://localhost:4321`). The request Origin is
  echoed only when allowlisted; credentials are allowed, so `*` is never used.
- **Auth**: `Authorization: Bearer <API_TOKEN>` on POST routes, compared in
  constant time (`constantTimeEqual`, length-aware, no early return).
- All input validated; malformed/oversized JSON → 400 (never 500).

## Secrets

`DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `API_TOKEN` are **secrets** — never in
`wrangler.jsonc`. Set before first deploy:

```sh
bun run secret:db-url     # wrangler secret put DATABASE_URL
bun run secret:db-token   # wrangler secret put DATABASE_AUTH_TOKEN
bun run secret:api-token  # wrangler secret put API_TOKEN
```

For local dev copy `.dev.vars.example` → `.dev.vars` (gitignored) and fill in.

## Scripts

```sh
bun run dev      # wrangler dev
bun run test     # vitest run --coverage (90% gate)
bun run lint     # wrangler deploy --dry-run (validates config + bundle)
bun run deploy   # wrangler deploy
```

## Testing notes

- The db client is **injected**: handlers take a structural `DbClient`, and the
  router takes a `Deps { getDb, schemaReady }`. Tests pass an in-memory fake, so
  unit tests never touch real Turso. Production builds `Deps` from env via
  `prodDeps`, lazily creating one `@libsql/client/web` client per isolate.
- Coverage excludes only `src/types.ts` (pure type declarations, no runtime
  code). Everything with branches is held to the 90% bar.
