-- meowsenger D1 schema (Slice 1: users + sessions; Slice 2: chats + members).
-- Applied with:
--   wrangler d1 execute meowsenger --remote --file schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,           -- OIDC sub
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  avatar_url    TEXT,
  verified      INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  -- Slice 7 privacy: 1 = this user may be added to groups directly (default);
  -- 0 = adding them instead yields an invite the actor must share (opt-out).
  allow_auto_group_add INTEGER NOT NULL DEFAULT 1,
  -- Last time this user's final live socket dropped (ms), for the DM "last seen …"
  -- header. Null until they've connected + disconnected at least once.
  last_seen_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,          -- opaque cookie value
  user_id        TEXT NOT NULL,
  access_token   TEXT NOT NULL,
  refresh_token  TEXT,
  access_exp     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Slice 2: the chat graph. Slice 5 adds named groups. Message bodies live in
-- each chat's Durable Object SQLite; D1 holds only the graph + a last-message
-- preview mirrored off the critical path for the sidebar.
--
-- NOTE (Slice 5): `visibility` + `slug` are additive columns. A fresh DB gets
-- them from this CREATE TABLE; an already-provisioned meowsenger D1 gets them
-- from the one-shot `schema-slice5.sql` (D1 has no ADD COLUMN IF NOT EXISTS, so
-- the ALTERs live in that separate file, applied once at deploy).
--
-- NOTE (Slice 7): `invite_code` + `invite_enabled` are additive too — a fresh DB
-- gets them here; an already-provisioned D1 gets them from `schema-slice7.sql`.
CREATE TABLE IF NOT EXISTS chats (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL,             -- 'direct' | 'group' | 'channel' (channel = broadcast, Slice 6)
  name           TEXT,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_activity  INTEGER NOT NULL,
  last_message   TEXT,
  last_sender_id TEXT,
  direct_key     TEXT UNIQUE,               -- 'min:max' of the two user ids, for DM dedup
  visibility     TEXT NOT NULL DEFAULT 'private', -- 'public' | 'private' (Slice 5; discovery = Slice 6)
  slug           TEXT UNIQUE,               -- optional handle, ^[a-z0-9-]{3,32}$ (Slice 5)
  invite_code    TEXT UNIQUE,               -- optional 12-char invite code, direct-join bypasses visibility (Slice 7)
  invite_enabled INTEGER NOT NULL DEFAULT 1 -- 1 = the current invite_code is live; 0 = revoked (Slice 7)
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

-- Slice 7: join requests for private-but-discoverable chats (a private chat WITH
-- a slug). A non-member requests access; owner/admin approve (→ member) or reject.
-- One row per (chat, user) — re-requesting is idempotent (UNIQUE keeps a single
-- row whose `status` reflects the latest decision).
CREATE TABLE IF NOT EXISTS join_requests (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  created_at  INTEGER NOT NULL,
  UNIQUE (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_join_requests_chat ON join_requests(chat_id, status);

-- Web Push subscriptions: one row per browser/device push endpoint. Keyed by the
-- endpoint (a push service URL, unique per subscription). p256dh/auth are the
-- client's keys, stored for a possible future encrypted payload (unused by the
-- current payloadless design). A user can have several (multiple devices/browsers).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  p256dh      TEXT,
  auth        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
