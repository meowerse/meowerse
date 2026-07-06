import { useState, type FormEvent } from "react";
import { Button, Field, Alert, clearSessionCache } from "@meowerse/ui";
import { postLogin, nextLocation } from "../lib/authApi";
import Turnstile from "./Turnstile";

export default function LoginForm({ base, turnstileSiteKey }: { base: string; turnstileSiteKey?: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (turnstileSiteKey && !token) { setError("please complete the challenge below."); return; }
    setError(""); setBusy(true);
    try {
      const res = await postLogin(base, username, password, token || undefined);
      if (res.ok) { clearSessionCache(); window.location.href = nextLocation(res.next); }
      else setError(loginError(res.error));
    } catch { setError("network error — please try again."); }
    setBusy(false);
  }

  return (
    <form onSubmit={onSubmit} className="mw-stack mw-narrow">
      <Field label="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
      <Field label="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      <Turnstile siteKey={turnstileSiteKey} onToken={setToken} />
      {error && <Alert variant="error">{error}</Alert>}
      <Button variant="primary" type="submit" loading={busy}>sign in</Button>
      <p className="mw-muted">new here? <a href="/signup">create an account</a></p>
    </form>
  );
}

function loginError(error: string | undefined): string {
  if (error === "invalid_credentials") return "wrong username or password.";
  if (error === "turnstile_failed") return "challenge failed — please retry.";
  if (error === "rate_limited") return "too many attempts — try again later.";
  return error ?? "login failed.";
}
