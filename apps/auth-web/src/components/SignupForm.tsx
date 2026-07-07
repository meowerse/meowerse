import { useState, type FormEvent } from "react";
import { Button, Field, Alert, Card, RecoveryCodes, clearSessionCache } from "@meowerse/ui";
import { postSignup, nextLocation, type NextStep } from "../lib/authApi";
import Turnstile from "./Turnstile";

export default function SignupForm({ base, turnstileSiteKey }: { base: string; turnstileSiteKey?: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [next, setNext] = useState<NextStep | undefined>(undefined);
  const [token, setToken] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (turnstileSiteKey && !token) { setError("just a moment — verifying you're human. try again."); return; }
    setError(""); setBusy(true);
    try {
      const res = await postSignup(base, username, password, token || undefined);
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
          <Button variant="primary" onClick={() => { clearSessionCache(); window.location.href = nextLocation(next); }}>i've saved them — continue</Button>
        </div>
      </Card>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mw-stack mw-narrow">
      <Field label="username" hint="3–32 letters, numbers, or underscores" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required minLength={3} maxLength={32} />
      <Field label="password" hint="12–128 characters" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={12} />
      <Turnstile siteKey={turnstileSiteKey} onToken={setToken} />
      {error && <Alert variant="error">{error}</Alert>}
      <Button variant="primary" type="submit" loading={busy}>create account</Button>
      <p className="mw-muted">already have one? <a href="/login">sign in</a></p>
    </form>
  );
}

function errorText(error: string | undefined): string {
  if (error === "unavailable") return "that username is taken.";
  if (error === "rate_limited") return "too many attempts — try again later.";
  if (error === "turnstile_failed") return "challenge failed — please retry.";
  if (error?.includes("password")) return "password must be 12–128 characters.";
  if (error?.includes("username")) return "usernames are 3–32 letters, numbers, or underscores.";
  return error ?? "sign-up failed.";
}
