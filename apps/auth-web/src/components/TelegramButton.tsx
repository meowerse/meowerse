import { useRef, useState } from "react";
import { Button } from "@meowerse/ui";
import { tgStart, tgStatus, getAccount, postAuthLocation, type NextStep } from "../lib/authApi";

export default function TelegramButton({ base, kind, label }: { base: string; kind?: "VERIFY_EXISTING"; label?: string }) {
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [needPassword, setNeedPassword] = useState(false);
  const [password, setPassword] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function start() {
    setError("");
    let auth: { csrf: string; currentPassword?: string } | undefined;
    if (kind === "VERIFY_EXISTING") {
      // Linking is CSRF-protected and needs fresh authentication; the server decides (stale session → ask for the password).
      const acct = await getAccount(base).catch(() => null);
      if (!acct || !("csrf" in acct) || !acct.csrf) { setError("sign in again to verify your account."); return; }
      auth = { csrf: acct.csrf, ...(password ? { currentPassword: password } : {}) };
    }
    const res = await tgStart(base, kind, auth).catch(() => ({ error: "network" }) as { error: string; reauth?: string });
    if (res.error === "step_up_required" && res.reauth === "password") { setNeedPassword(true); setError("enter your password to continue."); return; }
    if (res.error === "wrong_password") { setNeedPassword(true); setError("that password isn't right."); return; }
    if (res.error === "rate_limited") { setError("too many attempts. try again later."); return; }
    if (!("deepLink" in res) || !res.deepLink || !res.ticketId) { setError("telegram sign-in isn't available right now."); return; }
    setLink(res.deepLink);
    const ticketId = res.ticketId;
    timer.current = setInterval(async () => {
      const s = await tgStatus(base, ticketId).catch(() => ({ ready: false }) as { ready: boolean; next?: NextStep });
      if (s.ready) { if (timer.current) clearInterval(timer.current); window.location.href = postAuthLocation(s.next, window.location.search); }
    }, 2000);
    setTimeout(() => timer.current && clearInterval(timer.current), 5 * 60 * 1000);
  }

  if (link) {
    return (
      <div className="mw-stack">
        <a href={link} target="_blank" rel="noreferrer noopener"><Button variant="primary">open telegram to confirm</Button></a>
        <p className="mw-muted">waiting for you to tap start in telegram…</p>
      </div>
    );
  }
  return (
    <div className="mw-stack">
      {needPassword && (
        <input type="password" autoComplete="current-password" aria-label="current password" value={password} onChange={(e) => setPassword(e.target.value)} />
      )}
      <Button variant="secondary" onClick={start}>{label ?? "continue with telegram"}</Button>
      {error && <p role="alert" style={{ color: "var(--text-danger)" }}>{error}</p>}
    </div>
  );
}
