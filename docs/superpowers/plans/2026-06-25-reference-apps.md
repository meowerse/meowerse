# Reference Apps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** One working Go + Fiber backend (`apps/api`) persisting to Turso and one Astro + React frontend (`apps/web`) calling it — end-to-end, test-first, 90% coverage, deployable to Northflank + Cloudflare Pages.

**Architecture:** `apps/api` is a Go module joined via go.work. It exposes a small `meows` resource (create + list) backed by libSQL. The store is an interface (`Store`) with a libSQL implementation; tests run against pure-Go in-memory SQLite (`modernc.org/sqlite`) so no network is needed in CI. Object storage is an interface (`Blob`) with an in-memory fake now and an R2/S3 impl gated until R2 is enabled. Auth is a bearer-token middleware reading `API_TOKEN` from env. `apps/web` is Astro with a React island that lists/creates meows via `PUBLIC_API_URL`.

**Tech Stack:** Go 1.26, Fiber v2, `github.com/tursodatabase/libsql-client-go/libsql` (pure-Go remote driver), `modernc.org/sqlite` (tests), testify, Astro 5, @astrojs/react, Vitest, Bun.

**Conventions:** TDD strictly. Verify exact third-party APIs against current docs before use (Fiber v2 `app.Test`, libsql driver DSN format, modernc driver name `sqlite`). Commit per task. Use shared `go-shared/slug` for slugging meow text → id-friendly slugs.

---

## File structure

```
apps/api/
  go.mod
  main.go                 # wiring only (logic-free → excluded from coverage gate w/ reason)
  internal/
    meow/
      meow.go             # Meow type + Store interface
      sqlite_store.go     # libSQL/sqlite-backed Store (database/sql)
      sqlite_store_test.go
      handler.go          # Fiber handlers (create/list)
      handler_test.go
    auth/
      auth.go             # bearer-token middleware
      auth_test.go
    blob/
      blob.go             # Blob interface + in-memory fake (+ test)
      blob_test.go
apps/web/
  package.json
  astro.config.mjs
  tsconfig.json
  src/pages/index.astro
  src/components/MeowList.tsx      # React island
  src/lib/api.ts                   # typed client (+ test)
  src/lib/api.test.ts
  vitest.config.ts
```

---

### Task A1: api module skeleton + health endpoint (TDD)

**Files:** Create `apps/api/go.mod`, `apps/api/main.go`, `apps/api/internal/health/health_test.go`, `.../health/health.go`. Modify `go.work`.

- [ ] **Step 1: go.mod**

```
module github.com/alxnko/meowerse/api

go 1.26

require github.com/gofiber/fiber/v2 v2.52.5
```
(Run `go get` for the exact latest v2 patch; verify version.)

- [ ] **Step 2: add to go.work**

```
go 1.26

use ./packages/go-shared
use ./apps/api
```

- [ ] **Step 3: failing test** `internal/health/health_test.go`

```go
package health

import (
	"io"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
)

func TestHealth(t *testing.T) {
	app := fiber.New()
	app.Get("/healthz", Handler)
	resp, err := app.Test(httptest.NewRequest("GET", "/healthz", nil))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != `{"status":"ok"}` {
		t.Fatalf("body = %s", body)
	}
}
```

- [ ] **Step 4: run, see fail** `cd apps/api && go test ./internal/health/` → FAIL (undefined: Handler)

- [ ] **Step 5: implement** `internal/health/health.go`

```go
package health

import "github.com/gofiber/fiber/v2"

func Handler(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{"status": "ok"})
}
```

- [ ] **Step 6: run, see pass** `go test -cover ./internal/health/` → PASS 100%

- [ ] **Step 7: minimal main.go** (wiring only)

```go
package main

import (
	"log"
	"os"

	"github.com/alxnko/meowerse/api/internal/health"
	"github.com/gofiber/fiber/v2"
)

func main() {
	app := fiber.New()
	app.Get("/healthz", health.Handler)
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Fatal(app.Listen(":" + port))
}
```

- [ ] **Step 8: commit** `feat(api): fiber skeleton + health endpoint`

---

### Task A2: Meow type + Store interface + sqlite store (TDD against in-memory sqlite)

**Files:** `internal/meow/meow.go`, `internal/meow/sqlite_store.go`, `internal/meow/sqlite_store_test.go`. Add deps `modernc.org/sqlite`, `github.com/tursodatabase/libsql-client-go/libsql`.

- [ ] **Step 1: failing test** `sqlite_store_test.go` — open `sqlite` in-memory, `Migrate`, `Create`, `List`:

```go
package meow

import (
	"context"
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

func newTestStore(t *testing.T) *SQLiteStore {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	s := NewSQLiteStore(db)
	if err := s.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestCreateAndList(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	m, err := s.Create(ctx, "Hello World")
	if err != nil {
		t.Fatal(err)
	}
	if m.Slug != "hello-world" {
		t.Fatalf("slug = %q", m.Slug)
	}
	list, err := s.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Text != "Hello World" {
		t.Fatalf("list = %+v", list)
	}
}

func TestCreateRejectsEmpty(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.Create(context.Background(), "   "); err == nil {
		t.Fatal("expected error for empty text")
	}
}
```

- [ ] **Step 2: run, see fail** `go test ./internal/meow/` → FAIL (undefined types)

- [ ] **Step 3: implement** `meow.go`

```go
package meow

import "context"

type Meow struct {
	ID        int64  `json:"id"`
	Text      string `json:"text"`
	Slug      string `json:"slug"`
	CreatedAt string `json:"created_at"`
}

type Store interface {
	Migrate(ctx context.Context) error
	Create(ctx context.Context, text string) (Meow, error)
	List(ctx context.Context) ([]Meow, error)
}
```

`sqlite_store.go`:

```go
package meow

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/alxnko/meowerse/go-shared/slug"
)

var ErrEmptyText = errors.New("meow text must not be empty")

type SQLiteStore struct{ db *sql.DB }

func NewSQLiteStore(db *sql.DB) *SQLiteStore { return &SQLiteStore{db: db} }

func (s *SQLiteStore) Migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS meows (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			text TEXT NOT NULL,
			slug TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`)
	return err
}

func (s *SQLiteStore) Create(ctx context.Context, text string) (Meow, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return Meow{}, ErrEmptyText
	}
	sl := slug.Slugify(text)
	res, err := s.db.ExecContext(ctx, `INSERT INTO meows (text, slug) VALUES (?, ?)`, text, sl)
	if err != nil {
		return Meow{}, err
	}
	id, _ := res.LastInsertId()
	var m Meow
	err = s.db.QueryRowContext(ctx, `SELECT id, text, slug, created_at FROM meows WHERE id = ?`, id).
		Scan(&m.ID, &m.Text, &m.Slug, &m.CreatedAt)
	return m, err
}

func (s *SQLiteStore) List(ctx context.Context) ([]Meow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, text, slug, created_at FROM meows ORDER BY id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Meow{}
	for rows.Next() {
		var m Meow
		if err := rows.Scan(&m.ID, &m.Text, &m.Slug, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
```

- [ ] **Step 4: run, see pass with coverage** `go test -cover ./internal/meow/` → PASS, ≥90%

- [ ] **Step 5: commit** `feat(api): meow store on sqlite/libsql with tests`

---

### Task A3: Meow HTTP handlers (TDD with real in-memory store)

**Files:** `internal/meow/handler.go`, `internal/meow/handler_test.go`.

- [ ] **Step 1: failing test** `handler_test.go` — mount handlers with a migrated in-memory store, POST then GET:

```go
package meow

import (
	"database/sql"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	_ "modernc.org/sqlite"
)

func appWithStore(t *testing.T) *fiber.App {
	db, _ := sql.Open("sqlite", ":memory:")
	s := NewSQLiteStore(db)
	if err := s.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	app := fiber.New()
	RegisterRoutes(app, s)
	return app
}

func TestPostThenGet(t *testing.T) {
	app := appWithStore(t)
	req := httptest.NewRequest("POST", "/meows", strings.NewReader(`{"text":"Meow Verse"}`))
	req.Header.Set("Content-Type", "application/json")
	resp, _ := app.Test(req)
	if resp.StatusCode != 201 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("post status=%d body=%s", resp.StatusCode, b)
	}
	resp2, _ := app.Test(httptest.NewRequest("GET", "/meows", nil))
	body, _ := io.ReadAll(resp2.Body)
	if !strings.Contains(string(body), "meow-verse") {
		t.Fatalf("list body=%s", body)
	}
}

func TestPostEmptyIs400(t *testing.T) {
	app := appWithStore(t)
	req := httptest.NewRequest("POST", "/meows", strings.NewReader(`{"text":"  "}`))
	req.Header.Set("Content-Type", "application/json")
	resp, _ := app.Test(req)
	if resp.StatusCode != 400 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
}

func TestPostBadJSONIs400(t *testing.T) {
	app := appWithStore(t)
	req := httptest.NewRequest("POST", "/meows", strings.NewReader(`not json`))
	req.Header.Set("Content-Type", "application/json")
	resp, _ := app.Test(req)
	if resp.StatusCode != 400 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
}
```
(If `t.Context()` is unavailable, use `context.Background()`.)

- [ ] **Step 2: run, see fail** → undefined: RegisterRoutes

- [ ] **Step 3: implement** `handler.go`

```go
package meow

import (
	"errors"

	"github.com/gofiber/fiber/v2"
)

func RegisterRoutes(app *fiber.App, store Store) {
	app.Post("/meows", func(c *fiber.Ctx) error {
		var in struct {
			Text string `json:"text"`
		}
		if err := c.BodyParser(&in); err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "invalid body")
		}
		m, err := store.Create(c.Context(), in.Text)
		if errors.Is(err, ErrEmptyText) {
			return fiber.NewError(fiber.StatusBadRequest, err.Error())
		}
		if err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "create failed")
		}
		return c.Status(fiber.StatusCreated).JSON(m)
	})

	app.Get("/meows", func(c *fiber.Ctx) error {
		list, err := store.List(c.Context())
		if err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "list failed")
		}
		return c.JSON(list)
	})
}
```

- [ ] **Step 4: run, see pass** `go test -cover ./internal/meow/` → PASS ≥90%
- [ ] **Step 5: commit** `feat(api): meow create/list handlers with tests`

---

### Task A4: bearer-token auth middleware (TDD)

**Files:** `internal/auth/auth.go`, `internal/auth/auth_test.go`.

- [ ] **Step 1: failing test** — middleware rejects missing/wrong token (401), allows correct:

```go
package auth

import (
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
)

func appWith(token string) *fiber.App {
	app := fiber.New()
	app.Use(RequireToken(token))
	app.Get("/x", func(c *fiber.Ctx) error { return c.SendString("ok") })
	return app
}

func TestRejectsMissing(t *testing.T) {
	resp, _ := appWith("secret").Test(httptest.NewRequest("GET", "/x", nil))
	if resp.StatusCode != 401 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
}

func TestRejectsWrong(t *testing.T) {
	req := httptest.NewRequest("GET", "/x", nil)
	req.Header.Set("Authorization", "Bearer nope")
	resp, _ := appWith("secret").Test(req)
	if resp.StatusCode != 401 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
}

func TestAllowsCorrect(t *testing.T) {
	req := httptest.NewRequest("GET", "/x", nil)
	req.Header.Set("Authorization", "Bearer secret")
	resp, _ := appWith("secret").Test(req)
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
}
```

- [ ] **Step 2: run, see fail**
- [ ] **Step 3: implement** `auth.go`

```go
package auth

import (
	"crypto/subtle"
	"strings"

	"github.com/gofiber/fiber/v2"
)

// RequireToken returns middleware enforcing "Authorization: Bearer <token>".
// Constant-time compare avoids timing leaks.
func RequireToken(token string) fiber.Handler {
	want := []byte(token)
	return func(c *fiber.Ctx) error {
		got := strings.TrimPrefix(c.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(got), want) != 1 {
			return fiber.NewError(fiber.StatusUnauthorized, "unauthorized")
		}
		return c.Next()
	}
}
```

- [ ] **Step 4: run, see pass** ≥90%
- [ ] **Step 5: commit** `feat(api): bearer-token auth middleware`

---

### Task A5: Blob storage interface + in-memory fake (R2 deferred) (TDD)

**Files:** `internal/blob/blob.go`, `internal/blob/blob_test.go`.

- [ ] **Step 1: failing test** — Put then Get round-trips; Get missing → ErrNotFound:

```go
package blob

import (
	"context"
	"testing"
)

func TestPutGet(t *testing.T) {
	s := NewMemory()
	ctx := context.Background()
	if err := s.Put(ctx, "k", []byte("v")); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ctx, "k")
	if err != nil || string(got) != "v" {
		t.Fatalf("got=%q err=%v", got, err)
	}
}

func TestGetMissing(t *testing.T) {
	if _, err := NewMemory().Get(context.Background(), "nope"); err != ErrNotFound {
		t.Fatalf("err=%v", err)
	}
}
```

- [ ] **Step 2: run, see fail**
- [ ] **Step 3: implement** `blob.go`

```go
package blob

import (
	"context"
	"errors"
	"sync"
)

var ErrNotFound = errors.New("blob not found")

// Blob is the object-storage port. Memory impl now; an R2/S3 impl lands when
// R2 is enabled (needs a payment method) — same interface, swap in main.
type Blob interface {
	Put(ctx context.Context, key string, data []byte) error
	Get(ctx context.Context, key string) ([]byte, error)
}

type Memory struct {
	mu sync.RWMutex
	m  map[string][]byte
}

func NewMemory() *Memory { return &Memory{m: map[string][]byte{}} }

func (s *Memory) Put(_ context.Context, key string, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := make([]byte, len(data))
	copy(cp, data)
	s.m[key] = cp
	return nil
}

func (s *Memory) Get(_ context.Context, key string) ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	v, ok := s.m[key]
	if !ok {
		return nil, ErrNotFound
	}
	return v, nil
}
```

- [ ] **Step 4: run, see pass** ≥90%
- [ ] **Step 5: commit** `feat(api): blob storage port + memory impl (R2 deferred)`

---

### Task A6: wire main.go with Turso + auth + coverage exclusion

**Files:** Modify `apps/api/main.go`. Modify root `justfile` `COVERAGE_IGNORE`.

- [ ] **Step 1: update main.go** — open libSQL via env, migrate, mount auth + routes:

```go
package main

import (
	"context"
	"database/sql"
	"log"
	"os"

	"github.com/alxnko/meowerse/api/internal/auth"
	"github.com/alxnko/meowerse/api/internal/health"
	"github.com/alxnko/meowerse/api/internal/meow"
	"github.com/gofiber/fiber/v2"
	_ "github.com/tursodatabase/libsql-client-go/libsql"
)

func main() {
	dsn := os.Getenv("DATABASE_URL") + "?authToken=" + os.Getenv("DATABASE_AUTH_TOKEN")
	db, err := sql.Open("libsql", dsn)
	if err != nil {
		log.Fatal(err)
	}
	store := meow.NewSQLiteStore(db)
	if err := store.Migrate(context.Background()); err != nil {
		log.Fatal(err)
	}

	app := fiber.New()
	app.Get("/healthz", health.Handler)
	api := app.Group("/api", auth.RequireToken(os.Getenv("API_TOKEN")))
	meow.RegisterRoutes(api, store)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Fatal(app.Listen(":" + port))
}
```
(Verify the libsql DSN format against the driver's current README — some versions want `libsql://host?authToken=...`, others a separate connector. Adjust if `go test`/build reveals a different signature.)

- [ ] **Step 2: declare the coverage exclusion honestly** in `justfile` — `main.go` is logic-free wiring. Adjust `test-go` so the gate computes coverage excluding `apps/api/main.go` (e.g. build coverage with `-coverpkg=./internal/...` for the api module, or drop the `main` package from the profile), and document WHY in the `COVERAGE_IGNORE` comment: `apps/api (main.go = wiring, no branching logic)`.

- [ ] **Step 3: build + vet** `cd apps/api && go build ./... && go vet ./...` → clean
- [ ] **Step 4: full gate** `just test` → all packages ≥90%, exit 0
- [ ] **Step 5: integration smoke (optional, needs .env)** export DATABASE_URL/TOKEN/API_TOKEN, run the server, `curl -H "Authorization: Bearer $API_TOKEN" localhost:8080/api/meows` → `[]`. Document result.
- [ ] **Step 6: commit** `feat(api): wire libsql + auth, exclude main from coverage with reason`

---

### Task A7: Dockerfile for Northflank

**Files:** `apps/api/Dockerfile`, `apps/api/.dockerignore`.

- [ ] **Step 1: multi-stage Dockerfile**

```dockerfile
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY apps/api/go.mod apps/api/go.sum ./apps/api/
COPY packages/go-shared/go.mod ./packages/go-shared/
COPY go.work ./
RUN cd apps/api && go mod download
COPY . .
RUN cd apps/api && CGO_ENABLED=0 go build -o /out/api .

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/api /api
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/api"]
```
(Build context = repo root so go.work + go-shared resolve. Verify `docker build -f apps/api/Dockerfile .` succeeds if docker is available; otherwise note skipped.)

- [ ] **Step 2: .dockerignore** — `node_modules`, `**/dist`, `.git`, `**/*_test.go`
- [ ] **Step 3: commit** `build(api): distroless Dockerfile for Northflank`

---

### Task W1: Astro web skeleton (Bun) + typed API client (TDD)

**Files:** `apps/web/package.json`, `astro.config.mjs`, `tsconfig.json`, `vitest.config.ts`, `src/lib/api.ts`, `src/lib/api.test.ts`.

- [ ] **Step 1: package.json**

```json
{
  "name": "@meowerse/web",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "lint": "astro check",
    "test": "vitest run --coverage"
  },
  "dependencies": {
    "astro": "^5.0.0",
    "@astrojs/react": "^4.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "vitest": "^4.1.9",
    "@vitest/coverage-v8": "^4.1.9",
    "@astrojs/check": "^0.9.0",
    "typescript": "^6.0.0"
  }
}
```
(Resolve exact latest versions with `bun add` rather than hand-pinning if any fail to install.)

- [ ] **Step 2: failing test** `src/lib/api.test.ts` — `listMeows` calls `${base}/api/meows` with bearer header and returns parsed JSON; uses a stubbed `fetch`:

```ts
import { afterEach, expect, test, vi } from "vitest";
import { listMeows, createMeow } from "./api";

afterEach(() => vi.restoreAllMocks());

test("listMeows GETs with bearer and parses", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify([{ id: 1, text: "hi", slug: "hi", created_at: "" }]), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const out = await listMeows("http://x", "tok");
  expect(fetchMock).toHaveBeenCalledWith("http://x/api/meows", {
    headers: { Authorization: "Bearer tok" },
  });
  expect(out[0].slug).toBe("hi");
});

test("createMeow POSTs json", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: 2, text: "yo", slug: "yo", created_at: "" }), { status: 201 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const m = await createMeow("http://x", "tok", "yo");
  expect(m.slug).toBe("yo");
  const [, opts] = fetchMock.mock.calls[0];
  expect(opts.method).toBe("POST");
});

test("listMeows throws on non-ok", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("err", { status: 500 })));
  await expect(listMeows("http://x", "tok")).rejects.toThrow();
});
```

- [ ] **Step 3: run, see fail** `cd apps/web && bunx vitest run src/lib/api.test.ts`
- [ ] **Step 4: implement** `src/lib/api.ts`

```ts
export interface Meow {
  id: number;
  text: string;
  slug: string;
  created_at: string;
}

export async function listMeows(base: string, token: string): Promise<Meow[]> {
  const res = await fetch(`${base}/api/meows`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  return res.json() as Promise<Meow[]>;
}

export async function createMeow(base: string, token: string, text: string): Promise<Meow> {
  const res = await fetch(`${base}/api/meows`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  return res.json() as Promise<Meow>;
}
```

- [ ] **Step 5: vitest.config.ts** with v8 coverage thresholds 90% (exclude `*.astro`, `*.config.*`, `src/components/**` if DOM-heavy — document any exclusion):

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
      include: ["src/lib/**"],
    },
  },
});
```
(Scoping coverage `include` to `src/lib/**` is the honest exclusion: only testable logic is gated; `.astro` pages and the React island are smoke-checked by `astro check`/build, not the coverage gate. Document this in the config + README.)

- [ ] **Step 6: run, see pass** ≥90% on `src/lib`
- [ ] **Step 7: commit** `feat(web): astro skeleton + typed api client with tests`

---

### Task W2: Astro page + React island

**Files:** `astro.config.mjs`, `src/pages/index.astro`, `src/components/MeowList.tsx`, `tsconfig.json`.

- [ ] **Step 1: astro.config.mjs**

```js
import { defineConfig } from "astro/config";
import react from "@astrojs/react";

export default defineConfig({ integrations: [react()] });
```

- [ ] **Step 2: tsconfig.json**

```json
{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "react" }
}
```

- [ ] **Step 3: MeowList.tsx** — island that fetches on mount and renders a list + create form. Uses `PUBLIC_API_URL` (and a public, non-secret demo token via prop). Keep logic minimal; the testable parts live in `src/lib/api.ts` already covered.

```tsx
import { useEffect, useState } from "react";
import { listMeows, createMeow, type Meow } from "../lib/api";

export default function MeowList({ base, token }: { base: string; token: string }) {
  const [meows, setMeows] = useState<Meow[]>([]);
  const [text, setText] = useState("");
  useEffect(() => {
    listMeows(base, token).then(setMeows).catch(() => {});
  }, [base, token]);
  async function add() {
    if (!text.trim()) return;
    const m = await createMeow(base, token, text);
    setMeows((prev) => [m, ...prev]);
    setText("");
  }
  return (
    <div>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="meow..." />
      <button onClick={add}>add</button>
      <ul>{meows.map((m) => <li key={m.id}>{m.text} <code>{m.slug}</code></li>)}</ul>
    </div>
  );
}
```

- [ ] **Step 4: index.astro**

```astro
---
const base = import.meta.env.PUBLIC_API_URL ?? "http://localhost:8080";
const token = import.meta.env.PUBLIC_DEMO_TOKEN ?? "";
import MeowList from "../components/MeowList.tsx";
---
<html lang="en">
  <head><meta charset="utf-8" /><title>meowerse</title></head>
  <body>
    <h1>meowerse</h1>
    <MeowList client:load base={base} token={token} />
  </body>
</html>
```

- [ ] **Step 5: build** `cd apps/web && bun run build` → succeeds, emits `dist/`
- [ ] **Step 6: commit** `feat(web): astro page + react island`

---

### Task D1: CI extension + Pages/Northflank deploy workflows

**Files:** Modify `.github/workflows/ci.yml`; create `.github/workflows/deploy.yml`.

- [ ] **Step 1: ensure CI covers new apps** — `just test`/`just lint` already loop all go.mod dirs + Bun workspaces; confirm `apps/api` + `apps/web` are picked up (they are via go.work + workspaces). Add Go module cache + `apps/web` build to CI if not implicit. Run locally to confirm green.

- [ ] **Step 2: deploy.yml** (main only): build web (`bun run build` in apps/web) → `wrangler pages deploy apps/web/dist --project-name meowerse-web`; deploy worker (`wrangler deploy` in workers/edge); trigger Northflank api rebuild via API using `NORTHFLANK_API_TOKEN`, pushing `DATABASE_URL`/`DATABASE_AUTH_TOKEN`/`API_TOKEN` as Northflank secrets. Each step guarded by `if: secrets.* != ''` so a missing secret skips rather than fails.

```yaml
name: deploy
on:
  push: { branches: [main] }
jobs:
  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run --filter @meowerse/web build
      - if: ${{ env.CF_TOKEN != '' }}
        env:
          CF_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: bunx wrangler pages deploy apps/web/dist --project-name meowerse-web
```
(Worker + Northflank jobs follow the same guarded pattern; fill exact Northflank API calls from their docs at implementation time.)

- [ ] **Step 3: validate YAML** parses; commit `ci: deploy workflows for web/worker/api`

---

### Task D2: Cloudflare Pages project via Terraform

**Files:** `infra/terraform/pages.tf`, `infra/terraform/outputs.tf` (extend).

- [ ] **Step 1: introspect** `cloudflare_pages_project` schema (`terraform providers schema -json`) for exact v5 attribute names — do NOT assume v4 shape.
- [ ] **Step 2: define** `cloudflare_pages_project "web"` (name `meowerse-web`, production branch `main`, build config for Astro: build command `bun run build`, output dir `apps/web/dist`, root dir `apps/web`), with `PUBLIC_API_URL` env var. Use GitHub source integration (owner `alxnko`, repo `meowerse`).
- [ ] **Step 3: plan** — review carefully; this CREATES a Pages project (safe, new). Apply only after user confirms. Output the `*.pages.dev` subdomain.
- [ ] **Step 4: commit** `feat(infra): cloudflare pages project for web`

---

## Self-Review

**Spec coverage:** Go Fiber api ✓, Turso persistence ✓ (A2/A6), auth stub ✓ (A4), R2/object-storage interface with deferral ✓ (A5), Astro+React web ✓ (W1/W2), end-to-end client ✓ (W1), tests ≥90% with honest exclusions ✓ (A6 main.go, W1 src/lib scope), Northflank Dockerfile ✓ (A7), deploy wiring ✓ (D1), Pages via TF ✓ (D2). Worker already imported (prior work).

**Placeholder scan:** Third-party API specifics (libsql DSN, Fiber test API, v5 Pages schema, Northflank API) are flagged for verification-at-implementation rather than guessed — these are external contracts, not internal placeholders. All internal types (Meow, Store, Blob, listMeows/createMeow) are fully defined and used consistently.

**Type consistency:** `Meow{ID,Text,Slug,CreatedAt}` identical across Go (json tags) and TS interface. `Store`/`SQLiteStore`/`NewSQLiteStore`, `RegisterRoutes`, `RequireToken`, `Blob`/`NewMemory`, `listMeows`/`createMeow` consistent across tasks.

---

## Execution order

A1→A2→A3→A4→A5→A6→A7 (api, shippable), then W1→W2 (web), then D1→D2 (deploy). Apply steps (TF apply, Northflank, live Pages) gated on user confirmation.
