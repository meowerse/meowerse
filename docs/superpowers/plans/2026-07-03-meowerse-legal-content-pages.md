# Legal & Content Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/about`, `/privacy`, `/terms` (and confirm the footer links resolve) — written truthfully from the real auth data model, honest personal-project framing, `ContactLinks` for contact.

**Architecture:** Static Astro pages using the migrated `Layout.astro` (Plan 3) + a few `@meowerse/ui` primitives (`Card`, `ContactLinks`) rendered statically (no `client:load` — they're pure content). No new data, no new endpoints. Every factual claim traces to the schema in `workers/auth/src/db.ts` and the scope catalog in `packages/auth-shared`.

**Tech Stack:** Astro 7, `@meowerse/ui` (Plan 1 — `Card`, `ContactLinks`).

**This is Plan 4 of 4.** Depends on Plan 1 (`ContactLinks`, `Card`) and Plan 3 (themed `Layout`, `Footer` links). The `Footer` (Plan 1 Task 22) already links to `/about`, `/privacy`, `/terms`, `/developers`; this plan makes those targets exist.

**Factual basis (do not deviate):** collected = username, optional display name + avatar URL, password (PBKDF2-SHA256 600k, salted, hashed — never plaintext), 8 hashed recovery codes, and (only if linked) Telegram id + username + display name + avatar URL; verified is derived from a Telegram link. Sessions store a hashed id + CSRF; rate-limit counters key on a **hashed** IP (signup) or **hashed** username (login) — no raw IP stored. Shared with apps only per-scope with consent: `openid`→opaque id, `profile`→username/display/avatar, `telegram`→telegram id+username, `verified`→boolean. No email, no SMS, no analytics/trackers, no ads, no data selling. Processors: Turso (DB), Cloudflare (Workers/Pages hosting + edge logs), Telegram (only if used). Retention: sessions ≤30 days, tokens minutes, codes 60s; account data until you delete your account (the `/api/account/delete` from Plan 2) or unlink.

---

## File structure

```
apps/auth-web/src/pages/about.astro
apps/auth-web/src/pages/privacy.astro
apps/auth-web/src/pages/terms.astro
```

---

## Task 1: `/about`

**Files:** Create `apps/auth-web/src/pages/about.astro`

- [ ] **Step 1: Write the page**

```astro
---
import Layout from "../layouts/Layout.astro";
import { Card, ContactLinks } from "@meowerse/ui";
---
<Layout title="about · meowerse">
  <div class="mw-stack">
    <h1>about meowerse accounts</h1>
    <p>Meowerse accounts is a single sign-on for the meowerse apps. Create one account, optionally verify it with Telegram, and use it to sign in across meowerse — deciding, per app, exactly which of your data it may see.</p>
    <p class="mw-muted">It's a personal project by alxnko, run on a best-effort basis on free-tier infrastructure. It is not a company, it shows no ads, and it does not track you.</p>

    <Card title="what it does">
      <ul>
        <li>Sign in with a username and password, or with Telegram.</li>
        <li>Verify your account by linking Telegram.</li>
        <li>Grant apps access with granular, per-scope consent you can revoke any time.</li>
        <li>Recover access with one-time recovery codes.</li>
      </ul>
    </Card>

    <Card title="built on open standards">
      <p>OAuth 2.0 and OpenID Connect with PKCE, ES256-signed tokens, and a published JWKS — so any standards-compliant app can integrate.</p>
    </Card>

    <div class="mw-section">
      <h2>contact</h2>
      <ContactLinks />
    </div>
    <p class="mw-muted"><a href="/privacy">privacy</a> · <a href="/terms">terms</a></p>
  </div>
</Layout>
```

- [ ] **Step 2: Build check.** Run: `bun run --filter @meowerse/auth-web build` — expect success.

- [ ] **Step 3: Commit**

```bash
git add apps/auth-web/src/pages/about.astro
git commit -m "feat(auth-web): /about page"
```

---

## Task 2: `/privacy` (truthful, from the schema)

**Files:** Create `apps/auth-web/src/pages/privacy.astro`

- [ ] **Step 1: Write the page**

```astro
---
import Layout from "../layouts/Layout.astro";
import { Card, ContactLinks } from "@meowerse/ui";
---
<Layout title="privacy · meowerse">
  <div class="mw-stack">
    <h1>privacy policy</h1>
    <p class="mw-muted">Last updated 2026-07-03. Meowerse accounts is operated by an individual (alxnko) on a best-effort basis. This describes exactly what the service does with your data — nothing more.</p>

    <Card title="what we collect">
      <ul>
        <li>Your username, and an optional display name and avatar URL.</li>
        <li>Your password — stored only as a salted PBKDF2-SHA256 hash (600,000 iterations). We never store or log it in plain text.</li>
        <li>Eight one-time recovery codes, stored hashed.</li>
        <li>If you link Telegram: your Telegram id, username, display name, and avatar URL. Your "verified" status is derived from whether a Telegram link exists.</li>
        <li>Timestamps for account creation and updates.</li>
      </ul>
    </Card>

    <Card title="security & session data">
      <ul>
        <li>A session is a cookie holding a random id whose hash is stored server-side; the cookie is <code class="mono" data-case="preserve">__Host-</code> prefixed, HttpOnly, Secure, and SameSite=Lax.</li>
        <li>OAuth authorization codes and tokens are stored as hashes/ids with short lifetimes.</li>
        <li>Abuse-prevention counters are keyed on a <strong>hashed</strong> IP (at signup) or <strong>hashed</strong> username (at login). We do not store your raw IP address.</li>
      </ul>
    </Card>

    <Card title="what we share with apps">
      <p>Only with your explicit, per-scope consent — and you can revoke it any time from your account:</p>
      <ul>
        <li><code class="mono" data-case="preserve">openid</code> — an opaque account identifier (no personal information).</li>
        <li><code class="mono" data-case="preserve">profile</code> — your username, display name, and avatar.</li>
        <li><code class="mono" data-case="preserve">telegram</code> — your Telegram id and username.</li>
        <li><code class="mono" data-case="preserve">verified</code> — whether your account is verified (true/false).</li>
      </ul>
    </Card>

    <Card title="what we do not do">
      <ul>
        <li>No email address is collected, and we send no email.</li>
        <li>No SMS, no analytics, no advertising, no third-party trackers or cookies.</li>
        <li>We never sell or share your data beyond the processors below.</li>
      </ul>
    </Card>

    <Card title="processors">
      <ul>
        <li>Turso — the database that stores your account data.</li>
        <li>Cloudflare — hosts the workers and pages, and keeps short-lived edge request logs.</li>
        <li>Telegram — only involved if you use Telegram sign-in or verification.</li>
      </ul>
    </Card>

    <Card title="retention & your rights">
      <ul>
        <li>Sessions last at most 30 days; access tokens minutes; authorization codes 60 seconds.</li>
        <li>Your account data is kept until you delete your account or unlink Telegram.</li>
        <li>You can view your data on your account page, edit your display name and avatar, revoke app access, unlink Telegram, and <strong>permanently delete your account</strong> (which erases all of the above).</li>
      </ul>
    </Card>

    <div class="mw-section">
      <h2>questions or requests</h2>
      <ContactLinks />
    </div>
  </div>
</Layout>
```

- [ ] **Step 2: Build check.** Run: `bun run --filter @meowerse/auth-web build`

- [ ] **Step 3: Commit**

```bash
git add apps/auth-web/src/pages/privacy.astro
git commit -m "feat(auth-web): /privacy page (accurate to the data model)"
```

---

## Task 3: `/terms`

**Files:** Create `apps/auth-web/src/pages/terms.astro`

- [ ] **Step 1: Write the page**

```astro
---
import Layout from "../layouts/Layout.astro";
import { Card, ContactLinks } from "@meowerse/ui";
---
<Layout title="terms · meowerse">
  <div class="mw-stack">
    <h1>terms of use</h1>
    <p class="mw-muted">Last updated 2026-07-03. Meowerse accounts is a personal project provided by an individual (alxnko). By using it you agree to these terms.</p>

    <Card title="the service">
      <p>Meowerse accounts is provided free of charge, as-is and as-available, with no warranty and no service-level guarantee. It runs on free-tier infrastructure and may change, break, or be discontinued at any time.</p>
    </Card>

    <Card title="acceptable use">
      <ul>
        <li>Don't attempt to break, overload, or abuse the service. Automated credential attacks are rate-limited and may be blocked.</li>
        <li>Don't use it for anything illegal or to harm others.</li>
        <li>You are responsible for keeping your password and recovery codes safe.</li>
        <li>Accounts used for abuse may be suspended or removed.</li>
      </ul>
    </Card>

    <Card title="your content & apps">
      <p>You own the account data you provide. If you register developer apps, you're responsible for how they use the access you're granted, and for your own app's terms and privacy toward its users.</p>
    </Card>

    <Card title="liability">
      <p>To the extent permitted by law, the operator is not liable for any loss or damage arising from use of the service. Your sole remedy is to stop using it and delete your account.</p>
    </Card>

    <div class="mw-section">
      <h2>contact</h2>
      <ContactLinks />
    </div>
    <p class="mw-muted">See also our <a href="/privacy">privacy policy</a>.</p>
  </div>
</Layout>
```

- [ ] **Step 2: Build check.** Run: `bun run --filter @meowerse/auth-web build`

- [ ] **Step 3: Commit**

```bash
git add apps/auth-web/src/pages/terms.astro
git commit -m "feat(auth-web): /terms page"
```

---

## Task 4: Verify footer links + full gate + smoke

**Files:** none (verification)

- [ ] **Step 1: Full build**

Run: `bun run --filter @meowerse/auth-web lint && bun run --filter @meowerse/auth-web build`
Expected: `/about`, `/privacy`, `/terms` in `dist/`; 0 type errors.

- [ ] **Step 2: Smoke test the footer links**

With the preview dev server (from Plan 3 Task 12), from `/` click the footer's `about` / `privacy` / `terms` — each loads its page, styled, in both themes, with the contact icon-links opening the right URLs (`preview_snapshot` to confirm link hrefs).

- [ ] **Step 3: Monorepo gate**

Run: `cd C:/code/meow/meowerse && just lint && just test`
Expected: green.

- [ ] **Step 4: Commit (if any tweaks)**

```bash
git add apps/auth-web
git commit -m "test(auth-web): verify legal pages + footer links render"
```

---

## Self-review checklist

- **Spec coverage (§16):** `/about` (Task 1) · `/privacy` accurate to the schema — collection, per-scope sharing, hashed-IP rate limits, no-email/no-tracking, processors, retention, rights incl. account deletion (Task 2) · `/terms` personal-project as-is framing + acceptable use (Task 3) · `ContactLinks` on all three + footer already links them (Plan 1/3).
- **Factual accuracy:** every privacy claim matches `workers/auth/src/db.ts` + `packages/auth-shared` scopes + Plan 2's deletion. No invented data categories, no email, no analytics.
- **Placeholder scan:** none — full page content in every step.

## Notes for the implementer

- `ContactLinks` renders as plain anchor tags, so it works in a static Astro page with no `client:` directive.
- Content is written in normal case in source; the global lowercase transform styles it — `code`/emails/URLs stay real-case via `.mono`/`data-case="preserve"` and the `ContactLinks` hrefs.
- If the operator later forms a legal entity, only the framing lines in `/terms` + `/privacy` headers need updating — the factual sections stay valid.
```
