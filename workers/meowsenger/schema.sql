-- meowsenger D1 schema (Slice 1: users + sessions). Applied with:
--   wrangler d1 execute meowsenger --remote --file schema.sql
-- Chats/members tables arrive in Slice 2 where they are first used.

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
