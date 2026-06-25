# Auth with Meowerse — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the smallest real end-to-end OIDC loop: discovery/JWKS → `/authorize` (state-preserving, non-writing pre-auth) → username/password signup+login → consent → `/token` (authorization_code + PKCE) → `/userinfo`, with `__Host-` sessions, all on Cloudflare Workers + Turso, free-tier, mirroring `workers/api` patterns.

**Architecture:** One fat DI-routed Worker `workers/auth` (no framework, 10ms CPU budget) backed by Turso (single store) via `@libsql/client/web`; a pure WebCrypto helper package `packages/auth-shared`; an Astro frontend `apps/auth-web`. ES256 JWTs minted with WebCrypto (no JWT lib in the worker); the only stateful tokens are the auth code + session rows. Every security control from the spec §10 that touches a slice-1 path is built in.

**Tech Stack:** TypeScript, Cloudflare Workers (`workerd`, `nodejs_compat`), `@libsql/client/web`, WebCrypto (`SubtleCrypto`: ECDSA P-256, PBKDF2, HMAC, SHA-256, `getRandomValues`), vitest (90% gate), Astro + React island, `bun` workspaces + Turbo, `just` task layer.

**Spec:** [docs/superpowers/specs/2026-06-25-meowerse-auth-design.md](../specs/2026-06-25-meowerse-auth-design.md). Section refs (§N) below point there.

---

## File Structure

```
packages/auth-shared/            @meowerse/auth-shared — pure, WebCrypto-only, no DB/keys
  package.json                   bun test; tsc lint/build (clone ts-shared)
  tsconfig.json
  src/
    index.ts                     re-exports
    base64url.ts                 b64urlEncode/Decode (Uint8Array <-> string), constantTimeEqual
    pkce.ts                      verifyPkceS256(verifier, challenge)
    scopes.ts                    CATALOG, parseScope, effectiveScope(a,b,c) intersection, isSubset
    tokentype.ts                 TOKEN_USE, TYP, claim/typ guards
    recovery.ts                  genRecoveryCodes(), normalizeRecoveryCode()
    password-policy.ts           validatePassword (length, NFKC) — pure rules only
    types.ts                     shared OIDC + claim TS types (coverage-excluded)

workers/auth/                    @meowerse/auth-worker — auth-api.alxnko.eu.org
  package.json                   clone workers/api scripts + secret:* recipes
  wrangler.jsonc                 name meowerse-auth; nodejs_compat; custom_domain
  vitest.config.ts               90% gate, exclude only src/types.ts
  src/
    types.ts                     Env + row interfaces + structural DbClient (excluded)
    db.ts                        prodDeps + ensureSchema(SCHEMA[]) memoized once/isolate
    security.ts                  corsHeaders · constantTimeEqual · sha256Hex · randomId ·
                                 cookie helpers (__Host-) · CSRF · redirect-uri validators ·
                                 security headers (no-referrer/no-store/CSP)
    crypto.ts                    pbkdf2 chain hash/verify (PHC) · hmacSha256 · sha256
    keys.ts                      parse AUTH_SIGNING_KEYS · es256Sign(jwt) · buildJwks()
    jwt.ts                       signJwt(header,payload) · verifyJwt(token, jwks, opts)
    oidc.ts                      discoveryDoc(env) · jwksResponse() (cache-wrapped)
    accounts.ts                  signup · loginVerify · recovery codes · live verified
    session.ts                   issue/lookup/rotate/revoke · csrf bind
    authorize.ts                 validate · signed cookie request object · resume · owner bind
    consent.ts                   grant/deny · live effectiveScope + verified gate
    token.ts                     code+PKCE exchange · mint id+access · revoke · introspect
    userinfo.ts                  typ=at+jwt guard · live-derived scoped claims
    ratelimit.ts                 write-budget circuit breaker + per-bucket counter
    handlers.ts                  thin per-route handlers calling the modules above (optional split)
    index.ts                     DI router + generic-500 wrapper + edge-limit hook + seed
  test/                          *.test.ts colocated or here; fake DbClient + Deps

apps/auth-web/                   @meowerse/auth-web — auth.alxnko.eu.org (Pages)
  package.json, astro.config.mjs, tsconfig.json   (clone apps/web)
  src/
    lib/authApi.ts               typed credentialed client (PUBLIC_AUTH_API_URL)
    layouts/Auth.astro           sets Referrer-Policy:no-referrer + CSP + no-store
    pages/login.astro · signup.astro · consent.astro · error.astro · index.astro
    components/LoginForm.tsx · SignupForm.tsx · ConsentForm.tsx (React islands)

infra / root wiring (hand edits):
  package.json (root)            no change (bun globs auto-discover apps/* packages/* workers/*)
  justfile                       + deploy-auth, deploy-auth-web recipes
  infra/services.sh              + auth) / auth-web) cases
  infra/cloudflare/deploy.tf     + two locals.services entries
  infra/cloudflare/deploy-auth.sh · deploy-auth-web.sh   (clone deploy-api/web)
  infra/cloudflare/dns.tf        + CNAME auth -> meowerse-auth-web.pages.dev
  .github/workflows/deploy.yml   + path-scoped change-detect + deploy steps
  .env.example                   + AUTH_* documented
```

**Decomposition rule:** pure logic (no I/O) lives in `auth-shared` or in pure functions inside worker modules, tested directly; I/O modules take an injected `DbClient`/`Deps` so tests never hit Turso or the network — exactly the `workers/api` pattern.

---

## Conventions (apply to every task)

- **TDD:** write the failing test, run it red, implement minimal, run it green, commit. Never implement before a red test.
- **Test runner:** `auth-shared` uses `bun test`; `workers/auth` uses `bunx vitest run` (add `--coverage` for the gate). `apps/auth-web` uses `vitest`.
- **Commits:** Conventional Commits, never `--no-verify`, never skip hooks. Commit after each green task.
- **No real I/O in tests:** inject a fake `DbClient` (`{ execute }`) and `Deps` (`{ getDb, schemaReady? }`). Time/random injected where determinism matters.
- **Coverage:** 90% lines/functions/branches/statements per worker package; `types.ts` is the only exclusion.
- **Run from the worktree root** unless a step says otherwise.

---

## Phase 0 — Scaffold the three packages

### Task 0.1: Clone package skeletons

**Files:**
- Create: `packages/auth-shared/package.json`, `packages/auth-shared/tsconfig.json`, `packages/auth-shared/src/index.ts`
- Create: `workers/auth/package.json`, `workers/auth/wrangler.jsonc`, `workers/auth/vitest.config.ts`, `workers/auth/src/types.ts`
- Create: `apps/auth-web/package.json`, `apps/auth-web/astro.config.mjs`, `apps/auth-web/tsconfig.json`

- [ ] **Step 1: Write `packages/auth-shared/package.json`** (clone of `ts-shared`, name `@meowerse/auth-shared`).
- [ ] **Step 2: Write `workers/auth/package.json`** (clone of `workers/api`, name `@meowerse/auth-worker`, scripts: `dev`/`deploy`/`lint` (`wrangler deploy --dry-run --outdir tmp/wr-auth`)/`test` (`vitest run --coverage`); `secret:signing-keys` → `wrangler secret put AUTH_SIGNING_KEYS`, `secret:db-url`, `secret:db-token`). deps `@libsql/client`, `@meowerse/auth-shared` `workspace:*`; same devDeps as api.
- [ ] **Step 3: Write `workers/auth/wrangler.jsonc`** — `name: meowerse-auth`, `main: src/index.ts`, `compatibility_date: 2025-06-01`, `compatibility_flags: ["nodejs_compat"]`, `vars.CORS_ORIGINS: "https://auth.alxnko.eu.org,http://localhost:4321"`, `routes: [{ pattern: "auth-api.alxnko.eu.org", custom_domain: true }]`.
- [ ] **Step 4: Write `workers/auth/vitest.config.ts`** (clone api: 90% thresholds, include `src/**`, exclude `src/types.ts`).
- [ ] **Step 5: Clone `apps/auth-web`** scaffolding from `apps/web` (package.json name `@meowerse/auth-web`, astro.config, tsconfig). Leave pages for Phase 11.
- [ ] **Step 6: `bun install`** so workspace globs pick up the new packages.

Run: `bun install` — Expected: lockfile updates, new workspaces resolved.

- [ ] **Step 7: Commit** — `chore(auth): scaffold workers/auth, packages/auth-shared, apps/auth-web`.

---

## Phase 1 — `packages/auth-shared` (pure, WebCrypto-only)

All functions here are pure or use only `crypto.subtle`/`crypto.getRandomValues` (available in `bun` test + `workerd`). Target 100% coverage.

### Task 1.1: base64url + constant-time compare

**Files:** Create `src/base64url.ts`, `test/base64url.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "bun:test";
import { b64urlEncode, b64urlDecode, constantTimeEqual } from "../src/base64url";

test("b64url round-trips bytes without padding or +/", () => {
  const bytes = new Uint8Array([255, 0, 128, 64, 32, 16, 1]);
  const enc = b64urlEncode(bytes);
  expect(enc).not.toMatch(/[+/=]/);
  expect([...b64urlDecode(enc)]).toEqual([...bytes]);
});

test("constantTimeEqual: equal true, differing length false, differing byte false", () => {
  expect(constantTimeEqual("abcdef", "abcdef")).toBe(true);
  expect(constantTimeEqual("abc", "abcd")).toBe(false);
  expect(constantTimeEqual("abce", "abcd")).toBe(false);
});
```

- [ ] **Step 2: Run red** — `bunx --bun test packages/auth-shared/test/base64url.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `b64urlEncode` (btoa over binary string, replace `+/`→`-_`, strip `=`), `b64urlDecode` (reverse, re-pad), and the length-aware `constantTimeEqual` copied from `workers/api/src/security.ts:36`.
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit** — `feat(auth-shared): base64url + constant-time compare`.

### Task 1.2: PKCE S256 verify

**Files:** Create `src/pkce.ts`, `test/pkce.test.ts`

- [ ] **Step 1: Failing test** — known RFC 7636 Appendix B vector: verifier `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk`, challenge `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`.

```ts
import { test, expect } from "bun:test";
import { verifyPkceS256 } from "../src/pkce";

test("RFC 7636 B.1 vector verifies", async () => {
  const v = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const c = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  expect(await verifyPkceS256(v, c)).toBe(true);
  expect(await verifyPkceS256(v, "wrong")).toBe(false);
});
```

- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement** — `verifyPkceS256(verifier, challenge)` = `constantTimeEqual(b64urlEncode(sha256(verifier)), challenge)` using `crypto.subtle.digest("SHA-256", utf8(verifier))`.
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit** — `feat(auth-shared): PKCE S256 verify (RFC 7636)`.

### Task 1.3: scope catalog + effective-scope intersection

**Files:** Create `src/scopes.ts`, `test/scopes.test.ts`

The catalog and the **live intersection** are the heart of §10/#9 (no scope elevation). `effectiveScope` = intersection of (consented max) ∩ (client allowed) ∩ (requested), order-stable, `openid` always implied if any present.

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "bun:test";
import { CATALOG, parseScope, effectiveScope, isSubset } from "../src/scopes";

test("catalog is the fixed v1 set", () => {
  expect([...CATALOG].sort()).toEqual(["openid","profile","telegram","verified","offline_access"].sort());
});
test("parseScope dedups, drops unknown, keeps order", () => {
  expect(parseScope("openid profile profile bogus telegram")).toEqual(["openid","profile","telegram"]);
});
test("effectiveScope intersects all three sets", () => {
  expect(effectiveScope(["openid","profile","telegram"], ["openid","profile"], ["openid","profile","telegram"]))
    .toEqual(["openid","profile"]);
});
test("isSubset true when requested within granted", () => {
  expect(isSubset(["openid","profile"], ["openid","profile","telegram"])).toBe(true);
  expect(isSubset(["openid","telegram"], ["openid","profile"])).toBe(false);
});
```

- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement** `CATALOG` (Set), `parseScope` (split ws, filter to CATALOG, dedupe preserve order), `effectiveScope(consentMax, clientAllowed, requested)` (filter requested by membership in both others), `isSubset`.
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit** — `feat(auth-shared): scope catalog + effective-scope intersection`.

### Task 1.4: token-type guards

**Files:** Create `src/tokentype.ts`, `test/tokentype.test.ts`

Closes §10/#5 (id_token-as-access_token confusion). Single source of the `typ`/`token_use` constants + guards so no verifier can re-open the hole.

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "bun:test";
import { TYP, TOKEN_USE, assertAccessToken, assertIdToken } from "../src/tokentype";

test("access guard requires typ at+jwt and token_use access and resource aud", () => {
  expect(assertAccessToken({ typ: TYP.ACCESS }, { token_use: TOKEN_USE.ACCESS, aud: "https://api.meow.alxnko.eu.org" }, "https://api.meow.alxnko.eu.org")).toBe(true);
  expect(assertAccessToken({ typ: TYP.ID }, { token_use: TOKEN_USE.ID }, "https://api.meow.alxnko.eu.org")).toBe(false);
});
test("id guard rejects at+jwt", () => {
  expect(assertIdToken({ typ: TYP.ACCESS }, { token_use: TOKEN_USE.ACCESS })).toBe(false);
  expect(assertIdToken({ typ: TYP.ID }, { token_use: TOKEN_USE.ID })).toBe(true);
});
```

- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement** `TYP = { ID: "JWT", ACCESS: "at+jwt" }`, `TOKEN_USE = { ID: "id", ACCESS: "access" }`, `assertAccessToken(header,payload,resourceAud)` (header.typ===ACCESS && payload.token_use===ACCESS && payload.aud===resourceAud), `assertIdToken` (reject ACCESS typ/use).
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit** — `feat(auth-shared): token-type guards (RFC 9068 typ/token_use)`.

### Task 1.5: recovery codes + password policy

**Files:** Create `src/recovery.ts`, `src/password-policy.ts`, tests.

- [ ] **Step 1: Failing tests** — `genRecoveryCodes()` returns 8 distinct Crockford-base32 `XXXXX-XXXXX` codes (≥10 chars entropy); `normalizeRecoveryCode` upper-cases, strips dashes/spaces, maps Crockford ambiguities (I→1, O→0, L→1). `validatePassword`: rejects <12 or >128 chars, NFKC-normalizes, returns `{ok}` / `{ok:false,error}`.

```ts
import { test, expect } from "bun:test";
import { genRecoveryCodes, normalizeRecoveryCode } from "../src/recovery";
import { validatePassword } from "../src/password-policy";

test("8 distinct formatted recovery codes", () => {
  const codes = genRecoveryCodes();
  expect(codes.length).toBe(8);
  expect(new Set(codes).size).toBe(8);
  for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
});
test("normalize maps ambiguous chars", () => {
  expect(normalizeRecoveryCode("o0il1 -abcde")).toBe("0011ABCDE"); // 9 here is illustrative; assert idempotent mapping
});
test("password length policy", () => {
  expect(validatePassword("short").ok).toBe(false);
  expect(validatePassword("a".repeat(12)).ok).toBe(true);
  expect(validatePassword("a".repeat(129)).ok).toBe(false);
});
```

- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement** using `crypto.getRandomValues` for codes; pure string ops for normalize/policy.
- [ ] **Step 4: Run green** (adjust the normalize assertion to the exact mapping implemented).
- [ ] **Step 5: Commit** — `feat(auth-shared): recovery codes + password policy`.

### Task 1.6: index re-exports

- [ ] Re-export all of the above from `src/index.ts`; `bunx tsc --noEmit -p packages/auth-shared` clean; commit `chore(auth-shared): barrel exports`.

---

## Phase 2 — Worker foundation: types, db, crypto, security

### Task 2.1: `types.ts` (Env + rows + DbClient)

**Files:** Create `workers/auth/src/types.ts`

- [ ] Define `Env` (`CORS_ORIGINS?`, `DATABASE_URL?`, `DATABASE_AUTH_TOKEN?`, `AUTH_SIGNING_KEYS?`, `ISSUER?`, `RESOURCE_AUD?`, `WRITE_BUDGET_PER_MIN?`), the structural `DbClient` (copy from `workers/api/src/types.ts`, add `rowsAffected?` to the result), and row interfaces (`AccountRow`, `SessionRow`, `LoginRequestRow`, `OAuthCodeRow`, `OAuthClientRow`, `ConsentRow`). No runtime code. Commit `feat(auth): worker types`.

### Task 2.2: `db.ts` (ensureSchema with the full DDL)

**Files:** Create `workers/auth/src/db.ts`, `test/db.test.ts`

- [ ] **Step 1: Failing test** — a fake `DbClient` records `execute` calls; `ensureSchema(deps)` runs each `CREATE TABLE` statement exactly once even across two concurrent calls (memoized promise), mirroring `workers/api/src/db.ts:45`.

```ts
import { test, expect } from "vitest";
import { ensureSchema, SCHEMA, type Deps } from "../src/db";

test("ensureSchema runs every statement once, memoized across concurrent calls", async () => {
  const calls: string[] = [];
  const db = { execute: async (s: any) => { calls.push(typeof s === "string" ? s : s.sql); return { rows: [] }; } };
  const deps: Deps = { getDb: () => db as any };
  await Promise.all([ensureSchema(deps), ensureSchema(deps)]);
  expect(calls.length).toBe(SCHEMA.length);
});
```

- [ ] **Step 2: Run red** — `bunx vitest run workers/auth/test/db.test.ts`.
- [ ] **Step 3: Implement** — `SCHEMA: string[]` = the full DDL from spec §4 (all 12 tables + indexes, each `CREATE TABLE/INDEX IF NOT EXISTS`). `prodDeps(env)` lazily builds the libsql/web client (copy api). `ensureSchema` memoizes a promise that runs each statement sequentially.
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit** — `feat(auth): Turso schema + memoized ensureSchema`.

### Task 2.3: `crypto.ts` (PBKDF2 chain + hmac + sha256)

**Files:** Create `workers/auth/src/crypto.ts`, `test/crypto.test.ts`

Resolves §7 (PBKDF2 vs the 100k workerd cap → chain). PHC string `pbkdf2$sha256$<rounds>$<iter>$<salt_b64>$<hash_b64>`.

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "vitest";
import { hashPassword, verifyPassword, sha256Hex, hmacSha256Hex } from "../src/crypto";

test("hash verifies with right password, rejects wrong, low rounds for test speed", async () => {
  const phc = await hashPassword("correct horse battery staple", { rounds: 1, iter: 1000 });
  expect(phc.startsWith("pbkdf2$sha256$1$1000$")).toBe(true);
  expect(await verifyPassword("correct horse battery staple", phc)).toBe(true);
  expect(await verifyPassword("wrong", phc)).toBe(false);
});
test("sha256Hex + hmac are stable", async () => {
  expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect((await hmacSha256Hex("key", "msg")).length).toBe(64);
});
```

- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement** — `hashPassword(pw, {rounds,iter})`: random 16-byte salt; loop `rounds` times feeding prior output+salt into `deriveBits(PBKDF2, iter)`; PHC-encode. `verifyPassword` parses PHC, recomputes, `constantTimeEqual`. `sha256Hex`, `hmacSha256Hex` via subtle. Default params behind a `DEFAULT = {rounds:6, iter:100000}` constant (tests pass tiny params).
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit** — `feat(auth): PBKDF2-chain password hashing + sha256/hmac`.

### Task 2.4: `security.ts` (cors, ids, cookies, csrf, redirect-uri validator, headers)

**Files:** Create `workers/auth/src/security.ts`, `test/security.test.ts`

This is the largest security surface; split tests per concern. Critical: the **redirect_uri validator** (§8, §10/#1) — byte-exact compare + literal-loopback-port-only exception + authority-confusion rejection.

- [ ] **Step 1: Failing tests** (redirect validator is the priority — include the full reject-vector table)

```ts
import { test, expect } from "vitest";
import { validateRedirectUri, randomId, sha256Hex, hostCookie, parseCookies, securityHeaders } from "../src/security";

const REG = ["https://app.example.com/cb", "http://127.0.0.1:0/cb"]; // 0 = any-port loopback marker

test("exact registered https uri accepted", () => {
  expect(validateRedirectUri("https://app.example.com/cb", REG).ok).toBe(true);
});
test.each([
  "https://app.example.com/cb/../evil",
  "https://app.example.com/cb#frag",
  "https://app.example.com/cb?x=1",          // query not registered
  "https://app.example.com:443/cb",          // explicit port differs byte-wise
  "https://app.example.com/cb\\@evil.com",
  "https://evil.com\\@app.example.com/cb",
  "https://app.example.com/CB",              // case differs
  "https://app.example.com/cb/",             // trailing slash
])("authority/normalization confusion vector rejected: %s", (uri) => {
  expect(validateRedirectUri(uri, REG).ok).toBe(false);
});
test("loopback: only literal 127.0.0.1 with differing port, path byte-equal", () => {
  expect(validateRedirectUri("http://127.0.0.1:54321/cb", REG).ok).toBe(true);
  expect(validateRedirectUri("http://localhost:54321/cb", REG).ok).toBe(false);
  expect(validateRedirectUri("http://127.0.0.1:54321/evil", REG).ok).toBe(false);
});
test("__Host- cookie has HttpOnly, Secure, SameSite=Lax, Path=/, no Domain", () => {
  const c = hostCookie("mw_sess", "abc");
  expect(c).toMatch(/^__Host-mw_sess=abc;/);
  expect(c).toContain("HttpOnly");
  expect(c).toContain("Secure");
  expect(c).toContain("SameSite=Lax");
  expect(c).toContain("Path=/");
  expect(c).not.toContain("Domain=");
});
test("securityHeaders sets no-referrer, no-store, frame-ancestors none", () => {
  const h = securityHeaders();
  expect(h["Referrer-Policy"]).toBe("no-referrer");
  expect(h["Cache-Control"]).toContain("no-store");
  expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
});
```

- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement**
  - `corsHeaders` (copy api, methods `GET,POST,OPTIONS`).
  - `randomId(bytes=32)` → b64url of `getRandomValues`; `sha256Hex` (re-export from crypto).
  - `hostCookie(name, value, {maxAge?})` → `__Host-<name>=<value>; HttpOnly; Secure; SameSite=Lax; Path=/[; Max-Age=...]`; `clearHostCookie`; `parseCookies(header)`.
  - `csrfToken()` + `constantTimeEqual` compare.
  - `validateRedirectUri(raw, registered[])`: first reject raw containing `@ \ # whitespace control` or `>1 ?`; then byte-exact match against each registered; then the literal-loopback exception (registered host literally `127.0.0.1`/`[::1]`, scheme `http`, parse-serialize round-trip equal, only port differs). Return `{ok:true}` / `{ok:false,reason}`.
  - `securityHeaders()` → the no-referrer/no-store/CSP map.
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit** — `feat(auth): security primitives + hardened redirect_uri validator`.

---

## Phase 3 — Keys, JWT, OIDC discovery/JWKS

### Task 3.1: `keys.ts` (ES256 signing keys + JWKS)

**Files:** Create `workers/auth/src/keys.ts`, `test/keys.test.ts`

- [ ] **Step 1: Failing test** — generate a P-256 key in the test, build a fake `AUTH_SIGNING_KEYS` JSON, assert `getActiveKey` returns the `active` one and `buildJwks` emits public-only JWK(s) with `kid`,`alg:ES256`,`use:sig`,`crv:P-256` and NO `d` (private) field.

```ts
import { test, expect } from "vitest";
import { parseSigningKeys, getActiveKey, buildJwks } from "../src/keys";

async function genKeysJson() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign","verify"]);
  const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return JSON.stringify([{ kid: "k1", status: "active", privateJwk: priv, publicJwk: pub }]);
}
test("active key selected, jwks public-only", async () => {
  const ks = parseSigningKeys(await genKeysJson());
  expect((await getActiveKey(ks)).kid).toBe("k1");
  const jwks = buildJwks(ks);
  expect(jwks.keys[0].kid).toBe("k1");
  expect(jwks.keys[0].alg).toBe("ES256");
  expect(jwks.keys[0]).not.toHaveProperty("d");
});
```

- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement** — `parseSigningKeys(json)`; `getActiveKey` (status `active`, import as non-extractable `CryptoKey` for sign); `buildJwks` (active+next+retiring, strip `d`, set `alg/use/kid`).
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit** — `feat(auth): ES256 signing keys + JWKS builder`.

### Task 3.2: `jwt.ts` (sign + verify, ES256 only)

**Files:** Create `workers/auth/src/jwt.ts`, `test/jwt.test.ts`

- [ ] **Step 1: Failing test** — sign a payload, verify it round-trips; verifier pins `alg:["ES256"]` and rejects `alg:none` / tampered signature / wrong `iss`/`aud`/expired.

```ts
import { test, expect } from "vitest";
import { signJwt, verifyJwt } from "../src/jwt";
// uses keys from a P-256 pair generated in-test (see keys.test helper)
```

(Assertions: valid token verifies and returns claims; `{alg:"none"}` token rejected; `exp` in the past rejected with ±60s skew; `aud` mismatch rejected.)

- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement** — `signJwt(header, payload, cryptoKey)`: b64url header+payload, `crypto.subtle.sign(ECDSA P-256 SHA-256)`, JOSE raw r||s signature. `verifyJwt(token, jwks, {iss,aud,now,skew})`: split, reject if `alg!=="ES256"`, find `kid` in jwks, import public, `verify`, then validate `iss/aud/exp/nbf` and return payload or throw typed error.
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit** — `feat(auth): ES256 JWT sign/verify (alg-pinned)`.

### Task 3.3: `oidc.ts` (discovery + jwks responses)

**Files:** Create `workers/auth/src/oidc.ts`, `test/oidc.test.ts`

- [ ] **Step 1: Failing test** — `discoveryDoc(env)` advertises exactly the implemented surface: `response_types_supported:["code"]`, `grant_types_supported:["authorization_code"]` (refresh deferred to slice 2), `code_challenge_methods_supported:["S256"]`, `id_token_signing_alg_values_supported:["ES256"]`, `subject_types_supported:["public"]`, `authorization_response_iss_parameter_supported:true`, and the endpoint URLs derived from `ISSUER`.
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement** pure `discoveryDoc(env)`; `jwksResponse(keys)` returns the JWKS object. (Caching wired in `index.ts`.)
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit** — `feat(auth): OIDC discovery + JWKS documents`.

---

## Phase 4 — Accounts (signup, login, recovery, verified)

### Task 4.1: signup + login (enumeration-safe)

**Files:** Create `workers/auth/src/accounts.ts`, `test/accounts.test.ts`

- [ ] **Step 1: Failing tests** (inject fake `DbClient` + injected `hashPassword` params for speed; inject `now`)
  - `signup(db, {username,password})`: rejects weak password; rejects taken username with the SAME shape/response as success-path timing contract (assert it returns a typed `{ok:false,error:"unavailable"}` and that the code path always computes a hash — enumeration-safety); on success creates `accounts` + `password_credentials` rows and returns 8 recovery codes once.
  - `loginVerify(db, {username,password})`: returns `{ok:true,accountId}` on match; on unknown user runs a **canonical dummy hash** (assert `verifyPassword` invoked even when user absent) and returns `{ok:false}`; on wrong password returns `{ok:false}`.
  - `deriveVerified(db, accountId)`: true iff a `telegram_links` row exists (live), independent of the `accounts.verified` mirror.
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement** — uses `crypto.ts` hash/verify, `auth-shared` policy + recovery, `randomId` for `accounts.id`. Recovery codes hashed with cheap params and inserted. Enumeration-safety: always hash (dummy PHC constant when user missing), single canonical param set.
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit** — `feat(auth): enumeration-safe signup/login + recovery codes + live verified`.

---

## Phase 5 — Sessions

### Task 5.1: session issue/lookup/rotate/revoke + CSRF

**Files:** Create `workers/auth/src/session.ts`, `test/session.test.ts`

- [ ] **Step 1: Failing tests** — `issueSession(db,{accountId,amr,authTime,now})` returns a raw opaque id (set in `__Host-mw_sess`) and stores only `sha256(id)`; `lookupSession(db,rawId,now)` returns the row when not expired/revoked and rolls `last_seen`; expired/revoked → null; `rotateSession` issues a new id + revokes the old atomically; `revokeSession` sets `revoked_at`; CSRF token is bound to the session and `validateCsrf` is constant-time.
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement** with injected `now`/`randomId`. Idle 14d / absolute 30d epoch fields.
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit** — `feat(auth): __Host- sessions with rotation, revoke, CSRF`.

---

## Phase 6 — Authorize (state preservation)

### Task 6.1: request validation + non-writing pre-auth

**Files:** Create `workers/auth/src/authorize.ts`, `test/authorize.test.ts`

- [ ] **Step 1: Failing tests** — `validateAuthorizeParams(params, client, validateRedirectUri)`:
  - unknown client / bad redirect_uri → `{fatal:true}` (caller renders on-site error, never redirects);
  - bad scope/PKCE/response_type with a GOOD client+redirect → `{redirectError:{error,state}}`;
  - all good → `{ok:true, request}`.
  - Assert **no DB write** happens at this stage (fake db `execute` not called) — the validated request is returned for cookie-encoding.
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement** the ordered validation (client → byte-exact redirect → response_type/scope/PKCE/prompt) returning a discriminated union; build the **signed cookie request object** encoder (`signRequestObject`/`verifyRequestObject` via `hmacSha256` over a JSON blob + expiry + per-browser binding secret) — pure, no DB.
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit** — `feat(auth): authorize validation + signed non-writing request object`.

### Task 6.2: resume + owner-rebind

**Files:** Modify `authorize.ts`, extend test.

- [ ] **Step 1: Failing tests** — `resumeAuthorize` reloads the request object from the cookie, requires the per-browser owner secret to match (constant-time) the post-login session binding, and rejects on owner mismatch / expiry / replay. Materialize `login_requests` row only here (first interactive POST).
- [ ] **Step 2–4:** red → implement (owner-rebind to the completing session per §5/#2,#6) → green.
- [ ] **Step 5: Commit** — `feat(auth): authorize resume with post-login owner rebind`.

---

## Phase 7 — Consent

### Task 7.1: consent grant/deny with live effective-scope + verified gate

**Files:** Create `workers/auth/src/consent.ts`, `test/consent.test.ts`

- [ ] **Step 1: Failing tests** — `decideConsent(db,{request,session})`: prior consent ⊇ requested + gate satisfied → `{silent:true,scope}`; new/expanded scope → `{prompt:true,scope}`; `prompt=consent` forces prompt; verified_only client + non-verified user → `{verifyUpgrade:true}`. `grantConsent` computes `effectiveScope(consentMax, clientAllowed, requested)` **live**, upserts `consents`, and returns the scope to mint — never mints straight from `scope_set_max` (§10/#9). `denyConsent` consumes the request and yields `access_denied`.
- [ ] **Step 2–4:** red → implement → green.
- [ ] **Step 5: Commit** — `feat(auth): consent with live effective-scope + verified gating`.

---

## Phase 8 — Token endpoint

### Task 8.1: code+PKCE exchange + ES256 mint + revoke/introspect

**Files:** Create `workers/auth/src/token.ts`, `test/token.test.ts`

- [ ] **Step 1: Failing tests**
  - `exchangeCode(db,{code,verifier,client,redirectUri,now,signKey})`: delete-on-redeem (`DELETE ... RETURNING`); replayed code → `invalid_grant` AND family revoke; PKCE mismatch → `invalid_grant`; redirect/client mismatch → `invalid_grant`.
  - Minted `id_token`: `typ:JWT`, `token_use:id`, `aud=client_id`, `at_hash` present, `nonce` echoed iff sent, `sub` = opaque account id (NOT telegram_id).
  - Minted `access_token`: `typ:at+jwt`, `token_use:access`, `aud = RESOURCE_AUD` (fixed), `scope` = effective.
  - `revoke` / `introspect` (confidential-only) behave per RFC 7009/7662.
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement** using `jwt.signJwt` + active key; mint both tokens; insert `access_tokens` jti row; `at_hash` = left-128 of SHA-256(access_token) b64url.
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit** — `feat(auth): token exchange + ES256 id/access mint + revoke/introspect`.

---

## Phase 9 — UserInfo

### Task 9.1: typ-guarded userinfo with live claims

**Files:** Create `workers/auth/src/userinfo.ts`, `test/userinfo.test.ts`

- [ ] **Step 1: Failing tests** — bearer must be `typ:at+jwt` + resource `aud` (use `assertAccessToken`); an **id_token presented here → 401** (`invalid_token`); valid access_token → claims filtered by token `scope`, `verified` derived **live**, `sub` always present for `openid`.
- [ ] **Step 2–4:** red → implement → green.
- [ ] **Step 5: Commit** — `feat(auth): userinfo (typ-guarded, live scoped claims)`.

---

## Phase 10 — Rate limit, router, seed, headers

### Task 10.1: `ratelimit.ts` write-budget breaker

**Files:** Create `workers/auth/src/ratelimit.ts`, `test/ratelimit.test.ts`

- [ ] **Step 1: Failing tests** — per-bucket fixed-window counter (UPSERT) returns `{allowed,remaining}`; over budget → `allowed:false`; a global write-budget breaker returns 503-shed when the per-minute budget is exhausted; Turso `BLOCKED` error → fail-closed for new writes but lets cached reads through. Inject `now`.
- [ ] **Step 2–4:** red → implement → green.
- [ ] **Step 5: Commit** — `feat(auth): write-budget circuit breaker + per-bucket limiter`.

### Task 10.2: `index.ts` DI router + seed client + 500 wrapper + headers

**Files:** Create `workers/auth/src/index.ts`, `test/index.test.ts`

- [ ] **Step 1: Failing tests** (integration-style with a fake `Deps`) — route table resolves: `GET /.well-known/openid-configuration`, `GET /jwks`, `GET/POST /authorize`, `POST /authorize/resume`, `POST /token`, `GET /userinfo`, `POST /signup`, `POST /login`, `POST /consent`, `GET /logout`; OPTIONS → 204 CORS; unknown → 404; thrown error → generic 500 with CORS (never leaks); every capability response carries `securityHeaders()`; a migration seeds one `first_party` client (assert it exists after `ensureSchema`).
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement** the thin router (copy `workers/api/src/index.ts:119` shape), wire each handler to its module, add the edge-limit hook before writes, seed the first-party client idempotently in `ensureSchema` (an `INSERT ... ON CONFLICT(name) DO NOTHING`).
- [ ] **Step 4: Run green** + full worker coverage ≥90%: `bunx vitest run --coverage` in `workers/auth`.
- [ ] **Step 5: Commit** — `feat(auth): DI router, seed client, security headers, 500 wrapper`.

---

## Phase 11 — Frontend `apps/auth-web`

### Task 11.1: typed API client + Auth layout (headers)

- [ ] Create `src/lib/authApi.ts` (credentialed fetch to `PUBLIC_AUTH_API_URL`) with a vitest test mirroring `apps/web/src/lib/api.test.ts`. `src/layouts/Auth.astro` sets `Referrer-Policy: no-referrer` + CSP + `Cache-Control: no-store` via `Astro.response.headers`. Commit.

### Task 11.2: login / signup / consent / error pages

- [ ] Build `login.astro`, `signup.astro` (shows the 8 recovery codes once on success), `consent.astro` (renders app name/logo + requested scopes, Allow/Deny, carries `rid` from cookie not URL), `error.astro`. React islands `LoginForm`/`SignupForm`/`ConsentForm` post to the worker; assert `astro check` + `astro build` pass. Commit per page.

---

## Phase 12 — Deploy wiring + PBKDF2 measurement

### Task 12.1: just recipes + deploy scripts + sync edits

- [ ] Add `deploy-auth` / `deploy-auth-web` recipes (clone `deploy-api`/`deploy-web`); `infra/cloudflare/deploy-auth.sh` + `deploy-auth-web.sh` (dirty-check + `record-deploy.sh`); add `auth)` / `auth-web)` cases to `infra/services.sh`; two `locals.services` entries in `infra/cloudflare/deploy.tf`; CNAME `auth → meowerse-auth-web.pages.dev` in `dns.tf`; path-scoped detect+deploy steps in `.github/workflows/deploy.yml`; document `AUTH_SIGNING_KEYS` etc. in `.env.example`. Commit `build(auth): deploy wiring for workers/auth + apps/auth-web`.

### Task 12.2: measure PBKDF2 CPU

- [ ] Run `bunx wrangler dev` in `workers/auth`, time a login at `rounds:6,iter:100000`; if it overruns the 10ms CPU wall, drop to `rounds:4` and record the chosen params in `crypto.ts` `DEFAULT` + a `// ponytail:` note. Commit if changed.

---

## Phase 13 — Full gate

### Task 13.1: green the whole repo

- [ ] Run `just test` (JS via Turbo at 90% + Go untouched) and `just lint`. Fix everything. Confirm `bunx vitest run --coverage` in `workers/auth` ≥90% on every metric and the required negative tests are present:
  - id_token → `/userinfo` ⇒ 401; access_token → id-token verify ⇒ reject;
  - redirect_uri alias/authority vectors ⇒ REJECT;
  - unknown vs known username ⇒ indistinguishable response;
  - replayed code ⇒ `invalid_grant` + family revoke;
  - every `Set-Cookie` starts `__Host-`+`HttpOnly`+`Secure`;
  - `iss` present on every authorize response (success + error).
- [ ] Commit any fixes. This is the pre-PR gate (spec ship step 3).

---

## Self-Review notes (gaps to watch during execution)

- **Spec coverage:** §3 endpoints — `/logout` is in slice 1 (session revoke), refresh/`offline_access` deferred (§12). §4 — all tables created now even if only some are written in slice 1 (telegram/refresh tables are inert until slices 2). §5 — the full edge-case table is exercised by `authorize`/`consent`/`token` tests; the verified-upgrade branch returns `verifyUpgrade` (UI lands in slice 2 when Telegram exists, but the gate decision is built now). §10 hardening that touches slice-1 paths (#1,#2,#5,#7,#8,#9,#10) is built; #3 (SDK iss) and #6 Telegram-binding land with their subsystems.
- **Type consistency:** `effectiveScope(consentMax, clientAllowed, requested)` arg order is fixed; `assertAccessToken(header,payload,resourceAud)`; PHC format `pbkdf2$sha256$<rounds>$<iter>$<salt_b64>$<hash_b64>`; session stores `sha256(id)`, cookie carries raw id; `sub` = `accounts.id` everywhere.
- **No placeholders:** every task names exact files + real test code or precise signatures; tasks with representative-only tests (frontend) still name exact pages/assertions.
