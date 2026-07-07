# meowsenger — real-time messenger on Cloudflare (design)

**Date:** 2026-07-07
**Status:** approved design, pre-plan
**Owner:** meowerse
**Related memory:** meowerse-architecture, meowerse-auth-platform, meowerse-design-system, meowerse-perf-playbook

---

## 1. Summary

`meowsenger` is a real-time chat service, added to the meowerse monorepo as a first-class
citizen alongside `auth`. It is a **relying party** of the meowerse OIDC identity provider
(`auth.alxnko.eu.org`) — there are **no local accounts**; users sign in with their meowerse
identity. The frontend is Astro + React islands reusing `@meowerse/ui`; the backend is a
Cloudflare **Worker + Durable Objects + D1**, free-tier only.

It replaces two prior attempts:

- **NextMeowsenger** (Next.js + Prisma + socket.io + client-side RSA E2EE) — feature-rich but
  its E2EE is broken (late-joiners can't read history, O(members) message size, no forward
  secrecy, server can't preview/search) and its socket.io server is an in-process hack that
  does not survive serverless/multi-instance hosting.
- **LibMeowsenger** (FastAPI + Python `aits` libs + Redis + Postgres) — **dropped E2EE for
  plaintext** and in exchange gained typing, presence, read receipts, unread counters and a
  clean domain model. Its data model and socket event contract port directly; its runtime does
  not fit Cloudflare.

meowsenger takes LibMeowsenger's proven **plaintext (transport + at-rest, no E2EE)** model and
NextMeowsenger's richer feature surface, on a native Cloudflare edge architecture.

### Goals

- Match NextMeowsenger's **core** chat feature set (DMs, groups, replies, edit, delete,
  history, roles, member management) and **surpass** it with typing / presence / read-receipts
  done server-side, correct indexes, and sub-50ms realtime.
- Fastest possible send path: local Durable Object SQLite write (<2ms) + in-memory broadcast
  (<50ms), D1 sync off the critical path.
- Reuse the meowerse platform: OIDC auth, `@meowerse/ui` design system, the worker/app
  templates, the deploy/version/WAF machinery.
- Free-tier only (no card). Denial-of-service is the threat model, not a bill.

### Non-goals (v1)

E2EE, channels/public discovery, forwarding, invite links & join requests, media/attachments,
reactions, server-side search, push/web notifications, avatar upload, account deletion,
multi-device key sync. All are named as **deferred slices** (§10) — not dropped.

---

## 2. Architecture (Topology A: DO-per-conversation + D1 graph)

```
apps/meowsenger-web  (Astro static + React islands, @meowerse/ui)
        →  meowsenger.alxnko.eu.org   (Worker with static assets; custom_domain via wrangler)
        │      login = redirect to auth.alxnko.eu.org (OIDC code+PKCE) — no local accounts
        ▼
workers/meowsenger   (Router Worker + Durable Object classes)
        →  meowsenger-api.alxnko.eu.org   (custom_domain via wrangler)
        │
        ├─ REST API over D1
        │     · GET  /api/session            → who am I (BFF cookie)
        │     · GET  /api/chats              → sidebar list (D1 read replica)
        │     · POST /api/chats              → create DM (deduped) / group
        │     · GET  /api/chats/:id/messages → history page (proxied to the chat DO)
        │     · GET  /api/users?q=           → contact / username search (D1)
        │     · chat member mgmt endpoints (roles, add/remove/leave)
        │
        ├─ GET /ws?chat=:id  → authenticate BFF cookie → Upgrade → Conversation DO stub
        │
        ├─ Conversation Durable Object   (one instance per chatId; idFromName(chatId))
        │     · WebSocket Hibernation API — holds member sockets; sleeps after 10s idle ($0)
        │     · embedded SQLite = the room's message log (source of truth for history)
        │     · in-memory ONLY: typing state, presence (evaporate on hibernate)
        │     · alarm() = periodic hard-purge of soft-deleted-past-window rows
        │
        └─ D1 "meowsenger"  (isolated database — never shares auth's Turso)
              users · chats · chat_members
```

**Why A.** The DO SQLite is the transactional hot path (local disk, <2ms, no network); D1 is the
cold relational graph queried for the sidebar via its **free automatic read replicas** (5–15ms),
kept fresh **off the critical path** with `ctx.waitUntil`. The two alternatives were rejected:
pure-DO (B) makes cross-cutting queries like contact search painful and adds DO→DO fan-out on
every message; D1-only (C) puts a DB write on the send hot path and burns the 100k/day write cap.

**Placement note.** The router Worker uses **default (edge) placement** — NOT Smart Placement.
Smart Placement co-locates a DB-bound worker near a single origin; it is the wrong model for
Durable Objects (which live near first access) and for D1 (which read-replicates). This differs
from `workers/api` / `workers/auth`, which DO use Smart Placement because they are Turso-bound.

---

## 3. Components

### 3.1 `apps/meowsenger-web` (frontend)

Cloned from the `apps/auth-web` template (Astro static build, deployed as a Worker with static
assets — **not** Pages).

- `astro.config.mjs`: `react()` integration, `vite.build.assetsInlineLimit: 0` (keep fonts
  external for the strict CSP).
- `src/layouts/Layout.astro`: reuses `@meowerse/ui/tokens.css` + `THEME_INIT_SCRIPT`. **Forks**
  the header/footer — `@meowerse/ui`'s `Footer`/`AppHeader` are hardcoded to the accounts app
  (brand text, nav hrefs, legal line), so meowsenger ships its own thin `MeowsengerHeader`
  (brand wordmark + session avatar/menu) and minimal footer, built from the same primitives and
  tokens.
- Chat UI is React islands (`client:load`): `ChatShell` (master/detail responsive layout),
  `Sidebar` (chat list + unread + live updates), `ChatWindow` (messages, reply, edit, delete,
  optimistic send, infinite scroll, typing/presence/receipts), `NewChatModal` (username search +
  group member picker), `MessageItem`, `TypingIndicator`, `PresenceDot`, skeletons.
- `src/lib/`: the typed API + WS client (`meowsengerApi.ts`, `chatSocket.ts`) — the **only**
  vitest-covered code (90% on `src/lib/**`).
- `public/_headers`: CSP (allow `connect-src` to `meowsenger-api.alxnko.eu.org` incl. `wss:`),
  Referrer-Policy, per-path `Cache-Control` (no blanket `/*` — Cloudflare merges same-name
  headers; authed pages listed `no-store` explicitly).

### 3.2 `workers/meowsenger` (router Worker)

Cloned from the `workers/api` template (the minimal `handle(req, env, deps)` + fake-DB pattern).

- `src/index.ts`: thin hand-rolled router; `export default { fetch }` wraps a pure
  `handle(req, env, deps)`; catches into a generic 500. Also exports the Durable Object class
  (`export class Conversation`).
- `src/types.ts`: `Env` (bindings: `DB` = D1, `CONVERSATION` = DO namespace, OIDC config vars,
  session-signing secret), and a structural `DbClient` for D1 so tests inject a fake.
- `src/db.ts`: `Deps { getDb(): DbClient; ... }`, `prodDeps(env)`, `SCHEMA` (D1 DDL),
  `ensureSchema`.
- `src/auth.ts`: OIDC callback + BFF session (see §5). Validates access tokens via JWKS +
  `assertAccessToken` from `@meowerse/auth-shared`.
- `src/chats.ts`, `src/messages.ts`, `src/members.ts`, `src/users.ts`: REST handlers (pure
  functions over `DbClient`).
- `src/conversation.ts`: the `Conversation` Durable Object (see §3.3).
- `src/security.ts`: CORS allowlist, session-cookie verify.
- Depends on `@meowerse/auth-shared` (token guards, `constantTimeEqual`) and `@meowerse/ts-shared`
  (`slugify`).

### 3.3 `Conversation` Durable Object

One instance per chat, addressed by `env.CONVERSATION.idFromName(chatId)`.

- **WebSockets (Hibernation API):** `state.acceptWebSocket(server, [tags])` so the DO can
  hibernate while sockets stay open; `webSocketMessage`/`webSocketClose` handlers instead of
  in-closure listeners. Auto-response configured for protocol pings (free, no wake).
- **Storage (SQLite):** `state.storage.sql` — `messages` table (§4.2) is the room's source of
  truth. Full history reads and pagination are served from here.
- **In-memory (volatile) only:** `typing` map (`userId → expiresAt`) and `presence` set of
  connected userIds. Never persisted. Broadcast to sockets and let them evaporate on hibernate.
- **Membership:** the **router** gates the connection — it validates `chat_members` in D1 before
  the `Upgrade` and passes the authenticated `userId` + `role` to the DO via internal headers
  (same-worker, trusted). The DO holds `userId`+`role` per connection in memory for per-message
  authorization (admin edit/delete). Membership/role changes take effect on reconnect (v1
  simplification — mid-session role change is rare).
- **On send:** validate membership + per-connection rate bucket → `INSERT` into SQLite → assign
  server `id`+`created_at` → broadcast `message` to connected sockets → `ctx.waitUntil` mirror
  to D1 (update `chats.last_message*`, bump `chat_members.unread_count` for members ≠ sender).
- **On read:** update `chat_members.last_read_at` + reset that member's `unread_count` in D1
  (via `waitUntil`), broadcast `read_receipt`.
- **`alarm()`:** periodic hard-purge — `DELETE FROM messages WHERE is_deleted=1 AND deleted_at <
  now - window`. DO SQLite auto-reclaims freed space after `DELETE` (no VACUUM; see §9.2).

### 3.4 D1 database `meowsenger`

Isolated, created once (`wrangler d1 create meowsenger`), bound as `DB`. Free tier: 500 MB/db,
5 GB total, 5M reads/day, 100k writes/day, 10 dbs/account. Holds only the cold graph (§4.1).

---

## 4. Data model

### 4.1 D1 (relational graph — the cold, cross-chat store)

```sql
-- meowerse users seen by the messenger; upserted from OIDC id_token claims on login.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,           -- OIDC sub (meowerse user id)
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  avatar_url    TEXT,
  verified      INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL            -- epoch ms; refreshed each login
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS chats (
  id             TEXT PRIMARY KEY,          -- uuid
  type           TEXT NOT NULL,             -- 'direct' | 'group'
  name           TEXT,                      -- null for direct
  created_by     TEXT NOT NULL,             -- users.id
  created_at     INTEGER NOT NULL,
  last_activity  INTEGER NOT NULL,          -- epoch ms; drives sidebar sort
  last_message   TEXT,                      -- denormalized preview (truncated body)
  last_sender_id TEXT,                      -- users.id of last message sender
  direct_key     TEXT UNIQUE                -- 'sorted(uidA):uidB' for direct dedup; null for group
);
CREATE INDEX IF NOT EXISTS idx_chats_last_activity ON chats(last_activity);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id       TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',  -- 'owner' | 'admin' | 'member'
  unread_count  INTEGER NOT NULL DEFAULT 0,
  last_read_at  INTEGER,
  joined_at     INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members(user_id, chat_id);

-- BFF sessions: opaque session id (in the __Host-mw_session cookie) → OIDC token set.
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,          -- opaque, high-entropy (the cookie value)
  user_id        TEXT NOT NULL,             -- users.id (sub)
  access_token   TEXT NOT NULL,             -- validated per request via JWKS
  refresh_token  TEXT,                      -- server-side refresh
  access_exp     INTEGER NOT NULL,          -- epoch ms; refresh when near
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL           -- absolute session TTL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
```

Sidebar query (served by a read replica):

```sql
SELECT c.id, c.type, c.name, c.last_message, c.last_sender_id, c.last_activity,
       m.role, m.unread_count, m.last_read_at
FROM chat_members m JOIN chats c ON c.id = m.chat_id
WHERE m.user_id = ?
ORDER BY c.last_activity DESC;
```

Direct-chat dedup: `direct_key = [min(uidA,uidB), max(uidA,uidB)].join(':')` with a UNIQUE
constraint — a second attempt to open the same DM resolves to the existing row.

### 4.2 DO SQLite (per-room message log — the hot store)

```sql
CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,           -- server-assigned crypto.randomUUID()
  sender_id    TEXT NOT NULL,              -- users.id
  body         TEXT NOT NULL,              -- plaintext (at-rest encryption + TLS; no E2EE)
  reply_to_id  TEXT,                       -- messages.id, nullable
  created_at   INTEGER NOT NULL,           -- epoch ms, server-set
  edited_at    INTEGER,                    -- null unless edited
  is_deleted   INTEGER NOT NULL DEFAULT 0, -- soft delete
  deleted_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
```

Pagination: `SELECT ... WHERE created_at < ?cursor ORDER BY created_at DESC LIMIT 50`. Because
all inserts for a room are serialized through its single DO, `created_at` is made server-monotonic
(`created_at = max(now, lastCreatedAt + 1)`), so the timestamp cursor is unique and stable — no
uuid7/time-ordered-id dependency needed.

**No message bodies in D1.** D1 only stores the denormalized `last_message` preview per chat.
Full history lives in the room's DO. This keeps D1 tiny and the write cost bounded.

---

## 5. Auth integration (OIDC relying party + BFF)

meowsenger never sees a password. Login is delegated to `auth.alxnko.eu.org`.

1. **Client-config registration (config-as-code):** an `auth.config.ts` uses
   `defineAuthClient({ name: 'meowsenger', clientType: 'confidential', redirectUris:
   ['https://meowsenger.alxnko.eu.org/auth/callback', 'http://localhost:4321/auth/callback'],
   scopes: ['openid','profile'] })`, and `provision()` (with a management token) upserts it via
   the Management API. No manual dashboard step.
2. **Login:** the app calls `@meowerse/auth` `buildAuthorizationUrl` (Authorization Code + PKCE)
   and redirects to auth. The PKCE verifier + state live in a short httpOnly cookie set by the
   worker before redirect.
3. **Callback (`GET /auth/callback` on the router Worker):** `exchangeCode` → obtain
   `id_token` + `access_token` (+ refresh). **BFF pattern:** the worker stores the token set in
   the D1 `sessions` table (§4.1), keyed by an opaque high-entropy session id, and sets that id
   in a `__Host-mw_session` cookie (httpOnly, Secure, SameSite=Lax, Path=/). No tokens ever
   reach JS → no XSS token theft. Sessions are TTL'd and swept by `expires_at`.
4. **Every REST/WS request** carries `__Host-mw_session`; the worker authenticates by loading that
   session from D1 (opaque id → `user_id`). The OIDC **id_token is verified once at the callback**
   (JWKS/ES256 + iss/aud/nonce/exp via `@meowerse/auth` `verifyIdToken`); the access token is
   retained server-side only to call meowerse resource APIs later (none in v1), with server-side
   `refresh` to extend the session. The messenger is **not** the access-token audience (that's the
   shared `api.meow` resource), so it does not act as a resource server — its own session cookie is
   the auth boundary.
5. **User upsert:** the profile claims (`preferred_username`, `name`, `picture`, `verified`) live in
   **`/userinfo`**, not the id_token (the auth worker keeps data-bearing claims out of the
   id_token — confirmed in `workers/auth/src/token.ts`). At the callback the worker fetches
   `/userinfo` with the access token and upserts the caller into D1 `users`
   (`sub`→id, `preferred_username`→username, `name`→display_name, `picture`→avatar_url, verified).
   This is the messenger's searchable user directory — it never reads auth's accounts DB directly.
6. **Logout:** clear session server-side + cookie; optionally `buildLogoutUrl` back to auth with
   `post_logout_redirect_uri` = meowsenger.

**No login/signup forms in meowsenger → no Turnstile here.** The only human-challenge surface is
auth's own login page, already protected.

---

## 6. Realtime protocol (WebSocket)

Connect: `wss://meowsenger-api.alxnko.eu.org/ws?chat=<chatId>`, cookie-authenticated. The router
validates membership then `Upgrade`s to the chat's DO. Reuses LibMeowsenger's event contract.

**Client → server** (JSON frames):

| type          | payload                                  | effect |
|---------------|------------------------------------------|--------|
| `send`        | `{ tempId, body, replyToId? }`           | persist + broadcast; ack `sent` with real id |
| `edit`        | `{ id, body }`                           | own message, ≤1h; broadcast `edited` |
| `delete`      | `{ id }`                                 | own ≤24h OR admin/owner; soft-delete; broadcast `deleted` |
| `read`        | `{ upTo }`                               | update last_read; broadcast `read_receipt` |
| `typing`      | `{ on: bool }`                           | in-memory; broadcast `typing` (debounced, ~4s TTL) |

**Server → client:**

| type            | payload |
|-----------------|---------|
| `sent`          | `{ tempId, message }` (optimistic reconcile) |
| `message`       | `{ message }` |
| `edited`        | `{ id, body, editedAt }` |
| `deleted`       | `{ id }` |
| `read_receipt`  | `{ userId, upTo }` |
| `typing`        | `{ userId, on }` |
| `presence`      | `{ userId, online }` (on connect/disconnect) |
| `error`         | `{ code, message }` |

Presence: broadcast `online` when a user's first socket connects to the room, `offline` when
their last leaves.

**Cross-chat sidebar liveness (deliberate v1 simplification).** In v1 the client holds a WS only
to the **active** room, so live `message`/unread updates arrive only for the open chat. Unread for
**background** chats is refreshed by re-running the sidebar D1 query on window focus + a light
interval poll while visible. `// ponytail: active-room WS only; background unread via poll.`
Upgrade path (v1.1): a per-user **`UserInbox` DO** holding one WS that all the user's conversation
DOs notify (small RPC, off critical path) for instant cross-chat unread/preview badges — added
only if the poll UX proves insufficient.

Server sets/overrides `senderId` (authenticated), `created_at`, `id`, `isForwarded`. Client
input (`body`, `replyToId`) is validated; `replyToId` must reference a message in the room.

---

## 7. Feature spec (v1 core)

- **DMs:** deduped via `direct_key`. Create-or-open by target username.
- **Groups:** named, multi-member. Creator = `owner`. Add members from contact picker at
  creation and later (admin+).
- **Roles:** `owner` / `admin` / `member`. owner unremovable/undemotable; only owner
  promotes/demotes admins; admin can add/remove members and delete any message.
- **Send / receive:** optimistic UI (tempId → server id reconcile on `sent`).
- **Reply:** `replyToId` with quoted preview + jump-to-original (client scroll, loads history
  until found).
- **Edit:** own message, server-enforced ≤1h window, `edited_at` set, "edited" badge.
- **Delete:** soft; sender ≤24h OR admin/owner any time; renders "message deleted" placeholder;
  DO `alarm()` hard-purges later.
- **Read receipts + unread:** per-member `last_read_at` + `unread_count`; sidebar bold + count;
  smart mark-read (only when actually unread and not own last message).
- **Typing + presence:** in-memory, broadcast, TTL'd.
- **History:** infinite scroll, 50/page, `created_at`/id cursor, scroll-position preserved.
- **Sidebar:** sorted by `last_activity`, decrypted-free preview (`"You:"`/`"<name>:"`), relative
  time, live updates, unread indicators.
- **New chat modal:** debounced username search (D1), group member picker.
- **Contacts:** derived from users you share chats with + username search.
- **Member management drawer:** list members + roles, add/remove/promote/demote/leave.
- **Mobile:** master/detail (sidebar hides when a chat is open; back button).
- **Loading/empty states:** skeletons for list + messages; empty conversation + welcome
  placeholders.

Validation & limits: `body` length cap (e.g. 4000 chars), username search min length,
per-connection message rate bucket, membership gate on every mutation.

---

## 8. Protection

- **Edge WAF:** add `meowsenger-api.alxnko.eu.org` to `var.waf_api_hosts` — it joins the existing
  single zone `http_ratelimit` rule (100 req/10s per `ip.src`+`cf.colo.id`, `block`,
  free-plan-fixed 10s period). The static UI host is **not** added (static assets don't consume
  Worker quota).
- **WebSocket abuse:** access-token/session required to connect; rooms membership-gated;
  in-memory per-connection token bucket caps message flood inside the DO (drops with `error`,
  not a disconnect storm).
- **BFF cookie:** `__Host-` prefix, httpOnly, Secure, SameSite=Lax; CSRF-safe for the API
  because state-changing routes are same-origin + require the cookie; WS upgrade is same-origin.
- **No new human-challenge surface** → no Turnstile in meowsenger.

---

## 9. Operational guardrails (production sanity)

1. **D1 write discipline (avoid runaway `waitUntil`):** the mirror is **exactly-once per event**,
   never in a retry loop; coalesce to ≤2 statements per message (`UPDATE chats …` +
   `UPDATE chat_members … WHERE chat_id=? AND user_id<>sender`). No un-cached hot-loop reads in
   the DO. Free tier hard-caps writes at 100k/day (protective), but keep the per-message cost
   bounded so a paid upgrade never runs away. **Burst debounce:** under a rapid group burst,
   coalesce the `chats.last_message`/`last_activity` mirror on a short in-DO timer (~1–2s) so many
   messages/sec collapse into one D1 write; the unread bump can piggyback the same coalesced write.
   (The DO SQLite insert + broadcast still happen per-message, immediately — only the D1 mirror is
   debounced.)
2. **DO SQLite storage reclaim:** the DO `alarm()` runs a true `DELETE` on soft-deleted-past-window
   rows. In **DO SQLite this is sufficient** — Cloudflare auto-reclaims freed space after a
   `DELETE` (the storage layer cleans up automatically); **no `VACUUM` needed** (VACUUM is a
   full-DB rewrite needing ~2× space and is the wrong tool here, unlike a self-managed SQLite
   file). Run `PRAGMA optimize` after index creation (the documented DO maintenance command), not
   VACUUM. Cap context: free plan allows **5 GB total DO storage across the account** (10 GB max
   per DB) and is **not *billed*** for SQLite storage (paid SQLite-storage billing began Jan 2026)
   — so this is a cap hygiene concern, not a bill, and unreachable at messenger text scale anyway.
3. **Hibernation correctness:** use the Hibernation API (`acceptWebSocket` + `webSocketMessage`),
   not in-memory socket closures, so idle rooms cost $0 and survive DO eviction. Presence/typing
   are rebuilt from live connections on wake — never assume they persisted.
4. **Cost model:** incoming WS messages bill 20:1 (20 msgs = 1 request); pings + outgoing are
   free. 100k DO requests/day free ⇒ ~2M inbound chat messages/day headroom before the cap.

---

## 10. Scope decisions (what's in vs out)

**IN — full NextMeowsenger parity** (all in the §13 sequence, Slices 2–9): DMs, groups, **channels**
(broadcast/admin-post/public-slug/subscribe), **public/private visibility** + gated preview,
**invite links/codes** + `/join/<code>` + preview, **join requests** (approve/reject),
auto-invite + `allow_auto_group_add`, reply, edit, delete (soft + bulk), **forwarding**, multi-select
action bar, reactions, read receipts + unread, presence, typing, roles OWNER/ADMIN/MEMBER + member
management, new-chat modal + contact picker + username search, slug validation, context menus,
skeletons/empty states, mobile + desktop layouts, **server-side search**, account/data deletion,
push/web notifications.

**SURPASSES NextMeowsenger** (things it lacked): presence/online status, typing indicators,
server-side delivery/read receipts, sub-50ms DO broadcast (no in-process socket hack), proper
indexes, server-side search (its E2EE made this impossible), no O(members) crypto blow-up.

**Avatars — from Telegram, free (no R2, no upload):** the user's avatar is the Telegram Login
Widget `photo_url` (a stable `t.me/i/userpic/...` CDN URL) that `workers/auth` already captures
(`telegram.ts` → `avatar_url`) and returns as the `picture` claim from `/userinfo`. meowsenger's
`upsertUser` maps `picture` → `users.avatar_url` on every login, so the chat UI shows Telegram
avatars with an initials fallback. **Refresh cadence:** updated whenever the user logs in (userinfo
re-fetched; auth refreshes `avatar_url` on each Telegram re-auth). Not instant-live (Telegram
doesn't push photo-change events to bots), but auto-refreshes on login — acceptable. (Bot
deep-link logins have no `photo_url` → initials fallback.)

**OUT:**
1. **Message attachments / file uploads** — dropped by choice (user: "without files"). This was
   meowsenger's only R2 dependency, so with it gone **meowsenger is 100% free-tier — nothing is
   account-gated.** (Avatars come from Telegram, above — no upload needed.)
2. **Opt-in E2EE "secret chats"** — deliberately dropped (§1): E2EE breaks server search/preview/
   late-joiner history and the OIDC (no-password) model; NextMeowsenger's own E2EE was broken.

---

## 11. Deployment wiring (concrete)

Service keys: **`meowsenger`** (worker) and **`meowsenger-web`** (app). Follow the documented
"add one entry per service" recipe:

- **Frontend:** `apps/meowsenger-web` (`@meowerse/meowsenger-web`), Cloudflare worker
  `meowsenger-web`, `wrangler.jsonc` `assets: { directory: "./dist" }`, route
  `meowsenger.alxnko.eu.org` `custom_domain: true` (no `dns.tf` edit).
- **Backend:** `workers/meowsenger` (`@meowerse/meowsenger-worker`), Cloudflare worker
  `meowsenger`, route `meowsenger-api.alxnko.eu.org` `custom_domain: true`, bindings:
  `d1_databases` (`DB` → the `meowsenger` D1), `durable_objects` (`CONVERSATION` → `Conversation`
  class) + a `migrations` block declaring `new_sqlite_classes: ["Conversation"]`,
  `compatibility_flags: ["nodejs_compat"]`. **No** Smart Placement.
- **Deploy scripts:** `infra/cloudflare/deploy-meowsenger.sh` (clone of `deploy-auth.sh`) and
  `deploy-meowsenger-web.sh` (clone of `deploy-auth-web.sh`).
- **`infra/services.sh`:** add `meowsenger)` → `workers/meowsenger packages/ts-shared
  packages/auth-shared` and `meowsenger-web)` → `apps/meowsenger-web`.
- **`justfile`:** `deploy-meowsenger` + `deploy-meowsenger-web` recipes.
- **`infra/cloudflare/deploy.tf`:** two entries in `local.services`.
- **`infra/cloudflare/waf.tf`:** add `meowsenger-api.alxnko.eu.org` to `var.waf_api_hosts`.
- **`.github/workflows/deploy.yml`:** changed-service detection + deploy steps (workflow_dispatch).
- **Secrets (set once via `wrangler secret put`):** session-signing secret, OIDC management token
  (for `provision`), OIDC client secret (confidential). No Turso secrets (D1 is a binding).
- **turbo.json / root package.json:** nothing — workspaces are globbed.

The first deploy also runs `wrangler d1 create meowsenger` and applies the D1 schema.

---

## 12. Testing & quality

- **Worker:** the `handle(req, env, deps)` + fake-`DbClient` pattern; 90% coverage on `src/**`
  (minus `types.ts`). REST handlers unit-tested with an in-memory fake D1.
- **Durable Object:** tested with `@cloudflare/vitest-pool-workers` (real workerd `SQLite` +
  WebSocket), covering send/edit/delete/read, membership gating, rate bucket, and `alarm()`
  purge. (First WebSocket/DO code in the monorepo — introduces this test harness.)
- **App:** 90% on `src/lib/**` (API + WS client); pages/islands validated by `astro check` +
  `astro build`.
- Full `just lint` + `just test` green before each slice's PR; shipping-to-merge discipline
  (worktree, full local gate, one PR per repo, merge when CI green).

---

## 13. Shipping sequence — FULL NextMeowsenger parity (minus E2EE)

Goal: match **every** NextMeowsenger feature and surpass it. Built slice-by-slice, tested;
**one coordinated deploy at the end** (user directive 2026-07-07: "deploy when we fully finish").

1. **Scaffold + auth** ✅ LIVE — OIDC BFF login, D1 users/sessions, `/api/session`, single-host worker.
2. **Realtime DM send/receive** (in progress) — `Conversation` DO (Hibernation WS + SQLite log),
   `/ws`, send + broadcast + history pagination, D1 last-message mirror. DMs.
3. **Presence · typing · read receipts + unread** — in-memory presence/typing (broadcast, TTL),
   per-member `last_read_at`/`unread_count`, mark-read, live sidebar unread badges.
4. **Reply · edit · delete · multi-select** — reply (quoted + jump-to-original), edit (own, 1h),
   delete (soft; sender 24h / admin any; bulk), multi-select action bar (copy / bulk-delete),
   context menu per message, `alarm()` hard-purge of soft-deleted.
5. **Groups + member management** — create named group, roles OWNER/ADMIN/MEMBER (+ enforcement),
   add/promote/demote/remove/leave, member drawer, new-chat modal (username search + member
   picker + contact picker), full sidebar (sort/preview/live/skeletons/empty states).
6. **Channels + visibility** — CHANNEL type (broadcast, admin-only post), public slug discovery
   `/c/<slug>` (+ live slug-availability check), subscribe/unsubscribe, PUBLIC/PRIVATE visibility
   on groups+channels, gated preview (join/subscribe/request-access CTA + lock screen), toggle.
7. **Invites + join requests** — invite codes (generate/refresh 12-char, `/join/<code>` + preview
   page), join requests for private chats/channels (request → admin approve/reject, pending tab),
   auto-invite-on-group-add + `allow_auto_group_add` privacy opt-out.
8. **Forwarding + polish + protection** — forward multi-select → N chats, forwarded/edited badges,
   settings modal (username change + live availability, privacy toggle), mobile master/detail +
   **desktop full-width layout**, WAF host in rate-limit rule, in-DO per-connection message rate
   bucket, membership gates audited.
9. **Reactions · search · notifications · deletion** — emoji reactions, **server-side message
   search** (now possible — plaintext; D1 FTS or index DO), account/data deletion (child-first
   erasure), push/web notifications.

**Parallel track — auth consolidation:** merge `apps/auth-web` into `workers/auth` (one worker on
`auth.alxnko.eu.org` serving static assets + all OIDC/UI routes), change issuer →
`https://auth.alxnko.eu.org`, re-point + re-provision the meowsenger client, retire
`auth-api.alxnko.eu.org`. Safe because meowsenger is the only client. Update all docs.

**Out of scope:** (a) **Media / attachments + avatar upload** — need Cloudflare **R2**, which
requires a payment method; the account is free-tier-no-card, so this is the ONE NextMeowsenger
capability gated by the account, not the design. (b) **E2EE** — deliberately dropped (see §1).

Each slice: spec-conformant + tested (node + workers pools) on its branch. Deploy is a single
coordinated cutover at the end (meowsenger + auth), then verify live.
```

