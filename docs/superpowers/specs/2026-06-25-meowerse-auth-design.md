# Auth with Meowerse — OIDC Identity Provider Design

**Status:** v1 design, ready to slice. **Issuer:** `https://auth.alxnko.eu.org`. **API host:** `https://auth-api.alxnko.eu.org`.
**Constraint:** free tier only, no credit card. **Pattern source of truth:** `workers/api` (DI router, `ensureSchema` memoization, `constantTimeEqual`, exact-origin credentialed CORS, Cache-API purge-on-write).

This document is the single normative spec. Where the nine research dimensions disagreed, the conflict is resolved inline and the resolution is binding. Every exploitable path from the threat model is closed in the relevant section and indexed in §10.

---

## 1. Vision & scope

"Sign in with Meowerse" — a standards-compliant OAuth 2.0 / OpenID Connect authorization server that lets meowerse developers register apps and lets end users authenticate with **Telegram** or **username+password**, then consent to share a fixed catalog of claims.

### Locked envelope (not relitigated)
Authorization Code + PKCE (S256, mandatory for *all* clients); ES256 JWT `id_token` + `access_token`; full discovery + JWKS; signing key in a wrangler secret; Telegram + password login mapping to one linkable account; `verified` = confirmed linked Telegram; recovery via Telegram anchor + 8 one-time codes; **no email in v1**; all-or-nothing consent over the requested scope set; verified-only audience gating with inline Telegram upgrade; exhaustive state preservation across the signup/Telegram detour; one fat `workers/auth` Worker; Turso single store; opaque session cookie on `auth.alxnko.eu.org`; PBKDF2-HMAC-SHA256 passwords.

### Six-subsystem decomposition
1. **OIDC core** — `/authorize`, `/token`, `/userinfo`, `/jwks`, discovery, logout, revoke, introspect; token minting & key rotation.
2. **State-preserving authorize flow** — the server-side login-request object and the login/signup/consent state machine.
3. **Telegram subsystem** — `auth-bot` worker (deep-link primary, Login Widget secondary), HMAC verification, linking, recovery approval.
4. **Credential, session & recovery security** — password hashing, throttling, recovery codes, cookies, CSRF.
5. **Developer dashboard & client model** — client registration, secret handling, redirect-URI validation, scope/verified config, lifecycle.
6. **Integration SDK + IaC** — `@meowerse/auth` RP SDK and the `meow-auth` config-as-code provisioner + Management API.

### Build order
**Slice 1 = subsystems 1+2+4 minus refresh tokens and the dashboard UI**, i.e. the smallest end-to-end vertical: discovery/JWKS, `/authorize` (state-preserving), password login+signup, consent, `/token` (authorization_code only), `/userinfo`, sessions, and one seed client created by migration. Telegram (3), the dashboard (5), and the SDK/IaC (6) follow as slices 2–4. Refresh tokens and `offline_access` are deferred to slice 2.

---

## 2. System architecture

Three new workspace packages plus a fourth optional worker, all auto-discovered by Bun's `apps/* packages/* workers/*` globs and convention-based Turbo (no root config edits):

- **`workers/auth`** (`@meowerse/auth-worker`) — the fat OIDC Worker on `auth-api.alxnko.eu.org`.
- **`apps/auth-web`** (`@meowerse/auth-web`) — Astro+React island app on `auth.alxnko.eu.org` (its own Cloudflare Pages project `meowerse-auth-web` for cookie-origin isolation).
- **`packages/auth-shared`** (`@meowerse/auth-shared`) — pure, dependency-free, WebCrypto-only helpers shared by worker and frontend (PKCE S256 verify, scope→claims catalog, recovery-code format, token-type guard constants). **Never** holds DB access, the private signing key, or session issuance.
- **`workers/auth-bot`** (`@meowerse/auth-bot`) — Telegram webhook worker extending `workers/edge`'s `PATH_SECRET`-in-URL pattern. Shares the Turso DB. Slice 2.

```
                          ┌─────────────────────────── browser (end user) ───────────────────────────┐
                          │                                                                            │
            top-level GET/POST (cookie: __Host-mw_sess, __Host-mw_tkt)                                 │
                          │                                                                            │
                          v                                                                            │
   ┌──────────────────────────────────┐        HTML pages (login/signup/consent/dashboard)            │
   │  apps/auth-web  (Astro+React)     │<───────────────────────────────────────────────────┐         │
   │  auth.alxnko.eu.org  (Pages)      │                                                     │         │
   │  PUBLIC_AUTH_API_URL ─────────────┼──── fetch (credentialed, exact-origin CORS) ──┐      │         │
   └──────────────────────────────────┘                                               │      │         │
                                                                                       v      │         │
   ┌──────────────────────────────────────── workers/auth  (auth-api.alxnko.eu.org) ──────────────────┐ │
   │  index.ts  thin DI router  ── edge WAF rate-limit (free) runs in front of every write ──────────┐ │ │
   │   ├ oidc.ts      /.well-known/openid-configuration · /jwks        (Cache API, purge-on-rotate)  │ │ │
   │   ├ authorize.ts /authorize · /authorize/resume   (validate → cookie-borne signed req object)  │ │ │
   │   ├ token.ts     /token (code+PKCE, refresh) · /token/revoke · /token/introspect               │ │ │
   │   ├ userinfo.ts  /userinfo (typ=at+jwt only, live verified)                                    │ │ │
   │   ├ session.ts   opaque __Host- cookie ⇄ session row                                           │ │ │
   │   ├ accounts.ts  signup · PBKDF2 verify · recovery · live verified derivation                  │ │ │
   │   ├ consent.ts   grant/deny · effective-scope intersection at mint                             │ │ │
   │   ├ clients.ts   /api/dev/* dashboard CRUD · /mgmt/v1/* Management API                         │ │ │
   │   ├ telegram.ts  /internal/tg/confirm (HMAC from auth-bot) · /tg/* status                      │ │ │
   │   ├ db.ts        prodDeps + ensureSchema (memoized once/isolate)                               │ │ │
   │   ├ security.ts  corsHeaders · constantTimeEqual · cookie · PKCE · redirect-uri validators     │ │ │
   │   └ ratelimit.ts global write-budget circuit breaker (Turso BLOCKED = fail-closed-new)         │ │ │
   └──────────┬───────────────────────────────────────────────┬────────────────────────────────────┘ │
              │ libsql/web (DATABASE_URL secret)               │ HMAC-signed internal call             │
              v                                                v                                        │
   ┌────────────────────┐                       ┌──────────────────────────────────────┐               │
   │   Turso (libsql)    │<──────────────────────│  workers/auth-bot                    │<── webhook ───┘
   │ single shared DB    │  shared ticket table  │  PATH_SECRET + X-Telegram-Bot-Api-   │   Telegram
   │ codes·tokens·tickets│                       │  Secret-Token (constant-time)         │   Bot API
   │ sessions·clients    │                       └──────────────────────────────────────┘   (free)
   └────────────────────┘
   Resource servers (api.meow) import @meowerse/auth/worker → verify access_token locally vs cached JWKS;
   call /token/introspect only when instant revocation is needed (first-party only).
```

**Deploy/versioning wiring** (the only hand-edited files, mirroring the api/web services):
`infra/services.sh` (`auth) echo "workers/auth packages/auth-shared"`, `auth-web) echo "apps/auth-web packages/auth-shared"`); `infra/cloudflare/deploy.tf` `locals.services` (one map entry each); `.github/workflows/deploy.yml` path-scoped change-detect grep + deploy steps; `infra/cloudflare/dns.tf` CNAME `auth → meowerse-auth-web.pages.dev` (the worker custom domain is wrangler-provisioned, **not** in `dns.tf`, exactly like `api.meow`). `infra/deploy-state.json` self-populates on first `record-deploy.sh`.

---

## 3. OIDC surface

### Endpoints
| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/authorize` | Validate client+redirect+PKCE+scope; resolve session; decide silent/login/consent; create signed request object. |
| POST | `/authorize/resume` | Reload the original validated request after auth/consent; mint code to the **original** redirect_uri. |
| POST | `/token` | `authorization_code` (PKCE verify) and `refresh_token` (rotation). |
| GET/POST | `/userinfo` | Bearer **access_token only** (`typ:at+jwt`) → scope-filtered, live-derived claims. |
| GET | `/jwks`, `/.well-known/jwks.json` | ES256 public JWKS (active+next+retiring kids), edge-cached. |
| GET | `/.well-known/openid-configuration` | Discovery, edge-cached. |
| GET | `/logout`, `/session/end` | RP-initiated logout: validate `id_token_hint` + `post_logout_redirect_uri` (same exact-match validator), revoke session row server-side, clear cookie. |
| POST | `/token/revoke` | RFC 7009; family-aware for refresh tokens. |
| POST | `/token/introspect` | RFC 7662; confidential clients only. |
| — | `/api/dev/*`, `/mgmt/v1/*` | Dashboard CRUD + Management API (§8, §9). |

No Dynamic Client Registration in v1.

### Token design
**`id_token` (ES256 JWT, `typ:"JWT"`)** carries authentication only: `iss`, `sub` (stable opaque per-user id — **never** `telegram_id`), `aud=client_id`, `exp=now+5m`, `iat`, `auth_time`, `nonce` (echoed verbatim iff sent), `azp`, `at_hash` (left-128 of SHA-256(access_token)), `token_use:"id"`, and the convenience `verified` boolean (derived **live** at mint — see §10/#9).

**`access_token` (ES256 JWT, `typ:"at+jwt"` per RFC 9068)** carries `iss`, `sub`, `aud` = the **fixed resource identifier** `https://api.meow.alxnko.eu.org` (**never** the client_id — resolved hard rule, see §10/#5), `client_id`, `scope`, `exp=now+15m`, `iat`, `jti`, `token_use:"access"`. A `token` row keyed by `jti` backs introspect/revoke.

**Token-type non-interchangeability (hardening):** every verifier MUST check the `typ` header **and** `token_use` claim. `/userinfo` rejects anything that is not `typ:at+jwt` + resource `aud` (401 `invalid_token`); id_token verification rejects `typ:at+jwt`. These guards live in `packages/auth-shared` as the single assembler/verifier so no service can re-open the confusion.

### Claim catalog → /userinfo
`openid`→`sub`; `profile`→`preferred_username`(username), `name`(display_name), `picture`(avatar_url); `telegram`→`telegram_id`, `telegram_username`; `verified`→`verified` (bool). Data claims are served **from /userinfo**, not stuffed into the id_token, so revocation immediately stops data access and the id_token stays small.

### Lifetimes
auth code 60s · id_token 5m · access_token 15m · refresh sliding 14d/absolute 30d (slice 2) · request object 15m · session 30d absolute / 14d idle. Verifier clock skew ±60s.

### ES256 / JWKS / rotation
P-256 keys generated with WebCrypto. Private keys live **only** in wrangler secret `AUTH_SIGNING_KEYS` = JSON array `{kid, privateJwk, publicJwk, status:'active'|'next'|'retiring', notBefore}`, memoized per isolate. Sign with the single `active` key; always set header `kid` + `alg:ES256`. `/jwks` publishes active+next+retiring. Rotation: add `next` → flip to `active` on deploy → demote old to `retiring` ≥24h (>2× max token life), then drop. **Compromise response: purge the retiring key immediately, do not wait for natural expiry** (§10/#5d). Verification pins `alg:['ES256']` (rejects `none`/RS/HS confusion). JWKS + discovery edge-cached `max-age=3600`, purged on rotation.

### Discovery (advertises only what we implement)
`response_types_supported:['code']`, `grant_types_supported:['authorization_code','refresh_token']`, `code_challenge_methods_supported:['S256']`, `id_token_signing_alg_values_supported:['ES256']`, `token_endpoint_auth_methods_supported:['client_secret_basic','client_secret_post','none']`, `subject_types_supported:['public']`, `scopes_supported:['openid','profile','telegram','verified','offline_access']`, `prompt_values_supported:['none','login','consent','select_account']`, and **`authorization_response_iss_parameter_supported: true`** (RFC 9207 mix-up defense — see §10/#3).

### Error responses (spec-exact)
`/authorize` with a **registered** redirect_uri → redirect with `error`+`error_description`+`state`+**`iss`** (success and error responses both carry `iss`). Unknown/mismatched `client_id` or `redirect_uri` → **on-site HTML error page, never redirect**. `/token` → 400 JSON (`invalid_client` → 401 + `WWW-Authenticate`), all with `Cache-Control: no-store, Pragma: no-cache`.

---

## 4. Data model (Turso / libsql DDL)

Single shared DB. One memoized `ensureSchema` runs the whole `SCHEMA` array (additive `CREATE … IF NOT EXISTS`) once per isolate. Stateless JWTs mean **no `id_token`/`access_token` body table**; only refresh tokens, sessions, and the `jti` revocation index are stateful. Every read carries an `expires_at > now()` predicate; cleanup is lazy delete-on-read plus an optional free Cron sweep with a bounded `DELETE … LIMIT`.

```sql
-- Identity ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id           TEXT PRIMARY KEY,             -- stable opaque sub
  username     TEXT UNIQUE,                  -- nullable (telegram-only signup)
  display_name TEXT, avatar_url TEXT,
  verified     INTEGER NOT NULL DEFAULT 0,   -- DERIVED MIRROR of telegram_links; live read still authoritative
  identity_epoch INTEGER NOT NULL DEFAULT 0, -- bumped on unlink / token_version events (silent-path kill-switch)
  token_version  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS password_credentials (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  phc        TEXT NOT NULL                   -- pbkdf2$sha256$<rounds>$<iter>$<salt_b64>$<derived_b64>
);
CREATE TABLE IF NOT EXISTS telegram_links (
  telegram_id       INTEGER PRIMARY KEY,     -- immutable anchor; UNIQUE ⇒ one TG → one account
  account_id        TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  telegram_username TEXT, display_name TEXT, avatar_url TEXT,
  linked_at TEXT DEFAULT (datetime('now')), updated_at TEXT
);
CREATE TABLE IF NOT EXISTS recovery_codes (             -- exactly 8 per account
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,                  -- pbkdf2 record, CHEAP params (high-entropy input)
  used_at    TEXT, PRIMARY KEY (account_id, code_hash)
);

-- Sessions ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id_hash    TEXT PRIMARY KEY,               -- sha256(opaque 256-bit cookie id); raw never stored
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  auth_time  INTEGER NOT NULL,               -- epoch seconds; for max_age
  amr        TEXT,                           -- 'pwd' | 'tg'
  csrf_token TEXT NOT NULL,                  -- synchronizer token bound to session
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  idle_expires_at     INTEGER NOT NULL,      -- now+14d sliding
  absolute_expires_at INTEGER NOT NULL,      -- now+30d
  revoked_at TEXT
);

-- Authorization request object (state preservation) -------------------------
-- NOTE: NOT created on bare GET /authorize. Persisted only when a human first
-- POSTs (login/signup/consent). Pre-persist state rides a signed, single-use,
-- short-TTL token in the __Host- cookie. (DoS fix §10/#11.)
CREATE TABLE IF NOT EXISTS login_requests (
  rid            TEXT PRIMARY KEY,           -- 128-bit
  owner_hash     TEXT NOT NULL,              -- sha256 of per-browser binding secret (anti-fixation §10/#2,#6)
  client_id      TEXT NOT NULL, redirect_uri TEXT NOT NULL, scope TEXT NOT NULL,
  state TEXT, nonce TEXT, code_challenge TEXT NOT NULL, code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  prompt TEXT, max_age INTEGER, login_hint TEXT,
  account_id TEXT,                           -- bound after auth
  step       TEXT NOT NULL DEFAULT 'awaiting_login', -- awaiting_login|awaiting_signup|awaiting_verify_upgrade|awaiting_consent|consumed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at INTEGER NOT NULL, consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_requests_exp ON login_requests(expires_at);

-- Authorization codes -------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash  TEXT PRIMARY KEY,               -- sha256(code); raw never stored
  client_id  TEXT NOT NULL, redirect_uri TEXT NOT NULL, scope TEXT NOT NULL,
  nonce TEXT, code_challenge TEXT NOT NULL, code_challenge_method TEXT NOT NULL,
  account_id TEXT NOT NULL, session_id_hash TEXT NOT NULL, auth_time INTEGER NOT NULL,
  jti_family TEXT NOT NULL,                  -- ties derived tokens for replay-revoke
  created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at INTEGER NOT NULL
);

-- Token revocation index + refresh (refresh = slice 2) ----------------------
CREATE TABLE IF NOT EXISTS access_tokens (   -- jti index for introspect/revoke
  jti TEXT PRIMARY KEY, account_id TEXT NOT NULL, client_id TEXT NOT NULL,
  scope TEXT NOT NULL, family_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,               -- sha256(opaque)
  family_id  TEXT NOT NULL, client_id TEXT NOT NULL, account_id TEXT NOT NULL, scope TEXT NOT NULL,
  prev_id TEXT, used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  idle_expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id);

-- Clients / consent ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id    TEXT PRIMARY KEY,             -- 'mw_' + 128-bit base64url (public, plaintext)
  name         TEXT UNIQUE NOT NULL,         -- stable key for IaC upsert
  owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_type  TEXT NOT NULL CHECK(client_type IN ('public','confidential')),
  display_name TEXT, logo_url TEXT, homepage_url TEXT, privacy_policy_url TEXT, description TEXT,
  allowed_scopes TEXT NOT NULL,              -- JSON subset of catalog
  allow_offline_access INTEGER NOT NULL DEFAULT 0,
  verified_only INTEGER NOT NULL DEFAULT 0,
  first_party   INTEGER NOT NULL DEFAULT 0,  -- SERVER/admin-set only, never via public API
  status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  rate_limit_per_min INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS oauth_client_redirect_uris (
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,                -- stored CANONICAL form; authorize compares byte-exact
  PRIMARY KEY (client_id, redirect_uri)
);
CREATE TABLE IF NOT EXISTS oauth_client_secrets (   -- ≤2 active rows per client (rotation grace)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  secret_phc TEXT NOT NULL,                  -- PBKDF2 record; 'mws_' secret, hashed
  created_at TEXT NOT NULL DEFAULT (datetime('now')), not_after TEXT
);
CREATE TABLE IF NOT EXISTS consents (        -- all-or-nothing grant
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_id  TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scope_set_max TEXT NOT NULL,               -- max ever consented (never minted from directly — see §10/#9)
  approved_scope_snapshot TEXT NOT NULL,     -- exact set the user visually approved
  granted_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT,
  PRIMARY KEY (account_id, client_id)
);
CREATE TABLE IF NOT EXISTS management_tokens (
  token_hash TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), revoked_at TEXT
);

-- Telegram ticket (slice 2) -------------------------------------------------
CREATE TABLE IF NOT EXISTS login_tickets (
  ticket_id  TEXT PRIMARY KEY, nonce_hash TEXT NOT NULL,
  owner_hash TEXT NOT NULL,                  -- sha256 of per-browser binding secret (account-takeover fix §10/#5,#6)
  kind   TEXT NOT NULL CHECK(kind IN ('SIGNIN_OR_SIGNUP','VERIFY_EXISTING','RESET_APPROVAL')),
  status TEXT NOT NULL DEFAULT 'pending',    -- pending|consumed
  account_id TEXT,                           -- pre-bound for VERIFY/RESET; null for SIGNIN_OR_SIGNUP
  rid TEXT,                                  -- links back to login_requests for state preservation
  created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON login_tickets(status, expires_at);

-- Abuse counters (post-edge only; edge WAF is first line — §10/#7,#11) ------
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,                   -- e.g. 'login:'||sha256(username||day) ; 'signup-ip:'||hash
  count INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL, last_at INTEGER
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL DEFAULT (datetime('now')),
  event TEXT NOT NULL, account_id TEXT, client_id TEXT, ip_trunc TEXT, ua_hash TEXT
);
```

**Single-use consume strategy.** Codes: `DELETE FROM oauth_codes WHERE code_hash=? RETURNING *` — one redeemer wins atomically; a second presentation returns 0 rows → `invalid_grant` **and** revoke the `jti_family`. Refresh: `UPDATE refresh_tokens SET used_at=now() WHERE token_hash=? AND used_at IS NULL` — `rowsAffected==1` wins; a presented-but-already-used token triggers **family-wide** revocation. Tickets/login_requests: `UPDATE … SET status='consumed' WHERE … AND status='pending' AND expires_at>now()`. A short (~5s) idempotent grace returns the same rotated token to absorb network retries, not a reuse-revoke.

---

## 5. Core flow: state-preserving Authorization Code + PKCE

### Sequence
1. **GET `/authorize`.** Validate **in this order**: (a) parse params; (b) exact-match `client_id`; (c) **byte-exact** `redirect_uri` vs the client's stored canonical set (loopback exception per §8); (d) `response_type=code`, `scope ⊆ client.allowed_scopes`, PKCE present, `code_challenge_method=S256`, prompt values. Steps b/c failing → **on-site error page (never redirect)**. Step d failing → redirect to the now-trusted URI with `error`+`state`+`iss`. **No Turso write yet.**
2. **Decide.** Resolve `__Host-mw_sess`. With a valid session + a `consents` row whose `approved_scope_snapshot ⊇ requested` + no `prompt=login|consent` + verified gate satisfied **live** → mint code immediately (silent, zero clicks). Else carry the validated request in a **signed, single-use, 15-min token in the `__Host-mw_tkt` cookie** and 302 into the Astro UI at `/login` (or `/consent`). The cookie also carries a fresh **per-browser binding secret**; only its hash is persisted when the request object is later materialized.
3. **Detour (login / password-signup / Telegram-signup / recovery / verify-upgrade).** Every UI step carries only the cookie. The **first interactive POST** materializes the `login_requests` row (`owner_hash` = sha256 of the binding secret), runs PBKDF2/Telegram auth, sets `account_id`, advances `step`. On successful auth the server **rotates the session id**, **rebinds `owner_hash` to the post-login session**, and requires `constantTimeEqual(owner, session-derived token)` at resume — an attacker-created request can never be completed by a victim's browser (§10/#2,#6).
4. **POST `/authorize/resume`.** Re-load the request object by cookie, verify owner binding + Origin/`Sec-Fetch-Site` + CSRF synchronizer token, recompute the verified gate and **effective scope** live, render or auto-skip consent.
5. **POST `/authorize/consent` (Allow).** Compute `effective_scope = consents.scope_set_max ∩ client.allowed_scopes ∩ requested`, **live** (never mint straight from `scope_set_max` — §10/#9). Atomically: write `oauth_codes` row, flip request object to `consumed`, rotate session, 302 to the **original** redirect_uri with `code`+`state`+`iss`.
6. **POST `/token`.** Verify `code_verifier` vs stored S256 challenge; re-validate `client_id` + exact `redirect_uri`; delete-on-redeem; mint id_token + access_token (and refresh in slice 2).

### Edge-case table
| Scenario | Handling |
|---|---|
| Logged-out user, valid request | Validate (fatal-if-bad client/redirect), no session → cookie request object, 302 `/login`; after login → `awaiting_consent`. |
| Password signup detour | `/signup` carries the cookie; on create, bind `account_id`, rotate session, → consent for the ORIGINAL client+scope. |
| Telegram signup detour (external bounce) | Ticket carries `rid`; bot confirm creates verified account; browser (owner-bound poll) resumes to the original consent. |
| Logged in + prior consent ⊇ requested | Silent code, zero clicks. |
| Logged in + NEW scope | Consent for the full requested set (all-or-nothing); approve updates `scope_set_max` + snapshot. |
| `prompt=none`, session+consent present | Silent code, no UI. |
| `prompt=none`, login/consent needed | Redirect with `error=login_required`/`consent_required`/`interaction_required`+`state`+`iss`. Never render UI, never silently create. |
| `prompt=login` | Force re-auth even with session; refresh `auth_time`; always show consent. |
| `prompt=consent` | Always show consent even if prior grant. |
| `prompt=none` + other value | `invalid_request`. |
| `max_age` exceeded | Force re-auth; id_token carries fresh `auth_time`. |
| Multi-tab concurrent authorize | Each flow keyed by its own request object; cookie binding secret is per-browser; completing one tab benefits the others on next POST. |
| Back after Allow/Deny | Request object + code single-use → "already completed, return to <app>" page; never a second code; Deny can't flip to Allow. |
| Expired request object (>15m) | Friendly "request expired"; offer re-initiate `/authorize` if client+redirect still valid. Never proceed on stale. |
| Replayed/forged rid or owner mismatch | Owner check fails → invalid/expired page; mint nothing. |
| Deny | No code; redirect with `error=access_denied`+`state`+`iss`; consume request object. |
| Verified-only app, non-verified user | `awaiting_verify_upgrade`; inline Telegram-link prompt (rid preserved); on link, **live** verified flips, resume consent; refuse → `access_denied`. |
| Unregistered/mismatched redirect_uri or unknown client | On-site error page; **never redirect**. |
| Valid client/redirect, bad scope/PKCE/response_type | Redirect with `invalid_scope`/`invalid_request`+`state`+`iss`. |
| Session expires mid-flow | Consent POST re-checks session; on miss → `awaiting_login` → re-auth → back to consent; state/nonce/redirect re-emitted only from the request object. |
| Switch account / `select_account` | Route to `awaiting_login` keeping the request object; new login rebinds `account_id`; back to consent for the same request. |
| Recovery mid-authorize | Recovery pages carry the cookie; after reset+login, bind and resume to consent. |

---

## 6. Telegram verification & "Continue with Telegram" (slice 2)

**Two mechanisms.** **Primary: bot deep-link** `t.me/<bot>?start=<nonce>` over webhook — no third-party JS, CSP-clean, serves sign-in/up, verify-existing, and reset-approval. **Secondary: Login Widget** — one-click desktop convenience for sign-in/up only; **barred** from VERIFY_EXISTING and RESET_APPROVAL (no server nonce).

**Identity key** = `telegram_id` (immutable, UNIQUE). `telegram_username` is mutable metadata, refreshed each interaction, **never** used to match. A confirmed Telegram link ⇒ `verified=1` automatically.

**Deep-link binding.** `POST /tg/start` mints a `login_tickets` row: nonce = 32 random bytes base64url (≤64-char start-param limit), stored as `nonce_hash`; `kind`; `account_id` pre-bound for VERIFY/RESET (null for sign-in); `rid` linking the original authorize request; TTL 5 min; single-use atomic consume. It also issues a **per-browser binding secret** in the `__Host-mw_tkt` cookie and stores only its `owner_hash`.

**Webhook auth (auth-bot).** Two layers, both constant-time: secret in the URL path (`PATH_SECRET`, bot0 pattern) **and** the `X-Telegram-Bot-Api-Secret-Token` header (set via `setWebhook`). Either fails → 403 before any parse.

**Internal callback.** auth-bot → `POST /internal/tg/confirm` is HMAC-SHA256-signed over `{ticket_id, telegram_id, username, display_name, avatar_url, ts}` with a `ts` replay window; forged call → 401.

**Account-takeover & fixation fixes (§10/#5,#6) — binding both ends.**
- The session minted on confirm is released **only** to the browser holding the binding secret. `GET /tg/ticket/<id>/status` and resume require the owner secret (constant-time) before returning any resume target or session. **`ticket_id` is public and grants nothing.**
- SIGNIN_OR_SIGNUP that resolves an existing account requires an **in-Telegram confirmation interstitial** ("Sign in as @user?") as secondary defense; the owner-token binding is the primary, vigilance-independent control.
- Deep-link path gets a replay/skew guard equivalent to the widget's `auth_date≤60s`: reject confirms whose Telegram message date predates the ticket or is outside a tight window. `/tg/start` is edge-rate-limited per IP/account.

**Login Widget verification.** `data_check_string` = sorted `key=value` joined by `\n` excluding `hash`; `secret_key = SHA256(bot_token)`; `constantTimeEqual(hex HMAC-SHA256(dcs, secret_key), hash)`; reject `auth_date` older than 60s.

**Linking guard.** `telegram_id` UNIQUE; a VERIFY_EXISTING confirm where the `telegram_id` is linked to a different account surfaces an explicit "linked elsewhere" error, never a silent remap. **On unlink, bump `accounts.identity_epoch`** so any armed silent-consent path against a now-unverified identity cannot fire (§10/#9).

**Idempotency.** Conditional consume makes webhook redelivery a no-op; the bot reply derives from current ticket status. Expired pending tickets are filtered at read time.

---

## 7. Credential, session & recovery security

**Password hashing — resolves the locked "high iterations" vs the 100k workerd cap.** PBKDF2-HMAC-SHA256 via WebCrypto, **chained** to beat the per-call cap: `rounds × 100,000` effective (target 6×100k = 600k = OWASP 2025), each round salting the next. Stored PHC-style: `pbkdf2$sha256$<rounds>$<iter>$<salt_b64>$<derived_b64>`, 16-byte random salt, 256-bit output, `constantTimeEqual` verify. **Measure real CPU with `wrangler dev`; if 6 rounds overruns the 10ms wall, drop to a count that fits (≥4×100k = 400k) and record per-hash.** Rehash-on-login ratchets params up and is the documented pbkdf2 → Argon2id-wasm path (deferred: 64MiB memory-hard risks OOM in the 128MB isolate; gate at `m≤19MiB,t=2,p=1` and validate on paid plan first).

**Breach screening.** HIBP Pwned Passwords k-anonymity (SHA-1, send 5 hex chars) at signup/change; ~800ms timeout, **fail-open** (allow + metric) so HIBP outage never blocks signup. **Policy:** 12–128 chars (max caps hash CPU DoS), NFKC-normalize, all Unicode, no composition/rotation rules; block HIBP hits + a tiny denylist.

**Anti-stuffing & enumeration (hardening §10/#7).** Existence-independence is **structural, not just hash-equal**:
- Rate-limit buckets key on **sha256(username)** so a non-existent user is throttled identically; the dummy hash uses **one fixed canonical param set** (never per-account params) so CPU is account-independent.
- A **constant response-time deadline** (~250ms floor) on every login outcome swamps residual timing; HIBP/rehash run behind that deadline.
- **No hard lockout** (Telegram is the recovery anchor; lockout would be a victim-DoS). Defenses: per-account progressive delay + per-IP sliding window, **plus Telegram step-up approval after N global failures** on an account.
- **Signup anti-abuse:** Cloudflare Turnstile (free, no card) or PoW on `/signup`, per-IP + global signup caps, identical timing/response for "username taken" vs "available."
- **Rate-limiter is not the DoS:** Cloudflare WAF rate-limiting / Turnstile sits **in front of every Turso write** so unauthenticated floods drop at the edge and never amplify into the write quota.

**Recovery codes.** Exactly 8, 128-bit each (Crockford base32, `XXXXX-XXXXX`), shown once at signup; stored hashed with **cheap** PBKDF2 params (input is already high-entropy); single-use consume; regenerate-all on exhaustion or request. Telegram bot approval is the **primary** reset path. If both Telegram and codes are lost → unrecoverable by design (no email); surfaced clearly at signup.

**Sessions & cookies — single normative spec (resolves three divergent definitions, §10/#6).** One opaque 256-bit id; only `sha256(id)` stored. **All** auth cookies MUST use the `__Host-` prefix: `__Host-mw_sess` and `__Host-mw_tkt` = `<id>; HttpOnly; Secure; SameSite=Lax; Path=/` with **no Domain** (closes sibling-`*.alxnko.eu.org` cookie-injection fixation; forbids path-scoped cookies). A CI test asserts every auth `Set-Cookie` begins with `__Host-` + `HttpOnly` + `Secure`. `SameSite=Lax` (not Strict) so top-level returns from Telegram/consent keep the cookie. Idle 14d (rolling `last_seen`), absolute 30d.

**Rotation & revocation.** Rotate the session id on every privilege transition (login, Telegram link/verify, password change, recovery use, consent grant). Session mint is **conditional on the request-object pending→consumed transition succeeding** (no forked sessions). `/logout` and "logout all" **server-side revoke** the row(s) **and** invalidate pending tickets + the refresh-token family, so a stolen cookie/in-flight ticket dies immediately. Account-settings sensitive changes bump `token_version`.

**CSRF.** Synchronizer (double-submit) token bound to **both** session and request object on every state-changing POST (login, signup, consent, settings, logout), constant-time validated, with `SameSite=Lax` + an `Origin`/`Sec-Fetch-Site == auth.alxnko.eu.org` check as defense-in-depth. `/authorize` CSRF is covered by PKCE+state per RFC 9700; the login-CSRF/fixation gap that PKCE does **not** cover is closed by the post-login owner-rebinding above.

**Secret-in-URL leakage (hardening §10/#8).** `Referrer-Policy: no-referrer` HTTP header on **every** capability-bearing HTML page (`/authorize`, `/login`, `/signup`, `/consent`, `/select-account`, recovery, verify-upgrade); `rid` carried in the `__Host-` cookie, **not** the query string; `Cache-Control: no-store` on `/authorize`/`/consent`/`/userinfo` too; strict CSP (`default-src 'self'; frame-ancestors 'none'; img-src 'self' <validated-logo-host>`); `homepage_url`/`privacy_policy_url` rendered `rel="noreferrer noopener"`.

---

## 8. Developer dashboard & client model (slice 3)

**Who.** Any logged-in Meowerse user; `owner_account_id` per client; per-account cap ~25. Dashboard lists only the caller's clients.

**Types (immutable at registration).** `public` (`token_endpoint_auth_method=none`) and `confidential` (`client_secret_basic`/`_post`). PKCE+S256 mandatory for **both** — the secret is defense-in-depth.

**Identifiers.** `client_id` = `mw_` + 128-bit base64url (opaque, plaintext, non-enumerable). `client_secret` = `mws_` + 256-bit, shown **once**, stored only as a PBKDF2 hash (same primitive as passwords), compared with `constantTimeEqual`. Rotation keeps ≤2 active hashes with `not_after` grace (24–72h); "revoke now" drops the old immediately.

**redirect_uri validation (hardening §10/#1 — parser-free contract).**
- **Default:** compare the **full raw** redirect_uri byte-for-byte (constant-time) against each stored **canonical** value. **No `new URL()`, no normalization, no percent-decoding at `/authorize`.** All normalization happens **once at registration**; the client must send exactly the stored string.
- **Loopback (RFC 8252), the only parsed exception:** entered **only** when the *stored* host is the exact literal `127.0.0.1` or `[::1]` (never `localhost`, never other `127/8`, `0.0.0.0`, decimal/octal, or IPv6-mapped/zero-compressed — all rejected **at registration**). At `/authorize`: strict-parse, require `scheme=="http"`, incoming host **byte-equal** to the registered literal, path+query byte-equal, only the port differs (valid 1–65535).
- **Authority-confusion hardening:** before any loopback parse, reject raw strings containing `@`, `\`, whitespace, control chars, `>1 '?'`, or any `#`; after parse, re-serialize and require host/port/path round-trip identical (parse-serialize-equal). Loopback's port is the only permitted divergence.
- **Server-side registration validators** (not just dashboard UI, re-applied at Management API PUT) reject wildcards, fragments, userinfo, non-loopback `http`, trailing-slash/case-only variants, and any non-literal loopback host. `https` required for all non-loopback; private-use schemes (`com.example.app:/cb`) allowed for native apps. The **same** exact-match validator guards `post_logout_redirect_uri`.

**Scope / verified-only.** `allowed_scopes` = owner-selected subset of the catalog (`openid` implied); `/authorize` rejects any out-of-set scope (`invalid_scope`). `verified_only` enforced **live at consent and at mint** with inline Telegram upgrade (§10/#9). `first_party` is **server/admin-set only**, never settable via the public API; `first_party=true` skips consent for trusted self-owned apps; third-party always shows consent; verified gating still applies.

**Metadata safety.** `name` required; `logo_url`/`homepage_url`/`privacy_policy_url` https-only, URL-only (no blob hosting); all text length-capped + control-char stripped; logo rendered size-capped with monogram fallback. Combined with the §7 Referrer-Policy/CSP controls this blocks consent-screen spoofing and rid leakage.

**Lifecycle.** `active | disabled | deleted(soft)`. Disable → `/authorize`+`/token` reject (`access_denied`), rows retained. Delete → soft-delete + **cascade revoke** (codes, refresh, consents) in one transaction; `client_id` **never reissued**. Standalone "revoke all grants" exists without delete. **On `allowed_scopes` narrowing or `verified_only` toggle, bump owner/grant epoch** so the silent fast path cannot fire under stale policy.

**Per-app rate limits in Turso, not KV** (KV free = 1000 writes/day, exhausted in minutes): fixed-window-per-minute UPSERT keyed `(client_id, window_start)`, but gated behind the edge limiter so abuse never reaches Turso.

---

## 9. Integration SDK + config-as-code IaC (slice 4)

**`@meowerse/auth`** — pure ESM core + `@meowerse/auth/astro` (BFF) + `@meowerse/auth/worker` (verifier). Subpath exports keep edge/browser bundles lean. One small dep: `jose` (WebCrypto, workerd-compatible). TDD, 100% core coverage.

**Default topology = BFF** (recommended). The Astro adapter runs Code+PKCE server-side; `access_token`+`refresh_token` live **only** in the opaque `__Host-` server session — never in the browser. A `spa-public` mode (PKCE, tokens in memory, no persisted refresh) is the secondary path.

**Core surface (injectable fetch/clock/crypto).** `createAuthClient(config)` → `buildAuthorizationUrl()` (returns `{url,state,nonce,codeVerifier}` for the caller to persist), `handleCallback(params, txn)`, `refresh()`, `buildLogoutUrl()`, `getDiscovery()`, `getJwks()`.

**Verification & mix-up defense (hardening §10/#3).** `handleCallback` MUST, **before** exchanging the code: (1) constant-time `state` equality; (2) **validate the authorization-response `iss` against the transaction's intended issuer** (RFC 9207) — reject on mismatch, or on absence when the AS advertises support; (3) never let `state` alone choose the token endpoint — each transaction is pinned to its issuer's discovery+jwks. `iss`-checking is **non-optional in core**, not adapter-specific. id_token verification then pins `alg:['ES256']`, `iss===issuer`, `aud===clientId`, `exp/nbf`±skew, **`nonce` equality**, **`typ!=='at+jwt'`** (token-type guard §10/#5). JWKS via `createRemoteJWKSet` with cooldown-limited refetch on `kid` miss.

**Worker verifier** = verify-only: `createTokenVerifier({issuer, audience})` pins `aud === 'https://api.meow.alxnko.eu.org'` **and** `typ==='at+jwt'`; rejects everything else. The single mandated verify entrypoint lives in shared code so a hand-rolled verifier can't reopen confusion.

**Refresh rotation (slice 2 dependency).** SDK assumes rotation+reuse-detection; on `invalid_grant` it destroys the session and forces re-auth.

**Management API + IaC.** `/mgmt/v1/clients/:name` on the same worker, bearer **management token** (owner-scoped opaque PAT, hashed at rest, `constantTimeEqual`, `owner_id` checked on every write). `GET` (plan), idempotent `PUT` upsert keyed by stable `name` (`unchanged:true` on no-op diff), `DELETE`, `POST …/rotate-secret` (explicit, never part of apply). Manifest = `auth.config.ts` `defineAuthClient({name, displayName, redirectUris[], postLogoutRedirectUris[], scopes⊆catalog, clientType, verifiedOnly, tokenEndpointAuthMethod})`; hand-rolled validator re-validates redirect/scope rules server-side. `meow-auth` CLI: `plan` (read-only diff), `apply` (PUT, prints client_id + one-time secret), `whoami`; token+issuer from env, wired into path-scoped GitHub Actions on `auth.config.ts` changes.

---

## 10. Threat model & mitigations

| # | Attack class | Control folded in | Residual risk |
|---|---|---|---|
| 1 | Open redirect / redirect_uri bypass (loopback alias, authority confusion) | Byte-exact raw compare; loopback only for literal `127.0.0.1`/`[::1]`, port-only diff, parse-serialize-equal; pre-parse rejection of `@ \ # ws ctrl`; same validator on logout; regression suite of alias/confusion vectors asserts REJECT in CI 90% gate. | RFC 8252 loopback port-flex inherently lets a co-tenant/local malware on a registered-loopback client's host intercept a code; bounded by PKCE + 60s single-use code. |
| 2 | Login-CSRF / flow fixation via pre-auth ticket | No request object on bare GET; signed single-use cookie pre-persist; **post-login owner-rebind** to the session that completes auth; `__Host-` non-transferable cookie, no `?tid=` URL acceptance; Origin/`Sec-Fetch-Site` + double-bound CSRF token; first-party consent-skip still requires same-browser owner match. | XSS on auth origin or an RP, or an open redirect on a registered RP, can still leak in-flight — mitigated by CSP + exact redirect match; generic phishing-of-own-credential remains. |
| 3 | OAuth mix-up (multi-AS code/secret leak) | IdP emits `iss` on every authorize response + advertises `authorization_response_iss_parameter_supported`; SDK validates `iss` **before** code exchange and pins each txn to its issuer's endpoints; `iss` check mandatory in SDK core. | Hand-rolled RP callbacks that ignore the SDK reopen it; full coverage needs static issuer+jwks pinning, not attacker-supplied discovery. |
| 4 | (covered by #5) token forgery | — | — |
| 5 | Token-type confusion (id_token replayed as access_token) + alg/kid | Distinct `typ` (`at+jwt` vs `JWT`) + `token_use` claim, checked everywhere; `/userinfo` requires `at+jwt`+resource `aud`, rejects id-token-shaped tokens; access `aud` = fixed resource (never client_id), pinned in the shared verifier; id_token verify rejects `at+jwt`; `alg:['ES256']` allowlist in shared helper; negative tests in the 90% gate. | Same-type theft (15m access token) until exp/revoke unless RP introspects; non-revocable JWT window for verifiers that skip introspect; compromised retiring key usable until immediate purge. |
| 6 | Session hijack / cross-channel Telegram fixation; cookie spec divergence | Ticket bound to originating browser via `__Host-` binding secret (hash stored); session released only to that browser; SIGNIN_OR_SIGNUP never auto-issues to any poller; single `__Host-` cookie spec across all dimensions (CI-asserted); rotate-and-delete on resume; server-side logout revocation. | Same-origin XSS on auth still abuses an in-page session; phishing a user into linking the attacker's own Telegram grants no victim access (out of class). |
| 7 | Credential stuffing / user enumeration / signup abuse | Throttle keyed on `sha256(username)` so non-existent users throttle identically; one canonical dummy-hash param set; ~250ms constant-time floor; HIBP/rehash behind the deadline; Turnstile/PoW + per-IP/global caps on signup; identical "taken"/"available" timing; Telegram step-up after N failures; **edge WAF rate-limit in front of every Turso write**. | Distributed low-velocity stuffing remains possible (no-hard-lockout limit); breached-password reuse on password-only accounts is the weakest link until MFA/Telegram mandatory; CAPTCHA farms allow slow signup; free WAF coarser than paid. |
| 8 | Secret-in-URL leak (rid via Referer/logs) | `Referrer-Policy: no-referrer` on all capability pages; `rid` in `__Host-` cookie not query string; `no-store` on authorize/consent/userinfo; strict CSP; `rel="noreferrer noopener"` on app links. | Edge request logs still record the request line if any handle stays in a URL; browser history/shoulder-surf on the device; non-conformant UAs (bounded by 15m single-use rid). |
| 9 | Verified-gating bypass / scope elevation via stale grant | Effective-scope intersection (`scope_set_max ∩ allowed_scopes ∩ requested`) recomputed **live** at every mint; `verified` gate and claim derived **live** from `EXISTS(telegram_link)`; `identity_epoch`/grant invalidation on unlink, scope-narrowing, verified-toggle; single mint assembler covered at 90% gate. | A token minted just before unlink/downgrade stays valid until exp (≤15m) for RPs that don't introspect; granular per-scope opt-out deferred. |
| 10 | Free-tier write-quota DoS via anonymous `/authorize` | Pre-auth path is **non-writing** (signed cookie request object, row only on first human POST); first-line rate-limit on edge WAF (zero Turso writes); global write-budget circuit breaker sheds with 503+Retry-After without writing; Turso BLOCKED = fail-closed for new tickets, still serves cached JWKS/discovery + existing-session reads; bounded GC `DELETE … LIMIT`; `/tg/start` gated by edge limiter + Turnstile. | Human-scale botnet solving Turnstile still drives genuine writes (orders harder, breaker-bounded); read-quota (500M/mo shared) is a secondary vector needing its own edge limiter+caching; the 100k/day request cap is shared across workers — isolate `workers/auth` or add per-service budgeting. |

---

## 11. Free-tier budget analysis

**Cloudflare Workers (100k req/day, ~10ms CPU, shared across api+edge+auth).**
- A full login is ~1 `/authorize` (no write) + 1 `/login` POST (1 PBKDF2 + 1–2 Turso writes) + 1 `/consent` POST (1 write) + 1 `/token` (1 sign + 1 delete) ≈ 5 requests. At, say, 2,000 logins/day that's ~10k requests — 10% of the shared budget. JWKS/discovery served from edge cache (RP key-fetches mostly never hit the worker). RPs verify access tokens **locally** → **zero introspection traffic** on the common path.
- CPU: chained PBKDF2 600k ≈ 3–6ms (native, no wasm), ES256 sign/HMAC/SHA-256 sub-ms — within 10ms. Cold-start migration is one memoized round trip. **Must be `wrangler dev`-measured; drop to 4×100k if it overruns.**

**Turso (5GB, ~500M reads, ~10M writes/month = ~333k writes/day sustained).**
- Writes/login ≈ 3 (request object + consent + code) — slice 1 has no refresh write. 2,000 logins/day ≈ 6k writes/day, ~2% of the sustainable rate. The **DoS fix is what makes this safe**: the anonymous `/authorize` write is removed, so an attacker can't amplify into the write cap, and the edge WAF drops floods before any write.
- Reads are tiny indexed lookups; sessions/JWKS-miss are the hot reads, cacheable.

**KV / Durable Objects:** none required for v1 state (KV's 1000 writes/day rules it out for counters; DO noted only for a future strict global limiter). **Cron:** 1 of 5 free triggers for the bounded cleanup sweep (lazy delete-on-read is the correctness path; cron is a backstop). **Pages:** unlimited free projects → `meowerse-auth-web` adds no cost. **Telegram Bot API:** free; deep-link reply rides the webhook response body (zero extra outbound). **Secrets/custom domains:** free, no card. **No email/SMS/HSM/paid IdP anywhere.**

---

## 12. Slice-1 implementation scope

**In scope:** discovery + JWKS + ES256 signing/rotation; `/authorize` (state-preserving, non-writing pre-auth) + `/authorize/resume`; password signup (HIBP, policy, 8 recovery codes shown once) + password login (chained PBKDF2, constant-time, enumeration-safe); consent (all-or-nothing, live effective-scope + verified gate); `/token` (`authorization_code` only); `/userinfo` (typ-guarded, live claims); `/token/revoke` + `/token/introspect`; sessions (`__Host-` cookie, rotation, server-side logout revoke); one **first-party seed client** created by migration; all §10 hardening that touches these paths (#1,#2,#5,#7,#8,#9,#10).

**File layout (mirrors `workers/api` exactly).**
```
workers/auth/
  package.json            @meowerse/auth-worker (api scripts + secret:* recipes)
  wrangler.jsonc          name meowerse-auth; nodejs_compat; cd 2025-06-01;
                          custom_domain auth-api.alxnko.eu.org; CORS_ORIGINS
  vitest.config.ts        v8, 90% lines/fns/branches/stmts, exclude src/types.ts only
  src/
    index.ts              thin DI router + generic-500 wrapper + edge-limit hook
    db.ts                 prodDeps + ensureSchema(SCHEMA[]) memoized
    security.ts           corsHeaders · constantTimeEqual · cookie · PKCE-S256 ·
                          redirect-uri validators (byte-exact + loopback + authority guard)
    ratelimit.ts          write-budget circuit breaker; Turso-BLOCKED state
    keys.ts               AUTH_SIGNING_KEYS parse/memoize; sign; JWKS build
    oidc.ts               discovery + jwks (pure, cache-wrapped)
    authorize.ts          validate · signed cookie request object · resume · owner-rebind
    consent.ts            grant/deny · live effective-scope intersection
    token.ts              code+PKCE exchange · ES256 mint (typ/token_use) · revoke · introspect
    userinfo.ts           typ=at+jwt guard · live-derived scoped claims
    session.ts            issue/lookup/rotate/revoke · CSRF synchronizer
    accounts.ts           signup · PBKDF2 chain · HIBP · recovery codes · live verified
    types.ts              Env + row interfaces + structural DbClient (coverage-excluded)
  test/                   vitest, fake DbClient + Deps{getDb, schemaReady unset}
packages/auth-shared/     pkg clone of ts-shared; src/index.ts:
                          pkce.ts · scopes.ts (catalog+intersection) · recovery.ts ·
                          tokentype.ts (typ/token_use constants) · types.ts
apps/auth-web/            clone of apps/web; pages login/signup/consent/error;
                          PUBLIC_AUTH_API_URL; Referrer-Policy:no-referrer + CSP headers
```

**TDD/test strategy.** TDD enforced; hard 90% per service (only `types.ts` excluded). Tests inject a fake `DbClient` + `Deps` (stub `getDb`, unset `schemaReady`) — no real Turso/network in CI. Required negative tests: id_token → `/userinfo` and → resource verifier ⇒ 401; access_token → id_token verify ⇒ reject; redirect_uri alias/authority-confusion vectors ⇒ REJECT; non-existent vs existent username ⇒ indistinguishable timing/response; replayed code ⇒ `invalid_grant`+family revoke; every `Set-Cookie` starts `__Host-`+`HttpOnly`+`Secure`; `iss` present on every authorize response.

**Deploy wiring.** Add `deploy-auth` / `deploy-auth-web` just recipes + `infra/cloudflare/deploy-auth.sh`/`deploy-auth-web.sh` (dirty-check + `record-deploy.sh`); the four sync edits (`services.sh`, `deploy.tf`, `deploy.yml`, `dns.tf`). `secret:*` recipes for `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `AUTH_SIGNING_KEYS`, (slice 2) `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `INTERNAL_HMAC_KEY`.

**Explicitly deferred (YAGNI).** Refresh tokens + `offline_access` (slice 2). Telegram subsystem + `auth-bot` worker (slice 2). Developer dashboard UI + Management API + SDK + IaC (slices 3–4). Argon2id-wasm. Granular per-scope consent. RFC 8707 resource indicators / multiple audiences. `private_key_jwt`. Dynamic Client Registration. Pairwise (PPID) subjects — `subject_types_supported:['public']` only; can add pre-first-external-client.

---

## 13. Resolved decisions (v1) — product owner sign-off 2026-06-25

These were the open questions; all are now committed. Code follows these, not the alternatives.

1. **PBKDF2 round count:** target **6×100k (600k)**; measure real CPU in `wrangler dev` and fall back to **4×100k (400k)** only if it overruns the 10ms wall. PHC record stores the actual round count per hash (rehash-on-login ratchets up later).
2. **Telegram step-up trigger:** **N=10** account-scoped failures → mandatory **Turnstile** challenge for *everyone* (works without Telegram); Telegram approval is offered only as a fast-path for accounts that have a linked Telegram. No password-only user is ever locked out. (Slice 2 detail.)
3. **Cleanup cadence:** **lazy delete-on-read only** for slice 1 (it is the correctness path). Add the free Cron Trigger sweep as a backstop in slice 2. (YAGNI.)
4. **One Telegram per account** in v1 (UNIQUE `telegram_id`). Multiple-link support revisited later if needed.
5. **Worker isolation:** **single shared Cloudflare account.** Auth load is tiny (~10k req/day at 2k logins); the write-budget circuit breaker + edge rate-limit bound any flood. Re-evaluate isolating `workers/auth` onto a second free CF account only if real request volume pressures `workers/api`'s shared 100k/day budget. Upgrade path noted, not built.
6. **`auth-bot` worker:** **separate worker** (mirrors `workers/edge` bot0, isolates the Telegram secret). (Slice 2.)
7. **Management auth:** **owner-scoped opaque PAT** now (hashed at rest, `constantTimeEqual`, `owner_id` checked per write). Full `client_credentials` grant deferred until a second machine identity needs it. (Slice 4.)