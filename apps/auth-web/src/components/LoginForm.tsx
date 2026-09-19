import { useState, useRef, type FormEvent } from "react";
import { Button, Field, Alert, clearSessionCache } from "@meowerse/ui";
import { postLogin, nextLocation } from "../lib/authApi";
import Turnstile, { type TurnstileRef } from "./Turnstile";

export default function LoginForm({ base, turnstileSiteKey }: { base: string; turnstileSiteKey?: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [turnstileError, setTurnstileError] = useState(false);

  const turnstileRef = useRef<TurnstileRef>(null);
  const pendingSubmitRef = useRef(false);
  const waitTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  async function executeSubmit(activeToken: string) {
    setError("");
    setBusy(true);
    try {
      const res = await postLogin(base, username, password, activeToken || undefined);
      if (res.ok) {
        clearSessionCache();
        window.location.href = nextLocation(res.next);
      } else {
        setError(loginError(res.error));
        // Single-use token was consumed by siteverify; reset for the next attempt
        setToken("");
        turnstileRef.current?.reset();
      }
    } catch {
      setError("network error — please try again.");
      setToken("");
      turnstileRef.current?.reset();
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;

    // If Turnstile is active, token is still resolving, and no error occurred yet:
    // wait seamlessly for the token without rejecting the user.
    if (turnstileSiteKey && !token && !turnstileError) {
      setBusy(true);
      pendingSubmitRef.current = true;
      if (waitTimeoutRef.current) clearTimeout(waitTimeoutRef.current);
      waitTimeoutRef.current = setTimeout(() => {
        if (pendingSubmitRef.current) {
          pendingSubmitRef.current = false;
          setBusy(false);
          setError("verification timed out — please try again or check ad blockers.");
        }
      }, 8000);
      return;
    }

    executeSubmit(token);
  }

  function handleToken(t: string) {
    setToken(t);
    setTurnstileError(false);
    if (t && pendingSubmitRef.current) {
      pendingSubmitRef.current = false;
      if (waitTimeoutRef.current) clearTimeout(waitTimeoutRef.current);
      executeSubmit(t);
    }
  }

  function handleExpire() {
    setToken("");
    if (pendingSubmitRef.current) {
      pendingSubmitRef.current = false;
      if (waitTimeoutRef.current) clearTimeout(waitTimeoutRef.current);
      setBusy(false);
      setError("verification challenge expired — please try again.");
    }
  }

  function handleError() {
    setToken("");
    setTurnstileError(true);
    if (pendingSubmitRef.current) {
      pendingSubmitRef.current = false;
      if (waitTimeoutRef.current) clearTimeout(waitTimeoutRef.current);
      setBusy(false);
      setError("human verification failed to load — please check ad blockers or refresh.");
    }
  }

  const isVerifying = busy && pendingSubmitRef.current;

  return (
    <form onSubmit={onSubmit} className="mw-stack mw-narrow">
      <Field label="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
      <Field label="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      <Turnstile
        ref={turnstileRef}
        siteKey={turnstileSiteKey}
        onToken={handleToken}
        onExpire={handleExpire}
        onError={handleError}
      />
      {error && <Alert variant="error">{error}</Alert>}
      <Button
        variant="primary"
        type="submit"
        loading={busy}
      >
        {isVerifying ? "verifying..." : busy ? "signing in..." : "sign in"}
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
