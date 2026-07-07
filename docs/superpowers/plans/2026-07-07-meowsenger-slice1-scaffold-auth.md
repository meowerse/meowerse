# meowsenger Slice 1 — Scaffold + Auth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `workers/meowsenger` (router Worker + D1) and `apps/meowsenger-web` (Astro shell) with working OIDC login via auth.alxnko.eu.org behind a server-side BFF session — a deployable "logged-in empty shell" that proves identity end to end.

**Architecture:** The Astro UI has no accounts of its own; a "log in" link hits the Worker's `/auth/login`, which runs OIDC Authorization-Code + PKCE against auth.alxnko.eu.org. The Worker's `/auth/callback` exchanges the code, verifies the id_token (JWKS), fetches `/userinfo`, upserts the user into D1, creates a server-side session, and sets a `__Host-mw_session` cookie. Every UI call to the Worker authenticates by that cookie (BFF pattern) — no tokens ever reach the browser. Realtime (Durable Objects) is Slice 2; this slice is REST-only.

**Tech Stack:** Cloudflare Workers (workerd), D1 (SQLite), Astro 7 static + React 19 islands, `@meowerse/auth` (RP SDK), `@meowerse/auth-shared` (crypto helpers), `@meowerse/ui` (design system), vitest, wrangler, bun workspaces + turbo.

**Spec:** `docs/superpowers/specs/2026-07-07-meowsenger-design.md` (§3, §4.1, §5, §11).

---

## Shared contracts (referenced by every task — define once, reuse verbatim)

These names/shapes are used across tasks. Do not rename them between tasks.

**Cookie names:** `__Host-mw_session` (the session id), `__Host-mw_txn` (the short pre-auth PKCE transaction). Both are host-scoped to `meowsenger-api.alxnko.eu.org`; `__Host-` forbids a `Domain` attribute, so they are set/read only on the Worker host. The UI (different subdomain) never reads them — it calls the Worker with `credentials: "include"` and the browser attaches the cookie.

**`Env`** (`workers/meowsenger/src/types.ts`):
```ts
export interface Env {
  DB: D1Database;                 // D1 binding (wrangler.jsonc)
  OIDC_ISSUER?: string;           // https://auth-api.alxnko.eu.org
  OIDC_CLIENT_ID?: string;        // from provision (public)
  OIDC_CLIENT_SECRET?: string;    // from provision (secret)
  OIDC_REDIRECT_URI?: string;     // https://meowsenger-api.alxnko.eu.org/auth/callback
  WEB_ORIGIN?: string;            // https://meowsenger.alxnko.eu.org
  CORS_ORIGINS?: string;          // allowlist incl. the UI origin + localhost
}
```

**`DbClient`** (structural D1 surface so tests inject a fake — `workers/meowsenger/src/types.ts`):
```ts
export type Row = Record<string, unknown>;
export interface DbClient {
  all(sql: string, params?: unknown[]): Promise<Row[]>;
  first(sql: string, params?: unknown[]): Promise<Row | undefined>;
  run(sql: string, params?: unknown[]): Promise<void>;
}
```

**`Session`** (`workers/meowsenger/src/session.ts`):
```ts
export interface Session {
  id: string;
  userId: string;
  accessToken: string;
  refreshToken: string | null;
  accessExp: number;   // epoch ms
  createdAt: number;   // epoch ms
  expiresAt: number;   // epoch ms
}
```

**`Deps`** (injected into `handle` — `workers/meowsenger/src/deps.ts`):
```ts
import type { AuthClient } from "@meowerse/auth";
export interface Deps {
  getDb(): DbClient;
  auth(): AuthClient;         // createAuthClient(config)
  fetchFn: typeof fetch;      // for /userinfo
  now(): number;             // epoch ms — injectable clock
  newId(): string;           // 32-byte base64url — session/txn/user-nonce ids
}
```

**Session TTLs:** access refresh threshold not needed in Slice 1 (we don't call resource APIs); absolute session TTL = 7 days.

**OIDC scopes requested:** `"openid profile verified"` (→ `sub`, `preferred_username`, `name`, `picture`, `verified` from `/userinfo`).

---

## File structure (created this slice)

```
workers/meowsenger/
  package.json                 # @meowerse/meowsenger-worker
  tsconfig.json
  vitest.config.ts             # 90% on src/**, exclude src/types.ts
  wrangler.jsonc               # D1 binding, custom domain, NO DO yet, NO smart placement
  .dev.vars.example
  schema.sql                   # D1 DDL: users + sessions (single source of truth)
  auth.config.ts               # defineAuthClient manifest (config-as-code)
  scripts/provision.ts         # one-off: register the OIDC client, print id/secret
  src/
    types.ts                   # Env, DbClient, Row (excluded from coverage)
    deps.ts                    # Deps, prodDeps(env)
    db.ts                      # d1Client(D1Database): DbClient adapter
    security.ts                # corsHeaders, json, readCookies
    session.ts                 # createSession/getSession/deleteSession + cookie build
    users.ts                   # upsertUser, getUser
    oidc.ts                    # handleLogin, handleCallback (BFF)
    api.ts                     # handleSession, handleLogout
    index.ts                   # handle(req,env,deps) router + default fetch
    *.test.ts                  # per-module tests (fake DbClient / fake AuthClient)

apps/meowsenger-web/
  package.json                 # @meowerse/meowsenger-web
  astro.config.mjs
  tsconfig.json
  vitest.config.ts             # 90% on src/lib/**
  wrangler.jsonc               # static assets, custom domain
  public/_headers              # CSP incl. connect-src to the API host
  src/
    layouts/Layout.astro
    components/MeowsengerHeader.tsx   # forked header (brand + session menu)
    pages/index.astro          # landing + "log in"
    pages/app.astro            # gated empty chat shell (proves auth)
    lib/meowsengerApi.ts       # getSession/loginUrl/logoutUrl (only covered code)
    lib/meowsengerApi.test.ts
    styles/app.css

infra/  (wired for the new service pair)
  cloudflare/deploy-meowsenger.sh
  cloudflare/deploy-meowsenger-web.sh
  services.sh                  # + meowsenger / meowsenger-web cases
  cloudflare/deploy.tf         # + 2 local.services entries
  cloudflare/waf.tf            # + meowsenger-api host
justfile                       # + deploy-meowsenger / deploy-meowsenger-web
.github/workflows/deploy.yml   # + detect + deploy steps
```

---

## Task 1: Scaffold the `workers/meowsenger` package (health smoke)

**Files:**
- Create: `workers/meowsenger/package.json`, `tsconfig.json`, `vitest.config.ts`, `wrangler.jsonc`, `.dev.vars.example`
- Create: `workers/meowsenger/src/index.ts`, `src/types.ts`
- Test: `workers/meowsenger/src/index.test.ts`

- [ ] **Step 1: Write the files (configs first)**

`workers/meowsenger/package.json`:
```json
{
  "name": "@meowerse/meowsenger-worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "lint": "wrangler deploy --dry-run --outdir /tmp/wr-meowsenger",
    "test": "vitest run --coverage",
    "provision": "bun scripts/provision.ts",
    "secret:client-secret": "wrangler secret put OIDC_CLIENT_SECRET",
    "d1:schema": "wrangler d1 execute meowsenger --remote --file schema.sql",
    "d1:schema-local": "wrangler d1 execute meowsenger --local --file schema.sql"
  },
  "dependencies": {
    "@meowerse/auth": "workspace:*",
    "@meowerse/auth-shared": "workspace:*"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260625.1",
    "@vitest/coverage-v8": "^4.1.9",
    "vitest": "^4.1.9",
    "wrangler": "^4.105.0"
  }
}
```

`workers/meowsenger/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["@cloudflare/workers-types"], "noEmit": true },
  "include": ["src", "scripts", "auth.config.ts"]
}
```

`workers/meowsenger/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

// 90% on src/** (the worker logic). src/types.ts is pure types (compiles to
// nothing) — the one honest exclusion, mirroring workers/api.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
      include: ["src/**"],
      exclude: ["src/types.ts"],
    },
  },
});
```

`workers/meowsenger/wrangler.jsonc` (DB id filled in Task 13; DO added in Slice 2):
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  // meowsenger realtime backend. REST + BFF this slice; Durable Objects in Slice 2.
  //
  // SECRETS (never in this file): bunx wrangler secret put OIDC_CLIENT_SECRET
  // D1: created via `wrangler d1 create meowsenger`; paste database_id below.
  //
  // NO smart placement: this worker fronts D1 (read-replicated) and, later,
  // Durable Objects (located near first access) — edge placement is correct.
  "name": "meowsenger",
  "main": "src/index.ts",
  "compatibility_date": "2025-06-01",
  "vars": {
    "OIDC_ISSUER": "https://auth-api.alxnko.eu.org",
    "OIDC_REDIRECT_URI": "https://meowsenger-api.alxnko.eu.org/auth/callback",
    "WEB_ORIGIN": "https://meowsenger.alxnko.eu.org",
    "CORS_ORIGINS": "https://meowsenger.alxnko.eu.org,http://localhost:4321"
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "meowsenger", "database_id": "PLACEHOLDER_SET_IN_TASK_13" }
  ],
  "routes": [{ "pattern": "meowsenger-api.alxnko.eu.org", "custom_domain": true }]
}
```
> Note: `OIDC_CLIENT_ID` is added to `vars` in Task 13 after provisioning (it's public). Until then tests supply it via a fake `Env`.

`workers/meowsenger/.dev.vars.example`:
```
# Copy to .dev.vars (gitignored) for `wrangler dev`.
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=
```

`workers/meowsenger/src/types.ts` — the Shared contracts `Env`, `Row`, `DbClient` blocks above (verbatim).

`workers/meowsenger/src/index.ts`:
```ts
import type { Env } from "./types";
import { corsHeaders, json } from "./security";
import { type Deps, prodDeps } from "./deps";

/** Thin hand-rolled router (no framework) to stay under the 10ms CPU budget. */
export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req.headers.get("Origin"), env);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const path = new URL(req.url).pathname;

  if (path === "/health" && req.method === "GET") return json({ ok: true }, 200, cors);

  return json({ error: "not found" }, 404, cors);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env, prodDeps(env));
    } catch {
      return json({ error: "internal error" }, 500, corsHeaders(request.headers.get("Origin"), env));
    }
  },
};
```
> `security.ts` gains `readCookies` in Task 4; `deps.ts` below is already complete (not expanded later). Create both now so Task 1 compiles+tests standalone. `src/security.ts`:
```ts
import type { Env } from "./types";
export const DEFAULT_ORIGINS = "https://meowsenger.alxnko.eu.org,http://localhost:4321";
function allowlist(env: Env): string[] {
  return ((env.CORS_ORIGINS ?? "").trim() || DEFAULT_ORIGINS).split(",").map((o) => o.trim()).filter(Boolean);
}
export function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  if (origin && allowlist(env).includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
export function json(body: unknown, status: number, cors: Record<string, string>, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors, ...extra } });
}
```
`src/deps.ts` (complete — used as-is by all later tasks):
```ts
import type { DbClient, Env } from "./types";
import { d1Client } from "./db";
import { createAuthClient, type AuthClient } from "@meowerse/auth";

export interface Deps {
  getDb(): DbClient;
  auth(): AuthClient;
  fetchFn: typeof fetch;
  now(): number;
  newId(): string;
}

export function prodDeps(env: Env): Deps {
  let db: DbClient | undefined;
  let ac: AuthClient | undefined;
  return {
    getDb: () => (db ??= d1Client(env.DB)),
    auth: () =>
      (ac ??= createAuthClient({
        issuer: env.OIDC_ISSUER!,
        clientId: env.OIDC_CLIENT_ID!,
        clientSecret: env.OIDC_CLIENT_SECRET,
        redirectUri: env.OIDC_REDIRECT_URI!,
      })),
    fetchFn: fetch,
    now: () => Date.now(),
    newId: () => b64url(crypto.getRandomValues(new Uint8Array(32))),
  };
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
```
> `db.ts` is written in Task 3; create a one-line stub now so Task 1 compiles: `export function d1Client(_db: unknown): any { throw new Error("todo Task 3"); }` — replaced in Task 3. (It is never called by the health test.)

- [ ] **Step 2: Write the failing test** — `workers/meowsenger/src/index.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { handle } from "./index";
import type { Env } from "./types";

const env = { CORS_ORIGINS: "http://localhost:4321" } as Env;
const ORIGIN = "http://localhost:4321";
const deps = { getDb: () => ({}) } as never;
const req = (m: string, p: string) => new Request(`https://meowsenger-api.alxnko.eu.org${p}`, { method: m, headers: { Origin: ORIGIN } });

describe("router", () => {
  it("answers OPTIONS with 204 + CORS", async () => {
    const res = await handle(req("OPTIONS", "/health"), env, deps);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });
  it("GET /health returns 200 {ok:true}", async () => {
    const res = await handle(req("GET", "/health"), env, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
  it("unknown route → 404 JSON", async () => {
    const res = await handle(req("GET", "/nope"), env, deps);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});
```

- [ ] **Step 3: Register the workspace + install**

Run: `cd C:/code/meow/meowerse && bun install`
Expected: bun links `@meowerse/meowsenger-worker` (globbed by `workers/*`); no error.

- [ ] **Step 4: Run tests to verify pass**

Run: `bun run --filter @meowerse/meowsenger-worker test`
Expected: 3 passing. (Coverage may warn <90% until later tasks add the excluded stubs' callers — acceptable mid-slice; the gate is enforced at Task 12/14 when all modules exist.)

- [ ] **Step 5: Commit**
```bash
git add workers/meowsenger
git commit -m "feat(meowsenger): scaffold worker package + health route"
```

---

## Task 2: D1 schema file (users + sessions)

**Files:**
- Create: `workers/meowsenger/schema.sql`

- [ ] **Step 1: Write `workers/meowsenger/schema.sql`** (single source; applied out-of-band via `wrangler d1 execute`, so the Worker never runs DDL on the request path):
```sql
-- meowsenger D1 schema (Slice 1: users + sessions). Applied with:
--   wrangler d1 execute meowsenger --remote --file schema.sql
-- Chats/members tables arrive in Slice 2 where they are first used.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,           -- OIDC sub
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  avatar_url    TEXT,
  verified      INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,          -- opaque cookie value
  user_id        TEXT NOT NULL,
  access_token   TEXT NOT NULL,
  refresh_token  TEXT,
  access_exp     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
```

- [ ] **Step 2: Sanity-check the SQL locally** (no live DB needed yet)

Run: `cd workers/meowsenger && bunx wrangler d1 execute meowsenger --local --file schema.sql`
Expected: creates a local `.wrangler` D1; "Executed 4 commands". (If it prompts to create the DB locally, accept — local only.)

- [ ] **Step 3: Commit**
```bash
git add workers/meowsenger/schema.sql
git commit -m "feat(meowsenger): D1 schema — users + sessions"
```

---

## Task 3: D1 `DbClient` adapter

**Files:**
- Modify: `workers/meowsenger/src/db.ts` (replace the Task 1 stub)
- Test: `workers/meowsenger/src/db.test.ts`

- [ ] **Step 1: Write the failing test** — a hand-rolled fake `D1Database` verifying the adapter maps `all/first/run` onto `prepare().bind().all()/.first()/.run()`:
```ts
import { describe, it, expect } from "vitest";
import { d1Client } from "./db";

function fakeD1() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...p: unknown[]) { bound = p; return stmt; },
        async all() { calls.push({ sql, params: bound }); return { results: [{ id: "u1" }] }; },
        async first() { calls.push({ sql, params: bound }); return { id: "u1" }; },
        async run() { calls.push({ sql, params: bound }); return { success: true }; },
      };
      return stmt;
    },
  };
  return { db, calls };
}

describe("d1Client", () => {
  it("all() returns results[] and binds params", async () => {
    const { db, calls } = fakeD1();
    const rows = await d1Client(db as never).all("SELECT * FROM users WHERE id = ?", ["u1"]);
    expect(rows).toEqual([{ id: "u1" }]);
    expect(calls[0]).toEqual({ sql: "SELECT * FROM users WHERE id = ?", params: ["u1"] });
  });
  it("first() returns the row or undefined", async () => {
    const { db } = fakeD1();
    expect(await d1Client(db as never).first("SELECT 1")).toEqual({ id: "u1" });
  });
  it("run() executes without returning rows", async () => {
    const { db, calls } = fakeD1();
    await d1Client(db as never).run("INSERT INTO users (id) VALUES (?)", ["u1"]);
    expect(calls[0].params).toEqual(["u1"]);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `bun run --filter @meowerse/meowsenger-worker test db` → FAIL ("todo Task 3").

- [ ] **Step 3: Implement `workers/meowsenger/src/db.ts`**:
```ts
import type { DbClient, Row } from "./types";

/**
 * Adapt Cloudflare's D1Database to our structural DbClient (so handlers depend
 * on a tiny interface a fake can satisfy). D1 reads are served from free,
 * automatic regional read replicas; writes go to the primary.
 */
export function d1Client(db: D1Database): DbClient {
  const stmt = (sql: string, params: unknown[] = []) => db.prepare(sql).bind(...params);
  return {
    async all(sql, params = []) {
      const res = await stmt(sql, params).all<Row>();
      return res.results ?? [];
    },
    async first(sql, params = []) {
      return (await stmt(sql, params).first<Row>()) ?? undefined;
    },
    async run(sql, params = []) {
      await stmt(sql, params).run();
    },
  };
}
```

- [ ] **Step 4: Run to verify pass** — `bun run --filter @meowerse/meowsenger-worker test db` → 3 PASS.

- [ ] **Step 5: Commit**
```bash
git add workers/meowsenger/src/db.ts workers/meowsenger/src/db.test.ts
git commit -m "feat(meowsenger): D1 DbClient adapter"
```

---

## Task 4: Cookie + session module

**Files:**
- Modify: `workers/meowsenger/src/security.ts` (add `readCookies`)
- Create: `workers/meowsenger/src/session.ts`
- Test: `workers/meowsenger/src/session.test.ts`, add cases to `security.test.ts`

- [ ] **Step 1: Write failing tests** — `workers/meowsenger/src/session.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createSession, getSession, deleteSession, sessionCookie, clearCookie, SESSION_COOKIE } from "./session";
import type { DbClient, Row } from "./types";

function memDb() {
  const t = new Map<string, Row>();
  const db: DbClient = {
    async all() { return [...t.values()]; },
    async first(sql, p = []) {
      if (sql.startsWith("SELECT") && sql.includes("FROM sessions")) return t.get(String(p[0]));
      return undefined;
    },
    async run(sql, p = []) {
      if (sql.startsWith("INSERT INTO sessions")) {
        t.set(String(p[0]), { id: p[0], user_id: p[1], access_token: p[2], refresh_token: p[3], access_exp: p[4], created_at: p[5], expires_at: p[6] });
      } else if (sql.startsWith("DELETE FROM sessions")) {
        t.delete(String(p[0]));
      }
    },
  };
  return { db, t };
}
const now = 1_000_000;

describe("session store", () => {
  it("creates then reads a session", async () => {
    const { db } = memDb();
    const s = await createSession(db, { id: "sess1", userId: "u1", accessToken: "at", refreshToken: "rt", accessExp: now + 3600_000, now });
    expect(s.id).toBe("sess1");
    const got = await getSession(db, "sess1", now);
    expect(got?.userId).toBe("u1");
  });
  it("returns null for an expired session and deletes it", async () => {
    const { db, t } = memDb();
    await createSession(db, { id: "old", userId: "u1", accessToken: "at", refreshToken: null, accessExp: now, now: now - 8 * 864e5 });
    // expires_at = createdAt + 7d, which is < now
    expect(await getSession(db, "old", now)).toBeNull();
    expect(t.has("old")).toBe(false);
  });
  it("returns null for a missing session", async () => {
    const { db } = memDb();
    expect(await getSession(db, "nope", now)).toBeNull();
  });
  it("deleteSession removes the row", async () => {
    const { db, t } = memDb();
    await createSession(db, { id: "s", userId: "u1", accessToken: "a", refreshToken: null, accessExp: now, now });
    await deleteSession(db, "s");
    expect(t.has("s")).toBe(false);
  });
  it("sessionCookie is __Host-, httpOnly, Secure, SameSite=Lax", () => {
    const c = sessionCookie("abc");
    expect(c).toContain(`${SESSION_COOKIE}=abc`);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
  });
  it("clearCookie expires the cookie", () => {
    expect(clearCookie(SESSION_COOKIE)).toContain("Max-Age=0");
  });
});
```
Add to `workers/meowsenger/src/security.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readCookies } from "./security";

describe("readCookies", () => {
  it("parses a Cookie header into a map", () => {
    expect(readCookies("__Host-mw_session=abc; other=1")).toEqual({ "__Host-mw_session": "abc", other: "1" });
  });
  it("returns {} for no header", () => {
    expect(readCookies(null)).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify fail** — `bun run --filter @meowerse/meowsenger-worker test session` → FAIL (module not found).

- [ ] **Step 3: Implement**

Add to `workers/meowsenger/src/security.ts`:
```ts
/** Parse a Cookie header into a name→value map (never throws). */
export function readCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
```

`workers/meowsenger/src/session.ts`:
```ts
import type { DbClient } from "./types";

export const SESSION_COOKIE = "__Host-mw_session";
export const TXN_COOKIE = "__Host-mw_txn";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface Session {
  id: string;
  userId: string;
  accessToken: string;
  refreshToken: string | null;
  accessExp: number;
  createdAt: number;
  expiresAt: number;
}

export async function createSession(
  db: DbClient,
  i: { id: string; userId: string; accessToken: string; refreshToken: string | null; accessExp: number; now: number },
): Promise<Session> {
  const s: Session = {
    id: i.id, userId: i.userId, accessToken: i.accessToken, refreshToken: i.refreshToken,
    accessExp: i.accessExp, createdAt: i.now, expiresAt: i.now + SESSION_TTL_MS,
  };
  await db.run(
    `INSERT INTO sessions (id, user_id, access_token, refresh_token, access_exp, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [s.id, s.userId, s.accessToken, s.refreshToken, s.accessExp, s.createdAt, s.expiresAt],
  );
  return s;
}

export async function getSession(db: DbClient, id: string, now: number): Promise<Session | null> {
  const row = await db.first(
    `SELECT id, user_id, access_token, refresh_token, access_exp, created_at, expires_at
     FROM sessions WHERE id = ?`,
    [id],
  );
  if (!row) return null;
  if (Number(row.expires_at) < now) {
    await deleteSession(db, id);
    return null;
  }
  return {
    id: String(row.id), userId: String(row.user_id), accessToken: String(row.access_token),
    refreshToken: row.refresh_token == null ? null : String(row.refresh_token),
    accessExp: Number(row.access_exp), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
  };
}

export async function deleteSession(db: DbClient, id: string): Promise<void> {
  await db.run("DELETE FROM sessions WHERE id = ?", [id]);
}

/** __Host- cookie: httpOnly, Secure, SameSite=Lax, Path=/, no Domain (host-scoped). */
export function sessionCookie(id: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearCookie(name: string): string {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
```
> The expired-session test relies on `expiresAt = createdAt + 7d`; passing `now: now - 8*864e5` at create makes `expiresAt < now` at read, exercising the expiry+delete branch.

- [ ] **Step 4: Run to verify pass** — `bun run --filter @meowerse/meowsenger-worker test` (session + security) → PASS.

- [ ] **Step 5: Commit**
```bash
git add workers/meowsenger/src/session.ts workers/meowsenger/src/security.ts workers/meowsenger/src/session.test.ts workers/meowsenger/src/security.test.ts
git commit -m "feat(meowsenger): BFF session store + cookies"
```

---

## Task 5: User upsert (`users.ts`)

**Files:**
- Create: `workers/meowsenger/src/users.ts`
- Test: `workers/meowsenger/src/users.test.ts`

- [ ] **Step 1: Write failing test** — `workers/meowsenger/src/users.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { upsertUser, getUser } from "./users";
import type { DbClient, Row } from "./types";

function memDb() {
  const u = new Map<string, Row>();
  const db: DbClient = {
    async all() { return [...u.values()]; },
    async first(sql, p = []) { return sql.includes("FROM users") ? u.get(String(p[0])) : undefined; },
    async run(sql, p = []) {
      if (sql.startsWith("INSERT INTO users")) {
        u.set(String(p[0]), { id: p[0], username: p[1], display_name: p[2], avatar_url: p[3], verified: p[4], updated_at: p[5] });
      }
    },
  };
  return { db, u };
}
const now = 42;

describe("upsertUser", () => {
  it("inserts a new user from userinfo claims", async () => {
    const { db, u } = memDb();
    await upsertUser(db, { sub: "u1", preferred_username: "alex", name: "Alex", picture: "http://x/a.png", verified: true }, now);
    expect(u.get("u1")).toMatchObject({ username: "alex", display_name: "Alex", avatar_url: "http://x/a.png", verified: 1 });
  });
  it("defaults missing optional claims to null / verified 0", async () => {
    const { db, u } = memDb();
    await upsertUser(db, { sub: "u2", preferred_username: "bob" }, now);
    expect(u.get("u2")).toMatchObject({ display_name: null, avatar_url: null, verified: 0 });
  });
  it("getUser returns the typed row", async () => {
    const { db } = memDb();
    await upsertUser(db, { sub: "u1", preferred_username: "alex", verified: true }, now);
    const got = await getUser(db, "u1");
    expect(got).toEqual({ id: "u1", username: "alex", displayName: null, avatarUrl: null, verified: true });
  });
});
```

- [ ] **Step 2: Run to verify fail** — `... test users` → FAIL.

- [ ] **Step 3: Implement `workers/meowsenger/src/users.ts`**:
```ts
import type { DbClient } from "./types";

export interface UserInfo {
  sub: string;
  preferred_username?: string;
  name?: string;
  picture?: string;
  verified?: boolean;
}

export interface User {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  verified: boolean;
}

/**
 * Upsert the caller into the messenger's own user directory from OIDC /userinfo
 * claims. Keyed by `sub`; refreshed on every login. ON CONFLICT keeps the row
 * current without a second round-trip.
 */
export async function upsertUser(db: DbClient, info: UserInfo, now: number): Promise<void> {
  await db.run(
    `INSERT INTO users (id, username, display_name, avatar_url, verified, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       username = excluded.username,
       display_name = excluded.display_name,
       avatar_url = excluded.avatar_url,
       verified = excluded.verified,
       updated_at = excluded.updated_at`,
    [info.sub, info.preferred_username ?? info.sub, info.name ?? null, info.picture ?? null, info.verified ? 1 : 0, now],
  );
}

export async function getUser(db: DbClient, id: string): Promise<User | null> {
  const row = await db.first(
    "SELECT id, username, display_name, avatar_url, verified FROM users WHERE id = ?",
    [id],
  );
  if (!row) return null;
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: row.display_name == null ? null : String(row.display_name),
    avatarUrl: row.avatar_url == null ? null : String(row.avatar_url),
    verified: Number(row.verified) === 1,
  };
}
```
> `username` falls back to `sub` if the `preferred_username` claim is ever absent (UNIQUE requires non-null). The memDb fake ignores `ON CONFLICT` (insert-only) which is fine — the branch is exercised live; unit tests cover insert + read.

- [ ] **Step 4: Run to verify pass** — `... test users` → 3 PASS.

- [ ] **Step 5: Commit**
```bash
git add workers/meowsenger/src/users.ts workers/meowsenger/src/users.test.ts
git commit -m "feat(meowsenger): user directory upsert from userinfo"
```

---

## Task 6: `GET /auth/login` (PKCE start)

**Files:**
- Create: `workers/meowsenger/src/oidc.ts` (login half)
- Test: `workers/meowsenger/src/oidc.test.ts` (login cases)

- [ ] **Step 1: Write failing test** — `workers/meowsenger/src/oidc.test.ts` (login):
```ts
import { describe, it, expect } from "vitest";
import { handleLogin } from "./oidc";
import type { AuthClient } from "@meowerse/auth";

const fakeAuth = (): AuthClient => ({
  async buildAuthorizationUrl() {
    return { url: "https://auth-api.alxnko.eu.org/authorize?x=1", state: "st", nonce: "no", codeVerifier: "cv" };
  },
  async exchangeCode() { return {}; },
  async refresh() { return {}; },
  async verifyIdToken() { return {}; },
  buildLogoutUrl() { return ""; },
});

describe("handleLogin", () => {
  it("302s to the authorize URL and sets the txn cookie", async () => {
    const res = await handleLogin(fakeAuth());
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/authorize");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("__Host-mw_txn=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });
});
```

- [ ] **Step 2: Run to verify fail** — `... test oidc` → FAIL.

- [ ] **Step 3: Implement the login half of `workers/meowsenger/src/oidc.ts`**:
```ts
import type { AuthClient } from "@meowerse/auth";
import { TXN_COOKIE } from "./session";

const SCOPES = "openid profile verified";

/** GET /auth/login — start Authorization-Code + PKCE, stash the txn in a cookie. */
export async function handleLogin(auth: AuthClient): Promise<Response> {
  const txn = await auth.buildAuthorizationUrl({ scope: SCOPES });
  const payload = JSON.stringify({ state: txn.state, nonce: txn.nonce, codeVerifier: txn.codeVerifier });
  // 10-minute httpOnly txn cookie; consumed + cleared at /auth/callback.
  const cookie = `${TXN_COOKIE}=${encodeURIComponent(payload)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`;
  return new Response(null, { status: 302, headers: { Location: txn.url, "Set-Cookie": cookie } });
}
```

- [ ] **Step 4: Run to verify pass** — `... test oidc` → PASS.

- [ ] **Step 5: Commit**
```bash
git add workers/meowsenger/src/oidc.ts workers/meowsenger/src/oidc.test.ts
git commit -m "feat(meowsenger): /auth/login PKCE start"
```

---

## Task 7: `GET /auth/callback` (exchange → userinfo → session)

**Files:**
- Modify: `workers/meowsenger/src/oidc.ts` (add `handleCallback`)
- Test: `workers/meowsenger/src/oidc.test.ts` (callback cases)

- [ ] **Step 1: Write failing tests** — add to `workers/meowsenger/src/oidc.test.ts`:
```ts
import { handleCallback } from "./oidc";
import type { DbClient, Row } from "./types";

function memDb() {
  const s = new Map<string, Row>(); const u = new Map<string, Row>();
  const db: DbClient = {
    async all() { return []; },
    async first() { return undefined; },
    async run(sql, p = []) {
      if (sql.startsWith("INSERT INTO sessions")) s.set(String(p[0]), { id: p[0] });
      if (sql.startsWith("INSERT INTO users")) u.set(String(p[0]), { id: p[0] });
    },
  };
  return { db, s, u };
}

const authOk = (): AuthClient => ({
  async buildAuthorizationUrl() { return { url: "", state: "st", nonce: "no", codeVerifier: "cv" }; },
  async exchangeCode() { return { access_token: "AT", id_token: "ID", refresh_token: "RT", expires_in: 3600 }; },
  async refresh() { return {}; },
  async verifyIdToken() { return { sub: "u1", verified: true }; },
  buildLogoutUrl() { return ""; },
});

const txnCookie = "__Host-mw_txn=" + encodeURIComponent(JSON.stringify({ state: "st", nonce: "no", codeVerifier: "cv" }));
const cbReq = (qs: string, cookie = txnCookie) =>
  new Request(`https://meowsenger-api.alxnko.eu.org/auth/callback?${qs}`, { headers: { Cookie: cookie } });

const deps = (db: DbClient, auth: AuthClient, userinfo: Row = { sub: "u1", preferred_username: "alex", verified: true }) => ({
  getDb: () => db,
  auth: () => auth,
  fetchFn: (async () => new Response(JSON.stringify(userinfo), { status: 200 })) as unknown as typeof fetch,
  now: () => 1000,
  newId: () => "sess1",
});
const env = { OIDC_ISSUER: "https://auth-api.alxnko.eu.org", WEB_ORIGIN: "https://meowsenger.alxnko.eu.org" } as never;

describe("handleCallback", () => {
  it("exchanges, upserts, creates session, 302s to WEB_ORIGIN/app with session cookie", async () => {
    const { db, s, u } = memDb();
    const res = await handleCallback(cbReq("code=abc&state=st"), env, deps(db, authOk()));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://meowsenger.alxnko.eu.org/app");
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("__Host-mw_session=sess1");
    expect(s.has("sess1")).toBe(true);
    expect(u.has("u1")).toBe(true);
  });
  it("rejects a state mismatch with 400", async () => {
    const { db } = memDb();
    const res = await handleCallback(cbReq("code=abc&state=WRONG"), env, deps(db, authOk()));
    expect(res.status).toBe(400);
  });
  it("rejects a missing txn cookie with 400", async () => {
    const { db } = memDb();
    const res = await handleCallback(cbReq("code=abc&state=st", ""), env, deps(db, authOk()));
    expect(res.status).toBe(400);
  });
  it("returns 400 when the token exchange errors", async () => {
    const { db } = memDb();
    const badAuth = { ...authOk(), async exchangeCode() { return { error: "invalid_grant" }; } } as AuthClient;
    const res = await handleCallback(cbReq("code=abc&state=st"), env, deps(db, badAuth));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `... test oidc` → FAIL (`handleCallback` not exported).

- [ ] **Step 3: Implement — append to `workers/meowsenger/src/oidc.ts`**:
```ts
import type { Env } from "./types";
import type { Deps } from "./deps";
import { readCookies } from "./security";
import { createSession, sessionCookie, clearCookie, TXN_COOKIE, SESSION_COOKIE } from "./session";
import { upsertUser, type UserInfo } from "./users";

function redirectClearingTxn(location: string, extra: string[]): Response {
  const headers = new Headers({ Location: location });
  for (const c of [clearCookie(TXN_COOKIE), ...extra]) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}
function bad(msg: string): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", clearCookie(TXN_COOKIE));
  return new Response(JSON.stringify({ error: msg }), { status: 400, headers });
}

/** GET /auth/callback — validate state, exchange code, fetch userinfo, upsert, create session. */
export async function handleCallback(req: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const txnRaw = readCookies(req.headers.get("Cookie"))[TXN_COOKIE];
  if (!code || !state || !txnRaw) return bad("missing_params");

  let txn: { state: string; nonce: string; codeVerifier: string };
  try { txn = JSON.parse(decodeURIComponent(txnRaw)); } catch { return bad("bad_txn"); }
  if (txn.state !== state) return bad("state_mismatch");

  const auth = deps.auth();
  const tok = await auth.exchangeCode({ code, codeVerifier: txn.codeVerifier });
  if (tok.error || !tok.access_token || !tok.id_token) return bad("exchange_failed");

  let claims: Record<string, unknown>;
  try { claims = await auth.verifyIdToken(tok.id_token, { nonce: txn.nonce }); } catch { return bad("bad_id_token"); }
  const sub = String(claims.sub);

  // Profile claims live in /userinfo (not the id_token). Fetch with the access token.
  const uiRes = await deps.fetchFn(`${env.OIDC_ISSUER}/userinfo`, {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  });
  if (!uiRes.ok) return bad("userinfo_failed");
  const info = (await uiRes.json()) as UserInfo;

  const now = deps.now();
  const db = deps.getDb();
  await upsertUser(db, { ...info, sub, verified: info.verified ?? claims.verified === true }, now);
  const id = deps.newId();
  await createSession(db, {
    id, userId: sub, accessToken: tok.access_token, refreshToken: tok.refresh_token ?? null,
    accessExp: now + (tok.expires_in ?? 0) * 1000, now,
  });

  return redirectClearingTxn(`${env.WEB_ORIGIN}/app`, [sessionCookie(id)]);
}
```

- [ ] **Step 4: Run to verify pass** — `... test oidc` → all PASS.

- [ ] **Step 5: Commit**
```bash
git add workers/meowsenger/src/oidc.ts workers/meowsenger/src/oidc.test.ts
git commit -m "feat(meowsenger): /auth/callback — exchange, userinfo, session"
```

---

## Task 8: `GET /api/session` + `POST /auth/logout` (`api.ts`)

**Files:**
- Create: `workers/meowsenger/src/api.ts`
- Test: `workers/meowsenger/src/api.test.ts`

- [ ] **Step 1: Write failing tests** — `workers/meowsenger/src/api.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { handleSession, handleLogout } from "./api";
import type { DbClient, Row } from "./types";
import { SESSION_COOKIE } from "./session";

function memDb(session?: Row, user?: Row) {
  const del: string[] = [];
  const db: DbClient = {
    async all() { return []; },
    async first(sql, p = []) {
      if (sql.includes("FROM sessions")) return session;
      if (sql.includes("FROM users")) return user;
      return undefined;
    },
    async run(sql, p = []) { if (sql.startsWith("DELETE FROM sessions")) del.push(String(p[0])); },
  };
  return { db, del };
}
const cors = {};
const now = 5_000;
const cookieReq = (v?: string) =>
  new Request("https://x/api/session", { headers: v ? { Cookie: `${SESSION_COOKIE}=${v}` } : {} });

describe("handleSession", () => {
  it("returns authenticated:false with no cookie", async () => {
    const { db } = memDb();
    const res = await handleSession(cookieReq(), db, now, cors);
    expect(await res.json()).toEqual({ authenticated: false });
  });
  it("returns the user for a valid session", async () => {
    const session = { id: "s1", user_id: "u1", access_token: "a", refresh_token: null, access_exp: now, created_at: now, expires_at: now + 1e9 };
    const user = { id: "u1", username: "alex", display_name: "Alex", avatar_url: null, verified: 1 };
    const { db } = memDb(session, user);
    const res = await handleSession(cookieReq("s1"), db, now, cors);
    expect(await res.json()).toEqual({ authenticated: true, user: { id: "u1", username: "alex", displayName: "Alex", avatarUrl: null, verified: true } });
  });
});

describe("handleLogout", () => {
  it("deletes the session and clears the cookie", async () => {
    const session = { id: "s1", user_id: "u1", access_token: "a", refresh_token: null, access_exp: now, created_at: now, expires_at: now + 1e9 };
    const { db, del } = memDb(session);
    const res = await handleLogout(new Request("https://x/auth/logout", { method: "POST", headers: { Cookie: `${SESSION_COOKIE}=s1` } }), db, now, cors);
    expect(res.status).toBe(200);
    expect(del).toContain("s1");
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
  it("is a no-op 200 with no cookie", async () => {
    const { db } = memDb();
    const res = await handleLogout(new Request("https://x/auth/logout", { method: "POST" }), db, now, cors);
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `... test api` → FAIL.

- [ ] **Step 3: Implement `workers/meowsenger/src/api.ts`**:
```ts
import type { DbClient } from "./types";
import { json, readCookies } from "./security";
import { getSession, deleteSession, clearCookie, SESSION_COOKIE } from "./session";
import { getUser } from "./users";

/** GET /api/session — whoami via the BFF cookie. */
export async function handleSession(req: Request, db: DbClient, now: number, cors: Record<string, string>): Promise<Response> {
  const sid = readCookies(req.headers.get("Cookie"))[SESSION_COOKIE];
  const noStore = { "Cache-Control": "no-store" };
  if (!sid) return json({ authenticated: false }, 200, cors, noStore);
  const s = await getSession(db, sid, now);
  if (!s) return json({ authenticated: false }, 200, cors, noStore);
  const user = await getUser(db, s.userId);
  if (!user) return json({ authenticated: false }, 200, cors, noStore);
  return json({ authenticated: true, user }, 200, cors, noStore);
}

/** POST /auth/logout — delete the session server-side + clear the cookie. */
export async function handleLogout(req: Request, db: DbClient, now: number, cors: Record<string, string>): Promise<Response> {
  const sid = readCookies(req.headers.get("Cookie"))[SESSION_COOKIE];
  if (sid) await deleteSession(db, sid);
  return json({ ok: true }, 200, cors, { "Set-Cookie": clearCookie(SESSION_COOKIE) });
}
```

- [ ] **Step 4: Run to verify pass** — `... test api` → PASS.

- [ ] **Step 5: Commit**
```bash
git add workers/meowsenger/src/api.ts workers/meowsenger/src/api.test.ts
git commit -m "feat(meowsenger): /api/session + /auth/logout"
```

---

## Task 9: Wire the router (`index.ts`)

**Files:**
- Modify: `workers/meowsenger/src/index.ts`
- Test: `workers/meowsenger/src/index.test.ts` (add route cases)

- [ ] **Step 1: Write failing tests** — extend `workers/meowsenger/src/index.test.ts` (add these cases inside the existing `describe("router")`, calling `handle()` only):
```ts
it("GET /auth/login 302s (via injected auth)", async () => {
  const auth = {
    async buildAuthorizationUrl() { return { url: "https://auth/authorize", state: "s", nonce: "n", codeVerifier: "c" }; },
    async exchangeCode() { return {}; }, async refresh() { return {}; },
    async verifyIdToken() { return {}; }, buildLogoutUrl() { return ""; },
  };
  const d = { getDb: () => ({}), auth: () => auth, fetchFn: fetch, now: () => 1, newId: () => "x" } as never;
  const res = await handle(req("GET", "/auth/login"), env, d);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toContain("/authorize");
});

it("GET /api/session returns authenticated:false with no cookie", async () => {
  const d = { getDb: () => ({ async first() { return undefined; }, async all() { return []; }, async run() {} }), auth: () => ({}), fetchFn: fetch, now: () => 1, newId: () => "x" } as never;
  const res = await handle(req("GET", "/api/session"), env, d);
  expect(await res.json()).toEqual({ authenticated: false });
});
```

- [ ] **Step 2: Run to verify fail** — `... test index` → FAIL (routes 404).

- [ ] **Step 3: Rewrite `workers/meowsenger/src/index.ts` router body**:
```ts
import type { Env } from "./types";
import { corsHeaders, json } from "./security";
import { type Deps, prodDeps } from "./deps";
import { handleLogin, handleCallback } from "./oidc";
import { handleSession, handleLogout } from "./api";

export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req.headers.get("Origin"), env);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const path = new URL(req.url).pathname;
  const m = req.method;

  if (path === "/health" && m === "GET") return json({ ok: true }, 200, cors);
  if (path === "/auth/login" && m === "GET") return handleLogin(deps.auth());
  if (path === "/auth/callback" && m === "GET") return handleCallback(req, env, deps);
  if (path === "/api/session" && m === "GET") return handleSession(req, deps.getDb(), deps.now(), cors);
  if (path === "/auth/logout" && m === "POST") return handleLogout(req, deps.getDb(), deps.now(), cors);

  return json({ error: "not found" }, 404, cors);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env, prodDeps(env));
    } catch {
      return json({ error: "internal error" }, 500, corsHeaders(request.headers.get("Origin"), env));
    }
  },
};
```

- [ ] **Step 4: Run to verify pass + full worker suite + lint**

Run: `bun run --filter @meowerse/meowsenger-worker test`
Expected: all PASS, coverage ≥90% on `src/**`.
Run: `bun run --filter @meowerse/meowsenger-worker lint`
Expected: wrangler dry-run bundles with no error (D1 binding with placeholder id is fine for `--dry-run`).

- [ ] **Step 5: Commit**
```bash
git add workers/meowsenger/src
git commit -m "feat(meowsenger): wire router — login/callback/session/logout"
```

---

## Task 10: OIDC client manifest + provision script

**Files:**
- Create: `workers/meowsenger/auth.config.ts`
- Create: `workers/meowsenger/scripts/provision.ts`

- [ ] **Step 1: Write `workers/meowsenger/auth.config.ts`**:
```ts
import { defineAuthClient } from "@meowerse/auth";

/** meowsenger's OIDC client, registered via `bun run provision` (config-as-code). */
export const meowsengerClient = defineAuthClient({
  name: "meowsenger",
  displayName: "meowsenger",
  clientType: "confidential",
  redirectUris: [
    "https://meowsenger-api.alxnko.eu.org/auth/callback",
    "http://localhost:8787/auth/callback",
  ],
  postLogoutRedirectUris: [
    "https://meowsenger.alxnko.eu.org",
    "http://localhost:4321",
  ],
  scopes: ["openid", "profile", "verified"],
  allowOfflineAccess: true,
});
```

- [ ] **Step 2: Write `workers/meowsenger/scripts/provision.ts`**:
```ts
// One-off: register/update meowsenger's OIDC client via the Management API.
// Usage: MGMT_TOKEN=<dev management token> bun run provision
// Prints the client_id (public → set as an OIDC_CLIENT_ID var) and, for a NEW
// confidential client, the client_secret (→ wrangler secret put OIDC_CLIENT_SECRET).
import { provision } from "@meowerse/auth";
import { meowsengerClient } from "../auth.config";

const issuer = process.env.OIDC_ISSUER ?? "https://auth-api.alxnko.eu.org";
const managementToken = process.env.MGMT_TOKEN;
if (!managementToken) {
  console.error("Set MGMT_TOKEN (create one in the auth dashboard → management tokens).");
  process.exit(1);
}
const r = await provision(meowsengerClient, { issuer, managementToken });
console.log(JSON.stringify(r, null, 2));
if (r.clientSecret) console.log("\nSet secret:  bunx wrangler secret put OIDC_CLIENT_SECRET   (paste the value above)");
if (r.clientId) console.log(`Add var:     OIDC_CLIENT_ID=${r.clientId}  → wrangler.jsonc vars`);
```
> This is a bootstrap step run once (and re-run to update the manifest, idempotent). Not part of CI. It has no unit test — it is thin wiring over the tested `provision()` SDK function (which has its own tests in `packages/auth-sdk`). `// ponytail: one-off bootstrap; provision() is already tested upstream.`

- [ ] **Step 3: Commit**
```bash
git add workers/meowsenger/auth.config.ts workers/meowsenger/scripts/provision.ts
git commit -m "feat(meowsenger): OIDC client manifest + provision script"
```

---

## Task 11: Scaffold `apps/meowsenger-web`

**Files:**
- Create: `apps/meowsenger-web/package.json`, `astro.config.mjs`, `tsconfig.json`, `vitest.config.ts`, `wrangler.jsonc`, `public/_headers`, `src/styles/app.css`

- [ ] **Step 1: Write the config files**

`apps/meowsenger-web/package.json`:
```json
{
  "name": "@meowerse/meowsenger-web",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "lint": "astro check",
    "test": "vitest run --coverage"
  },
  "dependencies": {
    "@meowerse/ui": "workspace:*",
    "@astrojs/react": "^6.0.0",
    "astro": "^7.0.2",
    "react": "^19.2.7",
    "react-dom": "^19.2.7"
  },
  "devDependencies": {
    "@astrojs/check": "^0.9.9",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@vitest/coverage-v8": "^4.1.9",
    "typescript": "^6.0.3",
    "vitest": "^4.1.9"
  }
}
```

`apps/meowsenger-web/astro.config.mjs`:
```js
import { defineConfig } from "astro/config";
import react from "@astrojs/react";

// assetsInlineLimit: 0 keeps fonts external so the strict CSP (which blocks
// data: fonts) still loads them — same reason as auth-web.
export default defineConfig({
  integrations: [react()],
  vite: { build: { assetsInlineLimit: 0 } },
});
```

`apps/meowsenger-web/tsconfig.json`:
```json
{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "react" },
  "include": ["src", ".astro/types.d.ts", "astro.config.mjs", "vitest.config.ts"],
  "exclude": ["dist", "coverage", "node_modules"]
}
```

`apps/meowsenger-web/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
// Only src/lib/** (the typed API client) is unit-covered; pages/islands are
// checked by astro check + astro build (honest-90, same as auth-web).
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

`apps/meowsenger-web/wrangler.jsonc`:
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  // Serve the built Astro site (./dist) as a Worker with static assets on the
  // meowsenger.alxnko.eu.org custom domain (Worker path, not Pages).
  "name": "meowsenger-web",
  "compatibility_date": "2025-06-01",
  "assets": { "directory": "./dist" },
  "routes": [{ "pattern": "meowsenger.alxnko.eu.org", "custom_domain": true }]
}
```

`apps/meowsenger-web/public/_headers` (CSP allows `connect-src` to the API host incl. `wss:` for Slice 2):
```
# Cloudflare headers for the meowsenger UI. Cloudflare COMBINES same-name headers
# across matching rules and does NOT let a specific path override /* — so there is
# no blanket Cache-Control under /*; each path sets exactly one (see auth-web).
/*
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://meowsenger-api.alxnko.eu.org wss://meowsenger-api.alxnko.eu.org

/_astro/*
  Cache-Control: public, max-age=31536000, immutable

/
  Cache-Control: public, max-age=0, s-maxage=3600, stale-while-revalidate=86400

# The app shell is session-bearing — never cache.
/app*
  Cache-Control: no-store
```

`apps/meowsenger-web/src/styles/app.css`:
```css
/* App-local styles only; tokens + primitives come from @meowerse/ui/tokens.css. */
html { overflow-x: hidden; }
main { padding-block: clamp(1.75rem, 5vw, 3.25rem); }
```

- [ ] **Step 2: Install** — `cd C:/code/meow/meowerse && bun install` → links `@meowerse/meowsenger-web`.

- [ ] **Step 3: Commit**
```bash
git add apps/meowsenger-web
git commit -m "feat(meowsenger-web): scaffold Astro app shell configs"
```

---

## Task 12: Frontend — API client, header, landing + gated app shell

**Files:**
- Create: `apps/meowsenger-web/src/lib/meowsengerApi.ts`, `src/lib/meowsengerApi.test.ts`
- Create: `apps/meowsenger-web/src/components/MeowsengerHeader.tsx`, `src/components/AppShell.tsx`
- Create: `apps/meowsenger-web/src/layouts/Layout.astro`, `src/pages/index.astro`, `src/pages/app.astro`

- [ ] **Step 1: Write the failing test** — `apps/meowsenger-web/src/lib/meowsengerApi.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { getSession, loginUrl, logoutUrl } from "./meowsengerApi";

const BASE = "https://meowsenger-api.alxnko.eu.org";

describe("meowsengerApi", () => {
  it("loginUrl / logoutUrl build the BFF endpoints", () => {
    expect(loginUrl(BASE)).toBe(`${BASE}/auth/login`);
    expect(logoutUrl(BASE)).toBe(`${BASE}/auth/logout`);
  });
  it("getSession returns the parsed body (credentialed)", async () => {
    const body = { authenticated: true, user: { id: "u1", username: "alex", displayName: null, avatarUrl: null, verified: true } };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getSession(BASE)).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/session`, { credentials: "include" });
    vi.unstubAllGlobals();
  });
  it("getSession returns authenticated:false on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await getSession(BASE)).toEqual({ authenticated: false });
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run to verify fail** — `bun run --filter @meowerse/meowsenger-web test` → FAIL.

- [ ] **Step 3: Implement `apps/meowsenger-web/src/lib/meowsengerApi.ts`**:
```ts
// Typed client for the meowsenger BFF worker. All calls are credentialed so the
// __Host-mw_session cookie (on the API host) rides along. Pure logic — the only
// unit-tested frontend code.
export interface SessionUser {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  verified: boolean;
}
export interface SessionInfo {
  authenticated: boolean;
  user?: SessionUser;
}

export function loginUrl(base: string): string { return `${base}/auth/login`; }
export function logoutUrl(base: string): string { return `${base}/auth/logout`; }

export async function getSession(base: string): Promise<SessionInfo> {
  try {
    const res = await fetch(`${base}/api/session`, { credentials: "include" });
    return (await res.json()) as SessionInfo;
  } catch {
    return { authenticated: false };
  }
}
```

- [ ] **Step 4: Run to verify pass** — `bun run --filter @meowerse/meowsenger-web test` → PASS (≥90% on src/lib/**).

- [ ] **Step 5: Write the UI islands + pages** (validated by `astro check`/`build`, not vitest)

`apps/meowsenger-web/src/components/MeowsengerHeader.tsx`:
```tsx
import { useEffect, useState } from "react";
import { getSession, loginUrl, logoutUrl, type SessionInfo } from "../lib/meowsengerApi";

/** Forked header for meowsenger (the @meowerse/ui Footer/AppHeader are auth-app
 *  specific). Uses design-system mw- classes + tokens. */
export default function MeowsengerHeader({ base }: { base: string }) {
  const [session, setSession] = useState<SessionInfo>({ authenticated: false });
  useEffect(() => { getSession(base).then(setSession); }, [base]);

  async function onLogout() {
    await fetch(logoutUrl(base), { method: "POST", credentials: "include" });
    window.location.href = "/";
  }

  return (
    <header className="mw-row" style={{ padding: "var(--space-3) var(--space-gutter)", alignItems: "center" }}>
      <a href="/" className="mono" style={{ fontFamily: "var(--font-display)", fontSize: "var(--text-lg)" }}>
        meowsenger
      </a>
      {session.authenticated ? (
        <span className="mw-row" style={{ gap: "var(--space-2)", alignItems: "center" }}>
          <span className="mw-muted">{session.user?.username}</span>
          <button className="mw-btn mw-btn--sm" onClick={onLogout}>log out</button>
        </span>
      ) : (
        <a className="mw-btn mw-btn--sm" href={loginUrl(base)}>log in</a>
      )}
    </header>
  );
}
```

`apps/meowsenger-web/src/components/AppShell.tsx` (the gated empty shell that proves auth):
```tsx
import { useEffect, useState } from "react";
import { getSession, loginUrl, type SessionInfo } from "../lib/meowsengerApi";

export default function AppShell({ base }: { base: string }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  useEffect(() => { getSession(base).then(setSession); }, [base]);

  if (session === null) return <div className="mw-gate">loading…</div>;
  if (!session.authenticated) {
    window.location.href = loginUrl(base);
    return <div className="mw-gate">redirecting to login…</div>;
  }
  return (
    <div className="mw-stack">
      <h1>welcome, {session.user?.username}</h1>
      <p className="mw-muted">your chats will appear here. (realtime lands in slice 2.)</p>
    </div>
  );
}
```

`apps/meowsenger-web/src/layouts/Layout.astro`:
```astro
---
import "@meowerse/ui/tokens.css";
import "../styles/app.css";
import { THEME_INIT_SCRIPT } from "@meowerse/ui";
import MeowsengerHeader from "../components/MeowsengerHeader.tsx";
interface Props { title: string }
const { title } = Astro.props;
const base = import.meta.env.PUBLIC_MEOWSENGER_API_URL ?? "https://meowsenger-api.alxnko.eu.org";
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <script is:inline set:html={THEME_INIT_SCRIPT}></script>
  </head>
  <body>
    <MeowsengerHeader client:idle base={base} />
    <main class="mw-container">
      <slot />
    </main>
  </body>
</html>
```

`apps/meowsenger-web/src/pages/index.astro`:
```astro
---
import Layout from "../layouts/Layout.astro";
---
<Layout title="meowsenger">
  <section class="mw-stack">
    <h1>meowsenger</h1>
    <p class="mw-muted">fast, real-time chat for the meowerse. sign in with your meowerse account.</p>
    <p><a class="mw-btn" href="/app">open meowsenger</a></p>
  </section>
</Layout>
```

`apps/meowsenger-web/src/pages/app.astro`:
```astro
---
import Layout from "../layouts/Layout.astro";
import AppShell from "../components/AppShell.tsx";
const base = import.meta.env.PUBLIC_MEOWSENGER_API_URL ?? "https://meowsenger-api.alxnko.eu.org";
---
<Layout title="meowsenger — app">
  <AppShell client:load base={base} />
</Layout>
```

- [ ] **Step 6: Verify build + check**

Run: `bun run --filter @meowerse/meowsenger-web lint` (astro check) → 0 errors.
Run: `ASTRO_TELEMETRY_DISABLED=1 bun run --filter @meowerse/meowsenger-web build` → builds `dist/`.

- [ ] **Step 7: Commit**
```bash
git add apps/meowsenger-web/src
git commit -m "feat(meowsenger-web): API client, header, landing + gated app shell"
```

---

## Task 13: Provision the live OIDC client + create D1 + fill config

**Files:**
- Modify: `workers/meowsenger/wrangler.jsonc` (real `database_id` + `OIDC_CLIENT_ID`)

This task touches live Cloudflare/auth resources (owner-run once). Each step is a command with its expected effect.

- [ ] **Step 1: Create the D1 database**

Run: `cd workers/meowsenger && bunx wrangler d1 create meowsenger`
Expected: prints `database_id = "<uuid>"`. Paste it into `wrangler.jsonc` `d1_databases[0].database_id` (replace `PLACEHOLDER_SET_IN_TASK_13`).

- [ ] **Step 2: Apply the schema to the remote D1**

Run: `bunx wrangler d1 execute meowsenger --remote --file schema.sql`
Expected: "Executed 4 commands" against the remote DB.

- [ ] **Step 3: Create a management token + provision the OIDC client**

In the auth dashboard (auth.alxnko.eu.org → developers → management tokens) create a token, then:
Run: `cd workers/meowsenger && MGMT_TOKEN=<token> bun run provision`
Expected: JSON with `created:true`, a `clientId`, and (first time) a `clientSecret`.

- [ ] **Step 4: Set the client id (var) + secret**

- Add to `workers/meowsenger/wrangler.jsonc` `vars`: `"OIDC_CLIENT_ID": "<clientId from step 3>"`.
- Run: `cd workers/meowsenger && printf '%s' '<clientSecret>' | bunx wrangler secret put OIDC_CLIENT_SECRET`
Expected: "Success! Uploaded secret OIDC_CLIENT_SECRET".

- [ ] **Step 5: Commit the config (secret is NOT committed)**
```bash
git add workers/meowsenger/wrangler.jsonc
git commit -m "chore(meowsenger): wire D1 id + OIDC client id"
```

---

## Task 14: Deploy wiring (scripts, services.sh, justfile, Terraform, WAF, CI)

**Files:**
- Create: `infra/cloudflare/deploy-meowsenger.sh`, `infra/cloudflare/deploy-meowsenger-web.sh`
- Modify: `infra/services.sh`, `justfile`, `infra/cloudflare/deploy.tf`, `infra/cloudflare/waf.tf`, `.github/workflows/deploy.yml`

- [ ] **Step 1: Deploy scripts**

`infra/cloudflare/deploy-meowsenger.sh`:
```bash
#!/usr/bin/env bash
# Deploy the meowsenger Worker via wrangler + record version. Source ../../.env
# first. Secret OIDC_CLIENT_SECRET is set once via `wrangler secret put`.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if git status --porcelain -- workers/meowsenger packages/auth-shared packages/auth-sdk | grep -q .; then
  [ "${ALLOW_DIRTY:-0}" = "1" ] || { echo "ERROR: uncommitted meowsenger changes. commit or ALLOW_DIRTY=1" >&2; exit 1; }
fi
(cd workers/meowsenger && bunx wrangler deploy)
bash infra/record-deploy.sh meowsenger
```

`infra/cloudflare/deploy-meowsenger-web.sh`:
```bash
#!/usr/bin/env bash
# Build + deploy the meowsenger UI (Astro) as a Worker with static assets. Source
# ../../.env first.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if git status --porcelain -- apps/meowsenger-web | grep -q .; then
  [ "${ALLOW_DIRTY:-0}" = "1" ] || { echo "ERROR: uncommitted meowsenger-web changes. commit or ALLOW_DIRTY=1" >&2; exit 1; }
fi
ASTRO_TELEMETRY_DISABLED=1 bun run --filter @meowerse/meowsenger-web build
(cd apps/meowsenger-web && bunx wrangler deploy)
bash infra/record-deploy.sh meowsenger-web
```
Make them executable: `chmod +x infra/cloudflare/deploy-meowsenger*.sh`.

- [ ] **Step 2: `infra/services.sh`** — add two cases to `service_paths()` (after the `auth-web)` line):
```bash
    meowsenger)     echo "workers/meowsenger packages/auth-shared packages/auth-sdk" ;;
    meowsenger-web) echo "apps/meowsenger-web" ;;
```

- [ ] **Step 3: `justfile`** — add after the `deploy-auth-web` recipe:
```makefile
# Deploy the meowsenger worker via wrangler + record version.
deploy-meowsenger:
    bash -c 'set -a; source .env; set +a; bash infra/cloudflare/deploy-meowsenger.sh'

# Deploy the meowsenger UI (Worker static assets) + record version.
deploy-meowsenger-web:
    bash -c 'set -a; source .env; set +a; bash infra/cloudflare/deploy-meowsenger-web.sh'
```

- [ ] **Step 4: `infra/cloudflare/deploy.tf`** — add to `local.services` (inside the map):
```hcl
    meowsenger = {
      paths  = "workers/meowsenger packages/auth-shared packages/auth-sdk"
      script = "infra/cloudflare/deploy-meowsenger.sh"
    }
    meowsenger-web = {
      paths  = "apps/meowsenger-web"
      script = "infra/cloudflare/deploy-meowsenger-web.sh"
    }
```

- [ ] **Step 5: `infra/cloudflare/waf.tf`** — extend the `waf_api_hosts` default:
```hcl
  default     = ["auth-api.alxnko.eu.org", "api.meow.alxnko.eu.org", "meowsenger-api.alxnko.eu.org"]
```

- [ ] **Step 6: `.github/workflows/deploy.yml`** — two additions.

(a) In the `Detect changed services` `run:` block, after the `authweb=` line, add:
```bash
          grep -qE '^(workers/meowsenger/|packages/auth-shared/|packages/auth-sdk/)' <<<"$diff" && echo "meowsenger=1" >> "$GITHUB_OUTPUT" || echo "meowsenger=0" >> "$GITHUB_OUTPUT"
          grep -qE '^apps/meowsenger-web/' <<<"$diff" && echo "meowsengerweb=1" >> "$GITHUB_OUTPUT" || echo "meowsengerweb=0" >> "$GITHUB_OUTPUT"
```

(b) After the `Deploy auth-web` step, add two steps (same shape as the existing ones):
```yaml
      - name: Deploy meowsenger (Cloudflare Worker)
        if: steps.changed.outputs.meowsenger == '1' && env.CF != ''
        env:
          CF: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          set -euo pipefail
          (cd workers/meowsenger && bunx wrangler deploy)
          bash infra/record-deploy.sh meowsenger "run-${{ github.run_id }}"

      - name: Deploy meowsenger-web (Cloudflare Worker static assets)
        if: steps.changed.outputs.meowsengerweb == '1' && env.CF != ''
        env:
          CF: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          set -euo pipefail
          bun run --filter @meowerse/meowsenger-web build
          (cd apps/meowsenger-web && bunx wrangler deploy)
          bash infra/record-deploy.sh meowsenger-web "run-${{ github.run_id }}"
```

- [ ] **Step 7: Commit**
```bash
git add infra justfile .github/workflows/deploy.yml
git commit -m "chore(meowsenger): deploy wiring — scripts, services, terraform, WAF, CI"
```

---

## Task 15: Full gate, deploy, verify live

- [ ] **Step 1: Full local gate**

Run: `cd C:/code/meow/meowerse && just lint && just test`
Expected: all green (both new packages included by turbo globs).

- [ ] **Step 2: Deploy the worker, then the UI** (order matters: the callback host must exist before login works)

Run: `just deploy-meowsenger`
Run: `just deploy-meowsenger-web`
Expected: both `wrangler deploy` succeed; `meowsenger-api.alxnko.eu.org` + `meowsenger.alxnko.eu.org` resolve (wrangler provisions DNS + cert for the custom domains).

- [ ] **Step 3: Apply WAF (adds the new API host to the rate-limit rule)**

Run: `just deploy-all` (or a targeted `terraform apply -target=cloudflare_ruleset.api_rate_limit` from `infra/cloudflare`)
Expected: `api_rate_limit` updated in place to include `meowsenger-api.alxnko.eu.org`.

- [ ] **Step 4: Verify live**

- `curl -si https://meowsenger-api.alxnko.eu.org/health` → `200 {"ok":true}`.
- `curl -si https://meowsenger-api.alxnko.eu.org/api/session` (no cookie) → `200 {"authenticated":false}`.
- Browser: open `https://meowsenger.alxnko.eu.org/app` → redirects to auth login → after login, returns to `/app` showing "welcome, <username>". This proves OIDC + BFF end to end.
- `curl -si https://meowsenger-api.alxnko.eu.org/auth/login` → `302` to `auth-api.alxnko.eu.org/authorize?...` with a `__Host-mw_txn` Set-Cookie.

- [ ] **Step 5: Record + final commit** (record-deploy.sh already wrote `infra/deploy-state.json`)
```bash
git add infra/deploy-state.json
git commit -m "chore(meowsenger): record slice-1 deploy"
```

---

## Self-review notes (author)

- **Spec coverage:** §3.1 (app shell, forked header) → T11–12; §3.2 (router worker, `handle`+`Deps`) → T1,T9; §3.4 + §4.1 (D1 users/sessions) → T2,T3; §5 (OIDC RP + BFF, userinfo upsert, session cookie) → T5,T6,T7,T8,T10,T13; §8 (WAF host, no Turnstile) → T14; §11 (deploy wiring) → T14–15; §12 (90% worker src/**, 90% app src/lib/**) → per-task tests + T15 gate. DO/realtime (§3.3, §6) and chats/members (§4.1 remainder) are **Slice 2** — intentionally out of scope here.
- **Correction vs spec §5.5:** profile claims come from `/userinfo`, not the id_token (the auth worker keeps data-bearing claims out of the id_token). The callback fetches `/userinfo`; the spec line will be reconciled.
- **Type consistency:** `DbClient` (`all/first/run`), `Deps` (`getDb/auth/fetchFn/now/newId`), `Session`, cookie names, and `SessionInfo`/`SessionUser` are used identically across T3–T12.
- **Coverage caveat:** `prodDeps` (real D1/AuthClient wiring in `deps.ts`) is thin and injected-around in tests; if v8 dips below 90% on `deps.ts`, add a small test that calls `prodDeps({DB, OIDC_*})` with a fake `D1Database`+env and asserts `getDb()`/`auth()` are memoized (return the same instance twice). Left as a guard, not pre-written, to avoid over-fitting.
```
