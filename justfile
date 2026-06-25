# meowerse task layer
#
# COVERAGE_IGNORE:
#   Honest exclusion list for the Go coverage gate. Each entry names a package
#   path that is excluded from coverage measurement WITH a written reason.
#   Never cherry-pick packages to inflate coverage — exclusions must be for
#   genuinely logic-free code, justified below.
#
#   Excluded packages (regex matched against `go list ./...` import paths):
#     - github.com/meowerse/meowerse/api  (apps/api/main.go)
#         Reason: main.go is pure wiring — it opens the libSQL connector from
#         env, runs Migrate, mounts health + auth + meow routes, and calls
#         Listen. There are no branches or business logic to test; the logic it
#         wires (health, meow, auth, blob) is each covered >=90% in ./internal.
#         The gate therefore measures the api module over ./internal/... only,
#         so main.go's lack of tests cannot game the number, and every other
#         package is held to the real 90% bar.
COVERAGE_IGNORE := "github.com/meowerse/meowerse/api$"

set shell := ["bash", "-uc"]

# Minimum Go coverage percentage enforced by `just test-go`.
COVERAGE_MIN := "90"

# List all available recipes.
default:
    @just --list

# Install JS workspace dependencies.
install:
    bun install

# Run all tests (JS + Go) with coverage gates.
test: test-js test-go

# Run JS workspace tests via Turbo.
test-js:
    bun run test

# Run Go tests for every module, enforcing the {{COVERAGE_MIN}}% coverage gate.
test-go:
    #!/usr/bin/env bash
    set -euo pipefail
    min="{{COVERAGE_MIN}}"
    ignore="{{COVERAGE_IGNORE}}"
    found=0
    while IFS= read -r modfile; do
        dir="$(dirname "$modfile")"
        found=1
        echo "==> go test in $dir"
        (
            cd "$dir"
            # Build the package list, dropping any COVERAGE_IGNORE entries
            # (documented logic-free packages, e.g. apps/api/main.go wiring).
            if [ -n "$ignore" ]; then
                pkgs="$(go list ./... | grep -Ev "$ignore" || true)"
            else
                pkgs="$(go list ./...)"
            fi
            if [ -z "$pkgs" ]; then
                echo "    no testable packages after exclusions"
                exit 0
            fi
            go test -coverprofile=coverage.out -covermode=atomic $pkgs
            total="$(go tool cover -func=coverage.out | awk '/^total:/ {sub(/%/,"",$3); print $3}')"
            echo "    total coverage: ${total}%"
            awk -v t="$total" -v m="$min" 'BEGIN { exit (t+0 < m+0) ? 1 : 0 }' \
                || { echo "    FAIL: coverage ${total}% < ${min}% in $dir"; exit 1; }
        )
    done < <(find . -name go.mod -not -path '*/node_modules/*')
    if [ "$found" -eq 0 ]; then
        echo "No Go modules found."
    fi

# Run all linters (JS + Go).
lint: lint-js lint-go

# Lint the JS workspace via Turbo.
lint-js:
    bun run lint

# Lint every Go module: gofmt must be clean and go vet must pass.
lint-go:
    #!/usr/bin/env bash
    set -euo pipefail
    while IFS= read -r modfile; do
        dir="$(dirname "$modfile")"
        echo "==> lint Go in $dir"
        (
            cd "$dir"
            unformatted="$(gofmt -l .)"
            if [ -n "$unformatted" ]; then
                echo "    FAIL: gofmt needed on:"
                echo "$unformatted"
                exit 1
            fi
            go vet ./...
        )
    done < <(find . -name go.mod -not -path '*/node_modules/*')

# Build the JS workspace via Turbo.
build:
    bun run build

# Show deploy status per service: deployed SHA vs source SHA (+ dirty flag).
deploy-status:
    bash infra/deploy-status.sh

# Build + push the Go api image to GHCR and upsert the Northflank service.
# Reads secrets from .env. Refuses dirty api source unless ALLOW_DIRTY=1.
deploy-api:
    bash -c 'set -a; source .env; set +a; bash infra/northflank/deploy.sh'

# Deploy the web app to Cloudflare Pages (direct upload) + record version.
deploy-web:
    #!/usr/bin/env bash
    set -euo pipefail
    set -a; source .env; set +a
    if git status --porcelain -- apps/web packages/ts-shared | grep -q .; then
        [ "${ALLOW_DIRTY:-0}" = "1" ] || { echo "ERROR: uncommitted web changes. commit or ALLOW_DIRTY=1"; exit 1; }
    fi
    ASTRO_TELEMETRY_DISABLED=1 bun run --filter @meowerse/web build
    bunx wrangler pages deploy apps/web/dist --project-name meowerse-web --commit-hash "$(git rev-parse HEAD)"
    bash infra/record-deploy.sh web "$(git rev-parse --short HEAD)"

# Deploy the edge worker via wrangler + record version.
deploy-worker:
    #!/usr/bin/env bash
    set -euo pipefail
    set -a; source .env; set +a
    if git status --porcelain -- workers/edge | grep -q .; then
        [ "${ALLOW_DIRTY:-0}" = "1" ] || { echo "ERROR: uncommitted worker changes. commit or ALLOW_DIRTY=1"; exit 1; }
    fi
    (cd workers/edge && bunx wrangler deploy --message "$(git rev-parse --short HEAD)")
    bash infra/record-deploy.sh worker "$(git rev-parse --short HEAD)"
