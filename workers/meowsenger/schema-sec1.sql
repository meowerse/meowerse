-- SEC-1 one-time scrub for an ALREADY-provisioned meowsenger D1.
--
-- Session ids are now stored as sha256(cookie) and OAuth tokens are no longer
-- persisted. This blanks tokens on existing rows and drops expired sessions.
-- Legacy raw-id rows stay valid until first use (then rewritten hashed) or expiry.
-- All times are in milliseconds (strftime seconds * 1000). Idempotent: safe to re-run.
UPDATE sessions SET access_token = '', refresh_token = NULL;
DELETE FROM sessions WHERE expires_at < CAST(strftime('%s','now') AS INTEGER) * 1000;
