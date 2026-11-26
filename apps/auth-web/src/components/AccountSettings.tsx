import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Field, Card, Badge, Alert, RecoveryCodes, ConfirmDialog, useToast, Skeleton, StatusLine, clearSessionCache } from "@meowerse/ui";
import { getAccount, postAccountPassword, getGrants, revokeGrant, unlinkTelegram, regenerateRecoveryCodes, deleteAccount, startAccountDelete, wantsDeleteReauth, type AccountInfo, type Grant } from "../lib/authApi";

/**
 * What auth deletion does NOT do to the services you signed in to with meowerse (Meowsenger and any other app): nothing
 * links them, each keeps its own copy keyed by the old account id. Shown in the danger zone and in the confirm dialog.
 * Keep in sync with privacy.astro.
 */
export const CONNECTED_SERVICES_NOTICE =
  "this does not delete anything in the services you signed in to with meowerse (meowsenger or any other app): what you created there, like messages you sent, stays, and your profile, memberships and notification subscriptions there stay until you delete them in that service (in meowsenger: settings → danger zone → delete my meowsenger data). do that first: once your meowerse account is deleted you can't sign back in to those services to remove them. even then, content you already shared, like messages you sent, is not deleted.";

const ROW_H = 36; // the small buttons set a row's height; skeletons and one-line states reserve the same

/** The account page's shape while nothing is loaded (same cards and order as the loaded page for a password account; the deletion section is below the fold and appears with the data).
 *  The password card is the real form, disabled and inert, so its geometry is exact; min-height keeps the footer below the fold in tall viewports. */
function AccountSkeleton() {
  return (
    <div className="mw-stack" aria-busy="true" style={{ minHeight: "100svh" }}>
      <span role="status" aria-label="loading account" className="sr-only">loading account</span>
      <h1>account</h1>
      <p style={{ display: "flex", alignItems: "center", gap: "var(--gap-sm)", flexWrap: "wrap" }}>
        <Skeleton width="30%" height="1em" />
        <span style={{ visibility: "hidden" }}><Badge>unverified</Badge></span>
      </p>
      <Card title="telegram"><Skeleton height={ROW_H} /></Card>
      <Card title="change password">
        <div className="mw-stack" inert aria-hidden="true" style={{ opacity: 0.5 }}>
          <Field label="current password" type="password" disabled />
          <Field label="new password" type="password" disabled />
          <Button variant="primary" disabled>update password</Button>
        </div>
      </Card>
      <Card title="connected apps"><Skeleton height={ROW_H} /></Card>
      <Card title="recovery codes"><Skeleton height={ROW_H} /></Card>
    </div>
  );
}

export default function AccountSettings({ base }: { base: string }) {
  const toast = useToast();
  const [acct, setAcct] = useState<AccountInfo | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [grantsLoaded, setGrantsLoaded] = useState(false); // false until the first answer: "no apps have access" is only said when we know
  const [grantsFailed, setGrantsFailed] = useState(false); // the last grants (re)load failed; any loaded list stays on screen
  const [error, setError] = useState("");
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState<null | { kind: "revoke" | "unlink" | "regen" | "delete"; clientId?: string }>(null);
  const [busy, setBusy] = useState(false);
  const [needPassword, setNeedPassword] = useState(false); // server said our login is stale and this account has a password
  const [needTelegram, setNeedTelegram] = useState(false); // stale login on a Telegram-only account: sign in again

  const seq = useRef(0); // reload counter: only the latest request's answer may change state (a late 200 must not undo a newer 401)
  const acctRef = useRef(acct);
  acctRef.current = acct;
  const [refreshing, setRefreshing] = useState(false);

  /** Everything that belongs to one account: dropped whenever the account is gone or may be a different one. */
  function resetAccountState() {
    setAcct(null); setGrants([]); setGrantsLoaded(false); setGrantsFailed(false); setCodes(null); setConfirm(null);
    setNeedPassword(false); setNeedTelegram(false); setCur(""); setNext("");
  }

  function reload() {
    const mine = ++seq.current;
    setRefreshing(true);
    setGrantsFailed(false);
    if (!acctRef.current) setError(""); // a refresh keeps the account on screen (and any error banner) until the new answer arrives
    // Both answers are applied together, from the latest request only. Any other failure (a 404 once the account
    // behind a live session is gone, a 5xx) comes back as `{ error }` with none of the account's fields: it's an
    // error to show, never an account to render (`acct.telegram.linked` on it threw and blanked the whole page).
    Promise.allSettled([getAccount(base), getGrants(base)]).then(([ar, gr]) => {
      if (mine !== seq.current) return;
      setRefreshing(false);
      const aErr = ar.status === "rejected" ? "network" : ar.value.error;
      const gErr = gr.status === "rejected" ? "network" : gr.value.error;
      if (aErr === "no_session" || gErr === "no_session") {
        // Signed out (or switched): nothing from the previous account stays in state, and the shared session cache is dropped.
        clearSessionCache();
        resetAccountState(); setError("no_session");
        return;
      }
      if (aErr || ar.status === "rejected") { setError(aErr === "network" ? "network" : "failed"); return; }
      const a = ar.value;
      const prev = acctRef.current;
      // No stable account id comes back, so a changed name or CSRF token is treated as maybe-another-account: the previous
      // one's grants/codes/dialog must not survive next to it (a revoke would POST the new CSRF with the old client id).
      if (!prev || prev.username !== a.username || prev.displayName !== a.displayName || prev.avatarUrl !== a.avatarUrl || prev.csrf !== a.csrf) resetAccountState();
      setAcct(a); setError("");
      if (gErr || gr.status === "rejected") setGrantsFailed(true);
      else { setGrants(gr.value.grants ?? []); setGrantsLoaded(true); }
    });
  }
  useEffect(reload, [base]);

  // bfcache restore may show a page from before a sign-out/switch: drop everything shown and ask the server again.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) { resetAccountState(); setError(""); reloadRef.current(); } };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  // Back from "sign in again" (/login?reauth=delete → /account?reauth=delete): reopen the dialog once, then drop the marker.
  useEffect(() => {
    if (!acct?.deleteEnabled || !wantsDeleteReauth(window.location.search)) return;
    window.history.replaceState(null, "", window.location.pathname);
    setConfirm({ kind: "delete" });
  }, [acct?.deleteEnabled]);

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    if (!acct) return;
    const r = await postAccountPassword(base, acct.csrf, cur, next);
    if (r.ok) { toast({ message: "password changed", variant: "success" }); setCur(""); setNext(""); }
    else toast({ message: r.error === "wrong_password" ? "current password is wrong" : "could not change password", variant: "error" });
  }

  /** Delete flow: fresh-auth step-up (token), then the delete itself. Keeps the dialog open only when a password is needed/wrong. */
  async function runDelete(password?: string) {
    if (!acct) return;
    setBusy(true);
    let close = true;
    try {
      const st = await startAccountDelete(base, acct.csrf, password);
      if (!st.confirm_token) {
        if (st.error === "step_up_required" && st.reauth === "telegram") setNeedTelegram(true);
        else if (st.error === "step_up_required") { setNeedPassword(true); close = false; toast({ message: "enter your password to continue", variant: "error" }); }
        else if (st.error === "wrong_password") { close = false; toast({ message: "password is wrong", variant: "error" }); }
        else if (st.error === "rate_limited") toast({ message: "too many attempts — try again later", variant: "error" });
        else toast({ message: "could not delete account", variant: "error" });
        return;
      }
      const r = await deleteAccount(base, acct.csrf, acct.username ?? acct.displayName ?? "", st.confirm_token);
      if (r.ok) { clearSessionCache(); window.location.href = "/"; }
      else if (r.error === "owns_active_clients") toast({ message: "delete your apps in the developer dashboard first", variant: "error" });
      else if (r.error === "confirm_mismatch") toast({ message: "that doesn't match your username", variant: "error" });
      else if (r.error === "confirm_invalid") toast({ message: "the confirmation expired — try again", variant: "error" });
      else toast({ message: "could not delete account", variant: "error" });
    } catch {
      toast({ message: "could not delete account", variant: "error" });
    } finally {
      setBusy(false);
      if (close) { setConfirm(null); setNeedPassword(false); }
    }
  }

  async function runConfirm(password?: string) {
    if (!acct || !confirm) return;
    if (confirm.kind === "delete") return runDelete(password);
    setBusy(true);
    let close = true;
    /** Shared handling of a stale login on the fresh-auth actions; true = handled (dialog stays open when a password can fix it). */
    const stepUp = (error?: string, reauth?: string): boolean => {
      if (error === "step_up_required" && reauth === "password") { setNeedPassword(true); close = false; toast({ message: "enter your password to continue", variant: "error" }); return true; }
      if (error === "step_up_required") { toast({ message: "sign in again to continue", variant: "error" }); return true; }
      if (error === "wrong_password") { close = false; toast({ message: "password is wrong", variant: "error" }); return true; }
      if (error === "rate_limited") { toast({ message: "too many attempts — try again later", variant: "error" }); return true; }
      return false;
    };
    try {
      if (confirm.kind === "revoke" && confirm.clientId) {
        await revokeGrant(base, acct.csrf, confirm.clientId);
        setGrants((g) => g.filter((x) => x.clientId !== confirm.clientId));
        toast({ message: "access revoked", variant: "success" });
      } else if (confirm.kind === "unlink") {
        const r = await unlinkTelegram(base, acct.csrf, password);
        if (r.ok) { clearSessionCache(); toast({ message: "telegram unlinked", variant: "success" }); reload(); }
        else if (stepUp(r.error, r.reauth)) { /* handled */ }
        else toast({ message: "set a password first — unlinking would lock you out", variant: "error" });
      } else if (confirm.kind === "regen") {
        const r = await regenerateRecoveryCodes(base, acct.csrf, password);
        if (r.recoveryCodes) { setCodes(r.recoveryCodes); toast({ message: "recovery codes regenerated", variant: "success" }); }
        else stepUp(r.error, r.reauth);
      }
    } finally { setBusy(false); if (close) { setConfirm(null); setNeedPassword(false); } }
  }

  if (error === "no_session") return <Alert variant="error">please <a href="/login">sign in</a> to manage your account.</Alert>;
  if (!acct && (error === "failed" || error === "network")) {
    return (
      <StatusLine state="fail" action={<Button size="sm" variant="secondary" onClick={reload} disabled={refreshing}>try again</Button>}>
        {error === "network" ? "can't reach the account service." : "couldn't load your account."}
      </StatusLine>
    );
  }
  if (!acct) return <AccountSkeleton />;

  return (
    <div className="mw-stack">
      <h1>account</h1>
      {(error === "failed" || error === "network") && (
        <StatusLine state="fail" action={<Button size="sm" variant="secondary" onClick={reload} disabled={refreshing}>try again</Button>}>
          {error === "network" ? "can't reach the account service." : "couldn't refresh your account."} showing what we last loaded.
        </StatusLine>
      )}
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
        {!grantsLoaded ? (grantsFailed ? <p className="mw-muted">couldn't load your connected apps. <Button size="sm" variant="secondary" onClick={reload} disabled={refreshing}>try again</Button></p> : <div role="status" aria-label="loading connected apps"><Skeleton height={ROW_H} /></div>) : grants.length === 0 ? <p className="mw-muted" style={{ minHeight: ROW_H, margin: 0 }}>no apps have access.</p> : (
          <div className="mw-stack">
            {grants.map((g) => (
              <div key={g.clientId} className="mw-row">
                <span style={{ overflowWrap: "anywhere" }}>
                  {g.displayName ? <><strong data-case="preserve">{g.displayName}</strong>{" "}</> : null}
                  <code className={g.displayName ? "mono mw-muted" : "mono"} data-case="preserve">{g.clientId}</code> — {g.approvedScopes.join(", ")}
                </span>
                <Button size="sm" variant="danger" onClick={() => setConfirm({ kind: "revoke", clientId: g.clientId })}>revoke</Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {grantsFailed && grantsLoaded && <StatusLine state="fail" action={<Button size="sm" variant="secondary" onClick={reload} disabled={refreshing}>try again</Button>}>couldn't refresh your connected apps.</StatusLine>}
      <Card title="recovery codes">
        <p>{acct.recoveryRemaining} unused. <Button size="sm" variant="secondary" onClick={() => setConfirm({ kind: "regen" })}>regenerate</Button></p>
        {codes && <div style={{ marginTop: "var(--gap-md)" }}><p className="mw-muted">new codes (shown once — save them):</p><RecoveryCodes codes={codes} /></div>}
      </Card>

      <Card title="danger zone">
        {acct.deleteEnabled ? (
          <>
            <p className="mw-muted">deleting your meowerse account is permanent. it erases your meowerse login methods, sessions, app permissions and tokens.</p>
            <p className="mw-muted" data-testid="delete-services-notice">{CONNECTED_SERVICES_NOTICE}</p>
            <Button variant="danger" onClick={() => setConfirm({ kind: "delete" })}>delete account</Button>
            {needTelegram && (
              <Alert variant="error">
                for your security, sign in again before deleting your account. use the telegram account linked to {acct.username ?? acct.displayName ?? "this account"}.{" "}
                <a href="/login?reauth=delete"><Button size="sm" variant="secondary">sign in again with telegram</Button></a>
              </Alert>
            )}
          </>
        ) : (
          <p className="mw-muted">account deletion is handled on request for now: email <a href="mailto:privacy@alxnko.dev">privacy@alxnko.dev</a> with your username. we'll ask you to confirm from inside your account before deleting anything.</p>
        )}
      </Card>

      <p><a href="/logout" onClick={() => clearSessionCache()}><Button variant="secondary">sign out</Button></a></p>

      <ConfirmDialog open={confirm?.kind === "revoke"} onCancel={() => setConfirm(null)} onConfirm={() => runConfirm()}
        title="revoke access?" description={`${grants.find((x) => x.clientId === confirm?.clientId)?.displayName ?? "the app"} will immediately lose access to your account. you can re-authorize any time.`}
        confirmLabel="revoke access" variant="danger" loading={busy} />
      <ConfirmDialog open={confirm?.kind === "unlink"} onCancel={() => { setConfirm(null); setNeedPassword(false); }} onConfirm={(r) => runConfirm(r.password)} requirePassword={needPassword}
        title="unlink telegram?" description="you'll lose your verified status and telegram sign-in." confirmLabel="unlink" variant="danger" loading={busy} />
      <ConfirmDialog open={confirm?.kind === "regen"} onCancel={() => { setConfirm(null); setNeedPassword(false); }} onConfirm={(r) => runConfirm(r.password)} requirePassword={needPassword}
        title="regenerate recovery codes?" description="your current recovery codes stop working immediately." confirmLabel="regenerate" variant="danger" loading={busy} />
      {acct.deleteEnabled && (
        <ConfirmDialog open={confirm?.kind === "delete"} onCancel={() => { setConfirm(null); setNeedPassword(false); }} onConfirm={(r) => runConfirm(r.password)} requirePassword={needPassword}
          title="delete your account?" description={`this is permanent. your login methods, sessions, app permissions and tokens are erased. accounts with active apps can't be deleted until those apps are deleted in the developer dashboard. ${CONNECTED_SERVICES_NOTICE}`}
          confirmLabel="delete account" variant="danger" confirmPhrase={acct.username ?? acct.displayName ?? ""} loading={busy} />
      )}
    </div>
  );
}
