# Brand v2 — meowerse on the alxnko.dev design system

Status: draft for owner review · Date: 2026-09-24 · Decisions: `docs/superpowers/decisions/2026-09-24-brand-v2-log.md`
(B1–B10). Where this spec and the log disagree, the log wins and this spec is corrected.

## 1. Goal and scope

Move the meowerse design library and every meowerse frontend onto the alxnko.dev design system, and
use the pass to fix existing UX, accessibility, performance and security problems (B1, B7).

In scope (B2): `packages/ui`, `packages/brand`, `apps/web` (meow.alxnko.dev), `apps/auth-web`
(auth.alxnko.dev), `apps/meowsenger-web` (meowsenger.alxnko.dev), and retiring `apps/alxnko-dev`.
Out of scope: NextMeowsenger, LibMeowsenger, moonmeow, sunmeow, and the `alxnko.dev` repo (the source
of the design, not a target).

Fidelity (B3): "same system, app-shaped". Same tokens, type, colour and voice as alxnko.dev, but
normal app UX (real forms, buttons, chat bubbles) that non-technical people can use.

## 2. Foundations

### 2.1 Tokens

The source is alxnko.dev `design/tokens.json`. `packages/ui` gets its own copy; a drift check in CI
compares the two (B5).

| Group | Values |
|---|---|
| dark (default) | bg `#0a0a0b` · bgElev `#111113` · surface `#151517` · line `#232326` · lineStrong `#404044` · fg `#ededeb` · fgMuted `#b3b3af` · fgSubtle `#8c8c88` · accent/accentFill/focus `#00ff82` · onAccent `#06170d` · warn `#ffb454` · danger `#ff6b63` |
| light ("day paper") | bg `#e9e8e4` · bgElev `#f1f0ec` · surface `#dfded9` · line `#cfcec8` · lineStrong `#a9a8a2` · fg `#1a1a1c` · fgMuted `#46464a` · fgSubtle `#5e5e5b` · accent/focus `#0a6e3c` (text-safe green) · accentFill `#00ff82` · onAccent `#06170d` · warn `#8a5200` · danger `#b42318` |
| ansi | the alxnko.dev 16-colour palette, used only for status/terminal glyphs |
| space | 0 4 8 12 16 24 32 48 64 |
| radius | s 2 · m 4 · l 8 |
| type scale | 12 13 14 16 20 28 40 |
| motion | ease `cubic-bezier(.16,1,.3,1)` · fast 120 · base 240 · slow 600 ms |
| z | stage 0 · chrome 10 · dock 20 · sheet 30 · skip 100 |

- The theme follows the system (dark by default), with a manual toggle stored per origin.
- The current `--mw-*` / `--surface-*` / `--text-*` variables stay as aliases to the new tokens for
  one release, then are removed. The full mapping table comes from audit `web-and-ui` (§6).
- Rule: green is for the one primary action, focus and "live/ok" state. Never two green buttons on a
  screen, and never green body text in light mode (use `accent` #0a6e3c, not `accentFill`).

### 2.2 Type

- JetBrains Mono for everything, as woff2 at 400 and 700, with the Latin + Cyrillic + symbols
  `unicode-range` subset built by the same script alxnko.dev uses.
- VT323 appears only in the wordmarks (`meowerse_`, `meowsenger_`, `auth_`), as glyph-subset woff2
  files.
- Outfit and Bytesized are dropped (about −60 KB).
- Body text is 14/16 with line-height 1.5; the minimum is 12 for meta text, never for inputs (16 on
  phones, to avoid iOS zoom).

### 2.3 Voice

Lowercase, calm, short. tty flavour lives in small details:
- the `›` prompt glyph;
- a block cursor on the wordmark;
- `[ ok ]` / `[fail]` status lines.

Lowercase is written into our own copy, never applied with a global `text-transform`. User content is always shown exactly as typed (B14).
Errors say what happened and what to do, in plain words ("wrong password — try again or reset it"),
never a code alone.

### 2.4 Accessibility baseline

- Contrast is AA or better for every token pair used for text, checked by an automated test.
- 2 px focus ring in `focus`, offset 2 px, on every interactive element.
- Targets are at least 44×44 px.
- `prefers-reduced-motion` turns off all non-essential motion.
- Live regions for toasts and new messages.
- No information carried by colour alone: status always has a glyph and a word.

## 3. Components (`@meowerse/ui` v2)

- **Existing 20:** restyle all of them with their APIs kept (Alert, AppHeader, AuthGate, Avatar,
  Badge, Button, Card, Checkbox, Code, ConfirmDialog, ContactLinks, Field, Footer, Icon, Modal,
  RadioGroup, RecoveryCodes, Spinner, ThemeToggle, Toast). Fix each API or a11y issue the audit finds.
- **New:**
  - `Wordmark`: VT323 with a blinking cursor, static under reduced motion.
  - `Prompt`: the `›` input row, see §7.
  - `Cursor`.
  - `Kbd`.
  - `StatusLine`: `[ ok ]` / `[wait]` / `[fail]` plus text.
  - `Cat3D`: see §4.
- **Components that apps re-implement** (e.g. meowsenger's `Avatar`) move into `@meowerse/ui` where
  they are the same thing. The list comes from the audit.
- **Gallery:** the public UI docs at meow.alxnko.dev/ui (§5.2) render every component in every state,
  with phone and desktop sizes and light and dark themes side by side. Playwright screenshot tests run
  against them.

## 4. Cat3D (B4)

- The low-poly green cat from the alxnko.dev desk scene, exported from its Blender file as a small
  mesh (target 15–25 KB, quantised).
- It uses a custom WebGL2 renderer of about 6–8 KB gz, with flat shading and one light. No three.js.
- The head eases toward the cursor, or toward the finger on touch.
- It is lazy-loaded after first paint, when visible, and never blocks input.
- It falls back to a static image (the same pose) when:
  - WebGL is unavailable;
  - motion is reduced;
  - saving data;
  - load fails.
- It appears only in the meow.alxnko.dev hero and beside auth sign-in. There's no 3D in meowsenger.
- It is decorative only (`aria-hidden`), so failure costs nothing.

## 5. Apps

- **web (meow.alxnko.dev):**
  - the wordmark and the cat;
  - an `ls ~/services` list of services with live status (`StatusLine`), each with a timeout and an
    "unknown" state rather than hanging.
- See §5.1 and §5.2 for the project pages and the UI docs that also live on meow.alxnko.dev (B11,
  B12). It is a full redesign, not a re-token (B12a).
- **auth-web:**
  - every page is restyled;
  - OIDC, PKCE, Turnstile, Telegram and the password policy behave exactly as they do today, except
    for audit fixes;
  - the CSP is reviewed and tightened.
- **meowsenger-web:**
  - a full restyle with the composer as a prompt (§7);
  - the current performance is the floor.
- **Cleanup:** remove `apps/alxnko-dev` using the checklist from the audit.

### 5.1 Project pages (B11)

- There is one page per project at `/p/<slug>`. Each page has:
  - a one-line summary;
  - "what it is" in plain words for non-technical readers;
  - "how it works": a short technical section plus a small diagram (inline SVG, both themes);
  - live status (`StatusLine`, with a timeout);
  - an "open" link that opens in a new tab.
- Content lives in typed content files (Astro content collections) and is validated at build time.
- Public facts only: no secrets, internal hostnames, IPs or infra details beyond what is already
  public.
- Projects (B13):
  - auth
  - meowsenger
  - the UI library
  - moonmeow
  - sunmeow
  - alxnko.dev
- The moonmeow and sunmeow pages carry no network, Tailscale, IP or pairing details.
- The alxnko.dev page shows neither the real name nor the company.

### 5.2 UI docs (B12)

meow.alxnko.dev/ui holds the public docs of `@meowerse/ui`, the system alxnko.dev is built from.

- **Foundations:**
  - every token with a swatch and its value in dark and light;
  - the type scale, spacing, radii, motion (with live demos), z layers;
  - voice and microcopy rules;
  - contrast results.
- **Components:** one page each, with:
  - a live preview of every variant and state;
  - a props table and a CSS custom property table, generated from the TypeScript types and the
    token file so they can't drift;
  - copyable usage snippets (React and plain HTML/CSS where it applies);
  - accessibility notes (keyboard, ARIA);
  - do and don't examples.
- **Playground:** a panel that changes the theme, the props, and the token overrides (accent, radius
  scale, density) live, and shows the resulting snippet. Overrides are scoped to the preview and kept
  in the URL so they can be shared, never on the server.
- **Patterns:**
  - the tty/app "together" page (B10);
  - forms;
  - empty, loading and error states (B9);
  - the chat composer.
- **Cat3D:** a demo with its fallback.
- The docs are static, prerendered, with lazy islands only for live previews and the playground, so
  they stay within the same Lighthouse and CSP bar.

Order, one PR per sub-project, each merged with a merge commit and deployed with `just deploy-*` then
verified live:

1. DS v2 plus Cat3D
2. web (redesign, project pages, UI docs)
3. auth-web
4. meowsenger-web
5. cleanup

## 6. Existing issues (B7)

The audits live under `docs/superpowers/audits/2026-09-24-*.md`:
- `auth-web` (A-xx)
- `meowsenger-web` (M-xx)
- `web-and-ui` (W-xx, U-xx, L-xx)

Every finding is either fixed in the sub-project named for it or explicitly deferred here with a
reason. A per-finding table is added to this section once the audits are in.

## 7. Terminal styling, per element (B8)

Terminal styling is used only where it keeps or improves usability.

| Element | Treatment | Why |
|---|---|---|
| Wordmarks / headers | VT323 `name_` plus cursor | pure brand, no interaction cost |
| Chat composer | a `›` glyph before a normal auto-growing textarea, with placeholder text ("message"), a visible send button, Enter to send, Shift+Enter for a newline (on phones Enter inserts a newline and the button sends), IME-safe (no send while composing) | reads as a prompt while staying a standard, discoverable input |
| Status / connection | `StatusLine`, e.g. `[wait] connecting…` → `[ ok ] online` | a clear, glanceable state, always with text |
| Empty states | a short tty line plus one plain action button | friendly and explicit |
| Code, ids, keys | `Code` / `Kbd` | already monospace content |
| Auth forms | normal labelled fields; only the page title carries the prompt style | forms must stay familiar for trust and autofill |
| Buttons, menus, dialogs | normal app components in the shared tokens | tty-looking buttons hurt discoverability |

Composer and chat geometry (from audit M, B10):
- **Prompt field:**
  - at least 44 px tall, 1 px `line` border, 4 px radius, 32 px left padding;
  - the `›` glyph is 16 px, aligned to the first text line, `fgSubtle` at rest and `accent` on focus;
  - the field is never disabled: sends queue in an outbox instead.
- **Send button:** 44×44, 4 px radius, aligned to the bottom of the field.
- **Bubbles:**
  - 8 px radius, with a 2 px corner on the sender's side;
  - 8/12 px padding, 12 px meta text;
  - at most about 62 characters wide.
- **Avatars:** rounded squares with a 4 px radius.
- **Sidebar:** the active row gets a 2 px `accent` bar on its left; there's no `›` on rows or on the search box.
- **Connection:** a `StatusLine` in the header, shown only while the connection isn't ok.
- **Avoid:**
  - a borderless command-line input;
  - a blinking block cursor in the field;
  - `[send]` bracket buttons;
  - black terminal panels.

The audit's verdicts can adjust rows. Every change is recorded here and in the log.

### 7.1 Cohesion of tty and app elements (B10)

Terminal-styled and app-styled elements are one family and must read as one.

1. **Shared tokens only.** Both kinds use the same surfaces, lines, radii (2/4/8), spacing, type
   scale, focus ring and motion. There's no separate "terminal theme", no black-box terminal panels
   inside light pages, and no CRT effects inside apps.
2. **One font.** JetBrains Mono everywhere means a `›` prompt and a button label share metrics.
   Glyphs such as `›` and `[ ok ]` sit on the same baseline and size as the text next to them.
3. **Same geometry.** A `Prompt` is the same height, border, radius and padding as a `Field` and sits
   flush with a `Button` in a row. `StatusLine` uses the same line height as body text.
4. **Same states.** Hover, focus, disabled, error and loading look the same on both kinds: the same
   ring, the same danger colour, the same disabled opacity plus a reason.
5. **Hierarchy.** At most one tty accent per view region (a header, a composer, a status line).
   Everything else is plain app UI. Green stays reserved as in §2.1.
6. **Verification:**
   - the gallery has a "together" page that places every tty element next to the app components it
     appears with (a composer beside message bubbles and a send button; `StatusLine` in a header with
     an avatar and a menu; a prompt title above an auth form);
   - it is covered by screenshot tests on phone and desktop, in light and dark;
   - each app PR includes screenshots of its real pages and a cohesion check in its review checklist.

## 8. No blocking background logic (B9)

Rules for every app:

1. **Controls reflect real readiness.** A control that needs background work (captcha token, session,
   socket, chunk) is either:
   - disabled, with a visible reason ("verifying you're human…"); or
   - enabled with a working queue that finishes the action once ready.
   
   It is never enabled and then rejected with "not ready".
2. **Every async wait has:**
   - a visible state;
   - a timeout;
   - an error state in plain words;
   - a retry or recovery path.
3. **Failures are handled.** There are no silent `catch` blocks: every failure is shown to the user or
   deliberately ignored with a comment.
4. **Actions are idempotent where they can be.**
   - Double submits are prevented.
   - Sends carry a client id so retries don't duplicate.
5. **State is reconciled on return.** Back/forward and bfcache, visibility changes and reconnects
   re-check the session, the socket and captcha expiry.
6. **Tests.** Each audit finding in this class gets a regression test (unit or Playwright with
   network faults injected).

## 9. Quality bar

- **Tests:**
  - unit (vitest);
  - component;
  - Playwright end-to-end, including network-fault cases;
  - gallery screenshots;
  - token contrast;
  - the token drift check.
- **Performance:**
  - Lighthouse ≥ 95 in every category on each app's main page;
  - JS and CSS budgets per app, set from today's sizes as ceilings;
  - fonts preloaded and subset;
  - Cat3D is lazy and outside the budget of the critical path.
- **Security:**
  - strict CSP (hash-based or nonce-based, no `unsafe-inline` scripts);
  - HSTS, `frame-ancestors`, `Referrer-Policy`, `Permissions-Policy`;
  - `rel="noopener noreferrer"` on every external link;
  - no tokens in URLs or localStorage beyond what the auth design already allows.
- **Process:**
  - every sub-project gets a code review against this spec and the log before its PR;
  - CI must be green;
  - merge with a merge commit;
  - deploy and verify live;
  - update the log's status column.
