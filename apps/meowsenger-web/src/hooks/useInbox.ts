import { useEffect, useRef } from "react";
import { inboxWsUrl, type InboxDelta } from "../lib/chat";
import { retryDelay } from "../lib/backoff";
import { PROBE_AFTER_FAILED_OPENS, probeSession, startHeartbeat } from "../lib/socketHealth";
import { hasSessionEnded, subscribeSessionEnded } from "../lib/sessionEnded";

/**
 * Opens the user's single persistent "inbox" WebSocket and invokes `onDelta` for
 * every realtime sidebar update — a message in a chat they DON'T have open (the active
 * chat updates its own sidebar row from the conversation socket). Separate from the
 * per-chat conversation socket. Reconnects with equal-jitter backoff (cap 10 s), heartbeats while visible, and probes
 * the session after repeated failed opens (a 401 stops it and raises sessionEnded).
 * `onReconnect` fires on every open AFTER a drop (never the first): the caller runs ONE
 * coalesced list refresh to cover the deltas missed while offline.
 *
 * `onDelta` is mirrored into a ref so the socket effect depends only on `[base,
 * enabled]` and never re-runs (a reconnect storm) when the view re-renders with a new
 * closure — the same stability discipline the conversation hook uses.
 */
export function useInbox(base: string, enabled: boolean, onDelta: (d: InboxDelta) => void, onReconnect?: () => void): void {
  const onDeltaRef = useRef(onDelta);
  const onReconnectRef = useRef(onReconnect);
  useEffect(() => { onDeltaRef.current = onDelta; onReconnectRef.current = onReconnect; });

  useEffect(() => {
    if (!enabled || typeof WebSocket === "undefined") return;
    let cancelled = false;
    let closing = false;
    let ws: WebSocket | null = null;
    let timer: number | null = null;
    let attempts = 0;
    let failedOpens = 0; // consecutive closes without an open in between
    let everOpened = false;
    let stopped = false; // session ended: never reconnect
    let hb: ReturnType<typeof startHeartbeat> | null = null;
    const stopHb = () => { hb?.stop(); hb = null; };

    const clearTimer = () => { if (timer != null) { clearTimeout(timer); timer = null; } };

    const unsubEnded = subscribeSessionEnded(() => {
      stopped = true;
      closing = true;
      clearTimer();
      stopHb();
      if (ws) { ws.onclose = null; try { ws.close(); } catch { /* already closed */ } }
    });

    // The socket closed (or was declared dead): schedule a reconnect, and after repeated
    // failed opens check whether the session itself is gone.
    function handleClosed(): void {
      stopHb();
      if (cancelled || closing || stopped) return;
      failedOpens++;
      if (failedOpens >= PROBE_AFTER_FAILED_OPENS && failedOpens % PROBE_AFTER_FAILED_OPENS === 0) {
        void probeSession(base); // a definitive 401 raises sessionEnded -> the subscription above stops us
      }
      clearTimer();
      timer = window.setTimeout(connect, retryDelay(attempts++));
    }

    function connect(): void {
      if (cancelled || stopped || hasSessionEnded()) return;
      closing = false;
      const sock = new WebSocket(inboxWsUrl(base));
      ws = sock;
      sock.onopen = () => {
        if (cancelled || ws !== sock) return;
        attempts = 0;
        failedOpens = 0;
        const reopened = everOpened;
        everOpened = true;
        stopHb();
        hb = startHeartbeat(sock, () => {
          // No pong: the connection is dead. Detach it (a dead TCP close can take minutes
          // to report) and run the normal reconnect path now.
          sock.onclose = null; sock.onmessage = null;
          try { sock.close(); } catch { /* already closed */ }
          handleClosed();
        });
        if (reopened) onReconnectRef.current?.();
      };
      sock.onmessage = (ev) => {
        if (cancelled) return;
        if (hb?.onFrame(ev.data)) return;
        try {
          const frame = JSON.parse(ev.data as string) as { type?: string } & Partial<InboxDelta>;
          if (frame.type === "chat_update" && frame.chatId) {
            onDeltaRef.current({
              chatId: frame.chatId,
              preview: frame.preview ?? "",
              at: frame.at ?? Date.now(),
              senderId: frame.senderId ?? "",
              forwarded: frame.forwarded,
              invalidate: frame.invalidate === true,
            });
          }
        } catch { /* ignore junk */ }
      };
      sock.onclose = () => { if (ws === sock) handleClosed(); };
    }
    connect();

    const onWake = () => {
      if (cancelled || closing || stopped) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        attempts = 0;
        clearTimer();
        connect();
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("online", onWake);
      document.addEventListener("visibilitychange", onWake);
    }

    return () => {
      cancelled = true;
      closing = true;
      clearTimer();
      stopHb();
      unsubEnded();
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onWake);
        document.removeEventListener("visibilitychange", onWake);
      }
      if (ws) { ws.onclose = null; try { ws.close(); } catch { /* already closed */ } }
    };
  }, [base, enabled]);
}
