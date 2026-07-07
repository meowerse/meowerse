import { useEffect, useState } from "react";
import { getSession, loginUrl, logoutUrl, type SessionInfo } from "../lib/meowsengerApi";

/** Forked header for meowsenger (the @meowerse/ui Footer/AppHeader are auth-app
 *  specific). Uses design-system mw- classes + tokens. */
export default function MeowsengerHeader({ base }: { base: string }) {
  const [session, setSession] = useState<SessionInfo>({ authenticated: false });
  useEffect(() => { getSession(base).then(setSession); }, [base]);

  async function onLogout() {
    await fetch(logoutUrl(base), { method: "POST", credentials: "include" });
    window.location.href = "/";
  }

  return (
    <header className="mw-row" style={{ padding: "var(--space-3) var(--space-gutter)", alignItems: "center" }}>
      <a href="/" className="mono" style={{ fontFamily: "var(--font-display)", fontSize: "var(--text-lg)" }}>
        meowsenger
      </a>
      {session.authenticated ? (
        <span className="mw-row" style={{ gap: "var(--space-2)", alignItems: "center" }}>
          <span className="mw-muted">{session.user?.username}</span>
          <button className="mw-btn mw-btn--sm" onClick={onLogout}>log out</button>
        </span>
      ) : (
        <a className="mw-btn mw-btn--sm" href={loginUrl(base)}>log in</a>
      )}
    </header>
  );
}
