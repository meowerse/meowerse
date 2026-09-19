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

  const isWaitingVerification = Boolean(turnstileSiteKey && !token);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (isWaitingVerification) {
      setError("just a moment — verifying you're human. try again.");
      return;
    }
    setError(""); setBusy(true);
    try {
      const res = await postLogin(base, username, password, token || undefined);
      if (res.ok) { clearSessionCache(); window.location.href = nextLocation(res.next); }
      else setError(loginError(res.error));
    } catch { setError("network error — please try again."); }
    setBusy(false);
  }

  function handleToken(t: string) {
    setToken(t);
    if (t && error.includes("verifying you're human")) {
      setError("");
    }
  }

  return (
    <form onSubmit={onSubmit} className="mw-stack mw-narrow">
      <Field label="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
      <Field label="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      <Turnstile
        siteKey={turnstileSiteKey}
        onToken={handleToken}
        onExpire={() => setError("verification expired — please solve the challenge again.")}
        onError={() => setError("verification failed to load — please refresh.")}
      />
      {error && <Alert variant="error">{error}</Alert>}
      <Button
        variant="primary"
        type="submit"
        loading={busy}
        disabled={isWaitingVerification}
        title={isWaitingVerification ? "verifying you're human..." : undefined}
      >
        {isWaitingVerification ? "verifying..." : "sign in"}
      </Button>
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
