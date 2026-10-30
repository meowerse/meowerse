import { useEffect, useId, useState } from "react";
import {
  pushSupported, pushPermission, pushSubscribed, pushDiagnostics, enablePush, disablePush,
  recordPushError, isIos, isStandalone, PushError, type PushDiagnostics,
} from "../lib/push";

const SITE = "meowsenger.alxnko.dev";
/** How long to wait for the account id before saying it failed to load. */
const USER_WAIT_MS = 10_000;
const isAndroid = () => typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "");
const IOS_HINT = "on iPhone: tap share → add to home screen, open meowsenger from the home screen, then turn notifications on here";

type Env = "supported" | "unsupported" | "ios-tab";

function detectEnv(): Env {
  if (pushSupported()) return "supported";
  return isIos() && !isStandalone() ? "ios-tab" : "unsupported";
}

/**
 * The push-notifications switch. One unambiguous control: a labeled role=switch whose
 * track + knob show the CURRENT state, a visible "on"/"off" word, and a status line that
 * says what is true now and what a tap will do. Permission is requested ONLY from the tap
 * (enablePush calls Notification.requestPermission() synchronously, inside the click's
 * user activation — nothing is awaited before it).
 */
export default function NotificationsSetting({ base, userId, open }: { base: string; userId?: string; open: boolean }) {
  const [env, setEnv] = useState<Env>(detectEnv);
  const [perm, setPerm] = useState<string>(pushPermission);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState<"on" | "off" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [diag, setDiag] = useState<PushDiagnostics | null>(null);
  const [userTimedOut, setUserTimedOut] = useState(false);
  const labelId = useId();
  const statusId = useId();

  async function refresh() {
    setEnv(detectEnv());
    setPerm(pushPermission());
    setSubscribed(await pushSubscribed());
    setDiag(await pushDiagnostics());
  }
  useEffect(() => {
    if (!open) return;
    setErr(null);
    void refresh();
  }, [open]);

  // The account id arrives asynchronously; if it never does, say so instead of "loading…".
  useEffect(() => {
    if (!open || userId) { setUserTimedOut(false); return; }
    const t = setTimeout(() => setUserTimedOut(true), USER_WAIT_MS);
    return () => clearTimeout(t);
  }, [open, userId]);

  // NOT async-before-permission: enablePush() runs synchronously up to requestPermission().
  function turnOn() {
    if (busy || !userId) return;
    setBusy("on"); setErr(null);
    enablePush(base, userId).then(
      (result) => {
        setPerm(pushPermission());
        if (result === "granted") { setSubscribed(true); recordPushError(null); return; }
        recordPushError(result);
        if (result === "unsupported") setErr("notifications aren't available right now — try again later.");
        else if (result === "denied") setErr(`notifications were blocked. if you never saw a prompt, Chrome may have hidden it — tap the lock icon in the address bar, allow notifications for ${SITE}, then try again.${isAndroid() ? " also check android settings → apps → chrome → notifications." : ""}`);
        else setErr("the permission prompt was dismissed or hidden — tap the switch again and choose allow. if nothing appears, tap the bell/lock icon in the address bar and allow notifications.");
      },
      (e: unknown) => {
        const code = e instanceof PushError ? e.code : "unknown";
        recordPushError(code);
        setSubscribed(false);
        setPerm(pushPermission());
        setErr(
          code === "unauthorized"
            ? "your session expired — log in again, then turn notifications on."
            : "couldn't turn on notifications — try again. if it keeps failing, your browser may block push (e.g. private window, or push services disabled).",
        );
      },
    ).finally(() => { setBusy(null); void pushDiagnostics().then(setDiag); });
  }
  function turnOff() {
    if (busy) return;
    setBusy("off"); setErr(null);
    disablePush(base, userId)
      .then(() => setSubscribed(false))
      .catch(() => { recordPushError("disable"); setErr("couldn't turn off notifications — try again."); })
      .finally(() => { setBusy(null); void pushDiagnostics().then(setDiag); });
  }

  const supported = env === "supported";
  const blocked = supported && perm === "denied";
  const on = supported && subscribed;
  const loading = supported && !userId;
  const disabled = !supported || loading || busy !== null || (blocked && !on);

  let status: string;
  if (env === "ios-tab") status = IOS_HINT;
  else if (!supported) status = "not supported in this browser";
  else if (loading) status = userTimedOut ? "couldn't load your account — reload the page" : "loading…";
  else if (busy === "on") status = "turning on…";
  else if (busy === "off") status = "turning off…";
  else if (on) status = "on — you'll get a notification when a message arrives while meowsenger is closed";
  else if (blocked) status = `blocked in this browser — allow notifications for ${SITE} in site settings`;
  else status = "off";

  return (
    <>
      <div className="mw-setting mw-setting--push">
        <div className="mw-setting__text">
          <span className="mw-setting__label" id={labelId}>
            push notifications <span className="mw-setting__state" data-on={on ? "1" : "0"} aria-hidden="true">{on ? "on" : "off"}</span>
          </span>
          <span className="mw-setting__hint mw-muted" id={statusId}>{status}</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby={labelId}
          aria-describedby={statusId}
          className={`mw-switch${on ? " is-on" : ""}`}
          onClick={on ? turnOff : turnOn}
          disabled={disabled}
        >
          <span className="mw-switch__knob" aria-hidden="true" />
        </button>
      </div>
      {err && <p className="mw-chat__err" role="alert">{err}</p>}
      <details className="mw-setting__details">
        <summary className="mw-muted">details</summary>
        <ul className="mw-setting__diag mw-muted">
          <li>permission: {diag?.permission ?? perm}</li>
          <li>service worker active: {diag?.serviceWorker ? "yes" : "no"}</li>
          <li>push subscription on this device: {diag?.subscription ? "yes" : "no"}</li>
          <li>last error: {diag?.lastError ?? "none"}</li>
        </ul>
      </details>
    </>
  );
}
