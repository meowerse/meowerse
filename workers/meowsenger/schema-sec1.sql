-- SEC-1 one-time scrub for an ALREADY-provisioned meowsenger D1.
--
-- Session ids are now stored as sha256(cookie) and OAuth tokens are no longer
-- persisted. This blanks tokens on existing rows and drops expired sessions.
-- Legacy raw-id rows stay valid until first use (then rewritten hashed) or expiry.
-- Run order: deploy the SEC-1 worker FIRST, then `bun run d1:schema-sec1` (running it earlier
-- lets the old code keep writing tokens until the deploy lands).
-- All times are in milliseconds (strftime seconds * 1000). Idempotent: safe to re-run.
UPDATE sessions SET access_token = '', refresh_token = NULL;
DELETE FROM sessions WHERE expires_at < CAST(strftime('%s','now') AS INTEGER) * 1000;
