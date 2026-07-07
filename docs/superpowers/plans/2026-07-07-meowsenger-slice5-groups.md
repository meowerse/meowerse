# meowsenger Slice 5 — groups · roles · member management · visibility/slug fields — plan

> subagent-driven. Behavior-level + explicit authz rules (security-critical). Gates:
> `test:node`+`test:do`+web test/lint/build green; commit per group; no push (deploy at end).
> Discovery of PUBLIC groups/channels (slug pages, gated preview, join/request) = Slice 6; this
> slice stores `visibility`+`slug` and builds groups + roles + member mgmt.

**Goal:** named group chats, roles OWNER/ADMIN/MEMBER with enforced permissions, member management
(add/promote/demote/remove/leave), admin message-delete, and the `visibility`/`slug` fields. Group
messages render per-sender (name + avatar), unlike DMs.

**Spec:** §7 (groups, roles, member drawer, new-chat modal) + §13 slice 5 (visibility + slug).

---

## Data model (D1)
`chats` gains: `visibility TEXT NOT NULL DEFAULT 'private'` (`public`|`private`), `slug TEXT UNIQUE`
(nullable; validated `^[a-z0-9-]{3,32}$` via `slugify` from `@meowerse/ts-shared`). `chat_members.role`
already exists (`owner`|`admin`|`member`). Add these columns to `schema.sql` (additive; apply at
deploy — `IF NOT EXISTS` won't ALTER, so use `ALTER TABLE chats ADD COLUMN ...` guarded, OR since
this is pre-launch, edit the CREATE TABLE — the meowsenger D1 has no real group rows yet, so just
extend the CREATE TABLE and re-run schema on deploy after dropping/recreating is NOT ok — instead
add `ALTER TABLE chats ADD COLUMN visibility ...` / `... slug ...` statements to schema.sql; D1
`--file` runs them; wrap in a way that a re-run is tolerated — D1 lacks `ADD COLUMN IF NOT EXISTS`,
so put them in a separate `schema-slice5.sql` applied once at deploy, and note it).

## Authz rules (enforce server-side on EVERY mutation — never trust the client)
Roles: **owner** > **admin** > **member**. For a chat with actor role `A` acting on target `T`:
- **create group:** creator = `owner`. Initial members added as `member`.
- **add member:** `A ∈ {owner, admin}`. New member = `member`.
- **remove member:** `A ∈ {owner, admin}`; cannot remove `owner`; an admin cannot remove another admin (only owner can); anyone can remove self via **leave**.
- **promote member→admin:** `A = owner`. **demote admin→member:** `A = owner`.
- **leave:** anyone; if the owner leaves, transfer ownership to the oldest admin, else oldest member, else delete the chat (last member).
- **delete message:** sender within 24h (Slice 4) **OR** `A ∈ {owner, admin}` (any message, any time) — this slice extends the DO delete handler.
- **change name/visibility/slug:** `A ∈ {owner, admin}`.
Helper `requireRole(db, chatId, userId, min)` → boolean; every handler checks it and returns 403 otherwise.

---

## Group A — backend: groups, roles, member mgmt, DO admin-delete

**Files:** `workers/meowsenger/src/{chats.ts, members.ts (new), chatapi.ts, conversation.ts, index.ts, security helpers}` (+ tests).

1. **`chats.ts`:** `createGroup(db, {name, creatorId, memberIds, visibility, slug}, now)` (INSERT chat type='group' + owner + members; validate slug unique). `getRole(db, chatId, userId)` → role|null. `listMembers(db, chatId)` → `[{userId, username, displayName, avatarUrl, role, joinedAt}]` (JOIN users). `setVisibility`/`setSlug`/`renameChat`. `slugAvailable(db, slug)`.
2. **`members.ts` (new):** `addMember`, `removeMember`, `promote`, `demote`, `leave` — each takes `(db, chatId, actorId, targetId?)`, enforces the authz rules above (via `getRole`), returns `{ok}|{error}`. `leave` handles owner-transfer/chat-delete.
3. **`chatapi.ts` / `index.ts` routes:**
   - `POST /api/chats` — extend: `{type:"group", name, members:[usernames], visibility?, slug?}` → `createGroup`. (Keep the DM path.)
   - `GET /api/chats/:id/members` → `listMembers` (members only).
   - `POST /api/chats/:id/members` `{username}` (add), `DELETE /api/chats/:id/members/:userId` (remove), `POST /api/chats/:id/members/:userId/role` `{role}` (promote/demote), `POST /api/chats/:id/leave`.
   - `PATCH /api/chats/:id` `{name?, visibility?, slug?}` (owner/admin).
   - `GET /api/slug-available?slug=` → `{available:boolean}`.
   All gated by `getRole` per the authz table; return 403 on violation, 404 on missing.
4. **DO admin-delete:** the router's `handleWs` already forwards `?user=&chat=`; add **`?role=<role>`** (query `getRole` in handleWs). In `conversation.ts` store `role` in the socket Attach; `handleDelete` allows when `own && within24h` **OR** `att.role ∈ {owner, admin}` (drop the window for admins). Edit stays own-only (even admins don't edit others' text). `historyFor`/messages unchanged.
5. **Tests:** node — createGroup, each authz rule (owner-only promote, admin-can't-remove-admin, owner-leave transfers, last-member-leave deletes, slug uniqueness), listMembers shape; workers — DO admin-delete (a socket with role=admin deletes a peer's message → `deleted` broadcast; a member cannot). Keep coverage ≥90% + existing tests green.

Commit: `feat(meowsenger): groups + roles + member management + admin-delete`.

---

## Group B — frontend: group create, member drawer, group rendering

**Files:** `apps/meowsenger-web/src/components/{Chat, ChatSidebar, NewChatModal (new), MemberDrawer (new), MessageItem}.tsx`, `src/lib/chat.ts`, `styles/app.css`.

1. **New-chat modal** (replace the inline username input): tabs **Direct** | **Group**. Group tab: name, member picker (username search → add chips), visibility toggle (public/private), optional slug (with live `/api/slug-available` check + `slugify` normalization). Create → open the group.
2. **Sidebar:** render groups (group name + a group avatar/initials; DMs unchanged). `ChatSummary` gains `type`, `name`, `memberCount?`.
3. **Group message rendering:** in a group, each message shows the **sender's name + avatar** (not the DM peer). Chat.tsx fetches `GET /api/chats/:id/members` on opening a group → a `Map<userId, {name, avatar}>`; MessageItem uses it for non-own messages. (DMs keep the peer shortcut.)
4. **Member drawer:** open from the group header → list members with roles; owner/admin see actions (add member, promote/demote, remove) gated by the caller's role; everyone sees "leave". Wire to the REST endpoints; refresh on change.
5. **Header:** group shows name + member count + (for owner/admin) a settings affordance (rename, visibility, slug) → `PATCH`.
6. CSS: modal tabs, member picker chips, member drawer rows + role badges, group avatar. `@meowerse/ui` tokens.

Commit: `feat(meowsenger-web): group creation, member management drawer, group message rendering`.

---

## Group C — correctness audit (I run it)
Adversarial vs the authz table: try every forbidden action (member promoting, admin removing owner, non-member acting), owner-leave transfer + last-member-leave delete, admin-delete in the DO, slug uniqueness/validation. Fix findings.
