import { useEffect, useState } from "react";
import { getSession, loginUrl, logoutUrl, type SessionInfo } from "../lib/meowsengerApi";
import { Avatar } from "./Avatar";
import Settings from "./Settings";

/** Forked header for meowsenger (the @meowerse/ui Footer/AppHeader are auth-app
 *  specific). Uses design-system mw- classes + tokens. Slice 7 adds a settings
 *  button (auth only) that opens the account-privacy modal. */
export default function MeowsengerHeader({ base }: { base: string }) {
  const [session, setSession] = useState<SessionInfo>({ authenticated: false });
  const [settingsOpen, setSettingsOpen] = useState(false);
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
        <span className="mw-row" style={{ gap: "var(--space-2)", alignItems: "center", flexWrap: "nowrap" }}>
          <Avatar url={session.user?.avatarUrl} name={session.user?.displayName || session.user?.username} size="sm" />
          <span className="mw-muted" data-case="preserve">{session.user?.username}</span>
          <button className="mw-btn mw-btn--ghost mw-btn--sm" onClick={() => setSettingsOpen(true)}>settings</button>
          <button className="mw-btn mw-btn--ghost mw-btn--sm" onClick={onLogout}>log out</button>
          <Settings base={base} open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        </span>
      ) : (
        <a className="mw-btn mw-btn--primary mw-btn--sm" href={loginUrl(base)}>log in</a>
      )}
    </header>
  );
}
