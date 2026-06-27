import { useEffect, useState } from "react";
import { getPending, postConsent, type PendingResponse } from "../lib/authApi";

const SCOPE_LABELS: Record<string, string> = {
  openid: "your account identifier",
  profile: "your username, display name and avatar",
  telegram: "your linked Telegram account",
  verified: "whether your account is verified",
  offline_access: "stay signed in (refresh access)",
};

export default function ConsentForm({ base }: { base: string }) {
  const [pending, setPending] = useState<PendingResponse | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPending(base)
      .then((p) => {
        if (p.error === "no_session") setError("no_session");
        else if (p.error) setError("No pending authorization request.");
        else {
          setPending(p);
          setSelected(p.scope ?? []); // all requested scopes checked by default
        }
      })
      .catch(() => setError("network"));
  }, [base]);

  function toggle(s: string) {
    if (s === "openid") return; // required
    setSelected((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  }

  async function decide(decision: "allow" | "deny") {
    if (!pending?.csrf) return;
    setBusy(true);
    try {
      const res = await postConsent(base, decision, pending.csrf, decision === "allow" ? selected : undefined);
      if (res.redirect) window.location.href = res.redirect;
      else setError(res.error ?? "Could not complete the request.");
    } catch {
      setError("network");
    }
    setBusy(false);
  }

  if (error === "no_session") {
    return (
      <p role="alert" className="error">
        Please <a href="/login">sign in</a> to continue.
      </p>
    );
  }
  if (error) return <p role="alert" className="error">{error === "network" ? "Network error." : error}</p>;
  if (!pending) return <p>Loading…</p>;

  return (
    <div className="consent">
      <h1>Authorize {pending.client?.name}</h1>
      <p><strong>{pending.client?.name}</strong> is requesting access to your Meowerse account. Choose what to share:</p>
      <ul className="scopes">
        {pending.scope?.map((s) => (
          <li key={s}>
            <label className="inline">
              <input type="checkbox" checked={selected.includes(s)} disabled={s === "openid" || busy} onChange={() => toggle(s)} />{" "}
              {SCOPE_LABELS[s] ?? s}
              {s === "openid" && <span className="muted"> (required)</span>}
            </label>
          </li>
        ))}
      </ul>
      <div className="actions">
        <button disabled={busy} onClick={() => decide("allow")}>Allow</button>
        <button disabled={busy} onClick={() => decide("deny")} className="secondary">Deny</button>
      </div>
    </div>
  );
}
