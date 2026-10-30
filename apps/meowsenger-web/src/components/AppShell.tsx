import { useEffect, useRef, useState } from "react";
import { getSession, loginUrl } from "../lib/meowsengerApi";
import { getEndedSnapshot, hasSessionEnded, subscribeSessionEnded } from "../lib/sessionEnded";
import Chat from "./Chat";

const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 30_000;

/** Exponential backoff with jitter: 2s, 4s, 8s … capped at 30s, +/-20% jitter. */
function retryDelay(failures: number): number {
  const base = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** The "session ended" banner. Focus lands on the sign-in link. When the active
 *  composer held unsent text it is handed back here (in memory only, read-only,
 *  with copy); no other chat content is shown. */
function EndedBanner({ base }: { base: string }) {
  const snap = getEndedSnapshot();
  const linkRef = useRef<HTMLAnchorElement | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const [copied, setCopied] = useState<"" | "yes" | "no">("");
  useEffect(() => { linkRef.current?.focus(); }, []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(snap?.draft ?? "");
      setCopied("yes");
    } catch {
      // No clipboard permission: select the text so the user can copy it by hand.
      draftRef.current?.select();
      setCopied("no");
    }
  }
  return (
    <div className="mw-gate">
      <p role="alert">your session ended. sign in again to keep going.</p>
      {snap?.pendingSend && (
        <p className="mw-muted">a message may not have been sent — check after signing in.</p>
      )}
      {snap?.draft ? (
        <div className="mw-gate__draft">
          <label className="mw-muted" htmlFor="mw-ended-draft">your unsent message (not sent)</label>
          <textarea id="mw-ended-draft" ref={draftRef} className="mw-composer__input" readOnly rows={3} value={snap.draft} />
          <button type="button" className="mw-btn mw-btn--sm" onClick={() => { void copy(); }}>copy</button>
          {copied === "yes" && <span className="mw-muted" role="status">copied</span>}
          {copied === "no" && <span className="mw-muted" role="status">couldn't copy — the text is selected, copy it manually.</span>}
        </div>
      ) : null}
      <a ref={linkRef} className="mw-btn mw-btn--primary" href={loginUrl(base)}>sign in</a>
    </div>
  );
}

type Gate = "loading" | "in" | "out" | "unreachable" | "ended";

/** Auth gate for /app. Redirects to login ONLY on a definitive 200 {authenticated:false}
 *  (the real guard is the worker session). A network error / timeout / 5xx keeps the
 *  app in a "can't reach meowsenger, retrying" state; a 401 (here or from any later
 *  read, via the sessionEnded signal) shows a "session ended" banner with a sign-in
 *  action and unmounts the chat so no sensitive content stays in memory. */
export default function AppShell({ base }: { base: string }) {
  const [gate, setGate] = useState<Gate>(hasSessionEnded() ? "ended" : "loading");
  const [attempt, setAttempt] = useState(0);
  const failuresRef = useRef(0);

  useEffect(() => subscribeSessionEnded(() => setGate("ended")), []);

  useEffect(() => {
    if (gate !== "loading" && gate !== "unreachable") return;
    let cancelled = false;
    let timer: number | undefined;
    const clear = () => { if (timer != null) { window.clearTimeout(timer); timer = undefined; } };
    const retryNow = () => { clear(); if (!cancelled) setAttempt((n) => n + 1); };
    // Schedule the next attempt (backoff + jitter). While the tab is hidden nothing is
    // scheduled; becoming visible again retries immediately (see onVisible).
    const schedule = () => {
      clear();
      if (document.visibilityState === "hidden") return;
      timer = window.setTimeout(retryNow, retryDelay(failuresRef.current));
    };
    const onVisible = () => { if (document.visibilityState === "visible") retryNow(); };
    const onOnline = () => retryNow();
    void getSession(base).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        failuresRef.current = 0;
        setGate(r.data.authenticated ? "in" : "out");
      } else if (r.error.kind === "unauthorized") {
        setGate("ended");
      } else {
        failuresRef.current += 1;
        setGate("unreachable");
        schedule();
      }
    });
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      clear();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, attempt]);

  // Redirect side-effect belongs in an effect, not the render body.
  useEffect(() => {
    if (gate === "out") window.location.replace(loginUrl(base));
  }, [gate, base]);

  if (gate === "ended") return <EndedBanner base={base} />;
  if (gate === "unreachable") {
    return (
      <div className="mw-gate">
        <p role="status" aria-live="polite">can't reach meowsenger. retrying…</p>
        <button className="mw-btn mw-btn--sm" onClick={() => setAttempt((n) => n + 1)}>retry now</button>
      </div>
    );
  }
  if (gate !== "in") return <div className="mw-gate">authenticating…</div>;
  return <Chat base={base} />;
}
