import { useEffect, useState } from "react";
import {
  getAccount,
  postAccountPassword,
  getGrants,
  revokeGrant,
  unlinkTelegram,
  regenerateRecoveryCodes,
  type AccountInfo,
  type Grant,
} from "../lib/authApi";

type Submit = { preventDefault: () => void };

export default function AccountSettings({ base }: { base: string }) {
  const [acct, setAcct] = useState<AccountInfo | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);

  function reload() {
    getAccount(base)
      .then((a) => {
        if (a.error === "no_session") setError("no_session");
        else setAcct(a);
      })
      .catch(() => setError("network"));
    getGrants(base).then((g) => setGrants(g.grants ?? [])).catch(() => {});
  }
  useEffect(reload, [base]);

  async function changePassword(e: Submit) {
    e.preventDefault();
    setError("");
    setMsg("");
    const r = await postAccountPassword(base, acct!.csrf, cur, next);
    if (r.ok) {
      setMsg("Password changed.");
      setCur("");
      setNext("");
    } else {
      setError(r.error === "wrong_password" ? "Current password is wrong." : r.error?.includes("password") ? "New password must be 12–128 chars." : "Could not change password.");
    }
  }

  async function revoke(clientId: string) {
    if (!acct) return;
    await revokeGrant(base, acct.csrf, clientId);
    setGrants((g) => g.filter((x) => x.clientId !== clientId));
  }

  async function unlink() {
    if (!acct) return;
    const r = await unlinkTelegram(base, acct.csrf);
    if (r.ok) reload();
    else setError(r.error === "no_password_fallback" ? "Set a password first — unlinking Telegram would lock you out." : "Could not unlink.");
  }

  async function regen() {
    if (!acct) return;
    const r = await regenerateRecoveryCodes(base, acct.csrf);
    if (r.recoveryCodes) setCodes(r.recoveryCodes);
  }

  if (error === "no_session") {
    return (
      <p role="alert" className="error">
        Please <a href="/login">sign in</a> to manage your account.
      </p>
    );
  }
  if (!acct) return <p>Loading…</p>;

  return (
    <div className="account">
      <h1>Account</h1>
      <p>
        <strong>{acct.username ?? acct.displayName ?? "Telegram account"}</strong>{" "}
        {acct.verified ? <span className="badge ok">✓ Verified</span> : <span className="badge">Unverified</span>}
      </p>

      <section>
        <h2>Telegram</h2>
        {acct.telegram.linked ? (
          <p>
            Linked{acct.telegram.username ? ` as @${acct.telegram.username}` : ""}.{" "}
            <button className="secondary" onClick={unlink}>Unlink</button>
          </p>
        ) : (
          <p>Not linked. <a href="/verify"><button className="secondary">Verify with Telegram</button></a></p>
        )}
      </section>

      {acct.hasPassword && (
        <section>
          <h2>Change password</h2>
          <form onSubmit={changePassword} className="auth-form">
            <label>Current password<input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required /></label>
            <label>New password<input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={12} required /></label>
            <button type="submit">Update password</button>
          </form>
        </section>
      )}

      <section>
        <h2>Connected apps</h2>
        {grants.length === 0 ? (
          <p className="muted">No apps have access.</p>
        ) : (
          <ul>
            {grants.map((g) => (
              <li key={g.clientId}>
                <code>{g.clientId}</code> — {g.approvedScopes.join(", ")} <button className="secondary" onClick={() => revoke(g.clientId)}>Revoke</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Recovery codes</h2>
        <p>{acct.recoveryRemaining} unused. <button className="secondary" onClick={regen}>Regenerate</button></p>
        {codes && (
          <div className="recovery">
            <p>New codes (shown once — save them):</p>
            <ul>{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
          </div>
        )}
      </section>

      {msg && <p className="ok-msg" role="status">{msg}</p>}
      {error && error !== "no_session" && <p role="alert" className="error">{error === "network" ? "Network error." : error}</p>}

      <p><a href="/logout"><button className="secondary">Sign out</button></a></p>
    </div>
  );
}
