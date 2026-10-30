import { useEffect, useState } from "react";
import { getSession, loginUrl } from "../lib/meowsengerApi";
import { hasSessionEnded, subscribeSessionEnded } from "../lib/sessionEnded";
import Chat from "./Chat";

const RETRY_MS = 5_000;

type Gate = "loading" | "in" | "out" | "unreachable" | "ended";

/** Auth gate for /app. Redirects to login ONLY on a definitive 200 {authenticated:false}
 *  (the real guard is the worker session). A network error / timeout / 5xx keeps the
 *  app in a "can't reach meowsenger, retrying" state; a 401 (here or from any later
 *  read, via the sessionEnded signal) shows a "session ended" banner with a sign-in
 *  action and unmounts the chat so no sensitive content stays in memory. */
export default function AppShell({ base }: { base: string }) {
  const [gate, setGate] = useState<Gate>(hasSessionEnded() ? "ended" : "loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => subscribeSessionEnded(() => setGate("ended")), []);

  useEffect(() => {
    if (gate !== "loading" && gate !== "unreachable") return;
    let cancelled = false;
    let timer: number | undefined;
    void getSession(base).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setGate(r.data.authenticated ? "in" : "out");
      } else if (r.error.kind === "unauthorized") {
        setGate("ended");
      } else {
        setGate("unreachable");
        timer = window.setTimeout(() => setAttempt((n) => n + 1), RETRY_MS);
      }
    });
    return () => { cancelled = true; if (timer != null) window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, attempt]);

  // Redirect side-effect belongs in an effect, not the render body.
  useEffect(() => {
    if (gate === "out") window.location.replace(loginUrl(base));
  }, [gate, base]);

  if (gate === "ended") {
    return (
      <div className="mw-gate" role="alert">
        <p>your session ended. sign in again to keep going.</p>
        <a className="mw-btn mw-btn--primary" href={loginUrl(base)}>sign in</a>
      </div>
    );
  }
  if (gate === "unreachable") {
    return (
      <div className="mw-gate" role="status">
        <p>can't reach meowsenger. retrying…</p>
        <button className="mw-btn mw-btn--sm" onClick={() => setAttempt((n) => n + 1)}>retry now</button>
      </div>
    );
  }
  if (gate !== "in") return <div className="mw-gate">authenticating…</div>;
  return <Chat base={base} />;
}
