import { useEffect, useState } from "react";
import { getPending, postConsent, type PendingResponse } from "../lib/authApi";

const SCOPE_LABELS: Record<string, string> = {
  openid: "your account identifier",
  profile: "your username, display name and avatar",
  telegram: "your linked Telegram account",
  verified: "whether your account is verified",
};

export default function ConsentForm({ base }: { base: string }) {
  const [pending, setPending] = useState<PendingResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPending(base)
      .then((p) => {
        if (p.error === "no_session") setError("Please sign in first.");
        else if (p.error) setError("No pending authorization request.");
        else setPending(p);
      })
      .catch(() => setError("Network error."));
  }, [base]);

  async function decide(decision: "allow" | "deny") {
    if (!pending?.csrf) return;
    setBusy(true);
    try {
      const res = await postConsent(base, decision, pending.csrf);
      if (res.redirect) window.location.href = res.redirect;
      else setError(res.error ?? "Could not complete the request.");
    } catch {
      setError("Network error.");
    }
    setBusy(false);
  }

  if (error) return <p role="alert" className="error">{error}</p>;
  if (!pending) return <p>Loading…</p>;

  return (
    <div className="consent">
      <h1>Authorize {pending.client?.name}</h1>
      <p><strong>{pending.client?.name}</strong> wants permission to access:</p>
      <ul>{pending.scope?.map((s) => <li key={s}>{SCOPE_LABELS[s] ?? s}</li>)}</ul>
      <div className="actions">
        <button disabled={busy} onClick={() => decide("allow")}>Allow</button>
        <button disabled={busy} onClick={() => decide("deny")} className="secondary">Deny</button>
      </div>
    </div>
  );
}
