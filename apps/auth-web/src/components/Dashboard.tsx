import { useEffect, useState } from "react";
import {
  listClients,
  createClient,
  deleteClient,
  rotateClientSecret,
  postManagementToken,
  type ClientSummary,
} from "../lib/authApi";

const SCOPE_OPTIONS = ["openid", "profile", "telegram", "verified", "offline_access"];

/** Developer dashboard: register + manage OAuth apps and mint an IaC management token. */
export default function Dashboard({ base }: { base: string }) {
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [csrf, setCsrf] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [noSession, setNoSession] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ clientId: string; clientSecret?: string } | null>(null);
  const [mgmtToken, setMgmtToken] = useState<string | null>(null);
  const [rotated, setRotated] = useState<{ clientId: string; secret: string } | null>(null);

  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [redirect, setRedirect] = useState("");
  const [clientType, setClientType] = useState<"public" | "confidential">("public");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [scopes, setScopes] = useState<string[]>(["openid", "profile"]);

  function reload() {
    listClients(base)
      .then((r) => {
        if (r.error === "no_session") setNoSession(true);
        else {
          setClients(r.clients ?? []);
          setCsrf(r.csrf ?? "");
        }
        setLoaded(true);
      })
      .catch(() => setError("Network error."));
  }
  useEffect(reload, [base]);

  function toggleScope(s: string) {
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  }

  async function onCreate(e: { preventDefault: () => void }) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const r = await createClient(base, {
      csrf,
      name,
      display_name: displayName || undefined,
      client_type: clientType,
      redirect_uris: redirect,
      scopes: scopes.join(" "),
      verified_only: verifiedOnly ? "true" : "false",
    });
    setBusy(false);
    if (r.ok && r.clientId) {
      setCreated({ clientId: r.clientId, clientSecret: r.clientSecret });
      setName("");
      setDisplayName("");
      setRedirect("");
      reload();
    } else {
      setError(errorText(r.error));
    }
  }

  async function onDelete(clientId: string) {
    if (!confirm(`Delete ${clientId}? This revokes all its access.`)) return;
    await deleteClient(base, csrf, clientId);
    setClients((c) => c.filter((x) => x.clientId !== clientId));
  }

  async function onRotate(clientId: string) {
    const r = await rotateClientSecret(base, csrf, clientId);
    if (r.clientSecret) setRotated({ clientId, secret: r.clientSecret });
    else setError("Only confidential apps have a secret to rotate.");
  }

  async function onMgmtToken() {
    const r = await postManagementToken(base, csrf);
    if (r.token) setMgmtToken(r.token);
  }

  if (noSession) {
    return (
      <p role="alert" className="error">
        Please <a href="/login">sign in</a> to manage your apps.
      </p>
    );
  }

  return (
    <div className="dashboard">
      <h1>Developer dashboard</h1>

      {created && (
        <div className="recovery">
          <p>App created: <code>{created.clientId}</code></p>
          {created.clientSecret ? (
            <p>API key / client secret (shown once — save it now): <code>{created.clientSecret}</code></p>
          ) : (
            <p className="muted">Public client — no secret (uses PKCE).</p>
          )}
        </div>
      )}
      {rotated && (
        <div className="recovery">
          <p>New secret for <code>{rotated.clientId}</code> (shown once): <code>{rotated.secret}</code></p>
        </div>
      )}

      <h2>Your apps</h2>
      <ul>
        {clients.map((c) => (
          <li key={c.clientId}>
            <strong>{c.displayName ?? c.name}</strong> — <code>{c.clientId}</code> ({c.clientType}
            {c.verifiedOnly ? ", verified-only" : ""}) · {c.allowedScopes.join(", ")}
            {" "}
            {c.clientType === "confidential" && <button className="secondary" onClick={() => onRotate(c.clientId)}>Rotate secret</button>}{" "}
            <button className="secondary" onClick={() => onDelete(c.clientId)}>Delete</button>
          </li>
        ))}
        {loaded && clients.length === 0 && <li className="muted">No apps yet.</li>}
      </ul>

      <h2>Register an app</h2>
      <form onSubmit={onCreate} className="auth-form">
        <label>Name (lowercase, e.g. my-app)<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>Display name<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="My App" /></label>
        <label>Redirect URI<input value={redirect} onChange={(e) => setRedirect(e.target.value)} placeholder="https://your.app/callback" required /></label>
        <fieldset>
          <legend>Type</legend>
          <label className="inline"><input type="radio" name="ct" checked={clientType === "public"} onChange={() => setClientType("public")} /> Public (SPA/mobile, PKCE)</label>
          <label className="inline"><input type="radio" name="ct" checked={clientType === "confidential"} onChange={() => setClientType("confidential")} /> Confidential (server, gets an API key)</label>
        </fieldset>
        <fieldset>
          <legend>Data the app may request</legend>
          {SCOPE_OPTIONS.map((s) => (
            <label key={s} className="inline">
              <input type="checkbox" checked={scopes.includes(s)} disabled={s === "openid"} onChange={() => toggleScope(s)} /> {s}
            </label>
          ))}
        </fieldset>
        <label className="inline"><input type="checkbox" checked={verifiedOnly} onChange={(e) => setVerifiedOnly(e.target.checked)} /> Only verified users may authorize</label>
        {error && <p role="alert" className="error">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create app"}</button>
      </form>

      <h2>Config-as-code (IaC)</h2>
      <p>Mint a management token to provision apps from <code>auth.config.ts</code> with <code>@meowerse/auth</code>.</p>
      <button className="secondary" onClick={onMgmtToken}>Generate management token</button>
      {mgmtToken && (
        <div className="recovery">
          <p>Management token (shown once): <code>{mgmtToken}</code></p>
          <pre>{`import { defineAuthClient } from "@meowerse/auth";
export default defineAuthClient({
  name: "my-app",
  redirectUris: ["https://your.app/callback"],
  scopes: ["openid", "profile"],
});`}</pre>
        </div>
      )}
    </div>
  );
}

function errorText(error: string | undefined): string {
  if (error === "name_taken") return "That app name is taken.";
  if (error === "invalid_name") return "Name must be 3–40 lowercase letters/numbers/hyphens.";
  if (error === "invalid_redirect_uri") return "Redirect URI must be https (or http loopback) with no fragment.";
  if (error === "redirect_uri_required") return "A redirect URI is required.";
  return error ?? "Could not create the app.";
}
