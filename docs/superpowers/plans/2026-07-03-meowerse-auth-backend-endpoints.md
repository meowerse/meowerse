# Auth Backend Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two auth-worker endpoints the auth-web overhaul needs: `GET /api/session` (cheap whoami for the header + route guards) and `POST /api/account/delete` (right-to-erasure), plus a `deleteAccount` DB helper.

**Architecture:** Extend `workers/auth/src/index.ts`'s DI router and `accounts.ts`, following the existing `handleAccount` pattern (session + CSRF via `lookupSession`/`validateCsrf`, `json`/`securityHeaders` helpers). The `DbClient` interface exposes only `.execute()` — no `.batch()` — and cross-`execute` transactions don't hold over Turso's stateless HTTP, so `deleteAccount` issues sequential `DELETE`s, children first and the `accounts` row last (retry-safe; a partial failure leaves the account intact so a retry completes it). This corrects the design spec's `.batch()` note.

**Tech Stack:** Cloudflare Workers (TypeScript), `@libsql/client/web`, Vitest with the existing `memStore`/`routedDb` fakes in `workers/auth/test/helpers.ts`.

**This is Plan 2 of 4.** Independent of Plan 1. Plan 3 (auth-web) consumes these endpoints.

---

## File structure

```
workers/auth/src/accounts.ts     # + deleteAccount()
workers/auth/src/index.ts        # + handleSession(), + handleAccount "delete" sub, + 2 routes
workers/auth/test/helpers.ts     # + memStore DELETE handlers (sessions/account by id)
workers/auth/test/accounts.test.ts        # + deleteAccount unit test (routedDb)
workers/auth/test/index.session.test.ts   # + GET /api/session tests (append)
workers/auth/test/index.account.test.ts   # + POST /api/account/delete tests (append)
```

---

## Task 1: `deleteAccount` DB helper

**Files:**
- Modify: `workers/auth/src/accounts.ts` (append)
- Test: `workers/auth/test/accounts.test.ts` (append)

- [ ] **Step 1: Write the failing test (append to `accounts.test.ts`)**

```ts
import { deleteAccount } from "../src/accounts";
import { routedDb } from "./helpers";

test("deleteAccount deletes owned-client children + all account-keyed rows, accounts LAST", async () => {
  const log: { sql: string; args: unknown[] }[] = [];
  const db = routedDb(
    [[/SELECT client_id FROM oauth_clients WHERE owner_account_id/, () => ({ rows: [{ client_id: "app1" }] })]],
    log,
  );
  await deleteAccount(db, "acct_x");
  const deletes = log.map((l) => l.sql.replace(/\s+/g, " ").trim()).filter((s) => s.startsWith("DELETE"));
  // owned-client children present
  expect(deletes.some((s) => /oauth_client_secrets WHERE client_id/.test(s))).toBe(true);
  expect(deletes.some((s) => /oauth_client_redirect_uris WHERE client_id/.test(s))).toBe(true);
  // account-keyed tables present
  for (const tbl of ["recovery_codes", "password_credentials", "telegram_links", "sessions", "access_tokens", "refresh_tokens", "oauth_codes"]) {
    expect(deletes.some((s) => new RegExp(`DELETE FROM ${tbl} WHERE account_id`).test(s))).toBe(true);
  }
  // owned clients deleted, then the account row LAST
  expect(deletes.some((s) => /oauth_clients WHERE owner_account_id/.test(s))).toBe(true);
  expect(deletes[deletes.length - 1]).toMatch(/DELETE FROM accounts WHERE id/);
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/auth test -- accounts`
Expected: FAIL (`deleteAccount` is not exported).

- [ ] **Step 3: Implement `deleteAccount` (append to `accounts.ts`)**

```ts
/**
 * Erase an account and everything it owns. `DbClient` has no `.batch()` and
 * cross-execute transactions don't hold over Turso HTTP, so we delete
 * sequentially, children first and the `accounts` row LAST — a partial failure
 * leaves the account intact and a retry completes it. Table names below are a
 * fixed allow-list (never user input), so the string interpolation is safe.
 */
export async function deleteAccount(db: DbClient, accountId: string): Promise<void> {
  const owned = await db.execute({ sql: "SELECT client_id FROM oauth_clients WHERE owner_account_id = ?", args: [accountId] });
  for (const row of owned.rows) {
    const cid = String(row.client_id);
    await db.execute({ sql: "DELETE FROM oauth_client_secrets WHERE client_id = ?", args: [cid] });
    await db.execute({ sql: "DELETE FROM oauth_client_redirect_uris WHERE client_id = ?", args: [cid] });
    await db.execute({ sql: "DELETE FROM consents WHERE client_id = ?", args: [cid] });
  }
  const accountKeyed = [
    "recovery_codes", "password_credentials", "telegram_links", "sessions",
    "consents", "access_tokens", "refresh_tokens", "management_tokens",
    "oauth_codes", "login_requests", "login_tickets",
  ];
  for (const tbl of accountKeyed) {
    await db.execute({ sql: `DELETE FROM ${tbl} WHERE account_id = ?`, args: [accountId] });
  }
  await db.execute({ sql: "DELETE FROM oauth_clients WHERE owner_account_id = ?", args: [accountId] });
  await db.execute({ sql: "DELETE FROM accounts WHERE id = ?", args: [accountId] });
}
```

- [ ] **Step 4: Run — expect PASS.** Run: `bun run --filter @meowerse/auth test -- accounts`

- [ ] **Step 5: Commit**

```bash
git add workers/auth/src/accounts.ts workers/auth/test/accounts.test.ts
git commit -m "feat(auth): deleteAccount helper (sequential child-first erasure)"
```

---

## Task 2: `GET /api/session` endpoint

**Files:**
- Modify: `workers/auth/src/index.ts` (add `handleSession` + route)
- Test: `workers/auth/test/index.session.test.ts` (append)

- [ ] **Step 1: Write the failing test (append to `index.session.test.ts`)**

```ts
import { test, expect } from "vitest";
import { handle } from "../src/index";
import { genSigningKeys, memStore, cookieValue } from "./helpers";

async function login(username: string) {
  const store = memStore();
  const keys = await genSigningKeys();
  const env = { AUTH_SIGNING_KEYS: JSON.stringify(keys), ISSUER: "https://iss", CORS_ORIGINS: "https://web" };
  const deps = { getDb: () => store.db, clock: () => 1000 };
  const su = await handle(new Request("https://iss/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: "accttest1234" }) }), env as never, deps as never);
  const sess = cookieValue(su.headers.get("Set-Cookie"), "__Host-mw_sess")!;
  return { store, env, deps, sess };
}

test("GET /api/session reports the logged-in user", async () => {
  const { env, deps, sess } = await login("sess_user");
  const r = await handle(new Request("https://iss/api/session", { headers: { Cookie: `__Host-mw_sess=${sess}` } }), env as never, deps as never);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ authenticated: true, username: "sess_user", verified: false });
});

test("GET /api/session reports a guest with no session (200, not 401)", async () => {
  const { env, deps } = await login("sess_guest");
  const r = await handle(new Request("https://iss/api/session"), env as never, deps as never);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ authenticated: false });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/auth test -- index.session`
Expected: FAIL (route returns 404 / no `authenticated` field).

- [ ] **Step 3: Add `handleSession` (in `index.ts`, place it just before `handleAccount`)**

```ts
/** Cheap whoami for the web header + client route guards. Always 200. */
async function handleSession(req: Request, env: Env, deps: Deps, cors: Record<string, string>): Promise<Response> {
  const db = deps.getDb();
  const cookies = parseCookies(req.headers.get("Cookie"));
  const session = await lookupSession(db, cookies[`__Host-${SESS_COOKIE}`], now(deps));
  if (!session) return json({ authenticated: false }, 200, { ...cors, ...securityHeaders() });
  const info = await getAccountInfo(db, session.accountId);
  if (!info) return json({ authenticated: false }, 200, { ...cors, ...securityHeaders() });
  return json(
    { authenticated: true, username: info.username ?? info.displayName ?? "you", verified: await deriveVerified(db, session.accountId) },
    200,
    { ...cors, ...securityHeaders() },
  );
}
```

- [ ] **Step 4: Register the route (in `handle()`, add next to the `/api/account` route, ~line 737)**

```ts
  if (pathname === "/api/session" && m === "GET") return handleSession(req, env, deps, cors);
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/auth test -- index.session`

- [ ] **Step 6: Commit**

```bash
git add workers/auth/src/index.ts workers/auth/test/index.session.test.ts
git commit -m "feat(auth): GET /api/session whoami endpoint"
```

---

## Task 3: `POST /api/account/delete` endpoint

**Files:**
- Modify: `workers/auth/src/index.ts` (import `deleteAccount`; add "delete" sub in `handleAccount`)
- Modify: `workers/auth/test/helpers.ts` (memStore: DELETE sessions/account by id)
- Test: `workers/auth/test/index.account.test.ts` (append)

- [ ] **Step 1: Extend `memStore` so the account + its session actually vanish (in `helpers.ts`, add these near the other account-self-service handlers, before the generic INSERT/SELECT blocks)**

```ts
      if (/DELETE FROM sessions WHERE account_id/.test(sql)) {
        t.sessions = t.sessions.filter((r) => r.account_id !== a[0]);
        return { rows: [] };
      }
      if (/DELETE FROM accounts WHERE id/.test(sql)) {
        t.accounts = t.accounts.filter((r) => r.id !== a[0]);
        return { rows: [] };
      }
```

- [ ] **Step 2: Write the failing test (append to `index.account.test.ts`)**

```ts
test("POST /api/account/delete: bad csrf 403, wrong confirm 400, correct erases + clears cookie + kills session", async () => {
  const { env, deps, sess, csrf } = await loggedIn("neko_del");
  // bad csrf
  expect((await post(env, deps, "/api/account/delete", sess, { csrf: "WRONG", confirm: "neko_del" })).status).toBe(403);
  // wrong confirmation phrase
  expect((await post(env, deps, "/api/account/delete", sess, { csrf, confirm: "nope" })).status).toBe(400);
  // correct
  const ok = await post(env, deps, "/api/account/delete", sess, { csrf, confirm: "neko_del" });
  expect(ok.status).toBe(200);
  expect(ok.headers.get("Set-Cookie")).toContain("mw_sess");
  // session is gone → the same cookie now 401s
  expect((await get(env, deps, "/api/account", sess)).status).toBe(401);
});
```

- [ ] **Step 2b: Run — expect FAIL.** Run: `bun run --filter @meowerse/auth test -- index.account`
Expected: FAIL (delete sub returns 404).

- [ ] **Step 3: Import `deleteAccount` (extend the existing accounts import in `index.ts` line ~16)**

```ts
import { signup, loginVerify, deriveVerified, DEFAULT_DUMMY_PHC, getAccountInfo, changePassword, regenerateRecoveryCodes, countRecoveryCodes, deleteAccount } from "./accounts";
```

- [ ] **Step 4: Add the "delete" sub-route inside `handleAccount` (after the `recovery-codes` branch, before the final `return json({ error: "not_found" }, 404, cors)`)**

```ts
  if (sub === "delete") {
    const info = await getAccountInfo(db, accountId);
    if (!info) return json({ error: "not_found" }, 404, cors);
    const expected = info.username ?? info.displayName ?? "";
    if ((p.confirm ?? "") !== expected) return json({ error: "confirm_mismatch" }, 400, cors);
    await deleteAccount(db, accountId);
    return json({ ok: true }, 200, { ...cors, "Set-Cookie": clearHostCookie(SESS_COOKIE) });
  }
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/auth test -- index.account`

- [ ] **Step 6: Commit**

```bash
git add workers/auth/src/index.ts workers/auth/test/helpers.ts workers/auth/test/index.account.test.ts
git commit -m "feat(auth): POST /api/account/delete (type-username erasure)"
```

---

## Task 4: Full worker gate

- [ ] **Step 1: Run the whole auth-worker suite + coverage**

Run: `bun run --filter @meowerse/auth test`
Expected: all tests pass; branch coverage stays ≥90% (the repo `bunfig.toml` gate). If a new branch (e.g. `handleSession` no-account path, `deleteAccount` empty-owned path) dips coverage, add a targeted case: a session for a since-deleted account → `{authenticated:false}`; `deleteAccount` with zero owned clients still deletes account-keyed rows.

- [ ] **Step 2: Lint**

Run: `bun run --filter @meowerse/auth lint`
Expected: exits 0.

- [ ] **Step 3: Monorepo gate**

Run: `cd C:/code/meow/meowerse && just lint && just test`
Expected: green.

- [ ] **Step 4: Commit any coverage top-up tests**

```bash
git add workers/auth/test
git commit -m "test(auth): cover session no-account + empty-owned delete branches"
```

---

## Self-review checklist

- **Spec coverage (§15):** `GET /api/session` (Task 2) · `POST /api/account/delete` with type-username confirm + CSRF + cookie clear (Task 3) · explicit sequential child-first deletes, not cascade/batch (Task 1) · tests prove erasure order + endpoint behavior.
- **Type consistency:** `deleteAccount(db, accountId)` signature matches its import + call in Task 3. `handleSession` uses the same helpers (`parseCookies`, `lookupSession`, `getAccountInfo`, `deriveVerified`, `json`, `securityHeaders`) already imported in `index.ts`. `clearHostCookie` + `SESS_COOKIE` already in scope. Response shape `{authenticated, username, verified}` matches Plan 1's `useSession`/`Session` type.
- **Placeholder scan:** none — every step has real code + exact run command.

## Notes for the implementer

- **Filter name:** the package is `@meowerse/auth` (confirm via `workers/auth/package.json` `name`); if it differs, adjust the `--filter` value.
- **`clearHostCookie` format:** it returns a `Set-Cookie` string that expires the `__Host-mw_sess` cookie; the test only asserts the header contains `mw_sess`, so it's format-agnostic.
- **`login_requests`/`management_tokens`/`login_tickets`** aren't tracked by `memStore`, so their `DELETE`s no-op in tests — that's fine; the `routedDb` unit test (Task 1) proves the SQL is emitted, and production (real Turso) honors it.
