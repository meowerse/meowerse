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
