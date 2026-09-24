# Brand v2, sub-project 1: design system v2 + Cat3D + shared fixes. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Move `@meowerse/ui` onto the alxnko.dev design system: tokens, fonts, restyled components, and the
  new tty components plus Cat3D.
- Fix the shared root causes the audits found: the global lowercase, `useSession`, requests, `Modal`
  focus, and contrast.
- Retire the legacy `apps/alxnko-dev` first.

All three apps keep working unchanged through legacy aliases.

**Architecture:**
- **Token source:** `packages/ui/design/tokens.json`, a copy of alxnko.dev's `design/tokens.json`
  plus the B17 additions. A generator writes `tokens.gen.css`, whose variable names match
  alxnko.dev's `--c-*`, `--sp-*`, `--r-*`, `--fs-*`, `--z-*`, `--d-*`.
- **Legacy aliases:** `aliases.css` maps every legacy `--mw-*` / `--surface-*` / `--text-*` /
  `--radius*` / `--font-*` variable onto the new tokens. The apps restyle automatically and are
  migrated properly in sub-projects 2–4.
- **Request layer:** one `request()` helper (timeout, `res.ok`, typed result) underlies `useSession`,
  and the apps adopt it later.
- **Cat3D:** a dependency-free WebGL2 island, lazy-loaded, drawing a mesh extracted from alxnko.dev's
  `desk.glb`.

**Tech Stack:** Bun 1.3.14 workspaces, turbo, React 19, vitest 4 + Testing Library (jsdom), Astro 7
consumers, `@fontsource/jetbrains-mono`, `@fontsource/vt323`, fonttools `pyftsubset`,
`@gltf-transform/core` + `meshoptimizer` (build-time only), Playwright (build-time poster and visual
check).

**Spec:** `docs/superpowers/specs/2026-09-24-brand-v2-design.md`. Decision log:
`docs/superpowers/decisions/2026-09-24-brand-v2-log.md` (B1–B25). Audits: `docs/superpowers/audits/`.

## Global Constraints

Every task's requirements implicitly include this section.

**Git and process:**
- Worktree `meowerse/.claude/worktrees/brand-v2-ds`, branch `feat/brand-v2-ds`, created from
  `docs/brand-v2` so the PR carries the spec, log and audits too.
- One PR for this sub-project into `master`, merged with a merge commit, never a squash.
- Never `--no-verify`.
- Commit messages use Conventional Commits and end with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Heavy or build scratch goes to `/var/tmp/brand-v2/…`, never `/tmp` (RAM).
- Don't touch other sessions' repos (moonmeow, sunmeow). Don't kill servers you didn't start. Local
  dev ports for this plan are 4370–4379.

**Design rules:**
- Colours come only from tokens. Dark is the default and follows the system; there's a light "day
  paper" theme.
- Green (`--c-accent-fill`) is used only for the primary action, focus and live/ok. Never two green
  buttons in a view, and never `accentFill` as text on light.
- Radii are only 2/4/8 px. Spacing is only 0 4 8 12 16 24 32 48 64. Type scale is 12 13 14 16 20 28
  40, and inputs are ≥ 16 px.
- Every interactive element gets a 2 px focus ring in `--c-focus` with a 2 px offset. Targets are
  ≥ 44×44 px. `prefers-reduced-motion` removes non-essential motion.
- Text contrast is AA (≥ 4.5:1, or 3:1 for ≥ 20 px bold / UI borders), enforced by a test.
- **B14:** there's no global `text-transform`. We write our own copy in lowercase in the source, and
  user content is shown exactly as typed.
- **B9 and B18:** a control never looks ready while its background work isn't done. Every async wait
  has a visible state, a timeout, a plain-language error and a retry. "Signed out" means only a real
  401 or `authenticated:false`, never a network error, 5xx or timeout.
- **B10 cohesion:** tty elements (Prompt, StatusLine, Kbd, Wordmark) share `--control-height` 44 px,
  1 px `--c-line-input` border, `--r-m` 4 px radius, the focus ring and the disabled style with
  Field and Button.
- Public copy never contains the real name, the company or coordinates.
- Links open in a new tab except `mailto:`.

**Existing component APIs stay source-compatible:** all 20 exports keep their prop names; only
additive props are allowed.

**Budgets:**
- JetBrains Mono (400+700 Latin+Cyrillic+symbols) plus the VT323 mark subset ≤ 110 KB woff2 in total
  shipped per page.
- Cat3D renderer chunk ≤ 8 KB gz; `cat.bin` ≤ 25 KB.

**Coverage:** the ui coverage gate stays at ≥ 90 for branches, functions, lines and statements.

---

## File structure

```
packages/ui/
  design/tokens.json                  NEW  source of truth (alxnko.dev copy + B17 keys)
  scripts/gen-tokens.ts               NEW  tokens.json → src/styles/tokens.gen.css (--check = drift)
  scripts/tokens-drift.ts             NEW  compares shared keys with alxnko.dev's tokens.json
  scripts/subset-fonts.sh             NEW  VT323 wordmark subset + JetBrains Mono symbols subset
  scripts/extract-cat.ts              NEW  desk.glb → src/cat3d/cat.bin
  scripts/cat-poster.ts               NEW  Playwright render of the rest pose → src/cat3d/cat-poster.webp
  src/styles/tokens.css               MOD  imports only: fonts, tokens.gen, aliases, base, layout, components
  src/styles/tokens.gen.css           NEW  generated, committed
  src/styles/aliases.css              NEW  legacy variable names → new tokens (removed in sub-project 5)
  src/styles/global.css               NEW  reset, body, focus ring, reduced motion (moved out of tokens.css)
  src/styles/fonts.css                MOD  JetBrains Mono 400/700 + symbols + VT323 marks
  src/styles/components.css           MOD  every component restyled on the new tokens
  src/assets/fonts/*.woff2            NEW  jetbrains-mono-symbols-400.woff2, vt323-marks.woff2
  src/lib/request.ts                  NEW  request<T>() with timeout + typed result
  src/lib/useSession.ts               MOD  built on request(); error state; refreshSession()
  src/components/AuthGate.tsx         MOD  error state with retry, redirect only when truly signed out
  src/components/AppHeader.tsx        MOD  neutral nav while loading/error (no false "log in")
  src/components/Modal.tsx            MOD  latest-onClose ref; focusables exclude disabled/hidden
  src/components/ConfirmDialog.tsx    MOD  phrase shown in <code> exactly as required
  src/components/{Wordmark,Cursor,Kbd,StatusLine,Prompt}.tsx   NEW
  src/cat3d/{math.ts,renderer.ts,Cat3D.tsx,cat.bin,cat-poster.webp}  NEW
  src/index.ts                        MOD  new exports
apps/alxnko-dev/                      DEL
infra/cloudflare/deploy-alxnko-dev.sh DEL
packages/brand/scripts/build.sh       MOD  drop the alxnko-dev distribute line
.github/workflows/deploy.yml          MOD  packages/ui + packages/brand changes redeploy web/auth/meowsenger
justfile                              MOD  `tokens`, `tokens-drift` recipes
```

The alxnko.dev repo gets a separate small PR (Task 11) that adds the B17 keys to its
`design/tokens.json`.

---

### Task 0: Worktree

**Files:** none

- [ ] **Step 1: Create the worktree from the docs branch**

```bash
cd /home/alxnko/Projects/code/meow/meowerse
git fetch origin
git worktree add .claude/worktrees/brand-v2-ds -b feat/brand-v2-ds docs/brand-v2
cd .claude/worktrees/brand-v2-ds
bun install --frozen-lockfile
bun run --filter @meowerse/ui test
```

Expected: the install succeeds and the existing 57 ui tests pass.

---

### Task 1: Retire `apps/alxnko-dev` (B15, audit §3, L-01..L-05)

**Files:**
- Delete: `infra/cloudflare/deploy-alxnko-dev.sh`, `apps/alxnko-dev/` (whole tree)
- Modify: `packages/brand/scripts/build.sh:88`, `bun.lock`, any docs that mention it

**Interfaces:** Produces: nothing consumed later. Removes the only script that can overwrite live
alxnko.dev.

- [ ] **Step 1: Delete the deploy script first**

```bash
git rm infra/cloudflare/deploy-alxnko-dev.sh
git commit -m "chore(infra): remove legacy alxnko-dev deploy script (B15, L-01)

It targets Pages project alxnko-dev, which now serves the live desk site from the
alxnko.dev repo; one run would overwrite production.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 2: Remove the app, the brand line and the lockfile entry**

```bash
git rm -r apps/alxnko-dev
sed -i '/^distribute alxnko-dev /d' packages/brand/scripts/build.sh
bun install
bash packages/brand/scripts/build.sh
```

Expected: the brand build prints `distributing:` followed by exactly web, auth-web and
meowsenger-web, and exits 0.

- [ ] **Step 3: Grep for leftovers and reword them**

```bash
rg -n "alxnko-dev|@alxnko/web|alxnko-theme" --glob '!bun.lock' --glob '!docs/superpowers/audits/**' --glob '!docs/superpowers/decisions/**' --glob '!docs/superpowers/specs/**' --glob '!docs/superpowers/plans/**' .
```

Expected: no matches. If `README.md`, `infra/README.md` or `packages/brand/README.md` still mention
the app, reword those lines to say alxnko.dev lives in its own repo.

- [ ] **Step 4: Verify the workspace**

```bash
just lint && just test && just build
bunx turbo run build --dry=json | rg -c '@alxnko/web'
```

Expected: lint, test and build are all green, and the last command prints `0`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: retire apps/alxnko-dev (B15)

The live site is built from the separate alxnko.dev repo. Removes the app, its
brand-icon distribution and its lockfile entry.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Token source, generator, contrast test, legacy aliases (spec §2.1, B17)

**Files:**
- Create:
  - `packages/ui/design/tokens.json`
  - `packages/ui/scripts/gen-tokens.ts`
  - `packages/ui/src/styles/tokens.gen.css` (generated)
  - `packages/ui/src/styles/aliases.css`
  - `packages/ui/src/styles/global.css`
- Modify: `packages/ui/src/styles/tokens.css`, `packages/ui/package.json`
- Test: `packages/ui/scripts/gen-tokens.test.ts`

**Interfaces:**
- Produces CSS custom properties that every later task uses:
  - colours: `--c-bg --c-bg-elev --c-surface --c-surface-raised --c-line --c-line-strong
    --c-line-input --c-fg --c-fg-muted --c-fg-subtle --c-accent --c-accent-fill --c-on-accent
    --c-warn --c-danger --c-on-danger --c-danger-tint --c-ok --c-info --c-focus --c-scrim`;
  - scale: `--sp-1..--sp-8 --r-s --r-m --r-l --fs-1..--fs-7`;
  - layers: `--z-stage --z-chrome --z-dock --z-sheet --z-toast --z-skip`;
  - motion: `--ease --d-fast --d-base --d-slow`;
  - control: `--leading-tight --leading-normal --control-height --disabled-opacity`;
  - fonts: `--font-mono --font-mark`;
  - `ansi-*`.
- Produces `contrast(a: string, b: string): number` and `gen(t: Tokens): string` exported from
  `scripts/gen-tokens.ts`.

- [ ] **Step 1: Write `design/tokens.json`**

This is alxnko.dev's file plus the B17 keys. Take `primitive` and `ansi` verbatim with
`jq '{primitive, ansi}' ../../../../alxnko.dev/design/tokens.json`; the other groups are exactly:

```json
{
  "semantic": {
    "dark": {
      "bg": "#0a0a0b", "bgElev": "#111113", "surface": "#151517", "surfaceRaised": "#1a1a1d",
      "line": "#232326", "lineStrong": "#404044", "lineInput": "#6a6a70",
      "fg": "#ededeb", "fgMuted": "#b3b3af", "fgSubtle": "#8c8c88",
      "accent": "#00ff82", "accentFill": "#00ff82", "onAccent": "#06170d",
      "warn": "#ffb454", "danger": "#ff6b63", "onDanger": "#1a0605", "dangerTint": "#2a1513",
      "ok": "#3ddc84", "info": "#7cc4ff", "focus": "#00ff82", "scrim": "rgba(0, 0, 0, 0.6)"
    },
    "light": {
      "bg": "#e9e8e4", "bgElev": "#f1f0ec", "surface": "#dfded9", "surfaceRaised": "#f7f6f3",
      "line": "#cfcec8", "lineStrong": "#a9a8a2", "lineInput": "#7a7973",
      "fg": "#1a1a1c", "fgMuted": "#46464a", "fgSubtle": "#5e5e5b",
      "accent": "#0a6e3c", "accentFill": "#00ff82", "onAccent": "#06170d",
      "warn": "#8a5200", "danger": "#b42318", "onDanger": "#ffffff", "dangerTint": "#f6dcd8",
      "ok": "#11652f", "info": "#1d5fa8", "focus": "#0a6e3c", "scrim": "rgba(20, 20, 22, 0.4)"
    }
  },
  "space": [0, 4, 8, 12, 16, 24, 32, 48, 64],
  "radius": { "s": 2, "m": 4, "l": 8 },
  "type": { "scale": [12, 13, 14, 16, 20, 28, 40], "leading": { "tight": 1.2, "normal": 1.5 } },
  "control": { "height": 44, "disabledOpacity": 0.5 },
  "motion": { "ease": "cubic-bezier(.16,1,.3,1)", "fast": 120, "base": 240, "slow": 600 },
  "z": { "stage": 0, "chrome": 10, "dock": 20, "sheet": 30, "toast": 40, "skip": 100 }
}
```

- [ ] **Step 2: Write the failing test `scripts/gen-tokens.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import tokens from "../design/tokens.json";
import { contrast, gen } from "./gen-tokens";

type Pair = [fg: keyof typeof tokens.semantic.dark, bg: keyof typeof tokens.semantic.dark, min: number];
// Text pairs the components actually use; min is WCAG AA (4.5 text, 3 UI/borders).
const PAIRS: Pair[] = [
  ["fg", "bg", 4.5], ["fg", "bgElev", 4.5], ["fg", "surface", 4.5], ["fg", "surfaceRaised", 4.5],
  ["fgMuted", "bg", 4.5], ["fgMuted", "surface", 4.5], ["fgSubtle", "bg", 4.5], ["fgSubtle", "surface", 4.5],
  ["accent", "bg", 4.5], ["accent", "surface", 4.5], ["onAccent", "accentFill", 4.5],
  ["danger", "bg", 4.5], ["danger", "dangerTint", 4.5], ["onDanger", "danger", 4.5],
  ["ok", "bg", 4.5], ["ok", "surface", 4.5], ["info", "bg", 4.5], ["warn", "bg", 4.5],
  ["focus", "bg", 3], ["lineInput", "bg", 3], ["lineInput", "bgElev", 3],
];

describe("tokens", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const [fg, bg, min] of PAIRS) {
      it(`${theme}: ${fg} on ${bg} ≥ ${min}`, () => {
        const t = tokens.semantic[theme];
        expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(min);
      });
    }
  }
  it("dark is the default and light is opt-in or system-light", () => {
    const css = gen(tokens);
    expect(css).toMatch(/:root \{[^}]*--c-bg: #0a0a0b;[^}]*color-scheme: dark;/s);
    expect(css).toContain(':root[data-theme="light"]');
    expect(css).toContain('@media (prefers-color-scheme: light)');
  });
  it("emits the B17 control tokens", () => {
    const css = gen(tokens);
    for (const v of ["--control-height: 44px", "--disabled-opacity: 0.5", "--z-toast: 40", "--leading-normal: 1.5"])
      expect(css).toContain(v);
  });
});
```

Update `packages/ui/vitest.config.ts` to `include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"]`.

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd packages/ui && bunx vitest run scripts/gen-tokens.test.ts`

Expected: FAIL, because `./gen-tokens` doesn't exist.

- [ ] **Step 4: Write `scripts/gen-tokens.ts`**

This is alxnko.dev's generator, extended with the new groups.

```ts
// design/tokens.json → src/styles/tokens.gen.css. `--check` fails on drift (CI via `bun run tokens:check`).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Tokens = typeof import("../design/tokens.json");

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG 2.x contrast ratio between two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const block = (vars: Record<string, string>, prefix: string) =>
  Object.entries(vars).map(([k, v]) => `  --${prefix}${kebab(k)}: ${v};`).join("\n");

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
    `  --font-mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;`,
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
`;
}

const OUT = fileURLToPath(new URL("../src/styles/tokens.gen.css", import.meta.url));

if (import.meta.main) {
  const tokens: Tokens = JSON.parse(readFileSync(new URL("../design/tokens.json", import.meta.url), "utf8"));
  const css = gen(tokens);
  if (process.argv.includes("--check")) {
    let current = "";
    try { current = readFileSync(OUT, "utf8"); } catch { /* missing = drift */ }
    if (current !== css) {
      console.error("tokens.gen.css is out of date. Run `bun run tokens`.");
      process.exit(1);
    }
  } else {
    writeFileSync(OUT, css);
    console.log("wrote", OUT);
  }
}
```

In `packages/ui/package.json`, add the scripts `"tokens": "bun scripts/gen-tokens.ts"` and
`"tokens:check": "bun scripts/gen-tokens.ts --check"`, and change `"lint"` to
`"bun run tokens:check && tsc --noEmit"`. Add `"resolveJsonModule": true` to `packages/ui/tsconfig.json`
`compilerOptions` if it isn't inherited.

- [ ] **Step 5: Generate the CSS and run the tests**

Run: `cd packages/ui && bun run tokens && bunx vitest run scripts/gen-tokens.test.ts`

Expected: PASS, all 44 cases. If a contrast case fails, change only that colour in `tokens.json`, pick
the nearest value that passes, and note it in the commit body.

- [ ] **Step 6: Split `tokens.css` and add the aliases**

`src/styles/tokens.css` becomes imports only:

```css
/* @meowerse/ui entry: fonts → tokens (generated) → legacy aliases → global → base → layout → components. */
@import "./fonts.css";
@import "./tokens.gen.css";
@import "./aliases.css";
@import "./global.css";
@import "./base.css";
@import "./layout.css";
@import "./components.css";
```

`src/styles/aliases.css`. Legacy names are kept for one release so the apps restyle without code
changes (spec §2.1). They're removed in sub-project 5.

```css
/* Legacy variable names → v2 tokens. Apps migrate off these in sub-projects 2–4; removed in 5. */
:root {
  --mw-green: var(--c-accent-fill);
  --mw-green-hover: color-mix(in srgb, var(--c-accent-fill) 88%, var(--c-fg));
  --mw-on-green: var(--c-on-accent);
  --surface-0: var(--c-bg); --surface-1: var(--c-bg-elev); --surface-2: var(--c-surface-raised);
  --surface-muted: var(--c-surface);
  --text-primary: var(--c-fg); --text-secondary: var(--c-fg-muted); --text-muted: var(--c-fg-subtle);
  --text-accent: var(--c-accent);
  --border: var(--c-line); --border-strong: var(--c-line-strong);
  --danger: var(--c-danger); --on-danger: var(--c-on-danger); --text-danger: var(--c-danger);
  --bg-danger: var(--c-danger-tint); --success: var(--c-ok); --warning: var(--c-warn);
  --radius-sm: var(--r-s); --radius: var(--r-m); --radius-lg: var(--r-l); --radius-pill: var(--r-m);
  --space-0: 0; --space-1: var(--sp-1); --space-2: var(--sp-2); --space-3: var(--sp-3); --space-4: var(--sp-4);
  --space-5: var(--sp-5); --space-6: var(--sp-6); --space-7: var(--sp-7); --space-8: var(--sp-8);
  --space-section: clamp(2.75rem, 7vw, 4.5rem); --space-gutter: clamp(1rem, 5vw, 2rem);
  --gap-xs: var(--sp-1); --gap-sm: var(--sp-2); --gap-md: var(--sp-3);
  --gap-lg: var(--sp-4); --gap-xl: var(--sp-5); --gap-2xl: var(--sp-6);
  --mw-stack-gap: var(--sp-4);
  --font-sans: var(--font-mono); --font-display: var(--font-mark);
  --text-xs: var(--fs-1); --text-sm: var(--fs-2); --text-base: var(--fs-4); --text-md: var(--fs-4);
  --text-lg: var(--fs-5); --text-xl: clamp(var(--fs-5), 1rem + 1.6vw, var(--fs-6));
  --text-2xl: clamp(var(--fs-6), 1.2rem + 2.6vw, var(--fs-7));
  --leading-snug: 1.35;
  --measure: 72ch;
  --shadow-sm: none; --shadow-md: 0 8px 24px rgb(0 0 0 / 0.25); --shadow-lg: 0 16px 40px rgb(0 0 0 / 0.35);
  --dur-fast: var(--d-fast); --dur: var(--d-base);
}
```

`src/styles/global.css` takes the reset, focus and reduced-motion rules out of the old
`tokens.css`. B14: there's no `text-transform` anywhere.

```css
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  font-family: var(--font-mono);
  font-size: var(--fs-3);
  line-height: var(--leading-normal);
  color: var(--c-fg);
  background: var(--c-bg);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  -webkit-tap-highlight-color: transparent;
  font-variant-ligatures: none;
}
:where(a, button, input, select, textarea, summary, [tabindex]):focus-visible {
  outline: 2px solid var(--c-focus);
  outline-offset: 2px;
}
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.mw-no-transitions * { transition: none !important; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }
}
```

The focus ring uses `outline`, not `box-shadow`, so it survives forced-colors mode (U-09).

- [ ] **Step 7: Guard B14 with a test, `src/styles/no-transform.test.ts`**

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("B14: user text is never case-transformed", () => {
  it("no stylesheet in @meowerse/ui uses text-transform", () => {
    const dir = join(__dirname);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".css")))
      expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/text-transform\s*:\s*(lower|upper|capital)/);
  });
});
```

Run: `cd packages/ui && bunx vitest run src/styles`

Expected: PASS once the old body rule is gone (it moved to `global.css` without the transform).

- [ ] **Step 8: Restore the lowercase copy that the transform used to hide**

With the transform gone, any copy written in capitals in the three apps and the ui components now
shows in capitals. Find it:

```bash
rg -n '>[^<{]*[A-Z][^<{]*<|"[A-Z][a-z]+ [a-z]' packages/ui/src/components apps/auth-web/src apps/meowsenger-web/src apps/web/src -g '*.tsx' -g '*.astro' | rg -v 'test\.'
```

Lowercase every interface string we wrote: labels, headings, buttons, placeholders, `aria-label`s,
toasts. Don't change:
- user-content rendering;
- proper nouns in legal copy (e.g. "Cloudflare", "Telegram", "GitHub");
- code identifiers.

List every changed file in the commit body.

- [ ] **Step 9: Run the full ui suite and all three app builds**

Run: `bun run --filter @meowerse/ui test && bun run --filter @meowerse/auth-web build && bun run --filter @meowerse/meowsenger-web build && bun run --filter @meowerse/web build`

Expected: all green and coverage ≥ 90.

- [ ] **Step 10: Commit**

```bash
git add -A packages/ui apps
git commit -m "feat(ui): v2 tokens from alxnko.dev + B17 additions, legacy aliases, no global lowercase (B14)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Fonts (spec §2.2)

**Files:**
- Create: `packages/ui/scripts/subset-fonts.sh`, `packages/ui/src/assets/fonts/vt323-marks.woff2`,
  `packages/ui/src/assets/fonts/jetbrains-mono-symbols-400.woff2`, `packages/ui/src/assets/fonts/OFL.txt`
- Modify: `packages/ui/src/styles/fonts.css`, `packages/ui/package.json` (dependencies)
- Test: `packages/ui/src/styles/fonts.test.ts`

**Interfaces:**
- Consumes `--font-mono` and `--font-mark` from Task 2.
- Produces the `"JetBrains Mono"` faces at 400/700 and the `"VT323 Mark"` face covering exactly the
  glyphs of `meowerse_ meowsenger_ auth_ ui_`.

- [ ] **Step 1: Swap the dependencies**

```bash
cd packages/ui
bun remove @fontsource-variable/outfit @fontsource/bytesized
bun add @fontsource/jetbrains-mono@^5.3.0 @fontsource/vt323@^5.3.0
```

- [ ] **Step 2: Write `scripts/subset-fonts.sh`**

The symbols part is the same pinned source and ranges as alxnko.dev's `scripts/subset-symbols-font.sh`.

```bash
#!/usr/bin/env bash
# VT323 is only used for wordmarks; JetBrains Mono's fontsource files lack arrows, box drawing,
# blocks and maths, so ship those from the upstream TTF (every glyph a 600-unit cell). Needs
# fonttools + brotli. Outputs are committed; rerun only when a wordmark or range changes.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=src/assets/fonts
pyftsubset node_modules/@fontsource/vt323/files/vt323-latin-400-normal.woff2 \
  --text='meowrsngaui_' --flavor=woff2 --layout-features='' --no-hinting --desubroutinize \
  --name-IDs='' --output-file=$OUT/vt323-marks.woff2
SRC=${JBM_TTF:-/var/tmp/jbm/JetBrainsMono-Regular.ttf}
if [ ! -f "$SRC" ]; then
  mkdir -p "$(dirname "$SRC")"
  curl -fsSL -o "$SRC" https://github.com/JetBrains/JetBrainsMono/raw/v2.304/fonts/ttf/JetBrainsMono-Regular.ttf
fi
echo "a0bf60ef0f83c5ed4d7a75d45838548b1f6873372dfac88f71804491898d138f  $SRC" | sha256sum -c --quiet
pyftsubset "$SRC" \
  --unicodes='U+2190-21FF,U+2200-22FF,U+2500-259F,U+25A0-25FF' \
  --flavor=woff2 --layout-features='' --no-hinting --desubroutinize \
  --name-IDs='0,1,2,3,4,5,6,13,14' --output-file=$OUT/jetbrains-mono-symbols-400.woff2
curl -fsSL -o $OUT/OFL.txt https://raw.githubusercontent.com/JetBrains/JetBrainsMono/v2.304/OFL.txt
```

Run: `chmod +x scripts/subset-fonts.sh && ./scripts/subset-fonts.sh && ls -l src/assets/fonts`

Expected: `vt323-marks.woff2` < 2 KB and `jetbrains-mono-symbols-400.woff2` < 14 KB. Cyrillic comes
from fontsource's own `cyrillic` subset files, so the subset excludes U+0400–045F.

- [ ] **Step 3: Write `src/styles/fonts.css`**

```css
/* JetBrains Mono 400/700: fontsource ships latin, latin-ext, cyrillic, greek… each with its own
   unicode-range, so browsers download only what a page uses. */
@import "@fontsource/jetbrains-mono/400.css";
@import "@fontsource/jetbrains-mono/700.css";
/* arrows, maths, box drawing, blocks, shapes: not in the fontsource files */
@font-face {
  font-family: "JetBrains Mono"; font-style: normal; font-weight: 400 700; font-display: swap;
  src: url("../assets/fonts/jetbrains-mono-symbols-400.woff2") format("woff2");
  unicode-range: U+2190-21FF, U+2200-22FF, U+2500-259F, U+25A0-25FF;
}
@font-face {
  font-family: "VT323 Mark"; font-style: normal; font-weight: 400; font-display: block;
  src: url("../assets/fonts/vt323-marks.woff2") format("woff2");
}
```

- [ ] **Step 4: Test that the old families are gone, `src/styles/fonts.test.ts`**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json";

describe("fonts", () => {
  it("ships only JetBrains Mono + the VT323 mark subset", () => {
    const css = readFileSync(join(__dirname, "fonts.css"), "utf8");
    expect(css).not.toMatch(/outfit|bytesized/i);
    expect(css).toContain("@fontsource/jetbrains-mono/700.css");
    expect(Object.keys(pkg.dependencies)).toEqual(["@fontsource/jetbrains-mono", "@fontsource/vt323"]);
  });
});
```

Run: `cd packages/ui && bunx vitest run src/styles/fonts.test.ts`

Expected: PASS.

- [ ] **Step 5: Check the budget on a real build**

Run:

```bash
bun run --filter @meowerse/auth-web build
fd -e woff2 . apps/auth-web/dist | xargs du -cb | tail -1
```

Expected: the total of the woff2 files a Latin-only page references (check `dist/_astro/*.css` for
`url(`; the cyrillic and greek files are emitted but only downloaded when those characters appear)
stays ≤ 110 KB. Note the number in the commit body.

- [ ] **Step 6: Commit**

```bash
git add -A packages/ui bun.lock
git commit -m "feat(ui): JetBrains Mono 400/700 + symbols subset, VT323 wordmark subset; drop Outfit/Bytesized

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `request()`, the shared request layer (B18)

**Files:**
- Create: `packages/ui/src/lib/request.ts`
- Test: `packages/ui/src/lib/request.test.ts`
- Modify: `packages/ui/src/index.ts`

**Interfaces:**
- Produces the following. Later tasks, and sub-projects 2–4, call exactly this.

```ts
export type RequestError =
  | { kind: "timeout" }
  | { kind: "network" }
  | { kind: "unauthorized"; status: 401 }
  | { kind: "http"; status: number; body: unknown }
  | { kind: "parse" };
export type RequestResult<T> = { ok: true; status: number; data: T } | { ok: false; error: RequestError };
export function request<T>(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<RequestResult<T>>;
export function describeError(e: RequestError): string; // plain-language, lowercase, never a bare code
export const DEFAULT_TIMEOUT_MS = 10_000;
```

- [ ] **Step 1: Write the failing tests `src/lib/request.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeError, request } from "./request";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("request", () => {
  it("returns data on 2xx and always sends credentials", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ a: 1 }));
    await expect(request<{ a: number }>("https://x/y")).resolves.toEqual({ ok: true, status: 200, data: { a: 1 } });
    expect(spy.mock.calls[0][1]).toMatchObject({ credentials: "include" });
  });
  it("204 gives data null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    await expect(request("https://x")).resolves.toEqual({ ok: true, status: 204, data: null });
  });
  it("401 is unauthorized, not a generic error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "no" }, 401));
    await expect(request("https://x")).resolves.toEqual({ ok: false, error: { kind: "unauthorized", status: 401 } });
  });
  it("5xx keeps status and body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "boom" }, 503));
    await expect(request("https://x")).resolves.toEqual({ ok: false, error: { kind: "http", status: 503, body: { error: "boom" } } });
  });
  it("a rejected fetch is network", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(request("https://x")).resolves.toEqual({ ok: false, error: { kind: "network" } });
  });
  it("bad JSON on 2xx is parse", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>", { status: 200 }));
    await expect(request("https://x")).resolves.toEqual({ ok: false, error: { kind: "parse" } });
  });
  it("times out and aborts the fetch", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_u, init) => {
      signal = init?.signal ?? undefined;
      return new Promise((_, rej) => signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    });
    const p = request("https://x", { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(51);
    await expect(p).resolves.toEqual({ ok: false, error: { kind: "timeout" } });
    expect(signal?.aborted).toBe(true);
  });
  it("a caller abort is reported as network and not retried", async () => {
    const ac = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new DOMException("aborted", "AbortError")));
    ac.abort();
    await expect(request("https://x", { signal: ac.signal })).resolves.toEqual({ ok: false, error: { kind: "network" } });
  });
  it("describeError is plain language for every kind", () => {
    expect(describeError({ kind: "timeout" })).toBe("the server took too long to answer. try again.");
    expect(describeError({ kind: "network" })).toBe("can't reach the server. check your connection and try again.");
    expect(describeError({ kind: "unauthorized", status: 401 })).toBe("your session has ended. sign in again.");
    expect(describeError({ kind: "http", status: 429, body: null })).toBe("too many tries. wait a minute and try again.");
    expect(describeError({ kind: "http", status: 500, body: null })).toBe("something went wrong on our side. try again.");
    expect(describeError({ kind: "http", status: 400, body: { message: "name taken" } })).toBe("name taken");
    expect(describeError({ kind: "http", status: 404, body: null })).toBe("not found.");
    expect(describeError({ kind: "parse" })).toBe("the server sent an unexpected answer. try again.");
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd packages/ui && bunx vitest run src/lib/request.test.ts`

Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `src/lib/request.ts`**

```ts
export type RequestError =
  | { kind: "timeout" }
  | { kind: "network" }
  | { kind: "unauthorized"; status: 401 }
  | { kind: "http"; status: number; body: unknown }
  | { kind: "parse" };
export type RequestResult<T> = { ok: true; status: number; data: T } | { ok: false; error: RequestError };

export const DEFAULT_TIMEOUT_MS = 10_000;

async function body(res: Response): Promise<unknown> {
  try { return await res.json(); } catch { return null; }
}

/** fetch with a timeout, credentials, `res.ok` checks and a typed result — never throws. */
export async function request<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<RequestResult<T>> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = init;
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) ac.abort();
  try {
    const res = await fetch(url, { credentials: "include", ...rest, signal: ac.signal });
    if (res.status === 401) return { ok: false, error: { kind: "unauthorized", status: 401 } };
    if (!res.ok) return { ok: false, error: { kind: "http", status: res.status, body: await body(res) } };
    if (res.status === 204) return { ok: true, status: 204, data: null as T };
    try {
      return { ok: true, status: res.status, data: (await res.json()) as T };
    } catch {
      return { ok: false, error: { kind: "parse" } };
    }
  } catch {
    return { ok: false, error: timedOut ? { kind: "timeout" } : { kind: "network" } };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** One plain-language sentence for any request failure (lowercase voice, B14 applies to our copy only). */
export function describeError(e: RequestError): string {
  switch (e.kind) {
    case "timeout": return "the server took too long to answer. try again.";
    case "network": return "can't reach the server. check your connection and try again.";
    case "unauthorized": return "your session has ended. sign in again.";
    case "parse": return "the server sent an unexpected answer. try again.";
    case "http": {
      const msg = (e.body as { message?: unknown } | null)?.message;
      if (e.status === 429) return "too many tries. wait a minute and try again.";
      if (e.status >= 500) return "something went wrong on our side. try again.";
      if (typeof msg === "string" && msg) return msg;
      if (e.status === 404) return "not found.";
      return "that didn't work. try again.";
    }
  }
}
```

Add to `src/index.ts`:
`export { request, describeError, DEFAULT_TIMEOUT_MS, type RequestResult, type RequestError } from "./lib/request";`

- [ ] **Step 4: Run the tests**

Run: `cd packages/ui && bunx vitest run src/lib/request.test.ts`

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/request.ts packages/ui/src/lib/request.test.ts packages/ui/src/index.ts
git commit -m "feat(ui): request() with timeout, res.ok and typed errors + describeError (B18)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `useSession`, `AuthGate`, `AppHeader` on real readiness (B9, B18; U-01, U-02, A-07, M-06)

**Files:**
- Modify: `packages/ui/src/lib/useSession.ts`, `packages/ui/src/components/AuthGate.tsx`,
  `packages/ui/src/components/AppHeader.tsx`, `packages/ui/src/index.ts`
- Test: `packages/ui/src/lib/useSession.test.tsx`, `packages/ui/src/components/AuthGate.test.tsx`,
  `packages/ui/src/components/AppHeader.test.tsx`

**Interfaces:**
- Consumes `request` from Task 4, and `StatusLine` / `Button` (StatusLine is created in Task 7. To
  keep this task independent, AuthGate renders the markup `StatusLine` will use:
  `<p className="mw-status mw-status--fail" role="alert">`).
- Produces:

```ts
export type Session =
  | { loading: true; authenticated: false }
  | { loading: false; authenticated: false; error?: undefined }
  | { loading: false; authenticated: false; error: "network" | "timeout" | "server" }
  | { loading: false; authenticated: true; username: string; verified: boolean };
export function useSession(base: string): Session & { retry: () => void };
export function clearSessionCache(): void;               // unchanged
export const SESSION_TIMEOUT_MS = 8_000;
```

Rules:
- Only `200 {authenticated:false}` or a 401 means signed out.
- Errors are never cached.
- `clearSessionCache()` is also called on `pageshow` with `persisted` (bfcache) so a back-navigation
  re-checks.

- [ ] **Step 1: Replace the network-error test and add new failing tests in `useSession.test.tsx`**

Replace the test `"reports guest on a network error"` with the following, and keep the other two
tests:

```tsx
function View2({ base }: { base: string }) {
  const s = useSession(base);
  if (s.loading) return <div>loading</div>;
  if (s.authenticated) return <div>hi {s.username}</div>;
  if (s.error) return <button onClick={s.retry}>error {s.error}</button>;
  return <div>guest</div>;
}

it("a network error is an error, not signed-out, and is not cached", async () => {
  const spy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("down"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: true, username: "alex", verified: true }), { status: 200 }));
  render(<View2 base="https://api" />);
  const btn = await screen.findByRole("button", { name: "error network" });
  expect(sessionStorage.getItem("mw-session")).toBeNull();
  btn.click();
  expect(await screen.findByText("hi alex")).toBeInTheDocument();
  expect(spy).toHaveBeenCalledTimes(2);
});

it("a 5xx is error server", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x", { status: 502 }));
  render(<View2 base="https://api" />);
  expect(await screen.findByRole("button", { name: "error server" })).toBeInTheDocument();
});

it("a 401 is signed out", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
  render(<View2 base="https://api" />);
  expect(await screen.findByText("guest")).toBeInTheDocument();
});

it("a hung request becomes error timeout", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(globalThis, "fetch").mockImplementation((_u, init) =>
    new Promise((_, rej) => init!.signal!.addEventListener("abort", () => rej(new DOMException("a", "AbortError")))));
  render(<View2 base="https://api" />);
  await vi.advanceTimersByTimeAsync(8_001);
  expect(await screen.findByRole("button", { name: "error timeout" })).toBeInTheDocument();
  vi.useRealTimers();
});

it("a bfcache restore drops the cache", () => {
  sessionStorage.setItem("mw-session", JSON.stringify({ at: Date.now(), data: { loading: false, authenticated: false } }));
  window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
  expect(sessionStorage.getItem("mw-session")).toBeNull();
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd packages/ui && bunx vitest run src/lib/useSession.test.tsx`

Expected: the new tests FAIL. There's no `error` or `retry`, and a network error currently shows
"guest".

- [ ] **Step 3: Implement the new `useSession.ts`**

This replaces `loadSession` and the hook, and keeps `readCache`, `writeCache` and the SSR comment.

```ts
import { useCallback, useEffect, useState } from "react";
import { request } from "./request";

export type SessionError = "network" | "timeout" | "server";
export type Session =
  | { loading: true; authenticated: false }
  | { loading: false; authenticated: false; error?: undefined }
  | { loading: false; authenticated: false; error: SessionError }
  | { loading: false; authenticated: true; username: string; verified: boolean };

type Resolved = Exclude<Session, { loading: true }>;
type Known = Exclude<Resolved, { error: SessionError }>;

const CACHE_KEY = "mw-session";
const TTL = 15_000;
export const SESSION_TIMEOUT_MS = 8_000;
let inflight: Promise<Resolved> | null = null;

// readCache(): Known | null and writeCache(data: Known) — unchanged bodies from the current file.

export function clearSessionCache(): void {
  try { sessionStorage.removeItem(CACHE_KEY); } catch { /* private mode / SSR: best-effort */ }
  inflight = null;
}

// A back/forward-cache restore may show a page from before a sign-in or sign-out: re-check.
if (typeof window !== "undefined") {
  window.addEventListener("pageshow", (e) => { if ((e as PageTransitionEvent).persisted) clearSessionCache(); });
}

async function loadSession(base: string): Promise<Resolved> {
  const r = await request<{ authenticated?: boolean; username?: string; verified?: boolean }>(
    `${base}/api/session`, { timeoutMs: SESSION_TIMEOUT_MS });
  if (!r.ok) {
    if (r.error.kind === "unauthorized") { const d: Known = { loading: false, authenticated: false }; writeCache(d); return d; }
    const error: SessionError = r.error.kind === "timeout" ? "timeout" : r.error.kind === "network" ? "network" : "server";
    return { loading: false, authenticated: false, error };   // never cached
  }
  const j = r.data;
  const data: Known = j?.authenticated && j.username
    ? { loading: false, authenticated: true, username: j.username, verified: !!j.verified }
    : { loading: false, authenticated: false };
  writeCache(data);
  return data;
}

export function useSession(base: string): Session & { retry: () => void } {
  // Always start in `loading` so the server render and the first client render match (see note below).
  const [s, setS] = useState<Session>({ loading: true, authenticated: false });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => { clearSessionCache(); setS({ loading: true, authenticated: false }); setAttempt((n) => n + 1); }, []);

  useEffect(() => {
    const cached = readCache();
    if (cached) { setS(cached); return; }
    let live = true;
    inflight ??= loadSession(base);
    inflight.then((data) => { if (live) setS(data); }).finally(() => { inflight = null; });
    return () => { live = false; };
  }, [base, attempt]);

  return Object.assign({}, s, { retry });
}
```

Keep the existing long hydration comment above the hook. `readCache` and `writeCache` keep their
bodies with the type narrowed to `Known`.

- [ ] **Step 4: Run the tests**

Run: `cd packages/ui && bunx vitest run src/lib/useSession.test.tsx`

Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing AuthGate test (append to `AuthGate.test.tsx`)**

```tsx
it("on a network error shows a reason and retry — never redirects", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("down"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: true, username: "a", verified: false }), { status: 200 }));
  const replace = vi.fn();
  Object.defineProperty(window, "location", { value: { pathname: "/account", replace }, writable: true });
  render(<AuthGate base="https://api"><p>secret</p></AuthGate>);
  expect(await screen.findByRole("alert")).toHaveTextContent("can't reach the account service");
  expect(replace).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "try again" }));
  expect(await screen.findByText("secret")).toBeInTheDocument();
});
```

Add `import userEvent from "@testing-library/user-event";`.

Run: `cd packages/ui && bunx vitest run src/components/AuthGate.test.tsx`

Expected: FAIL.

- [ ] **Step 6: Implement `AuthGate.tsx`**

```tsx
import { useEffect, type ReactNode } from "react";
import { useSession } from "../lib/useSession";
import { Spinner } from "./Spinner";
import { Button } from "./Button";

export function AuthGate({ base, children, loginPath = "/login" }:
  { base: string; children: ReactNode; loginPath?: string }) {
  const s = useSession(base);
  const signedOut = !s.loading && !s.authenticated && !s.error;
  useEffect(() => {
    if (signedOut) {
      const next = encodeURIComponent(window.location.pathname + (window.location.search ?? ""));
      window.location.replace(`${loginPath}?next=${next}`);
    }
  }, [signedOut, loginPath]);

  if (!s.loading && !s.authenticated && s.error) {
    return (
      <div className="mw-gate mw-gate--error">
        <p className="mw-status mw-status--fail" role="alert">
          <span className="mw-status__tag" aria-hidden="true">[fail]</span>
          {s.error === "timeout" ? "the account service is taking too long." : "can't reach the account service."}
        </p>
        <Button variant="secondary" onClick={s.retry}>try again</Button>
      </div>
    );
  }
  if (s.loading || !s.authenticated) {
    return <div className="mw-gate"><Spinner size="lg" label="checking your session" /></div>;
  }
  return <>{children}</>;
}
```

The existing redirect test expects `"/login?next=%2Faccount"`. With `search` undefined in that test,
`?? ""` keeps it passing.

- [ ] **Step 7: Update `AppHeader` so errors never show a false "log in"**

Change the nav branches to the following:

```tsx
const known = !session.loading && !("error" in session && session.error);
const showNav = !session.loading;
// guest links only when we KNOW the visitor is signed out; on error show the public links only
{showNav && !session.authenticated && (
  <>
    <a href="/about">about</a>
    <a href="/developers">developers</a>
    <a href="/docs">docs</a>
    {known && <><a href="/login">log in</a><a href="/signup">sign up</a></>}
  </>
)}
```

Also render the burger and the public links while loading: set `showNav = true` for the public links,
and gate only the auth-specific links on `known`. That's U-02: the nav no longer vanishes for a hung
session. Add a test to `AppHeader.test.tsx`:

```tsx
it("keeps public nav while loading and hides log in on error", () => {
  const { rerender } = render(<AppHeader session={{ loading: true, authenticated: false }} />);
  expect(screen.getByRole("link", { name: "docs" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "log in" })).toBeNull();
  rerender(<AppHeader session={{ loading: false, authenticated: false, error: "network" }} />);
  expect(screen.queryByRole("link", { name: "log in" })).toBeNull();
  rerender(<AppHeader session={{ loading: false, authenticated: false }} />);
  expect(screen.getByRole("link", { name: "log in" })).toBeInTheDocument();
});
```

- [ ] **Step 8: Run the ui suite**

Run: `bun run --filter @meowerse/ui test`

Expected: PASS and coverage ≥ 90. Also run
`rg -n "useSession\(" apps -g '*.tsx'` and check that each call site still compiles:
`bun run --filter @meowerse/auth-web lint && bun run --filter @meowerse/meowsenger-web lint`.
`retry` is additive, so they should pass unchanged.

- [ ] **Step 9: Commit**

```bash
git add -A packages/ui
git commit -m "fix(ui): session errors are not sign-outs; timeout, retry, bfcache re-check (B9, B18; U-01, U-02, A-07, M-06)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Modal focus and ConfirmDialog phrase (U-06, U-07, A-20, U-31, A-18)

**Files:**
- Modify: `packages/ui/src/components/Modal.tsx`, `packages/ui/src/components/ConfirmDialog.tsx`
- Test: `packages/ui/src/components/Modal.test.tsx`, `packages/ui/src/components/ConfirmDialog.test.tsx`

**Interfaces:** Both APIs are unchanged.

- [ ] **Step 1: Write the failing tests (append to `Modal.test.tsx`)**

```tsx
it("skips disabled controls when wrapping Tab (ConfirmDialog armed state)", async () => {
  render(
    <Modal open onClose={() => {}} title="t">
      <input aria-label="phrase" />
      <button>cancel</button>
      <button disabled>delete</button>
    </Modal>,
  );
  screen.getByRole("button", { name: "cancel" }).focus();
  await userEvent.tab();
  expect(screen.getByLabelText("phrase")).toHaveFocus();
});

it("a parent re-render with a new onClose does not steal focus from the field", async () => {
  function Parent() {
    const [v, setV] = React.useState("");
    return (
      <Modal open onClose={() => {}} title="t">
        <button>first</button>
        <input aria-label="name" value={v} onChange={(e) => setV(e.target.value)} />
      </Modal>
    );
  }
  render(<Parent />);
  const input = screen.getByLabelText("name");
  await userEvent.click(input);
  await userEvent.type(input, "abc");
  expect(input).toHaveFocus();
  expect(input).toHaveValue("abc");
});
```

Add `import * as React from "react";`. In `ConfirmDialog.test.tsx`, append:

```tsx
it("shows the phrase exactly (case kept) and accepts it", async () => {
  const onConfirm = vi.fn();
  render(<ConfirmDialog open onCancel={() => {}} onConfirm={onConfirm} title="delete app"
    description="d" confirmLabel="delete" confirmPhrase="MyApp" />);
  expect(screen.getByText("MyApp", { selector: "code" })).toBeInTheDocument();
  await userEvent.type(screen.getByRole("textbox"), "MyApp");
  await userEvent.click(screen.getByRole("button", { name: "delete" }));
  expect(onConfirm).toHaveBeenCalled();
});
```

Run: `cd packages/ui && bunx vitest run src/components/Modal.test.tsx src/components/ConfirmDialog.test.tsx`

Expected: the new tests FAIL. The re-render test fails because the effect re-runs on every new
`onClose` and focuses the first button.

- [ ] **Step 2: Implement the Modal fix**

```tsx
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";

const FOCUSABLE = 'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';
const usable = (el: HTMLElement) =>
  !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true" && el.tabIndex !== -1 && !el.closest("[inert]");

export function Modal({ open, onClose, title, children, className }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; className?: string;
}) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;                       // latest callback without re-running the effect

  useEffect(() => {
    if (!open) return;
    const restore = document.activeElement as HTMLElement | null;
    const panel = panelRef.current!;
    const list = () => Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(usable);
    (panel.querySelector<HTMLElement>("[data-autofocus]") ?? list()[0] ?? panel).focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== "Tab") return;
      const f = list();
      const first = f[0], last = f[f.length - 1];
      if (!first || !last) { e.preventDefault(); return; }
      if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); restore?.focus?.(); };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="mw-modal">
      <div className="mw-modal__backdrop" data-testid="mw-modal-backdrop" onClick={() => closeRef.current()} />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}
        className={cx("mw-modal__panel", className)}>
        <h2 id={id} className="mw-modal__title">{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 3: Implement the ConfirmDialog phrase**

Replace the phrase `Field` with the following:

```tsx
{confirmPhrase && (
  <div className="mw-confirm__phrase">
    <p id={`${phraseId}-lbl`}>to confirm, type <code>{confirmPhrase}</code></p>
    <Field label={`type ${confirmPhrase} to confirm`} className="mw-confirm__field" value={typed}
      onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="none"
      autoCorrect="off" spellCheck={false} data-case="preserve" />
    {typed && !phraseOk && <span className="mw-field__hint">doesn't match yet</span>}
  </div>
)}
```

Add `const phraseId = useId();` (import `useId`). The comparison stays exact (`typed === confirmPhrase`).
Since B14 removed the transform, the shown phrase now matches what's required. The "doesn't match
yet" hint means the disabled button always has a visible reason.

- [ ] **Step 4: Run the tests**

Run: `cd packages/ui && bunx vitest run src/components`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/ui/src/components
git commit -m "fix(ui): modal focus trap skips disabled controls and survives re-renders; confirm phrase shown exactly (U-06, U-07, U-31, A-18, A-20)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: New tty components: Wordmark, Cursor, Kbd, StatusLine, Prompt (spec §3, §7, §7.1, B10)

**Files:**
- Create: `packages/ui/src/components/{Wordmark,Cursor,Kbd,StatusLine,Prompt}.tsx` and a
  `.test.tsx` for each
- Modify: `packages/ui/src/index.ts`, `packages/ui/src/styles/components.css` (append the `.mw-wordmark`,
  `.mw-cursor`, `.mw-kbd`, `.mw-status`, `.mw-prompt` rules from Task 8's CSS; write them here and
  Task 8 won't touch them)

**Interfaces:** Produces the following.

```ts
export function Wordmark(p: { name: "meowerse" | "meowsenger" | "auth" | "ui"; href?: string; className?: string }): JSX.Element;
export function Cursor(p: { blink?: boolean }): JSX.Element;                       // aria-hidden block cursor
export function Kbd(p: { children: ReactNode }): JSX.Element;
export type StatusState = "ok" | "wait" | "fail" | "info";
export function StatusLine(p: { state: StatusState; children: ReactNode; live?: boolean; action?: ReactNode; className?: string }): JSX.Element;
export type PromptProps = {
  label: string;                    // accessible name, e.g. "message"
  placeholder?: string;             // visible hint, default = label
  value: string; onChange: (v: string) => void;
  onSubmit: (v: string) => void;    // called with trimmed text; never called while IME is composing
  sendLabel?: string;               // default "send"
  maxRows?: number;                 // default 6
  busy?: boolean;                   // shows state only; the textarea is NEVER disabled (B9/M-01)
  enterSends?: "auto" | "always" | "never"; // auto: desktop sends on Enter, coarse pointers insert newline
};
export const Prompt: ForwardRefExoticComponent<PromptProps & RefAttributes<HTMLTextAreaElement>>;
```

- [ ] **Step 1: Write the failing tests**

`StatusLine.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusLine } from "./StatusLine";

describe("StatusLine", () => {
  it.each([["ok", "[ ok ]"], ["wait", "[wait]"], ["fail", "[fail]"], ["info", "[info]"]] as const)(
    "%s shows the tag and text", (state, tag) => {
      render(<StatusLine state={state}>connected</StatusLine>);
      expect(screen.getByText(tag)).toHaveAttribute("aria-hidden", "true");
      expect(screen.getByText("connected")).toBeInTheDocument();
    });
  it("fail is an alert, others are polite status when live", () => {
    const { rerender } = render(<StatusLine state="fail">x</StatusLine>);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    rerender(<StatusLine state="wait" live>x</StatusLine>);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
  it("renders an action", () => {
    render(<StatusLine state="fail" action={<button>retry</button>}>x</StatusLine>);
    expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument();
  });
});
```

`Prompt.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Prompt } from "./Prompt";

function Harness({ onSubmit, enterSends = "always" as const, busy = false }: { onSubmit: (v: string) => void; enterSends?: "auto" | "always" | "never"; busy?: boolean }) {
  const [v, setV] = useState("");
  return <Prompt label="message" value={v} onChange={setV} onSubmit={(t) => { onSubmit(t); setV(""); }} enterSends={enterSends} busy={busy} />;
}

describe("Prompt", () => {
  it("is a labelled multiline textbox with a visible send button", () => {
    render(<Harness onSubmit={() => {}} />);
    expect(screen.getByRole("textbox", { name: "message" })).toHaveAttribute("enterkeyhint", "send");
    expect(screen.getByRole("button", { name: "send" })).toBeInTheDocument();
  });
  it("Enter sends trimmed text, Shift+Enter inserts a newline", async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "  hi{Shift>}{Enter}{/Shift}there  {Enter}");
    expect(onSubmit).toHaveBeenCalledWith("hi\nthere");
  });
  it("never sends while an IME is composing", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "にほん" } });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true, keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it("does not send empty text; the button says why", async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: "send" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "send" })).toHaveAttribute("aria-disabled", "true");
  });
  it("busy never disables typing", () => {
    render(<Harness onSubmit={() => {}} busy />);
    expect(screen.getByRole("textbox")).not.toBeDisabled();
  });
  it("enterSends=never makes Enter a newline", async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} enterSends="never" />);
    await userEvent.type(screen.getByRole("textbox"), "a{Enter}b");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("a\nb");
  });
});
```

`Wordmark.test.tsx`, `Cursor.test.tsx`, `Kbd.test.tsx`:

```tsx
// Wordmark.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Wordmark } from "./Wordmark";
describe("Wordmark", () => {
  it("renders name_ with an aria-hidden cursor and an accessible name", () => {
    render(<Wordmark name="meowsenger" href="/" />);
    const link = screen.getByRole("link", { name: "meowsenger home" });
    expect(link).toHaveTextContent("meowsenger_");
    expect(link.querySelector(".mw-cursor")).toHaveAttribute("aria-hidden", "true");
  });
  it("renders a span without href", () => {
    const { container } = render(<Wordmark name="auth" />);
    expect(container.querySelector("span.mw-wordmark")).toHaveTextContent("auth_");
  });
});
// Cursor.test.tsx
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Cursor } from "./Cursor";
describe("Cursor", () => {
  it("is decorative and blinks by default", () => {
    const { container } = render(<Cursor />);
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
    expect(container.firstChild).toHaveClass("mw-cursor--blink");
  });
  it("can be static", () => {
    const { container } = render(<Cursor blink={false} />);
    expect(container.firstChild).not.toHaveClass("mw-cursor--blink");
  });
});
// Kbd.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Kbd } from "./Kbd";
describe("Kbd", () => {
  it("renders a kbd element", () => {
    render(<Kbd>Esc</Kbd>);
    expect(screen.getByText("Esc").tagName).toBe("KBD");
  });
});
```

Run: `cd packages/ui && bunx vitest run src/components/{StatusLine,Prompt,Wordmark,Cursor,Kbd}.test.tsx`

Expected: FAIL, because the modules aren't found.

- [ ] **Step 2: Implement the components**

```tsx
// Cursor.tsx
import { cx } from "../lib/cx";
export function Cursor({ blink = true }: { blink?: boolean }) {
  return <span className={cx("mw-cursor", blink && "mw-cursor--blink")} aria-hidden="true" />;
}
```

```tsx
// Wordmark.tsx
import { Cursor } from "./Cursor";
import { cx } from "../lib/cx";
export function Wordmark({ name, href, className }: { name: "meowerse" | "meowsenger" | "auth" | "ui"; href?: string; className?: string }) {
  const inner = <>{name}_<Cursor /></>;
  return href
    ? <a className={cx("mw-wordmark", className)} href={href} aria-label={`${name} home`}>{inner}</a>
    : <span className={cx("mw-wordmark", className)}>{inner}</span>;
}
```

```tsx
// Kbd.tsx
import type { ReactNode } from "react";
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mw-kbd">{children}</kbd>;
}
```

```tsx
// StatusLine.tsx
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
export type StatusState = "ok" | "wait" | "fail" | "info";
const TAG: Record<StatusState, string> = { ok: "[ ok ]", wait: "[wait]", fail: "[fail]", info: "[info]" };
export function StatusLine({ state, children, live = false, action, className }:
  { state: StatusState; children: ReactNode; live?: boolean; action?: ReactNode; className?: string }) {
  const role = state === "fail" ? "alert" : live ? "status" : undefined;
  return (
    <p className={cx("mw-status", `mw-status--${state}`, className)} role={role}>
      <span className="mw-status__tag" aria-hidden="true">{TAG[state]}</span>
      <span className="mw-status__text">{children}</span>
      {action && <span className="mw-status__action">{action}</span>}
    </p>
  );
}
```

```tsx
// Prompt.tsx
import { forwardRef, useId, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";

export type PromptProps = {
  label: string; placeholder?: string; value: string; onChange: (v: string) => void;
  onSubmit: (v: string) => void; sendLabel?: string; maxRows?: number; busy?: boolean;
  enterSends?: "auto" | "always" | "never"; className?: string;
};

const coarse = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

export const Prompt = forwardRef<HTMLTextAreaElement, PromptProps>(function Prompt(
  { label, placeholder, value, onChange, onSubmit, sendLabel = "send", maxRows = 6, busy = false, enterSends = "auto", className }, ref) {
  const id = useId();
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const empty = value.trim() === "";

  useLayoutEffect(() => {                         // auto-grow up to maxRows, then scroll
    const el = inner.current;
    if (!el) return;
    el.style.height = "auto";
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 24;
    el.style.height = `${Math.min(el.scrollHeight, lh * maxRows + 16)}px`;
  }, [value, maxRows]);

  const send = () => { if (!empty) onSubmit(value.trim()); };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    const sends = enterSends === "always" || (enterSends === "auto" && !coarse());
    if (!sends) return;
    e.preventDefault();
    send();
  };

  return (
    <div className={cx("mw-prompt", busy && "is-busy", className)}>
      <span className="mw-prompt__glyph" aria-hidden="true">›</span>
      <label htmlFor={id} className="sr-only">{label}</label>
      <textarea id={id} rows={1} value={value} placeholder={placeholder ?? label}
        ref={(el) => { inner.current = el; if (typeof ref === "function") ref(el); else if (ref) ref.current = el; }}
        onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown}
        enterKeyHint="send" autoComplete="off" aria-busy={busy || undefined} />
      <button type="button" className="mw-prompt__send" aria-label={sendLabel}
        aria-disabled={empty || undefined} onClick={send}>
        <Icon name="send" size={20} />
      </button>
    </div>
  );
});
```

If `Icon` has no `send` glyph, add `"send"` to the Tabler icon map in `Icon.tsx` the same way the
existing names are added, plus its test case.

Export all five from `src/index.ts`:

```ts
export { Wordmark } from "./components/Wordmark";
export { Cursor } from "./components/Cursor";
export { Kbd } from "./components/Kbd";
export { StatusLine, type StatusState } from "./components/StatusLine";
export { Prompt, type PromptProps } from "./components/Prompt";
```

- [ ] **Step 3: Add their CSS (append to `components.css`)**

These rules follow the §7.1 geometry.

```css
/* ---- tty family: shares --control-height, --c-line-input, --r-m, focus, disabled with Field/Button ---- */
.mw-wordmark { font-family: var(--font-mark); font-size: 1.75rem; line-height: 1; color: var(--c-fg); text-decoration: none; white-space: nowrap; display: inline-flex; align-items: center; }
a.mw-wordmark:hover { color: var(--c-accent); text-decoration: none; }
.mw-cursor { display: inline-block; width: .5em; height: .9em; margin-left: .06em; background: var(--c-accent-fill); vertical-align: -.08em; }
.mw-cursor--blink { animation: mw-blink 1.06s steps(1) infinite; }
@keyframes mw-blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .mw-cursor--blink { animation: none; } }

.mw-kbd { font: 500 var(--fs-1)/1 var(--font-mono); padding: 3px 6px; min-width: 1.6em; text-align: center; color: var(--c-fg); background: var(--c-surface); border: 1px solid var(--c-line-strong); border-bottom-width: 2px; border-radius: var(--r-s); }

.mw-status { display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--sp-2); margin: 0; font-size: var(--fs-3); line-height: var(--leading-normal); color: var(--c-fg-muted); }
.mw-status__tag { font-weight: 700; white-space: pre; }
.mw-status--ok .mw-status__tag { color: var(--c-ok); }
.mw-status--wait .mw-status__tag { color: var(--c-warn); }
.mw-status--fail .mw-status__tag, .mw-status--fail { color: var(--c-danger); }
.mw-status--info .mw-status__tag { color: var(--c-info); }
.mw-status__action { margin-left: auto; }

.mw-prompt { position: relative; display: flex; align-items: flex-end; gap: var(--sp-2); }
.mw-prompt__glyph { position: absolute; left: 12px; top: 10px; font-size: var(--fs-4); line-height: 24px; color: var(--c-fg-subtle); pointer-events: none; transition: color var(--d-fast) var(--ease); }
.mw-prompt:focus-within .mw-prompt__glyph { color: var(--c-accent); }
.mw-prompt textarea { flex: 1; min-height: var(--control-height); resize: none; overflow-y: auto; font: inherit; font-size: var(--fs-4); line-height: 24px; padding: 9px 12px 9px 32px; color: var(--c-fg); background: var(--c-bg-elev); border: 1px solid var(--c-line-input); border-radius: var(--r-m); }
.mw-prompt textarea::placeholder { color: var(--c-fg-subtle); }
.mw-prompt textarea:focus-visible { outline: 2px solid var(--c-focus); outline-offset: 2px; }
.mw-prompt__send { flex: none; width: var(--control-height); height: var(--control-height); display: inline-flex; align-items: center; justify-content: center; border-radius: var(--r-m); border: 0; background: var(--c-accent-fill); color: var(--c-on-accent); cursor: pointer; }
.mw-prompt__send[aria-disabled="true"] { opacity: var(--disabled-opacity); cursor: not-allowed; }
.mw-prompt.is-busy .mw-prompt__send { opacity: .75; }
```

- [ ] **Step 4: Run the tests**

Run: `bun run --filter @meowerse/ui test`

Expected: PASS and coverage ≥ 90.

- [ ] **Step 5: Commit**

```bash
git add -A packages/ui
git commit -m "feat(ui): Wordmark, Cursor, Kbd, StatusLine, Prompt — tty family on shared geometry (spec §7, B10)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Restyle the existing components on the v2 tokens (spec §3, U-09, U-10, A-19, A-21)

**Files:**
- Modify: `packages/ui/src/styles/components.css` (everything above the tty block from Task 7),
  `packages/ui/src/styles/base.css`, `packages/ui/src/styles/layout.css`
- Test: `packages/ui/src/styles/geometry.test.ts`

**Interfaces:** CSS only. Class names are unchanged, so every app picks the styles up.

- [ ] **Step 1: Write the failing geometry test (`src/styles/geometry.test.ts`)**

This asserts the §7.1 invariants statically. jsdom doesn't do layout, so the test reads the source.

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "components.css"), "utf8");
const rule = (sel: string) => {
  const m = css.match(new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`missing rule ${sel}`);
  return m[2];
};

describe("B10 geometry: tty and app controls share one shape", () => {
  it.each([".mw-btn--md", ".mw-field input", ".mw-prompt textarea"])("%s is control-height tall", (sel) =>
    expect(rule(sel)).toMatch(/min-height:\s*var\(--control-height\)/));
  it.each([".mw-btn", ".mw-field input", ".mw-prompt textarea", ".mw-prompt__send"])("%s uses --r-m", (sel) =>
    expect(rule(sel)).toMatch(/border-radius:\s*var\(--r-m\)/));
  it.each([".mw-field input", ".mw-prompt textarea"])("%s has a 1px line-input border and 16px text", (sel) => {
    expect(rule(sel)).toMatch(/border:\s*1px solid var\(--c-line-input\)/);
    expect(rule(sel)).toMatch(/font-size:\s*var\(--fs-4\)/);
  });
  it("no hard-coded colours, sub-pixel borders, or off-scale radii", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/0\.5px/);
    expect(css).not.toMatch(/border-radius:\s*(?!var\(--r-[slm]\)|50%|0)[^;]+;/);
  });
  it("disabled looks the same everywhere", () => {
    expect(rule(".mw-btn:disabled")).toMatch(/opacity:\s*var\(--disabled-opacity\)/);
  });
});
```

Run: `cd packages/ui && bunx vitest run src/styles/geometry.test.ts`

Expected: FAIL, because of the current 42 px heights, 0.5 px borders and hex colours.

- [ ] **Step 2: Rewrite the component rules**

Replace each existing rule in `components.css` (everything above the tty block) according to this
table. Each target value is exact; keep the selectors.

| Component | New values |
|---|---|
| `.mw-spinner` | `border: 2px solid var(--c-line-strong); border-top-color: var(--c-accent-fill); border-radius: 50%` |
| `.mw-btn` | `font: 500 var(--fs-3)/1 var(--font-mono); border-radius: var(--r-m); border: 1px solid transparent; gap: var(--sp-2); transition: background var(--d-fast) var(--ease), border-color var(--d-fast) var(--ease)` (no scale on `:active` under reduced motion) |
| `.mw-btn--md` | `min-height: var(--control-height); padding: 0 var(--sp-4)` |
| `.mw-btn--sm` | `min-height: 36px; padding: 0 var(--sp-3); font-size: var(--fs-2)` plus `position: relative` and `::after { content: ""; position: absolute; inset: -4px 0; }` to keep a 44 px hit area |
| `.mw-btn:disabled` | `opacity: var(--disabled-opacity); cursor: not-allowed` |
| `.mw-btn--primary` | `background: var(--c-accent-fill); color: var(--c-on-accent)`; hover: `background: color-mix(in srgb, var(--c-accent-fill) 88%, var(--c-fg))` |
| `.mw-btn--secondary` | `background: transparent; color: var(--c-fg); border-color: var(--c-line-strong)`; hover `background: var(--c-surface)` |
| `.mw-btn--ghost` | `color: var(--c-fg-muted)`; hover `background: var(--c-surface); color: var(--c-fg)` |
| `.mw-btn--danger` | `background: var(--c-danger); color: var(--c-on-danger)` (U-10: 6.57:1 light, 7.03:1 dark) |
| `.mw-field` | `gap: var(--sp-1)`; `> label { font-size: var(--fs-2); color: var(--c-fg-muted) }` |
| `.mw-field input` | `min-height: var(--control-height); padding: 0 var(--sp-3); font: inherit; font-size: var(--fs-4); color: var(--c-fg); background: var(--c-bg-elev); border: 1px solid var(--c-line-input); border-radius: var(--r-m)` (A-21: 16 px, no iOS zoom) |
| `.mw-field input:focus-visible` | `outline: 2px solid var(--c-focus); outline-offset: 2px` |
| `.mw-field--error input` | `border-color: var(--c-danger)` |
| `.mw-field__reveal` | `width: 40px; height: 40px; right: 2px; color: var(--c-fg-subtle)` (a 40 px target inside a 44 px field) |
| `.mw-field__hint` / `__error` | `font-size: var(--fs-2)`; `color: var(--c-fg-subtle)` / `var(--c-danger)` |
| `.mw-check input`, `.mw-radio__opt input` | `width: 20px; height: 20px; accent-color: var(--c-accent-fill)`; the label row has `min-height: var(--control-height)` |
| `.mw-radio` | `border: 1px solid var(--c-line); border-radius: var(--r-m)` |
| `.mw-card` | `background: var(--c-bg-elev); border: 1px solid var(--c-line); border-radius: var(--r-l); padding: var(--sp-5); box-shadow: none` |
| `.mw-card__title` | `font-size: var(--fs-4); font-weight: 700` |
| `.mw-badge` | `font-size: var(--fs-1); padding: 2px var(--sp-2); border-radius: var(--r-s); border: 1px solid currentColor`; verified: `color: var(--c-accent); background: transparent`; neutral: `color: var(--c-fg-muted)`; danger: `color: var(--c-danger); background: var(--c-danger-tint)` |
| `.mw-alert` | `border: 1px solid; border-radius: var(--r-m); padding: var(--sp-3); font-size: var(--fs-3)`; error: `color: var(--c-danger); background: var(--c-danger-tint); border-color: var(--c-danger)`; success: `color: var(--c-ok); background: var(--c-surface); border-color: var(--c-ok)`; info: `color: var(--c-fg-muted); background: var(--c-surface); border-color: var(--c-line-strong)` |
| `.mw-code code` | `background: var(--c-surface); border: 1px solid var(--c-line); border-radius: var(--r-s); font-size: var(--fs-2)` |
| `.mw-code__copy`, `.mw-alert__x` | `min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center` |
| `.mw-avatar` | `border-radius: var(--r-m); background: var(--c-surface); color: var(--c-accent); font-weight: 700` (rounded squares, per audit M §7 geometry) |
| `.mw-modal` | `z-index: var(--z-sheet)`; `__backdrop { background: var(--c-scrim) }`; `__panel { max-width: 420px; background: var(--c-surface-raised); border: 1px solid var(--c-line-strong); border-radius: var(--r-l); padding: var(--sp-5); box-shadow: var(--shadow-lg) }`; `__title { font-size: var(--fs-5); font-weight: 700 }` |
| `.mw-toasts` | `z-index: var(--z-toast); bottom: max(var(--sp-4), env(safe-area-inset-bottom))` |
| `.mw-toast` | `border: 1px solid var(--c-line-strong); border-radius: var(--r-m); background: var(--c-surface-raised); color: var(--c-fg)`; success border `var(--c-ok)`, error border `var(--c-danger)` |
| `.mw-recovery` | `border: 1px solid var(--c-line); border-radius: var(--r-m)` |
| `.mw-themetoggle`, `.mw-header__burger`, `.mw-contacts__link` | `width: 44px; height: 44px; border: 1px solid var(--c-line); border-radius: var(--r-m); color: var(--c-fg-muted)`; hover `background: var(--c-surface); color: var(--c-fg)` |
| `.mw-footer` | `border-top: 1px solid var(--c-line)`; links `color: var(--c-fg-muted)`, hover `var(--c-fg)` |
| `.mw-header` | `z-index: var(--z-chrome); border-bottom: 1px solid var(--c-line); background: var(--c-bg)`; `.mw-header__brand { font-family: var(--font-mark); font-size: 1.75rem }`; nav links `color: var(--c-fg-muted)`; mobile nav panel `background: var(--c-surface-raised); border-bottom: 1px solid var(--c-line)`, and its links get `min-height: var(--control-height)` |
| `.mw-gate--error` | `flex-direction: column; gap: var(--sp-4); text-align: center` |
| `.mw-confirm__phrase code` | `font-family: var(--font-mono); padding: 1px 6px; background: var(--c-surface); border: 1px solid var(--c-line); border-radius: var(--r-s)` |

In `base.css` and `layout.css`, replace every legacy variable with its v2 token:
- `--text-*` colours → `--c-fg*`;
- `--border` → `--c-line`;
- `--surface-muted` → `--c-surface`;
- `--radius*` → `--r-*`;
- `h1..h4` weights → `700`;
- remove the negative `letter-spacing` (mono);
- `a { color: var(--c-accent) }`.

- [ ] **Step 3: Run the tests**

Run: `bun run --filter @meowerse/ui test`

Expected: PASS, including `geometry.test.ts`.

- [ ] **Step 4: Visual check of the three apps**

Build each app and screenshot its key pages at 390×844 and 1440×900, in dark and light, into
`/var/tmp/brand-v2/sp1-shots/`. Use `bunx playwright screenshot` against `astro preview` on ports
4370–4372. Pages:
- auth-web: `/`, `/login`, `/signup`, `/account` (AuthGate spinner is fine), `/developers`;
- meowsenger-web: `/`;
- web: `/`.

Check by eye:
- nothing overflows horizontally;
- no text is invisible;
- no leftover light-only colour on dark.

Fix any app-local CSS that hard-codes a light colour only by swapping it to the matching alias
variable. The full app restyles are sub-projects 2–4. List the pages and the fixes in the commit body.

- [ ] **Step 5: Commit**

```bash
git add -A packages/ui apps
git commit -m "feat(ui): restyle all components on v2 tokens — 44px controls, 1px lines, 2/4/8 radii, AA danger/focus (U-09, U-10, A-19, A-21)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Theme default and init script (spec §2.1)

**Files:**
- Modify: `packages/ui/src/lib/theme.ts`, `packages/ui/src/components/ThemeToggle.tsx`
- Test: `packages/ui/src/lib/theme.test.ts`

**Interfaces:**
- `resolvedTheme()` now returns `"dark"` unless the stored or system value is light.
- `THEME_INIT_SCRIPT` is unchanged in shape.

- [ ] **Step 1: Write the failing test (append to `theme.test.ts`)**

```ts
it("resolves to dark when there is no stored choice and no system light preference", () => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q }));
  expect(resolvedTheme()).toBe("dark");
});
it("resolves to light only when the system prefers light", () => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(prefers-color-scheme: light)", media: q }));
  expect(resolvedTheme()).toBe("light");
});
```

Run: `cd packages/ui && bunx vitest run src/lib/theme.test.ts`

Expected: the first test FAILs, since today it returns light.

- [ ] **Step 2: Implement it**

```ts
export function resolvedTheme(): "light" | "dark" {
  const t = getTheme();
  if (t !== "system") return t;
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
```

Update any existing theme test that asserted the old light default so it asserts dark. Mention it in
the commit.

- [ ] **Step 3: Run the tests**

Run: `bun run --filter @meowerse/ui test`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A packages/ui/src/lib
git commit -m "feat(ui): dark by default, light only by choice or system preference

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Cat3D (spec §4, B4)

**Files:**
- Create:
  - `packages/ui/scripts/extract-cat.ts`
  - `packages/ui/scripts/cat-poster.ts`
  - `packages/ui/src/cat3d/math.ts`
  - `packages/ui/src/cat3d/renderer.ts`
  - `packages/ui/src/cat3d/Cat3D.tsx`
  - `packages/ui/src/cat3d/cat.bin` (generated, committed)
  - `packages/ui/src/cat3d/cat-poster.webp` (generated, committed)
- Test: `packages/ui/src/cat3d/math.test.ts`, `packages/ui/src/cat3d/Cat3D.test.tsx`
- Modify: `packages/ui/src/index.ts`, `packages/ui/package.json` (devDependencies
  `@gltf-transform/core`, `@gltf-transform/extensions`, `meshoptimizer`, `playwright`)

**Interfaces:**
- **`cat.bin` layout**, all little-endian:
  - header `Uint32[4]` = `[magic 0x43415433 "CAT3", bodyVerts, headVerts, reserved 0]`;
  - `Float32[3]` head pivot;
  - `Float32[3]` head forward;
  - `Float32[3]` bbox min;
  - `Float32[3]` bbox size;
  - then `Int16[3]` quantised positions: body+tail triangles first, then head triangles
    (non-indexed, flat).
- `math.ts` produces:

```ts
export type Vec3 = [number, number, number];
export function aim(px: number, py: number, maxYaw?: number, maxPitch?: number): { yaw: number; pitch: number }; // px,py in [-1,1]
export function ease(current: number, target: number, dt: number, rate?: number): number;
export function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array;
export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Float32Array;
export function multiply(a: Float32Array, b: Float32Array): Float32Array;
export function rotateYX(yaw: number, pitch: number, pivot: Vec3): Float32Array; // model matrix for the head
```

- `renderer.ts` produces
  `export function mount(canvas: HTMLCanvasElement, bin: ArrayBuffer, opts: { color: string; light: string }): { setAim(px: number, py: number): void; destroy(): void } | null`.
  It returns `null` when WebGL2 is unavailable.
- `Cat3D.tsx` produces `export function Cat3D(p: { size?: number; className?: string }): JSX.Element`.
  It's decorative (`aria-hidden`), always renders the poster `<img>` first, and swaps to the canvas
  only after a successful mount.

- [ ] **Step 1: Extract the mesh (`scripts/extract-cat.ts`)**

```ts
// alxnko.dev desk.glb → src/cat3d/cat.bin (see Interfaces for the layout). Build-time only; output committed.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = process.env.CAT_GLB ?? fileURLToPath(new URL("../../../../alxnko.dev/public/scene/desk.31f91316.glb", import.meta.url));
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
const doc = await io.read(SRC);
const nodes = new Map(doc.getRoot().listNodes().map((n) => [n.getName(), n]));

function triangles(name: string): number[] {
  const node = nodes.get(name);
  if (!node?.getMesh()) throw new Error(`${name} not found in ${SRC}`);
  const m = node.getWorldMatrix();
  const out: number[] = [];
  for (const prim of node.getMesh()!.listPrimitives()) {
    const pos = prim.getAttribute("POSITION")!;
    const idx = prim.getIndices();
    const count = idx ? idx.getCount() : pos.getCount();
    const p: number[] = [0, 0, 0];
    for (let i = 0; i < count; i++) {
      pos.getElement(idx ? idx.getScalar(i) : i, p);
      out.push(
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]);
    }
  }
  return out;
}

const body = [...triangles("cat_body"), ...triangles("cat_tail")];
const head = triangles("cat_head");
const headNode = nodes.get("cat_head")!;
const pivot = headNode.getWorldTranslation();                    // cat_head pivots at the neck (build.py)
const fwd = (headNode.getExtras() as { forward?: number[] }).forward ?? [0, -1, 0];
const all = [...body, ...head];
const min = [0, 1, 2].map((k) => Math.min(...all.filter((_, i) => i % 3 === k)));
const max = [0, 1, 2].map((k) => Math.max(...all.filter((_, i) => i % 3 === k)));
const size = max.map((v, k) => v - min[k]);

const header = new Uint32Array([0x43415433, body.length / 3, head.length / 3, 0]);
const floats = new Float32Array([...pivot, ...fwd, ...min, ...size]);
const q = new Int16Array(all.length);
for (let i = 0; i < all.length; i++) q[i] = Math.round(((all[i] - min[i % 3]) / size[i % 3]) * 65535 - 32768);
const out = new Uint8Array(header.byteLength + floats.byteLength + q.byteLength);
out.set(new Uint8Array(header.buffer), 0);
out.set(new Uint8Array(floats.buffer), header.byteLength);
out.set(new Uint8Array(q.buffer), header.byteLength + floats.byteLength);
writeFileSync(fileURLToPath(new URL("../src/cat3d/cat.bin", import.meta.url)), out);
console.log(`cat.bin: ${out.byteLength} bytes, ${body.length / 9 + head.length / 9} triangles`);
```

Run: `cd packages/ui && bun add -d @gltf-transform/core @gltf-transform/extensions meshoptimizer && bun scripts/extract-cat.ts`

Expected: it prints `cat.bin: N bytes` with N ≤ 25 600. If N is larger, stop and report. Don't
decimate silently; the owner approved "15–25 KB".

- [ ] **Step 2: Write the failing `math.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { aim, ease, lookAt, multiply, perspective, rotateYX } from "./math";

describe("cat3d math", () => {
  it("aim maps the pointer to clamped yaw/pitch (degrees → radians)", () => {
    expect(aim(0, 0)).toEqual({ yaw: 0, pitch: 0 });
    const r = aim(1, -1);
    expect(r.yaw).toBeCloseTo((35 * Math.PI) / 180);
    expect(r.pitch).toBeCloseTo((-20 * Math.PI) / 180);
    expect(aim(5, 5)).toEqual(aim(1, 1));
  });
  it("ease approaches the target and never overshoots", () => {
    const v = ease(0, 1, 1 / 60);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
    expect(ease(0, 1, 10)).toBeCloseTo(1, 5);
  });
  it("identity-ish sanity: rotateYX(0,0) is identity; perspective/lookAt are finite", () => {
    expect(Array.from(rotateYX(0, 0, [1, 2, 3]))).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const vp = multiply(perspective(0.6, 1, 0.01, 10), lookAt([0, -1, 0.5], [0, 0, 0], [0, 0, 1]));
    expect(vp.every(Number.isFinite)).toBe(true);
  });
});
```

Run: `cd packages/ui && bunx vitest run src/cat3d/math.test.ts`

Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `math.ts`**

```ts
export type Vec3 = [number, number, number];
const D = Math.PI / 180;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function aim(px: number, py: number, maxYaw = 35, maxPitch = 20) {
  return { yaw: clamp(px, -1, 1) * maxYaw * D, pitch: clamp(py, -1, 1) * maxPitch * D };
}
export function ease(current: number, target: number, dt: number, rate = 8) {
  return target + (current - target) * Math.exp(-rate * dt);
}
export function perspective(fovy: number, aspect: number, near: number, far: number) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
export function lookAt(eye: Vec3, t: Vec3, up: Vec3) {
  const z = norm([eye[0] - t[0], eye[1] - t[1], eye[2] - t[2]]);
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}
export function multiply(a: Float32Array, b: Float32Array) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
/** Head model matrix: yaw about world Z (up), then pitch about X, both around the neck pivot. */
export function rotateYX(yaw: number, pitch: number, p: Vec3) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const r = new Float32Array([cy, sy, 0, 0, -sy * cp, cy * cp, sp, 0, sy * sp, -cy * sp, cp, 0, 0, 0, 0, 1]);
  const t = (m: Float32Array, v: Vec3) => { m[12] = v[0]; m[13] = v[1]; m[14] = v[2]; return m; };
  const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const m = multiply(t(identity(), p), multiply(r, t(identity(), [-p[0], -p[1], -p[2]])));
  return m.map((v) => (Object.is(v, -0) ? 0 : v)) as Float32Array;
}
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
```

Run: `cd packages/ui && bunx vitest run src/cat3d/math.test.ts`

Expected: PASS.

- [ ] **Step 4: Implement `renderer.ts`**

This is WebGL2 with flat shading from screen-space derivatives: no normals are stored, and one
directional light plus ambient.

```ts
import { aim, ease, lookAt, multiply, perspective, rotateYX, type Vec3 } from "./math";

const VS = `#version 300 es
in vec3 aPos; uniform mat4 uVP; uniform mat4 uModel; uniform vec3 uMin; uniform vec3 uSize;
out vec3 vWorld;
void main(){ vec3 p = uMin + (aPos / 65535.0 + 0.5) * uSize; vec4 w = uModel * vec4(p,1.0); vWorld = w.xyz; gl_Position = uVP * w; }`;
const FS = `#version 300 es
precision mediump float; in vec3 vWorld; uniform vec3 uColor; uniform vec3 uLight; out vec4 o;
void main(){ vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld))); float d = max(dot(n, normalize(vec3(-0.4,-0.8,0.9))), 0.0);
  o = vec4(uColor * (0.35 + 0.65 * d) + uLight * pow(d, 12.0) * 0.25, 1.0); }`;

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

export function mount(canvas: HTMLCanvasElement, bin: ArrayBuffer, opts: { color: string; light: string }) {
  const gl = canvas.getContext("webgl2", { antialias: true, alpha: true, powerPreference: "low-power" });
  if (!gl) return null;
  const u32 = new Uint32Array(bin, 0, 4);
  if (u32[0] !== 0x43415433) return null;
  const [, bodyN, headN] = u32;
  const f = new Float32Array(bin, 16, 12);
  const pivot = [f[0], f[1], f[2]] as Vec3, min = [f[6], f[7], f[8]] as Vec3, size = [f[9], f[10], f[11]] as Vec3;
  const pos = new Int16Array(bin, 64, (bodyN + headN) * 3);

  const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 3, gl.SHORT, false, 0, 0);
  const U = (n: string) => gl.getUniformLocation(prog, n);
  gl.uniform3fv(U("uMin"), min); gl.uniform3fv(U("uSize"), size);
  gl.uniform3fv(U("uColor"), hex(opts.color)); gl.uniform3fv(U("uLight"), hex(opts.light));
  gl.enable(gl.DEPTH_TEST);

  const center: Vec3 = [min[0] + size[0] / 2, min[1] + size[1] / 2, min[2] + size[2] / 2];
  const r = Math.hypot(...size) * 0.62;
  const eye: Vec3 = [center[0] + r * 0.35, center[1] - r * 1.6, center[2] + r * 0.55];   // front, slightly above
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  let yaw = 0, pitch = 0, tYaw = 0, tPitch = 0, raf = 0, last = 0, dirty = true;

  const frame = (now: number) => {
    raf = 0;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016); last = now;
    yaw = ease(yaw, tYaw, dt); pitch = ease(pitch, tPitch, dt);
    const w = canvas.clientWidth * devicePixelRatio | 0, h = canvas.clientHeight * devicePixelRatio | 0;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(U("uVP"), false, multiply(perspective(0.55, w / h || 1, r * 0.05, r * 6), lookAt(eye, center, [0, 0, 1])));
    gl.uniformMatrix4fv(U("uModel"), false, identity); gl.drawArrays(gl.TRIANGLES, 0, bodyN);
    gl.uniformMatrix4fv(U("uModel"), false, rotateYX(yaw, pitch, pivot)); gl.drawArrays(gl.TRIANGLES, bodyN, headN);
    const settled = Math.abs(yaw - tYaw) < 1e-4 && Math.abs(pitch - tPitch) < 1e-4;
    if (!settled || dirty) { dirty = false; raf = requestAnimationFrame(frame); } else last = 0;
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
  kick();
  return {
    setAim(px: number, py: number) { const a = aim(px, py); tYaw = a.yaw; tPitch = a.pitch; kick(); },
    destroy() { cancelAnimationFrame(raf); gl.getExtension("WEBGL_lose_context")?.loseContext(); },
  };
}
```

Rendering stops when settled: there's no idle frame loop.

- [ ] **Step 5: Write the failing `Cat3D.test.tsx`, then implement `Cat3D.tsx`**

```tsx
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cat3D } from "./Cat3D";

afterEach(() => vi.unstubAllGlobals());

describe("Cat3D", () => {
  it("is decorative and renders the poster first", () => {
    const { container } = render(<Cat3D />);
    const root = container.firstElementChild!;
    expect(root).toHaveAttribute("aria-hidden", "true");
    expect(root.querySelector("img")).toHaveAttribute("alt", "");
  });
  it("stays on the poster when motion is reduced (never loads the renderer)", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
    const io = vi.fn();
    vi.stubGlobal("IntersectionObserver", class { constructor() { io(); } observe() {} disconnect() {} });
    const { container } = render(<Cat3D />);
    expect(io).not.toHaveBeenCalled();
    expect(container.querySelector("canvas")).toHaveAttribute("hidden");
  });
});
```

```tsx
// Cat3D.tsx — tiny decorative 3D cat (spec §4). Poster first; the WebGL2 renderer loads lazily when visible,
// never on reduced motion / save-data, and any failure just leaves the poster.
import { useEffect, useRef, useState } from "react";
import { cx } from "../lib/cx";
import poster from "./cat-poster.webp";
import binUrl from "./cat.bin?url";

const skip = () =>
  typeof matchMedia === "undefined" || matchMedia("(prefers-reduced-motion: reduce)").matches ||
  (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;

export function Cat3D({ size = 160, className }: { size?: number; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (skip() || typeof IntersectionObserver === "undefined") return;
    let api: { setAim(x: number, y: number): void; destroy(): void } | null = null;
    let gone = false;
    const onMove = (e: PointerEvent) => {
      const r = root.current!.getBoundingClientRect();
      api?.setAim(((e.clientX - (r.left + r.width / 2)) / (innerWidth / 2)), -((e.clientY - (r.top + r.height / 2)) / (innerHeight / 2)));
    };
    const io = new IntersectionObserver(async ([e]) => {
      if (!e?.isIntersecting || api || gone) return;
      io.disconnect();
      try {
        const [{ mount }, buf] = await Promise.all([import("./renderer"), fetch(binUrl).then((r) => r.arrayBuffer())]);
        if (gone || !canvas.current) return;
        const s = getComputedStyle(root.current!);
        api = mount(canvas.current, buf, { color: s.getPropertyValue("--cat-color").trim() || "#14995a", light: "#63d396" });
        if (!api) return;
        canvas.current.addEventListener("webglcontextlost", () => setLive(false), { once: true });
        addEventListener("pointermove", onMove, { passive: true });
        setLive(true);
      } catch { /* network or GL failure: the poster stays — decorative only */ }
    }, { rootMargin: "200px" });
    io.observe(root.current!);
    return () => { gone = true; io.disconnect(); removeEventListener("pointermove", onMove); api?.destroy(); };
  }, []);

  return (
    <div ref={root} className={cx("mw-cat3d", className)} style={{ width: size, height: size }} aria-hidden="true">
      <img src={typeof poster === "string" ? poster : (poster as { src: string }).src} alt="" width={size} height={size} hidden={live} decoding="async" />
      <canvas ref={canvas} hidden={!live} />
    </div>
  );
}
```

Add a test stub in `packages/ui/test/setup.ts` for the asset imports under vitest:

```ts
vi.mock("../src/cat3d/cat-poster.webp", () => ({ default: "cat-poster.webp" }));
vi.mock("../src/cat3d/cat.bin?url", () => ({ default: "cat.bin" }));
```

Add `import { vi } from "vitest";` there. Add `src/assets.d.ts`:

```ts
declare module "*.webp" { const src: string | { src: string }; export default src; }
declare module "*?url" { const url: string; export default url; }
```

Add this CSS to `components.css`:
`.mw-cat3d { position: relative; --cat-color: #14995a; } .mw-cat3d > img, .mw-cat3d > canvas { position: absolute; inset: 0; width: 100%; height: 100%; }`.
Also add `#14995a` to the test's allowlist: the cat's material colour comes from the alxnko.dev
scene, not the UI palette. Change the hex assertion in `geometry.test.ts` to
`expect(css.replace("--cat-color: #14995a", "")).not.toMatch(/#[0-9a-f]{3,8}\b/i);`.

Export `export { Cat3D } from "./cat3d/Cat3D";` from `src/index.ts`.

Run: `bun run --filter @meowerse/ui test`

Expected: PASS and coverage ≥ 90. `renderer.ts` is excluded from unit coverage: add
`"src/cat3d/renderer.ts"` to `coverage.exclude` with a comment that it's verified by the Playwright
poster script in Step 6.

- [ ] **Step 6: Render the poster and verify the renderer in a real GPU browser (`scripts/cat-poster.ts`)**

```ts
// Renders the rest pose with the real renderer in Chromium → src/cat3d/cat-poster.webp (320×320, transparent),
// and fails if the canvas is blank (proves renderer.ts + cat.bin work end to end).
import { chromium } from "playwright";
import { build } from "bun";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WORK = "/var/tmp/brand-v2/cat-poster";
mkdirSync(WORK, { recursive: true });
const out = await build({ entrypoints: [fileURLToPath(new URL("../src/cat3d/renderer.ts", import.meta.url))], outdir: WORK, minify: true, target: "browser" });
if (!out.success) throw new Error("bundle failed");
const js = readFileSync(`${WORK}/renderer.js`, "utf8");
const bin = readFileSync(fileURLToPath(new URL("../src/cat3d/cat.bin", import.meta.url))).toString("base64");
const html = `<!doctype html><body style="margin:0;background:transparent"><canvas id=c style="width:320px;height:320px"></canvas>
<script type=module>${js.replace(/export\s*\{[^}]*\}/, "")}
const b=Uint8Array.from(atob("${bin}"),c=>c.charCodeAt(0)).buffer;
window.api=mount(document.getElementById('c'),b,{color:'#14995a',light:'#63d396'});</script>`;
const browser = await chromium.launch({ args: ["--use-angle=gl-egl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 320, height: 320 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.waitForFunction(() => (window as unknown as { api: unknown }).api !== undefined);
await page.waitForTimeout(300);
const png = await page.locator("#c").screenshot({ omitBackground: true });
await browser.close();
writeFileSync(`${WORK}/poster.png`, png);
const blank = png.length < 2000;
if (blank) throw new Error("renderer produced a blank canvas");
const cwebp = Bun.spawnSync(["cwebp", "-q", "90", "-alpha_q", "100", `${WORK}/poster.png`, "-o", fileURLToPath(new URL("../src/cat3d/cat-poster.webp", import.meta.url))]);
if (cwebp.exitCode !== 0) throw new Error(cwebp.stderr.toString());
console.log("poster written");
```

Run: `cd packages/ui && bun add -d playwright && bunx playwright install chromium && bun scripts/cat-poster.ts`

Then open `/var/tmp/brand-v2/cat-poster/poster.png` with the Read tool to confirm it's the green
low-poly cat, recognisable, with its head facing the viewer.

Expected: `poster written`, the webp is ≤ 12 KB, and the image shows the cat. If the build uses a
bundled `export {mount}` form that the regex doesn't strip, swap the regex for building with
`format: "iife"` and `globalName: "Cat"`, then call `Cat.mount(...)`.

- [ ] **Step 7: Check the renderer budget**

Run:

```bash
bun build packages/ui/src/cat3d/renderer.ts --minify --target browser --outfile /var/tmp/brand-v2/r.js && gzip -9c /var/tmp/brand-v2/r.js | wc -c
```

Expected: ≤ 8192 bytes.

- [ ] **Step 8: Commit**

```bash
git add -A packages/ui bun.lock
git commit -m "feat(ui): Cat3D — tiny WebGL2 low-poly cat from the alxnko.dev desk, lazy, poster fallback (spec §4, B4)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Token drift check, and upstreaming B17 to alxnko.dev (B5, B17)

**Files:**
- Create: `packages/ui/scripts/tokens-drift.ts`, `packages/ui/scripts/tokens-drift.test.ts`
- Modify: `justfile`, `packages/ui/package.json`
- Other repo, separate PR: `alxnko.dev/design/tokens.json`, `alxnko.dev/src/styles/tokens.css`
  (regenerated)

**Interfaces:**
`export function drift(a: unknown, b: unknown, path?: string): string[]` returns the list of differing
paths. The check covers every key that exists in either file, except `control` and `type.leading`,
which alxnko.dev may add later.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { drift } from "./tokens-drift";

describe("drift", () => {
  it("reports differing and missing leaves by path", () => {
    expect(drift({ a: { x: 1, y: 2 } }, { a: { x: 1, y: 3, z: 4 } })).toEqual(["a.y", "a.z"]);
  });
  it("is empty for equal trees", () => {
    expect(drift({ a: [1, 2] }, { a: [1, 2] })).toEqual([]);
  });
});
```

Run: `cd packages/ui && bunx vitest run scripts/tokens-drift.test.ts`

Expected: FAIL.

- [ ] **Step 2: Implement `scripts/tokens-drift.ts`**

```ts
// Compares packages/ui/design/tokens.json with alxnko.dev's design/tokens.json (B5).
// Local: ALXNKO_DEV_DIR (default ../../../alxnko.dev from the repo root). CI: skipped with a notice
// when the private repo isn't checked out — `just tokens-drift` is part of the release checklist.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function drift(a: unknown, b: unknown, path = ""): string[] {
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null)
    return JSON.stringify(a) === JSON.stringify(b) ? [] : [path];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.flatMap((k) => drift((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
}

if (import.meta.main) {
  const dir = process.env.ALXNKO_DEV_DIR ?? resolve(import.meta.dir, "../../../../alxnko.dev");
  const theirs = resolve(dir, "design/tokens.json");
  if (!existsSync(theirs)) { console.warn(`tokens-drift: ${theirs} not found — skipped`); process.exit(0); }
  const ours = JSON.parse(readFileSync(resolve(import.meta.dir, "../design/tokens.json"), "utf8"));
  const other = JSON.parse(readFileSync(theirs, "utf8"));
  const diff = drift(ours, other).filter((p) => !p.startsWith("control") && !p.startsWith("type.leading"));
  if (diff.length) { console.error("token drift vs alxnko.dev:\n  " + diff.join("\n  ")); process.exit(1); }
  console.log("tokens in sync with alxnko.dev");
}
```

Add a `"tokens:drift": "bun scripts/tokens-drift.ts"` script, and this to the justfile:

```
# Check @meowerse/ui tokens against the alxnko.dev repo (B5). Set ALXNKO_DEV_DIR if not a sibling checkout.
tokens-drift:
    bun run --filter @meowerse/ui tokens:drift
```

Run: `cd packages/ui && bunx vitest run scripts/tokens-drift.test.ts && bun run tokens:drift`

Expected: the tests PASS, and the check FAILs listing the B17 keys (`semantic.dark.ok`,
`z.toast`, …). That's expected until Step 3 lands.

- [ ] **Step 3: Upstream B17 to alxnko.dev (separate PR in that repo)**

```bash
cd /home/alxnko/Projects/code/meow/alxnko.dev
git fetch origin && git worktree add .claude/worktrees/tokens-b17 -b feat/tokens-b17 origin/main
cd .claude/worktrees/tokens-b17
bun install --frozen-lockfile
```

Copy the `semantic` and `z` groups from `packages/ui/design/tokens.json` into `design/tokens.json`.
`control` and `type.leading` are optional there and not copied. Then:

```bash
bun run tokens && bun run lint && bun run test && bun run build && bun run budget
```

Expected: all green. The new variables are unused on the site, so the 3D chunk budget is unaffected.

Commit
`feat(tokens): add ok/info/onDanger/dangerTint/surfaceRaised/lineInput/scrim + z.toast (meowerse B17)`
with the Co-Authored-By line. Push, open the PR, review, wait for CI to go green, merge with a merge
commit, then run the alxnko.dev deploy chain from memory (`alxnko-dev-desk-redesign.md`: wrangler
Pages deploy, verify live). Remove the worktree.

- [ ] **Step 4: Re-run the drift check**

Run: `cd meowerse/.claude/worktrees/brand-v2-ds && just tokens-drift`

Expected: `tokens in sync with alxnko.dev`.

- [ ] **Step 5: Commit (meowerse)**

```bash
git add -A packages/ui justfile
git commit -m "feat(ui): tokens drift check against alxnko.dev (B5)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Deploy triggers (audit: web-and-ui "deploy trigger paths")

**Files:**
- Modify: `.github/workflows/deploy.yml:36-40`

**Interfaces:** none.

- [ ] **Step 1: Make shared-package changes redeploy the apps that ship them**

In the `Detect changed services` step, change the web, auth and meowsenger patterns to:

```bash
grep -qE '^(apps/web/|packages/ts-shared/|packages/ui/|packages/brand/)' <<<"$diff" && echo "web=1" >> "$GITHUB_OUTPUT" || echo "web=0" >> "$GITHUB_OUTPUT"
grep -qE '^(workers/auth/|apps/auth-web/|packages/auth-shared/|packages/ui/|packages/brand/)' <<<"$diff" && echo "auth=1" >> "$GITHUB_OUTPUT" || echo "auth=0" >> "$GITHUB_OUTPUT"
grep -qE '^(workers/meowsenger/|apps/meowsenger-web/|packages/auth-shared/|packages/auth-sdk/|packages/ui/|packages/brand/)' <<<"$diff" && echo "meowsenger=1" >> "$GITHUB_OUTPUT" || echo "meowsenger=0" >> "$GITHUB_OUTPUT"
```

- [ ] **Step 2: Validate the workflow**

Run: `bunx --bun yaml-lint .github/workflows/deploy.yml || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/deploy.yml'))"`

Expected: no error.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci(deploy): packages/ui and packages/brand changes redeploy web, auth and meowsenger

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Verify, review, PR, merge, deploy

**Files:**
- Modify: `docs/superpowers/decisions/2026-09-24-brand-v2-log.md` (status column),
  `docs/superpowers/specs/2026-09-24-brand-v2-design.md` §6 (IDs closed)

- [ ] **Step 1: Full verification** (skill: superpowers:verification-before-completion)

```bash
just lint && just test && just build
bun run --filter @meowerse/ui tokens:check
just tokens-drift
```

Expected: all green.

Then repeat the Task 8 Step 4 screenshots on the final tree and look at every one. They need
dark/light and phone/desktop, with no overflow, no invisible text and nothing lowercased that a user
typed. Check that by typing "Hello ПРИВЕТ" into a meowsenger local mock or the auth signup username
field.

- [ ] **Step 2: Independent review against the spec** (skill: superpowers:requesting-code-review)

Give the reviewer the spec, the log, this plan and the diff `git diff master...HEAD`. Ask it to
check:
- every Global Constraint;
- that the B9 rules hold;
- that no app lost behaviour;
- the IDs claimed as fixed: U-01, U-02, U-06, U-07, U-09, U-10, U-31, A-07, A-18 (display part),
  A-19, A-20, A-21, M-06, M-14, L-01..L-05.

Fix every confirmed finding in new commits.

- [ ] **Step 3: Update the docs**

- In the log: set B14, B15, B17 and B18 (shared part) to "Done in PR #N". Set B2's legacy row note to
  "retired".
- In the spec §6: add "closed in sub-project 1: …" with the ID list.

Commit:
`docs(brand-v2): record sub-project 1 status`.

- [ ] **Step 4: PR, CI, merge**

```bash
git push -u origin feat/brand-v2-ds
gh pr create --base master --title "brand v2 · sub-project 1: design system v2, Cat3D, shared fixes, retire legacy app" --body "$(cat <<'EOF'
Implements sub-project 1 of docs/superpowers/specs/2026-09-24-brand-v2-design.md (decisions B1–B25).

- retires apps/alxnko-dev and its deploy script (B15; it could overwrite live alxnko.dev)
- @meowerse/ui v2: alxnko.dev tokens + B17 additions, JetBrains Mono / VT323 marks, all components restyled, legacy aliases
- no global lowercase; user text shown as typed (B14)
- request() + useSession errors are not sign-outs; timeouts, retry, bfcache (B18)
- Modal focus + ConfirmDialog phrase fixes
- new: Wordmark, Cursor, Kbd, StatusLine, Prompt, Cat3D
- deploy triggers include packages/ui + packages/brand

Closes audit IDs: U-01 U-02 U-06 U-07 U-09 U-10 U-31 A-07 A-18(display) A-19 A-20 A-21 M-06 M-14 L-01..L-05.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr checks --watch
gh pr merge --merge
```

Expected: CI is green and the PR is merged with a merge commit.

- [ ] **Step 5: Deploy and verify live** (owner-authorised)

```bash
cd /home/alxnko/Projects/code/meow/meowerse && git pull --ff-only
just deploy-auth && just deploy-meowsenger && just deploy-web
curl -sI https://auth.alxnko.dev/ | rg -i 'content-security|strict-transport'
curl -sI https://alxnko.dev/ | rg -i content-security-policy
```

Check live with Playwright screenshots of auth.alxnko.dev/login, meowsenger.alxnko.dev and
meow.alxnko.dev at phone/desktop in dark/light. Confirm:
- the new fonts and colours;
- no console errors;
- alxnko.dev is untouched, with the hash CSP still present.

- [ ] **Step 6: Clean up**

Remove the worktree (`git worktree remove .claude/worktrees/brand-v2-ds`) and the `docs/brand-v2`
worktree once it's merged. Delete `/var/tmp/brand-v2/` scratch and
`/var/tmp/brand-v2-audit/*/build-src`.

Update the memory note on the alxnko.dev Pages rollback: "never roll back alxnko-dev past
`a0fa213`" (L-02).
