# meowsenger Slice 4 — reply · edit · delete · multi-select — plan

> subagent-driven. Behavior-level + key code for the DO. Gates: `test:node`+`test:do`+web
> test/lint/build green; commit per group; no push (deploy at end). DMs only (admin-delete +
> roles arrive in Slice 5 — Slice-4 delete is OWN-message only).

**Goal:** match NextMeowsenger's message actions: reply (quoted + jump-to-original), edit (own,
1h), delete (own, soft, 24h), multi-select action bar (copy + bulk-delete), per-message context
menu. Messages are in the `Conversation` DO's SQLite, so edit/delete operate there + broadcast.

**Spec:** §6 (edit/delete frames), §7 (reply/edit/delete). Windows: edit ≤1h, delete ≤24h (own).

---

## Group A — DO: schema + reply/edit/delete + alarm purge

**Files:** `workers/meowsenger/src/conversation.ts` (+ workers tests).

### Schema (DOs are not deployed yet → just extend the CREATE TABLE)
`messages (id, sender_id, body, created_at, reply_to_id TEXT, edited_at INTEGER, is_deleted INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER)`. (Fresh rooms only — no ALTER needed since nothing is live.)

### Wire shape (extend `Wire`)
`{ id, chatId, senderId, body, createdAt, replyToId?: string|null, replyTo?: {id, senderId, body}|null, editedAt?: number|null, isDeleted?: boolean }`. For a soft-deleted message, `historyFor`/broadcasts return `body:""`, `isDeleted:true` (UI shows a placeholder).

### `send` — accept `replyToId`
Validate `replyToId` (if present) references a non-deleted message in THIS room's SQLite; else ignore it (null). Store it. Build the `replyTo` snippet by looking up that message (`{id, senderId, body: truncate(120)}`). Include `replyToId` + `replyTo` in the persisted row's broadcast/ack + in `historyFor` (LEFT JOIN messages r ON m.reply_to_id = r.id → reply_sender/reply_body).

### `edit` — `{type:"edit", id, body}`
```
own = row.sender_id === att.userId; within1h = Date.now() - row.created_at <= 3600_000;
if (!row || row.is_deleted || !own || !within1h) → ws.send({type:"error", code:"cannot_edit"}); return;
body validated (trim, ≤4000). UPDATE messages SET body=?, edited_at=? WHERE id=?;
broadcast {type:"edited", id, body, editedAt} to ALL (incl. sender, so multi-tab syncs).
```

### `delete` — `{type:"delete", id}`
```
own = row.sender_id === att.userId; within24h = Date.now() - row.created_at <= 24*3600_000;
if (!row || row.is_deleted || !own || !within24h) → error code:"cannot_delete"; return;
UPDATE messages SET is_deleted=1, deleted_at=?, body='' WHERE id=?;
broadcast {type:"deleted", id} to ALL.
this.ctx.storage.setAlarm(Date.now() + 24*3600_000 + 60_000);  // schedule hard purge
```

### `alarm()` — hard purge
`DELETE FROM messages WHERE is_deleted=1 AND deleted_at < Date.now() - 24*3600_000`. (Auto-reclaims DO SQLite space; no VACUUM — spec §9.) Re-arm the alarm if any soft-deleted rows remain.

### Tests (workers pool)
reply (send with replyToId → ack/broadcast carry replyTo snippet; bad replyToId ignored); edit (own within 1h ok + `edited` broadcast + editedAt set; not-own → error; >1h → error [insert a row with old created_at via runInDurableObject]); delete (own → is_deleted + `deleted` broadcast + body cleared; historyFor returns isDeleted+body:""); alarm purge (soft-delete an old row, run alarm via `runDurableObjectAlarm`, row gone). Keep node tests green.

Commit: `feat(meowsenger): DO reply + edit(1h) + delete(24h soft) + alarm purge`.

---

## Group B — UI: reply/edit/delete/multi-select/context-menu

**Files:** `apps/meowsenger-web/src/components/{Chat,MessageItem?,Composer}.tsx`, `src/lib/chat.ts` (Message type + frames), `styles/app.css`.

- **Message type + frames:** add `replyToId`/`replyTo`/`editedAt`/`isDeleted` to `Message`; handle `edited` (update body+editedAt in place) + `deleted` (mark isDeleted, blank body) in `applyFrame`.
- **Reply:** a "reply" action per message sets `replyingTo` state; Composer shows a "replying to <name>: <preview>" chip (dismissable); send includes `replyToId`. Bubbles with a reply render a **quoted preview** (reply-to sender + truncated body) above the body; clicking it **jumps to the original** — scroll to it if loaded; if not, `loadOlder` repeatedly until the id is found (cap ~10 pages), then scroll + briefly highlight (`.is-flash`).
- **Edit:** on own message ≤1h, an "edit" action → inline edit (textarea prefilled) → send `{type:"edit"}` → optimistic body update; render an "edited" tag when `editedAt`.
- **Delete:** on own message ≤24h, a "delete" action → send `{type:"delete"}`; a deleted message renders a muted "message deleted" placeholder (no actions).
- **Multi-select:** a select mode (enter via context-menu "select" or a long-press) with per-bubble checkboxes + a floating action bar: **copy** (join selected bodies to clipboard) + **delete** (bulk-delete selected OWN, ≤24h). Exit clears selection.
- **Context menu:** right-click / long-press a message → menu with reply / edit (own≤1h) / delete (own≤24h) / select / copy. Position near the pointer; close on outside-click/Esc.
- Keep the existing optimistic-send, infinite-scroll, presence/typing/read logic intact. Style with `@meowerse/ui` tokens (quoted preview = left green border + muted; context menu = `mw-card` popover).

Commit: `feat(meowsenger-web): reply, edit, delete, multi-select, context menu`.

---

## Group C — correctness audit (I run it)
vs NextMeowsenger: reply jump loads-until-found + highlights; edit window enforced server-side (not just UI-hidden); delete permission (own only this slice) + placeholder; multi-select copy/bulk; context-menu actions gated by ownership/window. Fix findings.
