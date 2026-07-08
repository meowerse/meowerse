-- meowsenger — one-shot additive migration for an ALREADY-provisioned D1.
--
-- Adds the `last_seen_at` column to `users` (the DM "last seen …" header). A fresh
-- DB gets it from the CREATE TABLE in schema.sql; this file is ONLY for a database
-- created before this feature. D1 has no `ADD COLUMN IF NOT EXISTS`, so this ALTER
-- must run EXACTLY ONCE — re-running throws "duplicate column name".
--
-- Apply at deploy with:
--   wrangler d1 execute meowsenger --remote --file schema-lastseen.sql

ALTER TABLE users ADD COLUMN last_seen_at INTEGER;
