# Verification gates

What each required check proves, and the audit of anything that can pass without running.

## Required in hosted CI (`.github/workflows/ci.yml`, `test` job)

| Step | Command | Proves |
|---|---|---|
| Lint | `just lint` | `astro check` for every app, `tsc --noEmit` for every package, `wrangler deploy --dry-run` for every worker |
| Typecheck | `just typecheck` | each worker's production code (`tsconfig.json`, no tests) and test code (`tsconfig.test.json`, `@types/node`) type-check with 0 errors; the self-test proves the gate fails on a type error |
| Test | `just test` | vitest/bun suites with 90% coverage thresholds |

`wrangler --dry-run` only bundles (esbuild strips types), so it is NOT a typecheck; that is why `typecheck` is a separate step.
Worker configs: `tsconfig.json` is prod-only (excludes `*.test.ts` and `test/`); `tsconfig.test.json` adds `node` types for the `node:fs`/`node:sqlite` realsql tests. Both extend `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`). Do not add `@ts-ignore`/`@ts-expect-error`/`any` to get green; narrow, or use the `at()` test helper (`test/at.ts`) for indexed access.

Self-test: `scripts/typecheck-selftest.test.ts` writes deliberately bad fixtures next to each worker's real tsconfig and asserts non-zero exit, and that clean fixtures exit zero.

## Skip / vacuous-gate audit

| Where | Pattern | Class | Action |
|---|---|---|---|
| `workers/meowsenger/package.json` `test`, `test:do` | `--passWithNoTests` on the workers (workerd) pool | vacuous: a broken include glob would pass with zero Durable Object tests | removed; vitest now errors on "no test files" |
| `apps/web/tests/e2e/shell.spec.ts` (B16 build scan) | loop over `dist` html/js with no minimum count | vacuous when `dist` is empty | added `files.length > 0` assertion |
| `apps/web/tests/e2e/*.spec.ts` `test.skip(info.project.name !== ...)` | per-viewport/browser dedupe (the scan runs once, Chromium-only feature) | legit: the same assertion runs in one project | none |
| `apps/web/tests/e2e/screenshots.spec.ts` | `test.skip(!!process.env.CI)` | legit, documented: CI runner fonts differ; compared on the release machine | none; screenshots are NOT a CI gate |
| `packages/ui/scripts/tokens-drift.ts` | exits 0 with a notice when the private alxnko.dev checkout is absent and `CI` is set | legit, documented; hard failure locally. Not run by ci.yml | none (release checklist item) |
| `workers/auth/test/delete-acceptance.e2e.test.ts` | `REMOTE` opt-in against a real Turso | legit: local in-memory path always runs; remote is a manual acceptance run | none |
| `if (!res.ok) return;` in worker tests (auth `userinfo`/`accounts`, meowsenger `members`/`invites`/`chats`) | type narrowing right after `expect(res.ok).toBe(true)` | legit: the expect fails first | none |
| `workers/meowsenger/vitest.config.ts` coverage excludes `conversation.ts`, `inbox.ts` | covered only by the workers pool, which has no coverage threshold | weak (not vacuous): DO logic has no numeric gate | documented; follow-up if a coverage provider for workerd is adopted |
| `apps/meowsenger-web/vitest.config.ts` | branch threshold 87 (others 90) | legit, justified in the config | none |
| `workers/*/vitest.config.ts` `exclude: ["src/types.ts"]`, `packages/ui` `renderer.ts` | type-only file / WebGL not in jsdom (verified by `cat-poster.ts` in Chromium) | legit | none |
| `infra/turso/bootstrap.sh` `\|\| true` | idempotent "already exists" creates | legit: not a gate | none |
| `.github/workflows/*.yml` | `continue-on-error`, `\|\| true` | none present | none |
| `.skip`/`.only`/`.todo`/`skipIf`/`runIf` in vitest/bun tests | none present | n/a | none |
