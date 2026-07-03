import { useEffect, useState } from "react";
import { Button, Checkbox, Card, Alert, Spinner } from "@meowerse/ui";
import { getPending, postConsent, type PendingResponse } from "../lib/authApi";

const SCOPE_LABELS: Record<string, string> = {
  openid: "your account identifier",
  profile: "your username, display name and avatar",
  telegram: "your linked telegram account",
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
        else if (p.error) setError("no pending authorization request.");
        else { setPending(p); setSelected(p.scope ?? []); }
      })
      .catch(() => setError("network"));
  }, [base]);

  function toggle(s: string) {
    if (s === "openid") return;
    setSelected((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  }

  async function decide(decision: "allow" | "deny") {
    if (!pending?.csrf) return;
    setBusy(true);
    try {
      const res = await postConsent(base, decision, pending.csrf, decision === "allow" ? selected : undefined);
      if (res.redirect) window.location.href = res.redirect;
      else setError(res.error ?? "could not complete the request.");
    } catch { setError("network"); }
    setBusy(false);
  }

  if (error === "no_session") return <Alert variant="error">please <a href="/login">sign in</a> to continue.</Alert>;
  if (error) return <Alert variant="error">{error === "network" ? "network error." : error}</Alert>;
  if (!pending) return <div className="mw-stack"><Spinner label="loading request" /></div>;

  return (
    <Card title={`authorize ${pending.client?.name}`} className="mw-narrow">
      <p className="mw-muted"><strong>{pending.client?.name}</strong> is requesting access to your meowerse account. choose what to share:</p>
      <div className="mw-stack" style={{ margin: "var(--gap-md) 0" }}>
        {pending.scope?.map((s) => (
          <Checkbox key={s} label={`${SCOPE_LABELS[s] ?? s}${s === "openid" ? " (required)" : ""}`}
            checked={selected.includes(s)} disabled={s === "openid" || busy} onChange={() => toggle(s)} />
        ))}
      </div>
      <div style={{ display: "flex", gap: "var(--gap-sm)" }}>
        <Button variant="primary" disabled={busy} onClick={() => decide("allow")}>allow</Button>
        <Button variant="secondary" disabled={busy} onClick={() => decide("deny")}>deny</Button>
      </div>
    </Card>
  );
}
