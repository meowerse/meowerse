-- meowsenger D1 schema (Slice 1: users + sessions; Slice 2: chats + members).
-- Applied with:
--   wrangler d1 execute meowsenger --remote --file schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,           -- OIDC sub
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  avatar_url    TEXT,
  verified      INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
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
  slug           TEXT UNIQUE                -- optional handle, ^[a-z0-9-]{3,32}$ (Slice 5)
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
