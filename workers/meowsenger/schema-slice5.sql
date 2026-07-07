-- meowsenger Slice 5 — one-shot additive migration for an ALREADY-provisioned D1.
--
-- Adds the `visibility` + `slug` columns to `chats`. A fresh DB gets these from
-- the CREATE TABLE in schema.sql; this file is ONLY for a database that was
-- created before Slice 5. D1 has no `ADD COLUMN IF NOT EXISTS`, so these ALTERs
-- must run EXACTLY ONCE — re-running throws "duplicate column name". The
-- meowsenger D1 is pre-launch (no real group rows), so this is safe to apply once.
--
-- Apply at deploy with:
--   wrangler d1 execute meowsenger --remote --file schema-slice5.sql

ALTER TABLE chats ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
ALTER TABLE chats ADD COLUMN slug TEXT;

-- SQLite/D1 cannot add a UNIQUE column via ALTER TABLE; enforce slug uniqueness
-- with a unique index instead (equivalent to the `slug TEXT UNIQUE` in schema.sql).
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_slug ON chats(slug);
