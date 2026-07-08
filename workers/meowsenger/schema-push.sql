-- meowsenger — one-shot additive migration for an ALREADY-provisioned D1.
--
-- Adds the push_subscriptions table (Web Push). A fresh DB gets it from schema.sql;
-- this file is ONLY for a database created before Web Push. CREATE TABLE IF NOT
-- EXISTS makes it safe to re-run.
--
-- Apply at deploy with:
--   wrangler d1 execute meowsenger --remote --file schema-push.sql

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  p256dh      TEXT,
  auth        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
