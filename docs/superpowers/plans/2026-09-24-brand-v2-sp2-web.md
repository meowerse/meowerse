# Brand v2, sub-project 2: meow.alxnko.dev redesign, project pages and the `/ui` docs. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild meow.alxnko.dev on `@meowerse/ui` v2 as a static, strictly secured site: a hero with the
wordmark and Cat3D, a live `ls ~/services` status list, one page per project (B11, B13), and the public
`/ui` design-system docs generated from the source (B12), then deploy it and point `meow.alxnko.eu.org`
at it (B24).

**Architecture:**
- **Static Astro 7 site, no server.** Every page is prerendered. React components from `@meowerse/ui`
  render to static HTML at build time. JavaScript ships only where a page needs it:
  - small vanilla modules for the status probes, the theme button, copy buttons and the Cat3D attach;
  - React islands only on `/ui` pages, for the interactive demos (`client:visible`) and the
    playground (`client:only`).
  - The home page, the project pages and the foundations pages ship no React at all.
- **One stylesheet, inlined.** `src/styles/site.css` imports `@meowerse/ui/tokens.css` and holds every
  site rule. It is imported once, in `BaseLayout`, and `build.inlineStylesheets: "always"` inlines it,
  so every page carries the same `<style>` (one CSP hash) and there is no render-blocking CSS request.
  No `.astro` file has a `<style>` block.
- **Security headers are computed after the build.** `scripts/postbuild.ts` hashes every inline
  `<script>`/`<style>` in `dist/`, refuses `style=""` attributes and `data:` URLs, and writes one strict
  CSP (with Trusted Types enforced) into `dist/_headers`. It also writes the sitemap. The probe origins
  in `connect-src` come from the project content files, so they can't drift from what the page fetches.
- **Docs data comes from the source.** A build-time extractor built on the **TypeScript compiler API**
  reads `packages/ui/src/index.ts` and `src/cat3d/index.ts`. For every export it produces:
  - the component props (the type as written, string-literal values, the default from the
    destructuring pattern, required or not, JSDoc);
  - the inherited attribute interfaces;
  - function signatures and constant types.
  - A second extractor reads `components.css`, `tokens.gen.css` and `aliases.css` and lists every CSS
    custom property a component's rules use, with its dark and light values.
  - Code snippets are serialised from the same React elements the previews render (`toJsx`,
    `renderToStaticMarkup`), and demo sources are shown through Vite `?raw` imports.
  - **Why the compiler API rather than `react-docgen-typescript`:** `typescript` 6.0.3 is already in
    the workspace. The compiler API has no compatibility layer to lag behind TS 6, and it reaches
    forwardRef components, inherited DOM attribute interfaces, string-literal unions, destructuring
    defaults and plain function exports with one checker. `react-docgen-typescript` only covers
    components, and would add a dependency that wraps the same API.
- **Projects are typed content.** Six JSON files form an Astro content collection, validated by a zod
  schema that a unit test also runs, together with a public-facts guard (B13).
- **Service status is honest.** Each probe is a CORS `fetch` with a 5 s timeout, `credentials: "omit"`
  and `cache: "no-store"`. The result maps to:
  - `[ ok ]` up;
  - `[fail]` answered with an error;
  - `[info]` unknown (no answer, or unreachable from this browser).

  A "check again" button re-runs the probes and is disabled, with a visible reason, while they run.
  meowsenger's `/health` gains a public CORS header so it can be checked; auth is probed through its
  already public OIDC discovery document.
- **Two small `@meowerse/ui` changes make this possible:**
  - `Icon` stops using `dangerouslySetInnerHTML`, which Trusted Types would block.
  - Cat3D gets a vanilla `attachCat3D()`, so the home page runs it without React. It moves out of
    the root barrel, so apps that don't use it stop emitting its assets.
  - Smaller ui additions: scoped theme classes (for the side-by-side gallery), a metric-matched
    fallback font, the cat colours as tokens, and `contrast()` moved into `src/lib`.

**Tech Stack:** Bun 1.3.14 workspaces, turbo, Astro 7.0.2 + `@astrojs/react` 6.0.0, React 19.2.7,
TypeScript 6.0.3 (compiler API, build time only), zod 4 through `astro/zod`, vitest 4 (node + jsdom),
Playwright 1.63.0 (`@playwright/test`), `@axe-core/playwright`, Lighthouse 13 (through `bunx`,
local gate only), Cloudflare Pages (direct upload with wrangler), Terraform with the Cloudflare
provider.

**Spec:** `docs/superpowers/specs/2026-09-24-brand-v2-design.md` (§3, §4, §5, §5.1, §5.2, §6, §7, §7.1,
§8, §9). Decision log: `docs/superpowers/decisions/2026-09-24-brand-v2-log.md` (B1–B28; the log wins
over the spec). Audit: `docs/superpowers/audits/2026-09-24-web-and-ui.md` (W-01..W-19, §4, §5b, §5c).
Format and conventions: `docs/superpowers/plans/2026-09-24-brand-v2-sp1-design-system.md`.

## Global Constraints

Every task's requirements implicitly include this section.

**Git and process:**
- Worktree `meowerse/.claude/worktrees/brand-v2-sp2`, on branch `feat/brand-v2-sp2`, created from
  `origin/master` (fb6b20f or later). The plan branch `docs/brand-v2-sp2-plan` is merged into it in
  Task 0, so the PR carries this plan.
- One PR for this sub-project into `master`, merged with a merge commit, never a squash.
- Never `--no-verify`.
- Commit messages use Conventional Commits and end with a `Co-Authored-By:` trailer naming the model
  that wrote the commit (SP1 ruling: honest attribution), e.g.
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Heavy or build scratch goes to `/var/tmp/brand-v2/sp2/…`, never `/tmp` (RAM-backed).
- Never modify the main checkout `/home/alxnko/Projects/code/meow/meowerse`. It has an uncommitted
  `infra/deploy-state.json` that isn't ours. The only allowed use is reading its `.env`
  (`set -a; source /home/alxnko/Projects/code/meow/meowerse/.env; set +a`) for deploys and Terraform.
- `just` is not installed locally (SP1 ruling). Run the recipe bodies instead (`bun run lint`,
  `bun run test`, `bun run build`, `bun run --filter @meowerse/ui tokens:drift`). CI has `just`.
- Local ports for this plan are 4370–4379:
  - 4370 is `astro dev`;
  - 4371 is the e2e `serve-dist`;
  - 4372 is the Lighthouse `serve-dist`.
  - Don't kill servers you didn't start.
- Don't touch the moonmeow or sunmeow repos, or their running services. The alxnko.dev repo is
  touched only in Task 2 (a tokens-only PR).

**Design rules** (from SP1, unchanged):
- **Colours:**
  - Colours come only from tokens.
  - Dark is the default and follows the system; there's a light "day paper" theme.
  - Green (`--c-accent-fill`) is only for the one primary action per view, focus, and live/ok.
    Never `accentFill` as text on light.
- **Scale:**
  - Radii are only 2/4/8 px (`--r-s/m/l`).
  - Spacing is only 0 4 8 12 16 24 32 48 64.
  - Type is only 12 13 14 16 20 28 40, and inputs are ≥ 16 px.
- **Interaction:**
  - Every interactive element gets the 2 px `--c-focus` outline with a 2 px offset.
  - Targets are ≥ 44×44 px (inline links inside running prose are the WCAG exception).
  - `prefers-reduced-motion` removes non-essential motion.
- Text contrast is AA, enforced by the token contrast test.
- **B14:**
  - No `text-transform` anywhere.
  - Interface chrome (headings, labels, buttons, nav, status lines) is written in lowercase in the
    source. Long-form prose (project descriptions, rules, notes) keeps sentence case (SP1 Task 2
    ruling).
  - User-typed text in demos is shown exactly as typed.
- **B9:**
  - A control never looks ready while its background work isn't done.
  - Every async wait has a visible state, a timeout, a plain-language error and a retry.
- **B10:** tty elements share the control height, the 1 px `--c-line-input` border, `--r-m`, the focus
  ring and the disabled style with `Field`/`Button`. At most one tty accent per view region.

**Content rules** (B11, B13):
- **Public facts only.**
  - Project copy states only what the repo docs, READMEs and specs say, or what the live site shows.
    If a fact isn't documented, leave it out. Never invent a claim.
  - Never include secrets, internal hostnames, IPs, regions or infra details beyond that.
- **moonmeow and sunmeow:** no network, Tailscale, IP, port or pairing details.
- **The alxnko.dev page:** never the real name, never the company or employer. Only the handle
  "alxnko" identifies anyone on this site.
- NextMeowsenger and LibMeowsenger get no pages.
- **Links:**
  - A link to another origin opens in a new tab with `target="_blank" rel="noopener noreferrer"`, a
    visible `↗` and the screen-reader text "(opens in a new tab)".
  - `mailto:` never gets a target.
  - Same-site navigation stays in the tab.
  - Resolved ambiguity: "links open in a new tab" means external links.

**Security** (spec §9, B16, B26):
- **Static output:** Astro `output: "static"` with `vite.build.assetsInlineLimit: 0`. There are no
  `data:` URLs, and the postbuild fails on any in HTML or CSS (SP1 deferral: consumers keep
  `assetsInlineLimit: 0`).
- **One CSP for every page and the 404, generated at build:**
  - `default-src 'none'`;
  - `script-src 'self' <sha256 hashes>`;
  - `style-src 'self' <sha256 hashes>`;
  - `img-src 'self'`;
  - `font-src 'self'`;
  - `connect-src 'self' <probe origins>`;
  - `manifest-src 'self'`;
  - `base-uri 'none'`;
  - `form-action 'none'`;
  - `frame-ancestors 'none'`;
  - `upgrade-insecure-requests`;
  - `require-trusted-types-for 'script'` and `trusted-types 'none'`.
  - It never contains `'unsafe-inline'` or `'unsafe-eval'`.
  - The header line must stay ≤ 2000 characters (the Cloudflare Pages limit); the postbuild fails
    above that.
- **Also on every path:**
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`;
  - `Referrer-Policy: no-referrer`;
  - `X-Content-Type-Options: nosniff`;
  - `X-Frame-Options: DENY`;
  - `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()`;
  - `Cross-Origin-Opener-Policy: same-origin`;
  - `Cross-Origin-Resource-Policy: same-origin`.
- No `style=""` attribute in any built HTML: set styles from JS through the CSSOM
  (`el.style.setProperty`), never in markup.
- **No raw-HTML sinks in shipped code** (Trusted Types): no `dangerouslySetInnerHTML`, `innerHTML =`,
  `insertAdjacentHTML`, `outerHTML =` or `document.write`. React islands never receive Astro slot
  children, because those hydrate through `dangerouslySetInnerHTML`.
- Everything inside `<body>` sits between `<!--email_off-->` and `<!--/email_off-->`, so Cloudflare's
  Email Obfuscation never injects its `innerHTML` decoder (alxnko.dev R79).
- **B16:** no write credential, bearer token or `PUBLIC_*` secret is ever shipped. The site is
  read-only.
- No tokens in URLs or `localStorage`. The only storage key is the theme (`mw-theme`, an existing
  ui key).

**Live status and fetches** (B9, W-01, W-05):
- A probe is `fetch(url, { mode: "cors", credentials: "omit", cache: "no-store" })` with a
  **5000 ms** timeout (`PROBE_TIMEOUT_MS`). It shows:
  - `[wait] <name> — checking…`, then one of:
  - `[ ok ] <name> — up · <n> ms`;
  - `[fail] <name> — down · answered <status>`;
  - `[info] <name> — unknown · no answer in 5 s`;
  - `[info] <name> — unknown · couldn't reach it from here`.
- "check again" is disabled and reads "checking…" while probes run. Probes re-run on a bfcache
  restore (`pageshow` with `persisted`).
- No other fetch exists without a timeout, a visible error and an empty state.

**Performance budgets.** These were measured on 2026-09-24 at fb6b20f; sizes are gzip -9 in KiB unless
noted. `bun run --filter @meowerse/web budget` enforces the ceilings, and CI runs it.

| Item | Measured today | Ceiling |
|---|---|---|
| `@meowerse/ui` CSS, all layers (tokens.gen+aliases+global+base+layout+components) | 6.6 | — |
| Inline CSS per page (ui + site.css) | 6.6 + site | **14** |
| Critical JS per page (inline scripts + static import closure of module entries) | old page 1.3 | **8** |
| All JS reachable from a page without islands (critical + dynamic imports) | — | **12** |
| Island JS per `/ui` page (component + renderer URLs and their closure) | React runtime alone 55.6 | **90** |
| Preloaded fonts (JetBrains Mono latin 400 + VT323 mark), raw woff2 | 20.7 + 0.9 = 21.6 | **24** |
| Site font files (JBM latin 400 + 700, JBM symbols subset, VT323 mark), raw woff2 | 20.7 + 21.4 + 9.4 + 0.9 = 52.4 | **60** |
| Cat3D renderer chunk | 2.0 | **3** |
| `cat.bin`, raw | 7.8 | **10** |
| `cat-poster.webp`, raw | 5.1 | **6** |
| HTML per page incl. inline CSS | — | **25** (`/ui/*`: **40**) |

- Cat3D stays outside the critical path: attached in `requestIdleCallback`, the renderer is a dynamic
  import on first visibility, and it never loads under reduced motion or save-data.
- React never loads on the home page, the project pages, `/ui/`, the foundations pages, `/ui/cat3d/`
  or the 404.
- **No long main-thread tasks** (B26): page scripts do no synchronous work over 50 ms. Probes are
  async, and the cat attach is deferred to idle.

**Lighthouse** (B26):
- **Bar:** ≥ 95 in performance, accessibility, best practices and SEO, on mobile and desktop.
- **Pages:** `/`, `/p/meowsenger/`, `/ui/`, `/ui/components/button/` and `/ui/playground/`.
- **Method:** local `dist/` served with the real `_headers` and gzip; Lighthouse 13; the median of 3
  runs; headless Chromium with `--disable-gpu --enable-unsafe-swiftshader` (no GPU).
  - Mobile uses the default throttling (4× CPU, slow 4G).
  - Desktop uses `--preset=desktop --throttling.cpuSlowdownMultiplier=3`.
- The gate is `bun run --filter @meowerse/web lighthouse` (local only, it's noisy).

**Tests:**
- **Unit and coverage:**
  - `apps/web` vitest with a ≥ 90 coverage gate on `src/lib/**` (lines, branches, functions,
    statements).
  - `packages/ui` keeps its ≥ 90 gate.
- **Playwright e2e in `apps/web/tests/e2e`,** against `dist/` served with the real headers: desktop
  1440×900 and phone 390×844 (touch, device scale factor 1).
  - It covers the headers, CSP and Trusted Types violations on every page, the probes (ok, fail,
    hang, abort, retry), links, 44 px targets, axe, the playground URL state, and Modal focus.
- **Screenshot tests:**
  - the `/ui/gallery/` sections (dark and light side by side in each shot) at phone and desktop;
  - the `/ui/patterns/together/` pairings at phone and desktop × dark and light;
  - pairings 1–3 under reduced motion and forced colours;
  - `/` and `/p/auth/` at phone and desktop × dark and light.
  - They run locally and are skipped in CI (runner fonts differ), like `tokens:drift` (B28).

**Budgets of time and scope:** everything not listed in a task is out of scope. auth-web and
meowsenger-web only get the shared ui changes (Tasks 1–2) and the meowsenger `/health` CORS header
(Task 4). Their redesigns are sub-projects 3 and 4.

---

## File structure

```
packages/ui/
  design/tokens.json                    MOD  primitive.scene.cat / catEdge (T2)
  scripts/gen-tokens.ts                 MOD  imports contrast(); scoped theme classes; fallback font; --cat-* (T1, T2)
  scripts/gen-tokens.test.ts            MOD  CONTRAST_PAIRS from src; new outputs (T1, T2)
  scripts/cat-poster.ts                 MOD  cat colours from tokens.json (T2)
  src/lib/contrast.ts (+test)           NEW  contrast(), CONTRAST_PAIRS (T1)
  src/components/Icon.tsx (+test)       MOD  <path> elements, no innerHTML; ICON_NAMES (T1, U-28)
  src/no-html-sinks.test.ts             NEW  Trusted Types guard over src (T1)
  src/styles/fonts.css                  MOD  "JetBrains Mono Fallback" metric face (T1, U-29/G-12)
  src/styles/global.css                 MOD  .mw-theme--dark/--light scope colours (T1)
  src/styles/components.css             MOD  .mw-cat3d loses the colour literal (T2)
  src/styles/geometry.test.ts           MOD  no colour allow-list any more (T2)
  src/styles/tokens.gen.css             GEN  regenerated (T1, T2)
  src/cat3d/attach.ts (+test)           NEW  vanilla attachCat3D / attachAllCat3D (T2)
  src/cat3d/Cat3D.tsx                   MOD  thin wrapper over attachCat3D (T2)
  src/cat3d/index.ts                    NEW  subpath entry: Cat3D, attachCat3D, attachAllCat3D (T2)
  src/index.ts                          MOD  +contrast, CONTRAST_PAIRS, ICON_NAMES; −Cat3D (T1, T2)
  package.json                          MOD  exports ./theme ./tokens.json ./assets/fonts/* ./cat3d ./cat3d/attach (T1, T2)
alxnko.dev (separate repo)              PR   design/tokens.json primitive.scene.cat / catEdge (T2)
workers/meowsenger/src/index.ts (+test) MOD  /health: public CORS, no-store (T4)
apps/web/
  package.json, astro.config.mjs, tsconfig.json, vitest.config.ts, playwright.config.ts   MOD/NEW (T3)
  public/_headers                       MOD  __CSP__ template, security headers, pages.dev noindex (T3)
  public/robots.txt, site.webmanifest, .well-known/security.txt   MOD (T3, W-08, W-19)
  scripts/postbuild.ts                  NEW  CSP + guards + sitemap (T3)
  scripts/serve-dist.ts                 NEW  dist/ with _headers, gzip, dir index (T3)
  scripts/budget.ts                     NEW  budget gate (T13)
  scripts/lighthouse.ts                 NEW  Lighthouse gate (T13)
  src/styles/site.css                   NEW  the one stylesheet (T3; sections appended by T4, T5, T7, T8, T9, T10, T11)
  src/layouts/BaseLayout.astro          NEW  head/meta/preloads/theme init/header/main/footer (T3)
  src/layouts/DocsLayout.astro          NEW  /ui shell with docs nav (T7)
  src/components/SiteHeader.astro, SiteFooter.astro, ThemeButton.astro   NEW (T3)
  src/components/ProjectStatus.astro, Diagram.astro   NEW (T4)
  src/components/docs/*.astro, ReactNodeView.tsx      NEW (T7, T8, T9)
  src/content.config.ts, src/content/projects/*.json  NEW (T4)
  src/lib/site.ts, csp.ts, headers.ts, sitemap.ts, theme-button.ts        NEW (T3)
  src/lib/project-schema.ts, probe.ts, status-dom.ts, probe-runner.ts     NEW (T4)
  src/lib/ui-api.ts, css-api.ts, jsx.ts, slug.ts                          NEW (T6)
  src/lib/docs-nav.ts, copy-buttons.ts, motion-demo.ts                    NEW (T7)
  src/lib/playground-state.ts, island-watchdog.ts                         NEW (T10)
  src/lib/budget.ts                                                       NEW (T13)
  src/ui-docs/api.ts, types.ts, registry.ts, components/*.tsx             NEW (T6, T8)
  src/ui-docs/demos/*.tsx                                                 NEW (T9)
  src/ui-docs/playground/Playground.tsx, playable.tsx                    NEW (T10)
  src/pages/index.astro, 404.astro, p/[slug].astro                        MOD/NEW (T3, T4, T5)
  src/pages/ui/**                                                         NEW (T7–T11)
  src/lib/api.ts, api.test.ts, src/scripts/meow-island.ts                 DEL (T3, B16, W-10)
  tests/e2e/*.spec.ts, fixtures.ts, __screenshots__/                      NEW (T3–T12)
packages/brand/scripts/build.sh         MOD  emit_manifest: optional description → id/start_url/display (T3)
infra/services.sh, infra/deploy-status.sh, infra/cloudflare/deploy.tf, deploy-web.sh   MOD (T14, W-12, W-14)
infra/cloudflare/redirects.tf           MOD  meow.alxnko.eu.org → meow.alxnko.dev (T14, B24, W-15)
.github/workflows/deploy.yml            MOD  web step --branch main (T14, W-11)
.github/workflows/ci.yml                MOD  web build + budget + e2e job (T14)
.gitignore                              MOD  apps/web/test-results, playwright-report (T3)
docs/superpowers/{specs,decisions}/…    MOD  status and closed IDs (T15)
```

---

### Task 0: Worktree and baseline

**Files:** none

- [ ] **Step 1: Create the worktree and bring the plan in**

```bash
cd /home/alxnko/Projects/code/meow/meowerse
git fetch origin
git worktree add .claude/worktrees/brand-v2-sp2 -b feat/brand-v2-sp2 origin/master
cd .claude/worktrees/brand-v2-sp2
git merge --no-ff docs/brand-v2-sp2-plan -m "docs(brand-v2): bring in the sub-project 2 plan"
bun install --frozen-lockfile
bun run --filter @meowerse/ui test
bun run --filter @meowerse/web build
```

Expected: the install succeeds, every ui test passes with coverage ≥ 90, and the old web build
succeeds. `docs/brand-v2-sp2-plan` is a local branch of the same repository (worktrees share refs).
If it was already merged into master, skip the merge.

- [ ] **Step 2: Record the scratch dir**

```bash
mkdir -p /var/tmp/brand-v2/sp2
```

---
### Task 1: `@meowerse/ui` groundwork: Trusted-Types-safe Icon, Avatar as a named image, `contrast()`, scoped themes, fallback font, subpath exports (U-28, U-15, U-29/G-12, spec §3 "side by side")

**Files:**
- Create: `packages/ui/src/lib/contrast.ts`, `packages/ui/src/lib/contrast.test.ts`,
  `packages/ui/src/no-html-sinks.test.ts`, `packages/ui/src/package-exports.test.ts`
- Modify: `packages/ui/src/components/Icon.tsx`, `packages/ui/src/components/Icon.test.tsx`,
  `packages/ui/src/components/Avatar.tsx`, `packages/ui/src/components/Avatar.test.tsx`,
  `packages/ui/scripts/gen-tokens.ts`, `packages/ui/scripts/gen-tokens.test.ts`,
  `packages/ui/src/styles/fonts.css`, `packages/ui/src/styles/global.css`,
  `packages/ui/src/styles/tokens.gen.css` (regenerated), `packages/ui/src/index.ts`,
  `packages/ui/package.json`

**Interfaces:**
- Produces:
  - `contrast(a: string, b: string): number` and
    `CONTRAST_PAIRS: readonly ContrastPair[]`, where
    `ContrastPair = readonly [fg: SemanticKey, bg: SemanticKey, min: number]`. Exported from
    `@meowerse/ui`.
  - `ICON_NAMES: readonly string[]`, exported from `@meowerse/ui`.
  - `Avatar` renders `role="img"` with its `aria-label` (U-15). Without that role, axe's
    `aria-prohibited-attr` rule, which the site's a11y spec enforces, fails every page that shows an
    avatar.
  - CSS classes `.mw-theme--dark` / `.mw-theme--light`: any subtree renders in that theme.
  - `--font-mono` now includes `"JetBrains Mono Fallback"`.
  - Package subpaths: `@meowerse/ui/theme` (`src/lib/theme.ts`, no React),
    `@meowerse/ui/tokens.json`, and `@meowerse/ui/assets/fonts/<file>`.

- [ ] **Step 1: Write the failing tests**

`packages/ui/src/lib/contrast.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import tokens from "../../design/tokens.json";
import { CONTRAST_PAIRS, contrast } from "./contrast";

describe("contrast", () => {
  it("is 21 for black on white and 1 for a colour on itself", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#00ff82", "#00ff82")).toBe(1);
  });
  it("doesn't depend on argument order", () =>
    expect(contrast("#0a6e3c", "#e9e8e4")).toBeCloseTo(contrast("#e9e8e4", "#0a6e3c"), 10));
  it("pairs name only real semantic tokens, with an AA minimum", () => {
    expect(CONTRAST_PAIRS.length).toBe(21);
    for (const [fg, bg, min] of CONTRAST_PAIRS) {
      expect(tokens.semantic.dark).toHaveProperty(fg);
      expect(tokens.semantic.dark).toHaveProperty(bg);
      expect([3, 4.5]).toContain(min);
    }
  });
});
```

`packages/ui/src/no-html-sinks.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// meow.alxnko.dev enforces Trusted Types (`require-trusted-types-for 'script'; trusted-types 'none'`):
// any raw-HTML sink in a component throws the moment it renders on the client.
const SINK = /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|\.outerHTML\s*=|document\.write/;
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

describe("Trusted Types: shipped ui code has no raw-HTML sinks", () => {
  const files = walk(__dirname).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
  it.each(files.map((f) => [f.slice(__dirname.length + 1), f]))("%s", (_name, f) =>
    expect(readFileSync(f, "utf8")).not.toMatch(SINK));
});
```

`packages/ui/src/package-exports.test.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import pkg from "../package.json";

describe("package.json exports", () => {
  it.each(Object.entries(pkg.exports))("%s points at a real file", (_key, target) => {
    const probe = String(target).replace("*", "vt323-marks.woff2");
    expect(existsSync(join(__dirname, "..", probe)), probe).toBe(true);
  });
  it("offers the React-free subpaths the static site needs", () => {
    expect(pkg.exports).toMatchObject({
      "./theme": "./src/lib/theme.ts",
      "./tokens.json": "./design/tokens.json",
      "./assets/fonts/*": "./src/assets/fonts/*",
    });
  });
});
```

Append to `packages/ui/src/components/Icon.test.tsx`, inside the `describe("Icon", …)` block. Also
change its import line to `import { Icon, ICON_NAMES } from "./Icon";`:

```tsx
  it("draws its paths as <path> elements, never through innerHTML (Trusted Types, U-28)", () => {
    const { container } = render(<Icon name="sun" />);
    expect(container.querySelectorAll("svg[data-icon='sun'] > path")).toHaveLength(2);
  });
  it("ICON_NAMES lists exactly the icons it can draw", () => {
    expect(ICON_NAMES).toContain("send");
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(36);
    for (const name of ICON_NAMES) {
      const { container } = render(<Icon name={name} />);
      expect(container.querySelector("path"), name).not.toBeNull();
    }
  });
```

Append to `packages/ui/src/components/Avatar.test.tsx`, inside `describe("Avatar", …)`. Also add
`screen` to its import if it is missing.

```tsx
  it("is an image named by the person (a label on a generic span is prohibited, U-15)", () => {
    render(<Avatar name="Cats & Co" />);
    expect(screen.getByRole("img", { name: "Cats & Co" })).toHaveTextContent("C");
  });
```

In `packages/ui/scripts/gen-tokens.test.ts`:
- replace the local `type Pair = …` and `const PAIRS: Pair[] = [...]` with
  `import { CONTRAST_PAIRS as PAIRS } from "../src/lib/contrast";`;
- add these tests inside `describe("tokens", …)`:

```ts
  it("offers scoped theme classes so one page can show both themes side by side", () => {
    const css = gen(tokens);
    expect(css).toMatch(/\.mw-theme--dark \{[^}]*--c-bg: #0a0a0b;[^}]*color-scheme: dark;/s);
    expect(css).toMatch(/\.mw-theme--light \{[^}]*--c-bg: #e9e8e4;[^}]*color-scheme: light;/s);
  });
  it("puts the metric-matched fallback face second in --font-mono (no layout shift on swap)", () =>
    expect(gen(tokens)).toContain('--font-mono: "JetBrains Mono", "JetBrains Mono Fallback", ui-monospace'));
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd packages/ui && bunx vitest run src/lib/contrast.test.ts src/no-html-sinks.test.ts src/package-exports.test.ts src/components/Icon.test.tsx scripts/gen-tokens.test.ts`

Expected: FAIL.
- `contrast.ts` doesn't exist.
- `Icon.tsx` matches the sink regex.
- The `./theme` export is missing.
- `ICON_NAMES` is undefined.
- Avatar has no `img` role.
- No `.mw-theme--dark` exists.

- [ ] **Step 3: `src/lib/contrast.ts`**

```ts
// WCAG 2.x contrast, and the token pairs the components really put text or UI boundaries on. One list,
// shared by the token test (scripts/gen-tokens.test.ts) and the /ui docs' contrast table.
type SemanticKey = keyof (typeof import("../../design/tokens.json"))["semantic"]["dark"];
export type ContrastPair = readonly [fg: SemanticKey, bg: SemanticKey, min: number];

function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  // Non-null: `ch` is always the 3-element map of the literal 3-element array above.
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** WCAG 2.x contrast ratio between two #rrggbb colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** min is WCAG AA: 4.5 for text, 3 for the focus ring and input boundaries. */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ["fg", "bg", 4.5], ["fg", "bgElev", 4.5], ["fg", "surface", 4.5], ["fg", "surfaceRaised", 4.5],
  ["fgMuted", "bg", 4.5], ["fgMuted", "surface", 4.5], ["fgSubtle", "bg", 4.5], ["fgSubtle", "surface", 4.5],
  ["accent", "bg", 4.5], ["accent", "surface", 4.5], ["onAccent", "accentFill", 4.5],
  ["danger", "bg", 4.5], ["danger", "dangerTint", 4.5], ["onDanger", "danger", 4.5],
  ["ok", "bg", 4.5], ["ok", "surface", 4.5], ["info", "bg", 4.5], ["warn", "bg", 4.5],
  ["focus", "bg", 3], ["lineInput", "bg", 3], ["lineInput", "bgElev", 3],
];
```

- [ ] **Step 4: `scripts/gen-tokens.ts` uses it and emits scoped themes and the fallback font**

In `packages/ui/scripts/gen-tokens.ts`:
- delete the local `lum()` and `contrast()` functions;
- add below the `node:url` import:

```ts
import { contrast } from "../src/lib/contrast";
export { contrast };
```

Replace the whole `gen()` function with:

```ts
export function gen(t: Tokens): string {
  const base = [
    block(t.semantic.dark, "c-"),
    block(t.ansi, "ansi-"),
    t.space.slice(1).map((v, i) => `  --sp-${i + 1}: ${v}px;`).join("\n"),
    Object.entries(t.radius).map(([k, v]) => `  --r-${k}: ${v}px;`).join("\n"),
    t.type.scale.map((v, i) => `  --fs-${i + 1}: ${v / 16}rem;`).join("\n"),
    Object.entries(t.type.leading).map(([k, v]) => `  --leading-${k}: ${v};`).join("\n"),
    `  --control-height: ${t.control.height}px;\n  --disabled-opacity: ${t.control.disabledOpacity};`,
    Object.entries(t.z).map(([k, v]) => `  --z-${k}: ${v};`).join("\n"),
    `  --ease: ${t.motion.ease};`,
    `  --d-fast: ${t.motion.fast}ms;\n  --d-base: ${t.motion.base}ms;\n  --d-slow: ${t.motion.slow}ms;`,
    `  --font-mono: "JetBrains Mono", "JetBrains Mono Fallback", ui-monospace, "SFMono-Regular", Menlo, monospace;`,
    `  --font-mark: "VT323 Mark", var(--font-mono);`,
    `  color-scheme: dark;`,
  ].join("\n");
  const light = `${block(t.semantic.light, "c-")}\n  color-scheme: light;`;
  return `/* generated by scripts/gen-tokens.ts from design/tokens.json. Do not edit. */
:root {
${base}
}
:root[data-theme="light"] {
${light}
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
${light.replace(/^/gm, "  ")}
  }
}
/* scoped themes: a subtree that always renders dark or light, whatever the page theme (docs previews) */
.mw-theme--dark {
${block(t.semantic.dark, "c-")}
  color-scheme: dark;
}
.mw-theme--light {
${light}
}
`;
}
```

- [ ] **Step 5: The fallback face and scope colours**

Append to `packages/ui/src/styles/fonts.css`, after the existing `@font-face` blocks. `@import` rules
must stay first in the file.

```css
/* Metric-matched stand-in while JetBrains Mono loads, so the swap doesn't shift layout (U-29, G-12;
   the same face alxnko.dev ships in base.css). */
@font-face {
  font-family: "JetBrains Mono Fallback";
  src: local("DejaVu Sans Mono"), local("Menlo"), local("Consolas");
  size-adjust: 100%;
  ascent-override: 102%;
  descent-override: 30%;
}
```

Append to `packages/ui/src/styles/global.css`:

```css
/* a scoped theme subtree paints its own surface and text (see tokens.gen.css .mw-theme--*) */
.mw-theme--dark, .mw-theme--light { color: var(--c-fg); background: var(--c-bg); }
```

- [ ] **Step 6: Icon without innerHTML, Avatar as an image**

Convert the icon map with a one-off codemod. Don't commit it: it lives in scratch.

```bash
cat > /var/tmp/brand-v2/sp2/icon-codemod.ts <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const f = process.argv[2]!;
const src = readFileSync(f, "utf8");
const out = src.replace(/^(\s*)("[\w-]+"|[\w]+): '((?:<path d="[^"]*" \/>)+)',$/gm, (_m, ind: string, key: string, paths: string) => {
  const ds = [...paths.matchAll(/<path d="([^"]*)" \/>/g)].map((m) => JSON.stringify(m[1]));
  return `${ind}${key}: [${ds.join(", ")}],`;
});
if (/'<path/.test(out)) throw new Error("an icon string was not converted");
writeFileSync(f, out);
console.log("converted", (out.match(/^\s*("[\w-]+"|\w+): \[/gm) ?? []).length, "icons");
EOF
bun /var/tmp/brand-v2/sp2/icon-codemod.ts packages/ui/src/components/Icon.tsx
```

Expected: `converted 36 icons`, and no `'<path` left in the file.

Then, in `packages/ui/src/components/Icon.tsx`:
- replace the doc comment and the declaration line
  `const ICONS: Record<string, string> = {` with:

```tsx
/**
 * Curated inline-SVG icon set (Tabler outline glyphs), drawn as <path> elements: no innerHTML, so it
 * renders under Trusted Types (U-28). Only the icons this design system uses; coloured via currentColor.
 */
const ICONS: Record<string, readonly string[]> = {
```

- and replace everything from `export function Icon(` to the end of the file with:

```tsx
/** Every icon name `<Icon>` can draw. */
export const ICON_NAMES: readonly string[] = Object.keys(ICONS);

export function Icon({ name, size = 18, className, label }:
  { name: string; size?: number; className?: string; label?: string }) {
  const paths = ICONS[name];
  if (!paths) return null;
  return (
    <svg
      className={cx("mw-icon", className)}
      data-icon={name}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}
```

In `packages/ui/src/components/Avatar.tsx`, change the outer span to carry the role:

```tsx
    <span role="img" aria-label={name} className={cx("mw-avatar", `mw-avatar--${size}`, className)}>
```

- [ ] **Step 7: Exports**

In `packages/ui/src/index.ts`:
- replace `export { Icon } from "./components/Icon";` with
  `export { Icon, ICON_NAMES } from "./components/Icon";`;
- add at the end:

```ts
export { contrast, CONTRAST_PAIRS, type ContrastPair } from "./lib/contrast";
```

In `packages/ui/package.json`, replace the `"exports"` and `"files"` entries with:

```json
  "exports": {
    ".": "./src/index.ts",
    "./tokens.css": "./src/styles/tokens.css",
    "./tokens.json": "./design/tokens.json",
    "./theme": "./src/lib/theme.ts",
    "./assets/fonts/*": "./src/assets/fonts/*"
  },
  "files": ["src", "design"],
```

- [ ] **Step 8: Regenerate and run everything**

```bash
bun run --filter @meowerse/ui tokens
bun run --filter @meowerse/ui tokens:check
bun run --filter @meowerse/ui lint
bun run --filter @meowerse/ui test
```

Expected:
- `tokens.gen.css` gains the two `.mw-theme--*` blocks and the fallback in `--font-mono`;
- the check, `tsc` and every test pass, with coverage ≥ 90.

- [ ] **Step 9: The consumer apps still build**

```bash
bun run --filter @meowerse/auth-web build && bun run --filter @meowerse/meowsenger-web build
```

Expected: both build. The icons render as before; you can spot-check `dist/*.html` for
`<svg class="mw-icon"` containing `<path d=`.

- [ ] **Step 10: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): Trusted-Types-safe Icon, Avatar as a named image, shared contrast(), scoped themes, fallback font

Icon draws <path> elements instead of dangerouslySetInnerHTML (U-28) so pages can enforce
Trusted Types; a test keeps raw-HTML sinks out of ui. Avatar is role=img with its label (U-15). contrast() and the AA pair list move to
src/lib so the docs can show the same table the test enforces. .mw-theme--dark/--light let one
page show both themes side by side. The metric-matched JetBrains Mono fallback stops font-swap
layout shift (U-29, G-12). New React-free subpaths: ./theme, ./tokens.json, ./assets/fonts/*.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Cat3D without React, out of the barrel, and its colours as tokens (spec §4; SP1 deferrals: unused Cat3D assets, cat colour tokens)

**Files:**
- Create: `packages/ui/src/cat3d/attach.ts`, `packages/ui/src/cat3d/attach.test.ts`,
  `packages/ui/src/cat3d/index.ts`
- Modify:
  - `packages/ui/src/cat3d/Cat3D.tsx`;
  - `packages/ui/src/index.ts`;
  - `packages/ui/package.json`;
  - `packages/ui/vitest.config.ts`;
  - `packages/ui/design/tokens.json`;
  - `packages/ui/scripts/gen-tokens.ts`, `packages/ui/scripts/gen-tokens.test.ts`;
  - `packages/ui/src/styles/components.css`, `packages/ui/src/styles/geometry.test.ts`;
  - `packages/ui/scripts/cat-poster.ts`;
  - `packages/ui/src/styles/tokens.gen.css` (regenerated).
- The alxnko.dev repo: `design/tokens.json` and its decision log (a separate PR).

**Interfaces:**
- Consumes: Task 1's gen-tokens.
- Produces:
  - `attachCat3D(root: HTMLElement): () => void`: starts the lazy renderer for one `.mw-cat3d` root
    (a poster `<img>` plus a hidden `<canvas>`) and returns a cleanup.
  - `attachAllCat3D(doc?: ParentNode): () => void`: attaches every `.mw-cat3d` except those with the
    class `mw-cat3d--static` (the documented still fallback: `<Cat3D className="mw-cat3d--static" />`).
  - Both come from `@meowerse/ui/cat3d/attach` (no React) and from `@meowerse/ui/cat3d`.
  - `Cat3D({ size?: number = 160, className?: string })` now comes from `@meowerse/ui/cat3d` only,
    not `@meowerse/ui`.
  - CSS variables `--cat-color` and `--cat-edge` in `:root`.
  - The "live" class `mw-cat3d--live` and `canvas.hidden` are owned by `attachCat3D`. Don't change
    the root's `className` after mount.

- [ ] **Step 1: Write the failing tests**

`packages/ui/src/cat3d/attach.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import tokens from "../../design/tokens.json";
import { attachAllCat3D, attachCat3D } from "./attach";

const mount = vi.hoisted(() => vi.fn());
vi.mock("./renderer", () => ({ mount }));

afterEach(() => { vi.unstubAllGlobals(); mount.mockReset(); document.body.replaceChildren(); });

function root(extraClass?: string) {
  const el = document.createElement("div");
  el.className = extraClass ? `mw-cat3d ${extraClass}` : "mw-cat3d";
  const canvas = document.createElement("canvas");
  canvas.hidden = true;
  el.append(document.createElement("img"), canvas);
  document.body.append(el);
  return el;
}

function env(reduce = false) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) })));
  const observed: Element[] = [];
  let fire: (v: boolean) => void = () => {};
  vi.stubGlobal("IntersectionObserver", class {
    constructor(cb: (e: { isIntersecting: boolean }[]) => void) { fire = (v) => cb([{ isIntersecting: v }]); }
    observe(el: Element) { observed.push(el); }
    disconnect() {}
  });
  return { observed, visible: async () => { fire(true); await new Promise((r) => setTimeout(r, 0)); } };
}

describe("attachCat3D", () => {
  it("leaves the poster alone under reduced motion", () => {
    const e = env(true);
    attachCat3D(root());
    expect(e.observed).toHaveLength(0);
  });
  it("is a no-op for markup without a canvas", () => {
    const e = env();
    const el = document.createElement("div");
    expect(attachCat3D(el)).toBeTypeOf("function");
    expect(e.observed).toHaveLength(0);
  });
  it("goes live on first visibility with the token colours, then cleans up", async () => {
    const api = { setAim: vi.fn(), kick: vi.fn(), destroy: vi.fn() };
    mount.mockReturnValue(api);
    const e = env();
    const el = root();
    const off = attachCat3D(el);
    await e.visible();
    expect(mount).toHaveBeenCalledWith(el.querySelector("canvas"), expect.any(ArrayBuffer),
      { color: tokens.primitive.scene.cat, light: tokens.primitive.scene.catEdge });
    expect(el).toHaveClass("mw-cat3d--live");
    expect(el.querySelector("canvas")!.hidden).toBe(false);
    expect(api.kick).toHaveBeenCalledTimes(1);
    off();
    expect(api.destroy).toHaveBeenCalled();
  });
});

describe("attachAllCat3D", () => {
  it("attaches every cat except the documented still fallback (.mw-cat3d--static)", () => {
    const e = env();
    root();
    root("mw-cat3d--static");
    root();
    attachAllCat3D();
    expect(e.observed).toHaveLength(2);
  });
});
```

In `packages/ui/scripts/gen-tokens.test.ts`, add inside `describe("tokens", …)`:

```ts
  it("emits the cat's material colours from primitive.scene (Cat3D reads them)", () => {
    const css = gen(tokens);
    expect(css).toContain(`--cat-color: ${tokens.primitive.scene.cat};`);
    expect(css).toContain(`--cat-edge: ${tokens.primitive.scene.catEdge};`);
  });
```

In `packages/ui/src/styles/geometry.test.ts`:
- change `colourLiterals` to drop the allow-list:

```ts
/** Hard-coded colour literals. There is no allow-list: the cat colours are tokens now. */
const colourLiterals = (src: string) => src.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi) ?? [];
```

- and change the guard line `expect(colourLiterals("a { --cat-color: #00ff82; color: var(--c-fg); }")).toHaveLength(0);`
  to `.toHaveLength(1)`.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd packages/ui && bunx vitest run src/cat3d scripts/gen-tokens.test.ts src/styles/geometry.test.ts`

Expected: FAIL.
- `./attach` doesn't exist.
- `tokens.primitive.scene.cat` is undefined.
- `components.css` still has `--cat-color: #14995a`.

- [ ] **Step 3: Tokens**

In `packages/ui/design/tokens.json`, replace

```json
      "pad": "#141415"
    }
```

with

```json
      "pad": "#141415",
      "cat": "#14995a",
      "catEdge": "#63d396"
    }
```

These are the cat material and its edge colour from the alxnko.dev scene (`scene/build.py`:
`C.mat("cat", "#14995a", …, edge_hex="#63d396")`).

In `packages/ui/scripts/gen-tokens.ts` `gen()`, insert this line into the `base` array right after
the `--font-mark` line:

```ts
    `  --cat-color: ${t.primitive.scene.cat};\n  --cat-edge: ${t.primitive.scene.catEdge};`,
```

In `packages/ui/src/styles/components.css`, replace the Cat3D comment line and the `.mw-cat3d` rule:

```css
/* ---- Cat3D: decorative; --cat-color / --cat-edge come from tokens.gen.css (primitive.scene) ---- */
/* the in-flow poster <img width/height> sizes the box (no inline style); the canvas overlays it once live */
.mw-cat3d { display: inline-block; position: relative; line-height: 0; }
```

In `packages/ui/scripts/cat-poster.ts`:
- add `import tokens from "../design/tokens.json";` below the other imports;
- replace `{color:'#14995a',light:'#63d396'}` inside the `html` template with
  `${JSON.stringify({ color: tokens.primitive.scene.cat, light: tokens.primitive.scene.catEdge })}`.

The poster doesn't need re-rendering: the colours are unchanged.

- [ ] **Step 4: `src/cat3d/attach.ts`**

```ts
// Vanilla lifecycle of the decorative Cat3D (spec §4), shared by the React <Cat3D> and by pages that
// render its markup statically (meow.alxnko.dev ships no React on its home page). The poster stays
// until the WebGL2 renderer loads: lazily, on first visibility, never under reduced motion or
// save-data. Any failure just leaves the poster. Pointer tracking runs only while the cat is in view.
import { primitive } from "../../design/tokens.json";
import binUrl from "./cat.bin?url";

type Api = { setAim(x: number, y: number): void; kick(): void; destroy(): void };

const skip = () =>
  typeof matchMedia === "undefined" || matchMedia("(prefers-reduced-motion: reduce)").matches ||
  (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;

/** Starts the lazy renderer for one `.mw-cat3d` root (poster <img> + hidden <canvas>). Returns a cleanup. */
export function attachCat3D(root: HTMLElement): () => void {
  const canvas = root.querySelector("canvas");
  if (!canvas || skip() || typeof IntersectionObserver === "undefined") return () => {};
  const abort = new AbortController();
  let api: Api | null = null;
  let visible = false, loading = false, gone = false;
  let ro: ResizeObserver | undefined;
  const setLive = (on: boolean) => { root.classList.toggle("mw-cat3d--live", on); canvas.hidden = !on; };
  const onMove = (e: PointerEvent) => {
    const r = root.getBoundingClientRect();
    api?.setAim((e.clientX - (r.left + r.width / 2)) / (innerWidth / 2), -((e.clientY - (r.top + r.height / 2)) / (innerHeight / 2)));
  };
  const track = (on: boolean) =>
    on ? addEventListener("pointermove", onMove, { passive: true }) : removeEventListener("pointermove", onMove);
  const stop = () => { track(false); io.disconnect(); ro?.disconnect(); api?.destroy(); api = null; };
  const load = async () => {
    loading = true;
    try {
      const [{ mount }, buf] = await Promise.all([
        import("./renderer"),
        fetch(binUrl, { signal: abort.signal }).then((r) => r.arrayBuffer()),
      ]);
      if (gone) return;
      const css = getComputedStyle(root);
      const color = css.getPropertyValue("--cat-color").trim() || primitive.scene.cat;
      const light = css.getPropertyValue("--cat-edge").trim() || primitive.scene.catEdge;
      api = mount(canvas, buf, { color, light });
      if (!api) return io.disconnect();
      canvas.addEventListener("webglcontextlost", () => { stop(); setLive(false); }, { once: true });
      if (typeof ResizeObserver !== "undefined") (ro = new ResizeObserver(() => api?.kick())).observe(canvas);
      track(visible);
      setLive(true);
      api.kick(); // first frame once the canvas is displayed (it measured 0×0 while hidden)
    } catch { /* network or GL failure: the poster stays — decorative only */ }
  };
  const io = new IntersectionObserver(([e]) => {
    visible = e?.isIntersecting === true;
    if (api) track(visible);
    else if (visible && !loading) void load();
  }, { rootMargin: "200px" });
  io.observe(root);
  return () => { gone = true; abort.abort(); stop(); };
}

/** Attaches every `.mw-cat3d` in `doc` except `.mw-cat3d--static` ones (the documented still fallback). */
export function attachAllCat3D(doc: ParentNode = document): () => void {
  const offs = [...doc.querySelectorAll<HTMLElement>(".mw-cat3d:not(.mw-cat3d--static)")].map(attachCat3D);
  return () => offs.forEach((off) => off());
}
```

- [ ] **Step 5: `Cat3D.tsx` becomes a thin wrapper**

Replace the whole file `packages/ui/src/cat3d/Cat3D.tsx` with:

```tsx
// Cat3D.tsx — tiny decorative 3D cat (spec §4): the poster renders first, and attachCat3D() takes over
// (lazy WebGL2 renderer, fallbacks, pointer tracking). No inline style (strict style-src): the in-flow
// poster <img width/height> sizes the box and the canvas overlays it once live.
import { useEffect, useRef } from "react";
import { cx } from "../lib/cx";
import poster from "./cat-poster.webp";
import { attachCat3D } from "./attach";

export function Cat3D({ size = 160, className }: { size?: number; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => attachCat3D(root.current!), []);
  return (
    <div ref={root} className={cx("mw-cat3d", className)} aria-hidden="true">
      <img src={typeof poster === "string" ? poster : poster.src} alt="" width={size} height={size} decoding="async" />
      <canvas hidden />
    </div>
  );
}
```

`packages/ui/src/cat3d/index.ts`:

```ts
// @meowerse/ui/cat3d — kept out of the root barrel so apps that don't show the cat never emit its
// poster and mesh (SP1 deferral). React-free pages import "@meowerse/ui/cat3d/attach" instead.
export { Cat3D } from "./Cat3D";
export { attachCat3D, attachAllCat3D } from "./attach";
```

In `packages/ui/src/index.ts`, delete the line `export { Cat3D } from "./cat3d/Cat3D";`.

In `packages/ui/package.json` `"exports"`, add:

```json
    "./cat3d": "./src/cat3d/index.ts",
    "./cat3d/attach": "./src/cat3d/attach.ts",
```

In `packages/ui/vitest.config.ts` `coverage.exclude`, add `"src/cat3d/index.ts"` next to
`"src/index.ts"` (a re-export-only entry).

- [ ] **Step 6: Regenerate and run everything**

```bash
bun run --filter @meowerse/ui tokens
bun run --filter @meowerse/ui lint
bun run --filter @meowerse/ui test
```

Expected: all green, coverage ≥ 90. The existing `Cat3D.test.tsx` passes unchanged: it now exercises
`attachCat3D` through the component.

- [ ] **Step 7: Apps that don't use the cat stop shipping it**

```bash
bun run --filter @meowerse/auth-web build && bun run --filter @meowerse/meowsenger-web build
ls apps/auth-web/dist/_astro apps/meowsenger-web/dist/_astro | rg -c 'cat-poster|^cat\.' || echo 0
```

Expected: both build, and the count is `0`. This closes the SP1 deferral "unused Cat3D assets in app
dist".

- [ ] **Step 8: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): vanilla attachCat3D, Cat3D as its own subpath, cat colours as tokens

attachCat3D()/attachAllCat3D() run the lazy renderer on static markup, so meow.alxnko.dev
needs no React for its hero; <Cat3D> is a thin wrapper over it. Cat3D moves to
@meowerse/ui/cat3d, so apps that don't show it stop emitting its poster and mesh. The cat's
material colours are primitive.scene.cat/catEdge (from the alxnko.dev scene), emitted as
--cat-color/--cat-edge; the last colour literal in components.css is gone (SP1 deferrals).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 9: Upstream the two keys to alxnko.dev so the drift check stays green (B5)**

`tokens:drift` compares every key except `control` and `type.leading`, so alxnko.dev's
`design/tokens.json` needs the same two keys. Its generator doesn't emit `primitive`, so its CSS
doesn't change and no deploy is needed.

```bash
cd /home/alxnko/Projects/code/meow/alxnko.dev
git fetch origin
git worktree add .claude/worktrees/cat-tokens -b feat/cat-tokens origin/main
cd .claude/worktrees/cat-tokens
python3 - <<'EOF'
p = "design/tokens.json"
s = open(p).read()
old = '      "pad": "#141415"\n    }'
new = '      "pad": "#141415",\n      "cat": "#14995a",\n      "catEdge": "#63d396"\n    }'
assert s.count(old) == 1, "unexpected tokens.json layout"
open(p, "w").write(s.replace(old, new))
EOF
bun install --frozen-lockfile
bun run tokens:check && bun run test
```

Expected: `tokens:check` passes (the CSS is unchanged) and the unit tests pass.

Add a row to `docs/superpowers/decisions/2026-09-23-brainstorm-log.md`. Use the next free `R` number
on `origin/main`, which is R86 unless another open PR already claims it; in that case renumber before
merging.

```
| R86 | (meowerse brand v2, sub-project 2) the Cat3D on meow.alxnko.dev reads the cat's colours as tokens | `design/tokens.json` gains `primitive.scene.cat` `#14995a` and `primitive.scene.catEdge` `#63d396`, the cat material and edge colour from `scene/build.py`, so meowerse's copy of the tokens stays in sync (its drift check compares every key). `primitive` isn't emitted into CSS here, so the site is unchanged and needs no deploy. **Done.** |
```

```bash
git add design/tokens.json docs/superpowers/decisions/2026-09-23-brainstorm-log.md
git commit -m "chore(tokens): add the cat material colours to primitive.scene

Shared with meowerse's @meowerse/ui copy (drift check); not emitted into CSS.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/cat-tokens
gh pr create --base main --title "tokens: cat material colours in primitive.scene" --body "Adds primitive.scene.cat and catEdge (from scene/build.py) so meowerse's @meowerse/ui token copy stays in sync. No CSS change, no deploy.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
gh pr checks --watch
```

Leave the PR open for the controller: they review it and merge it with a merge commit, before
Task 15's drift check. Then, back in the meowerse worktree:

```bash
cd /home/alxnko/Projects/code/meow/meowerse/.claude/worktrees/brand-v2-sp2
ALXNKO_DEV_DIR=/home/alxnko/Projects/code/meow/alxnko.dev/.claude/worktrees/cat-tokens bun run --filter @meowerse/ui tokens:drift
```

Expected: `tokens in sync with alxnko.dev`.

---
### Task 3: Web scaffolding: layout, header and footer on `@meowerse/ui`, fonts, the postbuild CSP and headers, and the e2e harness (B12a, B16, B26; W-01, W-02, W-03, W-06, W-07, W-08, W-09, W-10, W-16, W-17, W-19)

**Files:**
- Delete: `apps/web/src/lib/api.ts`, `apps/web/src/lib/api.test.ts`,
  `apps/web/src/scripts/meow-island.ts`
- Modify:
  - `apps/web/package.json`, `apps/web/astro.config.mjs`, `apps/web/tsconfig.json`,
    `apps/web/vitest.config.ts`;
  - `apps/web/public/_headers`, `apps/web/public/robots.txt`, `apps/web/public/site.webmanifest`,
    `apps/web/public/.well-known/security.txt`;
  - `apps/web/src/pages/index.astro`, `apps/web/src/pages/404.astro`;
  - `packages/brand/scripts/build.sh`;
  - `.gitignore`, `bun.lock`.
- Create:
  - `apps/web/playwright.config.ts`;
  - `apps/web/scripts/postbuild.ts`, `apps/web/scripts/serve-dist.ts`;
  - `apps/web/src/styles/site.css`;
  - `apps/web/src/layouts/BaseLayout.astro`;
  - `apps/web/src/components/SiteHeader.astro`, `SiteFooter.astro`, `ThemeButton.astro`;
  - libraries in `apps/web/src/lib/`: `site.ts`, `csp.ts`, `headers.ts`, `sitemap.ts`,
    `theme-button.ts`, each with a `.test.ts`;
  - guard tests in `apps/web/src/lib/`: `site-css.test.ts`, `astro-no-style.test.ts`,
    `public-files.test.ts`;
  - e2e tests in `apps/web/tests/e2e/`: `fixtures.ts`, `headers.spec.ts`, `shell.spec.ts`,
    `csp.spec.ts`, `a11y.spec.ts`, `links.spec.ts`.

**Interfaces:**
- Consumes: Task 1's `@meowerse/ui/theme`, `@meowerse/ui/tokens.json`,
  `@meowerse/ui/assets/fonts/vt323-marks.woff2`, `Wordmark`, `Footer`, `Icon`, `StatusLine`.
- Produces:
  - `BaseLayout.astro`. Props: `{ title: string; description: string; jsonLd?: Record<string, unknown>; noindex?: boolean }`.
    It has a default slot inside `<main id="main">`.
  - `src/lib/site.ts`:
    - `SITE` (`url`, `name`, `description`, `legal`, `source`, `themeColor`);
    - `NAV`, `FOOTER_LINKS`;
    - `isCurrent(pathname, match): boolean`;
    - `isExternal(href): boolean`;
    - `linkAttrs(href): { target?: "_blank"; rel?: string }`.
  - `src/lib/csp.ts`:
    - `sha256`, `inlineBlocks`, `styleAttrs`, `dataUrls`;
    - `probeOrigins(projects)`;
    - `buildCsp(docs, connect?)`, `MAX_HEADER`.
  - `src/lib/headers.ts`: `parseHeaders(src)`, `headersFor(rules, path)`.
  - `src/lib/sitemap.ts`: `pagePaths(htmlFiles)`, `sitemapXml(site, paths)`.
  - `src/lib/theme-button.ts`: `bindThemeButtons(doc?)`, `themeLabel(theme)`.
  - `site.css` section markers: `/* ---- <name> ---- */`. Later tasks append their own section.
  - e2e fixtures:
    - `test` (auto-stubs every probed origin with a 200), `expect`;
    - `sitePaths()`;
    - `smallTargets(page)`;
    - `PROBED`.
  - `bun run --filter @meowerse/web build` runs `astro build` and then `scripts/postbuild.ts`.
  - `bun run --filter @meowerse/web e2e` runs Playwright against `dist/`.

- [ ] **Step 1: Dependencies, config, and removing the write demo (B16, W-01, W-02, W-10)**

```bash
git rm apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts apps/web/src/scripts/meow-island.ts
```

Replace `apps/web/package.json`:

```json
{
  "name": "@meowerse/web",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "astro dev",
    "build": "astro build && bun scripts/postbuild.ts",
    "lint": "astro check",
    "test": "vitest run --coverage",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@astrojs/react": "^6.0.0",
    "@fontsource/jetbrains-mono": "^5.3.0",
    "@meowerse/ui": "workspace:*",
    "astro": "^7.0.2",
    "react": "^19.2.7",
    "react-dom": "^19.2.7"
  },
  "devDependencies": {
    "@astrojs/check": "^0.9.9",
    "@axe-core/playwright": "^4.10.0",
    "@playwright/test": "1.63.0",
    "@types/react": "^19.2.17",
    "@types/node": "^26.6.2",
    "@types/react-dom": "^19.2.3",
    "@vitest/coverage-v8": "^4.1.9",
    "jsdom": "^25.0.1",
    "typescript": "^6.0.3",
    "vitest": "^4.1.9"
  }
}
```

Replace `apps/web/astro.config.mjs`:

```js
import { defineConfig } from "astro/config";
import react from "@astrojs/react";

// Static site under a strict hash-based CSP (scripts/postbuild.ts):
// - inlineStylesheets "always": the one site stylesheet (src/styles/site.css, imported only by
//   BaseLayout) is inlined on every page, so there is one CSP hash and no render-blocking CSS (B26);
// - assetsInlineLimit 0: fonts, the cat mesh and every other asset stay same-origin files. No data:
//   URLs, which img-src/font-src 'self' would block (SP1 deferral).
export default defineConfig({
  site: "https://meow.alxnko.dev",
  output: "static",
  trailingSlash: "always",
  integrations: [react()],
  build: { inlineStylesheets: "always", format: "directory" },
  vite: { build: { assetsInlineLimit: 0 } },
  devToolbar: { enabled: false },
  server: { host: "127.0.0.1", port: 4370 },
});
```

Replace `apps/web/tsconfig.json`:

```json
{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react"
  },
  "include": ["src", "scripts", "tests", ".astro/types.d.ts", "astro.config.mjs", "vitest.config.ts", "playwright.config.ts"],
  "exclude": ["dist", "coverage", "node_modules", "test-results"]
}
```

Replace `apps/web/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

// Pure logic lives in src/lib/** and carries the 90% gate. Pages, layouts and islands are covered by
// `astro check`, the build (+ scripts/postbuild.ts guards) and the Playwright suite (bun run e2e).
// DOM tests opt into jsdom per file with a `// @vitest-environment jsdom` first line.
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**"],
      exclude: ["src/lib/**/*.test.{ts,tsx}"],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
```

Create `apps/web/playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

// e2e against dist/ served with the real _headers (CSP included): run `bun run build` first.
// Phone is 390×844 at DPR 1 (spec audit §5b size; DPR 1 keeps screenshot files small).
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 45_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  snapshotPathTemplate: "tests/e2e/__screenshots__/{testFilePath}/{arg}-{projectName}{ext}",
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled", caret: "hide" } },
  use: {
    baseURL: "http://127.0.0.1:4371",
    colorScheme: "dark",
    trace: "retain-on-failure",
    launchOptions: { args: ["--enable-unsafe-swiftshader"] },
  },
  webServer: {
    command: "bun scripts/serve-dist.ts 4371",
    url: "http://127.0.0.1:4371/",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } },
  ],
});
```

Append to the root `.gitignore`:

```
apps/web/test-results/
apps/web/playwright-report/
```

Run:

```bash
bun install
(cd apps/web && bunx playwright install chromium)
```

Expected: `bun.lock` updates (`@axe-core/playwright`, `@playwright/test`, and the web workspace's new
deps) and Chromium for Playwright 1.63 is present.

- [ ] **Step 2: Write the failing unit tests**

`apps/web/src/lib/csp.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildCsp, dataUrls, inlineBlocks, MAX_HEADER, probeOrigins, sha256, styleAttrs } from "./csp";

describe("csp", () => {
  it("hashes like the browser (sha256, base64)", () =>
    expect(sha256("a")).toBe("'sha256-ypeBEsobvcr6wjGzmiPcTaeG7/gUfE5yuYB3ha/uSLs='"));
  it("collects inline scripts and styles, skipping src= scripts and non-executable data blocks", () => {
    const html = `<script>a()</script><script type="module">b()</script><script src="/x.js"></script>
      <script type="application/ld+json">{"x":1}</script><script></script><style>p{}</style>`;
    expect(inlineBlocks(html)).toEqual({ scripts: ["a()", "b()"], styles: ["p{}"] });
  });
  it("counts style attributes and finds data: URLs", () => {
    expect(styleAttrs('<p style="color:red">x</p><div>ok</div>')).toBe(1);
    expect(dataUrls('<img src="data:image/png;base64,AA"> a{background:url("data:image/svg+xml,x")}')).toHaveLength(2);
    expect(dataUrls('<img src="/cat.webp">')).toEqual([]);
  });
  it("builds one strict policy with Trusted Types and the probe origins", () => {
    const csp = buildCsp(["<script>a()</script><style>p{}</style>", "<script>a()</script>"], ["https://b.example", "https://a.example"]);
    expect(csp).toContain(`script-src 'self' ${sha256("a()")};`);
    expect(csp).toContain(`style-src 'self' ${sha256("p{}")};`);
    expect(csp).toContain("connect-src 'self' https://a.example https://b.example;");
    for (const d of ["default-src 'none'", "img-src 'self'", "font-src 'self'", "base-uri 'none'", "form-action 'none'",
      "frame-ancestors 'none'", "upgrade-insecure-requests", "require-trusted-types-for 'script'", "trusted-types 'none'"])
      expect(csp).toContain(d);
    expect(csp).not.toMatch(/unsafe-(inline|eval)/);
    expect(MAX_HEADER).toBe(2000);
  });
  it("takes connect-src origins from probe statuses only, deduplicated", () =>
    expect(probeOrigins([
      { status: { kind: "probe", url: "https://auth.alxnko.dev/.well-known/openid-configuration" } },
      { status: { kind: "probe", url: "https://auth.alxnko.dev/other" } },
      { status: { kind: "static" } },
      {},
    ])).toEqual(["https://auth.alxnko.dev"]));
});
```

`apps/web/src/lib/headers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { headersFor, parseHeaders } from "./headers";

const SRC = `# comment
/*
  X-A: 1
  Cache-Control: public
https://:project.pages.dev/*
  X-Robots-Tag: noindex
/_astro/*
  Cache-Control: immutable
`;

describe("_headers parsing", () => {
  it("applies path rules, joins same-name headers like Pages, and skips host rules", () => {
    const rules = parseHeaders(SRC);
    expect(rules).toHaveLength(2);
    expect(Object.fromEntries(headersFor(rules, "/"))).toEqual({ "x-a": "1", "cache-control": "public" });
    expect(headersFor(rules, "/_astro/a.js").get("cache-control")).toBe("public, immutable");
    expect(headersFor(rules, "/").has("x-robots-tag")).toBe(false);
  });
});
```

`apps/web/src/lib/sitemap.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pagePaths, sitemapXml } from "./sitemap";

describe("sitemap", () => {
  it("turns built index files into site paths and leaves out the 404", () =>
    expect(pagePaths(["p/auth/index.html", "404.html", "index.html", "ui\\index.html", "_astro/x.html"]))
      .toEqual(["/", "/p/auth/", "/ui/"]));
  it("writes a sitemaps.org urlset on the canonical host", () => {
    const xml = sitemapXml("https://meow.alxnko.dev/", ["/", "/ui/"]);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("<url><loc>https://meow.alxnko.dev/</loc></url>");
    expect(xml).toContain("<url><loc>https://meow.alxnko.dev/ui/</loc></url>");
  });
});
```

`apps/web/src/lib/site.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isCurrent, isExternal, linkAttrs, NAV, SITE } from "./site";

describe("site", () => {
  it("canonical host and theme colours come from the tokens", () => {
    expect(SITE.url).toBe("https://meow.alxnko.dev/");
    expect(SITE.themeColor).toEqual({ dark: "#0a0a0b", light: "#e9e8e4" });
  });
  it("only other origins open in a new tab; mailto and same-site never do", () => {
    expect(linkAttrs("https://github.com/meowerse/meowerse")).toEqual({ target: "_blank", rel: "noopener noreferrer" });
    expect(linkAttrs("/ui/")).toEqual({});
    expect(linkAttrs("https://meow.alxnko.dev/p/auth/")).toEqual({});
    expect(linkAttrs("mailto:x@example.com")).toEqual({});
    expect(isExternal("https://alxnko.dev/")).toBe(true);
  });
  it("marks the nav entry for the current section", () => {
    expect(NAV.map((l) => l.label)).toEqual(["projects", "ui docs"]);
    expect(isCurrent("/p/auth/", "/p/")).toBe(true);
    expect(isCurrent("/ui/components/button/", "/ui/")).toBe(true);
    expect(isCurrent("/", "/ui/")).toBe(false);
  });
});
```

`apps/web/src/lib/theme-button.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindThemeButtons, themeLabel } from "./theme-button";

const button = () => {
  const b = document.createElement("button");
  b.setAttribute("data-theme-button", "");
  document.body.append(b);
  return b;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("theme button", () => {
  beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute("data-theme"); document.body.replaceChildren(); });
  afterEach(() => vi.restoreAllMocks());

  it("labels the action, not the state", () => {
    expect(themeLabel("dark")).toBe("switch to light theme");
    expect(themeLabel("light")).toBe("switch to dark theme");
  });
  it("starts from the resolved theme (dark by default), toggles and persists", async () => {
    const b = button();
    bindThemeButtons(document);
    expect(b.getAttribute("aria-label")).toBe("switch to light theme");
    b.click();
    await tick();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("mw-theme")).toBe("light");
    expect(b.getAttribute("aria-label")).toBe("switch to dark theme");
  });
  it("follows another tab's choice", async () => {
    const b = button();
    bindThemeButtons(document);
    dispatchEvent(new StorageEvent("storage", { key: "mw-theme", newValue: "light" }));
    await tick();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(b.getAttribute("aria-label")).toBe("switch to dark theme");
    dispatchEvent(new StorageEvent("storage", { key: "mw-theme", newValue: null }));
    await tick();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
  it("still flips the page when storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const b = button();
    bindThemeButtons(document);
    b.click();
    await tick();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.classList.contains("mw-no-transitions")).toBe(false);
    expect(b.getAttribute("aria-label")).toBe("switch to dark theme");
  });
  it("does nothing without buttons", () => expect(() => bindThemeButtons(document)).not.toThrow());
});
```

`apps/web/src/lib/site-css.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// site.css is inlined on every page: it must follow the same token rules as @meowerse/ui's own CSS.
const css = readFileSync(join(__dirname, "../styles/site.css"), "utf8");
const RADII = new Set(["var(--r-s)", "var(--r-m)", "var(--r-l)", "50%", "0"]);

describe("site.css uses tokens only", () => {
  it("has no colour literals", () => expect(css.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi) ?? []).toEqual([]));
  it("has only on-scale radii", () => {
    const bad = [...css.matchAll(/border(?:-[a-z]+)*-radius\s*:\s*([^;}]+)/g)]
      .filter((m) => (m[1] ?? "").trim().split(/[\s/]+/).some((v) => !RADII.has(v))).map((m) => m[0]);
    expect(bad).toEqual([]);
  });
  it("never transforms case (B14)", () => expect(css).not.toMatch(/text-transform\s*:\s*(lower|upper|capital)/));
  it("has no sub-pixel lines", () => expect(css).not.toMatch(/0\.5px/));
});
```

`apps/web/src/lib/astro-no-style.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// One stylesheet (site.css via BaseLayout) → one inline <style> → one CSP hash. A component <style>
// block or style="" attribute would add hashes or be blocked outright.
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const astro = walk(join(__dirname, "..")).filter((f) => f.endsWith(".astro"));

describe("no per-component styles", () => {
  it.each(astro.map((f) => [f.slice(f.indexOf("src/")), f]))("%s has no <style> block or style attribute", (_n, f) => {
    const src = readFileSync(f, "utf8");
    expect(src).not.toMatch(/<style[\s>]/);
    expect(src).not.toMatch(/\sstyle=/);
  });
});
```

`apps/web/src/lib/public-files.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pub = (f: string) => readFileSync(join(__dirname, "../../public", f), "utf8");

describe("public files (W-08, W-19)", () => {
  it("the manifest is complete", () => {
    const m = JSON.parse(pub("site.webmanifest"));
    expect(m).toMatchObject({ name: "meowerse", id: "/", start_url: "/", display: "standalone" });
    expect(m.description.length).toBeGreaterThan(20);
  });
  it("robots.txt points at the sitemap", () => expect(pub("robots.txt")).toContain("Sitemap: https://meow.alxnko.dev/sitemap.xml"));
  it("security.txt is canonical for this host", () =>
    expect(pub(".well-known/security.txt")).toContain("Canonical: https://meow.alxnko.dev/.well-known/security.txt"));
  it("_headers has the CSP slot and the security headers", () => {
    const h = pub("_headers");
    expect(h.split("Content-Security-Policy: __CSP__")).toHaveLength(2);
    for (const k of ["Strict-Transport-Security: max-age=31536000; includeSubDomains; preload", "Permissions-Policy:",
      "Cross-Origin-Opener-Policy: same-origin", "X-Content-Type-Options: nosniff", "Referrer-Policy: no-referrer"])
      expect(h).toContain(k);
    expect(h).toContain("https://:project.pages.dev/*\n  X-Robots-Tag: noindex");
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cd apps/web && bunx vitest run`

Expected: FAIL. The `./csp`, `./headers`, `./sitemap`, `./site` and `./theme-button` modules and
`site.css` don't exist, and the public files lack the new fields.

- [ ] **Step 4: The libraries**

`apps/web/src/lib/csp.ts`:

```ts
// Strict CSP for a static site: every inline <script>/<style> the build emitted, hashed (spec §9, B26).
// Pure functions; scripts/postbuild.ts does the file I/O.
import { createHash } from "node:crypto";

export const MAX_HEADER = 2000; // Cloudflare Pages: max characters per _headers header value

export const sha256 = (s: string): string =>
  `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

const EXECUTABLE = new Set(["module", "text/javascript", "application/javascript"]);

/** Inline script bodies (no src=, an executable type) and style bodies, exactly as the browser hashes them. */
export function inlineBlocks(html: string): { scripts: string[]; styles: string[] } {
  const scripts: string[] = [];
  const styles: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1] ?? "", body = m[2] ?? "";
    if (/\ssrc\s*=/i.test(attrs) || body === "") continue;
    const type = /\stype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && !EXECUTABLE.has(type)) continue; // data blocks (JSON-LD) never run, so CSP never checks them
    scripts.push(body);
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) styles.push(m[1] ?? "");
  return { scripts, styles };
}

/** `style="…"` attributes: hashes can't allow them, so the build must emit none. */
export function styleAttrs(html: string): number {
  return (html.match(/<[a-z][^>]*\sstyle\s*=/gi) ?? []).length;
}

/** data: URLs in src/href attributes or CSS url(): img-src/font-src 'self' blocks them. */
export function dataUrls(src: string): string[] {
  return src.match(/(?:src|href)\s*=\s*["']data:[^"']*|url\(\s*["']?data:[^)]*/gi) ?? [];
}

export const TRUSTED_TYPES = ["require-trusted-types-for 'script'", "trusted-types 'none'"] as const;

type ProbeLike = { status?: { kind?: string; url?: string } };

/** connect-src origins: exactly the services the pages probe (content/projects/*.json). */
export function probeOrigins(projects: ProbeLike[]): string[] {
  const set = new Set<string>();
  for (const p of projects) if (p.status?.kind === "probe" && p.status.url) set.add(new URL(p.status.url).origin);
  return [...set].sort();
}

/** One policy for every page (the 404 included): the union of all inline hashes. */
export function buildCsp(docs: string[], connect: string[] = []): string {
  const scripts = new Set<string>(), styles = new Set<string>();
  for (const d of docs) {
    const b = inlineBlocks(d);
    b.scripts.forEach((x) => scripts.add(sha256(x)));
    b.styles.forEach((x) => styles.add(sha256(x)));
  }
  const list = (xs: Iterable<string>) => [...xs].sort().map((x) => ` ${x}`).join("");
  return [
    "default-src 'none'",
    `script-src 'self'${list(scripts)}`,
    `style-src 'self'${list(styles)}`,
    "img-src 'self'",
    "font-src 'self'",
    `connect-src 'self'${list(connect)}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
    ...TRUSTED_TYPES,
  ].join("; ");
}
```

`apps/web/src/lib/headers.ts`:

```ts
// Cloudflare Pages `_headers`, as far as local serving needs it (scripts/serve-dist.ts).
export type HeaderRule = { re: RegExp; headers: [string, string][] };

/** Path rules only: host-specific rules (`https://…`) never match a local request, so they're skipped. */
export function parseHeaders(src: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let cur: HeaderRule | null = null;
  for (const raw of src.split("\n")) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      const pat = raw.trim();
      if (!pat.startsWith("/")) { cur = null; continue; }
      const re = pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      cur = { re: new RegExp(`^${re}$`), headers: [] };
      rules.push(cur);
    } else if (cur) {
      const i = raw.indexOf(":");
      if (i > 0) cur.headers.push([raw.slice(0, i).trim(), raw.slice(i + 1).trim()]);
    }
  }
  return rules;
}

/** Headers for one path. Like Pages, same-name headers from several matching rules are joined with ", ". */
export function headersFor(rules: HeaderRule[], path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rules) {
    if (!r.re.test(path)) continue;
    for (const [k, v] of r.headers) {
      const key = k.toLowerCase();
      out.set(key, out.has(key) ? `${out.get(key)}, ${v}` : v);
    }
  }
  return out;
}
```

`apps/web/src/lib/sitemap.ts`:

```ts
/** dist-relative HTML files → site paths ("index.html" → "/", "p/auth/index.html" → "/p/auth/"); no 404. */
export function pagePaths(htmlFiles: string[]): string[] {
  return htmlFiles
    .map((f) => f.split("\\").join("/"))
    .filter((f) => f !== "404.html" && f.endsWith("index.html") && !f.startsWith("_astro/"))
    .map((f) => `/${f.slice(0, -"index.html".length)}`)
    .sort();
}

export function sitemapXml(site: string, paths: string[]): string {
  const base = site.replace(/\/$/, "");
  const urls = paths.map((p) => `  <url><loc>${base}${p}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
```

`apps/web/src/lib/site.ts`:

```ts
import tokens from "@meowerse/ui/tokens.json";

export const SITE = {
  url: "https://meow.alxnko.dev/",
  name: "meowerse",
  description: "Small, fast web apps by alxnko: one account, a messenger, and the design system they share.",
  legal: "meowerse — a personal project by alxnko. no ads, no analytics, no trackers.",
  source: "https://github.com/meowerse/meowerse",
  themeColor: { dark: tokens.semantic.dark.bg, light: tokens.semantic.light.bg },
} as const;

export type NavLink = { label: string; href: string; match: string };
export const NAV: readonly NavLink[] = [
  { label: "projects", href: "/#projects", match: "/p/" },
  { label: "ui docs", href: "/ui/", match: "/ui/" },
];

export const FOOTER_LINKS = [
  { label: "projects", href: "/#projects" },
  { label: "ui docs", href: "/ui/" },
  { label: "playground", href: "/ui/playground/" },
];

export const isCurrent = (pathname: string, match: string): boolean => pathname.startsWith(match);

/** Another origin (mailto: is not "external": it never gets a target). */
export function isExternal(href: string): boolean {
  if (href.startsWith("mailto:")) return false;
  return new URL(href, SITE.url).origin !== new URL(SITE.url).origin;
}

/** External links open in a new tab without leaking the opener or the referrer. */
export function linkAttrs(href: string): { target?: "_blank"; rel?: string } {
  return isExternal(href) ? { target: "_blank", rel: "noopener noreferrer" } : {};
}
```

`apps/web/src/lib/theme-button.ts`:

```ts
// The header theme button without React: ThemeButton.astro renders it, this binds it.
import { resolvedTheme, toggleTheme } from "@meowerse/ui/theme";

type Mode = "light" | "dark";

function current(doc: Document): Mode {
  try {
    return resolvedTheme();
  } catch { // storage blocked (private mode, strict settings): read what the page shows instead
    const attr = doc.documentElement.getAttribute("data-theme");
    if (attr === "light" || attr === "dark") return attr;
    return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
}

/** The button names the action it performs. */
export const themeLabel = (theme: Mode): string => (theme === "dark" ? "switch to light theme" : "switch to dark theme");

export function bindThemeButtons(doc: Document = document): void {
  const buttons = [...doc.querySelectorAll<HTMLButtonElement>("[data-theme-button]")];
  if (!buttons.length) return;
  const root = doc.documentElement;
  const sync = () => { const label = themeLabel(current(doc)); for (const b of buttons) b.setAttribute("aria-label", label); };
  for (const b of buttons) {
    b.addEventListener("click", () => {
      try {
        toggleTheme();
      } catch { // the choice can't persist; flip this page only
        root.setAttribute("data-theme", current(doc) === "dark" ? "light" : "dark");
        root.classList.remove("mw-no-transitions");
      }
      sync();
    });
  }
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-theme"] }); // other toggles on the page
  addEventListener("storage", (e) => { // another tab chose
    if (e.key !== "mw-theme") return;
    if (e.newValue === "light" || e.newValue === "dark") root.setAttribute("data-theme", e.newValue);
    else root.removeAttribute("data-theme");
  });
  if (typeof matchMedia !== "undefined") matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", sync);
  sync();
}
```

- [ ] **Step 5: Public files and the brand manifest template (W-08, W-09, W-19)**

Replace `apps/web/public/_headers`:

```
# Cloudflare Pages headers for meow.alxnko.dev. scripts/postbuild.ts replaces __CSP__ with the strict
# hash-based policy it computes from the built pages: one policy for every page, the 404 included.
#
# Cache-Control caveat: Cloudflare COMBINES same-name headers across every matching rule (a more
# specific path does NOT override /*), so there is deliberately no Cache-Control under /*. Set
# exactly one Cache-Control per path.
/*
  Content-Security-Policy: __CSP__
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin

# Preview and branch deployments on *.pages.dev duplicate the real site: keep them out of search (W-08).
https://:project.pages.dev/*
  X-Robots-Tag: noindex
https://:version.:project.pages.dev/*
  X-Robots-Tag: noindex

# Content-hashed build output never changes under a given URL.
/_astro/*
  Cache-Control: public, max-age=31536000, immutable

# HTML: the browser revalidates; the edge serves fast and refreshes in the background.
/
  Cache-Control: public, max-age=0, s-maxage=3600, stale-while-revalidate=86400
/p/*
  Cache-Control: public, max-age=0, s-maxage=3600, stale-while-revalidate=86400
/ui/*
  Cache-Control: public, max-age=0, s-maxage=3600, stale-while-revalidate=86400
/404.html
  Cache-Control: public, max-age=0, s-maxage=3600, stale-while-revalidate=86400
/sitemap.xml
  Cache-Control: public, max-age=3600

# Brand icons (packages/brand): stable URLs, not content-hashed, so a week rather than immutable.
/favicon.ico
  Cache-Control: public, max-age=604800
/favicon.svg
  Cache-Control: public, max-age=604800
/apple-touch-icon.png
  Cache-Control: public, max-age=604800
/icon-*.png
  Cache-Control: public, max-age=604800
/site.webmanifest
  Cache-Control: public, max-age=604800
```

Append to `apps/web/public/robots.txt`, after a blank line:

```
Sitemap: https://meow.alxnko.dev/sitemap.xml
```

Replace `apps/web/public/.well-known/security.txt`. The contact address stays as it is; confirming it
is the owner's call (W-19, recorded in Task 15).

```
Contact: mailto:Alexnekokyn@gmail.com
Expires: 2027-09-30T23:59:59.000Z
Preferred-Languages: en, ru
Canonical: https://meow.alxnko.dev/.well-known/security.txt
```

In `packages/brand/scripts/build.sh`, replace the `emit_manifest()` function header and its first
lines, up to and including `  "short_name": "$3",`, with:

```bash
emit_manifest() { # emit_manifest <dir> <name> <short_name> [description]
  local extra=""
  if [ -n "${4:-}" ]; then # a site (not only an app shell) also gets id/start_url/display/description (W-08)
    extra="  \"id\": \"/\",
  \"start_url\": \"/\",
  \"display\": \"standalone\",
  \"description\": \"$4\",
"
  fi
  cat > "$1/site.webmanifest" <<JSON
{
  "name": "$2",
  "short_name": "$3",
${extra}  "icons": [
```

Then delete the old `  "icons": [` line that followed `"short_name"`, so the icons array opens only
once.

In `distribute()`:
- change `emit_manifest "$dir" "$2" "$3"` to `emit_manifest "$dir" "$2" "$3" "${4:-}"`;
- change the web line to
  `distribute web             "meowerse"        "meowerse"   "Small, fast web apps by alxnko and the design system they share."`.

Replace `apps/web/public/site.webmanifest` with exactly what the template now emits:

```json
{
  "name": "meowerse",
  "short_name": "meowerse",
  "id": "/",
  "start_url": "/",
  "display": "standalone",
  "description": "Small, fast web apps by alxnko and the design system they share.",
  "icons": [
    { "src": "/icon-192.webp", "sizes": "192x192", "type": "image/webp" },
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.webp", "sizes": "512x512", "type": "image/webp" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icon-maskable-512.webp", "sizes": "512x512", "type": "image/webp", "purpose": "maskable" },
    { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "theme_color": "#0d0d0d",
  "background_color": "#0d0d0d"
}
```

Prove the template and the file agree. This runs only the function, not the whole icon build:

```bash
bash -n packages/brand/scripts/build.sh
m=/var/tmp/brand-v2/sp2/manifest && mkdir -p "$m"
{ awk '/^emit_manifest\(\) \{/,/^JSON$/' packages/brand/scripts/build.sh; echo "}"; } > "$m/fn.sh"
SURFACE="#0d0d0d" bash -c "source $m/fn.sh; emit_manifest $m meowerse meowerse 'Small, fast web apps by alxnko and the design system they share.'"
diff "$m/site.webmanifest" apps/web/public/site.webmanifest && echo same
SURFACE="#0d0d0d" bash -c "source $m/fn.sh; emit_manifest $m meowsenger meowsenger"
diff "$m/site.webmanifest" apps/meowsenger-web/public/site.webmanifest && echo unchanged
```

Expected: `same`, then `unchanged`. Apps that pass no description keep their manifests byte for byte.

- [ ] **Step 6: The stylesheet (shell section)**

Create `apps/web/src/styles/site.css`:

```css
/* meow.alxnko.dev: the site's one stylesheet. BaseLayout imports it once and Astro inlines it on every
   page (one CSP hash, no render-blocking request). Tokens only: no colour literals, radii 2/4/8, the
   spacing and type scales (src/lib/site-css.test.ts). Each task appends its own "---- name ----" section. */
@import "@meowerse/ui/tokens.css";

/* ---- shell ---- */
html { scroll-padding-top: calc(var(--control-height) + var(--sp-5)); }
body { min-height: 100dvh; display: flex; flex-direction: column; }
.site-main { flex: 1; display: block; width: 100%; max-width: 72rem; margin-inline: auto; padding: var(--sp-6) clamp(var(--sp-4), 5vw, var(--sp-6)) var(--sp-7); }
.site-main:focus { outline: none; }
.skip { position: absolute; left: var(--sp-2); top: calc(-1 * var(--sp-8)); z-index: var(--z-skip); display: inline-flex; align-items: center; min-height: var(--control-height); padding: 0 var(--sp-3); background: var(--c-surface-raised); color: var(--c-fg); border: 1px solid var(--c-line-strong); border-radius: var(--r-m); }
.skip:focus { top: var(--sp-2); text-decoration: none; }
.site-nav { display: flex; align-items: center; gap: var(--sp-1); }
.site-nav a { display: inline-flex; align-items: center; justify-content: center; min-height: var(--control-height); min-width: var(--control-height); padding: 0 var(--sp-2); border-radius: var(--r-m); color: var(--c-fg-muted); font-size: var(--fs-2); white-space: nowrap; }
.site-nav a:hover { color: var(--c-fg); background: var(--c-surface); text-decoration: none; }
.site-nav a[aria-current="page"] { color: var(--c-fg); box-shadow: inset 0 -2px 0 var(--c-accent); }
.theme-button__sun, .theme-button__moon { display: inline-flex; }
.theme-button__moon { display: none; }
:root[data-theme="light"] .theme-button__sun { display: none; }
:root[data-theme="light"] .theme-button__moon { display: inline-flex; }
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) .theme-button__sun { display: none; }
  :root:not([data-theme="dark"]) .theme-button__moon { display: inline-flex; }
}
.site-footer .mw-footer__legal { max-width: 60ch; }

/* ---- shared text and actions ---- */
.lede { font-size: var(--fs-4); color: var(--c-fg-muted); max-width: 60ch; }
.prompt-title { font-size: var(--fs-5); }
.prompt-title__glyph { color: var(--c-fg-subtle); font-weight: 400; }
.ext-mark { color: var(--c-fg-subtle); }
.btn-row { display: flex; flex-wrap: wrap; gap: var(--sp-3); }
a.mw-btn:hover { text-decoration: none; }

/* ---- 404 ---- */
.notfound { display: grid; gap: var(--sp-4); justify-items: start; padding-block: var(--sp-7); }
.notfound__code { font-size: var(--fs-7); font-weight: 700; line-height: 1; color: var(--c-accent); }
```

- [ ] **Step 7: Layout, header, footer, theme button, pages**

`apps/web/src/components/ThemeButton.astro`:

```astro
---
import { Icon } from "@meowerse/ui";
---
<button type="button" class="mw-themetoggle" data-theme-button aria-label="switch theme">
  <span class="theme-button__sun"><Icon name="sun" size={18} /></span>
  <span class="theme-button__moon"><Icon name="moon" size={18} /></span>
</button>
<script>
  import { bindThemeButtons } from "../lib/theme-button";
  bindThemeButtons();
</script>
```

`apps/web/src/components/SiteHeader.astro`:

```astro
---
import { Wordmark } from "@meowerse/ui";
import ThemeButton from "./ThemeButton.astro";
import { isCurrent, NAV } from "../lib/site";
const path = Astro.url.pathname;
---
<header class="mw-header">
  <Wordmark name="meowerse" href="/" />
  <div class="mw-header__actions">
    <nav class="site-nav" aria-label="primary">
      {NAV.map((l) => <a href={l.href} aria-current={isCurrent(path, l.match) ? "page" : undefined}>{l.label}</a>)}
    </nav>
    <ThemeButton />
  </div>
</header>
```

`apps/web/src/components/SiteFooter.astro`:

```astro
---
import { Footer } from "@meowerse/ui";
import { FOOTER_LINKS, SITE } from "../lib/site";
---
<Footer className="site-footer" links={FOOTER_LINKS} legal={SITE.legal} />
```

`apps/web/src/layouts/BaseLayout.astro`:

```astro
---
import "../styles/site.css";
import { THEME_INIT_SCRIPT } from "@meowerse/ui/theme";
import jbm400 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url";
import mark from "@meowerse/ui/assets/fonts/vt323-marks.woff2?url";
import SiteHeader from "../components/SiteHeader.astro";
import SiteFooter from "../components/SiteFooter.astro";
import { SITE } from "../lib/site";

interface Props { title: string; description: string; jsonLd?: Record<string, unknown>; noindex?: boolean }
const { title, description, jsonLd, noindex = false } = Astro.props;
const canonical = new URL(Astro.url.pathname, SITE.url).href;
const fullTitle = title === SITE.name ? title : `${title} · ${SITE.name}`;
const ld = jsonLd ? JSON.stringify(jsonLd).replace(/</g, "\\u003c") : undefined;
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{fullTitle}</title>
    <meta name="description" content={description} />
    {noindex ? <meta name="robots" content="noindex" /> : <link rel="canonical" href={canonical} />}
    <meta name="theme-color" content={SITE.themeColor.dark} media="(prefers-color-scheme: dark)" />
    <meta name="theme-color" content={SITE.themeColor.light} media="(prefers-color-scheme: light)" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content={SITE.name} />
    <meta property="og:title" content={fullTitle} />
    <meta property="og:description" content={description} />
    <meta property="og:url" content={canonical} />
    <meta property="og:image" content={`${SITE.url}icon-512.png`} />
    <meta name="twitter:card" content="summary" />
    <link rel="preload" href={jbm400} as="font" type="font/woff2" crossorigin />
    <link rel="preload" href={mark} as="font" type="font/woff2" crossorigin />
    <!-- Icons: generated by packages/brand (bash packages/brand/scripts/build.sh). -->
    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" href="/favicon.webp" type="image/webp" sizes="32x32" />
    <link rel="icon" href="/favicon.png" type="image/png" sizes="32x32" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/site.webmanifest" />
    <script is:inline set:html={THEME_INIT_SCRIPT}></script>
    {ld && <script type="application/ld+json" set:html={ld} />}
  </head>
  <body>
    <!--email_off-->
    <a class="skip" href="#main">skip to content</a>
    <SiteHeader />
    <main id="main" class="site-main" tabindex="-1">
      <slot />
    </main>
    <SiteFooter />
    <!--/email_off-->
  </body>
</html>
```

Replace `apps/web/src/pages/404.astro`:

```astro
---
// Cloudflare Pages serves dist/404.html with a 404 status for any path that matches nothing (W-17).
import BaseLayout from "../layouts/BaseLayout.astro";
import { StatusLine } from "@meowerse/ui";
---
<BaseLayout title="not found" description="This page doesn't exist on meow.alxnko.dev." noindex>
  <section class="notfound" aria-labelledby="nf-title">
    <p class="notfound__code" aria-hidden="true">404</p>
    <h1 id="nf-title" class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› </span>not found</h1>
    <StatusLine state="info">that page wandered off. it may have moved.</StatusLine>
    <a class="mw-btn mw-btn--secondary mw-btn--md" href="/">back home</a>
  </section>
</BaseLayout>
```

Replace `apps/web/src/pages/index.astro`. It is a real minimal page for now; Task 5 builds the hero
and the lists.

```astro
---
import BaseLayout from "../layouts/BaseLayout.astro";
import { SITE } from "../lib/site";
---
<BaseLayout title={SITE.name} description={SITE.description}>
  <h1 class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› </span>meowerse</h1>
  <p class="lede">{SITE.description}</p>
</BaseLayout>
```

- [ ] **Step 8: The postbuild and the local server**

`apps/web/scripts/postbuild.ts`:

```ts
// Postbuild for meow.alxnko.dev (`bun run build` runs it after `astro build`):
//  1. refuses what the strict CSP would break: style="" attributes, data: URLs (assetsInlineLimit: 0)
//     and external stylesheets (the site CSS must be inlined: one hash);
//  2. hashes every inline <script>/<style> in dist/**/*.{html,svg} into ONE strict CSP with Trusted
//     Types, with connect-src from the project probes, and writes it into dist/_headers (__CSP__);
//  3. writes dist/sitemap.xml from the built pages.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildCsp, dataUrls, MAX_HEADER, probeOrigins, styleAttrs } from "../src/lib/csp";
import { pagePaths, sitemapXml } from "../src/lib/sitemap";
import { SITE } from "../src/lib/site";

const root = process.cwd();
const dist = join(root, "dist");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const read = (f: string) => readFileSync(f, "utf8");
const files = walk(dist);
const html = files.filter((f) => f.endsWith(".html"));
const svg = files.filter((f) => f.endsWith(".svg"));
const css = files.filter((f) => f.endsWith(".css"));
const rel = (fs: string[]) => fs.map((f) => relative(dist, f)).join("\n  ");

const withStyle = html.filter((f) => styleAttrs(read(f)) > 0);
if (withStyle.length) throw new Error(`style="" attributes are blocked by the CSP:\n  ${rel(withStyle)}`);
const withData = [...html, ...css].filter((f) => dataUrls(read(f)).length > 0);
if (withData.length) throw new Error(`data: URLs are blocked by the CSP (keep assetsInlineLimit: 0):\n  ${rel(withData)}`);
const linked = html.filter((f) => /<link[^>]+rel="stylesheet"/.test(read(f)));
if (linked.length) throw new Error(`external stylesheets: the site CSS must be inlined (one hash):\n  ${rel(linked)}`);

const contentDir = join(root, "src/content/projects");
const projects = existsSync(contentDir)
  ? readdirSync(contentDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(read(join(contentDir, f))))
  : [];
const csp = buildCsp([...html, ...svg].map(read), probeOrigins(projects));
if (csp.length > MAX_HEADER) throw new Error(`the CSP is ${csp.length} characters; Cloudflare Pages allows ${MAX_HEADER}`);

const headersPath = join(dist, "_headers");
const slot = "Content-Security-Policy: __CSP__";
const headers = read(headersPath);
if (headers.split(slot).length !== 2) throw new Error(`dist/_headers needs exactly one "${slot}" line`);
writeFileSync(headersPath, headers.replace(slot, `Content-Security-Policy: ${csp}`));

const paths = pagePaths(html.map((f) => relative(dist, f)));
writeFileSync(join(dist, "sitemap.xml"), sitemapXml(SITE.url, paths));
console.log(`csp: ${csp.length} chars, ${(csp.match(/sha256-/g) ?? []).length} hashes → dist/_headers; sitemap: ${paths.length} pages`);
```

`apps/web/scripts/serve-dist.ts`:

```ts
// Lab and e2e only: serve dist/ the way Cloudflare Pages does for this site: the real dist/_headers
// (CSP included), /dir → /dir/ redirects, directory indexes, the 404 page with a 404 status, and gzip
// (the CDN compresses; Lighthouse must see it). Usage: bun scripts/serve-dist.ts [port]
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { gzipSync } from "node:zlib";
import { headersFor, parseHeaders } from "../src/lib/headers";

const dist = join(process.cwd(), "dist");
const port = Number(process.argv[2] ?? 4371);
const rules = parseHeaders(readFileSync(join(dist, "_headers"), "utf8"));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".bin": "application/octet-stream",
};
const COMPRESS = new Set([".html", ".js", ".css", ".json", ".webmanifest", ".svg", ".txt", ".xml"]);

type Hit = { file: string; status: number } | { location: string };
function resolve(pathname: string): Hit {
  const relPath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const f = join(dist, relPath);
  if (!f.startsWith(dist)) return { file: join(dist, "404.html"), status: 404 };
  if (existsSync(f) && statSync(f).isFile()) return { file: f, status: 200 };
  if (existsSync(join(f, "index.html")))
    return pathname.endsWith("/") ? { file: join(f, "index.html"), status: 200 } : { location: `${pathname}/` };
  return { file: join(dist, "404.html"), status: 404 };
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const hit = resolve(url.pathname);
  if ("location" in hit) { res.writeHead(308, { location: hit.location + url.search }); res.end(); return; }
  const headers: Record<string, string> = Object.fromEntries(headersFor(rules, url.pathname));
  const ext = extname(hit.file);
  headers["content-type"] = TYPES[ext] ?? "application/octet-stream";
  let body: Buffer = readFileSync(hit.file);
  if (COMPRESS.has(ext) && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
    body = gzipSync(body);
    headers["content-encoding"] = "gzip";
    headers["vary"] = "Accept-Encoding";
  }
  res.writeHead(hit.status, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}).listen(port, "127.0.0.1", () => console.log(`serving dist/ with _headers on http://127.0.0.1:${port}`));
```

- [ ] **Step 9: Unit tests, lint and build**

```bash
cd apps/web && bunx vitest run --coverage && cd ../..
bun run --filter @meowerse/web lint
bun run --filter @meowerse/web build
```

Expected:
- the unit tests pass with coverage ≥ 90 on `src/lib/**`;
- `astro check` shows 0 errors;
- the build prints `csp: … chars, N hashes → dist/_headers; sitemap: 1 pages`, with N ≤ 12 and
  under 2000 characters.
- `dist/_headers` has no `__CSP__` left:
  `rg -c __CSP__ apps/web/dist/_headers || echo 0` prints `0`.

- [ ] **Step 10: The e2e harness and the site-wide specs**

`apps/web/tests/e2e/fixtures.ts`:

```ts
import { test as base, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Every origin the site probes (src/content/projects). Tests never reach the real services. */
export const PROBED = /^https:\/\/(?:auth\.alxnko\.dev|meowsenger\.alxnko\.dev|alxnko\.dev)\//;

export const test = base.extend<{ stubProbes: void }>({
  stubProbes: [async ({ page }, use) => {
    await page.route(PROBED, (route) => route.fulfill({
      status: 200, body: "{}", headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
    }));
    await use();
  }, { auto: true }],
});
export { expect };

/** Site paths from the built sitemap (`bun run build` first). */
export function sitePaths(): string[] {
  const xml = readFileSync(join(process.cwd(), "dist/sitemap.xml"), "utf8");
  return [...xml.matchAll(/<loc>https:\/\/meow\.alxnko\.dev(\/[^<]*)<\/loc>/g)].map((m) => m[1]!);
}

/**
 * Visible interactive elements under 44×44 CSS px. Exempt: inline links in running text (WCAG 2.5.8),
 * `.mw-btn--sm` (36 px drawn, 44 px hit area through ::after), native checkboxes/radios inside a ≥44 px
 * label, and component previews in the /ui docs ([data-preview]: ui's own geometry tests cover those).
 */
export async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("a[href], button, summary, input, select, textarea, [role=button]")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
      if (el.closest(".sr-only, [data-preview]")) continue;
      if (el.tagName === "A" && el.closest("p, td, dd, figcaption")) continue;
      if (el.matches(".mw-btn--sm")) continue;
      const label = el.matches("input[type=checkbox], input[type=radio]") ? el.closest("label") : null;
      if (label && label.getBoundingClientRect().height >= 44) continue;
      if (r.width < 44 || r.height < 44)
        out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return out;
  });
}
```

`apps/web/tests/e2e/headers.spec.ts`:

```ts
import { test, expect } from "./fixtures";

test("every response carries the strict security headers, 404s included", async ({ request }, info) => {
  test.skip(info.project.name !== "desktop", "headers don't depend on the viewport");
  for (const path of ["/", "/does-not-exist/", "/favicon.svg"]) {
    const h = (await request.get(path)).headers();
    const csp = h["content-security-policy"] ?? "";
    expect(csp, path).toContain("default-src 'none'");
    expect(csp, path).toMatch(/script-src 'self'( 'sha256-[A-Za-z0-9+/=]+')+;/);
    expect(csp, path).toContain("frame-ancestors 'none'");
    expect(csp, path).toContain("require-trusted-types-for 'script'; trusted-types 'none'");
    expect(csp, path).not.toMatch(/unsafe-(inline|eval)/);
    expect(h["strict-transport-security"], path).toBe("max-age=31536000; includeSubDomains; preload");
    expect(h["referrer-policy"], path).toBe("no-referrer");
    expect(h["x-content-type-options"], path).toBe("nosniff");
    expect(h["cross-origin-opener-policy"], path).toBe("same-origin");
    expect(h["permissions-policy"], path).toContain("camera=()");
  }
});
```

`apps/web/tests/e2e/shell.spec.ts`:

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";

test("skip link, main landmark, theme button that persists", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.locator(".skip")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
  const btn = page.locator("[data-theme-button]");
  await expect(btn).toHaveAttribute("aria-label", "switch to light theme");
  await btn.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(btn).toHaveAttribute("aria-label", "switch to dark theme");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("B16: no write demo, no input, no token anywhere in the build", async ({ page }, info) => {
  await page.goto("/");
  await expect(page.locator("input, textarea")).toHaveCount(0);
  test.skip(info.project.name !== "desktop", "the file scan runs once");
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  for (const f of walk(join(process.cwd(), "dist")).filter((f) => /\.(html|js)$/.test(f))) {
    const src = readFileSync(f, "utf8");
    expect(src, f).not.toMatch(/PUBLIC_DEMO_TOKEN|Bearer |\/api\/meows/);
  }
});

test("the 404 page is a real page with a 404 status", async ({ page }) => {
  const res = await page.goto("/nope/");
  expect(res?.status()).toBe(404);
  await expect(page.locator("h1")).toContainText("not found");
  await expect(page.locator(".mw-header")).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
});

test("SEO basics (W-08)", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://meow.alxnko.dev/");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /one account/);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "meowerse");
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);
  expect(await (await request.get("/robots.txt")).text()).toContain("Sitemap: https://meow.alxnko.dev/sitemap.xml");
  expect(await (await request.get("/sitemap.xml")).text()).toContain("<loc>https://meow.alxnko.dev/</loc>");
  expect(await (await request.get("/.well-known/security.txt")).text()).toContain("Canonical: https://meow.alxnko.dev/");
});

test("fonts: the preloaded files are the ones the inline CSS uses", async ({ page }) => {
  await page.goto("/");
  const hrefs = await page.locator('link[rel="preload"][as="font"]').evaluateAll((ls) => ls.map((l) => l.getAttribute("href")!));
  expect(hrefs).toHaveLength(2);
  const css = await page.locator("style").allTextContents();
  for (const h of hrefs) expect(css.join("")).toContain(h);
});
```

`apps/web/tests/e2e/csp.spec.ts`:

```ts
import { test, expect, sitePaths } from "./fixtures";

// Every page, every island hydrated: no CSP or Trusted Types violation and no console error.
test("no CSP / Trusted Types violations and no console errors on any page", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one pass is enough");
  test.setTimeout(240_000);
  const problems: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") problems.push(`${page.url()} console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`${page.url()} error: ${e.message}`));
  await page.addInitScript(() =>
    addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective} ${e.blockedURI}`)));
  for (const path of sitePaths()) {
    await page.goto(path);
    await page.evaluate(async () => {
      for (let y = 0; y <= document.body.scrollHeight; y += innerHeight / 2) {
        scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
    });
    await expect.poll(() => page.locator("astro-island[ssr]").count(), { timeout: 15_000 }).toBe(0);
  }
  expect(problems).toEqual([]);
});
```

`apps/web/tests/e2e/a11y.spec.ts`:

```ts
import AxeBuilder from "@axe-core/playwright";
import { test, expect, sitePaths, smallTargets } from "./fixtures";

test("every page: axe WCAG 2.2 AA clean, one h1, one main, 44 px targets", async ({ page }, info) => {
  test.setTimeout(300_000);
  const problems: string[] = [];
  for (const path of sitePaths()) {
    await page.goto(path);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    for (const v of axe.violations)
      problems.push(`${path} axe ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
    if ((await page.locator("h1").count()) !== 1) problems.push(`${path}: expected exactly one h1`);
    if ((await page.locator("main").count()) !== 1) problems.push(`${path}: expected exactly one main`);
    for (const t of await smallTargets(page)) problems.push(`${path} (${info.project.name}) small target: ${t}`);
  }
  expect(problems).toEqual([]);
});
```

`apps/web/tests/e2e/links.spec.ts`:

```ts
import { test, expect, sitePaths } from "./fixtures";

test("external links open safely in a new tab, mailto never does, internal links resolve", async ({ page, request }, info) => {
  test.skip(info.project.name !== "desktop", "links don't depend on the viewport");
  test.setTimeout(240_000);
  const bad: string[] = [];
  const internal = new Set<string>();
  for (const path of sitePaths()) {
    await page.goto(path);
    const links = await page.locator("a[href]").evaluateAll((as) => as.map((a) => ({
      raw: a.getAttribute("href")!, abs: (a as HTMLAnchorElement).href, target: a.getAttribute("target"), rel: a.getAttribute("rel") ?? "",
    })));
    for (const l of links) {
      if (l.raw.startsWith("mailto:")) { if (l.target) bad.push(`${path}: mailto with a target`); continue; }
      const u = new URL(l.abs);
      if (u.origin !== new URL(page.url()).origin) {
        if (l.target !== "_blank" || !/\bnoopener\b/.test(l.rel) || !/\bnoreferrer\b/.test(l.rel))
          bad.push(`${path}: ${l.raw} target=${l.target} rel="${l.rel}"`);
      } else {
        if (l.target) bad.push(`${path}: same-site ${l.raw} opens a new tab`);
        internal.add(u.pathname);
      }
    }
  }
  for (const p of internal) {
    const status = (await request.get(p)).status();
    if (status !== 200) bad.push(`${p} → ${status}`);
  }
  expect(bad).toEqual([]);
});
```

Run:

```bash
bun run --filter @meowerse/web build && bun run --filter @meowerse/web e2e
```

Expected: every spec passes on desktop and phone (the desktop-only ones skip on phone).

- [ ] **Step 11: Commit**

```bash
git add -A apps/web packages/brand/scripts/build.sh .gitignore bun.lock
git commit -m "feat(web): rebuild meow.alxnko.dev's shell on @meowerse/ui with a strict CSP

Removes the token-in-page write demo and its dead client (B16, W-01, W-02, W-10). Static Astro
with the React integration for server rendering only; one inlined stylesheet (one CSP hash);
fonts preloaded; skip link, main landmark, header nav with aria-current, the theme button without
React, a real 404 on the layout (W-03, W-07, W-17). The postbuild hashes every inline block into
one CSP with Trusted Types, refuses style attributes, data: URLs and external CSS, and writes the
sitemap; _headers adds HSTS, Permissions-Policy, COOP/CORP and noindex on *.pages.dev (W-08, W-09).
Playwright checks headers, CSP violations, axe, 44 px targets and links on every built page.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 4: Project pages from a typed content collection, with live status and diagrams (B11, B13; spec §5.1; W-05)

**Files:**
- Create:
  - `apps/web/src/lib/project-schema.ts` (+`.test.ts`);
  - `apps/web/src/lib/probe.ts` (+`.test.ts`);
  - `apps/web/src/lib/status-dom.ts` (+`.test.tsx`);
  - `apps/web/src/lib/probe-runner.ts` (+`.test.ts`);
  - `apps/web/src/content.config.ts`;
  - `apps/web/src/content/projects/{auth,meowsenger,ui,moonmeow,sunmeow,alxnko-dev}.json`;
  - `apps/web/src/components/ProjectStatus.astro`, `apps/web/src/components/Diagram.astro`;
  - `apps/web/src/pages/p/[slug].astro`;
  - `apps/web/tests/e2e/projects.spec.ts`, `apps/web/tests/e2e/probes.spec.ts`.
- Modify: `apps/web/src/styles/site.css` (append the "projects" section),
  `workers/meowsenger/src/index.ts`, `workers/meowsenger/src/index.test.ts`

**Interfaces:**
- Consumes: Task 3's `BaseLayout`, `linkAttrs`, `isExternal`, and the e2e fixtures (`PROBED`).
- Produces:
  - `projectSchema` (zod), `Project`, `ProjectStatus`;
  - `publicFactProblems(slug: string, p: Project): string[]`;
  - `PROBE_TIMEOUT_MS = 5000`;
  - `probe(url, { method?, timeoutMs?, fetchImpl?, now? }): Promise<ProbeResult>`, where
    `ProbeResult = { state: "up"; ms } | { state: "down"; status } | { state: "unknown"; reason: "timeout" | "network" }`;
  - `describeProbe(name, result | "pending", timeoutMs?): { state: StatusState; text: string }`;
  - `setStatus(p: HTMLElement, state: StatusState, text: string): void`, which keeps a server-rendered
    `<StatusLine live>` in sync;
  - `runProbes(doc?, { fetchImpl?, timeoutMs?, watch? }): Promise<void>`, which drives every
    `[data-probe]` row and every `[data-probe-retry]` button;
  - `ProjectStatus.astro`, props `{ name: string; status: ProjectStatus }`;
  - `Diagram.astro`, props `{ id: string; label: string; steps: { title: string; note: string }[] }`;
  - the content collection `projects`, with ids `auth`, `meowsenger`, `ui`, `moonmeow`, `sunmeow`,
    `alxnko-dev`. `data.service` is true for auth and meowsenger only.

- [ ] **Step 1: Write the failing unit tests**

`apps/web/src/lib/project-schema.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectSchema, publicFactProblems, type Project } from "./project-schema";

const dir = join(__dirname, "../content/projects");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
const load = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Project;

describe("project content (B11, B13)", () => {
  it("has exactly the six decided projects", () =>
    expect(files.map((f) => f.replace(/\.json$/, "")).sort()).toEqual(["alxnko-dev", "auth", "meowsenger", "moonmeow", "sunmeow", "ui"]));
  it.each(files)("%s matches the schema", (f) => {
    const r = projectSchema.safeParse(load(f));
    expect(r.success ? [] : r.error.issues).toEqual([]);
  });
  it("orders are 1..6 without gaps, and only auth and meowsenger are live services", () => {
    expect(files.map((f) => load(f).order).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(files.filter((f) => load(f).service).map((f) => f.replace(/\.json$/, "")).sort()).toEqual(["auth", "meowsenger"]);
  });
  it.each(files)("%s states public facts only", (f) => expect(publicFactProblems(f.replace(/\.json$/, ""), load(f))).toEqual([]));
  it("the guard catches network details anywhere and a real name on the alxnko.dev page", () => {
    const base = load("moonmeow.json");
    expect(publicFactProblems("moonmeow", { ...base, how: ["Streams over Tailscale to 100.64.0.1 after pairing."] })).toHaveLength(3);
    expect(publicFactProblems("alxnko-dev", { ...load("alxnko-dev.json"), what: ["Made by Alex Neko, tech lead."] })).toHaveLength(2);
  });
});
```

`apps/web/src/lib/probe.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { describeProbe, probe, PROBE_TIMEOUT_MS } from "./probe";

const ok = (status = 200) => vi.fn(async () => ({ ok: status < 400, status, body: null }) as unknown as Response);

describe("probe", () => {
  it("asks with CORS, no credentials, no cache, and times the answer", async () => {
    const f = ok();
    let t = 100;
    const r = await probe("https://x.example/health", { fetchImpl: f, now: () => (t += 42) });
    expect(r).toEqual({ state: "up", ms: 42 });
    expect(f).toHaveBeenCalledWith("https://x.example/health", expect.objectContaining({
      method: "GET", mode: "cors", credentials: "omit", cache: "no-store", signal: expect.any(AbortSignal),
    }));
  });
  it("an error answer is down, with its status", async () =>
    expect(await probe("u", { fetchImpl: ok(503), method: "HEAD" })).toEqual({ state: "down", status: 503 }));
  it("no answer in time is unknown (timeout), not down", async () => {
    const hang = vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    expect(await probe("u", { fetchImpl: hang as unknown as typeof fetch, timeoutMs: 10 })).toEqual({ state: "unknown", reason: "timeout" });
  });
  it("a network or CORS failure is unknown (network)", async () =>
    expect(await probe("u", { fetchImpl: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) }))
      .toEqual({ state: "unknown", reason: "network" }));
  it("describes every outcome in plain words (B9)", () => {
    expect(PROBE_TIMEOUT_MS).toBe(5000);
    expect(describeProbe("auth", "pending")).toEqual({ state: "wait", text: "auth — checking…" });
    expect(describeProbe("auth", { state: "up", ms: 0.4 })).toEqual({ state: "ok", text: "auth — up · 1 ms" });
    expect(describeProbe("auth", { state: "down", status: 502 })).toEqual({ state: "fail", text: "auth — down · answered 502" });
    expect(describeProbe("auth", { state: "unknown", reason: "timeout" })).toEqual({ state: "info", text: "auth — unknown · no answer in 5 s" });
    expect(describeProbe("auth", { state: "unknown", reason: "network" })).toEqual({ state: "info", text: "auth — unknown · couldn't reach it from here" });
  });
});
```

`apps/web/src/lib/status-dom.test.tsx`:

```tsx
// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusLine, type StatusState } from "@meowerse/ui";
import { setStatus } from "./status-dom";

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html").body.firstElementChild as HTMLElement;

describe("setStatus keeps a server-rendered StatusLine identical to what StatusLine renders", () => {
  it.each(["ok", "wait", "fail", "info"] as StatusState[])("→ %s", (state) => {
    const el = parse(renderToStaticMarkup(<StatusLine state="wait" live>auth — checking…</StatusLine>));
    setStatus(el, state, "auth — done");
    expect(el.outerHTML).toBe(renderToStaticMarkup(<StatusLine state={state} live>auth — done</StatusLine>));
  });
  it("keeps extra classes after the state class", () => {
    const el = parse(renderToStaticMarkup(<StatusLine state="wait" live className="x">a</StatusLine>));
    setStatus(el, "ok", "b");
    expect(el.className).toBe("mw-status mw-status--ok x");
  });
});
```

`apps/web/src/lib/probe-runner.test.ts`:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runProbes } from "./probe-runner";

function page() {
  const row = (name: string, url: string) => {
    const d = document.createElement("div");
    d.setAttribute("data-probe", "");
    d.dataset.name = name;
    d.dataset.url = url;
    d.dataset.method = "GET";
    const p = document.createElement("p");
    p.className = "mw-status mw-status--wait";
    for (const c of ["mw-status__tag", "sr-only", "mw-status__text"]) { const s = document.createElement("span"); s.className = c; p.append(s); }
    d.append(p);
    return d;
  };
  const retry = document.createElement("button");
  retry.setAttribute("data-probe-retry", "");
  retry.hidden = true;
  document.body.replaceChildren(row("auth", "https://a.example/"), row("chat", "https://b.example/"), retry);
  return { retry, text: (i: number) => document.querySelectorAll(".mw-status__text")[i]!.textContent };
}

describe("runProbes", () => {
  beforeEach(() => document.body.replaceChildren());
  it("shows a wait state, then each result; the retry button appears and is busy while running", async () => {
    const p = page();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = vi.fn(async (url: string) => { await gate; return { ok: !url.includes("b."), status: url.includes("b.") ? 500 : 200, body: null } as unknown as Response; });
    const done = runProbes(document, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(p.text(0)).toBe("auth — checking…");
    expect(p.retry.hidden).toBe(false);
    expect(p.retry.disabled).toBe(true);
    expect(p.retry.textContent).toBe("checking…");
    expect(p.retry.getAttribute("aria-busy")).toBe("true");
    release();
    await done;
    expect(p.text(0)).toMatch(/^auth — up · \d+ ms$/);
    expect(p.text(1)).toBe("chat — down · answered 500");
    expect(p.retry.disabled).toBe(false);
    expect(p.retry.textContent).toBe("check again");
    expect(p.retry.hasAttribute("aria-busy")).toBe(false);
  });
  it("check again runs them once more (a second click while running is ignored)", async () => {
    const p = page();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: null }) as unknown as Response);
    await runProbes(document, { fetchImpl: fetchImpl as unknown as typeof fetch });
    p.retry.click();
    p.retry.click();
    await vi.waitFor(() => expect(p.retry.disabled).toBe(false));
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it("re-checks on a bfcache restore when watching", async () => {
    page();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: null }) as unknown as Response);
    await runProbes(document, { fetchImpl: fetchImpl as unknown as typeof fetch, watch: true });
    dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
  });
  it("is a no-op on a page without probes", async () => {
    await expect(runProbes(document)).resolves.toBeUndefined();
  });
});
```

In `workers/meowsenger/src/index.test.ts`, add inside `describe("router", …)`:

```ts
  it("GET /health answers any origin without credentials and is never cached (meow.alxnko.dev probe)", async () => {
    const res = await handle(new Request("https://meowsenger.alxnko.dev/health", { headers: { Origin: "https://meow.alxnko.dev" } }), env, deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run:
- `cd apps/web && bunx vitest run src/lib/project-schema.test.ts src/lib/probe.test.ts src/lib/status-dom.test.tsx src/lib/probe-runner.test.ts`
- `bun run --filter @meowerse/meowsenger-worker test:node`

Expected: FAIL. The modules and the content files are missing, and `/health` sends credentialed,
origin-reflecting CORS.

- [ ] **Step 3: meowsenger `/health` (the only server change in this sub-project)**

In `workers/meowsenger/src/index.ts`, replace

```ts
  if (path === "/health" && (m === "GET" || m === "HEAD")) return json({ ok: true }, 200, cors);
```

with

```ts
  // meow.alxnko.dev probes this cross-origin for its live status list: a plain public CORS answer
  // (no credentials, no Vary), never cached, so "up" always means up right now.
  if (path === "/health" && (m === "GET" || m === "HEAD"))
    return json({ ok: true }, 200, { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
```

- [ ] **Step 4: Schema, probe, status DOM, runner**

`apps/web/src/lib/project-schema.ts`:

```ts
// Project pages (B11): typed content validated at build (content.config.ts) and by the unit tests.
import { z } from "astro/zod";

const https = z.url({ protocol: /^https$/ });

export const statusSchema = z.discriminatedUnion("kind", [
  // a live check of a public, CORS-readable endpoint (its origin becomes a connect-src entry)
  z.strictObject({ kind: z.literal("probe"), url: https, method: z.enum(["GET", "HEAD"]) }),
  // nothing public to check: say so instead of pretending (B9)
  z.strictObject({ kind: z.literal("static"), state: z.enum(["info"]), text: z.string().min(1).max(80) }),
]);

export const projectSchema = z.strictObject({
  name: z.string().min(1).max(24),
  order: z.number().int().min(1),
  service: z.boolean(),
  summary: z.string().min(10).max(110),
  what: z.array(z.string().min(10)).min(2).max(6),
  how: z.array(z.string().min(10)).min(2).max(6),
  diagram: z.strictObject({
    label: z.string().min(10),
    steps: z.array(z.strictObject({ title: z.string().min(1).max(22), note: z.string().min(1).max(34) })).min(3).max(6),
  }),
  facts: z.array(z.strictObject({ k: z.string().min(1).max(16), v: z.string().min(1).max(80) })).min(2).max(8),
  status: statusSchema,
  links: z.array(z.strictObject({ label: z.string().min(1).max(24), href: z.string().regex(/^(https:\/\/|\/)/) })).min(1).max(3),
});

export type Project = z.infer<typeof projectSchema>;
export type ProjectStatus = Project["status"];

// B13: no network, Tailscale, IP or pairing details on any page; no real name or employer on alxnko.dev.
const EVERYWHERE: readonly RegExp[] = [
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/, /tailscale/i, /\bderp\b/i, /\bmtu\b/i, /\bpair(?:ing|ed|s)?\b/i,
  /\bport\s*\d+/i, /\blan\b/i, /\bvpn\b/i, /wireguard/i, /\baws\b|eu-west|ireland/i, /\.internal\b|\.local\b/i,
  /\bsecret\b|password=|token=/i,
];
const ALXNKO_DEV: readonly RegExp[] = [/neko|nyrko/i, /tech lead|company|employer|linkedin|kyrgyz/i];

const strings = (v: unknown): string[] =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];

/** Every forbidden pattern found in a project's copy, as "pattern in: text" lines. */
export function publicFactProblems(slug: string, p: Project): string[] {
  const rules = slug === "alxnko-dev" ? [...EVERYWHERE, ...ALXNKO_DEV] : EVERYWHERE;
  const text = strings(p);
  return rules.flatMap((re) => text.filter((t) => re.test(t)).map((t) => `${re} in: ${t}`));
}
```

The guard test counts problems. For moonmeow, "Streams over Tailscale to 100.64.0.1 after pairing." hits
three rules (IP, tailscale, pair). For alxnko-dev, "Made by Alex Neko, tech lead." hits two (neko,
tech lead).

`apps/web/src/lib/probe.ts`:

```ts
// Live service status (spec §5, B9): one CORS request with a timeout, and an honest reading of it.
import type { StatusState } from "@meowerse/ui";

export const PROBE_TIMEOUT_MS = 5000;

export type ProbeResult =
  | { state: "up"; ms: number }
  | { state: "down"; status: number }
  | { state: "unknown"; reason: "timeout" | "network" };

type ProbeOpts = { method?: "GET" | "HEAD"; timeoutMs?: number; fetchImpl?: typeof fetch; now?: () => number };

/** Never throws. An error status is "down"; no answer or a blocked request is "unknown", never "down". */
export async function probe(url: string, opts: ProbeOpts = {}): Promise<ProbeResult> {
  const { method = "GET", timeoutMs = PROBE_TIMEOUT_MS, now = () => performance.now() } = opts;
  const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  const t0 = now();
  try {
    const res = await fetchImpl(url, { method, mode: "cors", credentials: "omit", cache: "no-store", redirect: "follow", signal: ac.signal });
    const ms = now() - t0;
    res.body?.cancel().catch(() => { /* only the status matters */ });
    return res.ok ? { state: "up", ms } : { state: "down", status: res.status };
  } catch {
    return { state: "unknown", reason: timedOut ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** The StatusLine state and our lowercase copy for a probe outcome. */
export function describeProbe(name: string, r: ProbeResult | "pending", timeoutMs = PROBE_TIMEOUT_MS): { state: StatusState; text: string } {
  if (r === "pending") return { state: "wait", text: `${name} — checking…` };
  switch (r.state) {
    case "up": return { state: "ok", text: `${name} — up · ${Math.max(1, Math.round(r.ms))} ms` };
    case "down": return { state: "fail", text: `${name} — down · answered ${r.status}` };
    case "unknown":
      return {
        state: "info",
        text: r.reason === "timeout" ? `${name} — unknown · no answer in ${timeoutMs / 1000} s` : `${name} — unknown · couldn't reach it from here`,
      };
  }
}
```

`apps/web/src/lib/status-dom.ts`:

```ts
// Updates a server-rendered <StatusLine live> in place without React. The status-dom test compares the
// result with StatusLine's own markup for every state, so the two can't drift apart.
import type { StatusState } from "@meowerse/ui";

const TAG: Record<StatusState, string> = { ok: "[ ok ]", wait: "[wait]", fail: "[fail]", info: "[info]" };
const WORD: Record<StatusState, string> = { ok: "ok", wait: "working", fail: "error", info: "info" };

export function setStatus(p: HTMLElement, state: StatusState, text: string): void {
  const rest = [...p.classList].filter((c) => c !== "mw-status" && !c.startsWith("mw-status--"));
  p.className = ["mw-status", `mw-status--${state}`, ...rest].join(" ");
  p.setAttribute("role", state === "fail" ? "alert" : "status");
  const tag = p.querySelector(".mw-status__tag");
  const word = p.querySelector(":scope > .sr-only");
  const body = p.querySelector(".mw-status__text");
  if (tag) tag.textContent = TAG[state];
  if (word) word.textContent = `${WORD[state]}: `;
  if (body) body.textContent = text;
}
```

`apps/web/src/lib/probe-runner.ts`:

```ts
// Drives every [data-probe] row on a page (ProjectStatus.astro) and the [data-probe-retry] buttons:
// a visible wait, a 5 s timeout, plain results, and a retry that is disabled with its reason while busy (B9).
import { describeProbe, probe, PROBE_TIMEOUT_MS } from "./probe";
import { setStatus } from "./status-dom";

type Opts = { fetchImpl?: typeof fetch; timeoutMs?: number; watch?: boolean };

export function runProbes(doc: Document = document, opts: Opts = {}): Promise<void> {
  const { fetchImpl, timeoutMs = PROBE_TIMEOUT_MS, watch = false } = opts;
  const rows = [...doc.querySelectorAll<HTMLElement>("[data-probe]")];
  const retry = [...doc.querySelectorAll<HTMLButtonElement>("[data-probe-retry]")];
  if (!rows.length) return Promise.resolve();
  let running: Promise<void> | null = null;

  const busy = (on: boolean) => {
    for (const b of retry) {
      b.hidden = false;
      b.disabled = on;
      b.textContent = on ? "checking…" : "check again";
      if (on) b.setAttribute("aria-busy", "true");
      else b.removeAttribute("aria-busy");
    }
  };

  const run = (): Promise<void> => {
    if (running) return running;
    busy(true);
    running = Promise.all(rows.map(async (row) => {
      const p = row.querySelector<HTMLElement>(".mw-status");
      if (!p) return;
      const name = row.dataset.name ?? "service";
      const wait = describeProbe(name, "pending", timeoutMs);
      setStatus(p, wait.state, wait.text);
      const r = await probe(row.dataset.url ?? "", { method: row.dataset.method === "HEAD" ? "HEAD" : "GET", timeoutMs, fetchImpl });
      const d = describeProbe(name, r, timeoutMs);
      setStatus(p, d.state, d.text);
      row.dataset.state = r.state;
    })).then(() => { busy(false); running = null; });
    return running;
  };

  for (const b of retry) b.addEventListener("click", () => void run());
  if (watch) addEventListener("pageshow", (e) => { if ((e as PageTransitionEvent).persisted) void run(); });
  return run();
}
```

- [ ] **Step 5: The content collection**

`apps/web/src/content.config.ts`:

```ts
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { projectSchema } from "./lib/project-schema";

export const collections = {
  projects: defineCollection({ loader: glob({ pattern: "*.json", base: "./src/content/projects" }), schema: projectSchema }),
};
```

The six files hold public facts only. Each is sourced from:
- `apps/auth-web` about/privacy and the auth spec;
- the meowsenger spec and `workers/meowsenger` routes;
- the brand-v2 spec and `packages/ui`;
- the public moonmeow and sunmeow READMEs;
- what alxnko.dev visibly does.

Long-form copy is sentence case; labels and diagram text are lowercase.

`apps/web/src/content/projects/auth.json`:

```json
{
  "name": "auth",
  "order": 1,
  "service": true,
  "summary": "One meowerse account for every meowerse app: sign in with a password or with Telegram.",
  "what": [
    "Meowerse accounts is the sign-in that meowsenger and other meowerse apps use.",
    "You create one account, then choose app by app what it may see: your username, your Telegram link, or whether your account is verified.",
    "You can verify your account by linking Telegram, keep one-time recovery codes, and revoke any app's access from your account page.",
    "There is no email, no advertising and no analytics."
  ],
  "how": [
    "It is an OAuth 2.0 and OpenID Connect provider. An app sends you to /authorize with PKCE (S256, required for every app) and gets a one-time code back.",
    "The app exchanges the code at /token for ES256-signed ID and access tokens, which anyone can check against the published JWKS.",
    "Passwords are stored only as salted PBKDF2-SHA256 hashes, and a session is a __Host- cookie that holds a random ID.",
    "One Cloudflare Worker serves both the pages and the API; account data lives in Turso."
  ],
  "diagram": {
    "label": "Sign-in flow: an app sends you to auth, you sign in and consent, and the app gets signed tokens.",
    "steps": [
      { "title": "your app", "note": "sends you to /authorize" },
      { "title": "auth.alxnko.dev", "note": "password or telegram" },
      { "title": "consent", "note": "you choose what it sees" },
      { "title": "one-time code", "note": "exchanged at /token + pkce" },
      { "title": "signed tokens", "note": "es256, checked via jwks" }
    ]
  },
  "facts": [
    { "k": "protocol", "v": "OpenID Connect, authorization code flow with PKCE" },
    { "k": "tokens", "v": "ES256 JWTs, public keys at /jwks" },
    { "k": "sign-in", "v": "username and password, or Telegram" },
    { "k": "runs on", "v": "Cloudflare Workers, Turso" }
  ],
  "status": { "kind": "probe", "url": "https://auth.alxnko.dev/.well-known/openid-configuration", "method": "GET" },
  "links": [
    { "label": "open auth", "href": "https://auth.alxnko.dev/" },
    { "label": "source", "href": "https://github.com/meowerse/meowerse/tree/master/workers/auth" }
  ]
}
```

`apps/web/src/content/projects/meowsenger.json`:

```json
{
  "name": "meowsenger",
  "order": 2,
  "service": true,
  "summary": "A real-time messenger you sign in to with your meowerse account.",
  "what": [
    "Chats with one person, groups and channels, with replies, edits, deletes, forwarding, reactions and search.",
    "Groups have invite links and join requests, and a channel can be public, with its own address.",
    "It shows who is typing, who is online and who has read a message.",
    "There is no separate password: you sign in with meowerse accounts.",
    "Messages are not end-to-end encrypted. They travel over HTTPS and are stored on the server, which is what lets history and search work on every device."
  ],
  "how": [
    "The web app is Astro with React islands, served by the same Cloudflare Worker as the API, which is an OpenID Connect client of meowerse accounts.",
    "Each chat is a Durable Object: a new message is written to its SQLite storage and broadcast to everyone connected over WebSockets.",
    "Chats and message history are also synced to D1, off the send path."
  ],
  "diagram": {
    "label": "Message path: your browser talks to the meowsenger Worker; each chat's Durable Object stores and broadcasts; D1 keeps a synced copy.",
    "steps": [
      { "title": "your browser", "note": "astro + react islands" },
      { "title": "meowsenger worker", "note": "sign-in + api" },
      { "title": "chat durable object", "note": "sqlite + websockets" },
      { "title": "d1", "note": "synced off the send path" }
    ]
  },
  "facts": [
    { "k": "sign-in", "v": "meowerse accounts (OpenID Connect)" },
    { "k": "realtime", "v": "WebSockets through one Durable Object per chat" },
    { "k": "storage", "v": "Durable Object SQLite, Cloudflare D1" },
    { "k": "encryption", "v": "HTTPS in transit; not end-to-end encrypted" }
  ],
  "status": { "kind": "probe", "url": "https://meowsenger.alxnko.dev/health", "method": "GET" },
  "links": [
    { "label": "open meowsenger", "href": "https://meowsenger.alxnko.dev/" },
    { "label": "source", "href": "https://github.com/meowerse/meowerse/tree/master/workers/meowsenger" }
  ]
}
```

`apps/web/src/content/projects/ui.json`:

```json
{
  "name": "ui library",
  "order": 3,
  "service": false,
  "summary": "The design system every meowerse app is built with; it shares its tokens with alxnko.dev.",
  "what": [
    "One set of colours, type, spacing and motion, and the components built on them: buttons, fields, dialogs, status lines, the chat prompt and more.",
    "Dark by default with a light \"day paper\" theme; every colour combination used for text is checked for WCAG AA contrast by a test.",
    "Terminal touches (the › prompt, [ ok ] status lines, a blinking cursor on the wordmark) appear only where they keep an app easy to use.",
    "Its documentation, with every component rendered live, is on this site."
  ],
  "how": [
    "The tokens live in one tokens.json. A script generates the CSS custom properties, and CI fails when the generated file is out of date.",
    "A drift check compares the tokens with alxnko.dev's copy, so both sites stay one system.",
    "Components are React, styled only through the generated tokens. Astro renders them to static HTML and hydrates only the ones that need to be interactive.",
    "JetBrains Mono sets all text and VT323 only the wordmarks, both served as small woff2 files."
  ],
  "diagram": {
    "label": "From tokens to apps: tokens.json generates the CSS variables, the React components use them, and every meowerse app ships them.",
    "steps": [
      { "title": "tokens.json", "note": "one source of truth" },
      { "title": "tokens.gen.css", "note": "generated, checked in ci" },
      { "title": "@meowerse/ui", "note": "react components" },
      { "title": "the apps", "note": "auth, meowsenger, this site" }
    ]
  },
  "facts": [
    { "k": "package", "v": "@meowerse/ui, in the meowerse monorepo" },
    { "k": "components", "v": "React 19, typed with TypeScript" },
    { "k": "themes", "v": "dark (default) and light, following the system" },
    { "k": "docs", "v": "meow.alxnko.dev/ui" }
  ],
  "status": { "kind": "static", "state": "info", "text": "a library, not a service: it ships inside each app" },
  "links": [
    { "label": "read the docs", "href": "/ui/" },
    { "label": "source", "href": "https://github.com/meowerse/meowerse/tree/master/packages/ui" }
  ]
}
```

`apps/web/src/content/projects/moonmeow.json`:

```json
{
  "name": "moonmeow",
  "order": 4,
  "service": false,
  "summary": "An Android app for using your computer's desktop from your phone.",
  "what": [
    "Moonmeow shows your computer's screen on your phone and sends your touches, typing and mouse back, so you can write code, read logs or drive a terminal away from your desk.",
    "It is tuned for desktop and office work rather than games: text input, pointer precision, keyboard shortcuts that get past Android, and resolutions that match a phone screen.",
    "It works with sunmeow, and also with Sunshine and Apollo hosts.",
    "There are no prebuilt releases yet: it is built from source."
  ],
  "how": [
    "It is a fork of Artemis, which is itself a fork of Moonlight, so it speaks the Moonlight streaming protocol.",
    "The host encodes the desktop as video; moonmeow decodes it on the phone and sends input events back.",
    "It runs on Android 8.0 or newer and is licensed under the GPL-3.0."
  ],
  "diagram": {
    "label": "Streaming loop: the host captures and encodes the desktop, moonmeow decodes it on the phone, and your input goes back.",
    "steps": [
      { "title": "host (sunmeow)", "note": "captures + encodes" },
      { "title": "video stream", "note": "moonlight protocol" },
      { "title": "moonmeow (phone)", "note": "decodes + shows it" },
      { "title": "your input", "note": "touch, keys, mouse → host" }
    ]
  },
  "facts": [
    { "k": "platform", "v": "Android 8.0 or newer" },
    { "k": "fork of", "v": "Artemis (Moonlight)" },
    { "k": "hosts", "v": "sunmeow, Sunshine, Apollo" },
    { "k": "license", "v": "GPL-3.0" }
  ],
  "status": { "kind": "static", "state": "info", "text": "runs on your own devices: there's no public service to check" },
  "links": [
    { "label": "source", "href": "https://github.com/meowerse/moonmeow" }
  ]
}
```

`apps/web/src/content/projects/sunmeow.json`:

```json
{
  "name": "sunmeow",
  "order": 5,
  "service": false,
  "summary": "The host side: it streams a computer's desktop to moonmeow.",
  "what": [
    "Sunmeow runs on your computer, captures its desktop and streams it to moonmeow on your phone.",
    "It is meant for real coding and office work from a phone, not for game sessions.",
    "It is a fork of Sunshine: nearly all of its code is Sunshine's, and it stays under the GPL-3.0."
  ],
  "how": [
    "It captures the screen, encodes it as video on the GPU and streams it to the client; input from the client is replayed on the desktop.",
    "It follows upstream Sunshine rather than Apollo, so it keeps upstream's Linux capture and encoding fixes.",
    "Its main target is a Linux desktop."
  ],
  "diagram": {
    "label": "Host loop: sunmeow captures the desktop, encodes it on the GPU, streams it to moonmeow, and replays the input it gets back.",
    "steps": [
      { "title": "your desktop", "note": "linux" },
      { "title": "capture", "note": "the screen, frame by frame" },
      { "title": "gpu encode", "note": "video" },
      { "title": "moonmeow", "note": "decodes, sends input back" }
    ]
  },
  "facts": [
    { "k": "role", "v": "streaming host for moonmeow" },
    { "k": "fork of", "v": "LizardByte/Sunshine" },
    { "k": "target", "v": "Linux desktops" },
    { "k": "license", "v": "GPL-3.0" }
  ],
  "status": { "kind": "static", "state": "info", "text": "runs on your own devices: there's no public service to check" },
  "links": [
    { "label": "source", "href": "https://github.com/meowerse/sunmeow" }
  ]
}
```

`apps/web/src/content/projects/alxnko-dev.json`:

```json
{
  "name": "alxnko.dev",
  "order": 6,
  "service": false,
  "summary": "A personal site that is a terminal first and, on capable devices, a 3D desk.",
  "what": [
    "A working terminal in the browser: try help, ls or meow.",
    "On devices that can handle it, the page becomes an interactive 3D model of a desk, with the live terminal and the contacts on its screens.",
    "The green cat on that desk is the one at the top of this site's home page."
  ],
  "how": [
    "Static Astro pages with vanilla TypeScript: the terminal and the contacts work with no 3D and no network.",
    "A small script decides before the first paint whether the device can take 3D; three.js then loads as its own chunk.",
    "The desk is modelled and lit in Blender and shipped as one compressed glTF file.",
    "A strict hash-based Content Security Policy with Trusted Types, and no third-party scripts."
  ],
  "diagram": {
    "label": "Page first: the terminal works at once; capable devices then load three.js and the desk.",
    "steps": [
      { "title": "static page", "note": "terminal + contacts" },
      { "title": "capability check", "note": "before the first paint" },
      { "title": "three.js chunk", "note": "loads only if it fits" },
      { "title": "3d desk", "note": "live terminal on its screens" }
    ]
  },
  "facts": [
    { "k": "built with", "v": "Astro, TypeScript, three.js, Blender" },
    { "k": "security", "v": "hash-based CSP, Trusted Types, no third-party scripts" },
    { "k": "hosting", "v": "Cloudflare Pages" }
  ],
  "status": { "kind": "probe", "url": "https://alxnko.dev/", "method": "HEAD" },
  "links": [
    { "label": "open alxnko.dev", "href": "https://alxnko.dev/" }
  ]
}
```

- [ ] **Step 6: Components, page and styles**

`apps/web/src/components/ProjectStatus.astro`:

```astro
---
// A live status line: server-rendered [wait], then probe-runner.ts reads the endpoint (B9).
// Static statuses say plainly why there is nothing to check.
import { StatusLine } from "@meowerse/ui";
import type { ProjectStatus } from "../lib/project-schema";
import { describeProbe } from "../lib/probe";

interface Props { name: string; status: ProjectStatus }
const { name, status } = Astro.props;
const wait = describeProbe(name, "pending");
---
{status.kind === "probe" ? (
  <div class="probe" data-probe data-name={name} data-url={status.url} data-method={status.method}>
    <StatusLine state={wait.state} live children={wait.text} />
    <noscript><p class="mw-muted">live status needs JavaScript.</p></noscript>
  </div>
) : (
  <div class="probe">
    <StatusLine state={status.state} children={`${name} — ${status.text}`} />
  </div>
)}
```

`apps/web/src/components/Diagram.astro`:

```astro
---
// A small "how it works" diagram (spec §5.1): a vertical chain of boxes, drawn with token classes so it
// reads in both themes; the steps are also a list for screen readers.
interface Props { id: string; label: string; steps: { title: string; note: string }[] }
const { id, label, steps } = Astro.props;
const W = 320, BOX = 56, GAP = 28, X = 16, cx = W / 2;
const H = steps.length * BOX + (steps.length - 1) * GAP + 2;
---
<figure class="diagram">
  <svg class="diagram__svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-title`} aria-describedby={`${id}-steps`}>
    <title id={`${id}-title`}>{label}</title>
    {steps.map((s, i) => {
      const y = 1 + i * (BOX + GAP);
      const end = y + BOX + GAP - 2;
      return (
        <g>
          <rect class="dg-box" x="1" y={y} width={W - 2} height={BOX} rx="4" />
          <text class="dg-title" x={X} y={y + 23}>{s.title}</text>
          <text class="dg-note" x={X} y={y + 43}>{s.note}</text>
          {i < steps.length - 1 && (
            <path class="dg-arrow" d={`M${cx} ${y + BOX + 1} V${end} M${cx - 5} ${end - 6} L${cx} ${end} L${cx + 5} ${end - 6}`} />
          )}
        </g>
      );
    })}
  </svg>
  <ol id={`${id}-steps`} class="sr-only">{steps.map((s) => <li>{s.title}: {s.note}</li>)}</ol>
  <figcaption class="diagram__caption">{label}</figcaption>
</figure>
```

`apps/web/src/pages/p/[slug].astro`:

```astro
---
import { getCollection, type CollectionEntry } from "astro:content";
import BaseLayout from "../../layouts/BaseLayout.astro";
import ProjectStatus from "../../components/ProjectStatus.astro";
import Diagram from "../../components/Diagram.astro";
import { isExternal, linkAttrs } from "../../lib/site";

export async function getStaticPaths() {
  const all = (await getCollection("projects")).sort((a, b) => a.data.order - b.data.order);
  return all.map((entry, i) => ({ params: { slug: entry.id }, props: { entry, prev: all[i - 1], next: all[i + 1] } }));
}
interface Props { entry: CollectionEntry<"projects">; prev?: CollectionEntry<"projects">; next?: CollectionEntry<"projects"> }
const { entry, prev, next } = Astro.props;
const d = entry.data;
---
<BaseLayout title={d.name} description={d.summary}>
  <article class="project" aria-labelledby="project-title">
    <nav class="crumbs" aria-label="breadcrumb">
      <a href="/#projects">projects</a><span aria-hidden="true">/</span><span aria-current="page">{d.name}</span>
    </nav>
    <header class="project__head">
      <h1 id="project-title" class="prompt-title project__title"><span class="prompt-title__glyph" aria-hidden="true">› </span>{d.name}</h1>
      <p class="lede">{d.summary}</p>
      <ProjectStatus name={d.name} status={d.status} />
      <div class="btn-row">
        {d.links.map((l, i) => (
          <a class={`mw-btn mw-btn--md ${i === 0 ? "mw-btn--primary" : "mw-btn--secondary"}`} href={l.href} {...linkAttrs(l.href)}>
            {l.label}
            {isExternal(l.href) && <><span class="ext-mark" aria-hidden="true"> ↗</span><span class="sr-only"> (opens in a new tab)</span></>}
          </a>
        ))}
      </div>
    </header>
    <section class="project__section" aria-labelledby="what-title">
      <h2 id="what-title">what it is</h2>
      <ul class="project__list">{d.what.map((t) => <li>{t}</li>)}</ul>
    </section>
    <section class="project__section" aria-labelledby="how-title">
      <h2 id="how-title">how it works</h2>
      <div class="project__how">
        <ul class="project__list">{d.how.map((t) => <li>{t}</li>)}</ul>
        <Diagram id={`dg-${entry.id}`} label={d.diagram.label} steps={d.diagram.steps} />
      </div>
    </section>
    <section class="project__section" aria-labelledby="facts-title">
      <h2 id="facts-title">at a glance</h2>
      <dl class="facts">{d.facts.map((f) => <div class="facts__row"><dt>{f.k}</dt><dd>{f.v}</dd></div>)}</dl>
    </section>
    <nav class="project__pager" aria-label="other projects">
      {prev ? <a class="mw-btn mw-btn--ghost mw-btn--md" href={`/p/${prev.id}/`}><span aria-hidden="true">← </span>{prev.data.name}</a> : <span />}
      {next && <a class="mw-btn mw-btn--ghost mw-btn--md" href={`/p/${next.id}/`}>{next.data.name}<span aria-hidden="true"> →</span></a>}
    </nav>
  </article>
  <script>
    import { runProbes } from "../../lib/probe-runner";
    void runProbes(document, { watch: true });
  </script>
</BaseLayout>
```

Append to `apps/web/src/styles/site.css`:

```css
/* ---- projects ---- */
.crumbs { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-2); color: var(--c-fg-subtle); }
.crumbs a { display: inline-flex; align-items: center; min-height: var(--control-height); color: var(--c-fg-muted); }
.project { display: grid; gap: var(--sp-6); max-width: 60rem; }
.project__head { display: grid; gap: var(--sp-4); justify-items: start; }
.project__title { font-size: var(--fs-6); }
.project__section { display: grid; gap: var(--sp-3); }
.project__section h2 { font-size: var(--fs-5); }
.project__list { display: grid; gap: var(--sp-2); max-width: 70ch; margin: 0; padding-left: var(--sp-5); }
.project__how { display: grid; gap: var(--sp-5); align-items: start; }
@media (min-width: 960px) { .project__how { grid-template-columns: minmax(0, 1fr) 22rem; } }
.facts { display: grid; margin: 0; max-width: 48rem; border-top: 1px solid var(--c-line); }
.facts__row { display: grid; grid-template-columns: 9rem minmax(0, 1fr); gap: var(--sp-3); padding: var(--sp-2) 0; border-bottom: 1px solid var(--c-line); }
.facts dt { font-size: var(--fs-2); color: var(--c-fg-subtle); }
.facts dd { margin: 0; }
.project__pager { display: flex; justify-content: space-between; flex-wrap: wrap; gap: var(--sp-3); padding-top: var(--sp-4); border-top: 1px solid var(--c-line); }
.probe { display: flex; align-items: center; min-height: var(--control-height); }
.diagram { display: grid; gap: var(--sp-2); width: 100%; max-width: 22rem; margin: 0; }
.diagram__svg { display: block; width: 100%; height: auto; font-family: var(--font-mono); }
.diagram__caption { font-size: var(--fs-1); color: var(--c-fg-subtle); }
.dg-box { fill: var(--c-bg-elev); stroke: var(--c-line-input); stroke-width: 1; }
.dg-title { fill: var(--c-fg); font-size: var(--fs-3); font-weight: 700; }
.dg-note { fill: var(--c-fg-muted); font-size: var(--fs-1); }
.dg-arrow { fill: none; stroke: var(--c-fg-subtle); stroke-width: 1.5; }
```

- [ ] **Step 7: Unit tests, worker tests, lint, build**

```bash
(cd apps/web && bunx vitest run --coverage)
bun run --filter @meowerse/meowsenger-worker test:node
bun run --filter @meowerse/web lint
bun run --filter @meowerse/web build
```

Expected:
- all green;
- the build prints `sitemap: 7 pages`;
- `dist/_headers` has `connect-src 'self' https://alxnko.dev https://auth.alxnko.dev https://meowsenger.alxnko.dev`.

- [ ] **Step 8: e2e for the pages and the probes**

`apps/web/tests/e2e/projects.spec.ts`:

```ts
import { test, expect } from "./fixtures";

const SLUGS = ["auth", "meowsenger", "ui", "moonmeow", "sunmeow", "alxnko-dev"];

test("six project pages: summary, what, how + diagram, facts, links, a resolved status", async ({ page }) => {
  for (const slug of SLUGS) {
    await page.goto(`/p/${slug}/`);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator(".lede")).not.toBeEmpty();
    await expect(page.locator(".diagram svg[role=img] > title")).toHaveCount(1);
    await expect(page.locator("#what-title + .project__list li").first()).toBeVisible();
    await expect(page.locator(".facts__row").first()).toBeVisible();
    await expect(page.locator(".project__head .mw-btn--primary")).toHaveCount(1);
    await expect(page.locator(".mw-status")).toHaveCount(1);
    await expect(page.locator(".mw-status__tag")).not.toHaveText("[wait]", { timeout: 8000 });
  }
});

test("the diagram keeps its contrast in both themes", async ({ page }) => {
  for (const theme of ["dark", "light"] as const) {
    await page.addInitScript((t) => localStorage.setItem("mw-theme", t), theme);
    await page.goto("/p/auth/");
    const c = await page.locator(".dg-box").first().evaluate((box) => {
      const title = box.parentElement!.querySelector(".dg-title")!;
      return { box: getComputedStyle(box).fill, stroke: getComputedStyle(box).stroke, text: getComputedStyle(title).fill, bg: getComputedStyle(document.body).backgroundColor };
    });
    expect(c.text, theme).not.toBe(c.box);
    expect(c.stroke, theme).not.toBe(c.bg);
  }
});

test("pages without a public service say so instead of pretending", async ({ page }) => {
  for (const slug of ["moonmeow", "sunmeow"]) {
    await page.goto(`/p/${slug}/`);
    await expect(page.locator(".mw-status__tag")).toHaveText("[info]");
    await expect(page.locator(".mw-status")).toContainText("there's no public service to check");
  }
});
```

`apps/web/tests/e2e/probes.spec.ts`:

```ts
import { test, expect, PROBED } from "./fixtures";

test.describe("live status (B9)", () => {
  test("up, with the answer time", async ({ page }) => {
    await page.goto("/p/auth/");
    await expect(page.locator(".mw-status__tag")).toHaveText("[ ok ]");
    await expect(page.locator(".mw-status")).toContainText(/auth — up · \d+ ms/);
  });
  test("an error answer is down, announced", async ({ page }) => {
    await page.route(PROBED, (r) => r.fulfill({ status: 503, body: "", headers: { "access-control-allow-origin": "*" } }));
    await page.goto("/p/auth/");
    await expect(page.locator(".mw-status")).toContainText("auth — down · answered 503");
    await expect(page.locator(".mw-status")).toHaveAttribute("role", "alert");
  });
  test("no answer is a visible wait, then unknown after 5 s, never down", async ({ page }) => {
    await page.route(PROBED, () => { /* never answer */ });
    await page.goto("/p/auth/");
    await expect(page.locator(".mw-status__tag")).toHaveText("[wait]");
    await expect(page.locator(".mw-status")).toContainText("auth — unknown · no answer in 5 s", { timeout: 9000 });
  });
  test("unreachable from this browser is unknown", async ({ page }) => {
    await page.route(PROBED, (r) => r.abort("failed"));
    await page.goto("/p/meowsenger/");
    await expect(page.locator(".mw-status")).toContainText("meowsenger — unknown · couldn't reach it from here");
  });
});
```

Run: `bun run --filter @meowerse/web build && bun run --filter @meowerse/web e2e`

Expected: all specs pass. The site-wide `csp`, `a11y` and `links` specs now also cover the six project
pages.

- [ ] **Step 9: Commit**

```bash
git add apps/web workers/meowsenger/src/index.ts workers/meowsenger/src/index.test.ts
git commit -m "feat(web): project pages with live status and diagrams; public /health on meowsenger

Six pages at /p/<slug> from a zod-validated content collection (B11, B13): summary, what it is,
how it works with an inline SVG diagram that reads in both themes, facts and links. A unit
test guards public facts (no network/Tailscale/IP/pairing details; no real name or employer on
the alxnko.dev page). Live status probes a CORS endpoint with a 5 s timeout: ok / down /
unknown, never a false 'down' (B9, W-05). meowsenger's /health now answers any origin without
credentials and is never cached, so it can be probed.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Home: hero with the Wordmark and Cat3D, `ls ~/services`, `ls ~/projects` (spec §5 web, B4, B12a, B16; W-04)

**Files:**
- Modify: `apps/web/src/pages/index.astro`, `apps/web/src/styles/site.css` (append "home")
- Create: `apps/web/tests/e2e/home.spec.ts`

**Interfaces:**
- Consumes:
  - `runProbes` and `ProjectStatus.astro` (Task 4);
  - `Cat3D` from `@meowerse/ui/cat3d` and `attachAllCat3D` from `@meowerse/ui/cat3d/attach`
    (Task 2);
  - `Wordmark`, `SITE`, `linkAttrs`.
- Produces: the home page. Selectors later tasks rely on: `.hero`, `.services [data-probe]`,
  `[data-probe-retry]`, `#projects .card-link`.

- [ ] **Step 1: Write the failing e2e test**

`apps/web/tests/e2e/home.spec.ts`:

```ts
import { test, expect, PROBED } from "./fixtures";

test("hero: the wordmark is the heading, one green action, the cat's poster paints first", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toContainText("meowerse");
  await expect(page.locator("h1 .mw-wordmark")).toBeVisible();
  await expect(page.locator("main .mw-btn--primary")).toHaveCount(1);
  await expect(page.locator(".hero .mw-cat3d img")).toBeVisible();
  await expect(page.locator(".hero .mw-cat3d")).toHaveAttribute("aria-hidden", "true");
});

test("ls ~/services: both live services resolve; check again is busy while it runs", async ({ page }) => {
  await page.goto("/");
  const rows = page.locator(".services [data-probe]");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(/auth — up/);
  await expect(rows.nth(1)).toContainText(/meowsenger — up/);
  const again = page.locator("[data-probe-retry]");
  await expect(again).toBeEnabled();
  await expect(again).toHaveText("check again");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(PROBED, async (route) => {
    await gate;
    await route.fulfill({ status: 200, body: "{}", headers: { "access-control-allow-origin": "*" } });
  });
  await again.click();
  await expect(again).toBeDisabled();
  await expect(again).toHaveText("checking…");
  await expect(rows.nth(0).locator(".mw-status__tag")).toHaveText("[wait]");
  release();
  await expect(again).toBeEnabled();
  await expect(rows.nth(0)).toContainText(/auth — up/);
});

test("ls ~/projects: six cards, each to its page", async ({ page }) => {
  await page.goto("/");
  const cards = page.locator("#projects .card-link");
  await expect(cards).toHaveCount(6);
  await expect(cards.first()).toHaveAttribute("href", "/p/auth/");
  await expect(cards.last()).toHaveAttribute("href", "/p/alxnko-dev/");
});

test("Cat3D: poster only under reduced motion; otherwise the renderer loads lazily", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "one pass is enough");
  const stub = { status: 200, body: "{}", headers: { "access-control-allow-origin": "*" } };

  const reduced = await browser.newContext({ reducedMotion: "reduce", colorScheme: "dark" });
  await reduced.route(PROBED, (r) => r.fulfill(stub));
  const rp = await reduced.newPage();
  const rUrls: string[] = [];
  rp.on("request", (r) => rUrls.push(r.url()));
  await rp.goto("http://127.0.0.1:4371/");
  await rp.waitForTimeout(1500);
  expect(rUrls.some((u) => /\/_astro\/(renderer\.[^/]+\.js|cat\.[^/]+\.bin)$/.test(u))).toBe(false);
  await expect(rp.locator(".mw-cat3d canvas")).toBeHidden();
  await reduced.close();

  const normal = await browser.newContext({ reducedMotion: "no-preference", colorScheme: "dark" });
  await normal.route(PROBED, (r) => r.fulfill(stub));
  const np = await normal.newPage();
  const nUrls: string[] = [];
  np.on("request", (r) => nUrls.push(r.url()));
  await np.goto("http://127.0.0.1:4371/");
  await expect.poll(() => nUrls.some((u) => /\/_astro\/cat\.[^/]+\.bin$/.test(u)), { timeout: 10_000 }).toBe(true);
  await expect(np.locator(".mw-cat3d")).toHaveClass(/mw-cat3d--live/, { timeout: 10_000 });
  await normal.close();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun run --filter @meowerse/web build && cd apps/web && bunx playwright test tests/e2e/home.spec.ts`

Expected: FAIL. The home page has no wordmark, services, cards or cat yet.

- [ ] **Step 3: The page**

Replace `apps/web/src/pages/index.astro`:

```astro
---
import { getCollection } from "astro:content";
import { Wordmark } from "@meowerse/ui";
import { Cat3D } from "@meowerse/ui/cat3d";
import BaseLayout from "../layouts/BaseLayout.astro";
import ProjectStatus from "../components/ProjectStatus.astro";
import { isExternal, linkAttrs, SITE } from "../lib/site";

const projects = (await getCollection("projects")).sort((a, b) => a.data.order - b.data.order);
const services = projects.filter((p) => p.data.service);
const meowsenger = "https://meowsenger.alxnko.dev/";
const jsonLd = { "@context": "https://schema.org", "@type": "WebSite", name: SITE.name, url: SITE.url, description: SITE.description };
---
<BaseLayout title={SITE.name} description={SITE.description} jsonLd={jsonLd}>
  <section class="hero" aria-labelledby="hero-title">
    <div class="hero__text">
      <h1 id="hero-title" class="hero__title"><span class="sr-only">meowerse</span><span aria-hidden="true"><Wordmark name="meowerse" /></span></h1>
      <p class="lede">{SITE.description}</p>
      <div class="btn-row">
        <a class="mw-btn mw-btn--primary mw-btn--md" href={meowsenger} {...linkAttrs(meowsenger)}>open meowsenger<span class="ext-mark" aria-hidden="true"> ↗</span><span class="sr-only"> (opens in a new tab)</span></a>
        <a class="mw-btn mw-btn--secondary mw-btn--md" href="/ui/">read the ui docs</a>
      </div>
    </div>
    <div class="hero__cat"><Cat3D size={220} /></div>
  </section>

  <section class="block" aria-labelledby="services-title">
    <h2 id="services-title" class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› ls ~/</span>services</h2>
    <ul class="services">
      {services.map((p) => {
        const open = p.data.links[0]!.href;
        return (
          <li>
            <ProjectStatus name={p.data.name} status={p.data.status} />
            <span class="row-links">
              <a href={`/p/${p.id}/`}>about<span class="sr-only"> {p.data.name}</span></a>
              <a href={open} {...linkAttrs(open)}>open<span class="sr-only"> {p.data.name}</span>{isExternal(open) && <><span class="ext-mark" aria-hidden="true"> ↗</span><span class="sr-only"> (opens in a new tab)</span></>}</a>
            </span>
          </li>
        );
      })}
    </ul>
    <p><button type="button" class="mw-btn mw-btn--secondary mw-btn--md" data-probe-retry hidden>check again</button></p>
  </section>

  <section id="projects" class="block" aria-labelledby="projects-title">
    <h2 id="projects-title" class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› ls ~/</span>projects</h2>
    <ul class="cards">
      {projects.map((p) => (
        <li><a class="card-link" href={`/p/${p.id}/`}><span class="card-link__name">{p.data.name}</span><span class="card-link__sum">{p.data.summary}</span></a></li>
      ))}
    </ul>
  </section>

  <script>
    import { attachAllCat3D } from "@meowerse/ui/cat3d/attach";
    import { runProbes } from "../lib/probe-runner";
    void runProbes(document, { watch: true });
    // decorative and lazy (spec §4): only after the page is idle, never competing with first paint
    if ("requestIdleCallback" in window) requestIdleCallback(() => attachAllCat3D());
    else setTimeout(() => attachAllCat3D(), 200);
  </script>
</BaseLayout>
```

Append to `apps/web/src/styles/site.css`:

```css
/* ---- home ---- */
.hero { display: grid; gap: var(--sp-5); align-items: center; padding-block: var(--sp-5) var(--sp-7); }
@media (min-width: 760px) { .hero { grid-template-columns: minmax(0, 1fr) auto; } }
.hero__text { display: grid; gap: var(--sp-4); justify-items: start; }
.hero__title { margin: 0; line-height: 1; }
.hero__title .mw-wordmark { font-size: var(--fs-7); }
.hero__cat { justify-self: center; }
.block { display: grid; gap: var(--sp-4); padding-block: var(--sp-6); border-top: 1px solid var(--c-line); }
.services { display: grid; margin: 0; padding: 0; list-style: none; }
.services li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-3); padding-block: var(--sp-1); border-bottom: 1px solid var(--c-line); }
.services .probe { flex: 1 1 18rem; }
.row-links { display: flex; gap: var(--sp-1); }
.row-links a { display: inline-flex; align-items: center; justify-content: center; min-height: var(--control-height); min-width: var(--control-height); padding: 0 var(--sp-2); border-radius: var(--r-m); color: var(--c-fg-muted); font-size: var(--fs-2); }
.row-links a:hover { color: var(--c-fg); background: var(--c-surface); text-decoration: none; }
.cards { display: grid; gap: var(--sp-3); grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr)); margin: 0; padding: 0; list-style: none; }
.card-link { display: grid; gap: var(--sp-2); height: 100%; padding: var(--sp-4); background: var(--c-bg-elev); border: 1px solid var(--c-line); border-radius: var(--r-l); color: var(--c-fg); transition: border-color var(--d-fast) var(--ease); }
.card-link:hover { border-color: var(--c-line-input); text-decoration: none; }
.card-link__name { font-weight: 700; }
.card-link__sum { font-size: var(--fs-2); color: var(--c-fg-muted); }
```

- [ ] **Step 4: Run everything**

```bash
bun run --filter @meowerse/web lint
bun run --filter @meowerse/web build
bun run --filter @meowerse/web e2e
```

Expected: all green. The home page has no `astro-island`:
`rg -c 'astro-island' apps/web/dist/index.html || echo 0` prints `0`. Its only scripts are the
inline theme init and one module.

- [ ] **Step 5: Look at it**

Serve the build locally and look at the page at phone width and desktop width, in dark and light:

```bash
(cd apps/web && bun scripts/serve-dist.ts 4371) &
```

Open `http://127.0.0.1:4371/`, then stop the server.

Check:
- the wordmark cursor blinks, and is static under reduced motion;
- the cat eases toward the cursor, and toward a finger in touch emulation;
- the probes resolve against the real services;
- there is no horizontal overflow at 390 px.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): home with the wordmark, Cat3D, live services and the project list

meow.alxnko.dev now says what meowerse is (W-04): wordmark heading, one primary action, the
cat attached lazily after idle with its poster painted first (B4), ls ~/services with live
status and a check-again that is busy with its reason while it runs (B9), and the six projects.
No React ships on this page.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 6: The docs data layer: props, CSS variables and snippets from the source (spec §5.2 "generated … so they can't drift", B12)

**Files:**
- Create:
  - `apps/web/src/lib/ui-api.ts` (+`.test.ts`);
  - `apps/web/src/lib/css-api.ts` (+`.test.ts`);
  - `apps/web/src/lib/jsx.ts` (+`.test.tsx`);
  - `apps/web/src/lib/slug.ts` (+`.test.ts`);
  - `apps/web/src/ui-docs/api.ts`.

**Interfaces:**
- Consumes: the `@meowerse/ui` source at `packages/ui` (Tasks 1–2), read from disk at build time.
- Produces:
  - Types:
    - `PropDoc = { name; type; values?: string[]; required: boolean; default?: string; description?: string; inherited?: boolean }`;
    - `ComponentDoc = { name; file; description?; props: PropDoc[]; inherits: string[] }`;
    - `FunctionDoc = { name; file; signature; description? }`;
    - `ValueDoc = { name; file; type; description? }`;
    - `UiApi = { components; functions; values; types: string[] }`.
  - `uiDirFrom(cwd: string): string` and `extractUiApi(uiDir: string, entries?: string[]): UiApi`.
  - `CssVar = { name; dark?; light?; alias? }` and `CssApi = { classes: string[]; vars: CssVar[]; declared: string[] }`.
  - CSS helpers: `rootClasses(source)`, `tokenValues(tokensGenCss)`,
    `cssApiFor(source, componentsCss, tokensGenCss, aliasesCss): CssApi`.
  - `toJsx(node: ReactNode, indent?: string): string`.
  - `toSlug(name: string): string` ("ConfirmDialog" → "confirm-dialog", "Cat3D" → "cat3d").
  - `src/ui-docs/api.ts`: `UI_DIR`, `uiApi()` (memoised, one TypeScript program per build),
    `componentDoc(name)`, `cssApi(name)`.

The extractor uses the TypeScript compiler API (see Architecture). It reads the two public entries,
`src/index.ts` and `src/cat3d/index.ts`. For every value export:
- **A component** is an export whose name starts with a capital letter and has a call signature. The
  first parameter's type gives its props.
  - Props declared under `packages/ui/src` are listed with their type as written, their
    string-literal values, whether they are required, and their JSDoc.
  - Props declared in `@types/react` are summarised as the interfaces they come from
    (`inherits`), except inherited props the component gives a default, like `Field`'s
    `type = "text"`.
  - Defaults come from the destructuring pattern of the component's first parameter, including
    inside `forwardRef(function X({ … }) {})`.
- **A function** has a call signature and a lowercase name.
- **A value** is anything else.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/ui-api.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractUiApi, uiDirFrom } from "./ui-api";

const api = extractUiApi(uiDirFrom(process.cwd()));
const comp = (n: string) => api.components.find((c) => c.name === n)!;
const prop = (c: string, p: string) => comp(c).props.find((x) => x.name === p)!;

describe("extractUiApi (TypeScript compiler API over @meowerse/ui)", () => {
  it("finds every exported component, the cat included", () =>
    expect(api.components.map((c) => c.name)).toEqual([
      "Alert", "AppHeader", "AuthGate", "Avatar", "Badge", "Button", "Card", "Cat3D", "Checkbox", "Code",
      "ConfirmDialog", "ContactLinks", "Cursor", "Field", "Footer", "Icon", "Kbd", "Modal", "Prompt",
      "RadioGroup", "RecoveryCodes", "Spinner", "StatusLine", "ThemeToggle", "ToastProvider", "Wordmark",
    ]));
  it("reads a forwardRef component's own props, values and destructuring defaults", () => {
    expect(prop("Button", "variant")).toMatchObject({ type: '"primary" | "secondary" | "ghost" | "danger"', required: false, default: '"secondary"' });
    expect([...prop("Button", "variant").values!].sort()).toEqual(["danger", "ghost", "primary", "secondary"]);
    expect(prop("Button", "size")).toMatchObject({ default: '"md"', required: false });
    expect(prop("Button", "loading")).toMatchObject({ type: "boolean", default: "false" });
    expect(prop("Button", "loading").values).toBeUndefined();
    expect(comp("Button").inherits).toEqual(expect.arrayContaining(["ButtonHTMLAttributes", "RefAttributes"]));
  });
  it("reads a function component's props, required-ness and alias values", () => {
    expect(prop("Alert", "children")).toMatchObject({ type: "ReactNode", required: true });
    expect(prop("Alert", "variant").default).toBe('"info"');
    expect(prop("Alert", "onDismiss")).toMatchObject({ type: "() => void", required: false });
    expect(prop("StatusLine", "state")).toMatchObject({ type: "StatusState", required: true });
    expect([...prop("StatusLine", "state").values!].sort()).toEqual(["fail", "info", "ok", "wait"]);
    expect(prop("Cat3D", "size").default).toBe("160");
  });
  it("keeps an inherited prop the component gives a default", () =>
    expect(prop("Field", "type")).toMatchObject({ default: '"text"', inherited: true }));
  it("lists functions with signatures and constants with types", () => {
    const fns = api.functions.map((f) => f.name);
    for (const n of ["request", "useSession", "toggleTheme", "cx", "contrast", "attachCat3D", "useToast"]) expect(fns).toContain(n);
    expect(api.functions.find((f) => f.name === "cx")!.signature).toMatch(/^\(\.\.\.parts: /);
    expect(api.values.map((v) => v.name)).toEqual(expect.arrayContaining(["THEME_INIT_SCRIPT", "DEFAULT_TIMEOUT_MS", "ICON_NAMES", "CONTRAST_PAIRS"]));
    expect(api.types).toEqual(expect.arrayContaining(["ButtonProps", "Session", "StatusState"]));
  });
  it("records where each export lives", () => expect(comp("Prompt").file).toBe("src/components/Prompt.tsx"));
  it("fails loudly when the source isn't there", () => {
    expect(() => uiDirFrom("/nonexistent")).toThrow(/@meowerse\/ui source not found/);
    expect(() => extractUiApi(uiDirFrom(process.cwd()), ["src/nope.ts"])).toThrow(/can't read src\/nope.ts/);
  });
});
```

`apps/web/src/lib/css-api.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssApiFor, rootClasses, tokenValues } from "./css-api";
import { uiDirFrom } from "./ui-api";

const ui = uiDirFrom(process.cwd());
const read = (f: string) => readFileSync(join(ui, f), "utf8");
const css = ["components.css", "tokens.gen.css", "aliases.css"].map((f) => read(`src/styles/${f}`)) as [string, string, string];
const forFile = (f: string) => cssApiFor(read(f), ...css);

describe("css-api", () => {
  it("finds the root BEM blocks a component's source uses", () =>
    expect(rootClasses('cx("mw-btn", `mw-btn--${v}`, "mw-btn__x", "mw-brand-meow")')).toEqual(["mw-brand-meow", "mw-btn"]));
  it("reads the dark and light token values from the generated CSS", () => {
    const { dark, light } = tokenValues(css[1]);
    expect(dark.get("--c-fg")).toBe("#ededeb");
    expect(light.get("--c-fg")).toBe("#1a1a1c");
    expect(dark.get("--control-height")).toBe("44px");
  });
  it("lists the custom properties a component's rules use, with values per theme", () => {
    const btn = forFile("src/components/Button.tsx");
    expect(btn.classes).toEqual(["mw-btn"]);
    const names = btn.vars.map((v) => v.name);
    for (const n of ["--control-height", "--c-accent-fill", "--r-m", "--disabled-opacity"]) expect(names).toContain(n);
    expect(btn.vars.find((v) => v.name === "--c-accent-fill")).toMatchObject({ dark: "#00ff82" });
    expect(btn.vars.find((v) => v.name === "--control-height")!.light).toBeUndefined(); // same in both themes
    expect(forFile("src/components/StatusLine.tsx").vars.find((v) => v.name === "--c-ok")).toEqual({ name: "--c-ok", dark: "#3ddc84", light: "#11652f" });
  });
  it("shows legacy aliases for what the tokens don't define", () =>
    expect(forFile("src/components/Modal.tsx").vars.find((v) => v.name === "--shadow-lg")!.alias).toMatch(/^0 16px 40px/));
  it("ignores rules inside @media preludes and comments cleanly", () => {
    const api = cssApiFor('"mw-x"', "/* c */\n.mw-x { color: var(--c-fg); --own: 1; }\n@media (x) {\n  .mw-x:hover { color: var(--c-accent); }\n}\n.mw-xy { color: var(--nope); }", css[1], css[2]);
    expect(api.vars.map((v) => v.name)).toEqual(["--c-accent", "--c-fg"]);
    expect(api.declared).toEqual(["--own"]);
  });
});
```

`apps/web/src/lib/jsx.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { Alert, Button, Card, Kbd, Spinner, StatusLine, AppHeader } from "@meowerse/ui";
import { toJsx } from "./jsx";

describe("toJsx: snippets serialised from the same elements the previews render", () => {
  it("string props and text children on one line; forwardRef names resolve", () =>
    expect(toJsx(<Button variant="primary">save</Button>)).toBe('<Button variant="primary">save</Button>'));
  it("self-closes, writes true as a bare attribute and false/numbers in braces", () => {
    expect(toJsx(<Spinner size="lg" />)).toBe('<Spinner size="lg" />');
    expect(toJsx(<Button loading disabled={false}>go</Button>)).toBe("<Button loading disabled={false}>go</Button>");
  });
  it("names handlers instead of printing function bodies", () =>
    expect(toJsx(<Alert variant="error" onDismiss={() => {}}>no</Alert>)).toBe('<Alert variant="error" onDismiss={handleDismiss}>no</Alert>'));
  it("indents element children, keeps meaningful spaces, and writes fragments", () => {
    expect(toJsx(<Card title="profile"><p>hi</p></Card>)).toBe('<Card title="profile">\n  <p>hi</p>\n</Card>');
    expect(toJsx(<><Kbd>Shift</Kbd> + <Kbd>Enter</Kbd></>)).toBe('<>\n  <Kbd>Shift</Kbd>\n  {" + "}\n  <Kbd>Enter</Kbd>\n</>');
  });
  it("serialises object props as literals and element props inline", () => {
    expect(toJsx(<AppHeader session={{ loading: true, authenticated: false }} />))
      .toBe('<AppHeader session={{"loading":true,"authenticated":false}} />');
    expect(toJsx(<StatusLine state="fail" action={<Button>retry</Button>}>x</StatusLine>))
      .toBe('<StatusLine state="fail" action={<Button>retry</Button>}>x</StatusLine>');
  });
  it("braces text that JSX can't hold literally, and quotes that attributes can't", () => {
    expect(toJsx(<p>{"a {b}"}</p>)).toBe('<p>{"a {b}"}</p>');
    expect(toJsx(<Button title={'say "hi"'}>x</Button>)).toBe('<Button title={"say \\"hi\\""}>x</Button>');
  });
});
```

`apps/web/src/lib/slug.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toSlug } from "./slug";

describe("toSlug", () => {
  it.each([["Button", "button"], ["ConfirmDialog", "confirm-dialog"], ["AppHeader", "app-header"], ["Cat3D", "cat3d"], ["ToastProvider", "toast-provider"]])(
    "%s → %s", (name, slug) => expect(toSlug(name)).toBe(slug));
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/web && bunx vitest run src/lib/ui-api.test.ts src/lib/css-api.test.ts src/lib/jsx.test.tsx src/lib/slug.test.ts`

Expected: FAIL (modules not found).

- [ ] **Step 3: `src/lib/ui-api.ts`**

```ts
// The public API of @meowerse/ui, read at build time with the TypeScript compiler API, so the docs'
// props tables can't drift from the source (spec §5.2). A pure function of the source files.
import ts from "typescript";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

export type PropDoc = {
  name: string; type: string; values?: string[]; required: boolean; default?: string; description?: string; inherited?: boolean;
};
export type ComponentDoc = { name: string; file: string; description?: string; props: PropDoc[]; inherits: string[] };
export type FunctionDoc = { name: string; file: string; signature: string; description?: string };
export type ValueDoc = { name: string; file: string; type: string; description?: string };
export type UiApi = { components: ComponentDoc[]; functions: FunctionDoc[]; values: ValueDoc[]; types: string[] };

const FMT = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

/** packages/ui, found from the web app's directory (the build and the tests run in apps/web). */
export function uiDirFrom(cwd: string): string {
  const dir = join(cwd, "../../packages/ui");
  if (!existsSync(join(dir, "src/index.ts"))) throw new Error(`@meowerse/ui source not found at ${dir}`);
  return dir;
}

/** The function whose first parameter carries the props: a declaration, or forwardRef(function X(…) {}). */
function fnOf(decl: ts.Node): ts.SignatureDeclaration | undefined {
  if (ts.isFunctionDeclaration(decl)) return decl;
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = decl.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
    if (ts.isCallExpression(init)) {
      const a = init.arguments[0];
      if (a && (ts.isFunctionExpression(a) || ts.isArrowFunction(a))) return a;
    }
  }
  return undefined;
}

function defaultsOf(decl: ts.Node): Record<string, string> {
  const out: Record<string, string> = {};
  const p = fnOf(decl)?.parameters[0]?.name;
  if (p && ts.isObjectBindingPattern(p))
    for (const el of p.elements) if (el.initializer) out[(el.propertyName ?? el.name).getText()] = el.initializer.getText();
  return out;
}

export function extractUiApi(uiDir: string, entries = ["src/index.ts", "src/cat3d/index.ts"]): UiApi {
  const roots = [...entries.map((e) => join(uiDir, e)), join(uiDir, "src/assets.d.ts")];
  const program = ts.createProgram(roots, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX, strict: true, skipLibCheck: true, noEmit: true, resolveJsonModule: true, types: [],
  });
  const checker = program.getTypeChecker();
  const src = join(uiDir, "src");
  const own = (d: ts.Node) => { const f = d.getSourceFile().fileName; return f.startsWith(src) && !f.includes("/node_modules/"); };
  const doc = (s: ts.Symbol) => ts.displayPartsToString(s.getDocumentationComment(checker)).trim() || undefined;
  const out: UiApi = { components: [], functions: [], values: [], types: [] };
  const seen = new Set<string>();

  for (const entry of entries) {
    const sf = program.getSourceFile(join(uiDir, entry));
    if (!sf) throw new Error(`can't read ${entry}`);
    const mod = checker.getSymbolAtLocation(sf);
    if (!mod) throw new Error(`${entry} has no exports`);
    for (const exp of checker.getExportsOfModule(mod)) {
      const name = exp.getName();
      if (seen.has(name)) continue;
      seen.add(name);
      const sym = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
      if (!(sym.flags & ts.SymbolFlags.Value)) { out.types.push(name); continue; }
      const decl = sym.valueDeclaration ?? sym.declarations?.[0];
      if (!decl) continue;
      const file = relative(uiDir, decl.getSourceFile().fileName);
      const type = checker.getTypeOfSymbolAtLocation(sym, decl);
      const call = type.getCallSignatures()[0];
      if (!call) { out.values.push({ name, file, type: checker.typeToString(type, undefined, FMT), description: doc(sym) }); continue; }
      if (!/^[A-Z]/.test(name)) {
        out.functions.push({ name, file, signature: checker.signatureToString(call, undefined, FMT), description: doc(sym) });
        continue;
      }
      const param = call.getParameters()[0];
      const propsType = param ? checker.getTypeOfSymbol(param) : undefined;
      const defaults = defaultsOf(decl);
      const props: PropDoc[] = [];
      const inherits = new Set<string>();
      for (const p of propsType ? checker.getPropertiesOfType(propsType) : []) {
        const pd = p.declarations?.[0];
        if (!pd) continue;
        const pname = p.getName();
        const t = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(p, pd));
        const values = t.isUnion() && t.types.every((u) => u.isStringLiteral())
          ? t.types.map((u) => (u as ts.StringLiteralType).value) : undefined;
        const required = !(p.flags & ts.SymbolFlags.Optional);
        if (!own(pd)) {
          if (ts.isInterfaceDeclaration(pd.parent)) inherits.add(pd.parent.name.text);
          if (defaults[pname] !== undefined)
            props.push({ name: pname, type: checker.typeToString(t, undefined, FMT), values, required, default: defaults[pname], inherited: true });
          continue;
        }
        const typeNode = ts.isPropertySignature(pd) ? pd.type : undefined;
        props.push({
          name: pname, type: typeNode ? typeNode.getText() : checker.typeToString(t, undefined, FMT), values, required,
          default: defaults[pname], description: doc(p),
        });
      }
      out.components.push({ name, file, description: doc(sym), props, inherits: [...inherits].sort() });
    }
  }
  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
  out.components.sort(byName);
  out.functions.sort(byName);
  out.values.sort(byName);
  out.types.sort();
  return out;
}
```

- [ ] **Step 4: `src/lib/css-api.ts`, `src/lib/jsx.ts`, `src/lib/slug.ts`, `src/ui-docs/api.ts`**

`apps/web/src/lib/css-api.ts`:

```ts
// The CSS custom properties a component's rules use, with their dark/light values from the generated
// tokens, read at build time from packages/ui/src/styles so the table can't drift (spec §5.2).
export type CssVar = { name: string; dark?: string; light?: string; alias?: string };
export type CssApi = { classes: string[]; vars: CssVar[]; declared: string[] };

/** Root BEM blocks a component's source uses: "mw-btn--primary", "mw-btn__x", `mw-btn--${v}` → "mw-btn". */
export function rootClasses(source: string): string[] {
  return [...new Set([...source.matchAll(/\bmw-[a-z0-9]+(?:-[a-z0-9]+)*/g)].map((m) => m[0]))].sort();
}

/** `--name: value;` pairs of the first top-level block with exactly this selector. */
function block(css: string, selector: string): Map<string, string> {
  const out = new Map<string, string>();
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return out;
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

export function tokenValues(tokensGenCss: string): { dark: Map<string, string>; light: Map<string, string> } {
  return { dark: block(tokensGenCss, ":root"), light: block(tokensGenCss, ':root[data-theme="light"]') };
}

/** Innermost `selector { body }` rules; comments dropped, @media preludes never glued to a selector. */
function rules(css: string): { selector: string; body: string }[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
}

export function cssApiFor(source: string, componentsCss: string, tokensGenCss: string, aliasesCss: string): CssApi {
  const classes = rootClasses(source);
  const matchers = classes.map((c) => new RegExp(`\\.${c}(?![a-z0-9])`));
  const used = new Set<string>(), declared = new Set<string>();
  for (const r of rules(componentsCss)) {
    if (!matchers.some((re) => re.test(r.selector))) continue;
    for (const m of r.body.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) used.add(m[1]!);
    for (const m of r.body.matchAll(/(?:^|[;\s])(--[a-z0-9-]+)\s*:/g)) declared.add(m[1]!);
  }
  const { dark, light } = tokenValues(tokensGenCss);
  const aliases = block(aliasesCss, ":root");
  const vars = [...used].sort().map((name): CssVar => {
    const v: CssVar = { name };
    if (dark.has(name)) v.dark = dark.get(name);
    if (light.has(name) && light.get(name) !== dark.get(name)) v.light = light.get(name);
    if (aliases.has(name)) v.alias = aliases.get(name);
    return v;
  });
  return { classes, vars, declared: [...declared].sort() };
}
```

`apps/web/src/lib/jsx.ts`:

```ts
// Usage snippets serialised from the very React elements the docs previews render, so a snippet can't
// disagree with what's on screen (spec §5.2).
import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";

type Part = string | number | ReactElement;

const nameOf = (type: unknown): string => {
  if (typeof type === "string") return type;
  if (type === Fragment) return "";
  const t = type as { displayName?: string; name?: string; render?: { displayName?: string; name?: string } };
  return t.displayName ?? t.render?.displayName ?? t.render?.name ?? t.name ?? "Component";
};

const flat = (c: ReactNode): Part[] =>
  Array.isArray(c) ? c.flatMap(flat)
    : isValidElement(c) ? [c]
      : typeof c === "string" || typeof c === "number" ? [c]
        : [];

const text = (s: string) => (/[{}<>]/.test(s) ? `{${JSON.stringify(s)}}` : s);
const handler = (prop: string) => (/^on[A-Z]/.test(prop) ? `handle${prop.slice(2)}` : prop);

function attr(k: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (v === true) return k;
  if (typeof v === "string") return /["\n]/.test(v) ? `${k}={${JSON.stringify(v)}}` : `${k}="${v}"`;
  if (typeof v === "number" || typeof v === "boolean") return `${k}={${v}}`;
  if (typeof v === "function") return `${k}={${handler(k)}}`;
  if (isValidElement(v)) return `${k}={${toJsx(v).replace(/\n\s*/g, "")}}`;
  return `${k}={${JSON.stringify(v)}}`;
}

export function toJsx(node: ReactNode, indent = ""): string {
  if (!isValidElement(node)) return typeof node === "string" ? text(node) : String(node ?? "");
  const el = node as ReactElement<Record<string, unknown>>;
  const name = nameOf(el.type);
  const { children, ...props } = el.props;
  const attrs = Object.entries(props).map(([k, v]) => attr(k, v)).filter((a): a is string => a !== null).join(" ");
  const open = attrs ? `${name} ${attrs}` : name;
  const parts = flat(children as ReactNode);
  if (!parts.length) return name ? `<${open} />` : "<></>";
  if (parts.every((p) => !isValidElement(p))) return `<${open}>${parts.map((p) => text(String(p))).join("")}</${name}>`;
  const pad = `${indent}  `;
  const lines = parts.map((p) => {
    if (isValidElement(p)) return pad + toJsx(p, pad);
    const s = String(p);
    return pad + (s !== s.trim() ? `{${JSON.stringify(s)}}` : text(s));
  });
  return `<${open}>\n${lines.join("\n")}\n${indent}</${name}>`;
}
```

`apps/web/src/lib/slug.ts`:

```ts
/** Component name → URL slug: "ConfirmDialog" → "confirm-dialog"; "Cat3D" → "cat3d" (no dash before a capital after a digit). */
export const toSlug = (name: string): string => name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
```

`apps/web/src/ui-docs/api.ts`:

```ts
// Build-time docs data for the /ui pages. One TypeScript program per build (memoised).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cssApiFor, type CssApi } from "../lib/css-api";
import { extractUiApi, uiDirFrom, type ComponentDoc, type UiApi } from "../lib/ui-api";

export const UI_DIR = uiDirFrom(process.cwd());
let cached: UiApi | undefined;

export function uiApi(): UiApi {
  return (cached ??= extractUiApi(UI_DIR));
}

export function componentDoc(name: string): ComponentDoc {
  const d = uiApi().components.find((c) => c.name === name);
  if (!d) throw new Error(`@meowerse/ui exports no component named ${name}`);
  return d;
}

const style = (f: string) => readFileSync(join(UI_DIR, "src/styles", f), "utf8");

export function cssApi(name: string): CssApi {
  const source = readFileSync(join(UI_DIR, componentDoc(name).file), "utf8");
  return cssApiFor(source, style("components.css"), style("tokens.gen.css"), style("aliases.css"));
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd apps/web && bunx vitest run --coverage`

Expected: all pass, with `src/lib/**` coverage ≥ 90.
- If `prop("Button","variant").type` comes back with different whitespace, the type node's
  `getText()` is authoritative. Fix the expectation to the source text, never the code.
- The extractor takes about 1–3 s once (one TypeScript program).

- [ ] **Step 6: Type-check and commit**

```bash
bun run --filter @meowerse/web lint
git add apps/web/src/lib apps/web/src/ui-docs
git commit -m "feat(web): generate the ui docs data from the source (TypeScript compiler API)

extractUiApi() reads @meowerse/ui's public entries with the compiler API: component props as
written, string-literal values, destructuring defaults (forwardRef included), required-ness,
JSDoc, and the DOM attribute interfaces a component inherits; functions and constants too.
cssApiFor() lists the custom properties each component's rules use with dark/light values from
tokens.gen.css. toJsx() serialises snippets from the rendered elements. Nothing is hand-copied,
so the docs can't drift (spec §5.2).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The `/ui` shell, the foundations pages and the utilities page (spec §5.2 "Foundations"; §2)

**Files:**
- Create:
  - `apps/web/src/layouts/DocsLayout.astro`;
  - `apps/web/src/components/docs/CodeBlock.astro`, `apps/web/src/components/docs/Swatch.astro`;
  - `apps/web/src/lib/docs-nav.ts` (+`.test.ts`);
  - `apps/web/src/lib/copy-buttons.ts` (+`.test.ts`);
  - `apps/web/src/lib/motion-demo.ts` (+`.test.ts`);
  - `apps/web/src/pages/ui/index.astro`, `apps/web/src/pages/ui/utilities.astro`;
  - `apps/web/src/pages/ui/foundations/{colours,type,space,motion,voice}.astro`;
  - `apps/web/tests/e2e/ui-foundations.spec.ts`.
- Modify: `apps/web/src/styles/site.css` (append "docs")

**Interfaces:**
- Consumes: `uiApi()` (Task 6); `tokens.json`, `CONTRAST_PAIRS`, `contrast`, `Wordmark`, `Cursor`,
  `Button`, `Field`, `Prompt`, `StatusLine` from `@meowerse/ui`.
- Produces:
  - `DocsLayout.astro`. Props: `{ title: string; description: string }`. It has a default slot and
    renders the docs nav from `docsNav()`.
  - `docsNav(componentNames: string[]): NavGroup[]`, with
    `NavGroup = { label: string; items: { label: string; href: string }[] }`.
    - It is extended by later tasks: components in Task 8, gallery in Task 9, playground in Task 10,
      patterns and cat3d in Task 11.
    - The `/ui/` index lists whatever `docsNav` returns, so it never links to a page that doesn't
      exist yet.
  - `CodeBlock.astro`. Props: `{ id: string; code: string; lang: string }`. It has a copy button with
    a live-region result.
  - `bindCopyButtons(doc?, clipboard?)`.
  - `bindMotionDemos(doc?)`.
  - `Swatch.astro`. Props: `{ value: string }`.
  - CSS utilities `.fs-1`…`.fs-7`, `.sp-bar.sp-1`…`.sp-8`, `.r-box.r-s|r-m|r-l`, `.table`,
    `.table-wrap`, `.docs-section`, `.docs-head`, `.demo-row`.

- [ ] **Step 1: Write the failing unit tests**

`apps/web/src/lib/docs-nav.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { docsNav } from "./docs-nav";

describe("docsNav", () => {
  it("starts with the overview and the foundations, and every link is a /ui/ path with a trailing slash", () => {
    const groups = docsNav(["Button", "Alert"]);
    expect(groups[0]).toEqual({ label: "start", items: [{ label: "overview", href: "/ui/" }] });
    expect(groups.find((g) => g.label === "foundations")!.items.map((i) => i.label)).toEqual(["colours", "type", "space, radii, layers", "motion", "voice"]);
    for (const g of groups) for (const i of g.items) expect(i.href).toMatch(/^\/ui\/([a-z0-9-]+\/)*$/);
  });
  it("ends with utilities", () => expect(docsNav([]).at(-1)!.items.at(-1)).toEqual({ label: "utilities", href: "/ui/utilities/" }));
});
```

`apps/web/src/lib/copy-buttons.test.ts`:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindCopyButtons } from "./copy-buttons";

function block() {
  document.body.replaceChildren();
  const pre = document.createElement("pre");
  pre.id = "c1";
  pre.textContent = 'import { Button } from "@meowerse/ui";';
  const btn = document.createElement("button");
  btn.dataset.copy = "c1";
  btn.textContent = "copy";
  const status = document.createElement("p");
  status.dataset.copyStatus = "c1";
  document.body.append(pre, btn, status);
  return { btn, status };
}

describe("copy buttons (B9: no silent failure)", () => {
  beforeEach(() => vi.useRealTimers());
  it("copies the block's text and says so, then resets", async () => {
    vi.useFakeTimers();
    const { btn, status } = block();
    const clip = { writeText: vi.fn(async () => {}) };
    bindCopyButtons(document, clip);
    btn.click();
    await vi.waitFor(() => expect(btn.textContent).toBe("copied"));
    expect(clip.writeText).toHaveBeenCalledWith('import { Button } from "@meowerse/ui";');
    expect(status.textContent).toBe("copied to the clipboard");
    vi.advanceTimersByTime(2000);
    expect(btn.textContent).toBe("copy");
  });
  it("says how to copy by hand when the clipboard refuses or is missing", async () => {
    const { btn, status } = block();
    bindCopyButtons(document, { writeText: vi.fn(async () => { throw new Error("denied"); }) });
    btn.click();
    await vi.waitFor(() => expect(btn.textContent).toBe("copy failed"));
    expect(status.textContent).toBe("copy failed — select the code and copy it by hand");
    const second = block();
    bindCopyButtons(document, undefined);
    second.btn.click();
    await vi.waitFor(() => expect(second.btn.textContent).toBe("copy failed"));
  });
  it("binds each button once", async () => {
    const { btn } = block();
    const clip = { writeText: vi.fn(async () => {}) };
    bindCopyButtons(document, clip);
    bindCopyButtons(document, clip);
    btn.click();
    await vi.waitFor(() => expect(clip.writeText).toHaveBeenCalledTimes(1));
  });
});
```

`apps/web/src/lib/motion-demo.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { bindMotionDemos } from "./motion-demo";

describe("motion demos", () => {
  it("play toggles the demo and names the next action", () => {
    const demo = document.createElement("div");
    demo.setAttribute("data-motion-demo", "");
    const btn = document.createElement("button");
    btn.setAttribute("data-motion-play", "");
    btn.textContent = "play";
    demo.append(btn);
    document.body.replaceChildren(demo);
    bindMotionDemos(document);
    btn.click();
    expect(demo.classList.contains("is-playing")).toBe(true);
    expect(btn.textContent).toBe("reset");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    btn.click();
    expect(demo.classList.contains("is-playing")).toBe(false);
    expect(btn.textContent).toBe("play");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/web && bunx vitest run src/lib/docs-nav.test.ts src/lib/copy-buttons.test.ts src/lib/motion-demo.test.ts`

Expected: FAIL (modules not found).

- [ ] **Step 3: The three modules**

`apps/web/src/lib/docs-nav.ts`:

```ts
// The /ui docs navigation. Each group appears once its pages exist (later tasks add theirs), and the
// /ui/ index is built from this list, so no docs link ever points at a missing page.
export type NavItem = { label: string; href: string };
export type NavGroup = { label: string; items: NavItem[] };

export const FOUNDATIONS: NavItem[] = [
  { label: "colours", href: "/ui/foundations/colours/" },
  { label: "type", href: "/ui/foundations/type/" },
  { label: "space, radii, layers", href: "/ui/foundations/space/" },
  { label: "motion", href: "/ui/foundations/motion/" },
  { label: "voice", href: "/ui/foundations/voice/" },
];

export function docsNav(_componentNames: string[]): NavGroup[] {
  return [
    { label: "start", items: [{ label: "overview", href: "/ui/" }] },
    { label: "foundations", items: FOUNDATIONS },
    { label: "more", items: [{ label: "utilities", href: "/ui/utilities/" }] },
  ];
}
```

`apps/web/src/lib/copy-buttons.ts`:

```ts
// Copy buttons for code blocks: visible and announced success, and a plain instruction when the
// clipboard refuses (B9: no silent failure; U-19's lesson).
type Clip = Pick<Clipboard, "writeText"> | undefined;

export function bindCopyButtons(doc: Document = document, clip: Clip = globalThis.navigator?.clipboard): void {
  for (const b of doc.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
    if (b.dataset.bound) continue;
    b.dataset.bound = "1";
    b.addEventListener("click", async () => {
      const id = b.dataset.copy ?? "";
      const status = doc.querySelector<HTMLElement>(`[data-copy-status="${id}"]`);
      try {
        if (!clip) throw new Error("no clipboard");
        await clip.writeText(doc.getElementById(id)?.textContent ?? "");
        b.textContent = "copied";
        if (status) status.textContent = "copied to the clipboard";
      } catch {
        b.textContent = "copy failed";
        if (status) status.textContent = "copy failed — select the code and copy it by hand";
      }
      setTimeout(() => { b.textContent = "copy"; }, 2000);
    });
  }
}
```

`apps/web/src/lib/motion-demo.ts`:

```ts
// "play" on the motion foundations page: toggles a class; the CSS transitions use the motion tokens,
// and prefers-reduced-motion makes them jump (ui global.css).
export function bindMotionDemos(doc: Document = document): void {
  for (const demo of doc.querySelectorAll<HTMLElement>("[data-motion-demo]")) {
    const btn = demo.querySelector<HTMLButtonElement>("[data-motion-play]");
    btn?.addEventListener("click", () => {
      const on = demo.classList.toggle("is-playing");
      btn.textContent = on ? "reset" : "play";
      btn.setAttribute("aria-pressed", String(on));
    });
  }
}
```

- [ ] **Step 4: Layout and docs components**

`apps/web/src/layouts/DocsLayout.astro`:

```astro
---
// /ui shell: content first in the source (phones read it first, with a jump link to the menu), the
// nav as a sticky sidebar from 960 px. No JS.
import BaseLayout from "./BaseLayout.astro";
import { docsNav } from "../lib/docs-nav";
import { uiApi } from "../ui-docs/api";

interface Props { title: string; description: string }
const { title, description } = Astro.props;
const groups = docsNav(uiApi().components.map((c) => c.name));
const path = Astro.url.pathname;
---
<BaseLayout title={title} description={description}>
  <div class="docs">
    <a class="docs__jump" href="#docs-nav">docs menu<span aria-hidden="true"> ↓</span></a>
    <div class="docs__content"><slot /></div>
    <nav id="docs-nav" class="docs__nav" aria-label="ui docs">
      {groups.map((g) => (
        <div class="docs__group">
          <p class="docs__group-label">{g.label}</p>
          <ul>{g.items.map((it) => <li><a href={it.href} aria-current={path === it.href ? "page" : undefined}>{it.label}</a></li>)}</ul>
        </div>
      ))}
    </nav>
  </div>
</BaseLayout>
```

`apps/web/src/components/docs/CodeBlock.astro`:

```astro
---
interface Props { id: string; code: string; lang: string }
const { id, code, lang } = Astro.props;
---
<div class="codeblock">
  <div class="codeblock__bar">
    <span class="codeblock__lang">{lang}</span>
    <button type="button" class="codeblock__copy" data-copy={id}>copy</button>
  </div>
  <pre id={id} tabindex="0"><code>{code}</code></pre>
  <p class="sr-only" aria-live="polite" data-copy-status={id}></p>
</div>
<script>
  import { bindCopyButtons } from "../../lib/copy-buttons";
  bindCopyButtons();
</script>
```

`apps/web/src/components/docs/Swatch.astro`:

```astro
---
// A colour chip drawn with an SVG fill attribute: exact token value, no style attribute (CSP).
interface Props { value: string }
const { value } = Astro.props;
---
<svg class="swatch" viewBox="0 0 32 32" aria-hidden="true"><rect class="swatch__rect" x="0.5" y="0.5" width="31" height="31" rx="2" fill={value} /></svg>
```

Append to `apps/web/src/styles/site.css`:

```css
/* ---- docs ---- */
.docs { display: grid; gap: var(--sp-5); }
.docs__jump { display: inline-flex; align-items: center; justify-self: start; min-height: var(--control-height); color: var(--c-fg-muted); font-size: var(--fs-2); }
.docs__content { display: grid; gap: var(--sp-6); align-content: start; min-width: 0; }
.docs__nav { display: grid; gap: var(--sp-4); align-content: start; padding-top: var(--sp-4); border-top: 1px solid var(--c-line); }
.docs__group-label { margin-bottom: var(--sp-1); font-size: var(--fs-1); color: var(--c-fg-subtle); }
.docs__nav ul { display: grid; margin: 0; padding: 0; list-style: none; }
.docs__nav a { display: flex; align-items: center; min-height: var(--control-height); padding: 0 var(--sp-3); border-left: 2px solid transparent; color: var(--c-fg-muted); font-size: var(--fs-2); }
.docs__nav a:hover { color: var(--c-fg); background: var(--c-surface); text-decoration: none; }
.docs__nav a[aria-current="page"] { color: var(--c-fg); border-left-color: var(--c-accent); }
@media (min-width: 960px) {
  .docs { grid-template-columns: 15rem minmax(0, 1fr); grid-template-areas: "nav content"; }
  .docs__jump { display: none; }
  .docs__content { grid-area: content; }
  .docs__nav { grid-area: nav; position: sticky; top: calc(var(--control-height) + var(--sp-4)); max-height: calc(100dvh - var(--control-height) - var(--sp-6)); overflow-y: auto; padding-top: 0; border-top: 0; }
}
.docs-head { display: grid; gap: var(--sp-3); }
.docs-section { display: grid; gap: var(--sp-3); min-width: 0; }
.docs-section > h2 { font-size: var(--fs-5); }
.docs-section h3 { font-size: var(--fs-4); }
.docs-list { display: grid; gap: var(--sp-1); max-width: 70ch; margin: 0; padding-left: var(--sp-5); }
.table-wrap { max-width: 100%; overflow-x: auto; }
.table { width: 100%; border-collapse: collapse; font-size: var(--fs-2); }
.table th, .table td { padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--c-line); text-align: left; vertical-align: top; }
.table th { color: var(--c-fg-muted); font-weight: 700; white-space: nowrap; }
.table td code { white-space: nowrap; }
.swatch { width: var(--sp-6); height: var(--sp-6); margin-right: var(--sp-2); vertical-align: middle; }
.swatch__rect { stroke: var(--c-line-strong); stroke-width: 1; }
.codeblock { min-width: 0; background: var(--c-surface); border: 1px solid var(--c-line); border-radius: var(--r-m); }
.codeblock__bar { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); padding-left: var(--sp-3); border-bottom: 1px solid var(--c-line); }
.codeblock__lang { font-size: var(--fs-1); color: var(--c-fg-subtle); }
.codeblock__copy { min-height: var(--control-height); min-width: var(--control-height); padding: 0 var(--sp-3); background: none; border: 0; border-radius: var(--r-m); color: var(--c-fg-muted); font: inherit; font-size: var(--fs-2); cursor: pointer; }
.codeblock__copy:hover { color: var(--c-fg); background: var(--c-bg-elev); }
.codeblock pre { margin: 0; border: 0; border-radius: 0; }
.fs-1 { font-size: var(--fs-1); }
.fs-2 { font-size: var(--fs-2); }
.fs-3 { font-size: var(--fs-3); }
.fs-4 { font-size: var(--fs-4); }
.fs-5 { font-size: var(--fs-5); }
.fs-6 { font-size: var(--fs-6); }
.fs-7 { font-size: var(--fs-7); }
.bold { font-weight: 700; }
.sp-bar { display: block; height: var(--sp-3); background: var(--c-fg-subtle); }
.sp-1 { width: var(--sp-1); }
.sp-2 { width: var(--sp-2); }
.sp-3 { width: var(--sp-3); }
.sp-4 { width: var(--sp-4); }
.sp-5 { width: var(--sp-5); }
.sp-6 { width: var(--sp-6); }
.sp-7 { width: var(--sp-7); }
.sp-8 { width: var(--sp-8); }
.r-box { width: var(--sp-8); height: var(--sp-8); background: var(--c-surface); border: 1px solid var(--c-line-input); }
.r-s { border-radius: var(--r-s); }
.r-m { border-radius: var(--r-m); }
.r-l { border-radius: var(--r-l); }
.demo-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-2); }
.demo-row > * { flex: 1 1 12rem; }
.motion-demo { display: grid; gap: var(--sp-2); }
.motion-demo__track { position: relative; height: var(--sp-6); border-bottom: 1px solid var(--c-line); }
.motion-demo__dot { position: absolute; left: 0; top: var(--sp-2); width: var(--sp-4); height: var(--sp-4); border-radius: var(--r-s); background: var(--c-fg-muted); }
.motion-demo__dot.d-fast { transition: transform var(--d-fast) var(--ease); }
.motion-demo__dot.d-base { transition: transform var(--d-base) var(--ease); }
.motion-demo__dot.d-slow { transition: transform var(--d-slow) var(--ease); }
.motion-demo.is-playing .motion-demo__dot { transform: translateX(min(16rem, 60vw)); }
.motion-note { display: none; }
@media (prefers-reduced-motion: reduce) { .motion-note { display: block; } }
```

- [ ] **Step 5: The pages**

`apps/web/src/pages/ui/index.astro`:

```astro
---
import DocsLayout from "../../layouts/DocsLayout.astro";
import CodeBlock from "../../components/docs/CodeBlock.astro";
import { docsNav } from "../../lib/docs-nav";
import { uiApi } from "../../ui-docs/api";

const api = uiApi();
const groups = docsNav(api.components.map((c) => c.name)).filter((g) => g.label !== "start");
const usage = `// package.json of an app inside the meowerse monorepo
"@meowerse/ui": "workspace:*"

// once, in the app's layout: tokens, fonts, base styles, components
import "@meowerse/ui/tokens.css";

// then, anywhere
import { Button, StatusLine } from "@meowerse/ui";`;
---
<DocsLayout title="ui docs" description="The public docs of @meowerse/ui: tokens, type, motion, voice, every component live, patterns and a playground.">
  <header class="docs-head">
    <h1 class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› </span>@meowerse/ui</h1>
    <p class="lede">The design system every meowerse app is built with. It shares its tokens with alxnko.dev: one graphite palette, one green, JetBrains Mono everywhere, and terminal touches only where they keep an app easy to use.</p>
    <p>{api.components.length} components, {api.functions.length} utilities, dark and light themes. Everything here is generated from the source, so it can't drift from what the apps ship.</p>
  </header>
  <section class="docs-section" aria-labelledby="use-title">
    <h2 id="use-title">use it</h2>
    <CodeBlock id="use" lang="ts" code={usage} />
  </section>
  <section class="docs-section" aria-labelledby="map-title">
    <h2 id="map-title">what's here</h2>
    {groups.map((g) => (
      <div class="docs-section">
        <h3>{g.label}</h3>
        <ul class="docs-list">{g.items.map((it) => <li><a href={it.href}>{it.label}</a></li>)}</ul>
      </div>
    ))}
  </section>
</DocsLayout>
```

`apps/web/src/pages/ui/foundations/colours.astro`:

```astro
---
import tokens from "@meowerse/ui/tokens.json";
import { CONTRAST_PAIRS, contrast, StatusLine } from "@meowerse/ui";
import DocsLayout from "../../../layouts/DocsLayout.astro";
import Swatch from "../../../components/docs/Swatch.astro";

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const semantic = Object.keys(tokens.semantic.dark) as (keyof typeof tokens.semantic.dark)[];
const brand = { green: tokens.primitive.green, greenInk: tokens.primitive.greenInk, amber: tokens.primitive.amber, red: tokens.primitive.red, cat: tokens.primitive.scene.cat, catEdge: tokens.primitive.scene.catEdge };
const pairs = CONTRAST_PAIRS.flatMap(([fg, bg, min]) => (["dark", "light"] as const).map((theme) => {
  const t = tokens.semantic[theme];
  const ratio = contrast(t[fg], t[bg]);
  return { theme, fg, bg, min, ratio, ok: ratio >= min };
}));
---
<DocsLayout title="colours" description="Every colour token of @meowerse/ui with its dark and light value, and the contrast of every text pair.">
  <header class="docs-head">
    <h1 class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› </span>colours</h1>
    <p class="lede">Graphite surfaces and one green. Dark is the default and follows the system; light is "day paper". Green marks the one primary action, focus, and live/ok, and is never body text on light (use accent there).</p>
  </header>
  <section class="docs-section" aria-labelledby="sem-title">
    <h2 id="sem-title">semantic tokens</h2>
    <div class="table-wrap" tabindex="0" role="region" aria-label="semantic colour tokens">
      <table class="table">
        <thead><tr><th scope="col">token</th><th scope="col">css variable</th><th scope="col">dark</th><th scope="col">light</th></tr></thead>
        <tbody>
          {semantic.map((k) => (
            <tr>
              <td>{k}</td>
              <td><code>{`--c-${kebab(k)}`}</code></td>
              <td><Swatch value={tokens.semantic.dark[k]} /><code>{tokens.semantic.dark[k]}</code></td>
              <td><Swatch value={tokens.semantic.light[k]} /><code>{tokens.semantic.light[k]}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
  <section class="docs-section" aria-labelledby="contrast-title">
    <h2 id="contrast-title">contrast</h2>
    <p>Every pair the components put text or a boundary on, checked in both themes by the token test. AA needs 4.5:1 for text and 3:1 for the focus ring and input borders.</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="contrast results">
      <table class="table">
        <thead><tr><th scope="col">text</th><th scope="col">on</th><th scope="col">theme</th><th scope="col">ratio</th><th scope="col">needs</th></tr></thead>
        <tbody>
          {pairs.map((p) => (
            <tr>
              <td><code>{p.fg}</code></td><td><code>{p.bg}</code></td><td>{p.theme}</td>
              <td><StatusLine state={p.ok ? "ok" : "fail"}>{`${p.ratio.toFixed(2)}:1`}</StatusLine></td>
              <td>{p.min}:1</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
  <section class="docs-section" aria-labelledby="brand-title">
    <h2 id="brand-title">brand primitives</h2>
    <p>Raw colours behind the semantic tokens. Use the semantic tokens in components; these are listed for reference (the cat colours feed Cat3D).</p>
    <ul class="docs-list">{Object.entries(brand).map(([k, v]) => <li><Swatch value={v} /><code>{k}</code> <code>{v}</code></li>)}</ul>
  </section>
  <section class="docs-section" aria-labelledby="ansi-title">
    <h2 id="ansi-title">terminal (ansi) palette</h2>
    <p>For glyphs inside dark code and terminal surfaces only. Several of these fail contrast on light backgrounds, so StatusLine and every other component use the theme tokens instead.</p>
    <ul class="docs-list">{Object.entries(tokens.ansi).map(([k, v]) => <li><Swatch value={v} /><code>{`--ansi-${k}`}</code> <code>{v}</code></li>)}</ul>
  </section>
</DocsLayout>
```

`apps/web/src/pages/ui/foundations/type.astro`:

```astro
---
import tokens from "@meowerse/ui/tokens.json";
import { Wordmark } from "@meowerse/ui";
import DocsLayout from "../../../layouts/DocsLayout.astro";
---
<DocsLayout title="type" description="The @meowerse/ui type scale, line heights and fonts: JetBrains Mono everywhere, VT323 for the wordmarks.">
  <header class="docs-head">
    <h1 class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› </span>type</h1>
    <p class="lede">One font, JetBrains Mono, at 400 and 700, so a › prompt and a button label share the same metrics. VT323 appears only in the wordmarks. Body text is 14 px with a 1.5 line height; inputs are 16 px so phones don't zoom; 12 px is the floor, for meta text only.</p>
  </header>
  <section class="docs-section" aria-labelledby="scale-title">
    <h2 id="scale-title">scale</h2>
    <div class="table-wrap" tabindex="0" role="region" aria-label="type scale">
      <table class="table">
        <thead><tr><th scope="col">token</th><th scope="col">size</th><th scope="col">sample</th></tr></thead>
        <tbody>
          {tokens.type.scale.map((px, i) => (
            <tr><td><code>{`--fs-${i + 1}`}</code></td><td>{px}px · {px / 16}rem</td><td class={`fs-${i + 1}`}>meow › [ ok ]</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
  <section class="docs-section" aria-labelledby="lead-title">
    <h2 id="lead-title">line height</h2>
    <ul class="docs-list">{Object.entries(tokens.type.leading).map(([k, v]) => <li><code>{`--leading-${k}`}</code>: {v}</li>)}</ul>
  </section>
  <section class="docs-section" aria-labelledby="font-title">
    <h2 id="font-title">fonts</h2>
    <p class="fs-4">JetBrains Mono 400: The quick brown fox jumps over the lazy cat. Съешь ещё этих мягких булок.</p>
    <p class="fs-4 bold">JetBrains Mono 700: The quick brown fox jumps over the lazy cat.</p>
    <p>A metric-matched fallback face keeps the layout still while the font loads. Latin is preloaded; Cyrillic and the symbols subset load only on pages that use those glyphs.</p>
    <div class="demo-row">
      <Wordmark name="meowerse" /><Wordmark name="meowsenger" /><Wordmark name="auth" /><Wordmark name="ui" />
    </div>
  </section>
</DocsLayout>
```

`apps/web/src/pages/ui/foundations/space.astro`:

```astro
---
import tokens from "@meowerse/ui/tokens.json";
import { Button, Field, Prompt } from "@meowerse/ui";
import DocsLayout from "../../../layouts/DocsLayout.astro";
const noop = () => {};
---
<DocsLayout title="space, radii, layers" description="Spacing, radii, stacking layers and control geometry of @meowerse/ui.">
  <header class="docs-head">
    <h1 class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› </span>space, radii, layers</h1>
    <p class="lede">A 4 px spacing scale, three radii, 1 px lines, and one control height, 44 px, so every target is easy to hit and terminal-style controls line up with app controls.</p>
  </header>
  <section class="docs-section" aria-labelledby="space-title">
    <h2 id="space-title">spacing</h2>
    <div class="table-wrap" tabindex="0" role="region" aria-label="spacing scale">
      <table class="table">
        <thead><tr><th scope="col">token</th><th scope="col">value</th><th scope="col">sample</th></tr></thead>
        <tbody>{tokens.space.slice(1).map((v, i) => <tr><td><code>{`--sp-${i + 1}`}</code></td><td>{v}px</td><td><span class={`sp-bar sp-${i + 1}`} /></td></tr>)}</tbody>
      </table>
    </div>
  </section>
  <section class="docs-section" aria-labelledby="radius-title">
    <h2 id="radius-title">radii</h2>
    <div class="demo-row">
      {Object.entries(tokens.radius).map(([k, v]) => <div><div class={`r-box r-${k}`} /><p><code>{`--r-${k}`}</code> {v}px</p></div>)}
    </div>
    <p>2 px for chips and code, 4 px for controls, 8 px for cards and sheets. Avatars are rounded squares, not circles.</p>
  </section>
  <section class="docs-section" aria-labelledby="control-title">
    <h2 id="control-title">controls</h2>
    <p>A field, a prompt and a button share one height (<code>--control-height</code>, {tokens.control.height} px), one 1 px input border, one radius and one focus ring (B10). Disabled controls use <code>--disabled-opacity</code> ({tokens.control.disabledOpacity}) and always say why.</p>
    <div class="demo-row">
      <Field label="name" defaultValue="alxnko" />
      <Prompt label="message" value="" onChange={noop} onSubmit={noop} />
      <Button variant="secondary">save</Button>
      <Button variant="secondary" disabled>disabled</Button>
    </div>
  </section>
  <section class="docs-section" aria-labelledby="z-title">
    <h2 id="z-title">layers</h2>
    <div class="table-wrap" tabindex="0" role="region" aria-label="stacking layers">
      <table class="table">
        <thead><tr><th scope="col">token</th><th scope="col">value</th><th scope="col">used by</th></tr></thead>
        <tbody>
          {Object.entries(tokens.z).map(([k, v]) => (
            <tr><td><code>{`--z-${k}`}</code></td><td>{v}</td><td>{({ stage: "page content", chrome: "sticky header", dock: "menus and drawers", sheet: "modals", toast: "toasts, above sheets", skip: "the skip link, above everything" } as Record<string, string>)[k]}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
</DocsLayout>
```

`apps/web/src/pages/ui/foundations/motion.astro`:

```astro
---
import tokens from "@meowerse/ui/tokens.json";
import { Cursor } from "@meowerse/ui";
import DocsLayout from "../../../layouts/DocsLayout.astro";
const durations = [["fast", tokens.motion.fast, "hover, press, colour changes"], ["base", tokens.motion.base, "panels, toasts, small movements"], ["slow", tokens.motion.slow, "large movements, rarely"]] as const;
---
<DocsLayout title="motion" description="Easing and durations of @meowerse/ui, with live demos, and how reduced motion is handled.">
  <header class="docs-head">
    <h1 class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› </span>motion</h1>
    <p class="lede">One ease-out curve and three durations. Motion confirms an action or shows where something went; it never delays a reply. With reduced motion, every non-essential animation stops, the cursor stops blinking, and Cat3D stays a still image.</p>
  </header>
  <section class="docs-section" aria-labelledby="ease-title">
    <h2 id="ease-title">tokens</h2>
    <div class="table-wrap" tabindex="0" role="region" aria-label="motion tokens">
      <table class="table">
        <thead><tr><th scope="col">token</th><th scope="col">value</th><th scope="col">for</th></tr></thead>
        <tbody>
          <tr><td><code>--ease</code></td><td><code>{tokens.motion.ease}</code></td><td>everything (expo-out)</td></tr>
          {durations.map(([k, v, use]) => <tr><td><code>{`--d-${k}`}</code></td><td>{v}ms</td><td>{use}</td></tr>)}
        </tbody>
      </table>
    </div>
  </section>
  <section class="docs-section" aria-labelledby="demo-title">
    <h2 id="demo-title">try it</h2>
    <div class="motion-demo" data-motion-demo>
      {durations.map(([k]) => <div class="motion-demo__track"><span class={`motion-demo__dot d-${k}`} /></div>)}
      <p class="motion-note">Your device asks for reduced motion, so the dots jump instead of sliding.</p>
      <button type="button" class="mw-btn mw-btn--secondary mw-btn--md" data-motion-play aria-pressed="false">play</button>
    </div>
    <p>The wordmark cursor blinks at 1 Hz in steps: <Cursor /></p>
  </section>
  <script>
    import { bindMotionDemos } from "../../../lib/motion-demo";
    bindMotionDemos();
  </script>
</DocsLayout>
```

`apps/web/src/pages/ui/foundations/voice.astro`:

```astro
---
import DocsLayout from "../../../layouts/DocsLayout.astro";
const rules = [
  "Lowercase, calm and short. Interface copy (labels, buttons, headings, status lines) is written in lowercase in the source, never with text-transform.",
  "What people type is shown exactly as typed: names, messages, codes, email addresses.",
  "Long-form prose, like these rules, keeps normal sentence case.",
  "Errors say what happened and what to do next, in plain words; never a code alone.",
  "A control that waits for something says why it waits, and is never enabled only to refuse.",
  "The terminal flavour lives in small details: the › prompt, the block cursor on the wordmark, [ ok ] and [fail] status lines. At most one per region of a view.",
  "Status always has a glyph and a word; colour alone never carries meaning.",
];
const examples = [
  ["wrong password — try again or reset it", "Error 401"],
  ["checking you're human… (the button stays disabled until done)", "an enabled button that answers \"verification not finished\""],
  ["can't reach the server. check your connection and try again.", "Network error"],
  ["[ ok ] online", "a green dot on its own"],
  ["delete chat", "Delete Chat, DELETE CHAT"],
  ["type Cats & Co to confirm (the phrase exactly as the owner wrote it)", "a lowercased phrase that can never match"],
];
---
<DocsLayout title="voice and microcopy" description="How meowerse interfaces talk: lowercase, calm, short, and plain about errors.">
  <header class="docs-head">
    <h1 class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› </span>voice and microcopy</h1>
    <p class="lede">Same voice as alxnko.dev: a terminal's calm, an app's clarity.</p>
  </header>
  <section class="docs-section" aria-labelledby="rules-title">
    <h2 id="rules-title">rules</h2>
    <ul class="docs-list">{rules.map((r) => <li>{r}</li>)}</ul>
  </section>
  <section class="docs-section" aria-labelledby="ex-title">
    <h2 id="ex-title">examples</h2>
    <div class="table-wrap" tabindex="0" role="region" aria-label="microcopy examples">
      <table class="table">
        <thead><tr><th scope="col">write</th><th scope="col">not</th></tr></thead>
        <tbody>{examples.map(([good, bad]) => <tr><td>{good}</td><td>{bad}</td></tr>)}</tbody>
      </table>
    </div>
  </section>
</DocsLayout>
```

`apps/web/src/pages/ui/utilities.astro`:

```astro
---
import DocsLayout from "../../layouts/DocsLayout.astro";
import { uiApi } from "../../ui-docs/api";
const { functions, values, types } = uiApi();
---
<DocsLayout title="utilities" description="Hooks, helpers, constants and types exported by @meowerse/ui, generated from the source.">
  <header class="docs-head">
    <h1 class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› </span>utilities</h1>
    <p class="lede">Everything @meowerse/ui exports besides components, read from the TypeScript source at build time.</p>
  </header>
  <section class="docs-section" aria-labelledby="fn-title">
    <h2 id="fn-title">functions and hooks</h2>
    <div class="table-wrap" tabindex="0" role="region" aria-label="functions">
      <table class="table">
        <thead><tr><th scope="col">name</th><th scope="col">signature</th><th scope="col">notes</th></tr></thead>
        <tbody>{functions.map((f) => <tr><td><code>{f.name}</code></td><td><code>{f.signature}</code></td><td>{f.description ?? ""} <span class="mw-muted">{f.file}</span></td></tr>)}</tbody>
      </table>
    </div>
  </section>
  <section class="docs-section" aria-labelledby="val-title">
    <h2 id="val-title">constants</h2>
    <div class="table-wrap" tabindex="0" role="region" aria-label="constants">
      <table class="table">
        <thead><tr><th scope="col">name</th><th scope="col">type</th></tr></thead>
        <tbody>{values.map((v) => <tr><td><code>{v.name}</code></td><td><code>{v.type}</code></td></tr>)}</tbody>
      </table>
    </div>
  </section>
  <section class="docs-section" aria-labelledby="type-title">
    <h2 id="type-title">types</h2>
    <p>{types.map((t, i) => <><code>{t}</code>{i < types.length - 1 ? ", " : ""}</>)}</p>
  </section>
</DocsLayout>
```

- [ ] **Step 6: e2e for the foundations**

`apps/web/tests/e2e/ui-foundations.spec.ts`:

```ts
import { test, expect } from "./fixtures";

test("colours: every semantic token in both themes and every contrast pair passing", async ({ page }) => {
  await page.goto("/ui/foundations/colours/");
  await expect(page.locator('section[aria-labelledby="sem-title"] tbody tr')).toHaveCount(21);
  const rows = page.locator('section[aria-labelledby="contrast-title"] tbody tr');
  await expect(rows).toHaveCount(42);
  await expect(page.locator('section[aria-labelledby="contrast-title"] .mw-status--fail')).toHaveCount(0);
});

test("motion: play moves the dots and says reset", async ({ page }) => {
  await page.goto("/ui/foundations/motion/");
  const play = page.locator("[data-motion-play]");
  await play.click();
  await expect(page.locator("[data-motion-demo]")).toHaveClass(/is-playing/);
  await expect(play).toHaveText("reset");
});

test("copy buttons copy and say so", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "clipboard permissions are desktop-only in this setup");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/ui/");
  await page.locator('[data-copy="use"]').click();
  await expect(page.locator('[data-copy="use"]')).toHaveText("copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('import "@meowerse/ui/tokens.css";');
});

test("utilities are generated from the source", async ({ page }) => {
  await page.goto("/ui/utilities/");
  await expect(page.locator("td code", { hasText: /^request$/ })).toBeVisible();
  await expect(page.locator("td code", { hasText: /^THEME_INIT_SCRIPT$/ })).toBeVisible();
});

test("the docs menu is reachable on phones from the top of the page", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "the jump link only shows on narrow screens");
  await page.goto("/ui/foundations/type/");
  await page.locator(".docs__jump").click();
  await expect(page.locator("#docs-nav")).toBeInViewport();
});
```

- [ ] **Step 7: Run everything**

```bash
(cd apps/web && bunx vitest run --coverage)
bun run --filter @meowerse/web lint
bun run --filter @meowerse/web build
bun run --filter @meowerse/web e2e
```

Expected:
- all green;
- the build lists 14 sitemap pages;
- none of the new pages has an `astro-island`;
- the site-wide axe, targets, CSP and links specs cover them.

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "feat(web): /ui docs shell, foundations pages and utilities

Docs layout with a content-first nav (sticky sidebar from 960 px, jump link on phones). Colours
with every token in both themes and the contrast table the test enforces; type scale and fonts;
spacing, radii, layers and the shared control geometry (B10); motion with live demos and the
reduced-motion rule; voice and microcopy; utilities generated from the source. Code blocks copy
with a visible and announced result.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 8: Component pages: every variant and state live, props, CSS variables, snippets, accessibility, do and don't (spec §5.2 "Components", B12)

**Files:**
- Create:
  - `apps/web/src/ui-docs/types.ts`, `apps/web/src/ui-docs/registry.ts`,
    `apps/web/src/ui-docs/registry.test.ts`;
  - `apps/web/src/ui-docs/components/<slug>.tsx`, one per component (26 files, listed in Step 3);
  - `apps/web/src/components/docs/ReactNodeView.tsx`, `PropsTable.astro`, `CssVarsTable.astro`,
    `Preview.astro`;
  - `apps/web/src/pages/ui/components/index.astro`, `apps/web/src/pages/ui/components/[slug].astro`;
  - `apps/web/tests/e2e/ui-components.spec.ts`.
- Modify: `apps/web/src/lib/docs-nav.ts` (+test), `apps/web/src/styles/site.css` (append
  "component pages")

**Interfaces:**
- Consumes:
  - Task 6's `componentDoc`, `cssApi`, `toJsx`, `toSlug`, `extractUiApi`;
  - Task 7's `DocsLayout`, `CodeBlock`.
- Produces:
  - `Example = { title: string; node: ReactElement | ((scope: string) => ReactElement); html?: boolean; snippet?: false; wide?: true; note?: string }`.
    A function `node` gets a scope string ("page", "dark", "light"), so a node rendered twice on one
    page, like a radio group, can use unique names.
  - `ComponentPage = { name; from?: "@meowerse/ui" | "@meowerse/ui/cat3d"; summary; examples: Example[]; interactiveOnly?: true; a11y: string[]; keys?: [string, string][]; dos: string[]; donts: string[] }`.
  - `nodeOf(ex: Example, scope: string): ReactElement`.
  - `COMPONENT_PAGES: RegisteredPage[]`, sorted by name, where
    `RegisteredPage = ComponentPage & { slug: string }`. `pageFor(slug)`.
  - `Preview.astro`. Props: `{ page: RegisteredPage; scope: string; wide?: boolean }`. It renders
    every example of a page inside `[data-preview]` stages; Task 9's gallery reuses it.
  - Every component page has sections with ids `preview-title`, `props-title`, `css-title`,
    `usage-title`, `a11y-title` and `dodont-title`.
  - `/ui/components/<slug>/` for all 26 components.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/ui-docs/registry.test.ts`:

```ts
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { extractUiApi, uiDirFrom } from "../lib/ui-api";
import { toSlug } from "../lib/slug";
import { COMPONENT_PAGES, nodeOf } from "./registry";

const api = extractUiApi(uiDirFrom(process.cwd()));

describe("component docs registry", () => {
  it("documents every exported component and nothing else (a new ui component without docs fails here)", () =>
    expect(COMPONENT_PAGES.map((p) => p.name)).toEqual(api.components.map((c) => c.name)));
  it.each(COMPONENT_PAGES.map((p) => [p.name, p] as const))("%s has a summary, examples, a11y notes and do/don't", (_n, p) => {
    expect(p.slug).toBe(toSlug(p.name));
    expect(p.summary.length).toBeGreaterThan(20);
    if (!p.interactiveOnly) expect(p.examples.length).toBeGreaterThan(0);
    expect(p.a11y.length).toBeGreaterThan(0);
    expect(p.dos.length).toBeGreaterThan(0);
    expect(p.donts.length).toBeGreaterThan(0);
  });
  it.each(COMPONENT_PAGES.flatMap((p) => p.examples.map((e) => [`${p.name}: ${e.title}`, e] as const)))("%s renders on the server", (_n, e) => {
    expect(renderToStaticMarkup(nodeOf(e, "page"))).toMatch(/^</);
  });
});
```

In `apps/web/src/lib/docs-nav.test.ts`, add:

```ts
  it("lists every component under components, after an index link", () => {
    const comps = docsNav(["Button", "ConfirmDialog", "Alert"]).find((g) => g.label === "components")!;
    expect(comps.items).toEqual([
      { label: "all components", href: "/ui/components/" },
      { label: "Alert", href: "/ui/components/alert/" },
      { label: "Button", href: "/ui/components/button/" },
      { label: "ConfirmDialog", href: "/ui/components/confirm-dialog/" },
    ]);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/web && bunx vitest run src/ui-docs src/lib/docs-nav.test.ts`

Expected: FAIL. `./registry` doesn't exist and there is no components group.

- [ ] **Step 3: Types, registry and the 26 records**

`apps/web/src/ui-docs/types.ts`:

```ts
import type { ReactElement } from "react";

/** One live preview. `node` renders on the server; a function gets a scope so twice-rendered nodes stay unique. */
export type Example = {
  title: string;
  node: ReactElement | ((scope: string) => ReactElement);
  /** also show the rendered HTML (for components that work without React: static markup + tokens.css) */
  html?: boolean;
  /** hide the usage snippet (e.g. the all-icons grid) */
  snippet?: false;
  /** spans the whole preview grid (headers, footers, wide grids) */
  wide?: true;
  note?: string;
};

export type ComponentPage = {
  name: string;
  from?: "@meowerse/ui" | "@meowerse/ui/cat3d";
  summary: string;
  examples: Example[];
  /** nothing to show without interaction (portals, timers): the page relies on its demo (Task 9) */
  interactiveOnly?: true;
  a11y: string[];
  keys?: [key: string, action: string][];
  dos: string[];
  donts: string[];
};
```

`apps/web/src/ui-docs/registry.ts`:

```ts
// Every /ui/components page, one record per @meowerse/ui component (registry.test.ts keeps the list complete).
import type { ReactElement } from "react";
import { toSlug } from "../lib/slug";
import type { ComponentPage, Example } from "./types";

export type RegisteredPage = ComponentPage & { slug: string };

const mods = import.meta.glob<{ default: ComponentPage }>("./components/*.tsx", { eager: true });

export const COMPONENT_PAGES: RegisteredPage[] = Object.values(mods)
  .map((m) => ({ ...m.default, slug: toSlug(m.default.name) }))
  .sort((a, b) => a.name.localeCompare(b.name));

export function pageFor(slug: string): RegisteredPage {
  const p = COMPONENT_PAGES.find((x) => x.slug === slug);
  if (!p) throw new Error(`no component page ${slug}`);
  return p;
}

export const nodeOf = (ex: Example, scope: string): ReactElement => (typeof ex.node === "function" ? ex.node(scope) : ex.node);
```

Create these 26 files in `apps/web/src/ui-docs/components/`. The copy follows the house voice: labels
in lowercase, notes in sentence case. Known gaps from the audit are stated plainly, with the
sub-project that fixes them.

`alert.tsx`:

```tsx
import { Alert } from "@meowerse/ui";
import type { ComponentPage } from "../types";
const noop = () => {};

export default {
  name: "Alert",
  summary: "A short message block for a success, an error or information, with an optional dismiss button.",
  examples: [
    { title: "info", node: <Alert>your recovery codes were replaced. the old ones no longer work.</Alert>, html: true },
    { title: "success", node: <Alert variant="success">saved.</Alert>, html: true },
    { title: "error", node: <Alert variant="error">wrong password — try again or reset it.</Alert>, html: true },
    { title: "dismissible", node: <Alert variant="info" onDismiss={noop}>you can revoke an app's access any time.</Alert> },
  ],
  a11y: [
    "Errors render with role=\"alert\", so screen readers announce them at once; the other variants use role=\"status\".",
    "The icon is decorative: the words carry the meaning, never the colour alone.",
    "The dismiss button is 44×44 px and is named \"dismiss\".",
  ],
  keys: [["Tab", "reaches the dismiss button"], ["Enter or Space", "dismisses the alert"]],
  dos: ["Say what happened and what to do next: \"wrong password — try again or reset it\".", "Put the alert next to what it is about."],
  donts: ["Don't show a code on its own, like \"Error 401\".", "Don't use an alert for a passing success; use a toast."],
} satisfies ComponentPage;
```

`app-header.tsx`:

```tsx
import { AppHeader } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "AppHeader",
  summary: "The header of meowerse accounts: brand, navigation that follows the session, the theme toggle, and a menu button on phones.",
  examples: [
    { title: "checking the session", note: "session-dependent links wait", wide: true, node: <AppHeader session={{ loading: true, authenticated: false }} /> },
    { title: "signed out", wide: true, node: <AppHeader session={{ loading: false, authenticated: false }} /> },
    { title: "signed in", wide: true, node: <AppHeader session={{ loading: false, authenticated: true, username: "alxnko", verified: true }} /> },
    { title: "session check failed", note: "no false \"log in\"", wide: true, node: <AppHeader session={{ loading: false, authenticated: false, error: "network" }} /> },
  ],
  a11y: [
    "The brand link is named \"meowerse auth — home\".",
    "The phone menu button reports aria-expanded; the navigation opens below the header.",
    "While the session is loading or failed, the header never offers \"log in\" to someone who may already be signed in (B9).",
  ],
  keys: [["Tab", "moves through the links, the theme toggle and the menu button"], ["Enter or Space", "opens or closes the phone menu"]],
  dos: ["Pass the session from useSession(base), so every island on the page shares one request."],
  donts: ["Don't use it outside meowerse accounts yet: its brand and links are fixed. A configurable header comes with the accounts redesign (sub-project 3)."],
} satisfies ComponentPage;
```

`auth-gate.tsx`:

```tsx
import { AuthGate } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "AuthGate",
  summary: "Shows its children only to a signed-in user: it waits visibly, explains a failure with a retry, and sends people to sign in only on a real signed-out answer.",
  examples: [
    { title: "checking the session", note: "its first render, on the server and in the browser", node: <AuthGate base="https://auth.alxnko.dev"><p>account settings</p></AuthGate> },
  ],
  a11y: [
    "The wait is a labelled status: \"checking your session\".",
    "A failure is an alert that says what happened, with a \"try again\" button.",
    "It redirects only when the account service really answers \"signed out\", never on a timeout or a network error (B18).",
  ],
  keys: [["Tab", "reaches \"try again\" after a failure"]],
  dos: ["Wrap whole pages that need an account.", "Keep loginPath on the same origin; the return path (next=) is added for you."],
  donts: ["Don't treat a failed session check as signed out.", "Don't nest gates; use one per page."],
} satisfies ComponentPage;
```

`avatar.tsx`:

```tsx
import { Avatar } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Avatar",
  summary: "A rounded square with a person's initial, in three sizes.",
  examples: [
    { title: "small", node: <Avatar name="alxnko" size="sm" />, html: true },
    { title: "medium", node: <Avatar name="Мяу" />, html: true },
    { title: "large", node: <Avatar name="Cats & Co" size="lg" />, html: true },
  ],
  a11y: [
    "An image named by the person's name (role=\"img\" with aria-label, audit U-15); the initial itself is hidden from assistive tech.",
    "Where the name is already written next to it, the avatar repeats it; that's harmless, but keep the visible name.",
  ],
  dos: ["Show the person's name next to the avatar in lists and headers."],
  donts: ["Don't rely on the initial alone to identify someone."],
} satisfies ComponentPage;
```

`badge.tsx`:

```tsx
import { Badge } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Badge",
  summary: "A small label for a state or a category: verified, neutral or danger.",
  examples: [
    { title: "verified", node: <Badge variant="verified" icon="rosette-discount-check">verified</Badge>, html: true },
    { title: "neutral", node: <Badge>draft</Badge>, html: true },
    { title: "danger", node: <Badge variant="danger">suspended</Badge>, html: true },
  ],
  a11y: ["The text carries the meaning; the icon is hidden from assistive tech.", "A badge is not interactive."],
  dos: ["Keep it to one or two words."],
  donts: ["Don't use a badge as a button.", "Don't make a badge green unless it means verified or ok."],
} satisfies ComponentPage;
```

`button.tsx`:

```tsx
import { Button } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Button",
  summary: "A native button in four variants and two sizes, with a loading state.",
  examples: [
    { title: "primary", note: "the one main action", node: <Button variant="primary">save</Button>, html: true },
    { title: "secondary", node: <Button>cancel</Button>, html: true },
    { title: "ghost", node: <Button variant="ghost">more options</Button>, html: true },
    { title: "danger", node: <Button variant="danger">delete account</Button>, html: true },
    { title: "small", note: "36 px drawn, 44 px hit area", node: <Button size="sm">copy all</Button>, html: true },
    { title: "loading", node: <Button variant="primary" loading>saving</Button> },
    { title: "disabled", node: <Button variant="primary" disabled>save</Button>, html: true },
  ],
  a11y: [
    "A native <button>: Enter and Space work, and focus shows the 2 px ring.",
    "loading disables it and adds a spinner; keep the label saying what is happening.",
    "It sets no default type (audit U-20): inside a form, set type=\"button\" on buttons that must not submit.",
  ],
  keys: [["Tab", "focuses the button"], ["Enter or Space", "presses it"]],
  dos: ["Use one primary (green) button per view, for the main action.", "Explain a disabled button next to it."],
  donts: ["Don't put two green buttons in one view.", "Don't enable a button and then refuse the click with \"not ready\"."],
} satisfies ComponentPage;
```

`card.tsx`:

```tsx
import { Card } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Card",
  summary: "A flat panel that groups related content, with an optional title.",
  examples: [
    { title: "with a title", node: <Card title="profile"><p>signed in as alxnko.</p></Card>, html: true },
    { title: "without a title", node: <Card><p>a plain card groups related content.</p></Card>, html: true },
  ],
  a11y: ["With a title it is a section labelled by its heading.", "The title is always an h2 (audit U-21); place cards where an h2 fits the page outline."],
  dos: ["Use cards to group a few related things."],
  donts: ["Don't nest cards.", "Don't make a whole card clickable without a real link inside it."],
} satisfies ComponentPage;
```

`cat3d.tsx`:

```tsx
import { Cat3D } from "@meowerse/ui/cat3d";
import type { ComponentPage } from "../types";

export default {
  name: "Cat3D",
  from: "@meowerse/ui/cat3d",
  summary: "The low-poly green cat from the alxnko.dev desk: a still poster first, then a tiny WebGL2 renderer whose head follows the pointer.",
  examples: [
    { title: "the poster", note: "it comes alive on /ui/cat3d/ and on the home page", node: <Cat3D size={160} /> },
  ],
  a11y: [
    "Decorative: aria-hidden, with nothing focusable, so a failure costs nothing.",
    "Reduced motion, save-data, no WebGL2 or a failed load all keep the still image.",
  ],
  dos: ["Render its markup on the server and call attachAllCat3D() from a small script, or use <Cat3D> in a React island."],
  donts: ["Don't put information in it.", "Don't use it in meowsenger (spec §4)."],
} satisfies ComponentPage;
```

`checkbox.tsx`:

```tsx
import { Checkbox } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Checkbox",
  summary: "A native checkbox with its label, in a 44 px row.",
  examples: [
    { title: "unchecked", node: <Checkbox label="remember this device" />, html: true },
    { title: "checked", node: <Checkbox label="keep me signed in" defaultChecked />, html: true },
    { title: "disabled", node: <Checkbox label="sync across devices (not available yet)" disabled />, html: true },
  ],
  a11y: ["A native checkbox tied to its label: clicking the text toggles it.", "Space toggles it; focus shows the ring."],
  keys: [["Tab", "focuses it"], ["Space", "toggles it"]],
  dos: ["Word the label as the thing that becomes true when checked."],
  donts: ["Don't use a checkbox for an action that happens at once; use a button."],
} satisfies ComponentPage;
```

`code.tsx`:

```tsx
import { Code } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Code",
  summary: "An inline code value, shown exactly as it is, with an optional copy button.",
  examples: [
    { title: "value", node: <Code value="meow.alxnko.dev" />, html: true },
    { title: "with copy", note: "try it in the demo below", node: <Code value="k3m9-X2p4-q8w1" copy /> },
  ],
  a11y: [
    "The value keeps its case: what you see is what you copy.",
    "The copy button is 44×44 px and named \"copy\".",
    "Success is shown by the icon only and a refused clipboard is silent (audit U-19); that is fixed in the accounts redesign (sub-project 3).",
  ],
  keys: [["Tab", "reaches the copy button"], ["Enter or Space", "copies"]],
  dos: ["Use it for ids, keys, codes and commands."],
  donts: ["Don't use it for ordinary words."],
} satisfies ComponentPage;
```

`confirm-dialog.tsx`:

```tsx
import type { ComponentPage } from "../types";

export default {
  name: "ConfirmDialog",
  summary: "A modal that asks before something destructive, optionally making you type a phrase or your password.",
  examples: [],
  interactiveOnly: true,
  a11y: [
    "Opens as a modal dialog with focus inside; Escape and \"cancel\" close it.",
    "With confirmPhrase, the phrase is shown exactly in <code>, and the field says \"doesn't match yet\" while it doesn't.",
    "The confirm button stays disabled until the phrase or password is there, and the reason is on screen.",
  ],
  keys: [["Tab / Shift+Tab", "cycles inside the dialog"], ["Escape", "cancels"]],
  dos: ["Use it only for actions that are hard to undo.", "Name the confirm button after the action: \"delete chat\"."],
  donts: ["Don't lowercase or trim the phrase people must type.", "Don't ask for confirmation of harmless actions."],
} satisfies ComponentPage;
```

`contact-links.tsx`:

```tsx
import { ContactLinks } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "ContactLinks",
  summary: "A row of 44 px icon links to reach the author.",
  examples: [
    { title: "default contacts", node: <ContactLinks />, html: true },
    { title: "your own list", node: <ContactLinks contacts={[{ label: "github", href: "https://github.com/meowerse", icon: "brand-github" }]} />, html: true },
  ],
  a11y: ["Each icon link is named by its label.", "Web links open in a new tab with rel=\"noreferrer noopener\"; mailto opens the mail app in place."],
  dos: ["Keep the list short and familiar."],
  donts: ["Don't use unlabelled icons."],
} satisfies ComponentPage;
```

`cursor.tsx`:

```tsx
import { Cursor } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Cursor",
  summary: "The block cursor of the wordmarks, blinking at 1 Hz in steps.",
  examples: [
    { title: "blinking", node: <Cursor />, html: true },
    { title: "static", node: <Cursor blink={false} />, html: true },
  ],
  a11y: ["aria-hidden: purely decorative.", "It stops blinking under reduced motion."],
  dos: ["Use it in wordmarks and headings."],
  donts: ["Never put a blinking block cursor in an input field (spec §7)."],
} satisfies ComponentPage;
```

`field.tsx`:

```tsx
import { Field } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Field",
  summary: "A labelled text input with an optional hint or error, and a reveal button for passwords.",
  examples: [
    { title: "with a hint", node: <Field label="username" hint="letters, digits and _ only" autoCapitalize="none" autoCorrect="off" spellCheck={false} />, html: true },
    { title: "password", note: "with a reveal button", node: <Field label="password" type="password" defaultValue="correct horse" /> },
    { title: "error", node: <Field label="username" defaultValue="alxnko" error="that name is taken — try another" />, html: true },
    { title: "disabled", node: <Field label="email" defaultValue="not collected" disabled />, html: true },
  ],
  a11y: [
    "The label is always visible and tied to the input.",
    "The hint and the error are linked with aria-describedby; an error sets aria-invalid and is announced.",
    "The reveal button is 44×44 px and named \"show password\" or \"hide password\".",
    "Inputs are 16 px, so phones don't zoom in.",
  ],
  keys: [["Tab", "moves to the input, then to the reveal button"]],
  dos: ["Say what is wrong and how to fix it in the error.", "Use autoCapitalize=\"none\" for usernames."],
  donts: ["Don't use the placeholder as the label.", "Don't validate on every keystroke before the person has finished."],
} satisfies ComponentPage;
```

`footer.tsx`:

```tsx
import { Footer } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Footer",
  summary: "The page footer: site links, contact links and a one-line legal note.",
  examples: [
    { title: "defaults (meowerse accounts)", wide: true, node: <Footer />, html: true },
    { title: "your own links", wide: true, node: <Footer links={[{ label: "projects", href: "/#projects" }, { label: "ui docs", href: "/ui/" }]} legal="meowerse — a personal project by alxnko." />, html: true },
  ],
  a11y: ["The site links are a labelled navigation region (\"site\").", "Every link is at least 44 px tall."],
  dos: ["Pass your app's own links and legal line."],
  donts: ["Don't put primary actions in the footer."],
} satisfies ComponentPage;
```

`icon.tsx`:

```tsx
import { Icon, ICON_NAMES } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Icon",
  summary: "A curated set of Tabler outline icons, drawn as inline SVG paths in the current text colour.",
  examples: [
    { title: "decorative", node: <Icon name="send" />, html: true },
    { title: "with a label", note: "becomes an image with a name", node: <Icon name="check" label="done" />, html: true },
    {
      title: "every icon", snippet: false,
      node: <ul className="icon-grid">{ICON_NAMES.map((n) => <li key={n}><Icon name={n} size={20} /><code>{n}</code></li>)}</ul>,
    },
  ],
  a11y: ["Decorative by default (aria-hidden); pass label to give it a name.", "Paths are elements, not innerHTML, so it renders under Trusted Types."],
  dos: ["Pair icons with text, except in 44 px icon buttons that have an aria-label."],
  donts: ["Don't use an unknown name: it renders nothing."],
} satisfies ComponentPage;
```

`kbd.tsx`:

```tsx
import { Kbd } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Kbd",
  summary: "A keycap for keyboard shortcuts in text.",
  examples: [
    { title: "one key", node: <Kbd>Enter</Kbd>, html: true },
    { title: "a combination", node: <><Kbd>Shift</Kbd> + <Kbd>Enter</Kbd></>, html: true },
  ],
  a11y: ["A native <kbd> element; screen readers read the key name."],
  dos: ["Write key names as they appear on keyboards."],
  donts: ["Don't use it for buttons on screen."],
} satisfies ComponentPage;
```

`modal.tsx`:

```tsx
import type { ComponentPage } from "../types";

export default {
  name: "Modal",
  summary: "A dialog over the page that keeps focus inside until it closes.",
  examples: [],
  interactiveOnly: true,
  a11y: [
    "role=\"dialog\" with aria-modal, labelled by its title.",
    "Focus moves inside on open, cycles only through controls you can use (it skips disabled, hidden, display:none and visibility:hidden ones) and returns to the trigger on close.",
    "Escape and the backdrop close it; with two dialogs open, only the top one reacts.",
    "It has no close button of its own and doesn't lock page scroll yet (audit U-08): always give it a visible \"cancel\" or \"close\" button.",
  ],
  keys: [["Tab / Shift+Tab", "cycles through the dialog's controls"], ["Escape", "closes it"]],
  dos: ["Put the main action last and a cancel button next to it."],
  donts: ["Don't open a modal on page load.", "Don't put a whole page inside one."],
} satisfies ComponentPage;
```

`prompt.tsx`:

```tsx
import { Prompt } from "@meowerse/ui";
import type { ComponentPage } from "../types";
const noop = () => {};

export default {
  name: "Prompt",
  summary: "The chat composer: a › glyph before a normal, auto-growing textarea, with a visible send button.",
  examples: [
    { title: "empty", note: "send is aria-disabled", node: <Prompt label="message" value="" onChange={noop} onSubmit={noop} /> },
    { title: "with text", node: <Prompt label="message" value="see you at 7" onChange={noop} onSubmit={noop} /> },
    { title: "busy", note: "still editable; sends queue", node: <Prompt label="message" value="and one more thing" busy onChange={noop} onSubmit={noop} /> },
  ],
  a11y: [
    "A labelled textarea: the label is visually hidden and the placeholder repeats it.",
    "On desktop, Enter sends and Shift+Enter adds a line; on phones, Enter adds a line and the button sends. Nothing is sent while an input method is composing.",
    "The field is never disabled; the send button is 44×44 px and named \"send\".",
  ],
  keys: [["Enter", "sends (desktop)"], ["Shift+Enter", "adds a line"], ["Tab", "moves to the send button"]],
  dos: ["Queue sends while offline instead of disabling the field."],
  donts: ["Don't make it a borderless command line or add a blinking block cursor (spec §7)."],
} satisfies ComponentPage;
```

`radio-group.tsx`:

```tsx
import { RadioGroup } from "@meowerse/ui";
import type { ComponentPage } from "../types";
const noop = () => {};
const options = [
  { label: "follow the system", value: "system" },
  { label: "dark", value: "dark" },
  { label: "light", value: "light", hint: "day paper" },
];

export default {
  name: "RadioGroup",
  summary: "A labelled group of native radio buttons, each in a 44 px row, with optional hints.",
  examples: [
    { title: "with hints", node: (scope) => <RadioGroup name={`theme-${scope}`} legend="theme" options={options} value="system" onChange={noop} />, html: true },
  ],
  a11y: ["A fieldset with a legend; each option's label is tied to its radio.", "Arrow keys move between options, as with any native radio group."],
  keys: [["Tab", "enters the group"], ["Arrow keys", "move the choice"]],
  dos: ["Use it for two to five exclusive choices."],
  donts: ["Don't use it for a single yes/no; use a checkbox."],
} satisfies ComponentPage;
```

`recovery-codes.tsx`:

```tsx
import { RecoveryCodes } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "RecoveryCodes",
  summary: "A grid of one-time recovery codes with a \"copy all\" button.",
  examples: [
    { title: "eight codes", node: <RecoveryCodes codes={["b7qk-2m9x", "t4nw-8rd3", "h2vc-6yp1", "m9zs-4kt7", "q3lf-7bn2", "w8xd-1gj5", "e6pr-3hm8", "u1ty-9cs4"]} /> },
  ],
  a11y: ["The codes are a list, shown exactly as issued.", "\"copy all\" gives no feedback yet (audit U-19); that is fixed in the accounts redesign (sub-project 3)."],
  dos: ["Show codes once, right after they are made, and say they won't be shown again."],
  donts: ["Don't send codes by email or show them again later."],
} satisfies ComponentPage;
```

`spinner.tsx`:

```tsx
import { Spinner } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Spinner",
  summary: "A small ring that turns while something loads, in three sizes.",
  examples: [
    { title: "small", node: <Spinner size="sm" label="loading" />, html: true },
    { title: "medium", node: <Spinner label="loading chats" />, html: true },
    { title: "large", node: <Spinner size="lg" label="checking your session" />, html: true },
  ],
  a11y: ["Each spinner is a role=\"status\" with a label.", "Under reduced motion it stops turning; the label still says what is happening."],
  dos: ["Pair a long wait with a StatusLine that says what is happening, and give up with a plain error after a timeout."],
  donts: ["Don't put several spinners in one view.", "Don't spin forever."],
} satisfies ComponentPage;
```

`status-line.tsx`:

```tsx
import { Button, StatusLine } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "StatusLine",
  summary: "One line of state with a glyph and a word: [ ok ], [wait], [fail] or [info].",
  examples: [
    { title: "ok", node: <StatusLine state="ok">online</StatusLine>, html: true },
    { title: "wait", node: <StatusLine state="wait" live>connecting…</StatusLine>, html: true },
    { title: "fail, with an action", node: <StatusLine state="fail" action={<Button size="sm">retry</Button>}>offline — check your connection</StatusLine> },
    { title: "info", node: <StatusLine state="info">no public service to check</StatusLine>, html: true },
  ],
  a11y: [
    "The bracketed tag is hidden from assistive tech and a word (ok, working, error, info) is read instead.",
    "fail is an alert; with live, the other states are a polite status.",
    "Colours come from the theme tokens, so every state passes AA in both themes.",
  ],
  dos: ["Say what is happening and what to do: \"[fail] offline — retry\"."],
  donts: ["Don't use it for long text.", "Don't use the terminal (ANSI) colours for it."],
} satisfies ComponentPage;
```

`theme-toggle.tsx`:

```tsx
import { ThemeToggle } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "ThemeToggle",
  summary: "A 44 px button that switches between the dark and light themes and remembers the choice.",
  examples: [{ title: "server render", note: "shows the dark-theme icon until it hydrates", node: <ThemeToggle /> }],
  a11y: ["Its name says what pressing it does: \"switch to light theme\" or \"switch to dark theme\".", "The choice is stored per site under mw-theme."],
  keys: [["Tab", "focuses it"], ["Enter or Space", "switches the theme"]],
  dos: ["Put it in the header, at the end."],
  donts: ["Don't hide the theme choice in a menu."],
} satisfies ComponentPage;
```

`toast-provider.tsx`:

```tsx
import type { ComponentPage } from "../types";

export default {
  name: "ToastProvider",
  summary: "Short notices that appear at the bottom of the screen and go away on their own; useToast() shows one.",
  examples: [],
  interactiveOnly: true,
  a11y: [
    "Toasts appear in a polite live region labelled \"notifications\".",
    "Variants differ by border colour only, and toasts can't be paused or dismissed yet (audit U-13); keep them short and never the only place an error is shown.",
  ],
  dos: ["Confirm something that just happened: \"message sent\"."],
  donts: ["Don't put actions or long text in a toast."],
} satisfies ComponentPage;
```

`wordmark.tsx`:

```tsx
import { Wordmark } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Wordmark",
  summary: "An app's name in VT323 with an underscore and a blinking block cursor.",
  examples: [
    { title: "meowerse", node: <Wordmark name="meowerse" />, html: true },
    { title: "meowsenger", node: <Wordmark name="meowsenger" />, html: true },
    { title: "auth", node: <Wordmark name="auth" />, html: true },
    { title: "as a home link", node: <Wordmark name="ui" href="/ui/" />, html: true },
  ],
  a11y: ["As a link, it is named \"<name> home\" and is 44 px tall.", "The cursor is aria-hidden and stops blinking under reduced motion."],
  dos: ["Use one wordmark per page, in the header or the hero."],
  donts: ["Don't set other text in VT323: its subset only has the wordmark letters."],
} satisfies ComponentPage;
```

- [ ] **Step 4: The docs nav gains components**

Replace `docsNav` in `apps/web/src/lib/docs-nav.ts`, and add the import at the top:

```ts
import { toSlug } from "./slug";

export function docsNav(componentNames: string[]): NavGroup[] {
  return [
    { label: "start", items: [{ label: "overview", href: "/ui/" }] },
    { label: "foundations", items: FOUNDATIONS },
    {
      label: "components",
      items: [
        { label: "all components", href: "/ui/components/" },
        ...[...componentNames].sort().map((n) => ({ label: n, href: `/ui/components/${toSlug(n)}/` })),
      ],
    },
    { label: "more", items: [{ label: "utilities", href: "/ui/utilities/" }] },
  ];
}
```

- [ ] **Step 5: Docs components**

`apps/web/src/components/docs/ReactNodeView.tsx`:

```tsx
import type { ReactNode } from "react";

/** Renders a prebuilt React element on the server (no hydration): the docs previews. */
export default function ReactNodeView({ node }: { node: ReactNode }) {
  return <>{node}</>;
}
```

`apps/web/src/components/docs/Preview.astro`:

```astro
---
// Every example of a component page, each in its own stage. [data-preview] marks library output
// (the site's 44 px target check skips it: ui's own geometry tests cover it).
import ReactNodeView from "./ReactNodeView";
import { nodeOf, type RegisteredPage } from "../../ui-docs/registry";
interface Props { page: RegisteredPage; scope: string }
const { page, scope } = Astro.props;
---
<div class="previews">
  {page.examples.map((ex) => (
    <figure class:list={["preview", (ex.wide || ex.snippet === false) && "preview--wide"]}>
      <div class="preview__stage" data-preview><ReactNodeView node={nodeOf(ex, scope)} /></div>
      <figcaption class="preview__title">{ex.title}{ex.note && <span class="mw-muted"> — {ex.note}</span>}</figcaption>
    </figure>
  ))}
</div>
```

`apps/web/src/components/docs/PropsTable.astro`:

```astro
---
import type { ComponentDoc } from "../../lib/ui-api";
interface Props { doc: ComponentDoc }
const { doc } = Astro.props;
---
{doc.props.length === 0 ? <p>No props of its own.</p> : (
  <div class="table-wrap" tabindex="0" role="region" aria-label={`${doc.name} props`}>
    <table class="table">
      <thead><tr><th scope="col">prop</th><th scope="col">type</th><th scope="col">default</th><th scope="col">required</th></tr></thead>
      <tbody>
        {doc.props.map((p) => (
          <tr>
            <td><code>{p.name}</code>{p.inherited && <span class="mw-muted"> (html)</span>}</td>
            <td><code>{p.type}</code>{p.description && <span class="mw-muted"> {p.description}</span>}</td>
            <td>{p.default ? <code>{p.default}</code> : "—"}</td>
            <td>{p.required ? "yes" : "no"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)}
{doc.inherits.length > 0 && (
  <p class="mw-muted">Also accepts the standard attributes from {doc.inherits.map((n, i) => <><code>{n}</code>{i < doc.inherits.length - 1 ? ", " : ""}</>)}.</p>
)}
```

`apps/web/src/components/docs/CssVarsTable.astro`:

```astro
---
import type { CssApi } from "../../lib/css-api";
interface Props { name: string; api: CssApi }
const { name, api } = Astro.props;
---
{api.vars.length === 0 ? <p>Its rules use no custom properties.</p> : (
  <div class="table-wrap" tabindex="0" role="region" aria-label={`${name} css custom properties`}>
    <table class="table">
      <thead><tr><th scope="col">variable</th><th scope="col">dark</th><th scope="col">light</th></tr></thead>
      <tbody>
        {api.vars.map((v) => (
          <tr>
            <td><code>{v.name}</code></td>
            <td>{v.dark ? <code>{v.dark}</code> : v.alias ? <><code>{v.alias}</code><span class="mw-muted"> (legacy alias)</span></> : "—"}</td>
            <td>{v.light ? <code>{v.light}</code> : v.dark ? <span class="mw-muted">same</span> : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)}
<p class="mw-muted">Classes: {api.classes.map((c, i) => <><code>{`.${c}`}</code>{i < api.classes.length - 1 ? ", " : ""}</>)}. Set any of these variables on an ancestor (or wrap a subtree in <code>.mw-theme--dark</code> / <code>.mw-theme--light</code>) to restyle just that part of a page.</p>
{api.declared.length > 0 && <p class="mw-muted">It declares: {api.declared.map((d) => <code>{d} </code>)}</p>}
```

- [ ] **Step 6: The pages**

`apps/web/src/pages/ui/components/index.astro`:

```astro
---
import DocsLayout from "../../../layouts/DocsLayout.astro";
import { COMPONENT_PAGES } from "../../../ui-docs/registry";
---
<DocsLayout title="components" description="Every @meowerse/ui component, each with live variants, props, CSS variables, snippets and accessibility notes.">
  <header class="docs-head">
    <h1 class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› </span>components</h1>
    <p class="lede">{COMPONENT_PAGES.length} components. Each page renders every variant and state with the real component.</p>
  </header>
  <ul class="cards component-list">
    {COMPONENT_PAGES.map((p) => (
      <li><a class="card-link" href={`/ui/components/${p.slug}/`}><span class="card-link__name">{p.name}</span><span class="card-link__sum">{p.summary}</span></a></li>
    ))}
  </ul>
</DocsLayout>
```

`apps/web/src/pages/ui/components/[slug].astro`:

```astro
---
import { renderToStaticMarkup } from "react-dom/server";
import { Kbd } from "@meowerse/ui";
import DocsLayout from "../../../layouts/DocsLayout.astro";
import CodeBlock from "../../../components/docs/CodeBlock.astro";
import Preview from "../../../components/docs/Preview.astro";
import PropsTable from "../../../components/docs/PropsTable.astro";
import CssVarsTable from "../../../components/docs/CssVarsTable.astro";
import { COMPONENT_PAGES, nodeOf, type RegisteredPage } from "../../../ui-docs/registry";
import { componentDoc, cssApi } from "../../../ui-docs/api";
import { toJsx } from "../../../lib/jsx";

export function getStaticPaths() {
  return COMPONENT_PAGES.map((page) => ({ params: { slug: page.slug }, props: { page } }));
}
interface Props { page: RegisteredPage }
const { page } = Astro.props;
const doc = componentDoc(page.name);
const css = cssApi(page.name);
const importLine = `import { ${page.name} } from "${page.from ?? "@meowerse/ui"}";`;
const usage = page.examples.map((ex, i) => {
  const node = nodeOf(ex, "snippet");
  return {
    i, title: ex.title,
    jsx: ex.snippet === false ? null : `${importLine}\n\n${toJsx(node)}`,
    html: ex.html ? renderToStaticMarkup(node) : null,
  };
}).filter((u) => u.jsx);
---
<DocsLayout title={page.name} description={`${page.name}: ${page.summary}`}>
  <header class="docs-head">
    <h1 class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› </span>{page.name}</h1>
    <p class="lede">{page.summary}</p>
    <p class="mw-muted"><code>{importLine}</code> · source <code>{`packages/ui/${doc.file}`}</code></p>
  </header>

  {page.examples.length > 0 && (
    <section class="docs-section" aria-labelledby="preview-title">
      <h2 id="preview-title">variants and states</h2>
      <Preview page={page} scope="page" />
    </section>
  )}

  <section class="docs-section" aria-labelledby="props-title">
    <h2 id="props-title">props</h2>
    <PropsTable doc={doc} />
  </section>

  <section class="docs-section" aria-labelledby="css-title">
    <h2 id="css-title">css custom properties</h2>
    <CssVarsTable name={page.name} api={css} />
  </section>

  {usage.length > 0 && (
    <section class="docs-section" aria-labelledby="usage-title">
      <h2 id="usage-title">usage</h2>
      {usage.map((u) => (
        <div class="docs-section">
          <h3>{u.title}</h3>
          <CodeBlock id={`ex-${u.i}-jsx`} lang="tsx" code={u.jsx!} />
          {u.html && <CodeBlock id={`ex-${u.i}-html`} lang="html (needs @meowerse/ui/tokens.css)" code={u.html} />}
        </div>
      ))}
    </section>
  )}

  <section class="docs-section" aria-labelledby="a11y-title">
    <h2 id="a11y-title">accessibility</h2>
    <ul class="docs-list">{page.a11y.map((t) => <li>{t}</li>)}</ul>
    {page.keys && (
      <div class="table-wrap" tabindex="0" role="region" aria-label={`${page.name} keyboard`}>
        <table class="table">
          <thead><tr><th scope="col">key</th><th scope="col">does</th></tr></thead>
          <tbody>{page.keys.map(([k, d]) => <tr><td><Kbd>{k}</Kbd></td><td>{d}</td></tr>)}</tbody>
        </table>
      </div>
    )}
  </section>

  <section class="docs-section" aria-labelledby="dodont-title">
    <h2 id="dodont-title">do and don't</h2>
    <div class="dodont">
      <div class="docs-section"><h3><span class="dd-tag dd-tag--do" aria-hidden="true">[ ok ] </span>do</h3><ul class="docs-list">{page.dos.map((t) => <li>{t}</li>)}</ul></div>
      <div class="docs-section"><h3><span class="dd-tag dd-tag--dont" aria-hidden="true">[fail] </span>don't</h3><ul class="docs-list">{page.donts.map((t) => <li>{t}</li>)}</ul></div>
    </div>
  </section>
</DocsLayout>
```

Append to `apps/web/src/styles/site.css`:

```css
/* ---- component pages ---- */
.previews { display: grid; gap: var(--sp-3); grid-template-columns: repeat(auto-fill, minmax(min(100%, 18rem), 1fr)); }
.preview { display: grid; gap: var(--sp-2); min-width: 0; margin: 0; }
.preview--wide { grid-column: 1 / -1; }
.preview__stage { position: relative; display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); min-width: 0; min-height: var(--sp-8); padding: var(--sp-4); background: var(--c-bg); border: 1px solid var(--c-line); border-radius: var(--r-l); }
.preview__stage > * { max-width: 100%; }
.preview__stage .mw-header { position: static; flex: 1 1 100%; }
.preview__stage .mw-footer { flex: 1 1 100%; margin-top: 0; }
.preview__title { font-size: var(--fs-2); color: var(--c-fg-muted); }
.dodont { display: grid; gap: var(--sp-4); }
@media (min-width: 760px) { .dodont { grid-template-columns: 1fr 1fr; } }
.dd-tag { font-weight: 700; white-space: pre; }
.dd-tag--do { color: var(--c-ok); }
.dd-tag--dont { color: var(--c-danger); }
.icon-grid { display: grid; gap: var(--sp-2); grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); width: 100%; margin: 0; padding: 0; list-style: none; }
.icon-grid li { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-2); }
```

- [ ] **Step 7: e2e**

`apps/web/tests/e2e/ui-components.spec.ts`:

```ts
import { test, expect } from "./fixtures";

test("every component has a page with props, css variables, a11y notes and do/don't", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/ui/components/");
  const links = page.locator(".component-list a");
  await expect(links).toHaveCount(26);
  for (const href of await links.evaluateAll((as) => as.map((a) => a.getAttribute("href")!))) {
    await page.goto(href);
    for (const id of ["props-title", "css-title", "a11y-title", "dodont-title"]) await expect(page.locator(`#${id}`), `${href} #${id}`).toBeVisible();
  }
});

test("Button: every variant and state previewed; the props table comes from the types", async ({ page }) => {
  await page.goto("/ui/components/button/");
  for (const v of ["primary", "secondary", "ghost", "danger"]) await expect(page.locator(`[data-preview] .mw-btn--${v}`).first()).toBeVisible();
  await expect(page.locator("[data-preview] .mw-btn:disabled")).not.toHaveCount(0);
  const variant = page.locator('section[aria-labelledby="props-title"] tr', { hasText: "variant" });
  await expect(variant).toContainText('"primary" | "secondary" | "ghost" | "danger"');
  await expect(variant).toContainText('"secondary"');
  await expect(page.locator('section[aria-labelledby="css-title"]')).toContainText("--control-height");
  await expect(page.locator('section[aria-labelledby="usage-title"] pre').first()).toContainText('import { Button } from "@meowerse/ui";');
});

test("static component pages ship no React", async ({ page }) => {
  for (const slug of ["badge", "status-line", "field"]) {
    await page.goto(`/ui/components/${slug}/`);
    await expect(page.locator("astro-island")).toHaveCount(0);
  }
});
```

- [ ] **Step 8: Run everything**

```bash
(cd apps/web && bunx vitest run --coverage)
bun run --filter @meowerse/web lint
bun run --filter @meowerse/web build
bun run --filter @meowerse/web e2e
```

Expected:
- all green;
- the sitemap has 41 pages;
- the site-wide axe, CSP and link specs cover every component page.

If axe flags a library component inside a preview, that is a real ui defect. Fix it in
`packages/ui` in this task with a ui unit test, or, if it belongs to a later sub-project's audit
IDs, record it in the component's `a11y` notes and in the PR's deferral list. Never exclude
previews from axe.

- [ ] **Step 9: Commit**

```bash
git add apps/web
git commit -m "feat(web): /ui component pages generated from the source

A page for each of the 26 @meowerse/ui components: every variant and state rendered by the real
component on the server, the props table from the TypeScript types, the CSS custom properties
its rules use with dark/light values, copyable React snippets serialised from the same elements
(and plain HTML where the markup works on its own), accessibility and keyboard notes, and do and
don't. A test fails when a new component ships without a page (spec §5.2, B12).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 9: Interactive demos, the side-by-side gallery, and the Modal hidden-control focus test (spec §3 gallery, §5.2; SP1 deferral: Modal `display:none`/`visibility:hidden`)

**Files:**
- Create:
  - demos in `apps/web/src/ui-docs/demos/`: `modal.tsx`, `confirm-dialog.tsx`,
    `toast-provider.tsx`, `prompt.tsx`, `code.tsx`, `recovery-codes.tsx`, `theme-toggle.tsx`,
    `app-header.tsx`, `auth-gate.tsx`, `radio-group.tsx`;
  - `apps/web/src/ui-docs/demos.ts` (+`demos.test.ts`);
  - `apps/web/src/components/docs/Demo.astro`;
  - `apps/web/src/pages/ui/gallery.astro`;
  - `apps/web/public/ui-demo/no-account/api/session`;
  - e2e tests in `apps/web/tests/e2e/`: `ui-demos.spec.ts`, `modal-focus.spec.ts`,
    `ui-gallery.spec.ts`.
- Modify: `apps/web/src/pages/ui/components/[slug].astro`, `apps/web/src/lib/docs-nav.ts` (+test),
  `apps/web/src/styles/site.css` (append "demos and gallery")

**Interfaces:**
- Consumes:
  - `COMPONENT_PAGES`, `Preview.astro`, `CodeBlock.astro`, `DocsLayout` (Tasks 7–8);
  - ui `Modal`, `ConfirmDialog`, `ToastProvider`/`useToast`, `Prompt`, `Code`, `RecoveryCodes`,
    `ThemeToggle`, `AppHeader`, `AuthGate`, `RadioGroup`, `Button`, `Field`, `Checkbox`, `Icon`.
- Produces:
  - `DEMO_SOURCES: Record<slug, string>` (each demo's own source, through `?raw`) and
    `DEMO_SLUGS: string[]`.
  - `Demo.astro`. Props: `{ slug: string }`. It hydrates the demo for that slug with `client:visible`.
    Islands take no children (Trusted Types: slot children hydrate through innerHTML).
  - Component pages gain a "try it" section (`#demo-title`) when a demo exists.
  - `/ui/gallery/`: one `section[data-shot=<slug>]` per component, showing its examples in
    `.mw-theme--dark` and `.mw-theme--light` side by side. Task 12's screenshots use it.
  - The class names `.chat`, `.chat__log` and `.bubble`/`.bubble--own`, reused by Task 11.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/ui-docs/demos.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEMO_SLUGS, DEMO_SOURCES } from "./demos";
import { COMPONENT_PAGES } from "./registry";

describe("interactive demos", () => {
  it("exist for exactly these components", () =>
    expect(DEMO_SLUGS).toEqual(["app-header", "auth-gate", "code", "confirm-dialog", "modal", "prompt", "radio-group", "recovery-codes", "theme-toggle", "toast-provider"]));
  it("cover every component that has nothing to show without interaction", () => {
    for (const p of COMPONENT_PAGES.filter((x) => x.interactiveOnly)) expect(DEMO_SLUGS, p.name).toContain(p.slug);
  });
  it("belong to real component pages and ship their own source", () => {
    const slugs = COMPONENT_PAGES.map((p) => p.slug);
    for (const s of DEMO_SLUGS) {
      expect(slugs).toContain(s);
      expect(DEMO_SOURCES[s]).toMatch(/export default function Demo\(\)/);
    }
  });
});
```

In `apps/web/src/lib/docs-nav.test.ts`, change the "ends with utilities" test to:

```ts
  it("ends with the gallery, then utilities", () =>
    expect(docsNav([]).at(-1)!.items).toEqual([{ label: "gallery", href: "/ui/gallery/" }, { label: "utilities", href: "/ui/utilities/" }]));
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/web && bunx vitest run src/ui-docs/demos.test.ts src/lib/docs-nav.test.ts`

Expected: FAIL (`./demos` missing; no gallery link).

- [ ] **Step 3: The demos**

Every demo is `export default function Demo()` with no props: an island that receives nothing, not
even children.

`apps/web/src/ui-docs/demos/modal.tsx`:

```tsx
import { useState } from "react";
import { Button, Checkbox, Field, Icon, Modal } from "@meowerse/ui";

// A rename dialog. While the name is empty, "clear" is visibility:hidden and "save" is disabled; the
// extra options are display:none until opened. Tab must skip all three (Modal's usable() rules).
export default function Demo() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [more, setMore] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const empty = name.trim() === "";
  const close = () => { setOpen(false); setMore(false); };
  return (
    <div className="demo">
      <Button onClick={() => setOpen(true)}>rename chat</Button>
      {saved !== null && <p role="status" className="demo__out">renamed to “{saved}”</p>}
      <Modal open={open} onClose={close} title="rename chat">
        <div className="demo-modal">
          <div className="demo-modal__row">
            <Field label="new name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" data-autofocus />
            <button type="button" aria-label="clear the name" className={empty ? "demo-modal__clear is-invisible" : "demo-modal__clear"} onClick={() => setName("")}>
              <Icon name="x" />
            </button>
          </div>
          <Button variant="ghost" aria-expanded={more} aria-controls="demo-more" onClick={() => setMore((m) => !m)}>{more ? "fewer options" : "more options"}</Button>
          <div id="demo-more" className={more ? "demo-modal__more" : "demo-modal__more is-collapsed"}>
            <Checkbox label="tell the members" />
          </div>
          {empty && <p className="mw-field__hint">type a name to save.</p>}
          <div className="mw-confirm__actions">
            <Button onClick={close}>cancel</Button>
            <Button variant="primary" disabled={empty} onClick={() => { setSaved(name.trim()); setName(""); close(); }}>save</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
```

`apps/web/src/ui-docs/demos/confirm-dialog.tsx`:

```tsx
import { useState } from "react";
import { Button, ConfirmDialog } from "@meowerse/ui";

// The phrase has capitals and an ampersand: it must be shown and matched exactly (U-31, B14).
export default function Demo() {
  const [open, setOpen] = useState<"phrase" | "password" | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <div className="demo">
      <div className="btn-row">
        <Button variant="danger" onClick={() => setOpen("phrase")}>delete “Cats &amp; Co”</Button>
        <Button onClick={() => setOpen("password")}>sign out everywhere</Button>
      </div>
      {done && <p role="status" className="demo__out">{done}</p>}
      <ConfirmDialog
        open={open === "phrase"} onCancel={() => setOpen(null)}
        onConfirm={() => { setOpen(null); setDone("deleted (not really: this is a demo)."); }}
        title="delete this group?" description="Everyone loses the chat history. This can't be undone."
        confirmLabel="delete group" confirmPhrase="Cats & Co"
      />
      <ConfirmDialog
        open={open === "password"} variant="primary" requirePassword onCancel={() => setOpen(null)}
        onConfirm={() => { setOpen(null); setDone("signed out everywhere (not really: this is a demo)."); }}
        title="sign out everywhere?" description="Every device signs out, this one included." confirmLabel="sign out"
      />
    </div>
  );
}
```

`apps/web/src/ui-docs/demos/toast-provider.tsx`:

```tsx
import { Button, ToastProvider, useToast } from "@meowerse/ui";

function Buttons() {
  const push = useToast();
  return (
    <div className="btn-row">
      <Button onClick={() => push({ message: "message sent", variant: "success", duration: 6000 })}>success</Button>
      <Button onClick={() => push({ message: "couldn't send — it will retry when you're back online", variant: "error", duration: 6000 })}>error</Button>
      <Button onClick={() => push({ message: "3 new messages", duration: 6000 })}>info</Button>
    </div>
  );
}

export default function Demo() {
  return <ToastProvider><Buttons /></ToastProvider>;
}
```

`apps/web/src/ui-docs/demos/prompt.tsx`:

```tsx
import { useRef, useState } from "react";
import { Prompt } from "@meowerse/ui";

type Msg = { id: number; text: string; own: boolean };

// A tiny composer: sends land in the log below, exactly as typed. Nothing leaves the page.
export default function Demo() {
  const [value, setValue] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([{ id: 1, text: "are we still on for tonight?", own: false }]);
  const seq = useRef(1);
  return (
    <div className="demo chat">
      <ol className="chat__log" aria-label="messages" aria-live="polite">
        {msgs.map((m) => <li key={m.id} className={m.own ? "bubble bubble--own" : "bubble"}>{m.text}</li>)}
      </ol>
      <Prompt label="message" value={value} onChange={setValue}
        onSubmit={(text) => { seq.current += 1; const id = seq.current; setMsgs((ms) => [...ms, { id, text, own: true }]); setValue(""); }} />
      <p className="mw-muted">Nothing leaves this page: messages stay in this demo.</p>
    </div>
  );
}
```

`apps/web/src/ui-docs/demos/code.tsx`:

```tsx
import { Code } from "@meowerse/ui";

export default function Demo() {
  return <p className="demo">your invite code: <Code value="k3m9-X2p4-q8w1" copy /></p>;
}
```

`apps/web/src/ui-docs/demos/recovery-codes.tsx`:

```tsx
import { RecoveryCodes } from "@meowerse/ui";

export default function Demo() {
  return <div className="demo"><RecoveryCodes codes={["b7qk-2m9x", "t4nw-8rd3", "h2vc-6yp1", "m9zs-4kt7", "q3lf-7bn2", "w8xd-1gj5", "e6pr-3hm8", "u1ty-9cs4"]} /></div>;
}
```

`apps/web/src/ui-docs/demos/theme-toggle.tsx`:

```tsx
import { ThemeToggle } from "@meowerse/ui";

export default function Demo() {
  return <div className="demo btn-row"><ThemeToggle /><span className="mw-muted">switches this whole site's theme, like the one in the header</span></div>;
}
```

`apps/web/src/ui-docs/demos/app-header.tsx`:

```tsx
import { useState } from "react";
import { AppHeader, RadioGroup, type Session } from "@meowerse/ui";

const SESSIONS: Record<string, Session> = {
  loading: { loading: true, authenticated: false },
  guest: { loading: false, authenticated: false },
  "signed-in": { loading: false, authenticated: true, username: "alxnko", verified: true },
  error: { loading: false, authenticated: false, error: "timeout" },
};

export default function Demo() {
  const [k, setK] = useState("guest");
  return (
    <div className="demo">
      <RadioGroup name="demo-session" legend="session" value={k} onChange={setK} options={[
        { label: "checking", value: "loading" }, { label: "signed out", value: "guest" },
        { label: "signed in", value: "signed-in" }, { label: "check failed", value: "error" },
      ]} />
      <div className="demo__frame"><AppHeader session={SESSIONS[k]!} /></div>
    </div>
  );
}
```

`apps/web/src/ui-docs/demos/auth-gate.tsx`:

```tsx
import { AuthGate } from "@meowerse/ui";

// Points at a static file that isn't an account service (public/ui-demo/no-account/api/session), so the
// session check fails honestly, and without a network error, and the gate shows its error state.
export default function Demo() {
  return (
    <div className="demo__frame">
      <AuthGate base="/ui-demo/no-account"><p>account settings</p></AuthGate>
    </div>
  );
}
```

`apps/web/src/ui-docs/demos/radio-group.tsx`:

```tsx
import { useState } from "react";
import { RadioGroup } from "@meowerse/ui";

export default function Demo() {
  const [v, setV] = useState("system");
  return (
    <div className="demo">
      <RadioGroup name="demo-theme" legend="theme" value={v} onChange={setV} options={[
        { label: "follow the system", value: "system" }, { label: "dark", value: "dark" }, { label: "light", value: "light", hint: "day paper" },
      ]} />
      <p role="status" className="demo__out">chosen: {v}</p>
    </div>
  );
}
```

Create `apps/web/public/ui-demo/no-account/api/session`. It has no extension, and its content is
this one line:

```
this is not an account service: the AuthGate demo on /ui/components/auth-gate/ reads this file to show its error state.
```

- [ ] **Step 4: Sources, the Demo component, the page section, the gallery**

`apps/web/src/ui-docs/demos.ts`:

```ts
// Each demo's own source, shown under it (Vite ?raw): the code on the page is the code that runs.
const raw = import.meta.glob<string>("./demos/*.tsx", { query: "?raw", import: "default", eager: true });

export const DEMO_SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(raw).map(([path, src]) => [path.replace(/^\.\/demos\//, "").replace(/\.tsx$/, ""), src]),
);
export const DEMO_SLUGS: string[] = Object.keys(DEMO_SOURCES).sort();
```

`apps/web/src/components/docs/Demo.astro`:

```astro
---
// Hydrated only when scrolled into view. Islands get no props and no children (Trusted Types).
import ModalDemo from "../../ui-docs/demos/modal";
import ConfirmDialogDemo from "../../ui-docs/demos/confirm-dialog";
import ToastDemo from "../../ui-docs/demos/toast-provider";
import PromptDemo from "../../ui-docs/demos/prompt";
import CodeDemo from "../../ui-docs/demos/code";
import RecoveryCodesDemo from "../../ui-docs/demos/recovery-codes";
import ThemeToggleDemo from "../../ui-docs/demos/theme-toggle";
import AppHeaderDemo from "../../ui-docs/demos/app-header";
import AuthGateDemo from "../../ui-docs/demos/auth-gate";
import RadioGroupDemo from "../../ui-docs/demos/radio-group";
interface Props { slug: string }
const { slug } = Astro.props;
---
{slug === "modal" && <ModalDemo client:visible />}
{slug === "confirm-dialog" && <ConfirmDialogDemo client:visible />}
{slug === "toast-provider" && <ToastDemo client:visible />}
{slug === "prompt" && <PromptDemo client:visible />}
{slug === "code" && <CodeDemo client:visible />}
{slug === "recovery-codes" && <RecoveryCodesDemo client:visible />}
{slug === "theme-toggle" && <ThemeToggleDemo client:visible />}
{slug === "app-header" && <AppHeaderDemo client:visible />}
{slug === "auth-gate" && <AuthGateDemo client:visible />}
{slug === "radio-group" && <RadioGroupDemo client:visible />}
```

In `apps/web/src/pages/ui/components/[slug].astro`:
- add these imports:

```astro
import Demo from "../../../components/docs/Demo.astro";
import { DEMO_SOURCES } from "../../../ui-docs/demos";
```

- insert this section right after the "variants and states" section:

```astro
  {DEMO_SOURCES[page.slug] && (
    <section class="docs-section" aria-labelledby="demo-title">
      <h2 id="demo-title">try it</h2>
      <div class="demo-stage" data-preview><Demo slug={page.slug} /></div>
      <details class="demo-source">
        <summary>demo source</summary>
        <CodeBlock id="demo-src" lang="tsx" code={DEMO_SOURCES[page.slug]!} />
      </details>
    </section>
  )}
```

`apps/web/src/pages/ui/gallery.astro`:

```astro
---
import DocsLayout from "../../layouts/DocsLayout.astro";
import Preview from "../../components/docs/Preview.astro";
import { COMPONENT_PAGES } from "../../ui-docs/registry";
---
<DocsLayout title="gallery" description="Every @meowerse/ui component in every state, dark and light side by side.">
  <header class="docs-head">
    <h1 class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› </span>gallery</h1>
    <p class="lede">Every component in every state, dark and light side by side, at whatever width you're reading on. The screenshot tests compare these sections at phone and desktop sizes.</p>
  </header>
  {COMPONENT_PAGES.map((p) => (
    <section class="docs-section gallery-item" id={p.slug} data-shot={p.slug} aria-labelledby={`g-${p.slug}`}>
      <h2 id={`g-${p.slug}`}><a href={`/ui/components/${p.slug}/`}>{p.name}</a></h2>
      {p.interactiveOnly ? (
        <p>Nothing to show without interaction: <a href={`/ui/components/${p.slug}/#demo-title`}>try it on its page</a>.</p>
      ) : (
        <div class="gallery-pair">
          <div class="mw-theme--dark gallery-theme"><p class="gallery-theme__label">dark</p><Preview page={p} scope="dark" /></div>
          <div class="mw-theme--light gallery-theme"><p class="gallery-theme__label">light</p><Preview page={p} scope="light" /></div>
        </div>
      )}
    </section>
  ))}
</DocsLayout>
```

In `apps/web/src/lib/docs-nav.ts`, replace the last group of `docsNav` with:

```ts
    { label: "more", items: [{ label: "gallery", href: "/ui/gallery/" }, { label: "utilities", href: "/ui/utilities/" }] },
```

Append to `apps/web/src/styles/site.css`:

```css
/* ---- demos and gallery ---- */
.demo { display: grid; gap: var(--sp-3); justify-items: start; }
.demo__out { font-size: var(--fs-2); color: var(--c-fg-muted); }
.demo__frame { position: relative; width: 100%; border: 1px solid var(--c-line); border-radius: var(--r-l); }
.demo__frame .mw-header { position: static; }
.demo-stage { padding: var(--sp-4); background: var(--c-bg); border: 1px solid var(--c-line); border-radius: var(--r-l); }
.demo-source summary { display: flex; align-items: center; min-height: var(--control-height); cursor: pointer; color: var(--c-fg-muted); font-size: var(--fs-2); }
.demo-modal { display: grid; gap: var(--sp-3); }
.demo-modal__row { display: flex; align-items: flex-end; gap: var(--sp-2); }
.demo-modal__row .mw-field { flex: 1; }
.demo-modal__clear { display: inline-flex; align-items: center; justify-content: center; flex: none; width: var(--control-height); height: var(--control-height); padding: 0; background: none; border: 1px solid var(--c-line); border-radius: var(--r-m); color: var(--c-fg-muted); cursor: pointer; }
.demo-modal__more { padding-left: var(--sp-2); }
.is-invisible { visibility: hidden; }
.is-collapsed { display: none; }
.chat { width: 100%; max-width: 36rem; justify-items: stretch; }
.chat__log { display: flex; flex-direction: column; gap: var(--sp-2); margin: 0; padding: 0; list-style: none; }
.bubble { align-self: flex-start; max-width: min(62ch, 85%); padding: var(--sp-2) var(--sp-3); background: var(--c-surface); border: 1px solid var(--c-line); border-radius: var(--r-l) var(--r-l) var(--r-l) var(--r-s); overflow-wrap: anywhere; white-space: pre-wrap; }
.bubble--own { align-self: flex-end; background: var(--c-bg-elev); border-color: var(--c-line-strong); border-radius: var(--r-l) var(--r-l) var(--r-s) var(--r-l); }
.bubble__meta { display: block; margin-top: var(--sp-1); font-size: var(--fs-1); color: var(--c-fg-subtle); }
.bubble__quote { display: block; margin-bottom: var(--sp-1); padding-left: var(--sp-2); border-left: 2px solid var(--c-line-input); font-size: var(--fs-2); color: var(--c-fg-muted); }
.gallery-item h2 a { display: inline-flex; align-items: center; min-height: var(--control-height); color: var(--c-fg); }
.gallery-pair { display: grid; gap: var(--sp-3); }
@media (min-width: 960px) { .gallery-pair { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
.gallery-theme { display: grid; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--c-line); border-radius: var(--r-l); }
.gallery-theme__label { font-size: var(--fs-1); color: var(--c-fg-subtle); }
.gallery-theme .previews { grid-template-columns: 1fr; }
```

- [ ] **Step 5: e2e**

`apps/web/tests/e2e/modal-focus.spec.ts`:

```ts
import { test, expect } from "./fixtures";

// SP1 deferral: Modal's usable() skips display:none and visibility:hidden controls. jsdom can't lay
// out, so this runs in a real browser against the Modal demo.
const focused = (page: import("@playwright/test").Page) => page.evaluate(() => {
  const a = document.activeElement as HTMLElement;
  return [a.tagName.toLowerCase(), a.getAttribute("type") ?? "", a.getAttribute("aria-label") ?? a.textContent?.trim() ?? ""].join(":");
});

test("focus skips invisible and collapsed controls, follows them when they appear, and returns to the trigger", async ({ page }) => {
  await page.goto("/ui/components/modal/");
  const trigger = page.getByRole("button", { name: "rename chat" });
  await trigger.scrollIntoViewIfNeeded();
  await expect(page.locator("astro-island[ssr]")).toHaveCount(0, { timeout: 15_000 });
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "rename chat" })).toBeVisible();
  expect(await focused(page)).toBe("input:text:");

  const tabs = async (n: number, shift = false) => {
    const seen: string[] = [];
    for (let i = 0; i < n; i++) { await page.keyboard.press(shift ? "Shift+Tab" : "Tab"); seen.push(await focused(page)); }
    return seen;
  };
  // empty name: "clear" is visibility:hidden, "save" disabled, the options display:none
  expect(await tabs(3)).toEqual(["button::more options", "button::cancel", "input:text:"]);
  expect(await tabs(1, true)).toEqual(["button::cancel"]);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab"); // back on the name field
  await page.keyboard.type("Cats & Co");
  expect(await tabs(5)).toEqual(["button:button:clear the name", "button::more options", "button::cancel", "button::save", "input:text:"]);
  await page.getByRole("button", { name: "more options" }).click();
  expect(await tabs(1)).toEqual(["input:checkbox:"]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByLabel("new name").fill("Cats & Co");
  await page.getByRole("button", { name: "save" }).click();
  await expect(page.locator(".demo__out")).toHaveText("renamed to “Cats & Co”");
});
```

`apps/web/tests/e2e/ui-demos.spec.ts`:

```ts
import { test, expect } from "./fixtures";

async function hydrated(page: import("@playwright/test").Page, selector: string) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  await expect(page.locator("astro-island[ssr]")).toHaveCount(0, { timeout: 15_000 });
}

test("ConfirmDialog: the phrase must match exactly, and the reason shows until it does", async ({ page }) => {
  await page.goto("/ui/components/confirm-dialog/");
  await hydrated(page, "#demo-title");
  await page.getByRole("button", { name: "delete “Cats & Co”" }).click();
  const dialog = page.getByRole("dialog", { name: "delete this group?" });
  await expect(dialog.locator("code")).toHaveText("Cats & Co");
  const confirm = dialog.getByRole("button", { name: "delete group" });
  await dialog.getByRole("textbox").fill("cats & co");
  await expect(confirm).toBeDisabled();
  await expect(dialog).toContainText("doesn't match yet");
  await dialog.getByRole("textbox").fill("Cats & Co");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.locator(".demo__out")).toHaveText("deleted (not really: this is a demo).");
});

test("Toast: a pushed toast shows in the notifications region", async ({ page }) => {
  await page.goto("/ui/components/toast-provider/");
  await hydrated(page, "#demo-title");
  await page.getByRole("button", { name: "success" }).click();
  await expect(page.getByRole("region", { name: "notifications" })).toContainText("message sent");
});

test("AuthGate: a failing session check is an error with a retry, never a redirect", async ({ page }) => {
  await page.goto("/ui/components/auth-gate/");
  await hydrated(page, "#demo-title");
  const demo = page.locator(".demo-stage");
  await expect(demo).toContainText("the account service had a problem.");
  await expect(demo.getByRole("button", { name: "try again" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/ui/components/auth-gate/");
});

test("Prompt: sends exactly what was typed; Enter sends on desktop, the button sends on phones", async ({ page }, info) => {
  await page.goto("/ui/components/prompt/");
  await hydrated(page, "#demo-title");
  const box = page.locator(".demo-stage textarea");
  await box.fill("hello ПРИВЕТ Cats");
  if (info.project.name === "desktop") await box.press("Enter");
  else { await box.press("Enter"); await expect(box).toHaveValue("hello ПРИВЕТ Cats\n"); await page.locator(".demo-stage .mw-prompt__send").click(); }
  await expect(page.locator(".bubble--own").last()).toHaveText("hello ПРИВЕТ Cats");
});

test("AppHeader: the session switch drives the header", async ({ page }) => {
  await page.goto("/ui/components/app-header/");
  await hydrated(page, "#demo-title");
  await page.locator(".demo-stage").getByRole("radio", { name: "signed in" }).check();
  await expect(page.locator(".demo-stage .mw-header")).toContainText("alxnko");
});
```

`apps/web/tests/e2e/ui-gallery.spec.ts`:

```ts
import { test, expect } from "./fixtures";

test("the gallery shows every component, each state in dark and light side by side", async ({ page }) => {
  await page.goto("/ui/gallery/");
  await expect(page.locator("[data-shot]")).toHaveCount(26);
  for (const slug of ["button", "status-line", "field", "prompt"]) {
    const s = page.locator(`[data-shot="${slug}"]`);
    await expect(s.locator(".mw-theme--dark .preview")).not.toHaveCount(0);
    expect(await s.locator(".mw-theme--dark .preview").count()).toBe(await s.locator(".mw-theme--light .preview").count());
  }
  const bg = (sel: string) => page.locator(`[data-shot="button"] ${sel} .preview__stage`).first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await bg(".mw-theme--dark")).not.toBe(await bg(".mw-theme--light"));
  await expect(page.locator("astro-island")).toHaveCount(0);
});
```

- [ ] **Step 6: Run everything**

```bash
(cd apps/web && bunx vitest run --coverage)
bun run --filter @meowerse/web lint
bun run --filter @meowerse/web build
bun run --filter @meowerse/web e2e
```

Expected: all green, and the sitemap has 42 pages. The site-wide CSP spec hydrates every demo and
must see no Trusted Types violation. If a demo trips one, the demo, or the ui component it renders,
has a raw-HTML sink; fix the sink, never the policy.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): interactive demos, the side-by-side gallery, and the Modal hidden-control test

Ten demos hydrate on scroll with no props or children (Trusted Types): dialogs, toasts, the
composer, copy, the header's session states, AuthGate's honest error. Each shows its own
source. /ui/gallery renders every component's states dark and light side by side (spec §3).
A Playwright test proves Modal's focus trap skips display:none and visibility:hidden controls
and returns focus to the trigger (SP1 deferral).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: The playground island: props and token overrides in the URL (spec §5.2 "Playground")

**Files:**
- Create:
  - `apps/web/src/lib/playground-state.ts` (+`.test.ts`);
  - `apps/web/src/lib/island-watchdog.ts` (+`.test.ts`);
  - `apps/web/src/ui-docs/playground/seeds.ts`, `apps/web/src/ui-docs/playground/playable.tsx`,
    `apps/web/src/ui-docs/playground/Playground.tsx`, `apps/web/src/ui-docs/playground/playable.test.ts`;
  - `apps/web/src/pages/ui/playground.astro`;
  - `apps/web/tests/e2e/playground.spec.ts`.
- Modify: `apps/web/src/lib/docs-nav.ts` (+test), `apps/web/src/styles/site.css` (append
  "playground")

**Interfaces:**
- Consumes: `ComponentDoc` and `componentDoc()` (Task 6); `toJsx` (Task 6); `setStatus` (Task 4);
  ui `contrast`, `Button`, `Checkbox`, `Field`, `RadioGroup`, `StatusLine`, `tokens.json`.
- Produces:
  - Types:
    - `PropSpec = { name; kind: "enum" | "boolean" | "text" | "number"; values?: string[]; default: Scalar; required: boolean }`;
    - `PlayComponent = { name; props: PropSpec[] }`;
    - `Overrides = { theme: "system" | "dark" | "light"; accent: "green" | "blue" | "amber"; radius: 0 | 1 | 2; density: "compact" | "normal" | "comfy" }`;
    - `PlayState = { c: string; props: Record<string, Scalar>; o: Overrides }`.
  - Functions:
    - `specsFromDoc(doc, seed)`;
    - `parseState(search, comps)`, `serializeState(state, comps)`;
    - `overrideVars(o)`, `overrideCss(o)`, `themeClass(theme)`;
    - `elementProps(comp, state)`.
  - Constants: `OVERRIDABLE`, `ACCENTS`, `DEFAULT_OVERRIDES`.
  - `watchIsland(root, timeoutMs?)`.
  - The URL format:
    - `?c=<component, lowercased>`;
    - `&p.<prop>=<value>`, where booleans are 1/0;
    - `&theme=`, `&accent=`, `&radius=0|2`, `&density=`.
    - Only values that differ from the defaults are written.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/playground-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import tokens from "@meowerse/ui/tokens.json";
import type { ComponentDoc } from "./ui-api";
import {
  DEFAULT_OVERRIDES, elementProps, OVERRIDABLE, overrideCss, overrideVars, parseState, serializeState, specsFromDoc, themeClass,
  type PlayComponent,
} from "./playground-state";

const doc: ComponentDoc = {
  name: "Button", file: "src/components/Button.tsx", inherits: ["ButtonHTMLAttributes"],
  props: [
    { name: "variant", type: '"primary" | "secondary"', values: ["primary", "secondary"], required: false, default: '"secondary"' },
    { name: "loading", type: "boolean", required: false, default: "false" },
    { name: "maxRows", type: "number", required: false, default: "6" },
    { name: "onPick", type: "() => void", required: false },
    { name: "className", type: "string", required: false },
    { name: "type", type: "string", required: false, default: '"text"', inherited: true },
  ],
};
const comps: PlayComponent[] = [{ name: "Button", props: specsFromDoc(doc, { children: "save" }) }, { name: "Badge", props: specsFromDoc({ ...doc, name: "Badge" }, {}) }];

describe("playground state", () => {
  it("builds controls from the extracted props; functions, className and inherited props are left out; seeds add children", () =>
    expect(comps[0]!.props).toEqual([
      { name: "variant", kind: "enum", values: ["primary", "secondary"], default: "secondary", required: false },
      { name: "loading", kind: "boolean", values: undefined, default: false, required: false },
      { name: "maxRows", kind: "number", values: undefined, default: 6, required: false },
      { name: "children", kind: "text", default: "save", required: true },
    ]));
  it("reads a URL, ignoring anything invalid", () => {
    const s = parseState("?c=button&p.variant=primary&p.loading=1&p.maxRows=3&p.children=send&theme=light&accent=blue&radius=2&density=comfy", comps);
    expect(s).toEqual({ c: "Button", props: { variant: "primary", loading: true, maxRows: 3, children: "send" }, o: { theme: "light", accent: "blue", radius: 2, density: "comfy" } });
    const bad = parseState("?c=nope&p.variant=hack&p.loading=yes&p.maxRows=x&theme=pink&radius=9", comps);
    expect(bad).toEqual({ c: "Button", props: { variant: "secondary", loading: false, maxRows: 6, children: "save" }, o: DEFAULT_OVERRIDES });
  });
  it("writes only what differs from the defaults, and round-trips", () => {
    const s = parseState("?c=button&p.variant=primary&radius=0", comps);
    expect(serializeState(s, comps)).toBe("?c=button&p.variant=primary&radius=0");
    expect(parseState(serializeState(s, comps), comps)).toEqual(s);
    expect(serializeState(parseState("", comps), comps)).toBe("?c=button");
  });
  it("passes required props always and others only when set", () =>
    expect(elementProps(comps[0]!, parseState("?c=button&p.variant=primary", comps))).toEqual({ variant: "primary", children: "save" }));
  it("turns overrides into scoped custom properties from the tokens", () => {
    expect(overrideVars(DEFAULT_OVERRIDES)).toEqual({});
    const v = overrideVars({ theme: "dark", accent: "amber", radius: 2, density: "compact" });
    expect(v["--c-accent-fill"]).toBe(tokens.semantic.dark.warn);
    expect(v["--r-m"]).toBe(`${tokens.radius.m * 2}px`);
    expect(v["--sp-4"]).toBe(`${tokens.space[4]! * 0.75}px`);
    for (const k of Object.keys(v)) expect(OVERRIDABLE).toContain(k);
    expect(overrideCss(DEFAULT_OVERRIDES)).toBe("");
    expect(overrideCss({ ...DEFAULT_OVERRIDES, radius: 0 })).toBe(".my-scope {\n  --r-s: 0px;\n  --r-m: 0px;\n  --r-l: 0px;\n}");
    expect(themeClass("system")).toBeUndefined();
    expect(themeClass("light")).toBe("mw-theme--light");
  });
});
```

`apps/web/src/lib/island-watchdog.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchIsland } from "./island-watchdog";

afterEach(() => vi.useRealTimers());

function root() {
  const r = document.createElement("div");
  const p = document.createElement("p");
  p.className = "mw-status mw-status--wait";
  for (const c of ["mw-status__tag", "sr-only", "mw-status__text"]) { const s = document.createElement("span"); s.className = c; p.append(s); }
  r.append(p);
  return r;
}

describe("watchIsland (B9: a lazy chunk that never arrives)", () => {
  it("turns the wait into a plain error with a way out", () => {
    vi.useFakeTimers();
    const r = root();
    watchIsland(r, 100);
    vi.advanceTimersByTime(100);
    expect(r.querySelector(".mw-status")).toHaveProperty("className", "mw-status mw-status--fail");
    expect(r.querySelector(".mw-status__text")!.textContent).toBe("the playground didn't load. reload the page to try again.");
  });
  it("stays quiet once the island says it's ready, or when cancelled", () => {
    vi.useFakeTimers();
    const r = root();
    watchIsland(r, 100);
    r.setAttribute("data-ready", "");
    vi.advanceTimersByTime(100);
    expect(r.querySelector(".mw-status")!.className).toContain("mw-status--wait");
    const r2 = root();
    watchIsland(r2, 100)();
    vi.advanceTimersByTime(100);
    expect(r2.querySelector(".mw-status")!.className).toContain("mw-status--wait");
  });
});
```

`apps/web/src/ui-docs/playground/playable.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PLAYABLE } from "./playable";
import { SEEDS } from "./seeds";

describe("playground registry", () => {
  it("has a component for every seed and nothing else", () => expect(Object.keys(PLAYABLE).sort()).toEqual(Object.keys(SEEDS).sort()));
});
```

In `apps/web/src/lib/docs-nav.test.ts`, change the last-group test to:

```ts
  it("ends with the playground, the gallery, then utilities", () =>
    expect(docsNav([]).at(-1)!.items.map((i) => i.href)).toEqual(["/ui/playground/", "/ui/gallery/", "/ui/utilities/"]));
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/web && bunx vitest run src/lib/playground-state.test.ts src/lib/island-watchdog.test.ts src/ui-docs/playground src/lib/docs-nav.test.ts`

Expected: FAIL (modules missing).

- [ ] **Step 3: State, watchdog, seeds, registry**

`apps/web/src/lib/playground-state.ts`:

```ts
// Playground state (spec §5.2): component, props and token overrides, all in the URL, never on a server.
// The controls come from the extracted TypeScript props (ui-api.ts), so they can't drift either.
import tokens from "@meowerse/ui/tokens.json";
import type { ComponentDoc } from "./ui-api";

export type Scalar = string | boolean | number;
export type PropSpec = { name: string; kind: "enum" | "boolean" | "text" | "number"; values?: string[]; default: Scalar; required: boolean };
export type PlayComponent = { name: string; props: PropSpec[] };
export type Theme = "system" | "dark" | "light";
export type Accent = "green" | "blue" | "amber";
export type Density = "compact" | "normal" | "comfy";
export type Overrides = { theme: Theme; accent: Accent; radius: 0 | 1 | 2; density: Density };
export type PlayState = { c: string; props: Record<string, Scalar>; o: Overrides };

export const DEFAULT_OVERRIDES: Overrides = { theme: "system", accent: "green", radius: 1, density: "normal" };
/** Fill presets from the tokens; on-accent text stays AA on each (the playground shows the ratio). */
export const ACCENTS: Record<Accent, string> = { green: tokens.semantic.dark.accentFill, blue: tokens.semantic.dark.info, amber: tokens.semantic.dark.warn };
const DENSITY: Record<Density, number> = { compact: 0.75, normal: 1, comfy: 1.25 };
const THEMES = ["system", "dark", "light"] as const;
const ACCENT_KEYS = ["green", "blue", "amber"] as const;
const DENSITIES = ["compact", "normal", "comfy"] as const;

export const OVERRIDABLE: readonly string[] = [
  "--c-accent-fill",
  ...Object.keys(tokens.radius).map((k) => `--r-${k}`),
  ...tokens.space.slice(1).map((_, i) => `--sp-${i + 1}`),
];

function parseDefault(raw: string | undefined, kind: PropSpec["kind"]): Scalar | undefined {
  if (raw === undefined) return undefined;
  if (kind === "boolean") return raw === "true";
  if (kind === "number") return Number(raw);
  return raw.replace(/^["'`]|["'`]$/g, "");
}

/** string-literal union → select, boolean → checkbox, number → number, string/ReactNode → text. Seeds set
 * starting values, and a seed for a prop the component inherits (like children) adds a required text control. */
export function specsFromDoc(doc: ComponentDoc, seed: Record<string, Scalar>): PropSpec[] {
  const out: PropSpec[] = [];
  for (const p of doc.props) {
    if (p.inherited || p.name === "className") continue;
    const kind: PropSpec["kind"] | null = p.values ? "enum"
      : p.type === "boolean" ? "boolean"
        : p.type === "number" ? "number"
          : p.type === "string" || p.type === "ReactNode" ? "text" : null;
    if (!kind) continue;
    const fallback: Scalar = kind === "enum" ? p.values![0]! : kind === "boolean" ? false : kind === "number" ? 0 : "";
    out.push({ name: p.name, kind, values: p.values, default: seed[p.name] ?? parseDefault(p.default, kind) ?? fallback, required: p.required });
  }
  for (const [name, v] of Object.entries(seed))
    if (!out.some((s) => s.name === name)) out.push({ name, kind: "text", default: v, required: true });
  return out;
}

function coerce(spec: PropSpec, raw: string): Scalar | undefined {
  switch (spec.kind) {
    case "enum": return spec.values!.includes(raw) ? raw : undefined;
    case "boolean": return raw === "1" ? true : raw === "0" ? false : undefined;
    case "number": { const n = Number(raw); return raw !== "" && Number.isFinite(n) ? n : undefined; }
    case "text": return raw.slice(0, 200);
  }
}

export function parseState(search: string, comps: PlayComponent[]): PlayState {
  const q = new URLSearchParams(search);
  const comp = comps.find((c) => c.name.toLowerCase() === (q.get("c") ?? "").toLowerCase()) ?? comps[0]!;
  const props: Record<string, Scalar> = {};
  for (const spec of comp.props) {
    const raw = q.get(`p.${spec.name}`);
    props[spec.name] = (raw === null ? undefined : coerce(spec, raw)) ?? spec.default;
  }
  const pick = <T extends string>(key: string, ok: readonly T[], d: T): T => { const v = q.get(key); return v !== null && (ok as readonly string[]).includes(v) ? (v as T) : d; };
  const r = q.get("radius");
  return {
    c: comp.name, props,
    o: {
      theme: pick("theme", THEMES, DEFAULT_OVERRIDES.theme),
      accent: pick("accent", ACCENT_KEYS, DEFAULT_OVERRIDES.accent),
      radius: r === "0" ? 0 : r === "2" ? 2 : 1,
      density: pick("density", DENSITIES, DEFAULT_OVERRIDES.density),
    },
  };
}

export function serializeState(s: PlayState, comps: PlayComponent[]): string {
  const comp = comps.find((c) => c.name === s.c) ?? comps[0]!;
  const q = new URLSearchParams({ c: comp.name.toLowerCase() });
  for (const spec of comp.props) {
    const v = s.props[spec.name];
    if (v === undefined || v === spec.default) continue;
    q.set(`p.${spec.name}`, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  }
  for (const k of ["theme", "accent", "density"] as const) if (s.o[k] !== DEFAULT_OVERRIDES[k]) q.set(k, s.o[k]);
  if (s.o.radius !== DEFAULT_OVERRIDES.radius) q.set("radius", String(s.o.radius));
  return `?${q.toString()}`;
}

/** What the preview element receives: required props always, others only when they differ from the default. */
export function elementProps(comp: PlayComponent, s: PlayState): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const spec of comp.props) {
    const v = s.props[spec.name];
    if (v === undefined || v === "") continue;
    if (spec.required || v !== spec.default) out[spec.name] = v;
  }
  return out;
}

export function overrideVars(o: Overrides): Record<string, string> {
  const out: Record<string, string> = {};
  if (o.accent !== "green") out["--c-accent-fill"] = ACCENTS[o.accent];
  if (o.radius !== 1) for (const [k, v] of Object.entries(tokens.radius)) out[`--r-${k}`] = `${v * o.radius}px`;
  if (o.density !== "normal") tokens.space.slice(1).forEach((v, i) => { out[`--sp-${i + 1}`] = `${v * DENSITY[o.density]}px`; });
  return out;
}

/** The overrides as a CSS rule to paste (scoped to a wrapper of your choice). */
export function overrideCss(o: Overrides): string {
  const lines = Object.entries(overrideVars(o)).map(([k, v]) => `  ${k}: ${v};`);
  return lines.length ? `.my-scope {\n${lines.join("\n")}\n}` : "";
}

export const themeClass = (t: Theme): string | undefined => (t === "system" ? undefined : `mw-theme--${t}`);
```

`apps/web/src/lib/island-watchdog.ts`:

```ts
// B9: a lazy island whose chunk never arrives becomes a plain error with a way out, not an endless wait.
import { setStatus } from "./status-dom";

export const ISLAND_TIMEOUT_MS = 10_000;

/** The island sets data-ready on `root` once mounted; otherwise the root's StatusLine turns into an error. */
export function watchIsland(root: HTMLElement, timeoutMs = ISLAND_TIMEOUT_MS): () => void {
  const t = setTimeout(() => {
    if (root.hasAttribute("data-ready")) return;
    const p = root.querySelector<HTMLElement>(".mw-status");
    if (p) setStatus(p, "fail", "the playground didn't load. reload the page to try again.");
  }, timeoutMs);
  return () => clearTimeout(t);
}
```

`apps/web/src/ui-docs/playground/seeds.ts`:

```ts
import type { Scalar } from "../../lib/playground-state";

/** Components in the playground and their starting values (plain data: the server builds the controls from it). */
export const SEEDS: Record<string, Record<string, Scalar>> = {
  Button: { children: "save" },
  Badge: { children: "verified" },
  Alert: { children: "wrong password — try again or reset it." },
  StatusLine: { children: "connecting…" },
  Field: { label: "username" },
  Checkbox: { label: "remember this device" },
  Card: { title: "profile", children: "signed in as alxnko." },
  Avatar: { name: "alxnko" },
  Spinner: {},
  Kbd: { children: "Enter" },
  Wordmark: {},
  Code: { value: "meow.alxnko.dev" },
  Prompt: { label: "message", value: "see you at 7" },
};
```

`apps/web/src/ui-docs/playground/playable.tsx`:

```tsx
// Client side of the playground: the real components, plus props the controls can't set (handlers).
import type { ComponentType } from "react";
import { Alert, Avatar, Badge, Button, Card, Checkbox, Code, Field, Kbd, Prompt, Spinner, StatusLine, Wordmark } from "@meowerse/ui";

const noop = () => {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a heterogeneous registry of components
export type Playable = { component: ComponentType<any>; fixed?: Record<string, unknown> };

export const PLAYABLE: Record<string, Playable> = {
  Button: { component: Button }, Badge: { component: Badge }, Alert: { component: Alert },
  StatusLine: { component: StatusLine }, Field: { component: Field }, Checkbox: { component: Checkbox },
  Card: { component: Card }, Avatar: { component: Avatar }, Spinner: { component: Spinner }, Kbd: { component: Kbd },
  Wordmark: { component: Wordmark }, Code: { component: Code },
  Prompt: { component: Prompt, fixed: { onChange: noop, onSubmit: noop } },
};
```

In `apps/web/src/lib/docs-nav.ts`, replace the last group with:

```ts
    { label: "more", items: [{ label: "playground", href: "/ui/playground/" }, { label: "gallery", href: "/ui/gallery/" }, { label: "utilities", href: "/ui/utilities/" }] },
```

- [ ] **Step 4: The island and the page**

`apps/web/src/ui-docs/playground/Playground.tsx`:

```tsx
// The playground island (client:only). Props and token overrides live in the URL (replaceState), the
// overrides are set on the preview element through the CSSOM (never a style attribute, CSP), and
// nothing is ever sent anywhere.
import { createElement, useEffect, useRef, useState } from "react";
import { Button, Checkbox, Field, RadioGroup, contrast } from "@meowerse/ui";
import tokens from "@meowerse/ui/tokens.json";
import { toJsx } from "../../lib/jsx";
import {
  ACCENTS, DEFAULT_OVERRIDES, elementProps, OVERRIDABLE, overrideCss, overrideVars, parseState, serializeState, themeClass,
  type Accent, type Density, type Overrides, type PlayComponent, type PlayState, type Scalar, type Theme,
} from "../../lib/playground-state";
import { PLAYABLE } from "./playable";

export default function Playground({ components }: { components: PlayComponent[] }) {
  const [state, setState] = useState<PlayState>(() => parseState(location.search, components));
  const [note, setNote] = useState("");
  const stage = useRef<HTMLDivElement>(null);
  const comp = components.find((c) => c.name === state.c) ?? components[0]!;
  const play = PLAYABLE[comp.name]!;

  useEffect(() => { history.replaceState(history.state, "", `${location.pathname}${serializeState(state, components)}`); }, [state, components]);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    for (const k of OVERRIDABLE) el.style.removeProperty(k);
    for (const [k, v] of Object.entries(overrideVars(state.o))) el.style.setProperty(k, v);
  }, [state.o]);
  useEffect(() => { stage.current?.closest("[data-playground]")?.setAttribute("data-ready", ""); }, []);

  const setProp = (name: string, v: Scalar) => setState((s) => ({ ...s, props: { ...s.props, [name]: v } }));
  const setO = <K extends keyof Overrides>(k: K, v: Overrides[K]) => setState((s) => ({ ...s, o: { ...s.o, [k]: v } }));
  const pick = (name: string) => {
    const next = components.find((c) => c.name === name)!;
    setState((s) => ({ c: name, props: Object.fromEntries(next.props.map((p) => [p.name, p.default])), o: s.o }));
  };
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(location.href); setNote("link copied"); }
    catch { setNote("couldn't copy — copy the address bar instead"); }
  };

  const element = createElement(play.component, { ...elementProps(comp, state), ...play.fixed });
  const css = overrideCss(state.o);
  const snippet = `import { ${comp.name} } from "@meowerse/ui";\n\n${toJsx(element)}${css ? `\n\n/* the token overrides, scoped to a wrapper */\n${css}` : ""}`;

  return (
    <div className="pg">
      <div className="pg__controls">
        <label className="pg-select"><span>component</span>
          <select value={comp.name} onChange={(e) => pick(e.target.value)}>{components.map((c) => <option key={c.name}>{c.name}</option>)}</select>
        </label>
        <fieldset className="pg__group">
          <legend>props</legend>
          {comp.props.map((p) => p.kind === "enum" ? (
            <label key={p.name} className="pg-select"><span>{p.name}</span>
              <select value={String(state.props[p.name])} onChange={(e) => setProp(p.name, e.target.value)}>{p.values!.map((v) => <option key={v}>{v}</option>)}</select>
            </label>
          ) : p.kind === "boolean" ? (
            <Checkbox key={p.name} label={p.name} checked={state.props[p.name] === true} onChange={(e) => setProp(p.name, e.target.checked)} />
          ) : (
            <Field key={p.name} label={p.name} type={p.kind === "number" ? "number" : "text"} value={String(state.props[p.name] ?? "")}
              onChange={(e) => setProp(p.name, p.kind === "number" ? Number(e.target.value) : e.target.value)} />
          ))}
        </fieldset>
        <fieldset className="pg__group">
          <legend>tokens (this preview only)</legend>
          <RadioGroup name="pg-theme" legend="theme" value={state.o.theme} onChange={(v) => setO("theme", v as Theme)}
            options={[{ label: "follow the system", value: "system" }, { label: "dark", value: "dark" }, { label: "light", value: "light" }]} />
          <RadioGroup name="pg-accent" legend="accent fill" value={state.o.accent} onChange={(v) => setO("accent", v as Accent)}
            options={(Object.keys(ACCENTS) as Accent[]).map((a) => ({ label: a, value: a, hint: `text on it: ${contrast(tokens.semantic.dark.onAccent, ACCENTS[a]).toFixed(1)}:1` }))} />
          <RadioGroup name="pg-radius" legend="radius scale" value={String(state.o.radius)} onChange={(v) => setO("radius", Number(v) as 0 | 1 | 2)}
            options={[{ label: "sharp (×0)", value: "0" }, { label: "default (×1)", value: "1" }, { label: "round (×2)", value: "2" }]} />
          <RadioGroup name="pg-density" legend="density" value={state.o.density} onChange={(v) => setO("density", v as Density)}
            options={[{ label: "compact", value: "compact" }, { label: "normal", value: "normal" }, { label: "comfy", value: "comfy" }]} />
          <Button onClick={() => setState((s) => ({ ...s, o: DEFAULT_OVERRIDES }))}>reset tokens</Button>
        </fieldset>
      </div>
      <div className="pg__out">
        <div ref={stage} className={["pg__stage", themeClass(state.o.theme)].filter(Boolean).join(" ")} data-preview>{element}</div>
        <p className="mw-muted">Overrides apply to this preview only and live in the address, never on a server.</p>
        <pre className="pg__code" tabIndex={0}><code>{snippet}</code></pre>
        <div className="btn-row">
          <Button onClick={() => void copyLink()}>copy a link to this setup</Button>
          <span role="status" className="mw-muted">{note}</span>
        </div>
      </div>
    </div>
  );
}
```

`apps/web/src/pages/ui/playground.astro`:

```astro
---
import { StatusLine } from "@meowerse/ui";
import DocsLayout from "../../layouts/DocsLayout.astro";
import Playground from "../../ui-docs/playground/Playground";
import { componentDoc } from "../../ui-docs/api";
import { SEEDS } from "../../ui-docs/playground/seeds";
import { specsFromDoc, type PlayComponent } from "../../lib/playground-state";

const components: PlayComponent[] = Object.entries(SEEDS).map(([name, seed]) => ({ name, props: specsFromDoc(componentDoc(name), seed) }));
---
<DocsLayout title="playground" description="Change a component's props, the theme and the tokens live, and copy the resulting snippet. Everything stays in the URL.">
  <header class="docs-head">
    <h1 class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› </span>playground</h1>
    <p class="lede">Pick a component, change its props, the theme and a few tokens, and copy the result. The controls come from the component's TypeScript types. Your setup lives in the address, so you can share it.</p>
  </header>
  <div class="pg-shell" data-playground>
    <Playground client:only="react" components={components}>
      <div slot="fallback" class="pg-fallback"><StatusLine state="wait" live>loading the playground…</StatusLine></div>
    </Playground>
    <noscript><p>The playground needs JavaScript. Every component also has its own page, which works without it.</p></noscript>
  </div>
  <script>
    import { watchIsland } from "../../lib/island-watchdog";
    const root = document.querySelector<HTMLElement>("[data-playground]");
    if (root) watchIsland(root);
  </script>
</DocsLayout>
```

Append to `apps/web/src/styles/site.css`:

```css
/* ---- playground ---- */
.pg { display: grid; gap: var(--sp-5); }
@media (min-width: 1100px) { .pg { grid-template-columns: 20rem minmax(0, 1fr); align-items: start; } }
.pg__controls { display: grid; gap: var(--sp-4); }
.pg__group { display: grid; gap: var(--sp-3); margin: 0; padding: var(--sp-3); border: 1px solid var(--c-line); border-radius: var(--r-m); }
.pg__group > legend { padding: 0 var(--sp-1); font-size: var(--fs-2); color: var(--c-fg-muted); }
.pg-select { display: grid; gap: var(--sp-1); font-size: var(--fs-2); color: var(--c-fg-muted); }
.pg-select select { min-height: var(--control-height); padding: 0 var(--sp-3); font: inherit; font-size: var(--fs-4); color: var(--c-fg); background: var(--c-bg-elev); border: 1px solid var(--c-line-input); border-radius: var(--r-m); }
.pg__out { display: grid; gap: var(--sp-3); min-width: 0; }
.pg__stage { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); min-height: calc(var(--sp-8) * 2); padding: var(--sp-5); background: var(--c-bg); border: 1px solid var(--c-line); border-radius: var(--r-l); }
.pg__stage .mw-header { position: static; }
.pg__code { max-height: 24rem; overflow: auto; }
.pg-fallback { padding: var(--sp-5); border: 1px dashed var(--c-line-input); border-radius: var(--r-l); }
```

- [ ] **Step 5: e2e**

`apps/web/tests/e2e/playground.spec.ts`:

```ts
import { test, expect } from "./fixtures";

test("the setup lives in the URL: load it, change it, reload it; nothing goes to a server", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto("/ui/playground/?c=button&p.variant=primary&p.children=send&theme=light");
  const stage = page.locator(".pg__stage");
  await expect(stage.locator(".mw-btn--primary")).toHaveText("send");
  await expect(stage).toHaveClass(/mw-theme--light/);
  await page.getByLabel("variant").selectOption("danger");
  await expect(page).toHaveURL(/p\.variant=danger/);
  await page.getByRole("radio", { name: /round/ }).check();
  await expect(page).toHaveURL(/radius=2/);
  expect(await stage.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--r-m"))).toBe("8px");
  await page.reload();
  await expect(stage.locator(".mw-btn--danger")).toHaveText("send");
  await expect(page.locator(".pg__code")).toContainText('<Button variant="danger">send</Button>');
  await expect(page.locator(".pg__code")).toContainText("--r-m: 8px;");
  const origin = new URL(page.url()).origin;
  expect(requests.filter((u) => !u.startsWith(origin))).toEqual([]);
  expect(await page.locator("[style]").evaluateAll((els) => els.filter((e) => !e.classList.contains("pg__stage")).length)).toBe(0);
});

test("bad URL values fall back to defaults, and switching components keeps the tokens", async ({ page }) => {
  await page.goto("/ui/playground/?c=nope&p.variant=hack&radius=9&density=comfy");
  await expect(page.locator(".pg__stage .mw-btn--secondary")).toHaveText("save");
  await page.getByLabel("component").selectOption("StatusLine");
  await expect(page).toHaveURL(/c=statusline/);
  await expect(page).toHaveURL(/density=comfy/);
  await expect(page.locator(".pg__stage .mw-status")).toContainText("connecting…");
});
```

The `[style]` check proves the only styles set by script live on the preview stage, through the
CSSOM. React sets them after hydration; the served HTML carries none, which the postbuild enforces.

- [ ] **Step 6: Run everything**

```bash
(cd apps/web && bunx vitest run --coverage)
bun run --filter @meowerse/web lint
bun run --filter @meowerse/web build
bun run --filter @meowerse/web e2e
```

Expected: all green; the sitemap has 43 pages.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): the /ui playground, with its state in the URL

Pick a component, change its props (controls generated from its TypeScript types), the theme,
the accent fill, the radius scale and the density; the snippet and a scoped CSS override update
live. Everything lives in the address (replaceState) and nothing is sent anywhere; overrides go
on the preview through the CSSOM, never a style attribute. A watchdog turns a chunk that never
loads into a plain error (B9).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 11: Patterns (the twelve "together" pairings, forms, states, composer) and the Cat3D page (B10, spec §7.1, §8, §5.2 "Patterns", "Cat3D"; audit §5b)

**Files:**
- Create:
  - `apps/web/src/pages/ui/patterns/{together,forms,states,composer}.astro`;
  - `apps/web/src/pages/ui/cat3d.astro`;
  - `apps/web/tests/e2e/ui-patterns.spec.ts`.
- Modify: `apps/web/src/lib/docs-nav.ts` (+test), `apps/web/src/styles/site.css` (append
  "patterns")

**Interfaces:**
- Consumes:
  - `ThemeButton.astro` (Task 3);
  - `CodeBlock.astro`, `DocsLayout` (Task 7);
  - the demos `toast-provider`, `confirm-dialog`, `modal` and `prompt` (Task 9);
  - `Cat3D` and `attachAllCat3D` (Task 2);
  - the `.chat`/`.bubble` classes (Task 9).
- Produces:
  - `/ui/patterns/together/` with `section[data-pairing="1".."12"]`, each with an `h2` starting
    `"<n>. "`. Task 12's screenshots use them.
  - Pairing 4's row `.together-row` holds a `Field`, a `Prompt` and a `Button`.
  - `/ui/patterns/forms/`, `/ui/patterns/states/`, `/ui/patterns/composer/`, `/ui/cat3d/`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/lib/docs-nav.test.ts`, replace the last-group test with:

```ts
  it("has the patterns, then ends with the playground, the gallery, cat3d and utilities", () => {
    const groups = docsNav([]);
    expect(groups.find((g) => g.label === "patterns")!.items.map((i) => i.href)).toEqual([
      "/ui/patterns/together/", "/ui/patterns/forms/", "/ui/patterns/states/", "/ui/patterns/composer/",
    ]);
    expect(groups.at(-1)!.items.map((i) => i.href)).toEqual(["/ui/playground/", "/ui/gallery/", "/ui/cat3d/", "/ui/utilities/"]);
  });
```

`apps/web/tests/e2e/ui-patterns.spec.ts`:

```ts
import { test, expect } from "./fixtures";

test("together: all twelve pairings, numbered", async ({ page }) => {
  await page.goto("/ui/patterns/together/");
  await expect(page.locator("[data-pairing]")).toHaveCount(12);
  for (let n = 1; n <= 12; n++) await expect(page.locator(`[data-pairing="${n}"] h2`)).toContainText(`${n}. `);
});

test("pairing 4: field, prompt and button share one height, border and radius (B10.3)", async ({ page }) => {
  await page.goto("/ui/patterns/together/");
  const box = (sel: string) => page.locator(`[data-pairing="4"] ${sel}`).first().evaluate((el) => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return { h: Math.round(r.height), radius: s.borderTopLeftRadius, border: s.borderTopWidth };
  });
  const field = await box(".mw-field input");
  const prompt = await box(".mw-prompt textarea");
  const button = await box(".together-row > .mw-btn");
  expect([field.h, prompt.h, button.h]).toEqual([44, 44, 44]);
  expect(prompt.radius).toBe(field.radius);
  expect(button.radius).toBe(field.radius);
  expect(prompt.border).toBe(field.border);
});

test("forms, states and composer: rules and specimens", async ({ page }) => {
  await page.goto("/ui/patterns/forms/");
  await expect(page.locator(".specimen .mw-field--error")).not.toHaveCount(0);
  await page.goto("/ui/patterns/states/");
  for (const s of ["wait", "fail", "info"]) await expect(page.locator(`.specimen .mw-status--${s}`).first()).toBeVisible();
  await expect(page.locator(".specimen .empty")).toBeVisible();
  await page.goto("/ui/patterns/composer/");
  await expect(page.locator(".rules-table tbody tr")).not.toHaveCount(0);
});

test("cat3d: the live cat and its still fallback", async ({ page }, info) => {
  await page.goto("/ui/cat3d/");
  await expect(page.locator(".mw-cat3d")).toHaveCount(2);
  if (info.project.name === "desktop")
    await expect(page.locator(".mw-cat3d:not(.mw-cat3d--static)")).toHaveClass(/mw-cat3d--live/, { timeout: 10_000 });
  await page.waitForTimeout(500);
  await expect(page.locator(".mw-cat3d--static")).not.toHaveClass(/mw-cat3d--live/);
  await expect(page.locator(".mw-cat3d--static img")).toBeVisible();
});
```

- [ ] **Step 2: Run them and watch them fail**

Run:
- `cd apps/web && bunx vitest run src/lib/docs-nav.test.ts`
- then `bun run --filter @meowerse/web build && (cd apps/web && bunx playwright test tests/e2e/ui-patterns.spec.ts)`

Expected: FAIL. There is no patterns group and no pages.

- [ ] **Step 3: The docs nav gains patterns and cat3d**

In `apps/web/src/lib/docs-nav.ts`, add

```ts
export const PATTERNS: NavItem[] = [
  { label: "tty and app together", href: "/ui/patterns/together/" },
  { label: "forms", href: "/ui/patterns/forms/" },
  { label: "empty, loading, error", href: "/ui/patterns/states/" },
  { label: "chat composer", href: "/ui/patterns/composer/" },
];
```

and make the end of the array `docsNav` returns:

```ts
    { label: "patterns", items: PATTERNS },
    {
      label: "more",
      items: [
        { label: "playground", href: "/ui/playground/" },
        { label: "gallery", href: "/ui/gallery/" },
        { label: "cat3d", href: "/ui/cat3d/" },
        { label: "utilities", href: "/ui/utilities/" },
      ],
    },
```

- [ ] **Step 4: The together page (audit §5b, all twelve pairings)**

`apps/web/src/pages/ui/patterns/together.astro`:

```astro
---
import { Alert, Avatar, Badge, Button, Checkbox, Code, Field, Footer, Icon, Kbd, Prompt, RecoveryCodes, StatusLine, Wordmark } from "@meowerse/ui";
import { Cat3D } from "@meowerse/ui/cat3d";
import DocsLayout from "../../../layouts/DocsLayout.astro";
import ThemeButton from "../../../components/ThemeButton.astro";
import ToastDemo from "../../../ui-docs/demos/toast-provider";
import ConfirmDialogDemo from "../../../ui-docs/demos/confirm-dialog";
import ModalDemo from "../../../ui-docs/demos/modal";

const noop = () => {};
const headerStates = [["wait", "connecting…"], ["ok", "online"], ["fail", "offline — check your connection"]] as const;
---
<DocsLayout title="tty and app, together" description="Every terminal-styled element next to the app components it appears with: twelve pairings, checked by screenshot tests.">
  <header class="docs-head">
    <h1 class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› </span>tty and app, together</h1>
    <p class="lede">Terminal-styled and app-styled elements are one family (B10): the same tokens, the same 44 px height, the same line, radius, focus ring and disabled style. These specimens put each tty element next to the app components it sits with. They're here to be looked at; every control works on its own component page.</p>
  </header>

  <section class="pairing" data-pairing="1" aria-labelledby="pair-1">
    <h2 id="pair-1">1. composer row</h2>
    <div class="pairing__body chat">
      <ol class="chat__log" aria-label="messages">
        <li class="bubble">are we still on for tonight?<span class="bubble__meta">19:02</span></li>
        <li class="bubble bubble--own"><span class="bubble__quote">are we still on for tonight?</span>yes — see you at 7<span class="bubble__meta">19:03 · read</span></li>
        <li class="bubble">great, I'll bring the cat<span class="bubble__meta">19:04</span></li>
      </ol>
      <div class="composer-row">
        <Button variant="ghost" aria-label="attach a file"><Icon name="plus" /></Button>
        <Button variant="ghost" aria-label="add an emoji"><Icon name="mood-smile" /></Button>
        <Prompt label="message" value="" onChange={noop} onSubmit={noop} />
      </div>
      <p class="mw-field__hint">Type a message to send. Enter sends, Shift+Enter adds a line, and nothing is sent while an input method is still composing.</p>
      <ToastDemo client:visible />
    </div>
  </section>

  <section class="pairing" data-pairing="2" aria-labelledby="pair-2">
    <h2 id="pair-2">2. app header with a status line</h2>
    <div class="pairing__body">
      {headerStates.map(([state, text]) => (
        <div class="mw-header">
          <Wordmark name="meowsenger" />
          <StatusLine state={state} children={text} />
          <div class="mw-header__actions">
            <Avatar name="alxnko" size="sm" />
            <Button variant="ghost" aria-label="menu"><Icon name="dots" /></Button>
            <ThemeButton />
          </div>
        </div>
      ))}
    </div>
  </section>

  <section class="pairing" data-pairing="3" aria-labelledby="pair-3">
    <h2 id="pair-3">3. auth form under a prompt title</h2>
    <div class="pairing__body specimen">
      <h3 class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› </span>sign in</h3>
      <Field label="username" defaultValue="alxnko" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      <Field label="password" type="password" error="wrong password — try again or reset it" />
      <Checkbox label="keep me signed in" />
      <StatusLine state="wait" live>checking you're human…</StatusLine>
      <div class="btn-row">
        <Button variant="primary" disabled>sign in</Button>
        <a class="mw-btn mw-btn--ghost mw-btn--md" href="/ui/patterns/forms/">forgot your password?</a>
      </div>
      <Alert variant="error">can't reach the account service — try again in a moment.</Alert>
    </div>
  </section>

  <section class="pairing" data-pairing="4" aria-labelledby="pair-4">
    <h2 id="pair-4">4. field, prompt and button in one row</h2>
    <div class="pairing__body">
      <div class="together-row grid-overlay">
        <Field label="name" defaultValue="alxnko" />
        <Prompt label="message" value="hi" onChange={noop} onSubmit={noop} />
        <Button>save</Button>
      </div>
      <p class="mw-muted">The 4 px grid shows they share one height, one 1 px border, one radius and one baseline.</p>
    </div>
  </section>

  <section class="pairing" data-pairing="5" aria-labelledby="pair-5">
    <h2 id="pair-5">5. status vocabulary</h2>
    <div class="pairing__body">
      <StatusLine state="ok">online</StatusLine>
      <StatusLine state="wait">connecting…</StatusLine>
      <StatusLine state="fail">offline</StatusLine>
      <StatusLine state="info">no public service to check</StatusLine>
      <div class="btn-row"><Badge variant="verified" icon="rosette-discount-check">verified</Badge><Badge>neutral</Badge><Badge variant="danger">suspended</Badge></div>
      <Alert variant="success">saved.</Alert>
      <Alert variant="error">couldn't save — try again.</Alert>
      <Alert>your codes were replaced.</Alert>
      <p class="mw-muted">Toasts use the same words; see pairing 1. One colour, one glyph and one word per state.</p>
    </div>
  </section>

  <section class="pairing" data-pairing="6" aria-labelledby="pair-6">
    <h2 id="pair-6">6. code and keys</h2>
    <div class="pairing__body">
      <p>Your invite code is <Code value="k3m9-X2p4-q8w1" copy />. Press <Kbd>Enter</Kbd> to send, or <Kbd>Shift</Kbd> + <Kbd>Enter</Kbd> for a new line.</p>
      <RecoveryCodes codes={["Ab3D-x9Kq", "t4nW-8rD3", "H2vc-6Yp1", "m9Zs-4kT7"]} />
    </div>
  </section>

  <section class="pairing" data-pairing="7" aria-labelledby="pair-7">
    <h2 id="pair-7">7. landing hero</h2>
    <div class="pairing__body together-hero">
      <div class="specimen">
        <Wordmark name="meowerse" />
        <ul class="services">
          <li><StatusLine state="ok">auth — up · 84 ms</StatusLine></li>
          <li><StatusLine state="info">meowsenger — unknown · no answer in 5 s</StatusLine></li>
        </ul>
        <a class="mw-btn mw-btn--primary mw-btn--md" href="/">open the home page</a>
      </div>
      <Cat3D size={140} />
      <Cat3D size={140} className="mw-cat3d--static" />
    </div>
  </section>

  <section class="pairing" data-pairing="8" aria-labelledby="pair-8">
    <h2 id="pair-8">8. dialogs next to a prompt</h2>
    <div class="pairing__body">
      <Prompt label="message" value="" onChange={noop} onSubmit={noop} />
      <ConfirmDialogDemo client:visible />
    </div>
  </section>

  <section class="pairing" data-pairing="9" aria-labelledby="pair-9">
    <h2 id="pair-9">9. empty state</h2>
    <div class="pairing__body together-split">
      <ul class="together-list" aria-label="chats">
        <li><Avatar name="alxnko" size="sm" /> alxnko</li>
        <li><Avatar name="Мяу" size="sm" /> Мяу</li>
      </ul>
      <div class="empty">
        <p class="empty__line"><span aria-hidden="true">› </span>no chats yet</p>
        <Button variant="primary">start a chat</Button>
      </div>
    </div>
  </section>

  <section class="pairing" data-pairing="10" aria-labelledby="pair-10">
    <h2 id="pair-10">10. sheets over a header with a status line</h2>
    <div class="pairing__body">
      <div class="mw-header"><Wordmark name="meowsenger" /><StatusLine state="wait">reconnecting…</StatusLine></div>
      <ModalDemo client:visible />
      <p class="mw-muted">Menus and drawers aren't in @meowerse/ui yet; they move in from meowsenger in sub-project 4 (audit D-5, D-6), and this pairing gains them then.</p>
    </div>
  </section>

  <section class="pairing" data-pairing="11" aria-labelledby="pair-11">
    <h2 id="pair-11">11. footer under a status line</h2>
    <div class="pairing__body">
      <StatusLine state="ok">all services up</StatusLine>
      <Footer links={[{ label: "projects", href: "/#projects" }, { label: "ui docs", href: "/ui/" }]} legal="meowerse — a personal project by alxnko." />
    </div>
  </section>

  <section class="pairing" data-pairing="12" aria-labelledby="pair-12">
    <h2 id="pair-12">12. reduced motion and forced colours</h2>
    <div class="pairing__body">
      <p>Pairings 1 to 3 are also captured with reduced motion (the wordmark cursor holds still and waits stay [wait] lines) and in forced-colours mode (the focus ring stays visible). The screenshot tests in <code>apps/web/tests/e2e/screenshots.spec.ts</code> record both, at phone and desktop sizes.</p>
    </div>
  </section>

  <script>
    import { attachAllCat3D } from "@meowerse/ui/cat3d/attach";
    if ("requestIdleCallback" in window) requestIdleCallback(() => attachAllCat3D());
    else setTimeout(() => attachAllCat3D(), 200);
  </script>
</DocsLayout>
```

- [ ] **Step 5: Forms, states, composer, Cat3D**

`apps/web/src/pages/ui/patterns/forms.astro`:

```astro
---
import { Alert, Button, Checkbox, Field, StatusLine } from "@meowerse/ui";
import DocsLayout from "../../../layouts/DocsLayout.astro";
const rules = [
  "Labels are always visible, above the field; a placeholder is never the label.",
  "Inputs are 16 px so phones don't zoom. Usernames use autocapitalize=\"none\", autocorrect=\"off\" and spellcheck=\"false\".",
  "An error sits under the field that caused it, in plain words; with several, an alert at the top says how many.",
  "Submit is either ready, or disabled with a visible reason such as \"checking you're human…\". It is never enabled only to refuse.",
  "A form can't be sent twice: the button shows its loading state until the answer comes.",
  "Every wait has a timeout and ends in a plain error with a way to try again.",
];
---
<DocsLayout title="forms" description="How meowerse forms behave: visible labels, plain errors, honest waiting.">
  <header class="docs-head">
    <h1 class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› </span>forms</h1>
    <p class="lede">Forms stay familiar, for trust and for autofill: normal labelled fields; only the page title carries the prompt style.</p>
  </header>
  <section class="docs-section" aria-labelledby="rules-title">
    <h2 id="rules-title">rules</h2>
    <ul class="docs-list">{rules.map((r) => <li>{r}</li>)}</ul>
  </section>
  <section class="docs-section" aria-labelledby="spec-title">
    <h2 id="spec-title">specimen</h2>
    <div class="specimen">
      <Alert variant="error">2 things need fixing before you can sign up.</Alert>
      <Field label="username" defaultValue="meow cat" error="use letters, digits and _ only" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      <Field label="password" type="password" hint="at least 12 characters" error="too short — use at least 12 characters" />
      <Checkbox label="I accept the terms" />
      <StatusLine state="ok">you're human — thanks</StatusLine>
      <div class="btn-row"><Button variant="primary" loading>creating your account</Button><Button variant="ghost">cancel</Button></div>
    </div>
  </section>
</DocsLayout>
```

`apps/web/src/pages/ui/patterns/states.astro`:

```astro
---
import { Alert, Button, Spinner, StatusLine } from "@meowerse/ui";
import DocsLayout from "../../../layouts/DocsLayout.astro";
const rules = [
  "A control that needs background work (a captcha, the session, a socket, a lazy chunk) is either disabled with a visible reason or enabled with a queue that finishes the action once ready. It is never enabled and then refused.",
  "Every wait has a visible state, a timeout, a plain error, and a way to retry or recover.",
  "No failure is silent: it's shown, or deliberately ignored with a comment in the code.",
  "Actions are idempotent where they can be: double submits are blocked and sends carry a client id.",
  "State is checked again on return: back/forward and the back-forward cache, tab visibility and reconnects.",
  "Unknown is not down: when a check can't get an answer, say it's unknown.",
];
---
<DocsLayout title="empty, loading, error" description="How meowerse shows waiting, failure, the unknown and emptiness, so nothing looks ready when it isn't.">
  <header class="docs-head">
    <h1 class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› </span>empty, loading, error</h1>
    <p class="lede">No blocking background logic (B9): nothing looks ready while it isn't, and no wait lasts forever.</p>
  </header>
  <section class="docs-section" aria-labelledby="rules-title">
    <h2 id="rules-title">rules</h2>
    <ul class="docs-list">{rules.map((r) => <li>{r}</li>)}</ul>
  </section>
  <section class="docs-section" aria-labelledby="spec-title">
    <h2 id="spec-title">specimens</h2>
    <div class="specimen">
      <h3>loading</h3>
      <StatusLine state="wait" live>loading your chats… (gives up after 10 s)</StatusLine>
      <Spinner label="loading your chats" />
      <h3>failed</h3>
      <StatusLine state="fail">couldn't load your chats — the server took too long.<Button slot="action" size="sm">try again</Button></StatusLine>
      <h3>unknown</h3>
      <StatusLine state="info">meowsenger — unknown · no answer in 5 s</StatusLine>
      <h3>empty</h3>
      <div class="empty"><p class="empty__line"><span aria-hidden="true">› </span>no chats yet</p><Button variant="primary">start a chat</Button></div>
      <h3>done</h3>
      <Alert variant="success">saved.</Alert>
    </div>
  </section>
</DocsLayout>
```

`apps/web/src/pages/ui/patterns/composer.astro`:

```astro
---
import DocsLayout from "../../../layouts/DocsLayout.astro";
import PromptDemo from "../../../ui-docs/demos/prompt";
const rows = [
  ["field", "At least 44 px tall, a 1 px line border, a 4 px radius and 32 px of left padding. The › glyph is 16 px, on the first text line, subtle at rest and accent on focus. The field is never disabled: sends queue in an outbox."],
  ["send", "A 44×44 button with a 4 px radius, aligned to the bottom of the field."],
  ["keys", "Enter sends and Shift+Enter adds a line; on phones Enter adds a line and the button sends; nothing is sent while an input method is composing."],
  ["bubbles", "An 8 px radius with a 2 px corner on the sender's side, 8/12 px padding, 12 px meta text, and at most about 62 characters wide."],
  ["avatars", "Rounded squares with a 4 px radius."],
  ["sidebar", "The active row gets a 2 px accent bar on its left; no › on rows or on the search box."],
  ["connection", "A StatusLine in the header, shown only while the connection isn't ok."],
  ["avoid", "A borderless command-line input, a blinking block cursor in the field, [send] bracket buttons, black terminal panels."],
];
---
<DocsLayout title="chat composer" description="The chat composer pattern: a prompt that stays a normal, discoverable input.">
  <header class="docs-head">
    <h1 class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› </span>chat composer</h1>
    <p class="lede">The composer reads as a prompt and still behaves like the input everyone knows (spec §7).</p>
  </header>
  <section class="docs-section" aria-labelledby="try-title">
    <h2 id="try-title">try it</h2>
    <div class="demo-stage" data-preview><PromptDemo client:visible /></div>
  </section>
  <section class="docs-section" aria-labelledby="geo-title">
    <h2 id="geo-title">geometry and behaviour</h2>
    <div class="table-wrap" tabindex="0" role="region" aria-label="composer rules">
      <table class="table rules-table">
        <thead><tr><th scope="col">part</th><th scope="col">rule</th></tr></thead>
        <tbody>{rows.map(([k, v]) => <tr><td>{k}</td><td>{v}</td></tr>)}</tbody>
      </table>
    </div>
  </section>
</DocsLayout>
```

`apps/web/src/pages/ui/cat3d.astro`:

```astro
---
import { Cat3D } from "@meowerse/ui/cat3d";
import DocsLayout from "../../layouts/DocsLayout.astro";
import CodeBlock from "../../components/docs/CodeBlock.astro";
const usage = `---
// in an .astro page: server-rendered markup, no React shipped
import { Cat3D } from "@meowerse/ui/cat3d";
---
<Cat3D size={220} />
<script>
  import { attachAllCat3D } from "@meowerse/ui/cat3d/attach";
  requestIdleCallback(() => attachAllCat3D());
</script>`;
---
<DocsLayout title="Cat3D" description="The tiny interactive low-poly cat: a custom WebGL2 renderer, lazy, with a still fallback.">
  <header class="docs-head">
    <h1 class="prompt-title"><span class="prompt-title__glyph" aria-hidden="true">› </span>cat3d</h1>
    <p class="lede">The low-poly green cat from the alxnko.dev desk, drawn by a dependency-free WebGL2 renderer with flat shading and one light. Its head eases toward your pointer, or your finger on touch screens.</p>
  </header>
  <section class="docs-section" aria-labelledby="live-title">
    <h2 id="live-title">live</h2>
    <Cat3D size={240} />
  </section>
  <section class="docs-section" aria-labelledby="still-title">
    <h2 id="still-title">the still fallback</h2>
    <Cat3D size={240} className="mw-cat3d--static" />
    <p>The same pose as a still image. You get it when WebGL2 isn't available, when motion is reduced, when the browser asks to save data, or when loading fails. The cat is decorative (aria-hidden), so the fallback costs nothing.</p>
  </section>
  <section class="docs-section" aria-labelledby="cost-title">
    <h2 id="cost-title">what it costs</h2>
    <ul class="docs-list">
      <li>The renderer is about 2 KB gzipped (budget 3 KB), and the mesh is 7.8 KB (budget 10 KB). The poster is a 5 KB webp (budget 6 KB).</li>
      <li>Nothing loads before the page is idle and the cat is near the screen; nothing redraws while the head is still.</li>
      <li>No three.js: one small shader, and the mesh quantised to 16-bit positions.</li>
    </ul>
  </section>
  <section class="docs-section" aria-labelledby="use-title">
    <h2 id="use-title">use it</h2>
    <CodeBlock id="cat-use" lang="astro" code={usage} />
  </section>
  <script>
    import { attachAllCat3D } from "@meowerse/ui/cat3d/attach";
    if ("requestIdleCallback" in window) requestIdleCallback(() => attachAllCat3D());
    else setTimeout(() => attachAllCat3D(), 200);
  </script>
</DocsLayout>
```

Append to `apps/web/src/styles/site.css`:

```css
/* ---- patterns ---- */
.specimen { display: grid; gap: var(--sp-3); justify-items: start; max-width: 36rem; padding: var(--sp-4); background: var(--c-bg); border: 1px solid var(--c-line); border-radius: var(--r-l); }
.specimen > .mw-field, .specimen > .mw-alert, .specimen > .mw-status { justify-self: stretch; }
.pairing { display: grid; gap: var(--sp-3); padding-top: var(--sp-4); border-top: 1px solid var(--c-line); }
.pairing > h2 { font-size: var(--fs-4); }
.pairing__body { display: grid; gap: var(--sp-3); min-width: 0; padding: var(--sp-4); background: var(--c-bg); border: 1px solid var(--c-line); border-radius: var(--r-l); }
.pairing .mw-header { position: static; border: 1px solid var(--c-line); border-radius: var(--r-m); }
.together-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-2); }
.together-row > .mw-field, .together-row > .mw-prompt { flex: 1 1 14rem; }
.grid-overlay { background-image: repeating-linear-gradient(to bottom, transparent 0, transparent calc(var(--sp-1) - 1px), color-mix(in srgb, var(--c-accent) 22%, transparent) calc(var(--sp-1) - 1px), color-mix(in srgb, var(--c-accent) 22%, transparent) var(--sp-1)); }
.composer-row { display: flex; align-items: flex-end; gap: var(--sp-1); }
.composer-row .mw-prompt { flex: 1; }
.together-split { display: grid; gap: var(--sp-4); }
@media (min-width: 760px) { .together-split { grid-template-columns: 14rem minmax(0, 1fr); } }
.together-list { display: grid; align-content: start; margin: 0; padding: 0; list-style: none; border-right: 1px solid var(--c-line); }
.together-list li { display: flex; align-items: center; gap: var(--sp-2); min-height: var(--control-height); padding: 0 var(--sp-2); }
.empty { display: grid; gap: var(--sp-3); justify-items: start; align-content: center; min-height: calc(var(--sp-8) * 2); }
.empty__line { color: var(--c-fg-muted); }
.together-hero { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-5); }
.together-hero .services { min-width: 16rem; }
.rules-table td:first-child { font-weight: 700; white-space: nowrap; }
```

- [ ] **Step 6: Run everything**

```bash
(cd apps/web && bunx vitest run --coverage)
bun run --filter @meowerse/web lint
bun run --filter @meowerse/web build
bun run --filter @meowerse/web e2e
```

Expected:
- all green, and the sitemap has 48 pages;
- in `dist/`, `/ui/patterns/together/` has exactly three `astro-island` elements (toast, confirm,
  modal):
  `rg -o '<astro-island' apps/web/dist/ui/patterns/together/index.html | wc -l` prints `3`.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): /ui patterns (the twelve tty/app pairings, forms, states, composer) and the Cat3D page

The together page puts every tty element next to the app components it sits with: the audit's
twelve pairings (§5b), with a pixel-grid check that field, prompt and button share one geometry
(B10.3). Forms, states (B9's rules) and the composer (spec §7) each state their rules next to a
live specimen. The Cat3D page shows the live cat and its still fallback, and what they cost.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Screenshot tests: gallery, pairings, real pages (spec §3, §7.1.6, §9)

**Files:**
- Create: `apps/web/tests/e2e/screenshots.spec.ts` and `apps/web/tests/e2e/__screenshots__/**`
  (generated baselines, committed)

**Interfaces:**
- Consumes:
  - `/ui/gallery/` `[data-shot]` sections (Task 9);
  - `/ui/patterns/together/` `[data-pairing]` sections (Task 11);
  - `/` and `/p/auth/`;
  - the fixtures' `PROBED` stub.
- Produces: the committed baselines. The spec is skipped in CI: CI runner fonts differ, the same
  local-only deviation as `tokens:drift` (B28). Task 15 runs it.

Stable screenshots:
- `animations: "disabled"` and `caret: "hide"` come from the config.
- Fonts must be ready before each shot.
- Every island in the shot must be hydrated.
- Cat3D is masked (a WebGL canvas isn't deterministic).
- The probe texts, which include milliseconds, are masked.

- [ ] **Step 1: Write the spec**

`apps/web/tests/e2e/screenshots.spec.ts`:

```ts
import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

test.skip(!!process.env.CI, "screenshots are compared on the release machine only: CI runner fonts differ (like tokens:drift, B28)");

const THEMES = ["dark", "light"] as const;
const settle = async (page: Page, scope: Locator) => {
  await scope.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  await expect(scope.locator("astro-island[ssr]")).toHaveCount(0, { timeout: 15_000 });
};

test("gallery: every component section, dark and light side by side", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/ui/gallery/");
  const slugs = await page.locator("[data-shot]").evaluateAll((els) => els.map((e) => e.getAttribute("data-shot")!));
  for (const slug of slugs) {
    const s = page.locator(`[data-shot="${slug}"]`);
    await settle(page, s);
    await expect(s).toHaveScreenshot(`gallery-${slug}.png`, { mask: [page.locator(".mw-cat3d")] });
  }
});

for (const theme of THEMES) {
  test(`together: every pairing, ${theme}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.addInitScript((t) => localStorage.setItem("mw-theme", t), theme);
    await page.goto("/ui/patterns/together/");
    for (let n = 1; n <= 12; n++) {
      const s = page.locator(`[data-pairing="${n}"]`);
      await settle(page, s);
      await expect(s).toHaveScreenshot(`together-${n}-${theme}.png`, { mask: [page.locator(".mw-cat3d")] });
    }
    // states the pairings promise besides default: hover and focus-visible (pairing 4's row)
    const row = page.locator('[data-pairing="4"] .together-row');
    await row.locator(".mw-btn").hover();
    await expect(row).toHaveScreenshot(`together-4-hover-${theme}.png`);
    await row.locator(".mw-field input").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(row).toHaveScreenshot(`together-4-focus-${theme}.png`);
  });
}

test("together 1–3 under reduced motion and forced colours (pairing 12)", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await page.goto("/ui/patterns/together/");
  for (const n of [1, 2, 3]) {
    const s = page.locator(`[data-pairing="${n}"]`);
    await settle(page, s);
    await expect(s).toHaveScreenshot(`together-${n}-reduced-forced.png`);
  }
});

for (const theme of THEMES) {
  test(`real pages: home and a project page, ${theme}`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("mw-theme", t), theme);
    for (const [name, path] of [["home", "/"], ["project-auth", "/p/auth/"]] as const) {
      await page.goto(path);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator(".mw-status__tag").first()).not.toHaveText("[wait]");
      await expect(page).toHaveScreenshot(`page-${name}-${theme}.png`, {
        fullPage: true, mask: [page.locator(".mw-cat3d"), page.locator("[data-probe] .mw-status__text")],
      });
    }
  });
}
```

- [ ] **Step 2: Record the baselines**

```bash
bun run --filter @meowerse/web build
(cd apps/web && bunx playwright test tests/e2e/screenshots.spec.ts --update-snapshots)
ls apps/web/tests/e2e/__screenshots__/screenshots.spec.ts | wc -l
```

Expected: about 122 PNGs:
- 26 gallery × 2 viewports;
- (12 pairings + 2 states) × 2 themes × 2 viewports;
- 3 reduced/forced × 2 viewports;
- 2 pages × 2 themes × 2 viewports.

- [ ] **Step 3: Review every baseline by eye before committing it**

Open the PNGs, for example with the Read tool on each file, and check:
- dark and light both render: text is readable and nothing is invisible;
- there is no horizontal overflow at 390 px;
- no text is clipped and no targets overlap;
- the tty elements line up with the app elements (pairings 2, 3 and 4);
- the cursor is steady and focus is visible in the forced-colours shots;
- user text keeps its case ("Cats & Co", "Мяу", "Ab3D-x9Kq").

Fix any defect in the page or component, re-run with `--update-snapshots`, and look again. Never
commit a baseline you haven't looked at.

- [ ] **Step 4: Prove they compare cleanly**

Run: `(cd apps/web && bunx playwright test tests/e2e/screenshots.spec.ts)`

Expected: all pass without `--update-snapshots`. Run it twice, to rule out flake from hydration or
fonts.

- [ ] **Step 5: Commit**

```bash
git add apps/web/tests/e2e/screenshots.spec.ts apps/web/tests/e2e/__screenshots__
git commit -m "test(web): screenshot baselines for the gallery, the twelve pairings and the real pages

Every gallery section (dark and light side by side), every tty/app pairing in both themes plus
hover and focus-visible, pairings 1-3 under reduced motion and forced colours, and the home and
a project page, at phone (390) and desktop (1440). Compared locally (runner fonts differ in CI,
like tokens:drift, B28).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: The budget gate and the Lighthouse gate (B26, spec §9)

**Files:**
- Create: `apps/web/src/lib/budget.ts` (+`.test.ts`), `apps/web/scripts/budget.ts`,
  `apps/web/scripts/lighthouse.ts`
- Modify: `apps/web/package.json` (add `budget` and `lighthouse` scripts)

**Interfaces:**
- Consumes: `inlineBlocks` from `csp.ts`; `dist/` from the build.
- Produces:
  - `BUDGETS` (bytes, from Global Constraints);
  - `pageAssets(html)`;
  - `resolveJs(from, spec)`;
  - `staticClosure(entries, read)`, `dynamicTargets(files, read)`;
  - `gz(buf)`.
  - `bun run --filter @meowerse/web budget` exits 1 on any ceiling and prints every figure.
  - `bun run --filter @meowerse/web lighthouse` exits 1 below 95.

- [ ] **Step 1: Write the failing test**

`apps/web/src/lib/budget.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BUDGETS, dynamicTargets, gz, pageAssets, resolveJs, staticClosure } from "./budget";

const files: Record<string, string> = {
  "_astro/page.a.js": 'import{x}from"./shared.b.js";import"./side.c.js";const r=()=>import("./renderer.d.js");',
  "_astro/shared.b.js": "export const x=1;",
  "_astro/side.c.js": "console.log(1)",
  "_astro/renderer.d.js": 'import"./gl.e.js";',
  "_astro/gl.e.js": "export{}",
};
const read = (p: string) => files[p];

describe("budget", () => {
  it("reads a page's inline code, module entries, islands and font preloads", () => {
    const a = pageAssets(`<head><link rel="preload" href="/_astro/f.woff2" as="font" type="font/woff2" crossorigin><style>p{}</style>
      <script>theme()</script><script type="application/ld+json">{}</script></head>
      <body><script type="module" src="/_astro/page.a.js"></script>
      <astro-island uid="1" component-url="/_astro/Demo.x.js" renderer-url="/_astro/client.y.js" ssr></astro-island></body>`);
    expect(a).toEqual({
      inlineJs: "theme()", inlineCss: "p{}", entries: ["_astro/page.a.js"],
      islands: ["_astro/Demo.x.js", "_astro/client.y.js"], preloads: ["_astro/f.woff2"],
    });
  });
  it("resolves relative imports inside _astro", () => {
    expect(resolveJs("_astro/page.a.js", "./shared.b.js")).toBe("_astro/shared.b.js");
    expect(resolveJs("_astro/x/y.js", "../z.js")).toBe("_astro/z.js");
  });
  it("follows static imports only; dynamic imports are the lazy part", () => {
    const initial = staticClosure(["_astro/page.a.js"], read);
    expect([...initial].sort()).toEqual(["_astro/page.a.js", "_astro/shared.b.js", "_astro/side.c.js"]);
    const lazy = dynamicTargets(initial, read);
    expect([...lazy]).toEqual(["_astro/renderer.d.js"]);
    expect([...staticClosure([...lazy], read)].sort()).toEqual(["_astro/gl.e.js", "_astro/renderer.d.js"]);
  });
  it("measures gzip -9 and carries the ceilings from the plan", () => {
    expect(gz("a".repeat(1000))).toBeLessThan(40);
    expect(BUDGETS).toEqual({
      criticalJs: 8 * 1024, allJsNoIslands: 12 * 1024, islandJs: 90 * 1024, inlineCss: 14 * 1024,
      html: 25 * 1024, htmlUi: 40 * 1024, preloadFonts: 24 * 1024, siteFonts: 60 * 1024,
      renderer: 3 * 1024, catBin: 10 * 1024, poster: 6 * 1024,
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && bunx vitest run src/lib/budget.test.ts`

Expected: FAIL (module missing).

- [ ] **Step 3: `src/lib/budget.ts`**

```ts
// Byte budgets (spec §9, B26). The ceilings were set from what was measured on 2026-09-24 (plan Global
// Constraints). gzip -9 like the CDN, except fonts and binary assets (already compressed: raw bytes).
import { gzipSync } from "node:zlib";
import { posix } from "node:path";
import { inlineBlocks } from "./csp";

const KB = 1024;
export const BUDGETS = {
  criticalJs: 8 * KB, allJsNoIslands: 12 * KB, islandJs: 90 * KB, inlineCss: 14 * KB,
  html: 25 * KB, htmlUi: 40 * KB, preloadFonts: 24 * KB, siteFonts: 60 * KB,
  renderer: 3 * KB, catBin: 10 * KB, poster: 6 * KB,
} as const;

export const gz = (s: string | Uint8Array): number => gzipSync(s, { level: 9 }).length;

const strip = (url: string) => url.replace(/^\//, "");

export type PageAssets = { inlineJs: string; inlineCss: string; entries: string[]; islands: string[]; preloads: string[] };

export function pageAssets(html: string): PageAssets {
  const all = (re: RegExp) => [...html.matchAll(re)].map((m) => strip(m[1]!));
  const { scripts, styles } = inlineBlocks(html);
  return {
    inlineJs: scripts.join(""),
    inlineCss: styles.join(""),
    entries: all(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g),
    islands: [...all(/<astro-island\b[^>]*\bcomponent-url="([^"]+)"/g), ...all(/<astro-island\b[^>]*\brenderer-url="([^"]+)"/g)],
    preloads: all(/<link\b[^>]*\brel="preload"[^>]*\bhref="([^"]+)"/g),
  };
}

/** dist-relative path of an import specifier seen in a dist-relative JS file. */
export const resolveJs = (from: string, spec: string): string =>
  spec.startsWith("/") ? strip(spec) : posix.normalize(posix.join(posix.dirname(from), spec));

const STATIC = /(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"']+\.js)["']/g;
const DYNAMIC = /\bimport\(\s*["']([^"']+\.js)["']\s*\)/g;

/** Files reachable through static import/export (what the browser fetches before running the entry). */
export function staticClosure(entries: string[], read: (p: string) => string | undefined): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    const src = read(f);
    if (src === undefined) continue;
    seen.add(f);
    for (const m of src.matchAll(STATIC)) stack.push(resolveJs(f, m[1]!));
  }
  return seen;
}

/** Targets of dynamic import() in these files, not already in them: the lazy part. */
export function dynamicTargets(files: Iterable<string>, read: (p: string) => string | undefined): Set<string> {
  const have = new Set(files);
  const out = new Set<string>();
  for (const f of have) for (const m of (read(f) ?? "").matchAll(DYNAMIC)) {
    const t = resolveJs(f, m[1]!);
    if (!have.has(t)) out.add(t);
  }
  return out;
}
```

- [ ] **Step 4: `scripts/budget.ts` and `scripts/lighthouse.ts`**

`apps/web/scripts/budget.ts`:

```ts
// Enforces the byte budgets on dist/ (bun run budget, after bun run build). Prints every figure; exit 1 on any breach.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BUDGETS, dynamicTargets, gz, pageAssets, staticClosure } from "../src/lib/budget";

const dist = join(process.cwd(), "dist");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(dist).map((f) => relative(dist, f).split("\\").join("/"));
const text = (p: string) => (existsSync(join(dist, p)) ? readFileSync(join(dist, p), "utf8") : undefined);
const size = (p: string) => statSync(join(dist, p)).size;
const gzOf = (ps: Iterable<string>) => [...ps].reduce((n, p) => n + gz(readFileSync(join(dist, p))), 0);
const REACT = /react\.dev\/errors/;

type Row = { name: string; value: number; max: number; where?: string };
const rows: Row[] = [];
const worst = (name: string, max: number, per: [string, number][]) => {
  const [where, value] = per.reduce((a, b) => (b[1] > a[1] ? b : a), ["-", 0] as [string, number]);
  rows.push({ name, value, max, where });
};
const problems: string[] = [];

const pages = files.filter((f) => f.endsWith(".html"));
const critical: [string, number][] = [], allNoIsland: [string, number][] = [], island: [string, number][] = [];
const css: [string, number][] = [], html: [string, number][] = [], htmlUi: [string, number][] = [];
for (const page of pages) {
  const src = readFileSync(join(dist, page), "utf8");
  const a = pageAssets(src);
  const initial = staticClosure(a.entries, text);
  critical.push([page, gz(a.inlineJs) + gzOf(initial)]);
  css.push([page, gz(a.inlineCss)]);
  (page.startsWith("ui/") ? htmlUi : html).push([page, gz(src)]);
  if (a.islands.length) {
    island.push([page, gzOf(staticClosure(a.islands, text))]);
  } else {
    const lazy = staticClosure([...dynamicTargets(initial, text)], text);
    const reach = new Set([...initial, ...lazy]);
    allNoIsland.push([page, gz(a.inlineJs) + gzOf(reach)]);
    for (const f of reach) if (REACT.test(text(f) ?? "")) problems.push(`${page} reaches React (${f}) without an island`);
  }
  const preload = a.preloads.reduce((n, p) => n + size(p), 0);
  if (preload > BUDGETS.preloadFonts) problems.push(`${page}: preloaded fonts ${preload} B > ${BUDGETS.preloadFonts} B`);
}
worst("critical JS per page (gz)", BUDGETS.criticalJs, critical);
worst("all JS, pages without islands (gz)", BUDGETS.allJsNoIslands, allNoIsland);
worst("island JS per page (gz)", BUDGETS.islandJs, island);
worst("inline CSS per page (gz)", BUDGETS.inlineCss, css);
worst("HTML per page (gz)", BUDGETS.html, html);
worst("HTML per /ui page (gz)", BUDGETS.htmlUi, htmlUi);

const woff = files.filter((f) => /\/(jetbrains-mono-latin-(400|700)-normal|jetbrains-mono-symbols-400|vt323-marks)\.[^/]+\.woff2$/.test(f));
rows.push({ name: "site fonts (raw woff2)", value: woff.reduce((n, f) => n + size(f), 0), max: BUDGETS.siteFonts });
const one = (re: RegExp) => files.find((f) => re.test(f));
const renderer = one(/^_astro\/renderer\.[^/]+\.js$/), bin = one(/^_astro\/cat\.[^/]+\.bin$/), poster = one(/^_astro\/cat-poster\.[^/]+\.webp$/);
if (!renderer || !bin || !poster) problems.push("Cat3D assets missing from dist (renderer chunk, cat.bin, cat-poster.webp)");
else {
  rows.push({ name: "Cat3D renderer chunk (gz)", value: gz(readFileSync(join(dist, renderer))), max: BUDGETS.renderer });
  rows.push({ name: "cat.bin (raw)", value: size(bin), max: BUDGETS.catBin });
  rows.push({ name: "cat-poster.webp (raw)", value: size(poster), max: BUDGETS.poster });
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
for (const r of rows) {
  const ok = r.value <= r.max;
  if (!ok) problems.push(`${r.name}: ${kb(r.value)} > ${kb(r.max)}${r.where ? ` (${r.where})` : ""}`);
  console.log(`${ok ? "ok  " : "FAIL"} ${r.name.padEnd(38)} ${kb(r.value).padStart(9)}  (budget ${kb(r.max)})${r.where && r.where !== "-" ? `  worst: ${r.where}` : ""}`);
}
if (problems.length) { console.error(`\n${problems.join("\n")}`); process.exit(1); }
```

`apps/web/scripts/lighthouse.ts`:

```ts
// Lighthouse gate (B26), local only: dist/ served with the real _headers and gzip (serve-dist.ts), Lighthouse 13,
// median of 3 runs per page and form factor, headless Chromium without a GPU (--disable-gpu
// --enable-unsafe-swiftshader). Mobile: default throttling (4× CPU, slow 4G). Desktop: preset desktop with CPU ×3
// (the PSI-calibrated setup alxnko.dev used, R82). Every category must be ≥ 95. Reports: /var/tmp/brand-v2/sp2/lh.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const PORT = 4372, RUNS = 3, MIN = 95;
const OUT = "/var/tmp/brand-v2/sp2/lh";
const PAGES = ["/", "/p/meowsenger/", "/ui/", "/ui/components/button/", "/ui/playground/"];
const CATS = ["performance", "accessibility", "best-practices", "seo"] as const;
mkdirSync(OUT, { recursive: true });

const server = spawn("bun", ["scripts/serve-dist.ts", String(PORT)], { stdio: "ignore" });
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i++) { try { if ((await fetch(base)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)); }

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const failures: string[] = [];
try {
  for (const path of PAGES) {
    for (const ff of ["mobile", "desktop"] as const) {
      const scores: Record<string, number[]> = Object.fromEntries(CATS.map((c) => [c, []]));
      const bench: number[] = [];
      for (let run = 0; run < RUNS; run++) {
        const file = `${OUT}/${path.replace(/\//g, "_") || "_"}-${ff}-${run}.json`;
        const args = ["lighthouse@13", `${base}${path}`, "--quiet", "--output=json", `--output-path=${file}`,
          `--only-categories=${CATS.join(",")}`, "--chrome-flags=--headless=new --disable-gpu --enable-unsafe-swiftshader --no-sandbox",
          ...(ff === "desktop" ? ["--preset=desktop", "--throttling.cpuSlowdownMultiplier=3"] : [])];
        const r = spawnSync("bunx", args, { env: { ...process.env, CHROME_PATH: chromium.executablePath() }, stdio: "inherit" });
        if (r.status !== 0) throw new Error(`lighthouse failed on ${path} (${ff})`);
        const lhr = JSON.parse(readFileSync(file, "utf8"));
        for (const c of CATS) scores[c]!.push(Math.round(lhr.categories[c].score * 100));
        bench.push(lhr.environment.benchmarkIndex);
      }
      const med = Object.fromEntries(CATS.map((c) => [c, median(scores[c]!)]));
      console.log(`${path.padEnd(26)} ${ff.padEnd(8)} ${CATS.map((c) => `${c} ${med[c]}`).join("  ")}  (benchmarkIndex ${median(bench)})`);
      if (median(bench) < 1500) console.warn(`  warning: benchmarkIndex ${median(bench)} is low; the machine is busy or slow, so re-run when it is idle`);
      for (const c of CATS) if (med[c]! < MIN) failures.push(`${path} ${ff} ${c} ${med[c]} < ${MIN}`);
    }
  }
} finally {
  server.kill();
}
if (failures.length) { console.error(`\n${failures.join("\n")}`); process.exit(1); }
```

In `apps/web/package.json` `"scripts"`, add:

```json
    "budget": "bun scripts/budget.ts",
    "lighthouse": "bun scripts/lighthouse.ts"
```

- [ ] **Step 5: Run the budget gate**

```bash
(cd apps/web && bunx vitest run --coverage)
bun run --filter @meowerse/web build && bun run --filter @meowerse/web budget
```

Expected: every row `ok`, and no React reachable from a page without islands. Write the printed
table into `/var/tmp/brand-v2/sp2/budget.txt`; the PR body quotes it in Task 15.

If a row fails, cut bytes: move work out of the critical path, or split an island. Don't raise a
ceiling. A ceiling changes only with a measured reason, recorded in the decision log.

- [ ] **Step 6: Run the Lighthouse gate on an idle machine**

Run: `bun run --filter @meowerse/web lighthouse`

Expected: every page, mobile and desktop, ≥ 95 in all four categories. Save the printed table to
`/var/tmp/brand-v2/sp2/lighthouse.txt`.

If a page misses 95, fix the cause Lighthouse names, one at a time:
- **A long task:** split or defer the work. The playground island can move from `client:only` to
  rendering its controls lazily.
- **A render-blocking request.**
- **Layout shift:** give the element its size.
- **An a11y or SEO audit:** fix the markup.

Re-run until it passes. If only `/ui/playground/` on mobile stays below 95 after that (React's
parse cost on a 4× throttled CPU), record the measured medians in the PR and in the decision log
as an open item for the owner. Never lower the bar silently.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/budget.ts apps/web/src/lib/budget.test.ts apps/web/scripts/budget.ts apps/web/scripts/lighthouse.ts apps/web/package.json
git commit -m "build(web): byte budgets and the Lighthouse gate

budget: critical JS, all JS on pages without islands (and no React there), island JS, inline
CSS, HTML, preloaded and site fonts, and the Cat3D renderer, mesh and poster, each against the
ceilings measured on 2026-09-24. lighthouse: Lighthouse 13 on the built site with its real
headers, median of 3, no GPU, mobile and desktop (CPU x3); every category must be >= 95 (B26).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 14: Infra: production deploys from CI, deploy triggers, and `meow.alxnko.eu.org` → `meow.alxnko.dev` (W-11, W-12, W-14, W-15, B24)

**Files:**
- Modify:
  - `.github/workflows/deploy.yml` (web step);
  - `.github/workflows/ci.yml` (a web job);
  - `infra/services.sh`, `infra/deploy-status.sh`;
  - `infra/cloudflare/deploy.tf` (paths), `infra/cloudflare/deploy-web.sh`,
    `infra/cloudflare/deploy-auth.sh`, `infra/cloudflare/deploy-meowsenger.sh`;
  - `infra/cloudflare/redirects.tf`.
- Create: `apps/web/src/lib/deploy-config.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - A Terraform change of exactly one resource, `cloudflare_ruleset.redirect_eu_org_to_dev`, updated
    in place. Task 15 applies it.
  - CI job `web`: build, budget, e2e with screenshots skipped.

Verified while writing this plan: `.github/workflows/deploy.yml`'s web step runs
`bunx wrangler pages deploy apps/web/dist --project-name meowerse-web --commit-hash …` without
`--branch main`, so a CI deploy would be a Preview, never production (W-11).
`infra/cloudflare/deploy-web.sh` already passes `--branch main`.

- [ ] **Step 1: Write the failing guard test**

`apps/web/src/lib/deploy-config.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Deploy wiring is easy to break silently; these guard the audit fixes (W-11, W-12, W-14, B24).
const root = join(__dirname, "../../../..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

describe("deploy config", () => {
  it("CI deploys web to production, not a preview (W-11)", () => {
    const y = read(".github/workflows/deploy.yml");
    const web = y.slice(y.indexOf("name: Deploy web"), y.indexOf("name: Deploy worker"));
    expect(web).toMatch(/wrangler pages deploy apps\/web\/dist --project-name meowerse-web --branch main /);
  });
  it.each(["web", "auth", "meowsenger"])("%s redeploys when packages/ui or packages/brand change (W-12)", (svc) => {
    const sh = new RegExp(`\\b${svc}\\)\\s+echo "([^"]+)"`).exec(read("infra/services.sh"))?.[1] ?? "";
    const tf = new RegExp(`\\b${svc} = \\{\\s*(?:#[^\\n]*\\n\\s*)*paths\\s*=\\s*"([^"]+)"`).exec(read("infra/cloudflare/deploy.tf"))?.[1] ?? "";
    for (const paths of [sh, tf]) {
      expect(paths, svc).toContain("packages/ui");
      expect(paths, svc).toContain("packages/brand");
    }
    expect(read(`infra/cloudflare/deploy-${svc}.sh`)).toMatch(/git status --porcelain -- [^|]*packages\/ui packages\/brand/);
  });
  it("deploy-status covers every service (W-14)", () =>
    expect(read("infra/deploy-status.sh")).toContain("for svc in api web worker auth meowsenger; do"));
  it("meow.alxnko.eu.org redirects to meow.alxnko.dev, not alxnko.dev (B24, W-15)", () => {
    const tf = read("infra/cloudflare/redirects.tf");
    expect(tf).toContain('expression  = "http.host == \\"meow.alxnko.eu.org\\""');
    expect(tf).toContain('expression = "concat(\\"https://meow.alxnko.dev\\", http.request.uri.path)"');
    expect(tf).toContain('expression  = "http.host in {\\"alxnko.eu.org\\" \\"www.alxnko.eu.org\\"}"');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && bunx vitest run src/lib/deploy-config.test.ts`

Expected: FAIL on every case.

- [ ] **Step 3: The fixes**

In `.github/workflows/deploy.yml`, replace the web step's `run:` block with:

```yaml
        run: |
          set -euo pipefail
          bun run --filter @meowerse/web build
          # --branch main is required: the Pages project's production branch is "main" and this repo's
          # default branch is master, so without it wrangler makes a Preview deploy (W-11).
          bunx wrangler pages deploy apps/web/dist --project-name meowerse-web --branch main --commit-hash "$(git rev-parse HEAD)"
          bash infra/record-deploy.sh web "run-${{ github.run_id }}"
```

In `infra/services.sh`, replace the web, auth and meowsenger cases with:

```bash
    web)      echo "apps/web packages/ui packages/brand" ;;
    auth)     echo "workers/auth apps/auth-web packages/auth-shared packages/ui packages/brand" ;; # one Worker: UI assets + OIDC IdP
    meowsenger)     echo "workers/meowsenger apps/meowsenger-web packages/auth-shared packages/auth-sdk packages/ui packages/brand" ;; # one Worker: UI assets + BFF
```

`apps/web` never used `packages/ts-shared` (W-12), so web drops it.

In `infra/cloudflare/deploy.tf` `locals.services`, set the same three `paths`:

```hcl
    web = {
      paths  = "apps/web packages/ui packages/brand"
      script = "infra/cloudflare/deploy-web.sh"
    }
```

```hcl
      paths  = "workers/auth apps/auth-web packages/auth-shared packages/ui packages/brand"
```

```hcl
      paths  = "workers/meowsenger apps/meowsenger-web packages/auth-shared packages/auth-sdk packages/ui packages/brand"
```

The last two replace the `paths` line of `auth` and of `meowsenger`; keep their comment lines.

In `infra/cloudflare/deploy-web.sh`:
- replace the dirty-check line with
  `if git status --porcelain -- apps/web packages/ui packages/brand | grep -q .; then`;
- in the `--branch main` comment, replace `production (meow.alxnko.eu.org) never` with
  `production (meow.alxnko.dev) never`.

In `infra/cloudflare/deploy-auth.sh`, replace its `git status --porcelain -- …` path list with
`workers/auth apps/auth-web packages/auth-shared packages/ui packages/brand`. In
`infra/cloudflare/deploy-meowsenger.sh`, use
`workers/meowsenger apps/meowsenger-web packages/auth-shared packages/auth-sdk packages/ui packages/brand`.

In `infra/deploy-status.sh`, replace the two `printf` formats and the loop header:

```bash
printf '%-11s %-10s %-10s %-6s %s\n' SERVICE DEPLOYED SOURCE DIRTY STATUS
for svc in api web worker auth meowsenger; do
```

```bash
  printf '%-11s %-10s %-10s %-6s %s\n' "$svc" "$dep" "$src" "$dirty" "$status"
```

In `infra/cloudflare/redirects.tf`, replace the whole first rule object, the one with
`ref = "redirect_apex_to_dev"`, with these two:

```hcl
    {
      ref         = "redirect_apex_to_dev"
      description = "Redirect apex/www to alxnko.dev"
      expression  = "http.host in {\"alxnko.eu.org\" \"www.alxnko.eu.org\"}"
      action      = "redirect"
      action_parameters = {
        from_value = {
          status_code = 308
          target_url = {
            expression = "concat(\"https://alxnko.dev\", http.request.uri.path)"
          }
          preserve_query_string = true
        }
      }
      enabled = true
    },
    {
      ref         = "redirect_meow_to_dev"
      description = "Redirect meow to meow.alxnko.dev (B24)"
      expression  = "http.host == \"meow.alxnko.eu.org\""
      action      = "redirect"
      action_parameters = {
        from_value = {
          status_code = 308
          target_url = {
            expression = "concat(\"https://meow.alxnko.dev\", http.request.uri.path)"
          }
          preserve_query_string = true
        }
      }
      enabled = true
    },
```

Keep the `meow` CNAME in `dns.tf` and the Pages custom domain. The proxied record is what brings
`meow.alxnko.eu.org` traffic to the zone, where this redirect runs before Pages (W-15).

Add a CI job to `.github/workflows/ci.yml`, as a sibling of `test:` under `jobs:`:

```yaml
  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Install Chromium for Playwright
        working-directory: apps/web
        run: bunx playwright install --with-deps chromium

      - name: Build meow.alxnko.dev (postbuild CSP + guards)
        run: bun run --filter @meowerse/web build

      - name: Byte budgets
        run: bun run --filter @meowerse/web budget

      - name: e2e (screenshots are compared locally only)
        run: bun run --filter @meowerse/web e2e
```

- [ ] **Step 4: Check the shell and the workflow files**

```bash
(cd apps/web && bunx vitest run src/lib/deploy-config.test.ts)
bash -n infra/services.sh infra/deploy-status.sh infra/cloudflare/deploy-web.sh infra/cloudflare/deploy-auth.sh infra/cloudflare/deploy-meowsenger.sh
python3 -c "import yaml; [yaml.safe_load(open(f)) for f in ('.github/workflows/deploy.yml', '.github/workflows/ci.yml')]; print('yaml ok')"
bash infra/deploy-status.sh
```

Expected: the test passes, the syntax checks are silent, `yaml ok` prints, and `deploy-status` lists
five services.

- [ ] **Step 5: Terraform: format, validate, and a plan that changes exactly one resource**

The plan is read-only. `-var deploy_apps=false` keeps it from computing any app deploy, and
`-target` limits it to the ruleset.

```bash
cd infra/cloudflare
terraform fmt -check
bash -c 'set -a; source /home/alxnko/Projects/code/meow/meowerse/.env; set +a
  export TF_VAR_cloudflare_account_id="$CLOUDFLARE_ACCOUNT_ID" TF_VAR_cloudflare_zone_id="$CLOUDFLARE_ZONE_ID"
  terraform init -input=false && terraform validate &&
  terraform plan -input=false -var deploy_apps=false -target=cloudflare_ruleset.redirect_eu_org_to_dev -out=/var/tmp/brand-v2/sp2/b24.tfplan'
terraform show -no-color /var/tmp/brand-v2/sp2/b24.tfplan | tee /var/tmp/brand-v2/sp2/b24-plan.txt | rg -n 'will be|Plan:|redirect_meow_to_dev|meow.alxnko'
cd ../..
```

Expected:
- `Plan: 0 to add, 1 to change, 0 to destroy.`;
- `cloudflare_ruleset.redirect_eu_org_to_dev will be updated in-place`;
- the apex rule's expression loses `"meow.alxnko.eu.org"`, and a new rule `redirect_meow_to_dev`
  targets `https://meow.alxnko.dev`.

If the plan shows anything else, stop. Don't apply; report the diff. The plan file is applied in
Task 15, after the merge.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/deploy.yml .github/workflows/ci.yml infra apps/web/src/lib/deploy-config.test.ts
git commit -m "ci(infra): production web deploys from CI, ui/brand deploy triggers, meow.alxnko.eu.org → meow.alxnko.dev

The CI web step now passes --branch main, so it updates production instead of making a
preview (W-11). packages/ui and packages/brand count as web, auth and meowsenger sources in
services.sh, deploy.tf and the deploy scripts' dirty checks (W-12); deploy-status lists all
five services (W-14). The eu.org redirect rule is split so meow.alxnko.eu.org goes to
meow.alxnko.dev instead of alxnko.dev (B24, W-15). CI builds the web app, runs the byte budget
and the e2e suite. A test guards all of it.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Verify, review, PR, merge, deploy, apply B24, live check

**Files:**
- Modify:
  - `docs/superpowers/specs/2026-09-24-brand-v2-design.md` (§6: the sub-project 2 disposition);
  - `docs/superpowers/decisions/2026-09-24-brand-v2-log.md` (status column; new row B29).

- [ ] **Step 1: Bring the branch up to date**

```bash
git fetch origin
git merge --no-ff origin/master -m "Merge origin/master into feat/brand-v2-sp2"   # only if master moved; resolve, then re-run everything below
```

- [ ] **Step 2: Full verification** (skill: superpowers:verification-before-completion)

```bash
bun install --frozen-lockfile
bun run lint && bun run test && bun run build
bun run --filter @meowerse/ui tokens:check
git -C /home/alxnko/Projects/code/meow/alxnko.dev fetch origin
ALXNKO_DEV_DIR=/home/alxnko/Projects/code/meow/alxnko.dev/.claude/worktrees/cat-tokens bun run --filter @meowerse/ui tokens:drift
bun run --filter @meowerse/web budget | tee /var/tmp/brand-v2/sp2/budget.txt
bun run --filter @meowerse/web e2e
bun run --filter @meowerse/web lighthouse | tee /var/tmp/brand-v2/sp2/lighthouse.txt
```

Expected: every command is green.
- Coverage is ≥ 90 for ui and for web `src/lib`.
- The drift check prints `tokens in sync with alxnko.dev`. Once the alxnko.dev PR from Task 2 has
  merged, point `ALXNKO_DEV_DIR` at a checkout of alxnko.dev's `origin/main` instead.
- The e2e run includes the screenshots.
- Lighthouse is ≥ 95 everywhere, or the playground-only exception from Task 13 is recorded.

Then check by hand, in Chromium at 390 px and 1440 px, dark and light:
- `/`, one project page, `/ui/`, a component page, the gallery, the together page and the
  playground;
- tab through each page: the focus ring is visible everywhere, and nothing unreachable gets focus;
- type "Hello ПРИВЕТ Cats & Co" into the composer demo: it is shown exactly as typed;
- there is no horizontal overflow;
- the cohesion checklist: at most one tty accent per region, one green action per view outside
  the specimen pages, and tty and app controls in one row share their geometry.

- [ ] **Step 3: Independent review against the spec** (skill: superpowers:requesting-code-review)

Give the reviewer:
- the spec;
- the log;
- the audit `docs/superpowers/audits/2026-09-24-web-and-ui.md`;
- this plan;
- `git diff master...HEAD`.

Ask it to check:
- every Global Constraint: CSP, Trusted Types, no style attributes, links, B9, B14, B10, budgets;
- the public-facts rule on all six project pages, word by word against the sources named in
  Task 4 Step 5. There must be no network, Tailscale, IP or pairing detail on the moonmeow and
  sunmeow pages, and no real name or company on the alxnko.dev page;
- that `/ui` data is generated, with nothing hand-copied from the source;
- that the W-xx dispositions below are true;
- that auth-web and meowsenger-web still build and behave, since the shared ui changed (Icon,
  Avatar, fonts, tokens.gen, Cat3D subpath).

Fix every confirmed finding in new commits.

- [ ] **Step 4: Update the spec and the log**

In spec §6, after "### 6.2 Sub-project 1 disposition", add:

```markdown
### 6.3 Sub-project 2 disposition

Closed in sub-project 2:
- W-01, W-02, W-03, W-04, W-05, W-06, W-07, W-08, W-10, W-11, W-12, W-14, W-15, W-16, W-17;
- W-09, except the note below;
- U-15 and U-28 (ui, needed by the site's axe and Trusted Types gates).
- SP1 deferrals: unused Cat3D assets in app dist, cat colour tokens, `assetsInlineLimit: 0`, and the
  Modal `display:none`/`visibility:hidden` Playwright test.

Deferred, with reasons:
- **W-09 (part):** `Access-Control-Allow-Origin: *` on HTML is a Cloudflare Pages default that
  `_headers` can't remove. It's harmless for public static pages.
- **W-13 / B23:** Cloudflare Web Analytics and JS detections are zone and dashboard settings. The
  strict CSP blocks their scripts; the toggles are the owner's. Live status is in the PR.
- **W-18:** the meows API has no browser consumer after B16. Dropping its
  `Access-Control-Allow-Credentials` belongs to `workers/api`, in sub-project 5.
- **W-19 (part):** security.txt is now canonical for meow.alxnko.dev. Which contact address is
  canonical is the owner's call.
- **Together pairing 10 (menus, drawers):** those components move into `@meowerse/ui` with meowsenger
  in sub-project 4 (audit D-5, D-6).
- **Real-phone check of Cat3D finger tracking:** an owner check on a real device (below).
```

In the log:
- set the status of B4 (hero part), B9 (web), B10 (together page and screenshot tests), B11, B12,
  B12a, B13, B16, B24 and B26 (web) to "Done in PR #N (sub-project 2)";
- append:

```
| B29 | (sub-project 2 plan and implementation) | Decisions made while building meow.alxnko.dev: (1) screenshot baselines are compared locally, not in CI, because runner fonts differ (same deviation as B28); the Lighthouse gate is local too (noisy), while the byte budget and the functional e2e run in CI; (2) projects with no public service (the ui library, moonmeow, sunmeow) show a static `[info]` line saying so, instead of a fake live check; (3) meowsenger's `/health` answers any origin without credentials so its status can be read cross-origin; auth is read through its already public OIDC discovery document; (4) a status that can't get an answer is "unknown", never "down"; (5) "links open in a new tab" is read as links to other origins; mailto never, same-site never; (6) project prose keeps sentence case, interface copy is lowercase (SP1 ruling); (7) the docs extractor is the TypeScript compiler API. | Decided |
```

Commit: `docs(brand-v2): record sub-project 2 status and decisions`.

- [ ] **Step 5: PR, CI, merge**

```bash
git push -u origin feat/brand-v2-sp2
gh pr create --base master --title "brand v2 · sub-project 2: meow.alxnko.dev redesign, project pages, /ui docs" --body "$(cat <<'EOF'
Implements sub-project 2 of docs/superpowers/specs/2026-09-24-brand-v2-design.md (decisions B1–B29), per docs/superpowers/plans/2026-09-24-brand-v2-sp2-web.md.

- meow.alxnko.dev rebuilt on @meowerse/ui v2: wordmark + Cat3D hero, `ls ~/services` live status (timeout, unknown ≠ down), the six project pages (B11, B13), no write demo (B16)
- /ui: foundations, 26 component pages generated from the TypeScript source (props, CSS variables, snippets), demos, gallery (dark/light side by side), the twelve tty/app pairings, forms/states/composer patterns, Cat3D, playground (state in the URL)
- one strict hash-based CSP with Trusted Types enforced, HSTS, Permissions-Policy, COOP/CORP, noindex on *.pages.dev; one inlined stylesheet; fonts preloaded
- ui: Icon without innerHTML (U-28), Avatar as a named image (U-15), Cat3D attach without React and out of the barrel, cat colours as tokens, scoped themes, fallback font
- meowsenger /health: public CORS, no-store (for the status probe)
- infra: CI web deploy --branch main (W-11), ui/brand deploy triggers (W-12), deploy-status for all services (W-14), meow.alxnko.eu.org → meow.alxnko.dev (B24, W-15; applied after merge)

Closes: W-01 W-02 W-03 W-04 W-05 W-06 W-07 W-08 W-09 (part) W-10 W-11 W-12 W-14 W-15 W-16 W-17 W-19 (part), U-15, U-28; SP1 deferrals (unused Cat3D assets, cat colour tokens, assetsInlineLimit, Modal hidden-control test).
Deferred with reasons (spec §6.3): W-09 ACAO default, W-13/B23 dashboard toggles, W-18 (sub-project 5), W-19 contact address (owner), pairing 10 menus/drawers (sub-project 4), real-phone Cat3D check (owner).

Budgets (bun run --filter @meowerse/web budget):
<paste /var/tmp/brand-v2/sp2/budget.txt>

Lighthouse (median of 3, no GPU; desktop CPU×3):
<paste /var/tmp/brand-v2/sp2/lighthouse.txt>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr checks --watch
```

Replace the two `<paste …>` lines with the files' contents before running `gh pr create`: write the
body to `/var/tmp/brand-v2/sp2/pr.md` and use `--body-file`. Then set the PR number in the log (the
"PR #N" placeholders from Step 4), commit, push, and wait for CI again.

Before merging, the alxnko.dev tokens PR from Task 2 must be merged; the controller does that. Then:

```bash
gh pr merge --merge
```

Expected: CI is green, and the PR merges with a merge commit.

- [ ] **Step 6: Deploy from a clean worktree of the merged master** (owner-authorised)

```bash
cd /home/alxnko/Projects/code/meow/meowerse
git fetch origin
git worktree add --detach .claude/worktrees/sp2-deploy origin/master
cd .claude/worktrees/sp2-deploy
bun install --frozen-lockfile
ENV=/home/alxnko/Projects/code/meow/meowerse/.env
bash -c "set -a; source $ENV; set +a; bash infra/cloudflare/deploy-meowsenger.sh"
bash -c "set -a; source $ENV; set +a; bash infra/cloudflare/deploy-web.sh"
bash -c "set -a; source $ENV; set +a; bash infra/cloudflare/deploy-auth.sh"
```

This is the `just deploy-*` equivalent. meowsenger goes first because the web status list reads its
new `/health`. Auth is redeployed because `packages/ui` changed. Each script refuses a dirty tree and
records the deploy in this worktree's `infra/deploy-state.json`. Note the recorded SHAs for the PR
comment, and don't copy the file into the main checkout.

- [ ] **Step 7: Apply B24** (owner's standing authorisation for this change)

Apply the saved, reviewed plan. It changes the one ruleset and nothing else, and doesn't prompt. If
Terraform says the plan is stale (the state moved since Task 14), re-run Task 14 Step 5 in this
worktree, check that it again shows exactly `1 to change`, and apply the new file.

```bash
cd infra/cloudflare
bash -c 'set -a; source /home/alxnko/Projects/code/meow/meowerse/.env; set +a
  export TF_VAR_cloudflare_account_id="$CLOUDFLARE_ACCOUNT_ID" TF_VAR_cloudflare_zone_id="$CLOUDFLARE_ZONE_ID"
  terraform init -input=false && terraform apply -input=false /var/tmp/brand-v2/sp2/b24.tfplan'
cd ../..
```

Expected: `Apply complete! Resources: 0 added, 1 changed, 0 destroyed.`

- [ ] **Step 8: Live check**

```bash
curl -sI https://meow.alxnko.dev/ | rg -i '^(content-security-policy|strict-transport|permissions-policy|cross-origin-opener|referrer-policy|x-content-type)'
curl -sI 'https://meow.alxnko.eu.org/p/auth/?x=1' | rg -i '^(HTTP|location)'
curl -s -D- -o /dev/null -H 'Origin: https://meow.alxnko.dev' https://meowsenger.alxnko.dev/health | rg -i '^(HTTP|access-control|cache-control)'
curl -s https://meow.alxnko.dev/ | rg -c 'cloudflareinsights|challenge-platform|email-decode' || echo 0
curl -sI https://alxnko.dev/ | rg -i '^content-security-policy' | head -c 80; echo
```

Expected:
- the CSP has `sha256-` hashes and `require-trusted-types-for 'script'`, together with HSTS,
  Permissions-Policy, COOP, `Referrer-Policy: no-referrer` and nosniff;
- the eu.org request answers `HTTP/2 308` with `location: https://meow.alxnko.dev/p/auth/?x=1`;
- `/health` answers `access-control-allow-origin: *` and `cache-control: no-store`;
- `0` Cloudflare-injected scripts. If there are any, B23's dashboard toggles are still on: the CSP
  blocks them, and you report it to the owner with the toggle steps from alxnko.dev R79;
- alxnko.dev's own CSP is unchanged.

Then run a live browser pass. Write this file to `/var/tmp/brand-v2/sp2/live.ts`:

```ts
// Live pass: pages × phone/desktop × dark/light; console errors and CSP violations; the probes resolve.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = "/var/tmp/brand-v2/sp2/live";
mkdirSync(OUT, { recursive: true });
const PAGES = ["/", "/p/auth/", "/p/moonmeow/", "/ui/", "/ui/components/button/", "/ui/patterns/together/", "/ui/playground/?c=button&p.variant=primary"];
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
const problems: string[] = [];
for (const [vp, size] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1440, height: 900 }]] as const) {
  for (const theme of ["dark", "light"] as const) {
    const ctx = await browser.newContext({ viewport: size, colorScheme: theme, isMobile: vp === "phone", hasTouch: vp === "phone" });
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error") problems.push(`${vp}/${theme} ${page.url()}: ${m.text()}`); });
    await page.addInitScript(() => addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective} ${e.blockedURI}`)));
    for (const path of PAGES) {
      await page.goto(`https://meow.alxnko.dev${path}`, { waitUntil: "networkidle" });
      if (path === "/") {
        await page.waitForFunction(() => !document.querySelector(".services .mw-status--wait"), undefined, { timeout: 10_000 });
        const statuses = await page.locator(".services .mw-status").allTextContents();
        if (!statuses.every((s) => s.includes("[ ok ]"))) problems.push(`${vp}/${theme}: services not all up: ${statuses.join(" | ")}`);
      }
      await page.screenshot({ path: `${OUT}/${vp}-${theme}${path.replace(/[/?&=.]/g, "_")}.png`, fullPage: true });
    }
    await ctx.close();
  }
}
await browser.close();
console.log(problems.length ? problems.join("\n") : "live: no console errors, no CSP violations, all services up");
```

Run it from the web workspace, so `@playwright/test` resolves:

```bash
cp /var/tmp/brand-v2/sp2/live.ts apps/web/live.tmp.ts && (cd apps/web && bun live.tmp.ts); rm apps/web/live.tmp.ts
```

Expected: `live: no console errors, no CSP violations, all services up`. The one known exception is
a Cloudflare-injected script blocked by the CSP (B23); report it. Look at every screenshot in
`/var/tmp/brand-v2/sp2/live/`.

Also check that the other apps still work after the ui change:
- `https://auth.alxnko.dev/login` and `https://meowsenger.alxnko.dev/` load at phone and desktop;
- there are no new console errors;
- icons render and avatars look as before.

Finally, the real-phone check of Cat3D finger tracking (an SP1 deferral). Ask the owner to open
https://meow.alxnko.dev/ on a phone and drag a finger around the cat: the head should follow while
the finger moves, and page scrolling should still work. Record the answer on the PR. Until then it
stays listed as an owner check.

- [ ] **Step 9: Report and clean up**

- Comment on the PR with:
  - the deploy SHAs and the Pages deployment id;
  - the applied B24 change;
  - the live-check results;
  - any B23 finding.
- Remove the worktrees (`git worktree remove .claude/worktrees/brand-v2-sp2`,
  `.claude/worktrees/sp2-deploy`, and alxnko.dev's `.claude/worktrees/cat-tokens` once its PR has
  merged).
- Delete `/var/tmp/brand-v2/sp2/` except `budget.txt`, `lighthouse.txt` and `b24-plan.txt`, which
  the controller may keep.
- Tell the controller the new rollback point: the previous `meowerse-web` production deployment id,
  from `bunx wrangler pages deployment list --project-name meowerse-web`, taken before Step 6.

---

## Self-review

**1. Spec coverage** (spec section → task):
- **§3 gallery → the public `/ui` docs:**
  - every component in every state: Tasks 8, 9;
  - dark and light side by side (`/ui/gallery/`): Task 9;
  - phone and desktop screenshot tests: Task 12.
- **§4 Cat3D:**
  - in the hero: Task 5;
  - lazy after first paint, when visible: Tasks 2, 5;
  - fallback: Tasks 2, 11;
  - `aria-hidden`: Task 2;
  - no React on the home page: Task 2 (`attachCat3D`);
  - the real-phone finger check: Task 15.
- **§5 web:**
  - wordmark + cat hero, and the `ls ~/services` status with a timeout and unknown: Tasks 4, 5;
  - full redesign (B12a): Tasks 3–11;
  - B16 demo removed: Task 3.
- **§5.1 project pages:**
  - `/p/<slug>`: Task 4;
  - summary, what, how + SVG diagram in both themes, live status with a timeout, and an "open"
    link in a new tab: Task 4;
  - typed content validated at build (content collection + zod + a unit test): Task 4;
  - public facts only, with a guard test: Task 4;
  - six projects (B13): Task 4.
- **§5.2 UI docs:**
  - **Foundations:** tokens with swatches in both themes, type, spacing, radii, motion with live
    demos, z, voice, contrast: Task 7.
  - **Components:** live variants and states (Task 8), props and CSS-variable tables generated
    from the source (Tasks 6, 8), React + HTML snippets (Tasks 6, 8), a11y notes (Task 8),
    do/don't (Task 8).
  - **Playground:** theme, props, token overrides, URL state, never a server: Task 10.
  - **Patterns:** together (B10), forms, states (B9), composer: Task 11.
  - **Cat3D demo with its fallback:** Task 11.
  - **Static and prerendered, lazy islands only for previews and the playground:** Tasks 3, 9, 10.
    The budget test asserts no React on pages without islands.
- **§6 W-xx:**
  - closed: Tasks 3, 4, 5, 14, 15;
  - deferred with reasons: Task 15 Step 4;
  - SP1 deferrals to SP2: Tasks 2, 3, 9, 15.
- **§7/§7.1:**
  - composer and bubble geometry (Tasks 9, 11), the pairings page (Task 11), screenshots (Task 12);
  - cohesion review: Task 15.
- **§8 (B9):**
  - probes with timeout, unknown and retry (Task 4);
  - the island watchdog (Task 10);
  - copy failures shown (Task 7);
  - states page (Task 11);
  - pageshow re-check (Task 4).
- **§9:**
  - unit, component and Playwright tests incl. network faults (probes: Task 4);
  - screenshots: Task 12;
  - contrast: Tasks 1, 7;
  - drift check: Tasks 2, 15;
  - Lighthouse and budgets: Task 13;
  - CSP, HSTS, `frame-ancestors`, Referrer-Policy, Permissions-Policy and `noopener`: Task 3,
    with the links spec;
  - process: Task 15.
- **B24:** Task 14 (code + plan), Task 15 (apply + live).
- **B26:**
  - inline critical CSS hashed: Task 3;
  - font preload: Task 3;
  - no long tasks (the Lighthouse gate): Task 13;
  - 44 px targets (the a11y spec): Task 3;
  - no CF-injected scripts: Task 3 (email_off, CSP) and Task 15 (live);
  - Trusted Types: Tasks 1, 3;
  - Lighthouse ≥ 95: Task 13.

**2. Placeholder scan:**
- **No TBD or TODO.** Every code step has complete code.
- **Two literal markers are meant to be replaced during execution:**
  - "PR #N" in the log, filled once the PR number exists (Task 15 Step 5);
  - the `<paste …>` lines in the PR body, filled from files the gates wrote (Task 15 Step 5).
- **The Icon map is converted by a codemod**, not retyped. It was checked against the current
  `Icon.tsx` while planning: 36 icons, no string left.

**3. Type consistency:**
- **Probes and status:** `ProbeResult`, `describeProbe`, `setStatus` and `runProbes` (Task 4) are
  used with the same signatures in Tasks 5 and 10 (`setStatus` in the watchdog).
- **Docs data:** `ComponentDoc`/`PropDoc` (Task 6) feed `specsFromDoc` (Task 10) and `PropsTable`
  (Task 8).
- **Registry:** `nodeOf`, `RegisteredPage` and `COMPONENT_PAGES` (Task 8) feed `Preview.astro` and
  the gallery (Task 9).
- **`docsNav`:** it grows in Tasks 8, 9, 10 and 11, with its test updated in each. `utilities`
  stays last.
- **Cat3D:** `attachAllCat3D` skips `.mw-cat3d--static` (Task 2), which Task 11 uses.
- **Theme scopes:** `mw-theme--dark` and `mw-theme--light` (Task 1) are used by the gallery
  (Task 9) and `themeClass` (Task 10).
- **Budgets:** `BUDGETS` (Task 13) matches the Global Constraints table.
