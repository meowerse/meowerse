import { useState } from "react";
import { postLogin, nextLocation } from "../lib/authApi";

type Submit = { preventDefault: () => void };

export default function LoginForm({ base }: { base: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: Submit) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await postLogin(base, username, password);
      if (res.ok) window.location.href = nextLocation(res.next);
      else setError(res.error === "invalid_credentials" ? "Wrong username or password." : res.error ?? "Login failed.");
    } catch {
      setError("Network error — please try again.");
    }
    setBusy(false);
  }

  return (
    <form onSubmit={onSubmit} className="auth-form">
      <label>
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
      </label>
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
