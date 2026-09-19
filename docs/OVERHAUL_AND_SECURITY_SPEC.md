# Meowerse Overhaul, Domain Migration & Security Specification

## 1. Overview
This specification records the technical architecture, design decisions, bug fixes, and security posture implemented during the Meowerse system overhaul.

---

## 2. Real-Time Synchronization Engine

### Root Causes
1. **Inbox Fanout Exclusion Bug**:
   In `workers/meowsenger/src/conversation.ts`, `inboxFanout()` calculated `targets = ids.filter((id) => id !== senderId && !this.onlineUsers().includes(id))`.
   - Excluding `senderId` broke multi-tab sessions and multi-device updates for the sender.
   - Excluding `onlineUsers()` caused users transitioning between chats to lose sidebar unread/preview notifications because closing WebSockets persist temporarily in DO memory.
2. **Database Write vs WebSocket Delta Race**:
   In `waitUntil`, `mirrorLastMessage(chatId, msg)` and `inboxFanout(...)` were dispatched concurrently without serialization. Clients refetching chat metadata upon receiving the inbox delta queried D1 before the database transaction committed.
3. **Dead Socket Persistence on Client Sleep/Wake**:
   Client tabs that were suspended or put to sleep failed to detect silent connection drops until user action.

### Fixes & Implementation
- **DO Fanout (`workers/meowsenger/src/conversation.ts`)**:
  - `targets = ids`: Broadcast to all members of the chat.
  - Sequenced: `await this.mirrorLastMessage(...)` commits to D1 *before* `this.inboxFanout(...)` fires deltas.
- **Client Resilience (`apps/meowsenger-web/src/hooks/useConversation.ts`, `useInbox.ts`)**:
  - Attached `window.addEventListener('online', ...)` and `document.addEventListener('visibilitychange', ...)` to trigger instant health-checks and reconnects on wake.
  - Added 0ms optimistic updates to `onActiveMessageRef` on `send()` for immediate sidebar sorting.
  - Added delta fallback retry (600ms backoff) when receiving a delta for a chat not yet loaded in client cache.

---

## 3. UI/UX Architecture & Layout Redesign

### Requirements
- Eliminate global top navigation header in the messenger.
- Dock user account profile, settings, and logout into the bottom of the chat sidebar.
- Remove redundant intermediate landing pages to provide instant app entry.

### Implementation
1. **Layout Adaptability (`apps/meowsenger-web/src/layouts/Layout.astro`)**:
   - Added `header?: boolean` and `footer?: boolean` flags (default `true`).
   - `pages/app.astro` and `pages/index.astro` use `header={false}` and `footer={false}` for full-bleed viewport utilisation.
2. **Bottom Account Dock (`apps/meowsenger-web/src/components/ChatSidebar.tsx`, `app.css`)**:
   - Profile avatar, display name, `@username`, settings cog (⚙), and logout button (⎋) docked at bottom.
   - Wired settings modal dialog into the sidebar.
3. **Frictionless App Entry**:
   - `apps/meowsenger-web/src/pages/index.astro` mounts `<AppShell>` directly.
   - `apps/auth-web/src/pages/index.astro` includes fast-path session check to forward active sessions directly to `/account`.

---

## 4. Domain Migration (`alxnko.eu.org` $\rightarrow$ `alxnko.dev`)

### Strategy
- **Zero-Downtime Transition**: All workers (`auth`, `meowsenger`, `api`, `auth-bot`) bind both custom domains concurrently.
- **Edge Single Redirects (Cloudflare Ruleset)**: Cloudflare Anycast edge proxy (Pingora) intercepts `*.alxnko.eu.org` and immediately terminates requests with HTTP 301/308 redirects, consuming 0 Worker requests and providing sub-5ms response time.
- **In-Worker Permanent Redirects (Defense-in-Depth)**: Worker routers handle incoming requests matching `*.alxnko.eu.org` with HTTP 308 Permanent Redirect (RFC 7538) to preserve HTTP request method and body on POST/PUT mutations, while emitting full CORS headers and preflight handling.
- **HSTS Enforcement**: Redirect responses include `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`.
- **CORS & OIDC**: CORS origins accept both domains during the cutover window; default fallbacks and client redirect URIs updated to `alxnko.dev`.
- **Domain Independence (Local & Test Environments)**: CORS handlers automatically accept any loopback/localhost (`localhost:*`, `127.0.0.1:*`, `*.local`) origin across any port, removing environment hardcoding. Default OIDC issuer derives dynamically from request origin when unset.

---

## 5. Cloudflare Security Insights Audit & Remediation

Cloudflare Security Center reported 12 findings across zones `alxnko.dev`, `alxnko.eu.org`, and `alxnko.workers.dev`:

| Severity | Finding | Subject | Remediation Status | Mechanism |
|---|---|---|---|---|
| Low | Review unwanted AI crawlers with AI Labyrinth | `alxnko.dev` | **Resolved** | Zone API: `ai_bots_protection: "block"`, `ai_training: "disallow"` + `robots.txt` |
| Low | Review unwanted AI crawlers with AI Labyrinth | `alxnko.eu.org` | **Resolved** | Zone API: `ai_bots_protection: "block"`, `ai_training: "disallow"` + `robots.txt` |
| Low | Review unwanted AI crawlers with AI Labyrinth | `alxnko.workers.dev` | **Resolved** | `robots.txt` disallowing GPTBot, CCBot, ByteSpider, Claude-Web, Google-Extended |
| Low | Security.txt not configured | `alxnko.dev` | **Resolved** | RFC 9116 `/.well-known/security.txt` & `/security.txt` served with 1-year expiry |
| Low | Security.txt not configured | `alxnko.eu.org` | **Resolved** | RFC 9116 `/.well-known/security.txt` & `/security.txt` served with 1-year expiry |
| Low | Security.txt not configured | `alxnko.workers.dev` | **Resolved** | RFC 9116 `/.well-known/security.txt` served by edge worker |
| Moderate | Bot Fight Mode not enabled | `alxnko.dev` | **Resolved** | Zone API: `fight_mode: true`, `enable_js: true` |
| Moderate | Bot Fight Mode not enabled | `alxnko.eu.org` | **Resolved** | Zone API: `fight_mode: true`, `enable_js: true` |
| Moderate | Domains without HSTS | `meow.alxnko.eu.org` | **Resolved** | Zone API: `security_header` HSTS enabled (`max_age=31536000`, `include_subdomains=true`, `preload=true`) |
| Moderate | Domains without HSTS | `alxnko.dev` | **Resolved** | Zone API: `security_header` HSTS enabled (`max_age=31536000`, `include_subdomains=true`, `preload=true`) |
| Moderate | Domains without "Always Use HTTPS" | `alxnko.dev` | **Resolved** | Zone API: `always_use_https = "on"` |
| Moderate | Domains without "Always Use HTTPS" | `www.alxnko.dev` | **Resolved** | Zone API: `always_use_https = "on"` (covers apex + subdomains) |

---

## 6. Free-Tier Boundaries & Performance
- Rate limits remain edge-enforced (`cloudflare_ruleset.api_rate_limit`) before worker invocation to safeguard the 100k/day free-tier Worker quota.
- Static assets bypass worker execution via Cloudflare Assets.
- Zero extra dependencies added; standard Web APIs utilized (`URL`, `Headers`, `Response`).
