# meowsenger Slice 3 — presence · typing · read-receipts · unread — plan

> Execute with subagent-driven-development. Patterns are established (Slice 2); this plan is
> behavior-level with code for the tricky parts (hibernation-safe presence). Same gates:
> `test:node` + `test:do` + web `test`/`lint`/`build` all green; commit per group; no push (deploy at end).

**Goal:** live presence (online dot), typing indicators, read receipts ("seen"), and unread
counts/badges — the things NextMeowsenger lacked. DMs (groups later).

**Spec:** design §6 (WS frames: `typing`/`presence`/`read`→`read_receipt`) + §7 (read receipts + unread, typing + presence).

---

## WS protocol added (client→server / server→client)
- C→S `{type:"typing", on:boolean}` → S→peers `{type:"typing", userId, on}` (in-memory, not persisted).
- C→S `{type:"read", upTo:number}` (createdAt of the newest seen msg) → update D1 last_read_at + reset unread; S→peers `{type:"read_receipt", userId, upTo}`.
- On connect: DO sends the new socket `{type:"presence_snapshot", online:string[]}` (currently-online userIds) and broadcasts `{type:"presence", userId, online:true}`. On last socket for a user closing: broadcast `{type:"presence", userId, online:false}`.

---

## Group A — DO presence/typing/read (backend)

**Files:** `workers/meowsenger/src/conversation.ts`, `src/chats.ts` (+ tests).

### Task A1 — hibernation-safe presence (the tricky part)
Presence MUST derive from `ctx.getWebSockets()` (survives eviction), never an in-memory Map.

Helper on the DO:
```ts
/** distinct userIds with ≥1 live socket, optionally excluding one socket (a closing one). */
private onlineUsers(except?: WebSocket): string[] {
  const s = new Set<string>();
  for (const ws of this.ctx.getWebSockets()) {
    if (ws === except) continue;
    const a = ws.deserializeAttachment() as { userId?: string } | null;
    if (a?.userId) s.add(a.userId);
  }
  return [...s];
}
private broadcast(obj: unknown, except?: WebSocket) {
  const text = JSON.stringify(obj);
  for (const ws of this.ctx.getWebSockets()) if (ws !== except) ws.send(text);
}
```

In `fetch()` (after `acceptWebSocket` + attach + the `ready` frame): compute `const before = this.onlineUsers(server)` (users online BEFORE this socket). Send the snapshot to the new socket: `server.send(JSON.stringify({type:"presence_snapshot", online: before}))`. If this user wasn't already online (`!before.includes(userId)`), broadcast `{type:"presence", userId, online:true}` to the others.

In `webSocketClose(ws, ...)`: read the closing socket's `userId` from its attachment; after handling, if `this.onlineUsers(ws)` (excluding the closing socket) does NOT include that userId, `this.broadcast({type:"presence", userId, online:false}, ws)`.

### Task A2 — typing + read in `webSocketMessage`
Extend the `msg.type` switch (keep `send`):
- `typing`: `this.broadcast({type:"typing", userId: att.userId, on: !!msg.on}, ws)` (peers only; no persist).
- `read`: `const upTo = Number(msg.upTo)||0;` `this.ctx.waitUntil(markRead(this.d1(), att.chatId, att.userId, upTo).catch(()=>{}))`; `this.broadcast({type:"read_receipt", userId: att.userId, upTo}, ws)`.

`src/chats.ts` — add:
```ts
/** Mark a chat read up to a timestamp for one member: clear unread + set last_read_at. */
export async function markRead(db: DbClient, chatId: string, userId: string, upTo: number): Promise<void> {
  await db.run("UPDATE chat_members SET unread_count = 0, last_read_at = ? WHERE chat_id = ? AND user_id = ?", [upTo, chatId, userId]);
}
```
Note the DO's `d1()` adapter currently stubs `all`/`first` and implements `run` — `markRead` only needs `run`, fine.

### Task A3 — DO workers-pool tests
Add cases: two sockets → connecting the 2nd makes the 1st receive `{presence, online:true}` + the 2nd receives `{presence_snapshot}` including user1; `typing` frame reaches the peer not the sender; `read` frame → peer gets `read_receipt` AND (poll) D1 `chat_members.unread_count`=0/`last_read_at`=upTo. Keep node tests green (chats.markRead unit test with fake db).

Commit: `feat(meowsenger): DO presence + typing + read-receipts (hibernation-safe)`.

---

## Group B — frontend (presence/typing/receipts/unread)

**Files:** `apps/meowsenger-web/src/components/Chat.tsx`, `ChatSidebar.tsx`, `src/lib/chat.ts`, `styles/app.css`.

### Task B1 — Chat.tsx frames + sending
- Handle new frames in `applyFrame`: `presence_snapshot` (set an `online:Set<string>`), `presence` (add/remove userId), `typing` (set `peerTyping` with a ~5s auto-clear timer), `read_receipt` (track peer's `lastReadAt = max(prev, upTo)`).
- **Send typing:** in Composer/onChange, debounce — send `{type:"typing", on:true}` on first keystroke, `{on:false}` after 4s idle or on send/blur.
- **Send read:** when the active chat's log is at/near bottom AND there are messages, send `{type:"read", upTo: newestCreatedAt}` (on new message received while focused, on open, on scroll-to-bottom). Also reset the local sidebar unread for that chat to 0.
- **Render:** peer online dot on the header Avatar (green when `online.has(peerId)`); "typing…" line under the header when `peerTyping`; on my own last message, a "seen" tick when `peerLastReadAt >= message.createdAt`.
- Need the peer's userId: add it to `ChatSummary` if not present (DM peer id) — the list already joins the peer; ensure `peerId` is returned (add to `listChats` select + type). Small backend tweak.

### Task B2 — sidebar unread + live refresh
- `ChatSidebar` shows an unread badge (`unreadCount`) per chat; bold the row when unread>0.
- **Live-ish sidebar:** in Chat.tsx, refresh `listChats` on `window` focus + a 15s interval while visible (covers background-chat unread; the spec's v1 simplification — no per-user inbox DO yet). Opening a chat optimistically zeroes its badge.
- Style the badge + online dot + typing line with `@meowerse/ui` tokens.

Commit: `feat(meowsenger-web): presence, typing, read receipts, unread badges`.

---

## Group C — correctness audit (per the user's request)
Adversarial review vs spec + NextMeowsenger: presence toggles correctly across connect/disconnect (incl. multi-tab — same user two sockets shouldn't flap offline when one closes), typing TTL, read-receipt timing, unread reset races. Apply fixes. (I run this after B.)
