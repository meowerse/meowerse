import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Field, Card, Checkbox, RadioGroup, Code, Alert, ConfirmDialog, useToast, Skeleton, StatusLine, clearSessionCache } from "@meowerse/ui";
import { listClients, createClient, deleteClient, rotateClientSecret, updateClient, postManagementToken, type ClientSummary } from "../lib/authApi";

const SCOPE_OPTIONS = ["openid", "profile", "telegram", "verified", "offline_access"];

/** One app row's height: the 36px small buttons set it, so the loading, empty and one-app states all occupy the same box. */
const APPS_ROW_MIN = 36;

export default function Dashboard({ base }: { base: string }) {
  const toast = useToast();
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [csrf, setCsrf] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false); // the last (re)load failed: shown honestly, while any loaded data stays on screen
  const [signedOut, setSignedOut] = useState(false);
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
  const [offline, setOffline] = useState(false);
  const [scopes, setScopes] = useState<string[]>(["openid", "profile"]);

  const seq = useRef(0); // reload counter: only the latest request's answer may change state (a late 200 must not undo a newer 401)
  const loadedRef = useRef(false);
  loadedRef.current = loaded;
  const [refreshing, setRefreshing] = useState(false);

  /** Everything that belongs to the signed-in account: dropped when it is gone or may be a different one. */
  function resetAccountState() {
    setClients([]); setCsrf(""); setCreated(null); setRotated(null); setMgmtToken(null); setToDelete(null); setLoaded(false);
  }

  function reload() {
    const mine = ++seq.current;
    setRefreshing(true);
    if (!loadedRef.current) setLoadError(false); // a refresh keeps the apps (and any error banner) on screen until the new answer arrives
    listClients(base).then((r) => {
      if (mine !== seq.current) return;
      setRefreshing(false);
      if (r.error === "no_session") {
        // Signed out (or switched): nothing from the previous account stays on screen, and the shared session cache is dropped.
        clearSessionCache();
        resetAccountState(); setSignedOut(true);
      } else if (r.error) setLoadError(true);
      else { setClients(r.clients ?? []); setCsrf(r.csrf ?? ""); setLoaded(true); setLoadError(false); setSignedOut(false); }
    }).catch(() => { if (mine === seq.current) { setRefreshing(false); setLoadError(true); } });
  }
  useEffect(reload, [base]);

  // bfcache restore may show a page from before a sign-out/switch: drop everything shown and ask the server again.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) { resetAccountState(); setLoadError(false); setSignedOut(false); reloadRef.current(); } };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  function toggleScope(s: string) { setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s])); }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(""); setBusy(true);
    const r = await createClient(base, { csrf, name, display_name: displayName || undefined, client_type: clientType, redirect_uris: redirect, scopes: scopes.join(" "), verified_only: verifiedOnly ? "true" : "false", offline: offline ? "true" : "false" });
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

  async function onToggleOffline(c: ClientSummary) {
    const next = !c.allowOfflineAccess;
    const r = await updateClient(base, { csrf, client_id: c.clientId, offline: next ? "true" : "false" });
    if (r.ok) setClients((cur) => cur.map((x) => (x.clientId === c.clientId ? { ...x, allowOfflineAccess: next } : x)));
    else toast({ message: "could not update the app", variant: "error" });
  }

  async function onMgmtToken() { const r = await postManagementToken(base, csrf); if (r.token) setMgmtToken(r.token); }

  if (signedOut) return <Alert variant="error">please <a href="/login?next=%2Fdevelopers">sign in</a> to manage your apps.</Alert>;
  if (!loaded && loadError) {
    return (
      <StatusLine state="fail" action={<Button size="sm" variant="secondary" onClick={reload} disabled={refreshing}>try again</Button>}>couldn't load your apps.</StatusLine>
    );
  }

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

      {loaded && loadError && (
        <StatusLine state="fail" action={<Button size="sm" variant="secondary" onClick={reload} disabled={refreshing}>try again</Button>}>couldn't refresh your apps. showing what we last loaded.</StatusLine>
      )}
      <Card title="your apps">
        <div className="mw-apps-slot">
        {!loaded ? <div role="status" aria-label="loading your apps"><Skeleton height={APPS_ROW_MIN} /></div> : clients.length === 0 ? <p className="mw-muted" style={{ margin: 0 }}>no apps yet.</p> : (
          <div className="mw-stack">
            {clients.map((c) => (
              <div key={c.clientId} className="mw-row">
                <span><strong>{c.displayName ?? c.name}</strong> — <code className="mono" data-case="preserve">{c.clientId}</code> ({c.clientType}{c.verifiedOnly ? ", verified-only" : ""}) · {c.allowedScopes.join(", ")}</span>
                <span style={{ display: "flex", gap: "var(--gap-sm)", flexWrap: "wrap" }}>
                  {c.clientType === "confidential" && <Button size="sm" variant="secondary" onClick={() => onRotate(c.clientId)}>rotate secret</Button>}
                  <Button size="sm" variant="secondary" aria-pressed={!!c.allowOfflineAccess} onClick={() => onToggleOffline(c)}>{c.allowOfflineAccess ? "refresh tokens: on" : "refresh tokens: off"}</Button>
                  <Button size="sm" variant="danger" onClick={() => setToDelete(c)}>delete</Button>
                </span>
              </div>
            ))}
          </div>
        )}
        </div>
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
          <Checkbox label="allow refresh tokens (needed for the offline_access scope)" checked={offline} onChange={(e) => setOffline(e.target.checked)} />
          <Checkbox label="only verified users may authorize" checked={verifiedOnly} onChange={(e) => setVerifiedOnly(e.target.checked)} />
          {error && <Alert variant="error">{error}</Alert>}
          <Button variant="primary" type="submit" loading={busy} disabled={!loaded}>create app</Button>
        </form>
      </Card>

      <Card title="config-as-code (iac)">
        <p className="mw-muted">mint a management token to provision apps from <code className="mono" data-case="preserve">auth.config.ts</code> with <code className="mono" data-case="preserve">@meowerse/auth</code>.</p>
        <Button variant="secondary" onClick={onMgmtToken} disabled={!loaded}>generate management token</Button>
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
  if (error === "reserved_name") return "that name is reserved for meowerse apps. pick a different name.";
  if (error === "invalid_name") return "name must be 3–40 lowercase letters/numbers/hyphens.";
  if (error === "invalid_redirect_uri") return "redirect uri must be https (or http loopback) with no fragment.";
  if (error === "redirect_uri_required") return "a redirect uri is required.";
  return error ?? "could not create the app.";
}
