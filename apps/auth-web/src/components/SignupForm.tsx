import { useState } from "react";
import { postSignup, nextLocation, type NextStep } from "../lib/authApi";

type Submit = { preventDefault: () => void };

export default function SignupForm({ base }: { base: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [next, setNext] = useState<NextStep | undefined>(undefined);

  async function onSubmit(e: Submit) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await postSignup(base, username, password);
      if (res.ok) {
        setCodes(res.recoveryCodes ?? []);
        setNext(res.next);
      } else {
        setError(errorText(res.error));
      }
    } catch {
      setError("Network error — please try again.");
    }
    setBusy(false);
  }

  if (codes) {
    return (
      <div className="recovery">
        <h2>Save your recovery codes</h2>
        <p>These are shown once. Store them somewhere safe — each works a single time if you lose access.</p>
        <ul>{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
        <button onClick={() => (window.location.href = nextLocation(next))}>I’ve saved them — continue</button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="auth-form">
      <label>
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required minLength={3} maxLength={32} />
      </label>
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={12} />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
    </form>
  );
}

function errorText(error: string | undefined): string {
  if (error === "unavailable") return "That username is taken.";
  if (error === "rate_limited") return "Too many attempts — try again later.";
  if (error?.includes("password")) return "Password must be 12–128 characters.";
  if (error?.includes("username")) return "Usernames are 3–32 letters, numbers, or underscores.";
  return error ?? "Sign-up failed.";
}
