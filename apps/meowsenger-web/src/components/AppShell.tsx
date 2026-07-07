import { useEffect, useState } from "react";
import { getSession, loginUrl, type SessionInfo } from "../lib/meowsengerApi";

export default function AppShell({ base }: { base: string }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  useEffect(() => { getSession(base).then(setSession); }, [base]);

  if (session === null) return <div className="mw-gate">loading…</div>;
  if (!session.authenticated) {
    window.location.href = loginUrl(base);
    return <div className="mw-gate">redirecting to login…</div>;
  }
  return (
    <div className="mw-stack">
      <h1>welcome, {session.user?.username}</h1>
      <p className="mw-muted">your chats will appear here. (realtime lands in slice 2.)</p>
    </div>
  );
}
