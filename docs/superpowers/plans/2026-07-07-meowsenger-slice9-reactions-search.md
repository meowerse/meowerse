# meowsenger Slice 9 — reactions · search · account-deletion · notifications — plan

> subagent-driven. Gates green; commit per group; no push. Last meowsenger feature slice.

**Goal:** emoji reactions, within-chat message search (server-side — plaintext makes it possible),
account data deletion, and new-message browser notifications (backgrounded tab). Full Web Push
(VAPID + service worker, tab-closed) is documented as a follow-up (heavy; needs VAPID keys).

**Spec:** §13 slice 9.

---

## Group A — backend: reactions + search + account delete

**Files:** `workers/meowsenger/src/{conversation.ts, chatapi.ts, index.ts, chats.ts, users.ts}` (+ tests).

1. **Reactions (DO):** new DO SQLite table `reactions(message_id TEXT, user_id TEXT, emoji TEXT, PRIMARY KEY(message_id, user_id, emoji))` (in the constructor CREATE). WS `{type:"react", id, emoji}` → toggle (insert if absent → `on:true`, delete if present → `on:false`), broadcast `{type:"reaction", id, emoji, userId, on}` to ALL. `historyFor` aggregates each message's reactions into `reactions: {emoji: count, mine: emoji[]}` (LEFT JOIN reactions; or a second query per page keyed by the page's ids). Validate emoji (short, a small allowlist or just length ≤ 8 + non-empty). Cap reactions per user per message reasonably.
2. **Within-chat search (DO RPC):** `search(query, limit=30)` → `SELECT * FROM messages WHERE is_deleted=0 AND body LIKE '%'||?||'%' ORDER BY created_at DESC LIMIT ?` (escape LIKE wildcards in the query). Return Wire[]. Route: `GET /api/chats/:id/search?q=` → membership-gate → `stub.search(q)`. (Global cross-chat search = follow-up: needs a D1 mirror/FTS index; note it — we deliberately keep bodies only in the DO.)
3. **Account data deletion:** `POST /api/account/delete` (session-gated, requires a confirm field) → child-first D1 erasure of the caller's meowsenger data: `join_requests`, `chat_members` (leave all — transfer/delete owned chats via the existing `leave` logic per chat, or simply delete memberships), `sessions`, and the `users` row. (Messages in DO SQLite persist attributed to the now-unknown senderId — the UI shows the raw id; note this. Full per-DO message erasure = follow-up.) Then clear the session cookie. This is meowsenger-side deletion; the auth account is separate (auth owns that).
4. **Tests:** reaction toggle (add→on, again→off, broadcast, historyFor aggregates + `mine`); search (matches body, excludes deleted, membership-gated 403 for non-member, LIKE-escape); account delete (removes memberships/sessions/user, owned-chat handling, clears cookie, requires confirm). Keep all green ≥90%.

Commit: `feat(meowsenger): reactions + within-chat search + account data deletion`.

---

## Group B — frontend: reactions UI + search + delete + notifications

**Files:** `apps/meowsenger-web/src/{lib/chat.ts, components/{Chat, MessageItem, ReactionBar(new?), SearchBar(new?), Settings}.tsx, styles/app.css}`.

1. **lib:** `searchChat(base, chatId, q)`, `deleteAccount(base, confirm)`; `Message.reactions?`. Extend `chat.test.ts`.
2. **Reactions:** a small emoji picker on a message (from the context menu "react" or a hover 😀 button) with ~6 common emojis; sending `{type:"react", id, emoji}`. `MessageItem` renders reaction pills (emoji + count, highlighted if `mine`); clicking a pill toggles. Handle the `reaction` frame in `applyFrame` (update the message's reactions map, optimistic on own toggle).
3. **Search:** a search affordance in the chat header → an input; `searchChat` → results list (sender + snippet + time) → clicking a result jumps to that message (reuse the jump-to-original loads-until-found from Slice 4). Escape/clear closes.
4. **Account deletion:** in `Settings.tsx`, a "danger zone" — delete-my-data with a type-to-confirm (reuse `@meowerse/ui` `ConfirmDialog` tiered friction) → `deleteAccount` → on success, redirect to `/` (logged out).
5. **Notifications (backgrounded):** on a new incoming `message` frame while `document.hidden` (tab not focused) and the sender isn't me, if `Notification.permission==='granted'` show a `new Notification(peer/sender name, {body})`; request permission once (a subtle prompt/toggle in Settings, not aggressive). No service worker / no VAPID this slice (tab must be open). Document full Web Push as a follow-up in the finalize checklist.
6. CSS: reaction picker + pills, search bar + results, danger-zone. `@meowerse/ui` tokens.

Commit: `feat(meowsenger-web): reactions, in-chat search, account deletion, notifications`.

---

## Group C — audit (I run it) + note follow-ups
Reaction toggle idempotent + broadcast; search membership-gated + LIKE-safe; account delete removes
the right rows + handles owned chats; notifications only when hidden + permission granted. Add to
finalize checklist: global cross-chat search (D1 FTS mirror), full Web Push (VAPID + service worker),
per-DO message erasure on account delete.
