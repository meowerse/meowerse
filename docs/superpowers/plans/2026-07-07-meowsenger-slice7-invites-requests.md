# meowsenger Slice 7 — invite links/codes · join requests · auto-invite/privacy — plan

> subagent-driven. Gates green; commit per group; no push. Builds on Slices 5–6 (groups/channels,
> roles, visibility/slug, public open-join).

**Goal:** invite links (12-char code → `/join?invite=<code>` direct-join, bypasses private), join
requests for private discoverable chats (request → owner/admin approve/reject), auto-invite when
adding a user who opted out of auto-add (`allow_auto_group_add`), and that privacy toggle.

**Spec:** §13 slice 7. NextMeowsenger: invite codes + `/join/<code>` preview, join requests
(pending tab, approve/reject), auto-invite-on-add + `allowAutoGroupAdd` opt-out.

---

## Data model (D1)
- `chats.invite_code TEXT` (nullable, unique) + `invite_enabled INTEGER DEFAULT 1` — or a separate
  `invite_codes` table; simplest = a column on `chats` (one active code per chat, refreshable).
- `join_requests (id TEXT PK, chat_id, user_id, status TEXT DEFAULT 'pending', created_at, UNIQUE(chat_id,user_id))`.
- `users.allow_auto_group_add INTEGER NOT NULL DEFAULT 1`.
- Put the ALTERs in `schema-slice7.sql` (applied once at deploy) + add columns to the CREATE TABLEs in `schema.sql`.

---

## Group A — backend
**Files:** `workers/meowsenger/src/{chats.ts, members.ts, invites.ts (new), chatapi.ts, index.ts, users.ts}` (+ tests).

1. **Invite code:** `getOrCreateInvite(db, chatId, actorId)` (owner/admin → 12-char code via `randomId`), `refreshInvite` (new code, invalidates old), `revokeInvite`. `resolveInvite(db, code)` → `{chatId, type, name, memberCount}` or null. `joinByInvite(db, code, userId)` → adds member (bypasses visibility; idempotent). Routes: `POST /api/chats/:id/invite` (create/refresh), `DELETE /api/chats/:id/invite` (revoke), `GET /api/invite/:code` (preview), `POST /api/invite/:code/accept` (join). Authz: create/refresh/revoke = owner/admin.
2. **Join requests:** `requestJoin(db, chatId, userId)` — only for `visibility==='public'`... no: public is open-join. Requests are for **private** chats that are discoverable (have a slug) OR reachable by preview. Model: a non-member with the chat's slug/link but no invite can `POST /api/chats/:id/request` → creates a pending `join_request` (idempotent; already-member → 400). `listRequests(db, chatId, actorId)` (owner/admin) → pending list w/ user info. `approveRequest`/`rejectRequest(db, chatId, requestId, actorId)` (owner/admin) → approve adds member + marks approved; reject marks rejected. Routes: `POST /api/chats/:id/request`, `GET /api/chats/:id/requests`, `POST /api/chats/:id/requests/:rid/approve|reject`.
   - Update `getPreviewBySlug` (Slice 6): for a **private** discoverable chat, instead of a blanket `{error:"private"}`, if the chat is discoverable-but-private return a preview with `canRequest:true` + the caller's request status (none|pending) so the UI can show "request access"/"requested". (Keep truly-hidden/unknown → `private`. Decide: a private chat with a slug is "discoverable but gated" → allow the request preview; a private chat with NO slug stays fully hidden.)
3. **Privacy + auto-invite:** `users.allow_auto_group_add`; `GET/POST /api/account/privacy` (get/set). In `addMember`: if the target has `allow_auto_group_add=0`, DON'T add them — instead create a join invite/notification: create (or open) a DM from the actor to the target and post a system message with the invite link, and return `{ok:true, invited:true}` (not added). (Simplest: return `invited:true` + the invite link; the UI/actor shares it. Or auto-post to a DM — pick the DM-with-link approach to match NextMeowsenger.)
4. **Tests:** invite create/refresh/revoke (authz), resolve + accept (join bypasses private, idempotent), request flow (create pending, list as admin, approve adds member, reject, non-admin can't list/approve), preview canRequest + status, auto-invite when target opted out (not added, invited:true), privacy get/set. Keep ≥90% + existing green.

Commit: `feat(meowsenger): invite codes + join requests + auto-invite/privacy`.

---

## Group B — frontend
**Files:** `apps/meowsenger-web/src/{lib/chat.ts, components/{MemberDrawer, ChannelPreview, NewChatModal, Settings(new?)}.tsx, pages/join.astro}`, `styles/app.css`.

1. **lib:** invite create/refresh/revoke/getInvite, `getInviteByCode`, `acceptInvite`, `requestJoin`, `getRequests`, `approve/rejectRequest`, `getPrivacy/setPrivacy`.
2. **Member drawer:** an "invite link" section (owner/admin) — show/copy the link (`/join?invite=<code>`), refresh, revoke. A **Requests tab** (owner/admin) listing pending requests with approve/reject; a badge on the drawer button when pending>0.
3. **`/join` discovery (ChannelPreview):** handle `?invite=<code>` → `getInviteByCode` preview → **Accept invite** → join → open. For a private discoverable chat (slug link, `canRequest`) → **Request access** button → `requestJoin`; if already `pending` → "requested" disabled state.
4. **Privacy:** a small settings surface (in the app header menu or a settings modal) with the `allow_auto_group_add` toggle. When adding a member who opted out, surface the returned invite link to the actor ("they'll need this invite link").
5. CSS: invite section, requests tab + approve/reject rows, request-access states, privacy toggle. `@meowerse/ui` tokens.

Commit: `feat(meowsenger-web): invite links, join requests, privacy toggle`.

---

## Group C — audit (I run it)
Invite bypasses private only with a valid code; revoked code fails; request→approve adds exactly once; non-admin can't approve/list; auto-invite respects the opt-out; private-no-slug stays hidden.
