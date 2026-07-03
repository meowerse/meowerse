import { useEffect, useState, type FormEvent } from "react";
import { Button, Field, Card, Badge, Alert, RecoveryCodes, ConfirmDialog, useToast, Spinner, clearSessionCache } from "@meowerse/ui";
import { getAccount, postAccountPassword, getGrants, revokeGrant, unlinkTelegram, regenerateRecoveryCodes, deleteAccount, type AccountInfo, type Grant } from "../lib/authApi";

export default function AccountSettings({ base }: { base: string }) {
  const toast = useToast();
  const [acct, setAcct] = useState<AccountInfo | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [error, setError] = useState("");
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState<null | { kind: "revoke" | "unlink" | "regen" | "delete"; clientId?: string }>(null);
  const [busy, setBusy] = useState(false);

  function reload() {
    getAccount(base).then((a) => { if (a.error === "no_session") setError("no_session"); else setAcct(a); }).catch(() => setError("network"));
    getGrants(base).then((g) => setGrants(g.grants ?? [])).catch(() => {});
  }
  useEffect(reload, [base]);

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    if (!acct) return;
    const r = await postAccountPassword(base, acct.csrf, cur, next);
    if (r.ok) { toast({ message: "password changed", variant: "success" }); setCur(""); setNext(""); }
    else toast({ message: r.error === "wrong_password" ? "current password is wrong" : "could not change password", variant: "error" });
  }

  async function runConfirm(password?: string) {
    if (!acct || !confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === "revoke" && confirm.clientId) {
        await revokeGrant(base, acct.csrf, confirm.clientId);
        setGrants((g) => g.filter((x) => x.clientId !== confirm.clientId));
        toast({ message: "access revoked", variant: "success" });
      } else if (confirm.kind === "unlink") {
        const r = await unlinkTelegram(base, acct.csrf);
        if (r.ok) { clearSessionCache(); toast({ message: "telegram unlinked", variant: "success" }); reload(); }
        else toast({ message: "set a password first — unlinking would lock you out", variant: "error" });
      } else if (confirm.kind === "regen") {
        const r = await regenerateRecoveryCodes(base, acct.csrf);
        if (r.recoveryCodes) { setCodes(r.recoveryCodes); toast({ message: "recovery codes regenerated", variant: "success" }); }
      } else if (confirm.kind === "delete") {
        const r = await deleteAccount(base, acct.csrf, acct.username ?? acct.displayName ?? "");
        if (r.ok) { clearSessionCache(); window.location.href = "/"; }
        else toast({ message: "could not delete account", variant: "error" });
      }
    } finally { setBusy(false); setConfirm(null); }
  }

  if (error === "no_session") return <Alert variant="error">please <a href="/login">sign in</a> to manage your account.</Alert>;
  if (!acct) return <div className="mw-stack"><Spinner label="loading account" /></div>;

  return (
    <div className="mw-stack">
      <h1>account</h1>
      <p style={{ display: "flex", alignItems: "center", gap: "var(--gap-sm)", flexWrap: "wrap" }}>
        <strong>{acct.username ?? acct.displayName ?? "telegram account"}</strong>
        {acct.verified ? <Badge variant="verified" icon="rosette-discount-check">verified</Badge> : <Badge>unverified</Badge>}
      </p>

      <Card title="telegram">
        {acct.telegram.linked ? (
          <p>linked{acct.telegram.username ? ` as @${acct.telegram.username}` : ""}. <Button size="sm" variant="secondary" onClick={() => setConfirm({ kind: "unlink" })}>unlink</Button></p>
        ) : (
          <p>not linked. <a href="/verify"><Button size="sm" variant="secondary">verify with telegram</Button></a></p>
        )}
      </Card>

      {acct.hasPassword && (
        <Card title="change password">
          <form onSubmit={changePassword} className="mw-stack">
            <Field label="current password" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />
            <Field label="new password" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={12} required />
            <Button variant="primary" type="submit">update password</Button>
          </form>
        </Card>
      )}

      <Card title="connected apps">
        {grants.length === 0 ? <p className="mw-muted">no apps have access.</p> : (
          <div className="mw-stack">
            {grants.map((g) => (
              <div key={g.clientId} className="mw-row">
                <span><code className="mono" data-case="preserve">{g.clientId}</code> — {g.approvedScopes.join(", ")}</span>
                <Button size="sm" variant="danger" onClick={() => setConfirm({ kind: "revoke", clientId: g.clientId })}>revoke</Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="recovery codes">
        <p>{acct.recoveryRemaining} unused. <Button size="sm" variant="secondary" onClick={() => setConfirm({ kind: "regen" })}>regenerate</Button></p>
        {codes && <div style={{ marginTop: "var(--gap-md)" }}><p className="mw-muted">new codes (shown once — save them):</p><RecoveryCodes codes={codes} /></div>}
      </Card>

      <Card title="danger zone">
        <p className="mw-muted">deleting your account is permanent and removes all your data and apps.</p>
        <Button variant="danger" onClick={() => setConfirm({ kind: "delete" })}>delete account</Button>
      </Card>

      <p><a href="/logout" onClick={() => clearSessionCache()}><Button variant="secondary">sign out</Button></a></p>

      <ConfirmDialog open={confirm?.kind === "revoke"} onCancel={() => setConfirm(null)} onConfirm={() => runConfirm()}
        title="revoke access?" description="the app will immediately lose access to your account. you can re-authorize any time."
        confirmLabel="revoke access" variant="danger" loading={busy} />
      <ConfirmDialog open={confirm?.kind === "unlink"} onCancel={() => setConfirm(null)} onConfirm={() => runConfirm()}
        title="unlink telegram?" description="you'll lose your verified status and telegram sign-in." confirmLabel="unlink" variant="danger" loading={busy} />
      <ConfirmDialog open={confirm?.kind === "regen"} onCancel={() => setConfirm(null)} onConfirm={() => runConfirm()}
        title="regenerate recovery codes?" description="your current recovery codes stop working immediately." confirmLabel="regenerate" variant="danger" loading={busy} />
      <ConfirmDialog open={confirm?.kind === "delete"} onCancel={() => setConfirm(null)} onConfirm={() => runConfirm()}
        title="delete your account?" description="this is permanent. all your data, connected apps, and owned apps are erased."
        confirmLabel="delete account" variant="danger" confirmPhrase={acct.username ?? acct.displayName ?? ""} loading={busy} />
    </div>
  );
}
