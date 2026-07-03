# @meowerse/ui Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@meowerse/ui` — the shared design-system package (tokens, fonts, theme, accessible React primitives) that every meowerse frontend consumes as source.

**Architecture:** A `packages/ui` workspace mirroring `packages/ts-shared` — consumed as source (`main: src/index.ts`), so Vite/Astro transpile the `.tsx` and bundle the CSS at app build time; no dedicated build step. Plain CSS custom properties + className-based components (no CSS-in-JS, no Tailwind). Fonts self-hosted via Fontsource. Light/dark via `data-theme` + `prefers-color-scheme` with a no-flash init script.

**Tech Stack:** React 19, TypeScript (strict), Vitest + @testing-library/react (jsdom), Fontsource (Outfit variable, JetBrains Mono, Bytesized), Tabler icons (webfont, referenced by class).

**This is Plan 1 of 4.** Plan 2 = auth backend endpoints, Plan 3 = auth-web migration, Plan 4 = legal/content pages. This plan touches only `packages/ui` + root workspace config; it does not modify any app.

---

## File structure

```
packages/ui/
  package.json                 # @meowerse/ui, exports map, deps
  tsconfig.json                # extends ../../tsconfig.base.json, jsx: react-jsx
  vitest.config.ts             # jsdom env, coverage threshold 90
  test/setup.ts                # @testing-library/jest-dom
  src/
    index.ts                   # barrel: all components + theme helpers + types
    styles/
      tokens.css               # @import fonts + components; :root tokens; reset; lowercase; no-transitions
      fonts.css                # @import fontsource css
      components.css           # all .mw-* component styles
    lib/
      theme.ts                 # THEME_INIT_SCRIPT, getTheme, applyTheme, toggleTheme
      useSession.ts            # useSession(base) -> {loading, authenticated, username, verified}
      cx.ts                    # tiny className joiner
      ids.ts                   # useId-based helpers (thin wrappers)
    components/
      Spinner.tsx  Button.tsx  Field.tsx  Checkbox.tsx  RadioGroup.tsx
      Card.tsx  Badge.tsx  Alert.tsx  Code.tsx  RecoveryCodes.tsx  Avatar.tsx
      Modal.tsx  ConfirmDialog.tsx  Toast.tsx
      ThemeToggle.tsx  ContactLinks.tsx  Footer.tsx  AppHeader.tsx  AuthGate.tsx
```

**Design contracts (used consistently across every task):**

- Token names exactly as in the design spec (`--mw-green`, `--surface-0..2`, `--text-primary/secondary/muted`, `--border`, `--danger`, `--radius`, `--font-sans/mono/display`, etc.).
- CSS classes are `mw-<component>` with `mw-<component>--<variant>` modifiers.
- Every component accepts and merges `className`; interactive ones forward remaining DOM props.
- Two font weights in body copy (400/500); headings up to 600.
- Icons: `<i class="ti ti-NAME" aria-hidden="true" />`; icon-only controls get `aria-label`.

---

## Task 1: Scaffold the package

**Files:**
- Create: `packages/ui/package.json`
- Create: `packages/ui/tsconfig.json`
- Create: `packages/ui/vitest.config.ts`
- Create: `packages/ui/test/setup.ts`
- Create: `packages/ui/src/index.ts` (temporary stub)

- [ ] **Step 1: Write `package.json`**

```jsonc
{
  "name": "@meowerse/ui",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./tokens.css": "./src/styles/tokens.css"
  },
  "files": ["src"],
  "scripts": {
    "lint": "tsc --noEmit",
    "test": "vitest run --coverage"
  },
  "peerDependencies": { "react": ">=19", "react-dom": ">=19" },
  "dependencies": {
    "@fontsource-variable/outfit": "^5.1.0",
    "@fontsource/jetbrains-mono": "^5.1.0",
    "@fontsource/bytesized": "^5.1.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.1.0",
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitest/coverage-v8": "^2.1.8",
    "jsdom": "^25.0.1",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vitest/globals", "@testing-library/jest-dom"],
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    css: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/index.ts", "src/styles/**"],
      thresholds: { branches: 90, functions: 90, lines: 90, statements: 90 },
    },
  },
});
```

- [ ] **Step 4: Write `test/setup.ts`**

Use the explicit `expect.extend` form — under bun's isolated linker the `/vitest` convenience entry resolves a different vitest instance and every jest-dom matcher throws `Invalid Chai property`:

```ts
import { expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
```

- [ ] **Step 5: Write a temporary `src/index.ts` stub**

```ts
export const UI_VERSION = "0.0.0";
```

- [ ] **Step 6: Install and verify the workspace resolves**

Run: `cd C:/code/meow/meowerse && bun install`
Expected: installs the three fontsource + testing devDeps; `@meowerse/ui` symlinked into the workspace.

- [ ] **Step 7: Verify lint + empty test run**

Run: `bun run --filter @meowerse/ui lint`
Expected: exits 0 (no type errors).
Run: `bun run --filter @meowerse/ui test`
Expected: vitest reports "no test files" (exit 0 is fine at this point) OR passes once tests exist.

- [ ] **Step 8: Commit**

```bash
git add packages/ui/package.json packages/ui/tsconfig.json packages/ui/vitest.config.ts packages/ui/test/setup.ts packages/ui/src/index.ts bun.lock
git commit -m "feat(ui): scaffold @meowerse/ui package"
```

---

## Task 2: Design tokens, fonts, base styles

**Files:**
- Create: `packages/ui/src/styles/fonts.css`
- Create: `packages/ui/src/styles/components.css` (empty for now, filled per component)
- Create: `packages/ui/src/styles/tokens.css`

No test (pure CSS asset; verified visually + via the theme test in Task 3). These files are bundled by consuming apps.

- [ ] **Step 1: Write `fonts.css`**

```css
@import "@fontsource-variable/outfit";
@import "@fontsource/jetbrains-mono/400.css";
@import "@fontsource/jetbrains-mono/500.css";
@import "@fontsource/bytesized";
```

- [ ] **Step 2: Create empty `components.css`**

```css
/* mw component styles are appended per component task */
```

- [ ] **Step 3: Write `tokens.css` (imports fonts + components, defines all tokens, both themes, reset, lowercase, no-transitions)**

```css
@import "./fonts.css";
@import "./components.css";

:root {
  --mw-green: #00ff82;
  --mw-green-hover: #00e676;
  --mw-on-green: #06331b;

  --surface-0: #fafafa;
  --surface-1: #ffffff;
  --surface-2: #ffffff;
  --surface-muted: #f0f0ee;
  --text-primary: #141414;
  --text-secondary: #52514e;
  --text-muted: #8a8a85;
  --text-accent: #0a7a42;
  --border: #e6e6e3;
  --border-strong: #d4d4d0;

  --danger: #ef4444;
  --on-danger: #ffffff;
  --text-danger: #b42318;
  --bg-danger: rgba(239, 68, 68, 0.10);
  --success: #17803d;
  --warning: #b45309;

  --radius-sm: 6px;
  --radius: 8px;
  --radius-lg: 12px;
  --radius-pill: 999px;

  --gap-xs: 4px; --gap-sm: 8px; --gap-md: 12px; --gap-lg: 16px; --gap-xl: 24px; --gap-2xl: 32px;

  --font-sans: "Outfit Variable", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --font-display: "Bytesized", var(--font-sans);

  --text-xs: 12px; --text-sm: 13px; --text-base: 14px; --text-md: 16px;
  --text-lg: 18px; --text-xl: 22px; --text-2xl: 28px;

  --dur-fast: 120ms; --dur: 180ms; --ease: cubic-bezier(.4, 0, .2, 1);

  color-scheme: light;
}

:root[data-theme="dark"],
:root:not([data-theme="light"]) {
  /* fallback for system dark; overridden below when data-theme is explicit */
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --surface-0: #0d0d0d; --surface-1: #161616; --surface-2: #1c1c1c;
    --surface-muted: #222222;
    --text-primary: #f2f2f2; --text-secondary: #a8a8a2; --text-muted: #8a8a85;
    --text-accent: #00ff82;
    --border: #2a2a2a; --border-strong: #3a3a3a;
    --text-danger: #ff8f8f; --bg-danger: rgba(239, 68, 68, 0.14); --success: #34e78f; --warning: #f5a524;
    color-scheme: dark;
  }
}

:root[data-theme="dark"] {
  --surface-0: #0d0d0d; --surface-1: #161616; --surface-2: #1c1c1c;
  --surface-muted: #222222;
  --text-primary: #f2f2f2; --text-secondary: #a8a8a2; --text-muted: #8a8a85;
  --text-accent: #00ff82;
  --border: #2a2a2a; --border-strong: #3a3a3a;
  --text-danger: #ff8f8f; --bg-danger: rgba(239, 68, 68, 0.14); --success: #34e78f; --warning: #f5a524;
  color-scheme: dark;
}

* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  font-family: var(--font-sans);
  font-size: var(--text-base);
  line-height: 1.5;
  color: var(--text-primary);
  background: var(--surface-0);
  text-transform: lowercase;
  -webkit-font-smoothing: antialiased;
}
.mono, code, kbd, samp, pre, .cs, [data-case="preserve"] { text-transform: none; }

:where(a, button, input, select, textarea, [tabindex]):focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--surface-0), 0 0 0 4px var(--mw-green);
  border-radius: var(--radius-sm);
}

.mw-no-transitions * { transition: none !important; }

@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/styles
git commit -m "feat(ui): design tokens, fonts, base styles (both themes)"
```

---

## Task 3: Theme helpers (`lib/theme.ts`)

**Files:**
- Create: `packages/ui/src/lib/theme.ts`
- Test: `packages/ui/src/lib/theme.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { applyTheme, getTheme, toggleTheme, THEME_INIT_SCRIPT } from "./theme";

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("defaults to system when nothing stored", () => {
    expect(getTheme()).toBe("system");
  });

  it("applyTheme('dark') sets attribute + persists", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("mw-theme")).toBe("dark");
    expect(getTheme()).toBe("dark");
  });

  it("applyTheme('system') clears attribute + storage", () => {
    applyTheme("dark");
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem("mw-theme")).toBe(null);
  });

  it("toggleTheme flips light<->dark", () => {
    applyTheme("light");
    toggleTheme();
    expect(getTheme()).toBe("dark");
    toggleTheme();
    expect(getTheme()).toBe("light");
  });

  it("exports a non-empty init script string", () => {
    expect(typeof THEME_INIT_SCRIPT).toBe("string");
    expect(THEME_INIT_SCRIPT).toContain("data-theme");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `bun run --filter @meowerse/ui test -- theme`
Expected: FAIL (module not found / functions undefined).

- [ ] **Step 3: Implement `lib/theme.ts`**

```ts
export type Theme = "light" | "dark" | "system";
const KEY = "mw-theme";

export function getTheme(): Theme {
  if (typeof localStorage === "undefined") return "system";
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function resolvedTheme(): "light" | "dark" {
  const t = getTheme();
  if (t !== "system") return t;
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.add("mw-no-transitions");
  if (theme === "system") {
    localStorage.removeItem(KEY);
    root.removeAttribute("data-theme");
  } else {
    localStorage.setItem(KEY, theme);
    root.setAttribute("data-theme", theme);
  }
  requestAnimationFrame(() => root.classList.remove("mw-no-transitions"));
}

export function toggleTheme(): void {
  applyTheme(resolvedTheme() === "dark" ? "light" : "dark");
}

/** Synchronous script for <head> — sets data-theme before first paint (no FOUC). */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('mw-theme');var r=document.documentElement;r.classList.add('mw-no-transitions');if(t==='light'||t==='dark'){r.setAttribute('data-theme',t);}requestAnimationFrame(function(){r.classList.remove('mw-no-transitions');});}catch(e){}})();`;
```

- [ ] **Step 4: Run test — expect PASS**

Run: `bun run --filter @meowerse/ui test -- theme`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/theme.ts packages/ui/src/lib/theme.test.ts
git commit -m "feat(ui): theme helpers + no-flash init script"
```

---

## Task 4: `cx` className helper

**Files:**
- Create: `packages/ui/src/lib/cx.ts`
- Test: `packages/ui/src/lib/cx.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { cx } from "./cx";

describe("cx", () => {
  it("joins truthy strings, drops falsy", () => {
    expect(cx("a", false, "b", undefined, null, "c")).toBe("a b c");
  });
  it("returns empty string when all falsy", () => {
    expect(cx(false, undefined)).toBe("");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run --filter @meowerse/ui test -- cx`
Expected: FAIL.

- [ ] **Step 3: Implement `lib/cx.ts`**

```ts
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
```

- [ ] **Step 4: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- cx`

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/cx.ts packages/ui/src/lib/cx.test.ts
git commit -m "feat(ui): cx className helper"
```

---

## Task 5: `Spinner`

**Files:**
- Create: `packages/ui/src/components/Spinner.tsx`
- Test: `packages/ui/src/components/Spinner.test.tsx`
- Modify: `packages/ui/src/styles/components.css` (append)

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Spinner } from "./Spinner";

describe("Spinner", () => {
  it("renders an accessible busy indicator", () => {
    render(<Spinner label="loading account" />);
    const el = screen.getByRole("status");
    expect(el).toHaveAttribute("aria-label", "loading account");
  });
  it("applies size modifier + extra className", () => {
    render(<Spinner size="lg" className="x" />);
    expect(screen.getByRole("status").className).toContain("mw-spinner--lg");
    expect(screen.getByRole("status").className).toContain("x");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/ui test -- Spinner`

- [ ] **Step 3: Implement `Spinner.tsx`**

```tsx
import { cx } from "../lib/cx";

export function Spinner({ size = "md", label = "loading", className }:
  { size?: "sm" | "md" | "lg"; label?: string; className?: string }) {
  return <span role="status" aria-label={label} className={cx("mw-spinner", `mw-spinner--${size}`, className)} />;
}
```

- [ ] **Step 4: Append styles to `components.css`**

```css
.mw-spinner { display: inline-block; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--mw-green); animation: mw-spin .7s linear infinite; }
.mw-spinner--sm { width: 14px; height: 14px; }
.mw-spinner--md { width: 20px; height: 20px; }
.mw-spinner--lg { width: 32px; height: 32px; border-width: 3px; }
@keyframes mw-spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- Spinner`

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/Spinner.tsx packages/ui/src/components/Spinner.test.tsx packages/ui/src/styles/components.css
git commit -m "feat(ui): Spinner"
```

---

## Task 6: `Button`

**Files:**
- Create: `packages/ui/src/components/Button.tsx`
- Test: `packages/ui/src/components/Button.test.tsx`
- Modify: `packages/ui/src/styles/components.css`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";

describe("Button", () => {
  it("renders variant + size classes and children", () => {
    render(<Button variant="danger" size="sm">revoke</Button>);
    const b = screen.getByRole("button", { name: "revoke" });
    expect(b.className).toContain("mw-btn--danger");
    expect(b.className).toContain("mw-btn--sm");
  });
  it("loading disables and shows a status indicator", () => {
    render(<Button loading>save</Button>);
    const b = screen.getByRole("button");
    expect(b).toBeDisabled();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
  it("fires onClick when enabled", async () => {
    const fn = vi.fn();
    render(<Button onClick={fn}>go</Button>);
    await userEvent.click(screen.getByRole("button"));
    expect(fn).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/ui test -- Button`

- [ ] **Step 3: Implement `Button.tsx`**

```tsx
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cx } from "../lib/cx";
import { Spinner } from "./Spinner";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, disabled, className, children, ...rest }, ref) {
  return (
    <button ref={ref} disabled={disabled || loading}
      className={cx("mw-btn", `mw-btn--${variant}`, `mw-btn--${size}`, loading && "mw-btn--loading", className)}
      {...rest}>
      {loading && <Spinner size="sm" label="working" />}
      <span>{children}</span>
    </button>
  );
});
```

- [ ] **Step 4: Append styles**

```css
.mw-btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--gap-sm); font: inherit; font-weight: 500; border-radius: var(--radius); border: 0.5px solid transparent; cursor: pointer; transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease); }
.mw-btn:active { transform: scale(.98); }
.mw-btn:disabled { opacity: .55; cursor: not-allowed; }
.mw-btn--md { padding: 8px 16px; font-size: var(--text-base); }
.mw-btn--sm { padding: 6px 12px; font-size: var(--text-sm); }
.mw-btn--primary { background: var(--mw-green); color: var(--mw-on-green); }
.mw-btn--primary:not(:disabled):hover { background: var(--mw-green-hover); }
.mw-btn--secondary { background: transparent; color: var(--text-primary); border-color: var(--border-strong); }
.mw-btn--secondary:not(:disabled):hover { background: var(--surface-muted); }
.mw-btn--ghost { background: transparent; color: var(--text-secondary); }
.mw-btn--ghost:not(:disabled):hover { background: var(--surface-muted); }
.mw-btn--danger { background: var(--danger); color: var(--on-danger); }
.mw-btn--danger:not(:disabled):hover { filter: brightness(.94); }
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- Button`

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/Button.tsx packages/ui/src/components/Button.test.tsx packages/ui/src/styles/components.css
git commit -m "feat(ui): Button (primary/secondary/ghost/danger, loading)"
```

---

## Task 7: `Field` (labeled input with password reveal)

**Files:**
- Create: `packages/ui/src/components/Field.tsx`
- Test: `packages/ui/src/components/Field.test.tsx`
- Modify: `packages/ui/src/styles/components.css`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Field } from "./Field";

describe("Field", () => {
  it("associates the hint with the input as its description", () => {
    render(<Field label="username" hint="3-20 chars" name="u" />);
    expect(screen.getByLabelText("username")).toHaveAccessibleDescription(/3-20 chars/);
  });
  it("shows the error as an alert and marks the input invalid", () => {
    render(<Field label="username" error="taken" name="u" />);
    const input = screen.getByLabelText("username");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("taken");
  });
  it("password field toggles visibility", async () => {
    render(<Field label="password" type="password" name="p" />);
    const input = screen.getByLabelText("password") as HTMLInputElement;
    expect(input.type).toBe("password");
    await userEvent.click(screen.getByRole("button", { name: /show password/i }));
    expect(input.type).toBe("text");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/ui test -- Field`

- [ ] **Step 3: Implement `Field.tsx`**

```tsx
import { forwardRef, useId, useState, type InputHTMLAttributes } from "react";
import { cx } from "../lib/cx";

export type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string; hint?: string; error?: string;
};

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, type = "text", className, ...rest }, ref) {
  const id = useId();
  const hintId = `${id}-hint`;
  const [reveal, setReveal] = useState(false);
  const isPw = type === "password";
  const describedBy = cx(hint && hintId, error && `${id}-err`) || undefined;
  return (
    <div className={cx("mw-field", error && "mw-field--error", className)}>
      <label htmlFor={id}>{label}</label>
      <div className="mw-field__control">
        <input ref={ref} id={id} type={isPw && reveal ? "text" : type}
          aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...rest} />
        {isPw && (
          <button type="button" className="mw-field__reveal"
            aria-label={reveal ? "hide password" : "show password"} onClick={() => setReveal((v) => !v)}>
            <i className={reveal ? "ti ti-eye-off" : "ti ti-eye"} aria-hidden="true" />
          </button>
        )}
      </div>
      {hint && !error && <span id={hintId} className="mw-field__hint">{hint}</span>}
      {error && <span id={`${id}-err`} role="alert" className="mw-field__error">{error}</span>}
    </div>
  );
});
```

- [ ] **Step 4: Append styles**

```css
.mw-field { display: flex; flex-direction: column; gap: 5px; }
.mw-field > label { font-size: var(--text-xs); color: var(--text-secondary); }
.mw-field__control { position: relative; display: flex; }
.mw-field input { flex: 1; width: 100%; padding: 9px 11px; font: inherit; font-size: var(--text-base); color: var(--text-primary); background: var(--surface-1); border: 0.5px solid var(--border-strong); border-radius: var(--radius); }
.mw-field--error input { border-color: var(--danger); }
.mw-field__reveal { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 4px; }
.mw-field__hint { font-size: var(--text-xs); color: var(--text-muted); }
.mw-field__error { font-size: var(--text-xs); color: var(--text-danger); }
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- Field`

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/Field.tsx packages/ui/src/components/Field.test.tsx packages/ui/src/styles/components.css
git commit -m "feat(ui): Field (label/hint/error, password reveal)"
```

---

## Task 8: `Checkbox`

**Files:**
- Create: `packages/ui/src/components/Checkbox.tsx`
- Test: `packages/ui/src/components/Checkbox.test.tsx`
- Modify: `packages/ui/src/styles/components.css`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Checkbox } from "./Checkbox";

describe("Checkbox", () => {
  it("renders a labeled checkbox and toggles", async () => {
    const fn = vi.fn();
    render(<Checkbox label="your username and avatar" onChange={fn} />);
    const box = screen.getByRole("checkbox", { name: "your username and avatar" });
    await userEvent.click(box);
    expect(fn).toHaveBeenCalled();
  });
  it("respects disabled", () => {
    render(<Checkbox label="openid" disabled checked readOnly />);
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/ui test -- Checkbox`

- [ ] **Step 3: Implement `Checkbox.tsx`**

```tsx
import { forwardRef, useId, type InputHTMLAttributes } from "react";
import { cx } from "../lib/cx";

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "id"> & { label: string };

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, className, ...rest }, ref) {
  const id = useId();
  return (
    <label htmlFor={id} className={cx("mw-check", className)}>
      <input ref={ref} id={id} type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  );
});
```

- [ ] **Step 4: Append styles**

```css
.mw-check { display: flex; align-items: center; gap: var(--gap-sm); font-size: var(--text-base); cursor: pointer; }
.mw-check input { width: 18px; height: 18px; accent-color: var(--mw-green); cursor: pointer; }
.mw-check:has(input:disabled) { opacity: .55; cursor: not-allowed; }
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- Checkbox`

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/Checkbox.tsx packages/ui/src/components/Checkbox.test.tsx packages/ui/src/styles/components.css
git commit -m "feat(ui): Checkbox"
```

---

## Task 9: `RadioGroup`

**Files:**
- Create: `packages/ui/src/components/RadioGroup.tsx`
- Test: `packages/ui/src/components/RadioGroup.test.tsx`
- Modify: `packages/ui/src/styles/components.css`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RadioGroup } from "./RadioGroup";

describe("RadioGroup", () => {
  const opts = [{ label: "public", value: "public" }, { label: "confidential", value: "confidential" }];
  it("renders options and reports the picked value", async () => {
    const fn = vi.fn();
    render(<RadioGroup name="ct" legend="app type" options={opts} value="public" onChange={fn} />);
    await userEvent.click(screen.getByRole("radio", { name: "confidential" }));
    expect(fn).toHaveBeenCalledWith("confidential");
  });
  it("marks the selected radio checked", () => {
    render(<RadioGroup name="ct" legend="app type" options={opts} value="confidential" onChange={() => {}} />);
    expect(screen.getByRole("radio", { name: "confidential" })).toBeChecked();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/ui test -- RadioGroup`

- [ ] **Step 3: Implement `RadioGroup.tsx`**

```tsx
import { useId } from "react";
import { cx } from "../lib/cx";

export type RadioOption = { label: string; value: string; hint?: string };

export function RadioGroup({ name, legend, options, value, onChange, className }: {
  name: string; legend: string; options: RadioOption[];
  value: string; onChange: (v: string) => void; className?: string;
}) {
  const gid = useId();
  return (
    <fieldset className={cx("mw-radio", className)}>
      <legend>{legend}</legend>
      {options.map((o) => {
        const id = `${gid}-${o.value}`;
        return (
          <label key={o.value} htmlFor={id} className="mw-radio__opt">
            <input id={id} type="radio" name={name} value={o.value}
              checked={value === o.value} onChange={() => onChange(o.value)} />
            <span>{o.label}{o.hint && <em className="mw-radio__hint">{o.hint}</em>}</span>
          </label>
        );
      })}
    </fieldset>
  );
}
```

- [ ] **Step 4: Append styles**

```css
.mw-radio { border: 0.5px solid var(--border); border-radius: var(--radius); margin: 0; padding: var(--gap-sm) var(--gap-md); display: flex; flex-direction: column; gap: var(--gap-sm); }
.mw-radio legend { padding: 0 6px; font-size: var(--text-xs); color: var(--text-secondary); }
.mw-radio__opt { display: flex; align-items: center; gap: var(--gap-sm); font-size: var(--text-base); cursor: pointer; }
.mw-radio__opt input { accent-color: var(--mw-green); }
.mw-radio__hint { display: block; font-style: normal; font-size: var(--text-xs); color: var(--text-muted); }
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- RadioGroup`

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/RadioGroup.tsx packages/ui/src/components/RadioGroup.test.tsx packages/ui/src/styles/components.css
git commit -m "feat(ui): RadioGroup"
```

---

## Task 10: `Card`

**Files:**
- Create: `packages/ui/src/components/Card.tsx`
- Test: `packages/ui/src/components/Card.test.tsx`
- Modify: `packages/ui/src/styles/components.css`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card } from "./Card";

describe("Card", () => {
  it("renders a titled region with children", () => {
    render(<Card title="connected apps">body</Card>);
    expect(screen.getByRole("region", { name: "connected apps" })).toHaveTextContent("body");
  });
  it("renders plain card without title", () => {
    render(<Card className="x">bare</Card>);
    expect(screen.getByText("bare").closest(".mw-card")).toHaveClass("x");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/ui test -- Card`

- [ ] **Step 3: Implement `Card.tsx`**

```tsx
import { useId, type ReactNode } from "react";
import { cx } from "../lib/cx";

export function Card({ title, children, className }:
  { title?: string; children: ReactNode; className?: string }) {
  const id = useId();
  if (!title) return <div className={cx("mw-card", className)}>{children}</div>;
  return (
    <section aria-labelledby={id} className={cx("mw-card", className)}>
      <h2 id={id} className="mw-card__title">{title}</h2>
      {children}
    </section>
  );
}
```

- [ ] **Step 4: Append styles**

```css
.mw-card { background: var(--surface-1); border: 0.5px solid var(--border); border-radius: var(--radius-lg); padding: var(--gap-lg) var(--gap-xl); }
.mw-card__title { font-size: var(--text-md); font-weight: 600; margin: 0 0 var(--gap-md); }
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- Card`

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/Card.tsx packages/ui/src/components/Card.test.tsx packages/ui/src/styles/components.css
git commit -m "feat(ui): Card"
```

---

## Task 11: `Badge`

**Files:**
- Create: `packages/ui/src/components/Badge.tsx`
- Test: `packages/ui/src/components/Badge.test.tsx`
- Modify: `packages/ui/src/styles/components.css`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./Badge";

describe("Badge", () => {
  it("renders verified variant with icon + text", () => {
    render(<Badge variant="verified" icon="rosette-discount-check">verified</Badge>);
    const b = screen.getByText("verified").closest(".mw-badge")!;
    expect(b.className).toContain("mw-badge--verified");
    expect(b.querySelector("i")).toHaveClass("ti-rosette-discount-check");
  });
  it("defaults to neutral", () => {
    render(<Badge>public</Badge>);
    expect(screen.getByText("public").closest(".mw-badge")!.className).toContain("mw-badge--neutral");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/ui test -- Badge`

- [ ] **Step 3: Implement `Badge.tsx`**

```tsx
import type { ReactNode } from "react";
import { cx } from "../lib/cx";

export function Badge({ variant = "neutral", icon, children, className }: {
  variant?: "verified" | "neutral" | "danger"; icon?: string; children: ReactNode; className?: string;
}) {
  return (
    <span className={cx("mw-badge", `mw-badge--${variant}`, className)}>
      {icon && <i className={`ti ti-${icon}`} aria-hidden="true" />}
      {children}
    </span>
  );
}
```

- [ ] **Step 4: Append styles**

```css
.mw-badge { display: inline-flex; align-items: center; gap: 5px; font-size: var(--text-xs); padding: 3px 9px; border-radius: var(--radius-pill); }
.mw-badge--verified { background: color-mix(in srgb, var(--mw-green) 16%, transparent); color: var(--text-accent); }
.mw-badge--neutral { background: var(--surface-muted); color: var(--text-secondary); }
.mw-badge--danger { background: var(--bg-danger); color: var(--text-danger); }
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- Badge`

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/Badge.tsx packages/ui/src/components/Badge.test.tsx packages/ui/src/styles/components.css
git commit -m "feat(ui): Badge"
```

---

## Task 12: `Alert`

**Files:**
- Create: `packages/ui/src/components/Alert.tsx`
- Test: `packages/ui/src/components/Alert.test.tsx`
- Modify: `packages/ui/src/styles/components.css`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Alert } from "./Alert";

describe("Alert", () => {
  it("error variant is an assertive alert", () => {
    render(<Alert variant="error">that name's already taken. try another.</Alert>);
    expect(screen.getByRole("alert")).toHaveTextContent("already taken");
  });
  it("dismiss button fires onDismiss", async () => {
    const fn = vi.fn();
    render(<Alert variant="success" onDismiss={fn}>saved</Alert>);
    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(fn).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/ui test -- Alert`

- [ ] **Step 3: Implement `Alert.tsx`**

```tsx
import type { ReactNode } from "react";
import { cx } from "../lib/cx";

const ICON = { error: "alert-triangle", success: "circle-check", info: "info-circle" } as const;

export function Alert({ variant = "info", onDismiss, children, className }: {
  variant?: "error" | "success" | "info"; onDismiss?: () => void; children: ReactNode; className?: string;
}) {
  return (
    <div role={variant === "error" ? "alert" : "status"} className={cx("mw-alert", `mw-alert--${variant}`, className)}>
      <i className={`ti ti-${ICON[variant]}`} aria-hidden="true" />
      <span className="mw-alert__body">{children}</span>
      {onDismiss && (
        <button type="button" className="mw-alert__x" aria-label="dismiss" onClick={onDismiss}>
          <i className="ti ti-x" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Append styles**

```css
.mw-alert { display: flex; align-items: flex-start; gap: var(--gap-sm); font-size: var(--text-sm); padding: 9px 11px; border-radius: var(--radius); }
.mw-alert__body { flex: 1; }
.mw-alert__x { background: none; border: none; color: inherit; cursor: pointer; opacity: .7; }
.mw-alert--error { background: var(--bg-danger); color: var(--text-danger); }
.mw-alert--success { background: color-mix(in srgb, var(--success) 14%, transparent); color: var(--success); }
.mw-alert--info { background: var(--surface-muted); color: var(--text-secondary); }
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- Alert`

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/Alert.tsx packages/ui/src/components/Alert.test.tsx packages/ui/src/styles/components.css
git commit -m "feat(ui): Alert"
```

---

## Task 13: `Code` (case-preserved mono value + copy)

**Files:**
- Create: `packages/ui/src/components/Code.tsx`
- Test: `packages/ui/src/components/Code.test.tsx`
- Modify: `packages/ui/src/styles/components.css`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Code } from "./Code";

describe("Code", () => {
  it("preserves case (does not lowercase) and marks the mono class", () => {
    render(<Code value="7F3K-9QW2-XM4L" />);
    const el = screen.getByText("7F3K-9QW2-XM4L");
    expect(el).toHaveClass("mono");
    expect(el).toHaveAttribute("data-case", "preserve");
  });
  it("copy button writes the raw value to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<Code value="mw_live_abc" copy />);
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith("mw_live_abc");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/ui test -- Code`

- [ ] **Step 3: Implement `Code.tsx`**

```tsx
import { useState } from "react";
import { cx } from "../lib/cx";

export function Code({ value, copy = false, className }:
  { value: string; copy?: boolean; className?: string }) {
  const [done, setDone] = useState(false);
  async function onCopy() {
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch {}
  }
  return (
    <span className={cx("mw-code", className)}>
      <code className="mono" data-case="preserve">{value}</code>
      {copy && (
        <button type="button" className="mw-code__copy" aria-label="copy" onClick={onCopy}>
          <i className={done ? "ti ti-check" : "ti ti-copy"} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
```

- [ ] **Step 4: Append styles**

```css
.mw-code { display: inline-flex; align-items: center; gap: 6px; }
.mw-code code { font-family: var(--font-mono); font-size: var(--text-sm); background: var(--surface-muted); color: var(--text-primary); padding: 3px 8px; border-radius: var(--radius-sm); word-break: break-all; }
.mw-code__copy { background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 2px; }
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- Code`

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/Code.tsx packages/ui/src/components/Code.test.tsx packages/ui/src/styles/components.css
git commit -m "feat(ui): Code (case-preserved mono + copy)"
```

---

## Task 14: `Avatar`

**Files:**
- Create: `packages/ui/src/components/Avatar.tsx`
- Test: `packages/ui/src/components/Avatar.test.tsx`
- Modify: `packages/ui/src/styles/components.css`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar } from "./Avatar";

describe("Avatar", () => {
  it("shows uppercase initials from the name but keeps an accessible label", () => {
    render(<Avatar name="meow_alex" />);
    const el = screen.getByLabelText("meow_alex");
    expect(el).toHaveTextContent("M");
  });
  it("applies size", () => {
    render(<Avatar name="ab" size="lg" />);
    expect(screen.getByLabelText("ab").className).toContain("mw-avatar--lg");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/ui test -- Avatar`

- [ ] **Step 3: Implement `Avatar.tsx`**

```tsx
import { cx } from "../lib/cx";

export function Avatar({ name, size = "md", className }:
  { name: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span aria-label={name} className={cx("mw-avatar", `mw-avatar--${size}`, className)}>
      <span aria-hidden="true" className="mono" data-case="preserve">{initial}</span>
    </span>
  );
}
```

- [ ] **Step 4: Append styles**

```css
.mw-avatar { display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background: color-mix(in srgb, var(--mw-green) 18%, transparent); color: var(--text-accent); font-weight: 600; }
.mw-avatar--sm { width: 28px; height: 28px; font-size: var(--text-xs); }
.mw-avatar--md { width: 36px; height: 36px; font-size: var(--text-sm); }
.mw-avatar--lg { width: 48px; height: 48px; font-size: var(--text-md); }
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- Avatar`

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/Avatar.tsx packages/ui/src/components/Avatar.test.tsx packages/ui/src/styles/components.css
git commit -m "feat(ui): Avatar"
```

---

## Task 15: `Modal` (portal, focus trap, Esc, restore focus)

**Files:**
- Create: `packages/ui/src/components/Modal.tsx`
- Test: `packages/ui/src/components/Modal.test.tsx`
- Modify: `packages/ui/src/styles/components.css`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

describe("Modal", () => {
  it("renders nothing when closed", () => {
    render(<Modal open={false} onClose={() => {}} title="t">body</Modal>);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("open dialog is labelled by its title and Esc closes it", async () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="revoke access">body</Modal>);
    const dialog = screen.getByRole("dialog", { name: "revoke access" });
    expect(dialog).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("clicking the backdrop closes", async () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="t">body</Modal>);
    await userEvent.click(screen.getByTestId("mw-modal-backdrop"));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/ui test -- Modal`

- [ ] **Step 3: Implement `Modal.tsx`**

```tsx
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";

export function Modal({ open, onClose, title, children, className }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; className?: string;
}) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("[data-autofocus],button,[href],input,select,textarea")?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key !== "Tab" || !panel) return;
      const f = panel.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
      if (f.length === 0) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      (restoreRef.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="mw-modal">
      <div className="mw-modal__backdrop" data-testid="mw-modal-backdrop" onClick={onClose} />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={id}
        className={cx("mw-modal__panel", className)}>
        <h2 id={id} className="mw-modal__title">{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 4: Append styles**

```css
.mw-modal { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; padding: var(--gap-lg); }
.mw-modal__backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.5); }
.mw-modal__panel { position: relative; z-index: 1; width: 100%; max-width: 380px; background: var(--surface-1); border: 0.5px solid var(--border); border-radius: var(--radius-lg); padding: var(--gap-xl); }
.mw-modal__title { font-size: var(--text-lg); font-weight: 600; margin: 0 0 var(--gap-sm); }
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- Modal`

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/Modal.tsx packages/ui/src/components/Modal.test.tsx packages/ui/src/styles/components.css
git commit -m "feat(ui): Modal (portal, focus trap, Esc)"
```

---

## Task 16: `ConfirmDialog` (tiers: type-to-confirm + require-password)

**Files:**
- Create: `packages/ui/src/components/ConfirmDialog.tsx`
- Test: `packages/ui/src/components/ConfirmDialog.test.tsx`
- Modify: `packages/ui/src/styles/components.css`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  it("type-to-confirm keeps confirm disabled until the phrase matches", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open onCancel={() => {}} onConfirm={onConfirm}
      title="delete app" description="irreversible" confirmLabel="delete" variant="danger" confirmPhrase="meowsenger" />);
    const btn = screen.getByRole("button", { name: "delete" });
    expect(btn).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/type/i), "meowsenger");
    expect(btn).toBeEnabled();
    await userEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledWith({ password: undefined });
  });
  it("require-password passes the entered password to onConfirm", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open onCancel={() => {}} onConfirm={onConfirm}
      title="unlink" description="d" confirmLabel="unlink" requirePassword />);
    await userEvent.type(screen.getByLabelText(/password/i), "hunter2hunter2");
    await userEvent.click(screen.getByRole("button", { name: "unlink" }));
    expect(onConfirm).toHaveBeenCalledWith({ password: "hunter2hunter2" });
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/ui test -- ConfirmDialog`

- [ ] **Step 3: Implement `ConfirmDialog.tsx`**

```tsx
import { useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Field } from "./Field";

export type ConfirmResult = { password?: string };

export function ConfirmDialog({
  open, onCancel, onConfirm, title, description, confirmLabel,
  variant = "danger", confirmPhrase, requirePassword = false, loading = false,
}: {
  open: boolean; onCancel: () => void; onConfirm: (r: ConfirmResult) => void;
  title: string; description: string; confirmLabel: string;
  variant?: "danger" | "primary"; confirmPhrase?: string; requirePassword?: boolean; loading?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const [pw, setPw] = useState("");
  const phraseOk = !confirmPhrase || typed === confirmPhrase;
  const pwOk = !requirePassword || pw.length > 0;
  const canConfirm = phraseOk && pwOk && !loading;
  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <p className="mw-confirm__desc">{description}</p>
      {confirmPhrase && (
        <Field label={`type ${confirmPhrase} to confirm`} value={typed}
          onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      )}
      {requirePassword && (
        <Field label="your password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
      )}
      <div className="mw-confirm__actions">
        <Button variant="secondary" onClick={onCancel}>cancel</Button>
        <Button variant={variant} disabled={!canConfirm} loading={loading}
          onClick={() => onConfirm({ password: requirePassword ? pw : undefined })}>{confirmLabel}</Button>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 4: Append styles**

```css
.mw-confirm__desc { font-size: var(--text-sm); color: var(--text-secondary); margin: 0 0 var(--gap-md); line-height: 1.5; }
.mw-confirm__actions { display: flex; gap: var(--gap-sm); justify-content: flex-end; margin-top: var(--gap-lg); }
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- ConfirmDialog`

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/ConfirmDialog.tsx packages/ui/src/components/ConfirmDialog.test.tsx packages/ui/src/styles/components.css
git commit -m "feat(ui): ConfirmDialog (type-to-confirm, require-password)"
```

---

## Task 17: `Toast` (provider + useToast)

**Files:**
- Create: `packages/ui/src/components/Toast.tsx`
- Test: `packages/ui/src/components/Toast.test.tsx`
- Modify: `packages/ui/src/styles/components.css`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ToastProvider, useToast } from "./Toast";

function Trigger() {
  const toast = useToast();
  return <button onClick={() => toast({ message: "access revoked", variant: "success" })}>go</button>;
}

describe("Toast", () => {
  it("useToast pushes a toast that renders in the live region", async () => {
    render(<ToastProvider><Trigger /></ToastProvider>);
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    expect(await screen.findByText("access revoked")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/ui test -- Toast`

- [ ] **Step 3: Implement `Toast.tsx`**

```tsx
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { cx } from "../lib/cx";

type ToastItem = { id: number; message: string; variant: "success" | "error" | "info" };
type ToastInput = { message: string; variant?: ToastItem["variant"]; duration?: number };

const Ctx = createContext<(t: ToastInput) => void>(() => {});
export function useToast() { return useContext(Ctx); }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((t: ToastInput) => {
    const id = ++seq.current;
    setItems((cur) => [...cur, { id, message: t.message, variant: t.variant ?? "info" }]);
    setTimeout(() => setItems((cur) => cur.filter((x) => x.id !== id)), t.duration ?? 3500);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="mw-toasts" role="region" aria-live="polite" aria-label="notifications">
        {items.map((t) => (
          <div key={t.id} className={cx("mw-toast", `mw-toast--${t.variant}`)}>{t.message}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
```

- [ ] **Step 4: Append styles**

```css
.mw-toasts { position: fixed; bottom: var(--gap-lg); left: 50%; transform: translateX(-50%); z-index: 200; display: flex; flex-direction: column; gap: var(--gap-sm); align-items: center; pointer-events: none; }
.mw-toast { pointer-events: auto; font-size: var(--text-sm); padding: 9px 14px; border-radius: var(--radius); border: 0.5px solid var(--border); background: var(--surface-2); color: var(--text-primary); box-shadow: 0 4px 16px rgba(0,0,0,.12); }
.mw-toast--success { border-color: var(--success); }
.mw-toast--error { border-color: var(--danger); }
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- Toast`

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/Toast.tsx packages/ui/src/components/Toast.test.tsx packages/ui/src/styles/components.css
git commit -m "feat(ui): Toast provider + useToast"
```

---

## Task 18: `RecoveryCodes`

**Files:**
- Create: `packages/ui/src/components/RecoveryCodes.tsx`
- Test: `packages/ui/src/components/RecoveryCodes.test.tsx`
- Modify: `packages/ui/src/styles/components.css`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RecoveryCodes } from "./RecoveryCodes";

describe("RecoveryCodes", () => {
  const codes = ["ABCD-1234", "EFGH-5678"];
  it("renders each code case-preserved", () => {
    render(<RecoveryCodes codes={codes} />);
    expect(screen.getByText("ABCD-1234")).toHaveAttribute("data-case", "preserve");
  });
  it("copy-all writes the newline-joined codes", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<RecoveryCodes codes={codes} />);
    await userEvent.click(screen.getByRole("button", { name: /copy all/i }));
    expect(writeText).toHaveBeenCalledWith("ABCD-1234\nEFGH-5678");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/ui test -- RecoveryCodes`

- [ ] **Step 3: Implement `RecoveryCodes.tsx`**

```tsx
import { Button } from "./Button";
import { cx } from "../lib/cx";

export function RecoveryCodes({ codes, className }: { codes: string[]; className?: string }) {
  const joined = codes.join("\n");
  async function copyAll() { try { await navigator.clipboard.writeText(joined); } catch {} }
  return (
    <div className={cx("mw-recovery", className)}>
      <ul className="mw-recovery__grid">
        {codes.map((c) => <li key={c} className="mono" data-case="preserve">{c}</li>)}
      </ul>
      <div className="mw-recovery__actions">
        <Button size="sm" variant="secondary" onClick={copyAll}>copy all</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Append styles**

```css
.mw-recovery { border: 0.5px solid var(--border); border-radius: var(--radius); padding: var(--gap-md); }
.mw-recovery__grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: var(--gap-sm); }
.mw-recovery__grid li { font-family: var(--font-mono); font-size: var(--text-sm); }
.mw-recovery__actions { margin-top: var(--gap-md); }
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- RecoveryCodes`

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/RecoveryCodes.tsx packages/ui/src/components/RecoveryCodes.test.tsx packages/ui/src/styles/components.css
git commit -m "feat(ui): RecoveryCodes"
```

---

## Task 19: `useSession` hook

**Files:**
- Create: `packages/ui/src/lib/useSession.ts`
- Test: `packages/ui/src/lib/useSession.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSession } from "./useSession";

function View({ base }: { base: string }) {
  const s = useSession(base);
  return <div>{s.loading ? "loading" : s.authenticated ? `hi ${s.username}` : "guest"}</div>;
}

afterEach(() => vi.restoreAllMocks());

describe("useSession", () => {
  it("reports authenticated + username from /api/session", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, username: "alex", verified: true }), { status: 200 }));
    render(<View base="https://api" />);
    expect(await screen.findByText("hi alex")).toBeInTheDocument();
  });
  it("reports guest on a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    render(<View base="https://api" />);
    await waitFor(() => expect(screen.getByText("guest")).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/ui test -- useSession`

- [ ] **Step 3: Implement `lib/useSession.ts`**

```ts
import { useEffect, useState } from "react";

export type Session =
  | { loading: true; authenticated: false }
  | { loading: false; authenticated: false }
  | { loading: false; authenticated: true; username: string; verified: boolean };

export function useSession(base: string): Session {
  const [s, setS] = useState<Session>({ loading: true, authenticated: false });
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`${base}/api/session`, { credentials: "include" });
        const j = (await res.json()) as { authenticated?: boolean; username?: string; verified?: boolean };
        if (!live) return;
        setS(j.authenticated && j.username
          ? { loading: false, authenticated: true, username: j.username, verified: !!j.verified }
          : { loading: false, authenticated: false });
      } catch {
        if (live) setS({ loading: false, authenticated: false });
      }
    })();
    return () => { live = false; };
  }, [base]);
  return s;
}
```

- [ ] **Step 4: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- useSession`

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/useSession.ts packages/ui/src/lib/useSession.test.tsx
git commit -m "feat(ui): useSession hook"
```

---

## Task 20: `ThemeToggle`

**Files:**
- Create: `packages/ui/src/components/ThemeToggle.tsx`
- Test: `packages/ui/src/components/ThemeToggle.test.tsx`
- Modify: `packages/ui/src/styles/components.css`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ThemeToggle } from "./ThemeToggle";

describe("ThemeToggle", () => {
  beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute("data-theme"); });
  it("toggles the document theme on click", async () => {
    localStorage.setItem("mw-theme", "light");
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole("button", { name: /theme/i }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/ui test -- ThemeToggle`

- [ ] **Step 3: Implement `ThemeToggle.tsx`**

```tsx
import { useEffect, useState } from "react";
import { resolvedTheme, toggleTheme } from "../lib/theme";
import { cx } from "../lib/cx";

export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(false);
  useEffect(() => { setDark(resolvedTheme() === "dark"); }, []);
  return (
    <button type="button" className={cx("mw-themetoggle", className)} aria-label="toggle theme"
      onClick={() => { toggleTheme(); setDark(resolvedTheme() === "dark"); }}>
      <i className={dark ? "ti ti-sun" : "ti ti-moon"} aria-hidden="true" />
    </button>
  );
}
```

- [ ] **Step 4: Append styles**

```css
.mw-themetoggle { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; background: transparent; border: 0.5px solid var(--border); border-radius: var(--radius); color: var(--text-secondary); cursor: pointer; }
.mw-themetoggle:hover { background: var(--surface-muted); }
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- ThemeToggle`

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/ThemeToggle.tsx packages/ui/src/components/ThemeToggle.test.tsx packages/ui/src/styles/components.css
git commit -m "feat(ui): ThemeToggle"
```

---

## Task 21: `ContactLinks`

**Files:**
- Create: `packages/ui/src/components/ContactLinks.tsx`
- Test: `packages/ui/src/components/ContactLinks.test.tsx`
- Modify: `packages/ui/src/styles/components.css`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContactLinks, DEFAULT_CONTACTS } from "./ContactLinks";

describe("ContactLinks", () => {
  it("renders one labelled link per default contact", () => {
    render(<ContactLinks />);
    expect(screen.getByRole("link", { name: /telegram/i })).toHaveAttribute("href", "https://t.me/ALXNK0");
    expect(screen.getAllByRole("link")).toHaveLength(DEFAULT_CONTACTS.length);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/ui test -- ContactLinks`

- [ ] **Step 3: Implement `ContactLinks.tsx`**

```tsx
import { cx } from "../lib/cx";

export type Contact = { label: string; href: string; icon: string };

export const DEFAULT_CONTACTS: Contact[] = [
  { label: "email", href: "mailto:aleksandrnyrko@gmail.com", icon: "mail" },
  { label: "telegram", href: "https://t.me/ALXNK0", icon: "brand-telegram" },
  { label: "instagram", href: "https://instagram.com/alxnko", icon: "brand-instagram" },
  { label: "github", href: "https://github.com/alxnko", icon: "brand-github" },
  { label: "linkedin", href: "https://linkedin.com/in/alxnko", icon: "brand-linkedin" },
];

export function ContactLinks({ contacts = DEFAULT_CONTACTS, className }:
  { contacts?: Contact[]; className?: string }) {
  return (
    <nav className={cx("mw-contacts", className)} aria-label="contact">
      {contacts.map((c) => (
        <a key={c.label} href={c.href} aria-label={c.label} className="mw-contacts__link"
          target={c.href.startsWith("http") ? "_blank" : undefined}
          rel={c.href.startsWith("http") ? "noreferrer noopener" : undefined}>
          <i className={`ti ti-${c.icon}`} aria-hidden="true" />
        </a>
      ))}
    </nav>
  );
}
```

- [ ] **Step 4: Append styles**

```css
.mw-contacts { display: flex; gap: var(--gap-md); }
.mw-contacts__link { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: var(--radius); color: var(--text-secondary); font-size: 18px; }
.mw-contacts__link:hover { background: var(--surface-muted); color: var(--text-primary); }
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- ContactLinks`

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/ContactLinks.tsx packages/ui/src/components/ContactLinks.test.tsx packages/ui/src/styles/components.css
git commit -m "feat(ui): ContactLinks"
```

---

## Task 22: `Footer`

**Files:**
- Create: `packages/ui/src/components/Footer.tsx`
- Test: `packages/ui/src/components/Footer.test.tsx`
- Modify: `packages/ui/src/styles/components.css`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Footer } from "./Footer";

describe("Footer", () => {
  it("renders legal + dev links and the contact block", () => {
    render(<Footer />);
    expect(screen.getByRole("link", { name: "privacy" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: "terms" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("navigation", { name: "contact" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/ui test -- Footer`

- [ ] **Step 3: Implement `Footer.tsx`**

```tsx
import { ContactLinks } from "./ContactLinks";
import { cx } from "../lib/cx";

const LINKS = [
  { label: "about", href: "/about" },
  { label: "privacy", href: "/privacy" },
  { label: "terms", href: "/terms" },
  { label: "developers", href: "/developers" },
];

export function Footer({ className }: { className?: string }) {
  return (
    <footer className={cx("mw-footer", className)}>
      <nav className="mw-footer__links" aria-label="site">
        {LINKS.map((l) => <a key={l.href} href={l.href}>{l.label}</a>)}
      </nav>
      <ContactLinks />
      <p className="mw-footer__legal">meowerse accounts — a personal project by alxnko</p>
    </footer>
  );
}
```

- [ ] **Step 4: Append styles**

```css
.mw-footer { border-top: 0.5px solid var(--border); margin-top: var(--gap-2xl); padding: var(--gap-xl) var(--gap-lg); display: flex; flex-direction: column; gap: var(--gap-md); align-items: center; text-align: center; }
.mw-footer__links { display: flex; flex-wrap: wrap; gap: var(--gap-lg); }
.mw-footer__links a { color: var(--text-secondary); text-decoration: none; font-size: var(--text-sm); }
.mw-footer__links a:hover { color: var(--text-primary); }
.mw-footer__legal { font-size: var(--text-xs); color: var(--text-muted); margin: 0; }
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- Footer`

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/Footer.tsx packages/ui/src/components/Footer.test.tsx packages/ui/src/styles/components.css
git commit -m "feat(ui): Footer"
```

---

## Task 23: `AppHeader` (two states)

**Files:**
- Create: `packages/ui/src/components/AppHeader.tsx`
- Test: `packages/ui/src/components/AppHeader.test.tsx`
- Modify: `packages/ui/src/styles/components.css`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppHeader } from "./AppHeader";

describe("AppHeader", () => {
  it("guest sees log in / sign up, not account", () => {
    render(<AppHeader session={{ loading: false, authenticated: false }} />);
    expect(screen.getByRole("link", { name: "log in" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "sign up" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "account" })).toBeNull();
  });
  it("authed sees account + developers + username, not log in", () => {
    render(<AppHeader session={{ loading: false, authenticated: true, username: "alex", verified: true }} />);
    expect(screen.getByRole("link", { name: "account" })).toBeInTheDocument();
    expect(screen.getByText("alex")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "log in" })).toBeNull();
  });
  it("while loading shows only brand + theme toggle (no nav flash)", () => {
    render(<AppHeader session={{ loading: true, authenticated: false }} />);
    expect(screen.queryByRole("link", { name: "log in" })).toBeNull();
    expect(screen.queryByRole("link", { name: "account" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/ui test -- AppHeader`

- [ ] **Step 3: Implement `AppHeader.tsx`**

```tsx
import type { Session } from "../lib/useSession";
import { ThemeToggle } from "./ThemeToggle";
import { Avatar } from "./Avatar";
import { cx } from "../lib/cx";

export function AppHeader({ session, className }: { session: Session; className?: string }) {
  return (
    <header className={cx("mw-header", className)}>
      <a className="mw-header__brand" href="/"><span className="mw-header__paw" aria-hidden="true">🐾</span> meowerse</a>
      <nav className="mw-header__nav" aria-label="primary">
        {!session.loading && !session.authenticated && (
          <>
            <a href="/about">about</a>
            <a href="/developers">developers</a>
            <a href="/login">log in</a>
            <a href="/signup">sign up</a>
          </>
        )}
        {!session.loading && session.authenticated && (
          <>
            <a href="/account">account</a>
            <a href="/developers">developers</a>
            <span className="mw-header__user"><Avatar name={session.username} size="sm" /> {session.username}</span>
          </>
        )}
        <ThemeToggle />
      </nav>
    </header>
  );
}
```

- [ ] **Step 4: Append styles**

```css
.mw-header { display: flex; align-items: center; justify-content: space-between; gap: var(--gap-lg); padding: 10px var(--gap-lg); border-bottom: 0.5px solid var(--border); }
.mw-header__brand { font-family: var(--font-display); font-size: var(--text-xl); color: var(--text-primary); text-decoration: none; }
.mw-header__nav { display: flex; align-items: center; gap: var(--gap-lg); }
.mw-header__nav a { color: var(--text-secondary); text-decoration: none; font-size: var(--text-sm); }
.mw-header__nav a:hover { color: var(--text-primary); }
.mw-header__user { display: inline-flex; align-items: center; gap: var(--gap-sm); font-size: var(--text-sm); }
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- AppHeader`

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/AppHeader.tsx packages/ui/src/components/AppHeader.test.tsx packages/ui/src/styles/components.css
git commit -m "feat(ui): AppHeader (guest/authed states)"
```

---

## Task 24: `AuthGate` (client-side guard, neutral loader)

**Files:**
- Create: `packages/ui/src/components/AuthGate.tsx`
- Test: `packages/ui/src/components/AuthGate.test.tsx`
- Modify: `packages/ui/src/styles/components.css`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "./AuthGate";

afterEach(() => vi.restoreAllMocks());

describe("AuthGate", () => {
  it("renders children when authenticated", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, username: "a", verified: false }), { status: 200 }));
    render(<AuthGate base="https://api"><p>secret</p></AuthGate>);
    expect(await screen.findByText("secret")).toBeInTheDocument();
  });
  it("redirects a guest to login with next", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ authenticated: false }), { status: 200 }));
    const replace = vi.fn();
    Object.defineProperty(window, "location", {
      value: { pathname: "/account", replace }, writable: true,
    });
    render(<AuthGate base="https://api"><p>secret</p></AuthGate>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login?next=%2Faccount"));
    expect(screen.queryByText("secret")).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/ui test -- AuthGate`

- [ ] **Step 3: Implement `AuthGate.tsx`**

```tsx
import { useEffect, type ReactNode } from "react";
import { useSession } from "../lib/useSession";
import { Spinner } from "./Spinner";

export function AuthGate({ base, children, loginPath = "/login" }:
  { base: string; children: ReactNode; loginPath?: string }) {
  const s = useSession(base);
  useEffect(() => {
    if (!s.loading && !s.authenticated) {
      const next = encodeURIComponent(window.location.pathname);
      window.location.replace(`${loginPath}?next=${next}`);
    }
  }, [s, loginPath]);

  if (s.loading || !s.authenticated) {
    return <div className="mw-gate"><Spinner size="lg" label="checking your session" /></div>;
  }
  return <>{children}</>;
}
```

- [ ] **Step 4: Append styles**

```css
.mw-gate { display: flex; align-items: center; justify-content: center; min-height: 40vh; }
```

- [ ] **Step 5: Run — expect PASS.** Run: `bun run --filter @meowerse/ui test -- AuthGate`

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/AuthGate.tsx packages/ui/src/components/AuthGate.test.tsx packages/ui/src/styles/components.css
git commit -m "feat(ui): AuthGate (client guard, neutral loader)"
```

---

## Task 25: Barrel export + full gate

**Files:**
- Modify: `packages/ui/src/index.ts` (replace the stub)

- [ ] **Step 1: Write the real `index.ts`**

```ts
export { Spinner } from "./components/Spinner";
export { Button, type ButtonProps } from "./components/Button";
export { Field, type FieldProps } from "./components/Field";
export { Checkbox, type CheckboxProps } from "./components/Checkbox";
export { RadioGroup, type RadioOption } from "./components/RadioGroup";
export { Card } from "./components/Card";
export { Badge } from "./components/Badge";
export { Alert } from "./components/Alert";
export { Code } from "./components/Code";
export { Avatar } from "./components/Avatar";
export { Modal } from "./components/Modal";
export { ConfirmDialog, type ConfirmResult } from "./components/ConfirmDialog";
export { ToastProvider, useToast } from "./components/Toast";
export { RecoveryCodes } from "./components/RecoveryCodes";
export { ThemeToggle } from "./components/ThemeToggle";
export { ContactLinks, DEFAULT_CONTACTS, type Contact } from "./components/ContactLinks";
export { Footer } from "./components/Footer";
export { AppHeader } from "./components/AppHeader";
export { AuthGate } from "./components/AuthGate";
export { useSession, type Session } from "./lib/useSession";
export { THEME_INIT_SCRIPT, getTheme, resolvedTheme, applyTheme, toggleTheme, type Theme } from "./lib/theme";
export { cx } from "./lib/cx";
```

- [ ] **Step 2: Run the full test suite with coverage**

Run: `bun run --filter @meowerse/ui test`
Expected: all tests pass; coverage ≥90% on branches/functions/lines/statements.

- [ ] **Step 3: Run lint**

Run: `bun run --filter @meowerse/ui lint`
Expected: exits 0.

- [ ] **Step 4: Verify the whole monorepo gate is still green**

Run: `cd C:/code/meow/meowerse && just lint && just test`
Expected: turbo runs all packages green (new `@meowerse/ui` included).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/index.ts
git commit -m "feat(ui): public barrel export for @meowerse/ui"
```

---

## Self-review checklist (run before handing off)

- **Spec coverage:** tokens (Task 2) · fonts (Task 2) · theme + no-flash + no-transition (Tasks 2–3) · lowercase + code carve-out (Task 2 `.mono/[data-case=preserve]`, enforced by Code Task 13 / Avatar Task 14 / RecoveryCodes Task 18 tests) · every primitive in the §5 inventory has a task · ConfirmDialog tiers (Task 16) · AppHeader two states (Task 23) · AuthGate + useSession (Tasks 19, 24) · Footer + ContactLinks (Tasks 21–22) · a11y focus ring (Task 2), Modal focus trap/Esc (Task 15).
- **Not in this plan (later plans):** `/api/session` + `/api/account/delete` (Plan 2); wiring these components into auth-web + guards on real pages (Plan 3); legal page content (Plan 4). AppHeader/AuthGate here are the reusable pieces; their app wiring is Plan 3.
- **Type consistency:** `Session` type defined in Task 19 is consumed by AppHeader (23) and AuthGate (24). `cx` (Task 4) used everywhere. `Button` variants (`primary|secondary|ghost|danger`) match ConfirmDialog's `variant` usage. `data-case="preserve"` string identical across Code/Avatar/RecoveryCodes/ConfirmDialog.
- **Placeholder scan:** none — every step has real code + exact run command.

---

## Notes for the implementer

- **Fontsource import paths:** if `@fontsource/jetbrains-mono/400.css` subpath is not found, fall back to `@fontsource/jetbrains-mono` (index import loads all weights). Verify the installed version's exports.
- **`color-mix`** is used for tints (Badge/Avatar/Alert); it's supported in all evergreen targets. If a target lacks it, replace with a pre-computed rgba.
- **Coverage:** if a branch dips below 90%, add the missing case to that component's test (e.g. Alert info variant, Button ghost variant) rather than lowering the threshold.
- **The 🐾 in AppHeader** is the one allowed emoji (brand mark), not a UI icon — everything else uses Tabler classes.
