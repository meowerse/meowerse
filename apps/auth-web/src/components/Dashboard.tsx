import { useEffect, useState } from "react";
import { listClients, createClient, type ClientSummary } from "../lib/authApi";

/** Minimal developer dashboard: list your apps and register a new one. */
export default function Dashboard({ base }: { base: string }) {
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [csrf, setCsrf] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ clientId: string; clientSecret?: string } | null>(null);

  const [name, setName] = useState("");
  const [redirect, setRedirect] = useState("");
  const [scopes, setScopes] = useState("openid profile");

  function reload() {
    listClients(base)
      .then((r) => {
        if (r.error === "no_session") setError("Please sign in to manage your apps.");
        else {
          setClients(r.clients ?? []);
          setCsrf(r.csrf ?? "");
        }
        setLoaded(true);
      })
      .catch(() => setError("Network error."));
  }
  useEffect(reload, [base]);

  async function onCreate(e: { preventDefault: () => void }) {
    e.preventDefault();
    setError("");
    const r = await createClient(base, { csrf, name, client_type: "public", redirect_uris: redirect, scopes });
    if (r.ok && r.clientId) {
      setCreated({ clientId: r.clientId, clientSecret: r.clientSecret });
      setName("");
      setRedirect("");
      reload();
    } else {
      setError(r.error ?? "Could not create the app.");
    }
  }

  if (error && !loaded) return <p role="alert" className="error">{error}</p>;

  return (
    <div>
      <h1>Your apps</h1>
      {created && (
        <div className="recovery">
          <p>App created — <code>{created.clientId}</code></p>
          {created.clientSecret && <p>Secret (shown once): <code>{created.clientSecret}</code></p>}
        </div>
      )}
      <ul>
        {clients.map((c) => (
          <li key={c.clientId}>
            <strong>{c.displayName ?? c.name}</strong> — <code>{c.clientId}</code> ({c.allowedScopes.join(", ")})
          </li>
        ))}
        {loaded && clients.length === 0 && <li className="muted">No apps yet.</li>}
      </ul>

      <h2>Register an app</h2>
      <form onSubmit={onCreate} className="auth-form">
        <label>Name (lowercase, e.g. my-app)<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>Redirect URI<input value={redirect} onChange={(e) => setRedirect(e.target.value)} placeholder="https://your.app/callback" required /></label>
        <label>Scopes<input value={scopes} onChange={(e) => setScopes(e.target.value)} /></label>
        {error && <p role="alert" className="error">{error}</p>}
        <button type="submit">Create app</button>
      </form>
    </div>
  );
}
