# Meowerse UX, Edge Routing & Multi-Device Unread Specification

## 1. Context & Motivation
1. **`auth.alxnko.dev` Button Flash**: Logged-in users visiting `auth.alxnko.dev` see "create account" and "sign in" buttons flash briefly before swapping to "go to your account" or redirecting to `/account`. This occurs because `LandingCta.tsx` defaults to rendering guest buttons while `s.loading === true`, and the page is statically cached at the CDN.
2. **`meowsenger.alxnko.dev` Redirect Flash**: Users with active SSO sessions on `auth.alxnko.dev` who hit `meowsenger.alxnko.dev` without a local cookie see a flash of "redirecting to login…" before the SSO handshake immediately forwards them to open chats without ever showing a login page.
3. **`meowsenger` Sender Multi-Device Unread Bug**: When a user sends a message from Device A, opening the app on Device B (or receiving an inbox websocket delta) marks the chat as unread. This happens because the SQL query in `chats.ts` tests `c.last_activity > m.last_read_at` without checking if the user was `last_sender_id`, and `applySidebarDelta` in `Chat.tsx` sets `unreadCount: 1` on cross-chat deltas without checking `senderId === me.id`.

---

## 2. Requirements

### R1. Instant Edge Routing & Layout-Stable CTA for `auth.alxnko.dev`
- **Edge Routing**: If a browser requests `GET /` on `auth.alxnko.dev` with an active `__Host-mw_session` cookie, the worker intercept must return `302 Found` with `Location: /account` in sub-5ms, skipping static HTML delivery and client hydration entirely.
- **Run Worker First**: Configure `"/"` in `run_worker_first` in `workers/auth/wrangler.jsonc`.
- **Layout-Stable CTA**: If a user lands on the static `/` page (e.g. without cookie or during hydration), `LandingCta.tsx` must render an accessible, layout-stable skeleton/placeholder matching the button height/width instead of prematurely rendering the guest buttons.

### R2. Seamless App Gateway for `meowsenger.alxnko.dev`
- In `AppShell.tsx`, replace the abrupt *"redirecting to login…"* gate with a clean, unified loading/authenticating state.
- Ensure transitions between initial load, silent SSO authentication, and chat mounting are visual-jank free.

### R3. Multi-Device Unread State for Senders
- **Database (`chats.ts`)**: In `listChats()`, when `c.last_sender_id = m.user_id`, `unread_count` must evaluate to `0`. A user's own last message must never cause their chat to show as unread on any device or reload.
- **Persistence (`conversation.ts`)**: When a message is sent, advance `last_read_at` for `senderId` to `now` in `chat_members` via `markRead()`.
- **Frontend Realtime Delta (`Chat.tsx`)**: In `applySidebarDelta`, if `senderId === me.id`, unread count must remain `0` (or preserve existing read state), never incremented to `1`.

---

## 3. Architecture & Constraints
- **Zero Extra Cost / Free Tier Invariant**: All static assets remain served via Cloudflare Assets ($0 cost, 0 worker requests for unauthenticated guests).
- **Zero Added Latency**: Edge cookie checks happen in V8 isolates in <1ms without database roundtrips.
- **No Unneeded Dependencies**: Use native Web APIs (`Response`, `Headers`, `document.cookie`).
