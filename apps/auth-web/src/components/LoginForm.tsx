import { useState, type FormEvent } from "react";
import { Button, Field, Alert, clearSessionCache } from "@meowerse/ui";
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
      if (res.ok) { clearSessionCache(); window.location.href = nextLocation(res.next); }
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
