# UX, Edge Routing & Multi-Device Unread Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate auth button flash, polish meowsenger SSO gate UX, and synchronize sender read state across multiple devices with zero extra D1 write overhead.

**Architecture:** Cloudflare Workers edge-intercept on `/` with cookie-sniffing redirect to `/account`; layout-stable skeleton for `LandingCta`; unified authenticating gate in `AppShell`; and SQL conditional unread filtering + sender `markRead` advancement for multi-device consistency.

**Tech Stack:** Cloudflare Workers, Astro, React, D1 (SQLite), TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-ux-unread-edge-routing.md`

## Global Constraints
- Preserve Cloudflare Workers Free Tier ($0.00 / 100k requests/day ceiling).
- Serve unauthenticated static pages via Cloudflare Assets at edge with 0 worker cost.
- Do not add external dependencies (use standard Web APIs).
- Maintain 100% test pass rate across all workspace packages and workers.

## Review Focus
1. Edge cookie inspection on `/` does not cause infinite redirect loops if `/account` also redirects to `/`.
2. `LandingCta` skeleton perfectly matches button height and width to prevent Cumulative Layout Shift (CLS).
3. `meowsenger` SSO redirect preserves seamless login while hiding raw redirect text.
4. Sending a message from Device A does not show an unread dot or badge on Device B when both are logged into the same account.
5. Inbound messages from peers still correctly increment unread badges and trigger inbox fanout deltas.

---

### Task 1: Edge Cookie Redirect & Layout-Stable CTA for `auth.alxnko.dev`

**Files:**
- Modify: `workers/auth/wrangler.jsonc`
- Modify: `workers/auth/src/index.ts`
- Modify: `apps/auth-web/src/components/LandingCta.tsx`
- Test: `workers/auth/test/index.session.test.ts` (or relevant worker test)

- [ ] **Step 1: Write failing test in `workers/auth` for edge redirect on `/` with active session cookie**
- [ ] **Step 2: Add `"/"` to `run_worker_first` in `workers/auth/wrangler.jsonc`**
- [ ] **Step 3: Implement root GET handler in `workers/auth/src/index.ts` to 302-redirect to `/account` if session cookie exists**
- [ ] **Step 4: Update `LandingCta.tsx` to render a zero-CLS skeleton placeholder while `s.loading === true`**
- [ ] **Step 5: Run tests for `workers/auth` and `apps/auth-web`**

---

### Task 2: Seamless App Gateway for `meowsenger.alxnko.dev`

**Files:**
- Modify: `apps/meowsenger-web/src/components/AppShell.tsx`
- Modify: `apps/meowsenger-web/src/components/Chat.behavior.test.tsx` (or unit tests)

- [ ] **Step 1: Update `AppShell.tsx` to show a clean authenticating state during session resolution and redirect**
- [ ] **Step 2: Verify `AppShell` behavior test and run tests in `apps/meowsenger-web`**

---

### Task 3: Multi-Device Unread Fix for Sender

**Files:**
- Modify: `workers/meowsenger/src/chats.ts`
- Modify: `workers/meowsenger/src/conversation.ts`
- Modify: `apps/meowsenger-web/src/components/Chat.tsx`
- Test: `workers/meowsenger/src/chats.test.ts`
- Test: `apps/meowsenger-web/src/components/Chat.behavior.test.tsx`

- [ ] **Step 1: Write failing tests in `workers/meowsenger/src/chats.test.ts` verifying sender's own message results in `unreadCount: 0` for that sender**
- [ ] **Step 2: Update `listChats` SQL in `workers/meowsenger/src/chats.ts` with `WHEN c.last_sender_id = m.user_id THEN 0`**
- [ ] **Step 3: In `conversation.ts`, advance sender `last_read_at` via `markRead` on message dispatch**
- [ ] **Step 4: In `Chat.tsx`, guard `applySidebarDelta` so `senderId === me?.id` never sets `unreadCount: 1`**
- [ ] **Step 5: Run tests in `workers/meowsenger` and `apps/meowsenger-web` to verify fix**

---

### Task 4: Full Workspace Verification & Quality Gate

- [ ] **Step 1: Run `bun run test` (turbo test across all packages and workers)**
- [ ] **Step 2: Run `bun run lint` (or typecheck)**
- [ ] **Step 3: Document changes and verify final status**
