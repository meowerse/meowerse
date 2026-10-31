import { useEffect, useRef, useState } from "react";
import type { RequestResult } from "@meowerse/ui";
import { getSession, loginUrl, type SessionUser } from "../lib/meowsengerApi";
import { listChats, type ChatSummary } from "../lib/chat";
import { recordPushError } from "../lib/push";
import { getEndedSnapshot, hasSessionEnded, notifySessionEnded, resetSessionEnded, clearSessionEndedFlag, subscribeSessionEnded } from "../lib/sessionEnded";
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

/** The real shell's geometry with placeholder content (same grid, sidebar blocks and
 *  account dock as ChatSidebar; the log pane is empty). Purely decorative: aria-busy
 *  with one polite "loading" note and nothing announced as loaded. */
function BootSkeleton() {
  return (
    <div className="mw-chat mw-bootskel" data-open="0" aria-busy="true">
      <p className="mw-sr-only" role="status">loading meowsenger…</p>
      <aside className="mw-chat__side" aria-hidden="true">
        <div className="mw-chat__new">
          {/* Real (disabled, blank) controls so the header block has the exact real height
              at every breakpoint, incl. the mobile row layout and coarse-pointer sizes. */}
          <button type="button" className="mw-btn mw-btn--primary mw-btn--md mw-chat__newbtn mw-bootskel__ctl" disabled tabIndex={-1}>&nbsp;</button>
          <input type="search" className="mw-input mw-side__search mw-bootskel__ctl" disabled tabIndex={-1} />
        </div>
        <div className="mw-chat__list">
          <div className="mw-skel-list">
            {[0, 1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="mw-skelrow">
                <span className="mw-skel mw-skel--avatar" />
                <span className="mw-skelrow__body">
                  <span className="mw-skel mw-skel--line mw-skel--w60" />
                  <span className="mw-skel mw-skel--line mw-skel--w80" />
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="mw-chat__account">
          <span className="mw-chatrow__avatar"><span className="mw-avatar mw-avatar--sm mw-skel" /></span>
          <span className="mw-chat__account-info">
            <span className="mw-skel mw-skel--line mw-skel--w60" />
          </span>
        </div>
      </aside>
      <section className="mw-chat__main" aria-hidden="true">
        <div className="mw-chat__empty" />
      </section>
    </div>
  );
}

/** What AppShell hands Chat: the one session read and the list fetched in parallel with it. */
interface Boot { user: SessionUser; chats: RequestResult<ChatSummary[]> }

type Gate = "loading" | "in" | "out" | "unreachable" | "ended";

/** Auth gate for /app. Redirects to login ONLY on a definitive 200 {authenticated:false}
 *  (the real guard is the worker session). A network error / timeout / 5xx keeps the
 *  app in a "can't reach meowsenger, retrying" state; a 401 (here or from any later
 *  read, via the sessionEnded signal) shows a "session ended" banner with a sign-in
 *  action and unmounts the chat so no sensitive content stays in memory. */
export default function AppShell({ base }: { base: string }) {
  const [gate, setGate] = useState<Gate>(hasSessionEnded() ? "ended" : "loading");
  const [attempt, setAttempt] = useState(0);
  const [boot, setBoot] = useState<Boot | null>(null);
  const failuresRef = useRef(0);
  // The account whose data is currently held in memory (survives the gate changing, so a
  // bfcache restore can tell "same user" from "someone else signed in meanwhile").
  const heldUserRef = useRef<string | null>(null);
  const pageshowSeqRef = useRef(0);
  const gateRef = useRef<Gate>(gate);
  gateRef.current = gate;

  useEffect(() => subscribeSessionEnded(() => setGate("ended")), []);

  // bfcache restore: the frozen page may show a user who has since signed out or been
  // replaced. Re-check the session (same shape as auth-web's useSession pageshow).
  // Same user -> keep everything, quietly. Different user -> drop ALL in-memory
  // app state (unmounting Chat drops its chats, active chat, conversation, drafts and
  // sockets), then boot again for whoever is signed in now. A network/5xx error keeps the
  // current state: only a definitive answer changes anything. Signed out while we hold or
  // held a session raises the session-ended banner (draft kept), never a wipe/redirect.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      const seq = ++pageshowSeqRef.current;
      void getSession(base).then((r) => {
        if (seq !== pageshowSeqRef.current) return;
        if (!r.ok) {
          if (r.error.kind === "unauthorized") notifySessionEnded();
          return;
        }
        const nowId = r.data.authenticated ? (r.data.user?.id ?? null) : null;
        const held = heldUserRef.current;
        if (!r.data.authenticated) {
          // Definitive signed-out. If we hold (or held) a session, never wipe or
          // auto-redirect: surface the banner so the user's draft survives.
          if (held != null || gateRef.current === "ended") notifySessionEnded();
          else setGate("out");
          return;
        }
        if (nowId == null) return; // authenticated without a user: malformed, keep state
        if (held != null && nowId !== held) {
          // A DIFFERENT account is signed in now: drop everything, boot as them.
          wipeAppState();
          setGate("loading");
          setAttempt((n) => n + 1);
          return;
        }
        // Same user, or nothing held yet. Quiet while mounted; otherwise recover from
        // "ended"/"unreachable" without losing a handed-back draft or the address bar.
        if (gateRef.current === "ended" || gateRef.current === "unreachable") {
          clearSessionEndedFlag();
          setGate("loading");
          setAttempt((n) => n + 1);
        }
      });
    };
    function wipeAppState() {
      heldUserRef.current = null;
      setBoot(null);
      resetSessionEnded(); // drops the previous account's handed-back draft
      recordPushError(null);
      // The previous account's open chat id must not linger in the address bar.
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.has("chat") || url.searchParams.has("m")) {
          url.searchParams.delete("chat");
          url.searchParams.delete("m");
          window.history.replaceState({}, "", url.pathname + url.search);
        }
      } catch { /* non-browser env */ }
    }
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [base]);

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
    // Start BOTH reads now, in the same tick (no waterfall). The list is quiet on a 401
    // (a signed-out visitor must reach the redirect, not the session-ended banner) and
    // is only ever used if the session read proves an authenticated user: otherwise the
    // result is dropped on the floor, so it cannot leak into another account's view.
    const chatsP = listChats(base, { quiet: true });
    void getSession(base).then(async (r) => {
      if (cancelled) return;
      if (r.ok && r.data.authenticated && r.data.user) {
        const user = r.data.user;
        const chats = await chatsP;
        if (cancelled) return;
        if (!chats.ok && chats.error.kind === "unauthorized") {
          notifySessionEnded();
          return;
        }
        failuresRef.current = 0;
        heldUserRef.current = user.id;
        setBoot({ user, chats });
        setGate("in");
      } else if (r.ok && !r.data.authenticated) {
        failuresRef.current = 0;
        setGate("out");
      } else if (r.ok) {
        // 200 authenticated:true without a user: malformed, retry rather than guess.
        failuresRef.current += 1;
        setGate("unreachable");
        schedule();
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
  if (gate !== "in" || !boot) return <BootSkeleton />;
  return <Chat key={boot.user.id} base={base} user={boot.user} initialChats={boot.chats} />;
}
