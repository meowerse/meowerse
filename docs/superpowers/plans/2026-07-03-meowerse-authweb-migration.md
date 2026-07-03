# auth-web Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `apps/auth-web` onto `@meowerse/ui` — themed header/footer, two-state nav, route guards that fix the infinite-load, every screen rebuilt on primitives, and tiered confirm dialogs on dangerous actions.

**Architecture:** Astro (static) + React islands. `Layout.astro` imports `@meowerse/ui/tokens.css` in the layout frontmatter (so fonts land in `dist/`), runs the no-flash theme script in `<head>`, and renders a `SiteHeader` island (self-fetches `/api/session` via the ui `useSession` hook) + a static `Footer`. Guarded pages render a single island that composes `ToastProvider` → `AuthGate` → the screen. `authApi` GET helpers become status-aware so a 401 is a deterministic `{error:"no_session"}` instead of an infinite spinner. Dangerous actions use `ConfirmDialog` (type-to-confirm for deletes).

**Tech Stack:** Astro 7, React 19, `@meowerse/ui` (Plan 1), Vitest (existing lib tests only — components are composition of already-tested primitives; verified via `astro check` + build + preview smoke test).

**This is Plan 3 of 4.** Depends on Plan 1 (`@meowerse/ui`) and Plan 2 (`/api/session`, `/api/account/delete`). Plan 4 (legal pages) builds on the `Footer` links wired here.

---

## File structure

```
apps/auth-web/
  package.json                       # + @meowerse/ui dep
  src/
    styles/app.css                   # NEW: layout helpers (.mw-stack/.mw-narrow/.mw-muted)
    lib/authApi.ts                   # + deleteAccount, status-aware GET helpers
    lib/authApi.test.ts              # + tests for the above
    layouts/Layout.astro             # tokens.css + theme script + SiteHeader + Footer
    components/
      SiteHeader.tsx                 # NEW island: useSession -> AppHeader
      LoginForm.tsx  SignupForm.tsx  ConsentForm.tsx  TelegramButton.tsx   # rewritten on primitives
      AccountSettings.tsx  Dashboard.tsx                                    # rewritten
      AccountPage.tsx  DashboardPage.tsx  DevelopersPage.tsx  DevMarketing.tsx  LandingCta.tsx  # NEW wrappers
    pages/
      index.astro  login.astro  signup.astro  consent.astro  verify.astro  # updated
      account.astro  developers.astro  dashboard.astro  404.astro          # account guarded; dashboard -> redirect
```

---

## Task 1: Add the `@meowerse/ui` dependency

**Files:** Modify `apps/auth-web/package.json`

- [ ] **Step 1: Add the workspace dep** (in `dependencies`)

```jsonc
    "@meowerse/ui": "workspace:*",
```

- [ ] **Step 2: Install**

Run: `cd C:/code/meow/meowerse && bun install`
Expected: `@meowerse/ui` symlinked into `apps/auth-web/node_modules`.

- [ ] **Step 3: Commit**

```bash
git add apps/auth-web/package.json bun.lock
git commit -m "chore(auth-web): depend on @meowerse/ui"
```

---

## Task 2: `authApi` — deleteAccount + status-aware GETs (fixes infinite-load at the data layer)

**Files:**
- Modify: `apps/auth-web/src/lib/authApi.ts`
- Test: `apps/auth-web/src/lib/authApi.test.ts` (append)

- [ ] **Step 1: Write failing tests (append to `authApi.test.ts`)**

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { getAccount, deleteAccount } from "./authApi";

afterEach(() => vi.restoreAllMocks());

describe("authApi status-aware GET", () => {
  it("maps a 401 to {error:'no_session'} instead of parsing the body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401 }));
    expect(await getAccount("https://api")).toEqual({ error: "no_session" });
  });
  it("maps a non-ok non-401 to {error:'http'}", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
    expect(await getAccount("https://api")).toEqual({ error: "http" });
  });
  it("deleteAccount posts csrf + confirm", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await deleteAccount("https://api", "csrf1", "neko");
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ csrf: "csrf1", confirm: "neko" });
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `bun run --filter @meowerse/auth-web test`
Expected: FAIL (`deleteAccount` not exported; `getAccount` doesn't special-case status).

- [ ] **Step 3: Add a status-aware GET helper + reroute the three GETs + add `deleteAccount` (in `authApi.ts`)**

Replace the three GET functions (`getAccount`, `getGrants`, `listClients`) and add the helper + `deleteAccount`:

```ts
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  if (res.status === 401) return { error: "no_session" } as T;
  if (!res.ok) return { error: "http" } as T;
  return (await res.json()) as T;
}

export function getAccount(base: string): Promise<AccountInfo> {
  return getJson<AccountInfo>(`${base}/api/account`);
}
export function getGrants(base: string): Promise<{ grants?: Grant[]; error?: string }> {
  return getJson(`${base}/api/account/grants`);
}
export function listClients(base: string): Promise<{ clients?: ClientSummary[]; csrf?: string; error?: string }> {
  return getJson(`${base}/api/dev/clients`);
}
export function deleteAccount(base: string, csrf: string, confirm: string): Promise<{ ok?: boolean; error?: string }> {
  return postJson(`${base}/api/account/delete`, { csrf, confirm });
}
```

(Delete the old `getAccount`/`getGrants`/`listClients` bodies; keep everything else.)

- [ ] **Step 4: Run — expect PASS.** Run: `bun run --filter @meowerse/auth-web test`

- [ ] **Step 5: Commit**

```bash
git add apps/auth-web/src/lib/authApi.ts apps/auth-web/src/lib/authApi.test.ts
git commit -m "feat(auth-web): status-aware GETs + deleteAccount client"
```

---

## Task 3: Layout — tokens, theme script, header, footer

**Files:**
- Create: `apps/auth-web/src/styles/app.css`
- Create: `apps/auth-web/src/components/SiteHeader.tsx`
- Modify: `apps/auth-web/src/layouts/Layout.astro`

- [ ] **Step 1: Create `src/styles/app.css`**

```css
main { max-width: 34rem; margin: 2rem auto; padding: 0 1rem; width: 100%; }
main.wide { max-width: 52rem; }
.mw-stack { display: flex; flex-direction: column; gap: var(--gap-md); }
.mw-section { display: flex; flex-direction: column; gap: var(--gap-sm); margin-top: var(--gap-xl); }
.mw-narrow { max-width: 24rem; }
.mw-muted { color: var(--text-muted); font-size: var(--text-sm); }
h1 { font-size: var(--text-2xl); font-weight: 600; margin: 0 0 var(--gap-md); }
h2 { font-size: var(--text-lg); font-weight: 600; margin: 0; }
a { color: var(--text-accent); }
```

- [ ] **Step 2: Create `SiteHeader.tsx` (island that self-fetches the session)**

```tsx
import { AppHeader, useSession } from "@meowerse/ui";

export default function SiteHeader({ base }: { base: string }) {
  const session = useSession(base);
  return <AppHeader session={session} />;
}
```

- [ ] **Step 3: Rewrite `Layout.astro`**

```astro
---
import "@meowerse/ui/tokens.css";
import "../styles/app.css";
import { THEME_INIT_SCRIPT } from "@meowerse/ui";
import { Footer } from "@meowerse/ui";
import SiteHeader from "../components/SiteHeader.tsx";
interface Props { title: string; wide?: boolean }
const { title, wide } = Astro.props;
const base = import.meta.env.PUBLIC_AUTH_API_URL ?? "https://auth-api.alxnko.eu.org";
Astro.response.headers.set("Referrer-Policy", "no-referrer");
Astro.response.headers.set("Cache-Control", "no-store");
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <script is:inline set:html={THEME_INIT_SCRIPT}></script>
  </head>
  <body>
    <SiteHeader client:load base={base} />
    <main class={wide ? "wide" : undefined}>
      <slot />
    </main>
    <Footer />
  </body>
</html>
```

- [ ] **Step 4: Verify it builds**

Run: `bun run --filter @meowerse/auth-web build`
Expected: build succeeds; `dist/` contains the woff2 fonts (from `tokens.css`) and the header island JS.

- [ ] **Step 5: Commit**

```bash
git add apps/auth-web/src/styles/app.css apps/auth-web/src/components/SiteHeader.tsx apps/auth-web/src/layouts/Layout.astro
git commit -m "feat(auth-web): themed layout — tokens, no-flash theme, header, footer"
```

---

## Task 4: Rewrite `LoginForm`

**Files:** Modify `apps/auth-web/src/components/LoginForm.tsx`

- [ ] **Step 1: Replace the file**

```tsx
import { useState, type FormEvent } from "react";
import { Button, Field, Alert } from "@meowerse/ui";
import { postLogin, nextLocation } from "../lib/authApi";

export default function LoginForm({ base }: { base: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      const res = await postLogin(base, username, password);
      if (res.ok) window.location.href = nextLocation(res.next);
      else setError(res.error === "invalid_credentials" ? "wrong username or password." : res.error ?? "login failed.");
    } catch { setError("network error — please try again."); }
    setBusy(false);
  }

  return (
    <form onSubmit={onSubmit} className="mw-stack mw-narrow">
      <Field label="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
      <Field label="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      {error && <Alert variant="error">{error}</Alert>}
      <Button variant="primary" type="submit" loading={busy}>sign in</Button>
      <p className="mw-muted">new here? <a href="/signup">create an account</a></p>
    </form>
  );
}
```

- [ ] **Step 2: Typecheck.** Run: `bun run --filter @meowerse/auth-web lint` — expect 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/auth-web/src/components/LoginForm.tsx
git commit -m "feat(auth-web): LoginForm on @meowerse/ui"
```

---

## Task 5: Rewrite `SignupForm`

**Files:** Modify `apps/auth-web/src/components/SignupForm.tsx`

- [ ] **Step 1: Replace the file**

```tsx
import { useState, type FormEvent } from "react";
import { Button, Field, Alert, Card, RecoveryCodes } from "@meowerse/ui";
import { postSignup, nextLocation, type NextStep } from "../lib/authApi";

export default function SignupForm({ base }: { base: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [next, setNext] = useState<NextStep | undefined>(undefined);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      const res = await postSignup(base, username, password);
      if (res.ok) { setCodes(res.recoveryCodes ?? []); setNext(res.next); }
      else setError(errorText(res.error));
    } catch { setError("network error — please try again."); }
    setBusy(false);
  }

  if (codes) {
    return (
      <Card title="save your recovery codes" className="mw-narrow">
        <p className="mw-muted">shown once. store them somewhere safe — each works a single time if you lose access.</p>
        <RecoveryCodes codes={codes} />
        <div style={{ marginTop: "var(--gap-lg)" }}>
          <Button variant="primary" onClick={() => (window.location.href = nextLocation(next))}>i've saved them — continue</Button>
        </div>
      </Card>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mw-stack mw-narrow">
      <Field label="username" hint="3–32 letters, numbers, or underscores" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required minLength={3} maxLength={32} />
      <Field label="password" hint="12–128 characters" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={12} />
      {error && <Alert variant="error">{error}</Alert>}
      <Button variant="primary" type="submit" loading={busy}>create account</Button>
      <p className="mw-muted">already have one? <a href="/login">sign in</a></p>
    </form>
  );
}

function errorText(error: string | undefined): string {
  if (error === "unavailable") return "that username is taken.";
  if (error === "rate_limited") return "too many attempts — try again later.";
  if (error?.includes("password")) return "password must be 12–128 characters.";
  if (error?.includes("username")) return "usernames are 3–32 letters, numbers, or underscores.";
  return error ?? "sign-up failed.";
}
```

- [ ] **Step 2: Typecheck.** Run: `bun run --filter @meowerse/auth-web lint`

- [ ] **Step 3: Commit**

```bash
git add apps/auth-web/src/components/SignupForm.tsx
git commit -m "feat(auth-web): SignupForm on @meowerse/ui"
```

---

## Task 6: Rewrite `ConsentForm`

**Files:** Modify `apps/auth-web/src/components/ConsentForm.tsx`

- [ ] **Step 1: Replace the file**

```tsx
import { useEffect, useState } from "react";
import { Button, Checkbox, Card, Alert, Spinner } from "@meowerse/ui";
import { getPending, postConsent, type PendingResponse } from "../lib/authApi";

const SCOPE_LABELS: Record<string, string> = {
  openid: "your account identifier",
  profile: "your username, display name and avatar",
  telegram: "your linked telegram account",
  verified: "whether your account is verified",
  offline_access: "stay signed in (refresh access)",
};

export default function ConsentForm({ base }: { base: string }) {
  const [pending, setPending] = useState<PendingResponse | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPending(base)
      .then((p) => {
        if (p.error === "no_session") setError("no_session");
        else if (p.error) setError("no pending authorization request.");
        else { setPending(p); setSelected(p.scope ?? []); }
      })
      .catch(() => setError("network"));
  }, [base]);

  function toggle(s: string) {
    if (s === "openid") return;
    setSelected((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  }

  async function decide(decision: "allow" | "deny") {
    if (!pending?.csrf) return;
    setBusy(true);
    try {
      const res = await postConsent(base, decision, pending.csrf, decision === "allow" ? selected : undefined);
      if (res.redirect) window.location.href = res.redirect;
      else setError(res.error ?? "could not complete the request.");
    } catch { setError("network"); }
    setBusy(false);
  }

  if (error === "no_session") return <Alert variant="error">please <a href="/login">sign in</a> to continue.</Alert>;
  if (error) return <Alert variant="error">{error === "network" ? "network error." : error}</Alert>;
  if (!pending) return <div className="mw-stack"><Spinner label="loading request" /></div>;

  return (
    <Card title={`authorize ${pending.client?.name}`} className="mw-narrow">
      <p className="mw-muted"><strong>{pending.client?.name}</strong> is requesting access to your meowerse account. choose what to share:</p>
      <div className="mw-stack" style={{ margin: "var(--gap-md) 0" }}>
        {pending.scope?.map((s) => (
          <Checkbox key={s} label={`${SCOPE_LABELS[s] ?? s}${s === "openid" ? " (required)" : ""}`}
            checked={selected.includes(s)} disabled={s === "openid" || busy} onChange={() => toggle(s)} />
        ))}
      </div>
      <div style={{ display: "flex", gap: "var(--gap-sm)" }}>
        <Button variant="primary" disabled={busy} onClick={() => decide("allow")}>allow</Button>
        <Button variant="secondary" disabled={busy} onClick={() => decide("deny")}>deny</Button>
      </div>
    </Card>
  );
}
```

- [ ] **Step 2: Typecheck.** Run: `bun run --filter @meowerse/auth-web lint`

- [ ] **Step 3: Commit**

```bash
git add apps/auth-web/src/components/ConsentForm.tsx
git commit -m "feat(auth-web): ConsentForm on @meowerse/ui"
```

---

## Task 7: Rewrite `AccountSettings` + `AccountPage` (guard + toast + delete-account)

**Files:**
- Modify: `apps/auth-web/src/components/AccountSettings.tsx`
- Create: `apps/auth-web/src/components/AccountPage.tsx`

- [ ] **Step 1: Replace `AccountSettings.tsx`**

```tsx
import { useEffect, useState, type FormEvent } from "react";
import { Button, Field, Card, Badge, Alert, RecoveryCodes, ConfirmDialog, useToast, Spinner } from "@meowerse/ui";
import { getAccount, postAccountPassword, getGrants, revokeGrant, unlinkTelegram, regenerateRecoveryCodes, deleteAccount, type AccountInfo, type Grant } from "../lib/authApi";

export default function AccountSettings({ base }: { base: string }) {
  const toast = useToast();
  const [acct, setAcct] = useState<AccountInfo | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [error, setError] = useState("");
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState<null | { kind: "revoke" | "unlink" | "regen" | "delete"; clientId?: string }>(null);
  const [busy, setBusy] = useState(false);

  function reload() {
    getAccount(base).then((a) => { if (a.error === "no_session") setError("no_session"); else setAcct(a); }).catch(() => setError("network"));
    getGrants(base).then((g) => setGrants(g.grants ?? [])).catch(() => {});
  }
  useEffect(reload, [base]);

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    if (!acct) return;
    const r = await postAccountPassword(base, acct.csrf, cur, next);
    if (r.ok) { toast({ message: "password changed", variant: "success" }); setCur(""); setNext(""); }
    else toast({ message: r.error === "wrong_password" ? "current password is wrong" : "could not change password", variant: "error" });
  }

  async function runConfirm(password?: string) {
    if (!acct || !confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === "revoke" && confirm.clientId) {
        await revokeGrant(base, acct.csrf, confirm.clientId);
        setGrants((g) => g.filter((x) => x.clientId !== confirm.clientId));
        toast({ message: "access revoked", variant: "success" });
      } else if (confirm.kind === "unlink") {
        const r = await unlinkTelegram(base, acct.csrf);
        if (r.ok) { toast({ message: "telegram unlinked", variant: "success" }); reload(); }
        else toast({ message: "set a password first — unlinking would lock you out", variant: "error" });
      } else if (confirm.kind === "regen") {
        const r = await regenerateRecoveryCodes(base, acct.csrf);
        if (r.recoveryCodes) { setCodes(r.recoveryCodes); toast({ message: "recovery codes regenerated", variant: "success" }); }
      } else if (confirm.kind === "delete") {
        const r = await deleteAccount(base, acct.csrf, acct.username ?? acct.displayName ?? "");
        if (r.ok) window.location.href = "/";
        else toast({ message: "could not delete account", variant: "error" });
      }
    } finally { setBusy(false); setConfirm(null); }
  }

  if (error === "no_session") return <Alert variant="error">please <a href="/login">sign in</a> to manage your account.</Alert>;
  if (!acct) return <div className="mw-stack"><Spinner label="loading account" /></div>;

  return (
    <div className="mw-stack">
      <h1>account</h1>
      <p style={{ display: "flex", alignItems: "center", gap: "var(--gap-sm)" }}>
        <strong>{acct.username ?? acct.displayName ?? "telegram account"}</strong>
        {acct.verified ? <Badge variant="verified" icon="rosette-discount-check">verified</Badge> : <Badge>unverified</Badge>}
      </p>

      <Card title="telegram">
        {acct.telegram.linked ? (
          <p>linked{acct.telegram.username ? ` as @${acct.telegram.username}` : ""}. <Button size="sm" variant="secondary" onClick={() => setConfirm({ kind: "unlink" })}>unlink</Button></p>
        ) : (
          <p>not linked. <a href="/verify"><Button size="sm" variant="secondary">verify with telegram</Button></a></p>
        )}
      </Card>

      {acct.hasPassword && (
        <Card title="change password">
          <form onSubmit={changePassword} className="mw-stack">
            <Field label="current password" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />
            <Field label="new password" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={12} required />
            <Button variant="primary" type="submit">update password</Button>
          </form>
        </Card>
      )}

      <Card title="connected apps">
        {grants.length === 0 ? <p className="mw-muted">no apps have access.</p> : (
          <div className="mw-stack">
            {grants.map((g) => (
              <div key={g.clientId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--gap-md)" }}>
                <span><code className="mono" data-case="preserve">{g.clientId}</code> — {g.approvedScopes.join(", ")}</span>
                <Button size="sm" variant="danger" onClick={() => setConfirm({ kind: "revoke", clientId: g.clientId })}>revoke</Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="recovery codes">
        <p>{acct.recoveryRemaining} unused. <Button size="sm" variant="secondary" onClick={() => setConfirm({ kind: "regen" })}>regenerate</Button></p>
        {codes && <div style={{ marginTop: "var(--gap-md)" }}><p className="mw-muted">new codes (shown once — save them):</p><RecoveryCodes codes={codes} /></div>}
      </Card>

      <Card title="danger zone">
        <p className="mw-muted">deleting your account is permanent and removes all your data and apps.</p>
        <Button variant="danger" onClick={() => setConfirm({ kind: "delete" })}>delete account</Button>
      </Card>

      <p><a href="/logout"><Button variant="secondary">sign out</Button></a></p>

      <ConfirmDialog open={confirm?.kind === "revoke"} onCancel={() => setConfirm(null)} onConfirm={() => runConfirm()}
        title="revoke access?" description="the app will immediately lose access to your account. you can re-authorize any time."
        confirmLabel="revoke access" variant="danger" loading={busy} />
      <ConfirmDialog open={confirm?.kind === "unlink"} onCancel={() => setConfirm(null)} onConfirm={() => runConfirm()}
        title="unlink telegram?" description="you'll lose your verified status and telegram sign-in." confirmLabel="unlink" variant="danger" loading={busy} />
      <ConfirmDialog open={confirm?.kind === "regen"} onCancel={() => setConfirm(null)} onConfirm={() => runConfirm()}
        title="regenerate recovery codes?" description="your current recovery codes stop working immediately." confirmLabel="regenerate" variant="danger" loading={busy} />
      <ConfirmDialog open={confirm?.kind === "delete"} onCancel={() => setConfirm(null)} onConfirm={() => runConfirm()}
        title="delete your account?" description="this is permanent. all your data, connected apps, and owned apps are erased."
        confirmLabel="delete account" variant="danger" confirmPhrase={acct.username ?? acct.displayName ?? ""} loading={busy} />
    </div>
  );
}
```

- [ ] **Step 2: Create `AccountPage.tsx` (guard + toast wrapper — one island)**

```tsx
import { AuthGate, ToastProvider } from "@meowerse/ui";
import AccountSettings from "./AccountSettings";

export default function AccountPage({ base }: { base: string }) {
  return (
    <ToastProvider>
      <AuthGate base={base}>
        <AccountSettings base={base} />
      </AuthGate>
    </ToastProvider>
  );
}
```

- [ ] **Step 3: Typecheck.** Run: `bun run --filter @meowerse/auth-web lint`

- [ ] **Step 4: Commit**

```bash
git add apps/auth-web/src/components/AccountSettings.tsx apps/auth-web/src/components/AccountPage.tsx
git commit -m "feat(auth-web): AccountSettings on primitives + guard/toast/delete-account"
```

---

## Task 8: Rewrite `Dashboard` + `DashboardPage` (ConfirmDialog for delete)

**Files:**
- Modify: `apps/auth-web/src/components/Dashboard.tsx`
- Create: `apps/auth-web/src/components/DashboardPage.tsx`

- [ ] **Step 1: Replace `Dashboard.tsx`**

```tsx
import { useEffect, useState, type FormEvent } from "react";
import { Button, Field, Card, Checkbox, RadioGroup, Code, Alert, ConfirmDialog, useToast, Spinner } from "@meowerse/ui";
import { listClients, createClient, deleteClient, rotateClientSecret, postManagementToken, type ClientSummary } from "../lib/authApi";

const SCOPE_OPTIONS = ["openid", "profile", "telegram", "verified", "offline_access"];

export default function Dashboard({ base }: { base: string }) {
  const toast = useToast();
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [csrf, setCsrf] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ clientId: string; clientSecret?: string } | null>(null);
  const [rotated, setRotated] = useState<{ clientId: string; secret: string } | null>(null);
  const [mgmtToken, setMgmtToken] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<ClientSummary | null>(null);

  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [redirect, setRedirect] = useState("");
  const [clientType, setClientType] = useState("public");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [scopes, setScopes] = useState<string[]>(["openid", "profile"]);

  function reload() {
    listClients(base).then((r) => { if (!r.error) { setClients(r.clients ?? []); setCsrf(r.csrf ?? ""); } setLoaded(true); }).catch(() => setError("network error."));
  }
  useEffect(reload, [base]);

  function toggleScope(s: string) { setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s])); }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(""); setBusy(true);
    const r = await createClient(base, { csrf, name, display_name: displayName || undefined, client_type: clientType, redirect_uris: redirect, scopes: scopes.join(" "), verified_only: verifiedOnly ? "true" : "false" });
    setBusy(false);
    if (r.ok && r.clientId) { setCreated({ clientId: r.clientId, clientSecret: r.clientSecret }); setName(""); setDisplayName(""); setRedirect(""); reload(); toast({ message: "app created", variant: "success" }); }
    else setError(errorText(r.error));
  }

  async function doDelete() {
    if (!toDelete) return;
    setBusy(true);
    try { await deleteClient(base, csrf, toDelete.clientId); setClients((c) => c.filter((x) => x.clientId !== toDelete.clientId)); toast({ message: "app deleted", variant: "success" }); }
    finally { setBusy(false); setToDelete(null); }
  }

  async function onRotate(clientId: string) {
    const r = await rotateClientSecret(base, csrf, clientId);
    if (r.clientSecret) setRotated({ clientId, secret: r.clientSecret });
    else toast({ message: "only confidential apps have a secret to rotate", variant: "error" });
  }

  async function onMgmtToken() { const r = await postManagementToken(base, csrf); if (r.token) setMgmtToken(r.token); }

  if (!loaded) return <div className="mw-stack"><Spinner label="loading your apps" /></div>;

  return (
    <div className="mw-stack">
      <h1>developer dashboard</h1>

      {created && (
        <Card title="app created">
          <p><Code value={created.clientId} copy /></p>
          {created.clientSecret ? <p>api key (shown once — save it now): <Code value={created.clientSecret} copy /></p> : <p className="mw-muted">public client — no secret (uses pkce).</p>}
        </Card>
      )}
      {rotated && <Card title="new secret"><p>for <code className="mono" data-case="preserve">{rotated.clientId}</code> (shown once): <Code value={rotated.secret} copy /></p></Card>}

      <Card title="your apps">
        {clients.length === 0 ? <p className="mw-muted">no apps yet.</p> : (
          <div className="mw-stack">
            {clients.map((c) => (
              <div key={c.clientId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--gap-md)", flexWrap: "wrap" }}>
                <span><strong>{c.displayName ?? c.name}</strong> — <code className="mono" data-case="preserve">{c.clientId}</code> ({c.clientType}{c.verifiedOnly ? ", verified-only" : ""}) · {c.allowedScopes.join(", ")}</span>
                <span style={{ display: "flex", gap: "var(--gap-sm)" }}>
                  {c.clientType === "confidential" && <Button size="sm" variant="secondary" onClick={() => onRotate(c.clientId)}>rotate secret</Button>}
                  <Button size="sm" variant="danger" onClick={() => setToDelete(c)}>delete</Button>
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="register an app">
        <form onSubmit={onCreate} className="mw-stack">
          <Field label="name (lowercase, e.g. my-app)" value={name} onChange={(e) => setName(e.target.value)} required />
          <Field label="display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="my app" />
          <Field label="redirect uri" value={redirect} onChange={(e) => setRedirect(e.target.value)} placeholder="https://your.app/callback" required />
          <RadioGroup name="ct" legend="type" value={clientType} onChange={setClientType}
            options={[{ label: "public (spa/mobile, pkce)", value: "public" }, { label: "confidential (server, gets an api key)", value: "confidential" }]} />
          <fieldset style={{ border: "0.5px solid var(--border)", borderRadius: "var(--radius)", padding: "var(--gap-sm) var(--gap-md)" }}>
            <legend className="mw-muted">data the app may request</legend>
            <div className="mw-stack">
              {SCOPE_OPTIONS.map((s) => <Checkbox key={s} label={s} checked={scopes.includes(s)} disabled={s === "openid"} onChange={() => toggleScope(s)} />)}
            </div>
          </fieldset>
          <Checkbox label="only verified users may authorize" checked={verifiedOnly} onChange={(e) => setVerifiedOnly(e.target.checked)} />
          {error && <Alert variant="error">{error}</Alert>}
          <Button variant="primary" type="submit" loading={busy}>create app</Button>
        </form>
      </Card>

      <Card title="config-as-code (iac)">
        <p className="mw-muted">mint a management token to provision apps from <code className="mono" data-case="preserve">auth.config.ts</code> with <code className="mono" data-case="preserve">@meowerse/auth</code>.</p>
        <Button variant="secondary" onClick={onMgmtToken}>generate management token</Button>
        {mgmtToken && (
          <div style={{ marginTop: "var(--gap-md)" }}>
            <p>management token (shown once): <Code value={mgmtToken} copy /></p>
            <pre className="mono" data-case="preserve">{`import { defineAuthClient } from "@meowerse/auth";
export default defineAuthClient({
  name: "my-app",
  redirectUris: ["https://your.app/callback"],
  scopes: ["openid", "profile"],
});`}</pre>
          </div>
        )}
      </Card>

      <ConfirmDialog open={!!toDelete} onCancel={() => setToDelete(null)} onConfirm={doDelete}
        title={`delete ${toDelete?.displayName ?? toDelete?.name ?? "app"}?`}
        description="this breaks the integration for everyone using it. it cannot be undone."
        confirmLabel="delete app" variant="danger" confirmPhrase={toDelete?.name ?? ""} loading={busy} />
    </div>
  );
}

function errorText(error: string | undefined): string {
  if (error === "name_taken") return "that app name is taken.";
  if (error === "invalid_name") return "name must be 3–40 lowercase letters/numbers/hyphens.";
  if (error === "invalid_redirect_uri") return "redirect uri must be https (or http loopback) with no fragment.";
  if (error === "redirect_uri_required") return "a redirect uri is required.";
  return error ?? "could not create the app.";
}
```

- [ ] **Step 2: Create `DashboardPage.tsx`**

```tsx
import { ToastProvider } from "@meowerse/ui";
import Dashboard from "./Dashboard";

export default function DashboardPage({ base }: { base: string }) {
  return <ToastProvider><Dashboard base={base} /></ToastProvider>;
}
```

- [ ] **Step 3: Typecheck.** Run: `bun run --filter @meowerse/auth-web lint`

- [ ] **Step 4: Commit**

```bash
git add apps/auth-web/src/components/Dashboard.tsx apps/auth-web/src/components/DashboardPage.tsx
git commit -m "feat(auth-web): Dashboard on primitives + type-to-confirm delete"
```

---

## Task 9: Developers split (marketing for guests, dashboard for owners)

**Files:**
- Create: `apps/auth-web/src/components/DevMarketing.tsx`
- Create: `apps/auth-web/src/components/DevelopersPage.tsx`

- [ ] **Step 1: Create `DevMarketing.tsx`**

```tsx
import { Button, Card } from "@meowerse/ui";

export default function DevMarketing() {
  return (
    <div className="mw-stack">
      <h1>build on meowerse</h1>
      <p className="mw-muted">add "continue with meowerse" to your app — one login, telegram verification, and granular per-scope consent, on the free tier.</p>
      <Card title="what you get">
        <ul>
          <li>standards oauth2 / oidc with pkce</li>
          <li>public (pkce) or confidential (api key) clients</li>
          <li>choose exactly which data your app may request</li>
          <li>restrict to verified users, config-as-code provisioning</li>
        </ul>
      </Card>
      <p><a href="/login?next=%2Fdevelopers"><Button variant="primary">sign in to manage your apps</Button></a></p>
    </div>
  );
}
```

- [ ] **Step 2: Create `DevelopersPage.tsx` (session-aware: marketing vs dashboard, no redirect)**

```tsx
import { useSession, Spinner } from "@meowerse/ui";
import DevMarketing from "./DevMarketing";
import DashboardPage from "./DashboardPage";

export default function DevelopersPage({ base }: { base: string }) {
  const s = useSession(base);
  if (s.loading) return <div className="mw-stack"><Spinner label="loading" /></div>;
  if (!s.authenticated) return <DevMarketing />;
  return <DashboardPage base={base} />;
}
```

- [ ] **Step 3: Typecheck.** Run: `bun run --filter @meowerse/auth-web lint`

- [ ] **Step 4: Commit**

```bash
git add apps/auth-web/src/components/DevMarketing.tsx apps/auth-web/src/components/DevelopersPage.tsx
git commit -m "feat(auth-web): developers split — marketing for guests, dashboard for owners"
```

---

## Task 10: Astro pages — wire islands, add /developers, /404, guarded /account, landing

**Files:**
- Modify: `apps/auth-web/src/pages/account.astro`
- Create: `apps/auth-web/src/pages/developers.astro`
- Modify: `apps/auth-web/src/pages/dashboard.astro` (→ redirect)
- Create: `apps/auth-web/src/pages/404.astro`
- Modify: `apps/auth-web/src/pages/index.astro`
- Create: `apps/auth-web/src/components/LandingCta.tsx`

- [ ] **Step 1: `account.astro` — render the guarded page island**

```astro
---
import Layout from "../layouts/Layout.astro";
import AccountPage from "../components/AccountPage.tsx";
const base = import.meta.env.PUBLIC_AUTH_API_URL ?? "https://auth-api.alxnko.eu.org";
---
<Layout title="account · meowerse">
  <AccountPage client:load base={base} />
</Layout>
```

- [ ] **Step 2: `developers.astro`**

```astro
---
import Layout from "../layouts/Layout.astro";
import DevelopersPage from "../components/DevelopersPage.tsx";
const base = import.meta.env.PUBLIC_AUTH_API_URL ?? "https://auth-api.alxnko.eu.org";
---
<Layout title="developers · meowerse" wide>
  <DevelopersPage client:load base={base} />
</Layout>
```

- [ ] **Step 3: `dashboard.astro` — redirect old path to /developers**

```astro
---
import Layout from "../layouts/Layout.astro";
---
<Layout title="developers · meowerse">
  <p>redirecting to <a href="/developers">developers</a>…</p>
  <script is:inline>location.replace("/developers");</script>
</Layout>
```

- [ ] **Step 4: `404.astro`**

```astro
---
import Layout from "../layouts/Layout.astro";
---
<Layout title="not found · meowerse">
  <div class="mw-stack" style="text-align:center; align-items:center;">
    <p style="font-family: var(--font-display); font-size: 64px;">404</p>
    <p class="mw-muted">that page wandered off.</p>
    <p><a href="/">back home</a></p>
  </div>
</Layout>
```

- [ ] **Step 5: `LandingCta.tsx` (session-aware landing button)**

```tsx
import { useSession, Button, Spinner } from "@meowerse/ui";

export default function LandingCta({ base }: { base: string }) {
  const s = useSession(base);
  if (s.loading) return <Spinner label="loading" />;
  if (s.authenticated) return <a href="/account"><Button variant="primary">go to your account</Button></a>;
  return (
    <div style={{ display: "flex", gap: "var(--gap-sm)" }}>
      <a href="/signup"><Button variant="primary">create account</Button></a>
      <a href="/login"><Button variant="secondary">sign in</Button></a>
    </div>
  );
}
```

- [ ] **Step 6: `index.astro` — landing**

```astro
---
import Layout from "../layouts/Layout.astro";
import LandingCta from "../components/LandingCta.tsx";
const base = import.meta.env.PUBLIC_AUTH_API_URL ?? "https://auth-api.alxnko.eu.org";
---
<Layout title="meowerse accounts">
  <div class="mw-stack">
    <h1>one login for everything meowerse</h1>
    <p class="mw-muted">sign in once, verify with telegram, and control exactly which apps see which data.</p>
    <LandingCta client:load base={base} />
    <p class="mw-muted"><a href="/developers">building an app?</a> · <a href="/about">about</a></p>
  </div>
</Layout>
```

- [ ] **Step 7: Typecheck + build.** Run: `bun run --filter @meowerse/auth-web lint && bun run --filter @meowerse/auth-web build`

- [ ] **Step 8: Commit**

```bash
git add apps/auth-web/src/pages apps/auth-web/src/components/LandingCta.tsx
git commit -m "feat(auth-web): wire pages — guarded account, developers split, 404, landing"
```

---

## Task 11: Restyle `TelegramButton` on primitives

**Files:** Modify `apps/auth-web/src/components/TelegramButton.tsx`

- [ ] **Step 1: Replace the two `<button>`s with the `Button` primitive (keep all polling logic identical)**

```tsx
import { useRef, useState } from "react";
import { Button } from "@meowerse/ui";
import { tgStart, tgStatus, nextLocation, type NextStep } from "../lib/authApi";

export default function TelegramButton({ base, kind, label }: { base: string; kind?: "VERIFY_EXISTING"; label?: string }) {
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function start() {
    setError("");
    const res = await tgStart(base, kind).catch(() => ({ error: "network" }) as { error: string });
    if (!("deepLink" in res) || !res.deepLink || !res.ticketId) { setError("telegram sign-in isn't available right now."); return; }
    setLink(res.deepLink);
    const ticketId = res.ticketId;
    timer.current = setInterval(async () => {
      const s = await tgStatus(base, ticketId).catch(() => ({ ready: false }) as { ready: boolean; next?: NextStep });
      if (s.ready) { if (timer.current) clearInterval(timer.current); window.location.href = nextLocation(s.next); }
    }, 2000);
    setTimeout(() => timer.current && clearInterval(timer.current), 5 * 60 * 1000);
  }

  if (link) {
    return (
      <div className="mw-stack">
        <a href={link} target="_blank" rel="noreferrer noopener"><Button variant="primary">open telegram to confirm</Button></a>
        <p className="mw-muted">waiting for you to tap start in telegram…</p>
      </div>
    );
  }
  return (
    <div className="mw-stack">
      <Button variant="secondary" onClick={start}>{label ?? "continue with telegram"}</Button>
      {error && <p role="alert" style={{ color: "var(--text-danger)" }}>{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck.** Run: `bun run --filter @meowerse/auth-web lint`

- [ ] **Step 3: Commit**

```bash
git add apps/auth-web/src/components/TelegramButton.tsx
git commit -m "feat(auth-web): TelegramButton on @meowerse/ui"
```

---

## Task 12: Verify build, CSP, and smoke-test in the browser

**Files:** none (verification) — may touch `apps/auth-web/public/_headers`

- [ ] **Step 1: Full build + typecheck**

Run: `bun run --filter @meowerse/auth-web lint && bun run --filter @meowerse/auth-web build`
Expected: 0 type errors; `dist/` has all pages + the woff2 fonts + island JS.

- [ ] **Step 2: Confirm CSP still same-origin**

Read `apps/auth-web/public/_headers`. Fonts + styles are self-hosted (bundled into `dist/`), so `style-src`/`font-src` need no external origin. `connect-src` must allow the auth API origin (`https://auth-api.alxnko.eu.org`) for the `fetch` calls — verify it's present; if the file scopes `connect-src`, ensure the API origin is listed. Do not add any external font/style origin.

- [ ] **Step 3: Smoke test with the preview tools**

Use `preview_start` (create `.claude/launch.json` for `astro dev` on port 4321 if absent), then:
- `/` renders the header (guest: about/developers/log in/sign up) + landing + footer, in both themes (toggle).
- `/account` as a guest → shows the neutral loader then redirects to `/login?next=%2Faccount` (no infinite spinner).
- `/developers` as a guest → shows the marketing view (no create-account-looking form).
- Toggle theme → no color-slide flash on reload.
Confirm no console errors via `preview_console_logs`.

- [ ] **Step 4: Monorepo gate**

Run: `cd C:/code/meow/meowerse && just lint && just test`
Expected: green (auth-web lib tests + ui + worker).

- [ ] **Step 5: Commit any `_headers` adjustment**

```bash
git add apps/auth-web/public/_headers
git commit -m "chore(auth-web): confirm CSP connect-src covers auth api"
```

---

## Self-review checklist

- **Spec coverage (§14):** two-state header (Task 3 SiteHeader/AppHeader) · `/api/session`-driven guard `AuthGate` on `/account` (Task 7 AccountPage) · infinite-load fixed at data layer (Task 2) + never-unbounded-loading in components (Spinner states) · pages-vs-modals: password/revoke/unlink/regen/delete-account/delete-client are modals via `ConfirmDialog` (Tasks 7–8) · developers marketing/dashboard split (Task 9) · footer on every page (Task 3) · 404 (Task 10).
- **Type consistency:** every component imports named exports that exist in Plan 1's barrel (`Button`, `Field`, `Card`, `Checkbox`, `RadioGroup`, `Code`, `Alert`, `Badge`, `Spinner`, `RecoveryCodes`, `ConfirmDialog`, `useToast`, `AuthGate`, `AppHeader`, `useSession`, `ToastProvider`, `Footer`). `deleteAccount(base, csrf, confirm)` matches Task 2. `AppHeader` receives the `Session` union from `useSession`. Confirm phrases (`acct.username`, `toDelete.name`) are lowercase, so no `data-case` needed on `ConfirmDialog`'s Field.
- **Placeholder scan:** none — every step has full file/patch code + exact run command.

## Notes for the implementer

- **`PUBLIC_AUTH_API_URL`** must be set at build time (already used by `verify.astro`); default falls back to the prod origin.
- **Astro island children:** guarded pages compose everything inside ONE React island (`AccountPage`/`DevelopersPage`) so `AuthGate`/`ToastProvider` context works — don't split them across separate `client:load` directives.
- **`pre` blocks + `code`** carrying secrets/tokens use `className="mono" data-case="preserve"` so lowercase transform never mangles them.
- If `astro check` flags the `Footer`/`AppHeader` server-render (no `client:` directive on `Footer`), that's intended — `Footer` is static; only `SiteHeader`/page islands hydrate.
