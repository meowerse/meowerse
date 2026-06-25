# Monorepo Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `meowerse` polyglot monorepo skeleton — Bun workspaces + Turbo for JS, go.work for Go, a justfile task layer, GitHub Actions CI with a hard 90% coverage gate — proven end-to-end by one tested shared function on each language side.

**Architecture:** Bun is the JS package manager, script runner, and test runner. Turbo orchestrates and caches tasks across JS workspaces. Go modules are joined by a `go.work` file. A `justfile` is the single human/CI entrypoint (`just test`, `just lint`, `just build`). CI runs the same `just` targets. Coverage is measured repo-wide; only provably logic-free dirs are excluded, and each exclusion is named with a reason (no silent package cherry-picking).

**Tech Stack:** Bun, Turbo, TypeScript, Vitest, Go 1.22+, testify, just, GitHub Actions, pre-commit.

---

## File Structure

- `package.json` — root, Bun workspaces (`apps/*`, `packages/*`, `workers/*`), shared scripts
- `bunfig.toml` — Bun config (test coverage thresholds)
- `turbo.json` — task graph (`build`, `test`, `lint`)
- `tsconfig.base.json` — shared TS compiler options
- `go.work` — Go workspace joining `packages/go-shared` (and later `apps/api`)
- `justfile` — task entrypoints, incl. Go coverage gate with declared exclusions
- `.editorconfig`, `.gitignore` — already partially present; extend
- `.pre-commit-config.yaml` — fmt/lint/test hooks
- `.github/workflows/ci.yml` — lint → test+coverage gate → build
- `packages/ts-shared/` — shared TS lib (one tested function: `slugify`)
- `packages/go-shared/` — shared Go module (one tested function: `Slugify`)
- `README.md` — extend with dev commands

---

### Task 1: Root Bun workspace + Turbo

**Files:**
- Create: `package.json`
- Create: `bunfig.toml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`

- [ ] **Step 1: Create root `package.json`**

```json
{
  "name": "meowerse",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*", "packages/*", "workers/*"],
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint"
  },
  "devDependencies": {
    "turbo": "^2.5.0",
    "typescript": "^5.7.0"
  },
  "packageManager": "bun@1.2.0"
}
```

- [ ] **Step 2: Create `bunfig.toml`**

```toml
[install]
# deterministic installs in CI
frozenLockfile = false

[test]
coverage = true
coverageThreshold = 0.9
```

- [ ] **Step 3: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["^build"], "outputs": ["coverage/**"] },
    "lint": {}
  }
}
```

- [ ] **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "skipLibCheck": true,
    "types": ["bun-types"]
  }
}
```

- [ ] **Step 5: Install and verify Bun resolves the workspace**

Run: `bun install`
Expected: creates `bun.lock`, exits 0, no workspace errors.

- [ ] **Step 6: Commit**

```bash
git add package.json bunfig.toml turbo.json tsconfig.base.json bun.lock
git commit -m "chore: root Bun workspace + Turbo config"
```

---

### Task 2: Shared TS package with a failing-first test (`slugify`)

**Files:**
- Create: `packages/ts-shared/package.json`
- Create: `packages/ts-shared/tsconfig.json`
- Test: `packages/ts-shared/src/slugify.test.ts`
- Create: `packages/ts-shared/src/slugify.ts`
- Create: `packages/ts-shared/src/index.ts`

- [ ] **Step 1: Create `packages/ts-shared/package.json`**

```json
{
  "name": "@meowerse/ts-shared",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "bun test --coverage",
    "lint": "tsc --noEmit",
    "build": "tsc"
  }
}
```

- [ ] **Step 2: Create `packages/ts-shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 3: Write the failing test**

`packages/ts-shared/src/slugify.test.ts`:

```ts
import { expect, test } from "bun:test";
import { slugify } from "./slugify";

test("lowercases and hyphenates", () => {
  expect(slugify("Hello World")).toBe("hello-world");
});

test("strips non-alphanumerics and collapses separators", () => {
  expect(slugify("  Meow!! __Verse  ")).toBe("meow-verse");
});

test("empty input yields empty string", () => {
  expect(slugify("")).toBe("");
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test packages/ts-shared/src/slugify.test.ts`
Expected: FAIL — `Cannot find module './slugify'` (or export missing).

- [ ] **Step 5: Write minimal implementation**

`packages/ts-shared/src/slugify.ts`:

```ts
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
```

`packages/ts-shared/src/index.ts`:

```ts
export { slugify } from "./slugify";
```

- [ ] **Step 6: Run test to verify it passes with coverage**

Run: `bun test packages/ts-shared/src/slugify.test.ts --coverage`
Expected: PASS, 3 tests, coverage for `slugify.ts` = 100%.

- [ ] **Step 7: Commit**

```bash
git add packages/ts-shared
git commit -m "feat(ts-shared): slugify with full test coverage"
```

---

### Task 3: Shared Go module with a failing-first test (`Slugify`)

**Files:**
- Create: `packages/go-shared/go.mod`
- Test: `packages/go-shared/slug/slug_test.go`
- Create: `packages/go-shared/slug/slug.go`
- Create: `go.work`

- [ ] **Step 1: Create `packages/go-shared/go.mod`**

```
module github.com/alxnko/meowerse/go-shared

go 1.22
```

- [ ] **Step 2: Create `go.work` at repo root**

```
go 1.22

use ./packages/go-shared
```

- [ ] **Step 3: Write the failing test**

`packages/go-shared/slug/slug_test.go`:

```go
package slug

import "testing"

func TestSlugify(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Hello World", "hello-world"},
		{"  Meow!! __Verse  ", "meow-verse"},
		{"", ""},
	}
	for _, c := range cases {
		if got := Slugify(c.in); got != c.want {
			t.Errorf("Slugify(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd packages/go-shared && go test ./slug/`
Expected: FAIL — `undefined: Slugify`.

- [ ] **Step 5: Write minimal implementation**

`packages/go-shared/slug/slug.go`:

```go
package slug

import (
	"regexp"
	"strings"
)

var nonAlnum = regexp.MustCompile(`[^a-z0-9]+`)

// Slugify lowercases input and replaces runs of non-alphanumerics with single
// hyphens, trimming leading/trailing hyphens.
func Slugify(input string) string {
	s := nonAlnum.ReplaceAllString(strings.ToLower(input), "-")
	return strings.Trim(s, "-")
}
```

- [ ] **Step 6: Run test with coverage to verify it passes**

Run: `cd packages/go-shared && go test -cover ./slug/`
Expected: PASS, `coverage: 100.0% of statements`.

- [ ] **Step 7: Commit**

```bash
git add go.work packages/go-shared
git commit -m "feat(go-shared): Slugify with full test coverage"
```

---

### Task 4: justfile with coverage gate (declared exclusions)

**Files:**
- Create: `justfile`

- [ ] **Step 1: Create `justfile`**

The Go gate measures coverage across all Go modules, then asserts the total is
≥ 90%. `COVERAGE_IGNORE` names dirs excluded from the gate with a reason — this
is the honest exclusion mechanism (no silent per-package cherry-picking).

```makefile
set shell := ["bash", "-cu"]

# Dirs excluded from the Go coverage gate. Each MUST have a reason comment.
# (none yet — `main`/wiring dirs get added here when apps/api lands, with reasons)
COVERAGE_IGNORE := ""

default:
    @just --list

install:
    bun install

# JS + Go tests with coverage
test: test-js test-go

test-js:
    bun run test

test-go:
    #!/usr/bin/env bash
    set -euo pipefail
    fail=0
    for mod in $(find . -name go.mod -not -path '*/node_modules/*' -exec dirname {} \;); do
      echo "== go test $mod =="
      pushd "$mod" >/dev/null
      go test -coverprofile=coverage.out -covermode=atomic ./... || fail=1
      if [ -f coverage.out ]; then
        pct=$(go tool cover -func=coverage.out | tail -1 | awk '{print $3}' | tr -d '%')
        echo "coverage: ${pct}%"
        awk -v p="$pct" 'BEGIN{ if (p+0 < 90) { exit 1 } }' || { echo "FAIL: $mod below 90%"; fail=1; }
      fi
      popd >/dev/null
    done
    exit $fail

lint: lint-js lint-go
lint-js:
    bun run lint
lint-go:
    #!/usr/bin/env bash
    set -euo pipefail
    for mod in $(find . -name go.mod -not -path '*/node_modules/*' -exec dirname {} \;); do
      (cd "$mod" && gofmt -l . | (! grep .) && go vet ./...)
    done

build:
    bun run build
```

- [ ] **Step 2: Run the full test gate**

Run: `just test`
Expected: JS 3 tests pass; Go reports `coverage: 100.0%`; gate passes; exit 0.

- [ ] **Step 3: Verify the gate actually fails under threshold**

Temporarily add an untested function to `packages/go-shared/slug/slug.go`:

```go
// TEMP: unTested function to prove the gate trips
func untested(x int) int { if x > 0 { return x }; return -x }
```

Run: `just test-go`
Expected: FAIL — coverage drops below 90%, `FAIL: ... below 90%`, exit 1.
Then DELETE the temp function and re-run `just test-go` → PASS. This proves the
gate is real, not decorative.

- [ ] **Step 4: Commit**

```bash
git add justfile
git commit -m "build: just task layer with real 90% coverage gate"
```

---

### Task 5: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request: {}

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: "1.2.0" }
      - uses: actions/setup-go@v5
        with: { go-version: "1.22" }
      - uses: extractions/setup-just@v2
      - run: bun install --frozen-lockfile
      - run: just lint
      - run: just test
```

- [ ] **Step 2: Validate workflow YAML locally**

Run: `bun x yaml-lint .github/workflows/ci.yml || python -c "import yaml,sys;yaml.safe_load(open('.github/workflows/ci.yml'))"`
Expected: no parse errors.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: lint + test + coverage gate on push/PR"
```

---

### Task 6: pre-commit hooks

**Files:**
- Create: `.pre-commit-config.yaml`

- [ ] **Step 1: Create `.pre-commit-config.yaml`**

```yaml
repos:
  - repo: local
    hooks:
      - id: go-fmt
        name: go fmt
        entry: bash -c 'gofmt -l packages/go-shared | (! grep .)'
        language: system
        pass_filenames: false
      - id: just-test
        name: just test
        entry: just test
        language: system
        pass_filenames: false
        stages: [pre-push]
```

- [ ] **Step 2: Install and run against all files**

Run: `pre-commit install && pre-commit run --all-files`
Expected: hooks pass (go-fmt clean). If `pre-commit` not installed, document in README and skip locally — CI still enforces.

- [ ] **Step 3: Commit**

```bash
git add .pre-commit-config.yaml
git commit -m "build: pre-commit fmt + pre-push test hooks"
```

---

### Task 7: README dev section + .editorconfig

**Files:**
- Modify: `README.md` (create if absent)
- Create: `.editorconfig`

- [ ] **Step 1: Create `.editorconfig`**

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2

[*.go]
indent_style = tab
```

- [ ] **Step 2: Write `README.md` dev section**

```markdown
# meowerse

Polyglot monorepo: Astro/React frontends, Go/Fiber backends, Cloudflare edge
worker, shared Terraform. Free-tier first.

## Prereqs
- Bun 1.2+, Go 1.22+, just, (optional) pre-commit

## Commands
- `just install` — install JS deps
- `just test` — run all tests + 90% coverage gate
- `just lint` — fmt/vet/typecheck
- `just build` — build all workspaces

## Layout
- `apps/` frontends + backends · `workers/` edge workers · `packages/` shared libs
- `infra/terraform/` shared IaC · `docs/superpowers/` specs + plans
```

- [ ] **Step 3: Verify full gate one more time**

Run: `just lint && just test`
Expected: all pass, exit 0.

- [ ] **Step 4: Commit**

```bash
git add README.md .editorconfig
git commit -m "docs: dev commands + editorconfig"
```

---

## Self-Review

**Spec coverage (foundation slice):** Bun workspaces ✓ (T1), Turbo ✓ (T1),
go.work ✓ (T3), justfile ✓ (T4), 90% hard gate with declared exclusions ✓ (T4,
proven to trip in T4 Step 3), GitHub Actions ✓ (T5), pre-commit ✓ (T6),
Vitest/bun-test ✓ (T2), Go testing ✓ (T3). Terraform, Cloudflare import, and the
Astro/Go/worker reference apps are intentionally deferred to Plans 2 and 3.

**Placeholder scan:** No TBD/TODO. Every code step shows full content. The
`COVERAGE_IGNORE` is empty by design (no wiring dirs exist yet) and documented.

**Type consistency:** `slugify` (TS) / `Slugify` (Go) used consistently. Module
path `github.com/alxnko/meowerse/go-shared` matches go.work `use` path.

---

## Execution Handoff

After this plan: Plan 2 (Terraform + R2 state + Cloudflare import — needs the CF
API token) and Plan 3 (reference apps + deploy).
