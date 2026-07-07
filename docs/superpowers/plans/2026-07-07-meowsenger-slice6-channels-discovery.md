# meowsenger Slice 6 — channels + shared public discovery — plan

> subagent-driven. Gates: worker `test`+web `test/lint/build` green; commit per group; no push.
> Builds on Slice 5 (groups, roles, visibility/slug already stored).

**Goal:** CHANNEL type (broadcast — only owner/admin post; everyone else subscribes). Uniform
public discovery for BOTH groups and channels: public chats are reachable at `/g/<slug>` (groups)
/ `/c/<slug>` (channels) with a gated preview (join/subscribe/request CTA); private chats show a
lock screen. Open-join for public chats; subscribe/unsubscribe for channels.

**Spec:** §13 slice 6 (channels + shared visibility/discovery). Roles/visibility/slug exist (Slice 5).

---

## Group A — backend: channels, posting rule, discovery, join

**Files:** `workers/meowsenger/src/{chats.ts, chatapi.ts, conversation.ts, index.ts}` (+ tests).

1. **Create channel:** `POST /api/chats` accepts `{type:"channel", name, visibility?, slug?, members?}`. Creator = owner. (Reuse `createGroup` generalized to a `type` param, or a `createChannel`.)
2. **Channel posting rule (DO):** the router `handleWs` already forwards `?user=&chat=&role=`; add **`?type=<direct|group|channel>`** (from the chats row). DO stores `type` in Attach. In `webSocketMessage` `send`: if `att.type==='channel' && att.role==='member'` → `ws.send({type:"error", code:"read_only"})`, no post. Owner/admin post normally. (Groups + DMs unchanged.)
3. **Discovery endpoint:** `GET /api/chats/by-slug/:slug` → resolve the chat by slug; if not found or `visibility!=='public'` and caller not a member → for public: return public preview `{id, type, name, memberCount, visibility, isMember}`; for private+non-member: `{error:"private"}` (404-ish, no leak beyond existence). If caller IS a member, also allow it (return `isMember:true`). Public preview must NOT leak messages.
4. **Join / subscribe:** `POST /api/chats/:id/join` — only for `visibility==='public'` chats (open join); adds caller as `member` (idempotent). `POST /api/chats/:id/subscribe` = alias for channels. (Leave/unsubscribe = the existing `leave`.) Private chats → 403 (must be invited/request — Slice 7).
5. **listChats:** already returns type/name; ensure channels render (posting-disabled handled in UI via role).
6. **Tests:** node — create channel; channel member send blocked at DO (workers pool: `role=member type=channel` send → `read_only`; owner send ok); by-slug preview (public returns preview, private+non-member → private error, member ok); join public (adds member; join private → 403). Keep ≥90% + existing green.

Commit: `feat(meowsenger): channels (broadcast) + public discovery + open-join`.

---

## Group B — frontend: channel create, discovery pages, gated preview, channel view

**Files:** `apps/meowsenger-web/src/{lib/chat.ts, components/{NewChatModal, Chat, ChatSidebar, ChannelPreview(new)}.tsx, pages/g/[slug].astro (new), pages/c/[slug].astro (new)}`, `styles/app.css`.

1. **lib:** `getBySlug(base, slug)`, `joinChat(base, chatId)`, `createChannel(base, {...})`. Extend types.
2. **New-chat modal:** add a **Channel** tab (name, visibility, slug, initial members optional) — like the Group tab but creates a channel; explain "only admins post."
3. **Discovery pages** `pages/g/[slug].astro` + `pages/c/[slug].astro` — server-render nothing sensitive; a `ChannelPreview` island fetches `getBySlug(slug)`:
   - not found / private + not member → a "private or not found" lock card.
   - public + not member → preview card (name, type, member count) + **Join** (groups) / **Subscribe** (channels) button → `joinChat` → redirect into `/app` with the chat open (`?chat=<id>` or client nav).
   - member → redirect straight into the chat.
4. **Channel view in Chat.tsx:** for a channel where the caller's role is `member`, hide the Composer and show a "subscribed — only admins post" note; owner/admin get the Composer. Sidebar shows channels with a broadcast glyph.
5. **CSS:** preview/lock cards, channel glyph, read-only note. `@meowerse/ui` tokens.

Commit: `feat(meowsenger-web): channels, public discovery pages, gated preview`.

---

## Group C — audit (I run it)
Channel member cannot post (DO-enforced, not just UI); private chat doesn't leak via by-slug; public join works + is idempotent; discovery pages handle all 4 states (public-member, public-nonmember, private, not-found).
