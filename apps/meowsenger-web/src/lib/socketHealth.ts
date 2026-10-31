// Shared socket-health helpers for the conversation and inbox sockets: the client
// heartbeat and the "is my session still alive?" probe that follows repeated failed opens.
import { getSession } from "./meowsengerApi";
import { notifySessionEnded } from "./sessionEnded";

/** Send "ping" this often while the tab is visible. The DO's runtime auto-response answers
 *  "pong" without waking it, so the heartbeat costs no DO duration. */
export const PING_INTERVAL_MS = 25_000;
/** No "pong" within this long after a ping => the connection is dead: reconnect. */
export const PONG_TIMEOUT_MS = 10_000;
/** Consecutive failed opens before the session is probed. */
export const PROBE_AFTER_FAILED_OPENS = 2;

/**
 * Start the heartbeat for an OPEN socket. Returns `{ onFrame, stop }`: feed every received
 * data frame to `onFrame` (it consumes "pong" and returns true); `stop()` on close. A hidden
 * tab sends nothing. A visible tab pings at once on becoming visible again (a socket that died
 * while backgrounded is found within PONG_TIMEOUT_MS instead of up to a full interval).
 * `onDead` runs at most once per heartbeat.
 */
export function startHeartbeat(ws: { send(d: string): void }, onDead: () => void): { onFrame: (data: unknown) => boolean; stop: () => void } {
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let dead = false;
  const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
  const ping = () => {
    if (dead || !visible() || pongTimer != null) return; // hidden: no ping; one outstanding at a time
    try { ws.send("ping"); } catch { return; }
    pongTimer = setTimeout(() => {
      pongTimer = null;
      if (dead) return;
      dead = true;
      onDead();
    }, PONG_TIMEOUT_MS);
  };
  const interval = setInterval(ping, PING_INTERVAL_MS);
  const onVis = () => { if (visible()) ping(); };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
  return {
    onFrame(data) {
      if (data !== "pong") return false;
      if (pongTimer != null) { clearTimeout(pongTimer); pongTimer = null; }
      return true;
    },
    stop() {
      dead = true;
      clearInterval(interval);
      if (pongTimer != null) { clearTimeout(pongTimer); pongTimer = null; }
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
    },
  };
}

let probing: Promise<boolean> | null = null;
/**
 * Probe /api/session once (single-flight across both sockets). A definitive 401, or a 200
 * `{authenticated:false}`, raises the app-level sessionEnded signal and resolves true (the
 * caller stops reconnecting). Network/timeout/5xx are NOT "ended": resolves false.
 */
export function probeSession(base: string): Promise<boolean> {
  if (probing) return probing;
  probing = getSession(base)
    .then((r) => {
      const ended = r.ok ? !r.data.authenticated : r.error.kind === "unauthorized";
      if (ended) notifySessionEnded();
      return ended;
    })
    .catch(() => false)
    .finally(() => { probing = null; });
  return probing;
}
