# Meowerse Design System — Design Spec

Date: 2026-07-03
Status: Approved (brainstorming), pending implementation plan
Package: `@meowerse/ui`

## 1. Goal

One shared design system for every meowerse frontend (`apps/auth-web`, `apps/web`,
and future apps), so UIs are consistent, on-brand, fast, accessible, and buildable
to Cloudflare Pages with zero extra config. It unifies the existing meowsenger house
style (NextMeowsenger + LibMeowsenger) into a single canonical token set + primitive
library, and migrates `apps/auth-web` onto it.

The look: modern, flat, **lowercase**, one bright-green accent over near-ink neutrals.
No gradients, no glow, no second accent. Clean like airbnb / bidmyauto, playful like
meowsenger.

## 2. Locked decisions (from brainstorming)

- **Accent**: brand green `#00ff82` — used as a *fill* with near-black text on top
  (15.6:1), never as green text on white (1.3:1, fails). A single darker green
  `#0a7a42` is derived for the rare "green link/text on a light surface" case
  (5.2:1 on `#fafafa`, passes AA). No second bright accent — restraint is the point.
- **Neutrals**: near-ink, never pure. `#141414` ink / `#f2f2f2` inverse, not `#000`/`#fff`
  (avoids the "flashbang"; still AAA).
- **Both light + dark**, default = **follow system** (`prefers-color-scheme`), remember
  the user's manual toggle after.
- **Lowercase everything** via CSS `text-transform`, **except** a `mono`/code class —
  recovery codes, API keys, one-time codes, hashes, and passwords render in their true
  case (case is meaningful there; lowercasing would mislead reading/copying). This is a
  hard carve-out, not a style preference.
- **Fonts** (all OFL, self-hosted via Fontsource — no external CDN):
  - UI sans: **Outfit** (geometric, single-storey "circle + line" `a`, variable).
  - Functional mono: **JetBrains Mono** (slashed zero, disambiguated `I/l/1`, copy-safe).
  - Display accent: **Bytesized** (pixel/retro) — big brand moments only (logo, 404,
    hero numbers), never functional codes.
- **Scope of this deliverable**: build `@meowerse/ui`, fully migrate `apps/auth-web`,
  light-touch wire `apps/web` to the tokens.

## 3. Package architecture

`packages/ui` mirrors `packages/ts-shared` and is **consumed as source** — apps import
the package name and Vite/Astro transpile the `.tsx` + bundle the CSS at app build time
(exactly as `ts-shared` points `main` at `src/index.ts`). Consequences:

- **No build step required** for consumption (no `dist/`, no Windows `cp` copy problem).
  Turbo's `build` task runs `tsc --noEmit` for typecheck only.
- **No external CDN, no runtime dependency.** Fonts self-hosted as static woff2.
- Works identically for every Astro + React frontend and deploys unchanged to
  Cloudflare Pages.

```
packages/ui/
  package.json          # @meowerse/ui, exports map, fontsource deps
  tsconfig.json         # extends ../../tsconfig.base.json
  src/
    index.ts            # export all primitives + ThemeToggle + theme script string
    styles/
      tokens.css        # CSS custom properties, both themes, reset, lowercase rule
      fonts.css         # @import fontsource (Outfit variable, JetBrains Mono, Bytesized)
    components/
      Button.tsx  Field.tsx  Checkbox.tsx  RadioGroup.tsx  Card.tsx  Badge.tsx
      Alert.tsx  Modal.tsx  ConfirmDialog.tsx  Code.tsx  RecoveryCodes.tsx
      Avatar.tsx  Toast.tsx  Spinner.tsx  AppHeader.tsx  ThemeToggle.tsx
    lib/
      theme.ts          # no-flash theme init script + toggle helper
    test/               # vitest + @testing-library/react per primitive
```

`package.json` exports:

```jsonc
{
  "name": "@meowerse/ui",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./tokens.css": "./src/styles/tokens.css"
  },
  "scripts": { "lint": "tsc --noEmit", "test": "vitest run --coverage" }
}
```

Apps consume: `import "@meowerse/ui/tokens.css"` (in the Astro layout) and
`import { Button, ConfirmDialog } from "@meowerse/ui"` (in React islands).

## 4. Token system

All tokens are CSS custom properties on `:root`, prefixed `--mw-` for brand/one-off and
purpose names for the rest. Dark values under `[data-theme="dark"]` and, when no explicit
choice is stored, `@media (prefers-color-scheme: dark)`.

`tokens.css` begins with `@import "./fonts.css";` (which pulls the Fontsource woff2 for
Outfit / JetBrains Mono / Bytesized), so a single `import "@meowerse/ui/tokens.css"` in a
layout loads tokens **and** fonts — an app can't half-load the type. Vite resolves the
bare Fontsource specifiers and emits the woff2 into `dist/`.

### Brand
| Token | Light | Dark | Use |
|---|---|---|---|
| `--mw-green` | `#00ff82` | `#00ff82` | accent fill (stable both modes) |
| `--mw-green-hover` | `#00e676` | `#00e676` | accent fill hover |
| `--mw-on-green` | `#06331b` | `#06331b` | text/icon on green fill |
| `--text-accent` | `#0a7a42` | `#00ff82` | green as link/text |

### Neutrals
| Token | Light | Dark |
|---|---|---|
| `--surface-0` (page) | `#fafafa` | `#0d0d0d` |
| `--surface-1` (card/panel) | `#ffffff` | `#161616` |
| `--surface-2` (raised/popover) | `#ffffff` | `#1c1c1c` |
| `--surface-muted` (chip) | `#f0f0ee` | `#222222` |
| `--text-primary` (ink) | `#141414` | `#f2f2f2` |
| `--text-secondary` | `#52514e` | `#a8a8a2` |
| `--text-muted` | `#8a8a85` | `#8a8a85` |
| `--border` | `#e6e6e3` | `#2a2a2a` |
| `--border-strong` | `#d4d4d0` | `#3a3a3a` |

### Semantic
| Token | Light | Dark | Use |
|---|---|---|---|
| `--danger` | `#ef4444` | `#ef4444` | destructive fill |
| `--on-danger` | `#ffffff` | `#ffffff` | text on danger fill |
| `--text-danger` | `#b42318` | `#ff8f8f` | danger text/inline alert |
| `--bg-danger` | `rgba(239,68,68,.10)` | `rgba(239,68,68,.14)` | danger tint surface |
| `--success` | `#17803d` | `#34e78f` | success text/icon |
| `--warning` | `#b45309` | `#f5a524` | warning text |

Green is the success/verified color visually (checkmarks, verified badge); `--success`
text token is a green that meets contrast on light.

### Radius / spacing / type / motion
- `--radius-sm` 6px · `--radius` 8px (controls) · `--radius-lg` 12px (cards) · pill 999px.
- gap/pad scale (4px base): `--gap-xs` 4 · `sm` 8 · `md` 12 · `lg` 16 · `xl` 24 · `2xl` 32.
- `--font-sans`: `"Outfit Variable", system-ui, sans-serif`
- `--font-mono`: `"JetBrains Mono", ui-monospace, monospace`
- `--font-display`: `"Bytesized", var(--font-sans)`
- sizes: `--text-xs` 12 · `sm` 13 · `base` 14 · `md` 16 · `lg` 18 · `xl` 22 · `2xl` 28; line-height 1.5.
- weights used: 400, 500, 600, 700.
- `--dur-fast` 120ms · `--dur` 180ms · `--ease` `cubic-bezier(.4,0,.2,1)`.

### Base rules in `tokens.css`
- box-sizing reset, margin reset, `:focus-visible` → 2px green ring (`box-shadow: 0 0 0 2px var(--mw-green)`).
- Global lowercase: `body { text-transform: lowercase; }` with escape hatch
  `.mono, code, kbd, samp, .cs, [data-case="preserve"] { text-transform: none; }`.
  The `Code`, `RecoveryCodes`, and any secret display use `.mono`/`data-case="preserve"`.

## 5. Component inventory

Only what `apps/auth-web` needs plus obvious reuse. YAGNI on Select, Tabs, Tooltip,
Dropdown, DatePicker until a real screen needs them.

| Component | Purpose | Key props / states |
|---|---|---|
| `Button` | actions | `variant`: primary(green) / secondary(outline) / ghost / danger; `size` sm/md; `loading`; `as` (a/button) |
| `Field` / `Input` | labeled input | label, hint, error, `type` (text/password), password reveal toggle |
| `Checkbox` | scope consent, toggles | checked, disabled, label |
| `RadioGroup` | client type (public/confidential), etc. | options, value, onChange |
| `Card` | bounded surface | padding, optional header |
| `Badge` | verified / status | `variant`: verified(green) / neutral / danger; icon |
| `Alert` | inline error/success/info | `variant`, dismissible |
| `Modal` | dialog base | open, onClose, focus-trap, Esc, faux-viewport safe |
| `ConfirmDialog` | dangerous-action pattern | title, body(consequence), confirmLabel, `variant` danger, optional `confirmPhrase` (type-to-confirm), optional `requirePassword` |
| `Code` / `CodeBlock` | mono value + copy | value, copy button, case-preserved |
| `RecoveryCodes` | one-time codes | codes[], copy-all, download |
| `Avatar` | initials circle | name, size sm/md/lg |
| `Toast` | action feedback | message, `variant`, auto-dismiss; provider + `useToast()` |
| `Spinner` | loading | size |
| `AppHeader` | brand + nav + theme toggle | two states (guest/authed), current path |
| `Footer` | site footer | brand, legal + dev links, `ContactLinks` |
| `ContactLinks` | icon links to owner channels | email/telegram/instagram/github/linkedin, `aria-label`ed |
| `ThemeToggle` | light/dark switch | reads/writes localStorage |
| `AuthGate` | client-side page guard | checks `/api/session`; renders skeleton → content or redirects to `/login?next=` |

All components: className passthrough, forwardRef where it matters, aria wired, keyboard
support, focus-visible green ring.

## 6. Dangerous-action UX — tiers

Confirmation friction scales with blast radius, so it's protective without being naggy.

| Action (auth-web) | Tier | Treatment |
|---|---|---|
| toggle setting, edit display name, create client, consent allow/deny, navigate | 0 — none | act immediately, `Toast` on success |
| revoke a connected app's access | 1 — confirm modal | `ConfirmDialog` danger, names consequence |
| rotate client secret | 1 — confirm modal | danger; "old secret stops working now" |
| regenerate recovery codes | 1 — confirm modal | "your old codes stop working now"; show new codes after |
| sign out everywhere | 1 — confirm modal | danger |
| delete an OAuth client | 2 — type-to-confirm | type the app name; breaks the integration for all its users |
| **delete your account** | 2 — type-to-confirm | type username; irreversible, cascades all data; needs new `POST /api/account/delete` |
| change password | 3 — re-auth | already requires current password ✓ (keep) |
| unlink Telegram when it's the only auth factor | 3 — hard warn | warn user they may lock themselves out; block if truly last factor |

`ConfirmDialog` implements tiers 1–2 via `confirmPhrase`; tier 3 via `requirePassword`
(and the existing current-password field for password change).

## 7. Theme strategy

- No-flash: a tiny synchronous script (exported string from `lib/theme.ts`) runs in
  `<head>` before paint — reads `localStorage.mw-theme`, else `prefers-color-scheme`,
  sets `data-theme` on `<html>`. Prevents FOUC.
- `ThemeToggle` writes `localStorage.mw-theme` and flips `data-theme`.
- CSS: `:root` = light; `[data-theme="dark"]` = dark; plus a `@media (prefers-color-scheme: dark)`
  block scoped to `:root:not([data-theme="light"])` so system dark works before JS runs.
- **No transition slide on init** (review caveat): the sync script adds `.mw-no-transitions`
  to `<html>` while it sets the theme, removed on the next frame (`requestAnimationFrame`).
  Surface/background tokens carry no global `transition` — only interactive states do — so
  first paint never animates a color slide.

## 8. Accessibility

- WCAG AA minimum on all text (verified: green-ink 5.2:1, near-ink 18:1).
- `:focus-visible` green ring on every interactive element.
- `Modal`/`ConfirmDialog`: focus trap, restore focus on close, Esc to close, `role="dialog"`
  + `aria-modal`, labelled by title.
- Icons decorative → `aria-hidden`; icon-only buttons → `aria-label`.
- Color never the only signal (badges/alerts pair icon + text).
- Respect `prefers-reduced-motion` (disable non-essential transitions).

## 9. Migration

### apps/auth-web (full)
- Add `@meowerse/ui` (`workspace:*`) dep.
- `Layout.astro`: drop the inline `<style>`, `import "@meowerse/ui/tokens.css"` **in the
  Astro layout frontmatter** (not inside a React island — review caveat: Astro may not copy
  font CSS imported only across the island barrier; importing in the layout guarantees the
  woff2 land in `dist/`), add the no-flash theme script, render `AppHeader` + `Footer`.
  Components must carry **no implicit global-style dependency** (no Tailwind, no ambient
  reset) — they read only `@meowerse/ui` tokens, so the single layout import is enough.
- Rebuild all components on primitives: `LoginForm`, `SignupForm`, `ConsentForm`
  (scope `Checkbox`es), `AccountSettings`, `Dashboard`, `TelegramButton`, `verify`.
- Wire confirm tiers into: revoke app, delete client (type-to-confirm), rotate secret,
  unlink Telegram, regenerate recovery codes, sign out everywhere.
- Replace ad-hoc success/error `<p>` with `Alert` / `Toast`.
- Keep the CSP `public/_headers` — fonts are self-hosted, so no new external origins;
  verify `style-src`/`font-src` stay same-origin.

### apps/web (light touch)
- Add dep, `import "@meowerse/ui/tokens.css"`, swap the bare `MeowList` tags for
  `Button` / `Field`. No full redesign this round.

## 10. Testing

- Each primitive: `vitest` + `@testing-library/react` — renders variants, handles
  interaction, enforces the lowercase carve-out (`Code` preserves case), `ConfirmDialog`
  blocks confirm until phrase matches / password entered, `Modal` traps focus + Esc,
  `ThemeToggle` flips `data-theme`.
- Keep the repo's 90% coverage gate (`bunfig.toml`).
- auth-web: existing lib tests stay green; add interaction tests for the newly-wired
  confirm flows.

## 11. Build / deploy impact

- No change to deploy scripts (`infra/cloudflare/deploy-*.sh`) — still `wrangler pages deploy dist`.
- Turbo builds `@meowerse/ui` typecheck before apps via `^build` + workspace dep.
- Font woff2 ship as static assets in each app's `dist/` (bundled by Vite from fontsource).
- CSP unchanged (same-origin fonts/styles).

## 12. Out of scope (future)

- The "vibecode authorization in code, not just UI" IaC angle (`auth.config.ts`) already
  exists via `@meowerse/auth-sdk` — untouched here.
- Extra primitives (Select, Tabs, Tooltip, Dropdown, DataTable) — add when a screen needs one.
- A full `apps/web` redesign — later.
- Storybook / a hosted component gallery — nice-to-have, not now.

## 13. Success criteria

- `@meowerse/ui` builds (typecheck) + tests pass at ≥90% branch.
- `apps/auth-web` fully migrated: every screen uses primitives, dark/light + toggle work
  with no FOUC, all lowercase with codes case-preserved, confirm tiers wired.
- `just lint` + `just test` green across the monorepo.
- Both apps deploy to Cloudflare Pages unchanged and render correctly in both themes.

## 14. auth-web information architecture & route protection

Static Astro pages, so **guards are UX; the API is the real wall** (every `/api/account`
and `/api/dev` route already returns `401 {error:"no_session"}` for guests). No page
guard can leak data because the server enforces auth on every call.

### Session detection
Add `GET /api/session` (see §15) → `{authenticated, username, verified}`. The header and
guarded pages call it once. The `__Host-mw_sess` cookie is HttpOnly, so JS can't read auth
state directly — this cheap endpoint is the sanctioned way to know.

### Header — two states
Neutral first paint (brand + theme toggle only) to avoid a flash of the wrong nav; then
`/api/session` resolves it:
- **guest** → brand · about · developers · `log in` · `sign up` · theme
- **authed** → brand · account · developers · theme · avatar menu (username → sign out)

### AuthGate (fixes the infinite-load bug)
`/account` and `/developers` wrap their island in `AuthGate`: render a **neutral centered
loader (not a content skeleton)**, call `/api/session`; if not authenticated →
`location.replace("/login?next=<path>")`; else mount the real island. Guests never mount the
heavy island, so they never hit the fallthrough. The neutral loader matters: a fake account
skeleton implies content is coming, so the redirect reads as bait-and-switch; a plain
loader → redirect reads as intentional (the unavoidable one round-trip on a static host).
Root cause of the current infinite load: `AccountSettings` renders `Loading…` forever when
`getAccount` errors with anything other than `no_session` (no generic error branch). Fixes:
1. `authApi` helpers become status-aware — inspect `res.status`, return typed
   `{error: "no_session" | "http" | "network"}` deterministically (never silently `.json()`
   a 401/404).
2. Every guarded component renders a resolved state for every case (content · sign-in ·
   error-with-retry) — no unbounded loading fallback.
3. Verify the worker's `401` responses carry CORS headers (else the browser blocks the body
   read and the client sees a network error).

### Pages vs modals
- **Pages** (deep-linkable / OIDC targets / full decisions): `/`, `/login`, `/signup`,
  `/consent`, `/verify`, `/account`, `/developers`, `/about`, `/privacy`, `/terms`,
  `/error`, `/404`.
- **Modals** (sub-actions, not deep-linked): change password, revoke app, delete client
  (type-to-confirm), rotate secret, unlink Telegram, regenerate recovery codes, sign out
  everywhere, delete account (type-to-confirm), create client.
- **Developers split**: a public "build on meowerse" marketing view for guests (kills the
  current create-account-looking form a guest sees), and the real dashboard for authed
  owners. Login/signup stay separate pages (OIDC deep-links) but cross-link.
- Every page gets the shared `Footer` (about · privacy · terms · developers · `ContactLinks`).

## 15. Backend additions (workers/auth)

Two small, tested endpoints — everything else already exists.

- `GET /api/session` — reads the session cookie, returns `{authenticated: bool, username?,
  verified?}` (no PII beyond username; `verified` derived live). 200 always (guests get
  `{authenticated:false}`), CORS + `no-store`. Cheap; powers header + `AuthGate`.
- `POST /api/account/delete` — session + CSRF + **type-username confirmation** in body;
  clears the session cookie, returns `{ok:true}`. Right-to-erasure path for the privacy policy.
  - **Do NOT rely on `ON DELETE CASCADE`.** The schema declares it (`db.ts`), but the worker
    never sets `PRAGMA foreign_keys = ON` and Turso's stateless HTTP won't persist it, so
    SQLite FK enforcement stays off and cascades silently no-op. The worker's `DbClient`
    interface also exposes only `.execute()` (no `.batch()`), and cross-execute transactions
    don't hold over stateless HTTP — so delete with **sequential `db.execute` `DELETE`s,
    children first and the `accounts` row LAST** (retry-safe: a partial failure leaves the
    account intact so a retry completes it). Order: for each owned client — its secrets,
    redirect_uris, consents; then account-keyed rows — recovery_codes, password_credentials,
    telegram_links, sessions, consents, access_tokens, refresh_tokens, management_tokens,
    oauth_codes, login_requests, login_tickets; then owned oauth_clients; finally accounts.
    Owned clients breaking their RP integrations is expected and documented on the confirm modal.
- Tests (vitest, repo 90% branch gate): `/api/session` authed vs guest; delete happy-path,
  wrong-confirmation rejected, missing-CSRF rejected, and **every child table emptied**
  verified via `memStore` (proves the explicit batch, not a cascade that never runs).

## 16. Legal & content pages

Written from the **real** data model (§ investigation), honest personal-project framing, no
invented claims, plain language, GDPR-friendly. Contact via `ContactLinks`
(email `aleksandrnyrko@gmail.com`, Telegram `t.me/ALXNK0`, Instagram/GitHub/LinkedIn `alxnko`).

### /about
What meowerse accounts is: a personal-project single sign-on (OIDC identity provider) that
lets you use one meowerse login across meowerse apps, verify with Telegram, and control which
apps see which data. What it is not: a company, not ad-supported, no tracking.

### /privacy (truthful, from the schema)
- **What we collect**: username; optional display name + avatar URL; a password (stored only
  as a salted PBKDF2-SHA256 hash, 600k iterations — never plaintext); 8 one-time recovery
  codes (stored hashed); if you link Telegram — your Telegram id, username, display name,
  avatar URL; a verified flag (derived from whether Telegram is linked); timestamps.
- **Sessions & security data**: a hashed session id + CSRF token (cookie is `__Host-`,
  HttpOnly, Secure, SameSite=Lax); OAuth codes/tokens stored as hashes/ids with short TTLs;
  rate-limit counters keyed on a **hashed** IP (signup) or **hashed** username (login) — we
  do not store your raw IP.
- **What we share with apps** — only with your per-scope consent, and you can revoke anytime:
  `openid` → an opaque account id (no personal info); `profile` → username, display name,
  avatar; `telegram` → Telegram id + username; `verified` → true/false.
- **What we do NOT do**: no email collected, no SMS, no analytics or trackers, no third-party
  advertising cookies, no selling or sharing data beyond the processors below.
- **Processors**: Turso (database), Cloudflare (Workers + Pages hosting, edge request logs),
  Telegram (only if you use Telegram sign-in/verify).
- **Retention**: sessions ≤30 days, tokens minutes, auth codes 60s; account data kept until
  you delete your account or unlink Telegram.
- **Your rights**: see your data (account page), edit display name/avatar, **delete your
  account** (§15), revoke app access, withdraw consent. Contact via `ContactLinks`.

### /terms
Personal-project terms: provided as-is, best-effort, no warranty/SLA; acceptable-use (no
abuse, no automated credential attacks — rate-limited and may be blocked); accounts may be
suspended for abuse; you own your content; the operator may change or discontinue the service;
governing framing kept minimal (individual operator, not a company); contact via `ContactLinks`.

### Success additions
- Header shows correct guest/authed nav; `/account` + `/developers` never infinite-load
  (guest → redirect to login).
- `/about`, `/privacy`, `/terms`, `/404` exist, styled, linked in the footer, factually
  accurate to the code.
- `GET /api/session` + `POST /api/account/delete` shipped with tests; deletion reachable from
  the account page behind type-to-confirm.
