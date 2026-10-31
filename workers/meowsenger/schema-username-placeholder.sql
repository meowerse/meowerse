-- meowsenger: one-shot data fix (2026-10-31). Username-less (Telegram-only) users used to be
-- stored with username = their own id; move them to the unaddressable placeholder form
-- ('~' || id) so an id-shaped auth username can never claim their handle. Idempotent.
--   wrangler d1 execute meowsenger --remote --file schema-username-placeholder.sql
UPDATE users SET username = '~' || id WHERE username = id;
