# meowsenger — finalize checklist (swept before/at the single end-of-build deploy)

Running tracker of small gaps + live-only checks found during slice builds. Cleared at the
end-of-build finalize pass (user: "deploy when we fully finish" + "add missing things if agents
forgot something").

## Live-only checks (need the deployed app / a browser — do at deploy)
- [ ] **Desktop chat layout eyeball** — the master-detail is verified by CSS logic + clean build,
      not a real render. Confirm the wide-screen log padding + bubble max-width feel right.
- [ ] **End-to-end realtime** — two browsers, send in A → appears live in B; reload → history
      persists; reconnect after network blip.
- [ ] **Telegram avatar** — after the final deploy (avatar proxy live + issuer), confirm the
      real Telegram photo renders (and initials fallback when hidden/none).
- [ ] **Slice-4 message actions (eyeball)** — hover-action emoji glyphs (↩✎🗑⋯) vs house style;
      context-menu positioning near screen edges; reply flash-highlight settling back to the
      normal green tint on my-bubbles. All functional (build-verified), just need a look.

## Slice 2 follow-ups (addressed in a later slice — verify they land)
- [ ] **Live sidebar** — sidebar `last_message`/`unread` don't refresh after send/receive yet;
      Slice 3 (presence/receipts) or Slice 8 adds live sidebar + unread badges. Verify.
- [ ] **Own-message avatar** — intentionally omitted (WhatsApp-style, avatar only on peer side).
      Confirm the design reads well; easy to add if wanted.

## Cross-cutting (do during the relevant slice / finalize)
- [ ] **Per-slice correctness audit vs NextMeowsenger** — reply (quote + jump), forward (N targets
      + badge), edit (1h window), delete (perms + soft), roles (owner-unremovable), channels/invites
      state machines. Adversarial pass each slice + a final full audit.
- [ ] **Auth consolidation** — merge auth-web into the auth worker on `auth.alxnko.eu.org`, issuer
      cutover, re-point/re-provision meowsenger, retire `auth-api`. Update all docs.
- [ ] **Docs sweep** — spec §11 (deploy wiring) still describes the OLD two-host meowsenger; update
      to single-host. Update package READMEs. Update memory. (User: "update everything, all docs.")
- [ ] **Deploy** — one coordinated cutover: apply new D1 tables (chats/chat_members already in
      schema.sql), deploy meowsenger (with the DO `migrations` block) + auth, WAF, verify.
