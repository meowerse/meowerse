# meowsenger Slice 8 — forwarding · in-DO rate protection · polish — plan

> subagent-driven. Gates green; commit per group; no push.

**Goal:** forward selected messages to N chats (forwarded badge), a per-connection message rate
bucket in the DO (flood protection), and polish (skeletons, empty states, small a11y). Settings
(username) note: meowsenger username IS the auth identity — not editable here; link to auth's
account page instead. `allow_auto_group_add` already shipped (Slice 7).

**Spec:** §13 slice 8 + §8 (per-connection rate bucket).

---

## Group A — backend: DO appendMessage RPC + forward REST + rate bucket

**Files:** `workers/meowsenger/src/{conversation.ts, chatapi.ts, index.ts, chats.ts}` (+ tests).

1. **Refactor the send path** in `conversation.ts` into a private `insertAndBroadcast(senderId, body, opts:{replyToId?, forwarded?, tempId?, ackTo?})` used by both `webSocketMessage`'s `send` branch and a new RPC. It: monotonic created_at, INSERT (with `reply_to_id`, `is_forwarded`), build Wire (+ `isForwarded`), ack the sender if `ackTo` socket given, broadcast `message` to others, waitUntil D1 mirror. (Behavior unchanged for the WS path.)
2. **Schema:** add `messages.is_forwarded INTEGER NOT NULL DEFAULT 0` to the DO messages CREATE TABLE (fresh DOs, no migration). Wire gains `isForwarded?:boolean`; `historyFor` returns it.
3. **DO RPC `appendMessage(senderId, body, forwarded)`** → calls `insertAndBroadcast(senderId, body, {forwarded})` (no ack socket — the forwarder isn't necessarily connected to the target). Returns the created message id.
4. **Forward REST:** `POST /api/chats/:id/forward {messages:[{body}]}` → `callerId` + membership gate on the TARGET chat (`isMember`) + (channel? only owner/admin may post — reuse the channel rule via getRole/chatType) → for each message, `env.CONVERSATION.get(idFromName(targetId)).appendMessage(me, body, true)`. Cap N (e.g. ≤20 messages, ≤10 targets is a UI concern; server caps messages length + count). Returns `{forwarded:count}`.
5. **In-DO rate bucket:** an in-memory `Map<WebSocket, number[]>` of recent send timestamps (in-memory is fine — a flood keeps the DO awake; idle hibernates with no flood). In the `send` branch, before insert: prune timestamps older than 10s; if ≥ `RATE_MAX` (e.g. 30) → `ws.send({type:"error", code:"rate_limited"})` + return; else push now. (Applies to `send` only; typing/read are cheap + separate.)
6. **Tests:** forward REST (member forwards into a target → appears in target historyFor with `isForwarded:true`; non-member → 403; channel member → 403/read_only); DO appendMessage RPC; rate bucket (spam >RATE_MAX sends in 10s → `rate_limited` error, message not persisted); is_forwarded round-trips. Keep all green ≥90%.

Commit: `feat(meowsenger): forward messages + in-DO rate limit + is_forwarded`.

---

## Group B — frontend: forward modal + badge + polish

**Files:** `apps/meowsenger-web/src/{lib/chat.ts, components/{Chat, ForwardModal(new), MessageItem, ChatSidebar}.tsx, styles/app.css}`.

1. **lib:** `forwardMessages(base, targetId, bodies)`. (Handle the `rate_limited` frame → toast.)
2. **Forward modal:** from multi-select (or a single message's context menu "forward") → a modal listing the user's chats (searchable) with multi-select targets → "forward" → `forwardMessages` to each selected target → toast "forwarded to N chats". Exits select mode.
3. **Forwarded badge:** `MessageItem` shows a small "forwarded" tag when `isForwarded`.
4. **Polish:** loading skeletons for the sidebar list + message log (shimmer rows) while loading; empty states (no chats → friendly prompt; empty conversation → "say hi"); ensure the context menu + drawers are keyboard-accessible (Esc, focus) — most exist, fill gaps; `rate_limited` + other error toasts styled.
5. CSS: forward modal, forwarded tag, skeleton shimmer, empty states. `@meowerse/ui` tokens.

Commit: `feat(meowsenger-web): forward modal, forwarded badge, skeletons/empty-state polish`.

---

## Group C — audit (I run it)
Forward gated by target membership + channel rule; rate bucket drops floods without disconnect;
forwarded badge; skeletons/empty states present; no regressions in reply/edit/delete/multi-select.
