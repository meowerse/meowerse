# Design note: auth -> meowsenger "account deleted" webhook (NOT implemented)

Status: proposal for owner decision. No code was written for it (audit finding I5, auth side).

## Problem
`deleteAccount` in `workers/auth` erases the auth-side account (sessions, tokens, consents, links). Meowsenger keeps
per-sender data keyed by the auth `sub` (messages, memberships, push subscriptions, sessions). Nothing tells meowsenger
the account is gone, so its data lives on, and a deleted `sub` is never erased there (GDPR erasure gap).

## Proposal
1. Auth worker, after the deletion transaction commits, POSTs a signed event to meowsenger:
   `POST https://<meowsenger>/internal/auth/account-deleted`
   body `{"event":"account.deleted","sub":"acct_...","ts":<unix>,"jti":"<random>"}`
   header `X-Meow-Signature: hex(HMAC-SHA256(INTERNAL_HMAC_KEY_AUTH_TO_MEOWSENGER, ts + "." + rawBody))`.
   Reuse the existing `INTERNAL_HMAC_KEY` pattern (separate key per direction; rotate by accepting two keys).
2. Meowsenger verifies: constant-time MAC compare, `|now - ts| <= 300 s`, `jti` not seen (small replay table or the DO's
   own idempotency), then calls a Durable Object RPC `eraseSender(sub)` on every room DO that holds the sender
   (rooms found via a per-sender index; erasure = tombstone messages / null author, drop memberships, push
   subscriptions and meowsenger sessions). Idempotent: repeating is a no-op.
3. Delivery: enqueue the event inside the same auth DB transaction as the deletion (an `outbox` row), and drain it from
   the daily cron + `ctx.waitUntil` with retry/backoff, so a meowsenger outage does not lose the erasure. Mark the row
   delivered on a 2xx. (Needs one additive table: a prod one-shot, SKIP_MIGRATIONS=1.)
4. Observability: audit row `account.erase_propagated` (no PII), alert on rows undelivered > 24 h.

## Decisions needed
- Erase vs tombstone message bodies in rooms with other members (product/legal call).
- Whether meowsenger must also pull: reconcile job asking auth "is `sub` still live" for stale senders (belt and braces).
- Secret naming and where the shared key lives (wrangler secret on both workers).

## Out of scope here
Any change to workers/meowsenger (another change owns that area).
