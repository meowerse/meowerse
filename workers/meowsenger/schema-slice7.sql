-- meowsenger Slice 7 — one-shot additive migration for an ALREADY-provisioned D1.
--
-- Adds the invite-code columns to `chats`, the `allow_auto_group_add` column to
-- `users`, and the `join_requests` table. A fresh DB gets all of these from the
-- CREATE TABLEs in schema.sql; this file is ONLY for a database created before
-- Slice 7. D1 has no `ADD COLUMN IF NOT EXISTS`, so these ALTERs must run EXACTLY
-- ONCE — re-running throws "duplicate column name". The meowsenger D1 is pre-launch
-- (no real group rows), so this is safe to apply once.
--
-- Apply at deploy with:
--   wrangler d1 execute meowsenger --remote --file schema-slice7.sql

ALTER TABLE chats ADD COLUMN invite_code TEXT;
ALTER TABLE chats ADD COLUMN invite_enabled INTEGER NOT NULL DEFAULT 1;

-- SQLite/D1 cannot add a UNIQUE column via ALTER TABLE; enforce invite_code
-- uniqueness with a unique index (equivalent to the `invite_code TEXT UNIQUE` in
-- schema.sql). NULLs are exempt from UNIQUE, so chats without a code coexist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_invite_code ON chats(invite_code);

ALTER TABLE users ADD COLUMN allow_auto_group_add INTEGER NOT NULL DEFAULT 1;

-- Join requests: a private-but-discoverable chat (private + slug) can be requested
-- by a non-member; owner/admin approve (→ member) or reject. One row per (chat,
-- user), so re-requesting reuses the same row.
CREATE TABLE IF NOT EXISTS join_requests (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL,
  UNIQUE (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_join_requests_chat ON join_requests(chat_id, status);
