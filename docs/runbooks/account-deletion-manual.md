# Manual account deletion (auth + Meowsenger)

## A. When this applies
`ACCOUNT_DELETE_ENABLED` is off (default): `POST /api/account/delete` returns 503 `deletion_unavailable` and the account page tells users to email `privacy@alxnko.dev` (Cloudflare Email Routing, working mailbox). Do the steps below by hand. To enable self-service instead, add `"ACCOUNT_DELETE_ENABLED": "1"` to `workers/auth/wrangler.jsonc` vars and update the privacy copy in the same PR.

Auth deletion removes the **auth account only**. Meowsenger data is deleted separately (step D). Never act on the email alone.

## B. Verify ownership
Accounts have no email, so email proves nothing. Display name and avatar are **not editable** anywhere today (no `UPDATE accounts SET display_name` exists in `workers/auth`), so use another in-account action that works for password and Telegram-only accounts: **regenerate recovery codes** (account page, "recovery codes", needs a live session + CSRF) which writes an audit row `recovery.regenerate`.

1. Reply to the requester (ask for their username) and note the send time `T` (UTC). Tell them: "sign in, then regenerate your recovery codes and save the new ones."
2. Confirm read-only (Turso shell), using the account id from the username:
   ```sql
   SELECT id, username, display_name FROM accounts WHERE username = :username;  -- Telegram-only: match via telegram_links.telegram_username
   SELECT ts, event FROM audit_log WHERE account_id = :id AND event = 'recovery.regenerate' AND ts > :T ORDER BY ts DESC;
   ```
   `audit_log.ts` is UTC `datetime('now')`. No row after `T` = not verified; stop. Note: regenerating invalidates their previous recovery codes (tell them).

## C. Refuse while they own OAuth clients
```sql
SELECT client_id, name FROM oauth_clients WHERE owner_account_id = :id;
```
Any rows: refuse. Deletion would remove the clients and break their users' sign-in; the requester must delete or hand over those apps first.

## D. Meowsenger first
1. Requester deletes their Meowsenger data in Meowsenger settings, danger zone. This removes profile, sessions, memberships, join requests, push subscriptions and groups they solely own; **message bodies they already sent remain** in each chat's storage.
2. Verify (`users.id` is the OIDC `sub`, i.e. the auth account id; confirm for this account first). From `workers/meowsenger`, each must be 0:
   ```sh
   for t in users:id sessions:user_id chat_members:user_id join_requests:user_id push_subscriptions:user_id; do
     bunx wrangler d1 execute meowsenger --remote --command "SELECT '${t%%:*}' AS t, COUNT(*) AS n FROM ${t%%:*} WHERE ${t##*:} = '<ACCOUNT_ID>'"
   done
   ```

## E. Auth deletion (one transaction, Turso shell)
Same statements as `deleteAccount` in `workers/auth/src/accounts.ts` (keep in sync if it changes). Replace `:id`:
```sql
BEGIN;
DELETE FROM oauth_client_secrets WHERE client_id IN (SELECT client_id FROM oauth_clients WHERE owner_account_id = :id);
DELETE FROM oauth_client_redirect_uris WHERE client_id IN (SELECT client_id FROM oauth_clients WHERE owner_account_id = :id);
DELETE FROM consents WHERE client_id IN (SELECT client_id FROM oauth_clients WHERE owner_account_id = :id);
DELETE FROM recovery_codes WHERE account_id = :id;
DELETE FROM password_credentials WHERE account_id = :id;
DELETE FROM telegram_links WHERE account_id = :id;
DELETE FROM sessions WHERE account_id = :id;
DELETE FROM consents WHERE account_id = :id;
DELETE FROM access_tokens WHERE account_id = :id;
DELETE FROM refresh_tokens WHERE account_id = :id;
DELETE FROM oauth_codes WHERE account_id = :id;
DELETE FROM login_requests WHERE account_id = :id;
DELETE FROM login_tickets WHERE account_id = :id;
DELETE FROM management_tokens WHERE owner_account_id = :id;
DELETE FROM oauth_clients WHERE owner_account_id = :id;
DELETE FROM accounts WHERE id = :id;
INSERT INTO audit_log (event, account_id, client_id, ip_trunc, ua_hash) VALUES ('account.delete', :id, NULL, NULL, NULL);
COMMIT;
```
The audit INSERT uses the same columns `recordAudit` writes; `ts` defaults to now. IP/UA are NULL because an operator action has no request to derive them from (the Worker stores truncated IP + UA hash only for user requests).

## F. Verify
Each must return 0 (substitute the id):
```sql
SELECT COUNT(*) FROM accounts WHERE id = :id;
-- repeat for recovery_codes, password_credentials, telegram_links, sessions, consents, access_tokens,
-- refresh_tokens, oauth_codes, login_requests, login_tickets (account_id) and management_tokens, oauth_clients (owner_account_id)
SELECT event, ts FROM audit_log WHERE account_id = :id ORDER BY ts DESC LIMIT 1;  -- account.delete
SELECT COUNT(*) FROM accounts;  -- compare with the count before; must be exactly one lower
```

## G. What remains
- Messages the user sent in Meowsenger chats (bodies stay in chat storage under their old id).
- Audit rows for the account, pruned after 365 days.
- Turso/D1 backups until their retention window expires.

## H. Reply to the requester
Confirm deletion, list what remains (section G), and note Meowsenger data was handled separately. Do not include account ids or query output.
