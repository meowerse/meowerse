# meowerse task layer
#
# COVERAGE_IGNORE := ""
#   Honest exclusion list for the Go coverage gate. It is intentionally EMPTY.
#   When a directory must be excluded later, add it here WITH a written reason.
#   Never cherry-pick packages to inflate coverage — the gate measures the
#   whole module (go test ./...).

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
    found=0
    while IFS= read -r modfile; do
        dir="$(dirname "$modfile")"
        found=1
        echo "==> go test in $dir"
        (
            cd "$dir"
            go test -coverprofile=coverage.out -covermode=atomic ./...
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
