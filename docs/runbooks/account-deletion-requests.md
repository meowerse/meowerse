# Account deletion requests (intake only)

**Status (2026-10-30): no irreversible deletion is performed from an email request.** Self-service deletion
(`POST /api/account/delete`) is disabled (`ACCOUNT_DELETE_ENABLED` unset) until hardening steps B–D ship and the
owner separately approves turning it on. There is no approved manual deletion procedure; do not run deletion SQL
by hand against production. The earlier manual runbook was withdrawn because its ownership check was not bound
to a specific request and did not require fresh authentication.

## When a request arrives at privacy@alxnko.dev
1. Reply within 7 days, from the privacy@ conversation:
   - we received the request and are holding it;
   - deletion will be done from inside their account, after they sign in again and confirm, once that flow is
     live, and we will tell them when;
   - never send recovery codes, passwords or Telegram login codes by email; we will never ask for them.
2. Record the request in the private tracker: date received, the username they gave (if any), the services they
   mention, and status `queued`. Do not look up or copy any other account data into the tracker.
3. Do not change the account, revoke sessions, or touch Meowsenger data on their behalf.
4. When the in-account deletion flow is live, tell each queued requester how to use it, and mark the entry
   `notified`.

If someone reports an account compromise instead, treat it as a security report (security@alxnko.dev), not a
deletion request.

## What deletion will cover (reference, not a procedure)
Auth deletion (`deleteAccount` in `workers/auth/src/accounts.ts`, one write transaction) removes the meowerse
account: login methods, sessions, recovery codes, consents, tokens and codes, management tokens, login tickets,
and apps the account owns.

Meowsenger data is separate: the user deletes it from Meowsenger settings → danger zone, which removes their
profile, sessions, memberships, join requests, push subscriptions and groups they solely own.

What remains after both:
- Messages they sent in Meowsenger chats (stored in each chat under their old id), their emoji reactions, and
  `chats.created_by` on chats that still exist.
- Security audit entries for the account, removed after 365 days.
- Database backups until their retention window expires.

Do not describe a deletion as complete erasure while these remain.
