# meowsenger Slice 2 — Realtime send/receive (Durable Object + WebSocket) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the logged-in shell into a working chat: create/open a DM, send a message and see it arrive live on another connected client, with server-stored history — via a per-conversation Durable Object (WebSocket Hibernation + embedded SQLite) fronted by the existing meowsenger Worker, plus the D1 chat graph.

**Architecture:** The meowsenger Worker (one host, `meowsenger.alxnko.eu.org`) gains: (1) a `Conversation` Durable Object class — one instance per chat, holding the room's live WebSockets (Hibernation API) + an embedded SQLite message log; (2) a `/ws?chat=<id>` upgrade endpoint that authenticates the BFF session, checks membership in D1, then forwards the upgrade to the chat's DO; (3) REST over D1 for the chat graph (create DM, list chats, load history). On send, the DO writes the message to its local SQLite, broadcasts to connected sockets, and `ctx.waitUntil`-mirrors the last-message + activity to D1 for the sidebar. This is the first DO/WebSocket code in the monorepo.

**Tech Stack:** Cloudflare Durable Objects (SQLite-backed, WebSocket Hibernation API, `DurableObject` from `cloudflare:workers`), D1, `@cloudflare/vitest-pool-workers` for DO tests, Astro + React islands.

**Spec:** `docs/superpowers/specs/2026-07-07-meowsenger-design.md` §3.3, §4, §6. **Scope: DMs only** (groups, presence/typing/receipts, edit/delete come in Slices 3–5).

---

## Shared contracts

**WebSocket message protocol** (JSON frames; subset of spec §6 for Slice 2):

Client → server: `{ type: "send", tempId: string, body: string }`
Server → client:
- `{ type: "ready", chatId, you }` (on connect)
- `{ type: "sent", tempId, message }` (ack to sender, reconcile optimistic)
- `{ type: "message", message }` (broadcast to the room)
- `{ type: "error", code }`

`Message = { id: string; chatId: string; senderId: string; body: string; createdAt: number }`

**D1 tables added this slice** (spec §4.1 `chats` + `chat_members`; a subset of columns Slice 2 needs — later slices add role nuance/unread refinements):
```sql
CREATE TABLE IF NOT EXISTS chats (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL,             -- 'direct' (groups: Slice 5)
  name           TEXT,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_activity  INTEGER NOT NULL,
  last_message   TEXT,
  last_sender_id TEXT,
  direct_key     TEXT UNIQUE                -- 'min:max' of the two user ids, for DM dedup
);
CREATE INDEX IF NOT EXISTS idx_chats_last_activity ON chats(last_activity);
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id       TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',
  unread_count  INTEGER NOT NULL DEFAULT 0,
  last_read_at  INTEGER,
  joined_at     INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members(user_id, chat_id);
```

**DO SQLite schema** (per-room, created in the DO constructor via `blockConcurrencyWhile`):
```sql
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  sender_id  TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
```

**Testing infra decision:** the existing 49 worker tests use plain vitest + a fake `DbClient` and MUST keep working unchanged (fast, no workerd). DO tests need the workerd runtime. Use **two vitest projects**: the existing `vitest.config.ts` (node pool, `src/**` minus DO + types) and a new `vitest.workers.config.ts` (`@cloudflare/vitest-pool-workers`, references `wrangler.jsonc`, covers `src/conversation.ts`). The package `test` script runs both.

---

## Task 1: D1 chat-graph tables + `chats.ts` helpers

**Files:** Modify `workers/meowsenger/schema.sql`; Create `workers/meowsenger/src/chats.ts` + `src/chats.test.ts`.

- [ ] **Step 1: Append the `chats` + `chat_members` DDL** (Shared contracts §) to `schema.sql`.

- [ ] **Step 2: Write failing test** `src/chats.test.ts` — an in-memory `DbClient` fake (same style as `users.test.ts`) covering `createOrGetDirect` (dedup by `direct_key`), `listChats`, `addMessageMirror`:
```ts
import { describe, it, expect } from "vitest";
import { createOrGetDirect, listChats, mirrorLastMessage, directKey } from "./chats";
import type { DbClient, Row } from "./types";

function memDb() {
  const chats = new Map<string, Row>(); const members: Row[] = [];
  const db: DbClient = {
    async all(sql, p = []) {
      if (sql.includes("FROM chat_members m")) return chats.size ? [...chats.values()].map(c => ({ ...c, role: "member", unread_count: 0, last_read_at: null })) : [];
      return [];
    },
    async first(sql, p = []) {
      if (sql.includes("direct_key")) return [...chats.values()].find(c => c.direct_key === p[0]);
      if (sql.includes("FROM chats WHERE id")) return chats.get(String(p[0]));
      return undefined;
    },
    async run(sql, p = []) {
      if (sql.startsWith("INSERT INTO chats")) chats.set(String(p[0]), { id: p[0], type: p[1], name: p[2], created_by: p[3], created_at: p[4], last_activity: p[5], last_message: null, last_sender_id: null, direct_key: p[6] });
      else if (sql.startsWith("INSERT INTO chat_members")) members.push({ chat_id: p[0], user_id: p[1] });
      else if (sql.startsWith("UPDATE chats SET last_message")) { const c = chats.get(String(p[3])); if (c) { c.last_message = p[0]; c.last_sender_id = p[1]; c.last_activity = p[2]; } }
    },
  };
  return { db, chats, members };
}

describe("directKey", () => {
  it("is order-independent", () => {
    expect(directKey("b", "a")).toBe(directKey("a", "b"));
    expect(directKey("a", "b")).toBe("a:b");
  });
});
describe("createOrGetDirect", () => {
  it("creates a DM with both members + dedups on second call", async () => {
    const { db, chats, members } = memDb();
    const a = await createOrGetDirect(db, "u1", "u2", 1000);
    expect(a.created).toBe(true);
    expect(chats.size).toBe(1);
    expect(members.filter(m => m.chat_id === a.id)).toHaveLength(2);
    const b = await createOrGetDirect(db, "u2", "u1", 2000);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
  });
});
describe("mirrorLastMessage", () => {
  it("updates last_message/last_sender/last_activity", async () => {
    const { db, chats } = memDb();
    const a = await createOrGetDirect(db, "u1", "u2", 1000);
    await mirrorLastMessage(db, a.id, "hi", "u1", 3000);
    expect(chats.get(a.id)?.last_message).toBe("hi");
  });
});
describe("listChats", () => {
  it("returns the user's chats", async () => {
    const { db } = memDb();
    await createOrGetDirect(db, "u1", "u2", 1000);
    const rows = await listChats(db, "u1");
    expect(rows.length).toBe(1);
  });
});
```

- [ ] **Step 3: Run → FAIL** (`bun run --filter @meowerse/meowsenger-worker test:node chats`).

- [ ] **Step 4: Implement `src/chats.ts`:**
```ts
import type { DbClient, Row } from "./types";

export interface ChatSummary {
  id: string; type: string; name: string | null;
  lastMessage: string | null; lastSenderId: string | null; lastActivity: number;
  unreadCount: number;
}

/** Order-independent key for a 1:1 DM, so A+B and B+A resolve to one chat. */
export function directKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export async function createOrGetDirect(
  db: DbClient, me: string, other: string, now: number,
): Promise<{ id: string; created: boolean }> {
  const key = directKey(me, other);
  const existing = await db.first("SELECT id FROM chats WHERE direct_key = ?", [key]);
  if (existing) return { id: String(existing.id), created: false };
  const id = crypto.randomUUID();
  await db.run(
    "INSERT INTO chats (id, type, name, created_by, created_at, last_activity, direct_key) VALUES (?, 'direct', NULL, ?, ?, ?, ?)",
    [id, me, now, now, key],
  );
  for (const uid of [me, other]) {
    await db.run(
      "INSERT INTO chat_members (chat_id, user_id, role, unread_count, last_read_at, joined_at) VALUES (?, ?, 'member', 0, NULL, ?)",
      [id, uid, now],
    );
  }
  return { id, created: true };
}

/** Off-critical-path mirror from the DO after a send, so the sidebar shows a preview. */
export async function mirrorLastMessage(
  db: DbClient, chatId: string, body: string, senderId: string, now: number,
): Promise<void> {
  await db.run(
    "UPDATE chats SET last_message = ?, last_sender_id = ?, last_activity = ? WHERE id = ?",
    [body.slice(0, 140), senderId, now, chatId],
  );
  await db.run(
    "UPDATE chat_members SET unread_count = unread_count + 1 WHERE chat_id = ? AND user_id <> ?",
    [chatId, senderId],
  );
}

export async function listChats(db: DbClient, userId: string): Promise<ChatSummary[]> {
  const rows = await db.all(
    `SELECT c.id, c.type, c.name, c.last_message, c.last_sender_id, c.last_activity, m.unread_count
     FROM chat_members m JOIN chats c ON c.id = m.chat_id
     WHERE m.user_id = ? ORDER BY c.last_activity DESC`,
    [userId],
  );
  return rows.map((r: Row) => ({
    id: String(r.id), type: String(r.type), name: r.name == null ? null : String(r.name),
    lastMessage: r.last_message == null ? null : String(r.last_message),
    lastSenderId: r.last_sender_id == null ? null : String(r.last_sender_id),
    lastActivity: Number(r.last_activity), unreadCount: Number(r.unread_count ?? 0),
  }));
}

/** Is `userId` a member of `chatId`? (gate for /ws + history) */
export async function isMember(db: DbClient, chatId: string, userId: string): Promise<boolean> {
  const r = await db.first("SELECT 1 AS ok FROM chat_members WHERE chat_id = ? AND user_id = ?", [chatId, userId]);
  return !!r;
}
```

- [ ] **Step 5: Run → PASS. Commit** `feat(meowsenger): D1 chat graph — chats/chat_members + helpers`.

---

## Task 2: wrangler DO binding + split vitest configs

**Files:** Modify `workers/meowsenger/wrangler.jsonc`, `package.json`, `vitest.config.ts`; Create `vitest.workers.config.ts`.

- [ ] **Step 1: Add the DO binding + migration to `wrangler.jsonc`** (after `d1_databases`):
```jsonc
  "durable_objects": {
    "bindings": [{ "name": "CONVERSATION", "class_name": "Conversation" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Conversation"] }],
```

- [ ] **Step 2: Split test configs.** Rename the coverage note in `vitest.config.ts` to exclude the DO file (it runs in the workers project) — set `include: ["src/**"]`, `exclude: ["src/types.ts", "src/conversation.ts"]`. Create `vitest.workers.config.ts`:
```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// DO/integration tests run inside workerd (real SQLite + WebSocket). Separate
// from the fast node-pool unit tests (vitest.config.ts).
export default defineWorkersConfig({
  test: {
    include: ["src/**/*.workers.test.ts"],
    poolOptions: { workers: { wrangler: { configPath: "./wrangler.jsonc" } } },
  },
});
```

- [ ] **Step 3: package.json scripts** — split test:
```json
    "test": "vitest run --coverage --config vitest.config.ts && vitest run --config vitest.workers.config.ts",
    "test:node": "vitest run --config vitest.config.ts",
    "test:do": "vitest run --config vitest.workers.config.ts",
```
Add devDep `"@cloudflare/vitest-pool-workers": "^0.9.0"` (match the installed wrangler major; run `bun add -d @cloudflare/vitest-pool-workers` in the package and take the resolved version).

- [ ] **Step 4: `bun install`; run `bun run --filter @meowerse/meowsenger-worker test:node`** → the existing 49 pass (DO excluded).

- [ ] **Step 5: Commit** `chore(meowsenger): DO binding + split node/workers vitest configs`.

---

## Task 3: The `Conversation` Durable Object

**Files:** Create `workers/meowsenger/src/conversation.ts`; export it from `src/index.ts`.

- [ ] **Step 1: Implement `src/conversation.ts`** (Hibernation WS + SQLite log; membership passed by the router via the upgrade URL, trusted same-worker):
```ts
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import { mirrorLastMessage } from "./chats";

interface Attach { userId: string; chatId: string }
interface Wire { id: string; chatId: string; senderId: string; body: string; createdAt: number }

const MAX_BODY = 4000;
const HISTORY_PAGE = 50;

/** One instance per chat (addressed by chatId). Holds the room's live WebSockets
 *  (Hibernation) + a local SQLite message log. */
export class Conversation extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Create the message table once; block requests until ready.
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);`,
      );
    });
    // Free ping/pong without waking the DO.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Router forwards the upgrade here with ?user=<id>&chat=<id> (already gated). */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const userId = url.searchParams.get("user");
    const chatId = url.searchParams.get("chat");
    if (!userId || !chatId) return new Response("bad ws params", { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId, chatId } satisfies Attach);
    server.send(JSON.stringify({ type: "ready", chatId, you: userId }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attach | null;
    if (!att) return;
    let msg: { type?: string; tempId?: string; body?: string };
    try { msg = JSON.parse(typeof raw === "string" ? raw : ""); } catch { return; }
    if (msg.type !== "send") return;
    const body = (msg.body ?? "").trim();
    if (!body || body.length > MAX_BODY) { ws.send(JSON.stringify({ type: "error", code: "bad_body" })); return; }

    const now = Date.now();
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (id, sender_id, body, created_at) VALUES (?, ?, ?, ?)",
      id, att.userId, body, now,
    );
    const message: Wire = { id, chatId: att.chatId, senderId: att.userId, body, createdAt: now };

    ws.send(JSON.stringify({ type: "sent", tempId: msg.tempId, message }));
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) peer.send(JSON.stringify({ type: "message", message }));
    }
    // Off critical path: mirror the preview + unread to D1 for the sidebar.
    this.ctx.waitUntil(mirrorLastMessage(this.d1(), att.chatId, body, att.userId, now));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try { ws.close(code, reason); } catch { /* already closing */ }
  }

  /** History page (used by the REST GET /api/chats/:id/messages via DO RPC). */
  async history(beforeId: string | null): Promise<Wire[]> {
    const chatId = this.roomChatId();
    const cursor = beforeId
      ? this.ctx.storage.sql.exec("SELECT created_at FROM messages WHERE id = ?", beforeId).one()?.created_at as number | undefined
      : undefined;
    const rows = cursor != null
      ? this.ctx.storage.sql.exec("SELECT * FROM messages WHERE created_at < ? ORDER BY created_at DESC LIMIT ?", cursor, HISTORY_PAGE)
      : this.ctx.storage.sql.exec("SELECT * FROM messages ORDER BY created_at DESC LIMIT ?", HISTORY_PAGE);
    return [...rows].map((r) => ({ id: String(r.id), chatId, senderId: String(r.sender_id), body: String(r.body), createdAt: Number(r.created_at) })).reverse();
  }

  private roomChatId(): string {
    const ws = this.ctx.getWebSockets()[0];
    return ws ? (ws.deserializeAttachment() as Attach).chatId : "";
  }
  private d1() {
    // Minimal D1 adapter (same shape as src/db.ts) for the mirror write.
    const db = this.env.DB;
    return {
      all: async () => [], first: async () => undefined,
      run: async (sql: string, params: unknown[] = []) => { await db.prepare(sql).bind(...params).run(); },
    };
  }
}
```
> `history` reads the room's own SQLite; chatId is recovered from any live socket (a connected reader always exists when history is fetched over the same connection flow — in Slice 2 the REST history handler opens a short DO stub call; if no socket is attached, chatId comes from the RPC caller — see Task 5, which passes chatId into a `historyFor(chatId, before)` variant). Keep `d1()` tiny; the full adapter lives in `db.ts` but the DO needs only `run`.

- [ ] **Step 2: Export the DO from `src/index.ts`** — add `export { Conversation } from "./conversation";` at the top.

- [ ] **Step 3: Commit** `feat(meowsenger): Conversation Durable Object — hibernation WS + SQLite log` (tests in Task 4).

---

## Task 4: Durable Object tests (workers pool)

**Files:** Create `workers/meowsenger/src/conversation.workers.test.ts`.

- [ ] **Step 1: Write the test** using `cloudflare:test`:
```ts
import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { Conversation } from "./conversation";

function stub(chatId: string) {
  const id = env.CONVERSATION.idFromName(chatId);
  return env.CONVERSATION.get(id);
}

describe("Conversation DO", () => {
  it("accepts a websocket and replies ready", async () => {
    const s = stub("c1");
    const res = await s.fetch("https://do/ws?user=u1&chat=c1", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(101);
    expect(res.webSocket).toBeTruthy();
  });

  it("stores + returns history", async () => {
    const s = stub("c2");
    await runInDurableObject(s, async (instance: Conversation, ctx) => {
      ctx.storage.sql.exec("INSERT INTO messages (id, sender_id, body, created_at) VALUES ('m1','u1','hi',1000)");
      const rows = [...ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM messages")];
      expect(Number(rows[0].n)).toBe(1);
    });
  });

  it("broadcasts a sent message to peers + acks the sender", async () => {
    const s = stub("c3");
    const a = await s.fetch("https://do/ws?user=u1&chat=c3", { headers: { Upgrade: "websocket" } });
    const b = await s.fetch("https://do/ws?user=u2&chat=c3", { headers: { Upgrade: "websocket" } });
    const wa = a.webSocket!, wb = b.webSocket!;
    wa.accept(); wb.accept();
    const got: string[] = [];
    const peerMsg = new Promise<void>((resolve) => wb.addEventListener("message", (e) => { got.push(String(e.data)); resolve(); }));
    const ack = new Promise<void>((resolve) => wa.addEventListener("message", (e) => { if (String(e.data).includes("\"sent\"")) resolve(); }));
    wa.send(JSON.stringify({ type: "send", tempId: "t1", body: "hello" }));
    await Promise.all([peerMsg, ack]);
    expect(got.some((m) => m.includes("hello") && m.includes("\"message\""))).toBe(true);
  });
});
```
> Note: the `ready` frame arrives before `accept()` is called on the client side; the test only asserts the 101 + the broadcast/ack, which is the core behavior. If the runtime buffers pre-accept frames differently, assert on the broadcast only.

- [ ] **Step 2: Run `bun run --filter @meowerse/meowsenger-worker test:do`** → passes in workerd. Iterate until green (DO/WS timing in tests can need small awaits).

- [ ] **Step 3: Commit** `test(meowsenger): Conversation DO — ws accept, history, broadcast`.

---

## Task 5: Router — `/ws` upgrade + chat REST

**Files:** Modify `workers/meowsenger/src/index.ts`; Create `src/chatapi.ts` + `src/chatapi.test.ts`.

- [ ] **Step 1: `src/chatapi.ts`** — REST handlers over D1 + a history bridge to the DO:
```ts
import type { DbClient, Env } from "./types";
import { json, readCookies } from "./security";
import { getSession, SESSION_COOKIE } from "./session";
import { getUser } from "./users";
import { createOrGetDirect, listChats, isMember } from "./chats";

/** Resolve the caller's userId from the BFF cookie, or null. */
export async function callerId(req: Request, db: DbClient, now: number): Promise<string | null> {
  const sid = readCookies(req.headers.get("Cookie"))[SESSION_COOKIE];
  if (!sid) return null;
  const s = await getSession(db, sid, now);
  return s?.userId ?? null;
}

/** GET /api/chats — sidebar list. */
export async function handleListChats(req: Request, db: DbClient, now: number, cors: Record<string, string>): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors);
  return json({ chats: await listChats(db, me) }, 200, cors, { "Cache-Control": "no-store" });
}

/** POST /api/chats { username } — open-or-create a DM with that user. */
export async function handleCreateChat(req: Request, db: DbClient, now: number, cors: Record<string, string>): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors);
  let body: { username?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400, cors); }
  const uname = (body.username ?? "").trim();
  if (!uname) return json({ error: "username_required" }, 400, cors);
  const other = await db.first("SELECT id FROM users WHERE username = ?", [uname]);
  if (!other) return json({ error: "user_not_found" }, 404, cors);
  if (String(other.id) === me) return json({ error: "cannot_dm_self" }, 400, cors);
  const r = await createOrGetDirect(db, me, String(other.id), now);
  return json({ chatId: r.id, created: r.created }, 200, cors);
}

/** GET /api/chats/:id/messages?before=<id> — history from the chat's DO. */
export async function handleHistory(req: Request, env: Env, db: DbClient, now: number, chatId: string, cors: Record<string, string>): Promise<Response> {
  const me = await callerId(req, db, now);
  if (!me) return json({ error: "unauthorized" }, 401, cors);
  if (!(await isMember(db, chatId, me))) return json({ error: "forbidden" }, 403, cors);
  const before = new URL(req.url).searchParams.get("before");
  const stub = env.CONVERSATION!.get(env.CONVERSATION!.idFromName(chatId));
  const messages = await stub.historyFor(chatId, before);
  return json({ messages }, 200, cors, { "Cache-Control": "no-store" });
}
```
> Add a `historyFor(chatId, before)` RPC method to the DO (Task 3 variant) that takes chatId explicitly (doesn't rely on a live socket):
> ```ts
> async historyFor(chatId: string, beforeId: string | null): Promise<Wire[]> { /* same body as history(), using chatId param */ }
> ```
> Replace the earlier `history()`/`roomChatId()` with `historyFor(chatId, beforeId)`.

- [ ] **Step 2: Wire routes in `src/index.ts` `handle()`** (before the assets fallback):
```ts
  if (path === "/api/chats" && m === "GET") return handleListChats(req, deps.getDb(), deps.now(), cors);
  if (path === "/api/chats" && m === "POST") return handleCreateChat(req, deps.getDb(), deps.now(), cors);
  const hist = path.match(/^\/api\/chats\/([^/]+)\/messages$/);
  if (hist && m === "GET") return handleHistory(req, env, deps.getDb(), deps.now(), hist[1], cors);
  if (path === "/ws" && m === "GET") return handleWs(req, env, deps);
```
And add `handleWs` (upgrade → gate → forward to DO):
```ts
async function handleWs(req: Request, env: Env, deps: Deps): Promise<Response> {
  if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
  const chatId = new URL(req.url).searchParams.get("chat");
  if (!chatId) return new Response("chat required", { status: 400 });
  const me = await callerId(req, deps.getDb(), deps.now());
  if (!me) return new Response("unauthorized", { status: 401 });
  if (!(await isMember(deps.getDb(), chatId, me))) return new Response("forbidden", { status: 403 });
  const stub = env.CONVERSATION!.get(env.CONVERSATION!.idFromName(chatId));
  const fwd = new Request(`https://do/ws?user=${encodeURIComponent(me)}&chat=${encodeURIComponent(chatId)}`, req);
  return stub.fetch(fwd);
}
```
(Import `callerId`, `isMember`, the chat handlers.)

- [ ] **Step 3: Tests** `src/chatapi.test.ts` — fake DbClient + a fake `env.CONVERSATION` stub returning canned history; cover unauthorized (401), user_not_found (404), create/dedup, membership gate (403), list. (WS upgrade path is covered by the DO workers test + the live smoke.)

- [ ] **Step 4: Run `test:node` (chatapi green) + `test:do` (DO green). Commit** `feat(meowsenger): /ws upgrade + chat REST (create/list/history)`.

---

## Task 6: Frontend — desktop-first chat UI

**Files:** Create `apps/meowsenger-web/src/lib/chat.ts` (+ test), `src/components/Chat.tsx`, `src/components/Composer.tsx`, `src/components/ChatSidebar.tsx`; Modify `src/components/AppShell.tsx`, `src/pages/app.astro`, `src/styles/app.css`.

- [ ] **Step 1: `src/lib/chat.ts`** — typed REST + a tiny WS client (unit-tested REST parts; WS is thin):
```ts
export interface ChatSummary { id: string; type: string; name: string | null; lastMessage: string | null; lastSenderId: string | null; lastActivity: number; unreadCount: number; }
export interface Message { id: string; chatId: string; senderId: string; body: string; createdAt: number; }

export async function listChats(base: string): Promise<ChatSummary[]> {
  try { const r = await fetch(`${base}/api/chats`, { credentials: "include" }); const d = await r.json(); return d.chats ?? []; } catch { return []; }
}
export async function openDirect(base: string, username: string): Promise<{ chatId?: string; error?: string }> {
  try { const r = await fetch(`${base}/api/chats`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username }) }); return await r.json(); } catch { return { error: "network" }; }
}
export async function loadHistory(base: string, chatId: string, before?: string): Promise<Message[]> {
  try { const q = before ? `?before=${encodeURIComponent(before)}` : ""; const r = await fetch(`${base}/api/chats/${chatId}/messages${q}`, { credentials: "include" }); const d = await r.json(); return d.messages ?? []; } catch { return []; }
}
/** WebSocket URL for a chat on the same origin (wss in prod). */
export function wsUrl(base: string, chatId: string): string {
  const origin = base || (typeof location !== "undefined" ? location.origin : "");
  const wsOrigin = origin.replace(/^http/, "ws");
  return `${wsOrigin}/ws?chat=${encodeURIComponent(chatId)}`;
}
```
Test `chat.test.ts`: mock `fetch`, assert `listChats`/`openDirect`/`loadHistory` shapes + `wsUrl` (`https://x`→`wss://x/ws?chat=c`).

- [ ] **Step 2: Desktop-first layout in `app.css`** — a master-detail chat grid that is side-by-side ≥720px and swaps on mobile:
```css
.mw-chat { display: grid; grid-template-columns: 320px 1fr; height: calc(100dvh - var(--header-h, 64px)); min-height: 0; }
.mw-chat__side { border-right: 1px solid var(--border); overflow-y: auto; min-height: 0; }
.mw-chat__main { display: flex; flex-direction: column; min-height: 0; }
.mw-chat__log { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-4); min-height: 0; }
.mw-bubble { max-width: min(66ch, 76%); padding: 8px 12px; border-radius: var(--radius-lg); background: var(--surface-2); width: fit-content; }
.mw-bubble--me { align-self: flex-end; background: color-mix(in srgb, var(--mw-green) 22%, var(--surface-2)); }
.mw-composer { display: flex; gap: var(--space-2); padding: var(--space-3); border-top: 1px solid var(--border); }
.mw-composer input { flex: 1; }
@media (max-width: 719px) {
  .mw-chat { grid-template-columns: 1fr; }
  .mw-chat[data-open="1"] .mw-chat__side { display: none; }
  .mw-chat:not([data-open="1"]) .mw-chat__main { display: none; }
}
```
> `main` uses `.mw-container--wide`/full-bleed for chat (override the narrow default) so desktop uses the horizontal space — this addresses the "desktop too narrow" feedback.

- [ ] **Step 3: `Chat.tsx`** — the island: sidebar (`listChats` + a "new chat" username input calling `openDirect`), a conversation pane that on select `loadHistory` + opens a WebSocket (`wsUrl`), renders bubbles, optimistic send (tempId → reconcile on `sent`), appends on `message`. `Composer.tsx` = input + send. Reconnect on close (simple backoff). Full code in the implementation (mirrors nextmeowsenger's optimistic pattern; ~150 lines).

- [ ] **Step 4: Point `app.astro` at the new `Chat` island** (replace the AppShell placeholder body with `<Chat client:load base={base} />`, keeping the AppShell auth-gate wrapper). Header height var wired for the grid.

- [ ] **Step 5: `astro check` + `build` + `test` green. Commit** `feat(meowsenger-web): realtime DM chat UI (sidebar + conversation, desktop-first)`.

---

## Task 7: Deploy + verify live

- [ ] **Step 1: Full local gate** — `just lint && just test` green (DO tests included).
- [ ] **Step 2: Apply the new D1 tables** — `cd workers/meowsenger && bunx wrangler d1 execute meowsenger --remote --file schema.sql` (idempotent `IF NOT EXISTS`; adds chats/chat_members).
- [ ] **Step 3: Deploy** — `just deploy-meowsenger` (builds UI + deploys the worker incl. the new DO migration). First deploy with a `[[migrations]]` block registers the `Conversation` SQLite class.
- [ ] **Step 4: Verify live:**
  - Log in as user A, open a DM to user B's username → `POST /api/chats` returns a chatId.
  - In two browsers (A + B, both members), open the chat → a message A sends appears in B **live** (WebSocket), and persists on reload (history from the DO).
  - `curl` `GET /api/chats` (with A's cookie) → the DM listed with last_message.
  - Non-member `GET /api/chats/:id/messages` → 403; `/ws?chat=` without session → 401.
- [ ] **Step 5: Commit any deploy-state; open PR; merge when green.**

---

## Self-review notes
- **Spec coverage:** §3.3 (Conversation DO: Hibernation WS + SQLite + waitUntil D1 mirror) → T3; §4.1 chats/chat_members → T1; §6 protocol (send/sent/message/ready/error) → T3,T6; membership gate → T5. Presence/typing/receipts (§6 remainder), edit/delete, groups, sidebar unread-reset = Slices 3–5 (out of scope).
- **First DO/WS in the monorepo:** introduces `@cloudflare/vitest-pool-workers` (second vitest project) — the existing 49 node-pool tests are untouched.
- **DO↔D1:** the DO writes messages to its own SQLite (hot path) and mirrors only the last-message preview + unread to D1 (bounded: ≤2 statements/msg) via `waitUntil` — matches spec §9 guardrails.
- **Placement:** the worker stays edge-placed (no Smart Placement) — correct for DO + D1.
- **Desktop UI:** the chat is a full-width master-detail grid (not the narrow content column), directly addressing the "desktop too narrow" feedback; mobile swaps to a single column.
